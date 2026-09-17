//! OTLP 수신 · 디코딩 · 포워딩.
//!
//! Claude Code 가 보내는 OTLP/HTTP 요청을 받아 정식 protobuf 로 디코딩하고,
//! 기록한 뒤 설정된 수집 서버로 그대로 전달한다.

use std::io::Read;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Router,
};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value::Value as AnyValue, KeyValue};
use opentelemetry_proto::tonic::metrics::v1::{metric::Data, number_data_point::Value as NumVal};
use prost::Message;
use serde::{Deserialize, Serialize};

use crate::state::AppState;

/// 내용 노출로 간주하는 속성/필드 이름.
/// 이게 페이로드에 나타나면 설정이 바뀌어 원문이 새고 있다는 뜻이다.
const LEAK_KEYS: &[&str] = &[
    "prompt",
    "response",
    "tool_parameters",
    "error",
    "command_name",
    "api_request_body",
    "api_response_body",
];

/// 개인 식별로 간주하는 속성.
const PII_KEYS: &[&str] = &[
    "user.email",
    "user.account_uuid",
    "user.account_id",
    "organization.id",
    "user.id",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capture {
    pub id: u64,
    pub ts: String,
    pub signal: String,
    pub path: String,
    pub bytes: usize,
    pub metrics: Vec<MetricRow>,
    pub attrs: Vec<(String, String)>,
    pub leaks: Vec<String>,
    pub pii: Vec<String>,
    pub forwarded: ForwardResult,
    pub event_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricRow {
    pub name: String,
    pub unit: String,
    pub value: f64,
    pub attrs: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ForwardResult {
    Ok { status: u16, ms: u64 },
    Failed { error: String },
    Disabled,
}

fn any_to_string(v: &Option<opentelemetry_proto::tonic::common::v1::AnyValue>) -> String {
    match v.as_ref().and_then(|x| x.value.as_ref()) {
        Some(AnyValue::StringValue(s)) => s.clone(),
        Some(AnyValue::IntValue(i)) => i.to_string(),
        Some(AnyValue::DoubleValue(d)) => d.to_string(),
        Some(AnyValue::BoolValue(b)) => b.to_string(),
        Some(AnyValue::BytesValue(b)) => format!("<{} bytes>", b.len()),
        Some(AnyValue::ArrayValue(a)) => format!("[{} items]", a.values.len()),
        Some(AnyValue::KvlistValue(k)) => format!("{{{} keys}}", k.values.len()),
        None => String::new(),
    }
}

fn kvs(list: &[KeyValue]) -> Vec<(String, String)> {
    list.iter()
        .map(|kv| (kv.key.clone(), any_to_string(&kv.value)))
        .collect()
}

fn gunzip(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    if flate2::read::GzDecoder::new(b).read_to_end(&mut out).is_ok() {
        out
    } else {
        b.to_vec()
    }
}

/// 메트릭 페이로드를 디코딩해 메트릭 행과 리소스 속성을 뽑는다.
fn decode_metrics(body: &[u8]) -> Option<(Vec<MetricRow>, Vec<(String, String)>)> {
    let req = ExportMetricsServiceRequest::decode(body).ok()?;
    let mut rows = Vec::new();
    let mut res_attrs = Vec::new();

    for rm in &req.resource_metrics {
        if let Some(r) = &rm.resource {
            for kv in kvs(&r.attributes) {
                if !res_attrs.contains(&kv) {
                    res_attrs.push(kv);
                }
            }
        }
        for sm in &rm.scope_metrics {
            for m in &sm.metrics {
                let unit = m.unit.clone();
                let mut push = |value: f64, attrs: Vec<(String, String)>| {
                    rows.push(MetricRow {
                        name: m.name.clone(),
                        unit: unit.clone(),
                        value,
                        attrs,
                    })
                };
                match &m.data {
                    Some(Data::Sum(s)) => {
                        for dp in &s.data_points {
                            let v = match dp.value {
                                Some(NumVal::AsDouble(d)) => d,
                                Some(NumVal::AsInt(i)) => i as f64,
                                None => 0.0,
                            };
                            push(v, kvs(&dp.attributes));
                        }
                    }
                    Some(Data::Gauge(g)) => {
                        for dp in &g.data_points {
                            let v = match dp.value {
                                Some(NumVal::AsDouble(d)) => d,
                                Some(NumVal::AsInt(i)) => i as f64,
                                None => 0.0,
                            };
                            push(v, kvs(&dp.attributes));
                        }
                    }
                    Some(Data::Histogram(h)) => {
                        for dp in &h.data_points {
                            push(dp.sum.unwrap_or(0.0), kvs(&dp.attributes));
                        }
                    }
                    _ => push(0.0, Vec::new()),
                }
            }
        }
    }
    Some((rows, res_attrs))
}

/// 로그(이벤트) 페이로드 — 여기에 프롬프트 원문이 담긴다.
fn decode_logs(body: &[u8]) -> Option<(usize, Vec<(String, String)>)> {
    let req = ExportLogsServiceRequest::decode(body).ok()?;
    let mut n = 0;
    let mut attrs = Vec::new();
    for rl in &req.resource_logs {
        if let Some(r) = &rl.resource {
            for kv in kvs(&r.attributes) {
                if !attrs.contains(&kv) {
                    attrs.push(kv);
                }
            }
        }
        for sl in &rl.scope_logs {
            for rec in &sl.log_records {
                n += 1;
                for kv in kvs(&rec.attributes) {
                    if !attrs.contains(&kv) {
                        attrs.push(kv);
                    }
                }
                let body_s = any_to_string(&rec.body);
                if !body_s.is_empty() {
                    attrs.push(("body".into(), body_s));
                }
            }
        }
    }
    Some((n, attrs))
}

fn decode_traces(body: &[u8]) -> Option<usize> {
    let req = ExportTraceServiceRequest::decode(body).ok()?;
    Some(
        req.resource_spans
            .iter()
            .flat_map(|rs| rs.scope_spans.iter())
            .map(|ss| ss.spans.len())
            .sum(),
    )
}

async fn handle(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    path: String,
    raw: Bytes,
) -> impl IntoResponse {
    let body = if headers
        .get("content-encoding")
        .map(|v| v.as_bytes() == b"gzip")
        .unwrap_or(false)
    {
        gunzip(&raw)
    } else {
        raw.to_vec()
    };

    let signal = if path.contains("metrics") {
        "metrics"
    } else if path.contains("logs") {
        "logs"
    } else if path.contains("traces") {
        "traces"
    } else {
        "unknown"
    };

    let mut metrics = Vec::new();
    let mut attrs: Vec<(String, String)> = Vec::new();
    let mut event_count = 0usize;

    match signal {
        "metrics" => {
            if let Some((rows, ra)) = decode_metrics(&body) {
                for r in &rows {
                    for kv in &r.attrs {
                        if !attrs.contains(kv) {
                            attrs.push(kv.clone());
                        }
                    }
                }
                for kv in ra {
                    if !attrs.contains(&kv) {
                        attrs.push(kv);
                    }
                }
                metrics = rows;
            }
        }
        "logs" => {
            if let Some((n, la)) = decode_logs(&body) {
                event_count = n;
                attrs = la;
            }
        }
        "traces" => {
            event_count = decode_traces(&body).unwrap_or(0);
        }
        _ => {}
    }

    // 유출 감지: 로그 신호 자체가 곧 경고, 그리고 내용 키가 보이면 경고.
    let mut leaks: Vec<String> = Vec::new();
    if signal == "logs" {
        leaks.push("로그(이벤트) 신호가 전송되고 있습니다 — OTEL_LOGS_EXPORTER 가 켜져 있습니다".into());
    }
    for (k, v) in &attrs {
        let kl = k.to_ascii_lowercase();
        if LEAK_KEYS.iter().any(|c| kl == *c || kl.ends_with(&format!(".{c}")))
            && !v.is_empty()
            && v != "<REDACTED>"
        {
            leaks.push(format!("내용 필드 노출: {k}"));
        }
    }

    let pii: Vec<String> = attrs
        .iter()
        .filter(|(k, _)| PII_KEYS.contains(&k.as_str()))
        .map(|(k, v)| format!("{k} = {v}"))
        .collect();

    // 설정된 서버로 그대로 전달
    let forwarded = app.forward(&path, &headers, &raw).await;

    let cap = Capture {
        id: app.next_id(),
        ts: chrono::Local::now().format("%H:%M:%S").to_string(),
        signal: signal.to_string(),
        path,
        bytes: body.len(),
        metrics,
        attrs,
        leaks,
        pii,
        forwarded,
        event_count,
    };

    app.record(cap);
    (StatusCode::OK, [("content-type", "application/x-protobuf")], Vec::<u8>::new())
}

pub fn router(app: Arc<AppState>) -> Router {
    let h = |p: &'static str| {
        move |s: State<Arc<AppState>>, hm: HeaderMap, b: Bytes| async move {
            handle(s, hm, p.to_string(), b).await
        }
    };
    Router::new()
        .route("/v1/metrics", post(h("/v1/metrics")))
        .route("/v1/logs", post(h("/v1/logs")))
        .route("/v1/traces", post(h("/v1/traces")))
        .route("/otlp/v1/metrics", post(h("/otlp/v1/metrics")))
        .route("/otlp/v1/logs", post(h("/otlp/v1/logs")))
        .route("/otlp/v1/traces", post(h("/otlp/v1/traces")))
        .with_state(app)
}
