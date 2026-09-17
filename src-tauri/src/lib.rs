mod history;
mod otlp;
mod state;

use std::sync::Arc;

use serde::Serialize;
use state::{AppState, Config, Point, Totals};
use tauri::State;
use tokio::net::TcpListener;

#[derive(Serialize)]
struct Snapshot {
    running: bool,
    cfg: Config,
    totals: Totals,
    captures: Vec<otlp::Capture>,
    series: Vec<Point>,
}

#[tauri::command]
fn snapshot(app: State<'_, Arc<AppState>>) -> Snapshot {
    Snapshot {
        running: *app.running.read(),
        cfg: app.cfg.read().clone(),
        totals: app.totals.read().clone(),
        captures: app.captures.read().clone(),
        series: app.series.read().clone(),
    }
}

#[tauri::command]
fn set_config(app: State<'_, Arc<AppState>>, cfg: Config) -> Config {
    let mut c = app.cfg.write();
    // 포트는 재시작해야 반영되므로 현재 구동 중이면 유지
    if !*app.running.read() {
        c.listen_port = cfg.listen_port;
    }
    c.upstream = cfg.upstream;
    c.forward_enabled = cfg.forward_enabled;
    c.clone()
}

#[tauri::command]
fn clear(app: State<'_, Arc<AppState>>) {
    app.clear();
}

#[tauri::command]
fn history(app: State<'_, Arc<AppState>>) -> history::History {
    app.history.snapshot()
}

#[tauri::command]
fn history_path(app: State<'_, Arc<AppState>>) -> String {
    app.history.path_string()
}

#[tauri::command]
fn set_retention(app: State<'_, Arc<AppState>>, days: u32) {
    app.history.set_retention(days);
    app.history.flush();
}

#[tauri::command]
fn clear_history(app: State<'_, Arc<AppState>>) {
    app.history.clear();
}

#[tauri::command]
fn export_json(app: State<'_, Arc<AppState>>) -> Result<String, String> {
    let caps = app.captures.read().clone();
    serde_json::to_string_pretty(&caps).map_err(|e| e.to_string())
}

#[tauri::command]
fn export_csv(app: State<'_, Arc<AppState>>) -> String {
    let caps = app.captures.read().clone();
    let mut s = String::from("time,signal,bytes,metric,unit,value,attrs,forwarded\n");
    for c in &caps {
        let fwd = match &c.forwarded {
            otlp::ForwardResult::Ok { status, ms } => format!("ok:{status}:{ms}ms"),
            otlp::ForwardResult::Failed { error } => format!("fail:{}", error.replace(',', ";")),
            otlp::ForwardResult::Disabled => "disabled".into(),
        };
        if c.metrics.is_empty() {
            s.push_str(&format!("{},{},{},,,,,{}\n", c.ts, c.signal, c.bytes, fwd));
        }
        for m in &c.metrics {
            let a = m
                .attrs
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join(" ")
                .replace(',', ";");
            s.push_str(&format!(
                "{},{},{},{},{},{},{},{}\n",
                c.ts, c.signal, c.bytes, m.name, m.unit, m.value, a, fwd
            ));
        }
    }
    s
}

/// Claude Code 설정 파일 후보를 찾는다.
///
/// 경로는 고정이 아니다 — `CLAUDE_CONFIG_DIR` 로 바꿀 수 있고, 계정을 나눠 쓰면
/// 여러 개가 공존한다. 그래서 환경변수를 먼저 보고, 없으면 흔한 위치를 훑는다.
#[tauri::command]
fn find_settings() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut out: Vec<String> = Vec::new();

    let mut push = |p: String| {
        if !p.is_empty() && std::path::Path::new(&p).is_file() && !out.contains(&p) {
            out.push(p);
        }
    };

    // 1) 명시된 config 디렉토리가 최우선
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        for d in dir.split(':') {
            push(format!("{}/settings.json", d.trim_end_matches('/')));
        }
    }

    // 2) 홈 아래의 .claude* 디렉토리를 훑는다 (계정별로 나눠 쓰는 경우)
    if !home.is_empty() {
        if let Ok(rd) = std::fs::read_dir(&home) {
            let mut dirs: Vec<String> = rd
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n == ".claude" || n.starts_with(".claude-"))
                .collect();
            dirs.sort();
            for n in dirs {
                push(format!("{home}/{n}/settings.json"));
            }
        }
    }

    out
}

/// 설치된 settings.json 을 읽어 현재 OTel 설정 상태를 진단한다.
#[tauri::command]
fn inspect_settings(path: String) -> serde_json::Value {
    let expanded = if let Some(rest) = path.strip_prefix("~/") {
        std::env::var("HOME")
            .map(|h| format!("{h}/{rest}"))
            .unwrap_or(path.clone())
    } else {
        path.clone()
    };

    let raw = match std::fs::read_to_string(&expanded) {
        Ok(r) => r,
        Err(e) => {
            return serde_json::json!({ "ok": false, "error": e.to_string(), "path": expanded })
        }
    };
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            return serde_json::json!({ "ok": false, "error": e.to_string(), "path": expanded })
        }
    };
    let env = v.get("env").cloned().unwrap_or(serde_json::json!({}));
    let get = |k: &str| env.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();

    let risky = [
        "OTEL_LOGS_EXPORTER",
        "OTEL_LOG_USER_PROMPTS",
        "OTEL_LOG_ASSISTANT_RESPONSES",
        "OTEL_LOG_TOOL_DETAILS",
        "OTEL_LOG_TOOL_CONTENT",
        "OTEL_LOG_RAW_API_BODIES",
    ];
    let found: Vec<String> = risky
        .iter()
        .filter(|k| !get(k).is_empty())
        .map(|k| format!("{k} = {}", get(k)))
        .collect();

    serde_json::json!({
        "ok": true,
        "path": expanded,
        "telemetry": get("CLAUDE_CODE_ENABLE_TELEMETRY"),
        "metrics_exporter": get("OTEL_METRICS_EXPORTER"),
        "endpoint": get("OTEL_EXPORTER_OTLP_ENDPOINT"),
        "resource_attrs": get("OTEL_RESOURCE_ATTRIBUTES"),
        "interval": get("OTEL_METRIC_EXPORT_INTERVAL"),
        "content_keys": found,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new();
    let for_setup = app_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            snapshot,
            set_config,
            clear,
            export_json,
            export_csv,
            inspect_settings,
            find_settings,
            history,
            history_path,
            set_retention,
            clear_history
        ])
        .setup(move |app| {
            for_setup.set_handle(app.handle().clone());

            let st = for_setup.clone();
            let port = st.cfg.read().listen_port;

            tauri::async_runtime::spawn(async move {
                let router = otlp::router(st.clone());
                match TcpListener::bind(("127.0.0.1", port)).await {
                    Ok(l) => {
                        *st.running.write() = true;
                        if let Some(h) = app_handle_of(&st) {
                            use tauri::Emitter;
                            let _ = h.emit("server-status", serde_json::json!({
                                "running": true, "port": port
                            }));
                        }
                        let _ = axum::serve(l, router).await;
                    }
                    Err(e) => {
                        *st.running.write() = false;
                        if let Some(h) = app_handle_of(&st) {
                            use tauri::Emitter;
                            let _ = h.emit("server-status", serde_json::json!({
                                "running": false, "port": port, "error": e.to_string()
                            }));
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn app_handle_of(st: &Arc<AppState>) -> Option<tauri::AppHandle> {
    st.handle_clone()
}
