//! 메뉴바(트레이) 아이콘.
//!
//! 창을 닫아도 앱은 메뉴바에 남아 계속 수신한다 — 모니터링 도구는 떠 있는 게 기본이다.
//! 아이콘 옆에 현재 비용을 함께 띄워, 창을 열지 않고도 흐름을 읽을 수 있게 한다.

use std::sync::Arc;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

use crate::state::AppState;

/// 메뉴바에 띄울 짧은 요약. 길면 메뉴바를 잡아먹으므로 비용 하나만 쓴다.
pub fn title_for(state: &AppState) -> String {
    let t = state.totals.read();
    if t.requests == 0 {
        return String::new();
    }
    format!("${:.2}", t.cost_usd)
}

/// 메뉴에 표시할 여러 줄 요약.
fn summary_lines(state: &AppState) -> Vec<String> {
    let t = state.totals.read();
    let tokens = t.tokens_in + t.tokens_out;
    let mins = (t.active_seconds / 60.0).round() as i64;
    vec![
        format!("토큰  {}", thousands(tokens)),
        format!("비용  ${:.4}", t.cost_usd),
        format!("세션  {}", t.sessions as i64),
        format!("활동  {}분", mins),
        format!("수신  {}건", t.requests),
    ]
}

fn thousands(v: f64) -> String {
    let n = v.round() as i64;
    let s = n.abs().to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 {
        format!("-{out}")
    } else {
        out
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>, state: Arc<AppState>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "창 열기", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;

    // 요약 줄은 클릭 대상이 아니라 표시용이라 비활성으로 둔다.
    let lines = summary_lines(&state);
    let mut items: Vec<MenuItem<R>> = Vec::with_capacity(lines.len());
    for (i, l) in lines.iter().enumerate() {
        items.push(MenuItem::with_id(app, format!("stat{i}"), l, false, None::<&str>)?);
    }

    let mut menu = Menu::new(app)?;
    menu.append(&show)?;
    menu.append(&sep1)?;
    for it in &items {
        menu.append(it)?;
    }
    menu.append(&sep2)?;
    menu.append(&quit)?;

    let st = state.clone();
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .icon_as_template(true) // 다크/라이트 메뉴바에 맞춰 자동 반전
        .title(title_for(&st))
        .tooltip("OTel Monitor")
        .menu(&menu)
        .show_menu_on_left_click(false) // 좌클릭은 창 토글, 우클릭이 메뉴
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => open_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                // 이미 보이고 있으면 숨긴다 — 메뉴바 토글의 기본 동작
                if let Some(w) = app.get_webview_window("main") {
                    if w.is_visible().unwrap_or(false) {
                        let _ = w.hide();
                        return;
                    }
                }
                open_window(app);
            }
        })
        .build(app)?;

    Ok(())
}

fn open_window<R: Runtime>(app: &AppHandle<R>) {
    // macOS 는 창을 모두 숨기면 앱이 Accessory 로 내려가, show() 만으로는 앞으로 나오지 않는다.
    // 다시 Regular 로 올린 뒤 보여줘야 한다.
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 수신할 때마다 메뉴바 제목과 메뉴의 요약을 갱신한다.
pub fn refresh<R: Runtime>(app: &AppHandle<R>, state: &AppState) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_title(Some(title_for(state)));
    }
}
