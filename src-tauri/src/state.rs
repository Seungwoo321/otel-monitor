//! 앱 상태 — 캡처 버퍼, 누적 집계, 상류 포워딩 설정.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use axum::http::HeaderMap;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::history::HistoryStore;
use crate::otlp::{Capture, ForwardResult};

/// 메모리에 들고 있을 최대 캡처 수. 오래된 것부터 버린다.
const MAX_CAPTURES: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// 수신 포트
    pub listen_port: u16,
    /// 전달할 서버 주소 (빈 문자열이면 전달하지 않음)
    pub upstream: String,
    /// 포워딩 활성화
    pub forward_enabled: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen_port: 4319,
            // 기본값 없음 — 설정 화면에서 직접 입력한다.
            upstream: String::new(),
            forward_enabled: false,
        }
    }
}

/// 누적 집계 — 일자별·메트릭별.
#[derive(Debug, Default, Clone, Serialize)]
pub struct Totals {
    pub requests: u64,
    pub bytes: u64,
    pub tokens_in: f64,
    pub tokens_out: f64,
    pub tokens_cache_read: f64,
    pub tokens_cache_creation: f64,
    pub cost_usd: f64,
    pub sessions: f64,
    pub commits: f64,
    pub prs: f64,
    pub lines_added: f64,
    pub lines_removed: f64,
    pub active_seconds: f64,
    pub leak_events: u64,
    pub forward_failures: u64,
}

/// 시계열 한 점 — 차트용.
#[derive(Debug, Clone, Serialize)]
pub struct Point {
    pub ts: String,
    pub tokens: f64,
    pub tokens_in: f64,
    pub tokens_out: f64,
    pub cost: f64,
    pub active: f64,
    pub added: f64,
    pub removed: f64,
}

/// cumulative 메트릭의 시리즈별 최신값.
/// 키 = (metric, session.id, 구분 속성) — 같은 시리즈의 재전송은 누적이므로 덮어쓴다.
type SeriesKey = (String, String, String);

pub struct AppState {
    pub cfg: RwLock<Config>,
    latest: RwLock<std::collections::HashMap<SeriesKey, f64>>,
    pub captures: RwLock<Vec<Capture>>,
    pub totals: RwLock<Totals>,
    pub series: RwLock<Vec<Point>>,
    pub running: RwLock<bool>,
    pub history: HistoryStore,
    seq: AtomicU64,
    http: reqwest::Client,
    handle: RwLock<Option<AppHandle>>,
}

impl AppState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            cfg: RwLock::new(Config::default()),
            latest: RwLock::new(std::collections::HashMap::new()),
            captures: RwLock::new(Vec::new()),
            totals: RwLock::new(Totals::default()),
            series: RwLock::new(Vec::new()),
            running: RwLock::new(false),
            history: HistoryStore::new(),
            seq: AtomicU64::new(1),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .unwrap_or_default(),
            handle: RwLock::new(None),
        })
    }

    pub fn set_handle(&self, h: AppHandle) {
        *self.handle.write() = Some(h);
    }

    pub fn handle_clone(&self) -> Option<AppHandle> {
        self.handle.read().clone()
    }

    pub fn next_id(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed)
    }

    /// 상류로 원본 바이트를 그대로 전달한다.
    pub async fn forward(&self, path: &str, headers: &HeaderMap, raw: &[u8]) -> ForwardResult {
        let (enabled, upstream) = {
            let c = self.cfg.read();
            (c.forward_enabled, c.upstream.clone())
        };
        if !enabled || upstream.is_empty() {
            return ForwardResult::Disabled;
        }

        // 전달 URL 조립: 설정된 base + 신호 경로(/v1/metrics 등)
        let suffix = path.rsplit_once("/v1/").map(|(_, s)| s).unwrap_or("metrics");
        let url = format!("{}/v1/{}", upstream.trim_end_matches('/'), suffix);

        let mut req = self.http.post(&url).body(raw.to_vec());
        for (k, v) in headers.iter() {
            let kn = k.as_str().to_ascii_lowercase();
            // hop-by-hop 및 길이 관련 헤더는 제외하고 그대로 전달
            if matches!(kn.as_str(), "host" | "content-length" | "connection" | "accept-encoding") {
                continue;
            }
            if let Ok(val) = v.to_str() {
                req = req.header(k.as_str(), val);
            }
        }

        let t = Instant::now();
        match req.send().await {
            Ok(r) => ForwardResult::Ok {
                status: r.status().as_u16(),
                ms: t.elapsed().as_millis() as u64,
            },
            Err(e) => ForwardResult::Failed {
                error: e.to_string(),
            },
        }
    }

    /// 캡처를 기록하고 집계를 갱신한 뒤 프론트로 이벤트를 쏜다.
    ///
    /// Claude Code 는 cumulative temporality 로 보낸다 — 매 전송이 "세션 시작 이후 누계"다.
    /// 따라서 값을 더하면 안 되고, 시리즈별 최신값으로 덮어쓴 뒤 전체를 다시 합산한다.
    pub fn record(&self, cap: Capture) {
        {
            // 1) 시리즈별 최신값 갱신
            let session = cap
                .attrs
                .iter()
                .find(|(k, _)| k == "session.id")
                .map(|(_, v)| v.clone())
                .unwrap_or_default();

            let mut latest = self.latest.write();
            for m in &cap.metrics {
                // 같은 메트릭이라도 type/start_type 으로 시리즈가 갈린다
                let disc = m
                    .attrs
                    .iter()
                    .filter(|(k, _)| k == "type" || k == "start_type")
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join(",");
                latest.insert((m.name.clone(), session.clone(), disc), m.value);
            }

            // 2) 최신값 전체를 다시 합산 (세션이 여럿이면 세션별 누계의 합)
            let mut t = self.totals.write();
            let (req, bytes, leaks, fails) =
                (t.requests + 1, t.bytes + cap.bytes as u64,
                 t.leak_events + if cap.leaks.is_empty() { 0 } else { 1 },
                 t.forward_failures
                     + if matches!(cap.forwarded, ForwardResult::Failed { .. }) { 1 } else { 0 });

            *t = Totals::default();
            t.requests = req;
            t.bytes = bytes;
            t.leak_events = leaks;
            t.forward_failures = fails;

            for ((name, _sess, disc), val) in latest.iter() {
                let kind = disc
                    .split(',')
                    .find_map(|p| p.strip_prefix("type="))
                    .unwrap_or("");
                match name.as_str() {
                    "claude_code.token.usage" => match kind {
                        "input" => t.tokens_in += val,
                        "output" => t.tokens_out += val,
                        "cacheRead" => t.tokens_cache_read += val,
                        "cacheCreation" => t.tokens_cache_creation += val,
                        _ => {}
                    },
                    "claude_code.cost.usage" => t.cost_usd += val,
                    "claude_code.session.count" => t.sessions += val,
                    "claude_code.commit.count" => t.commits += val,
                    "claude_code.pull_request.count" => t.prs += val,
                    "claude_code.lines_of_code.count" => match kind {
                        "removed" => t.lines_removed += val,
                        _ => t.lines_added += val,
                    },
                    "claude_code.active_time.total" => t.active_seconds += val,
                    _ => {}
                }
            }

            let pt = Point {
                ts: cap.ts.clone(),
                tokens: t.tokens_in + t.tokens_out,
                tokens_in: t.tokens_in,
                tokens_out: t.tokens_out,
                cost: t.cost_usd,
                active: t.active_seconds,
                added: t.lines_added,
                removed: t.lines_removed,
            };
            let mut s = self.series.write();
            s.push(pt);
            if s.len() > 300 {
                let drop = s.len() - 300;
                s.drain(0..drop);
            }
        }

        {
            let mut v = self.captures.write();
            v.push(cap.clone());
            if v.len() > MAX_CAPTURES {
                let drop = v.len() - MAX_CAPTURES;
                v.drain(0..drop);
            }
        }

        // 일자별 집계에 반영 (계정은 user.email, 없으면 unit, 그것도 없으면 unknown)
        let account = cap
            .attrs
            .iter()
            .find(|(k, _)| k == "user.email")
            .or_else(|| cap.attrs.iter().find(|(k, _)| k == "unit"))
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| "unknown".into());
        let date = chrono::Local::now().format("%Y-%m-%d").to_string();
        let rows: Vec<(String, String, f64)> = cap
            .metrics
            .iter()
            .map(|m| {
                let disc = m
                    .attrs
                    .iter()
                    .filter(|(k, _)| k == "type" || k == "start_type")
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join(",");
                (m.name.clone(), disc, m.value)
            })
            .collect();
        self.history.record(&date, &account, &rows, &cap.leaks, &cap.ts);
        self.history.flush();

        if let Some(h) = self.handle.read().as_ref() {
            let _ = h.emit("otlp-capture", &cap);
        }
    }

    pub fn clear(&self) {
        self.latest.write().clear();
        self.captures.write().clear();
        *self.totals.write() = Totals::default();
        self.series.write().clear();
    }
}
