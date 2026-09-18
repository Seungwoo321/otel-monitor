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

/// 메뉴에 표시할 여러 줄 요약. 메뉴바에는 아이콘만 두고 수치는 여기서 본다.
fn summary_lines(state: &AppState) -> Vec<String> {
    let t = state.totals.read();
    if t.requests == 0 {
        return vec!["아직 받은 트래픽이 없습니다".into()];
    }

    let tokens = t.tokens_in + t.tokens_out;
    let mins = (t.active_seconds / 60.0).round() as i64;
    let mut v = vec![
        format!("비용      ${:.4}", t.cost_usd),
        format!("토큰      {}", thousands(tokens)),
        format!("세션      {}", t.sessions as i64),
        format!("활동      {}분", mins),
        format!("수신      {}건", t.requests),
    ];
    // 문제가 있을 때만 덧붙인다 — 평소에 0 줄이 늘어서 있을 이유가 없다
    if t.leak_events > 0 {
        v.push(format!("⚠ 내용 유출  {}건", t.leak_events));
    }
    if t.forward_failures > 0 {
        v.push(format!("⚠ 전달 실패  {}건", t.forward_failures));
    }
    v
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

/// 트레이 메뉴를 그 시점 수치로 새로 만든다.
/// 메뉴 항목은 만든 뒤 라벨을 바꿀 수 없어서, 갱신할 때마다 통째로 교체한다.
fn build_menu<R: Runtime>(app: &AppHandle<R>, state: &AppState) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "show", "창 열기", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    // 요약 줄은 활성으로 둔다 — macOS 는 비활성 항목을 흐리게 그려서,
    // 정작 읽으라고 넣은 숫자가 안 보인다. 클릭하면 창을 연다.
    for (i, l) in summary_lines(state).iter().enumerate() {
        menu.append(&MenuItem::with_id(app, format!("stat{i}"), l, true, None::<&str>)?)?;
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?)?;
    Ok(menu)
}

pub fn build<R: Runtime>(app: &AppHandle<R>, state: Arc<AppState>) -> tauri::Result<()> {
    let menu = build_menu(app, &state)?;
    // 메뉴바 전용 아이콘 — 배경 없는 단색 실루엣이라야 템플릿 반전이 자연스럽다.
    // 앱 아이콘(라운드 사각형 배경)을 그대로 쓰면 메뉴바에서 답답해 보인다.
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray@2x.png"))?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true) // 다크/라이트 메뉴바에 맞춰 자동 반전
        .tooltip("OTel Monitor")
        .menu(&menu)
        .show_menu_on_left_click(false) // 좌클릭은 창 토글, 우클릭이 메뉴
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "quit" => app.exit(0),
            // "show" 와 요약 줄(stat*) 모두 창을 연다
            _ => open_window(app),
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
        if let Ok(menu) = build_menu(app, state) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}
