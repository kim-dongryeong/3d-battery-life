// Menu-bar (tray) desktop wrapper for 3D Battery Life.
// On launch it: spawns the bundled `battery-life serve` sidecar (local web server),
// on first run asks (once) whether to enable auto-recording, and shows a tray icon
// with "뷰어 열기 / 기록 시작 / 기록 중지 / 앱 종료". Build: see TAURI.md. Tauri v2.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod live;
mod smc;

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use std::process::Command as Sh;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;

// When the popover loses focus we hide it. A tray click on an already-open popover fires
// focus-loss (hide) BEFORE the click event, so remember when we last hid it and skip the
// re-show if that was just now — otherwise clicking the icon to close would reopen it.
static LAST_POPOVER_HIDE: LazyLock<Mutex<Option<Instant>>> = LazyLock::new(|| Mutex::new(None));
fn note_popover_hidden() { if let Ok(mut g) = LAST_POPOVER_HIDE.lock() { *g = Some(Instant::now()); } }
fn hidden_just_now() -> bool {
    LAST_POPOVER_HIDE.lock().ok().and_then(|g| *g).map_or(false, |t| t.elapsed().as_millis() < 300)
}
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

const LABEL: &str = "com.kdr.3d-battery-life.sampler";

fn home() -> PathBuf { PathBuf::from(std::env::var("HOME").unwrap_or_default()) }
fn plist_path() -> PathBuf { home().join("Library/LaunchAgents").join(format!("{LABEL}.plist")) }
fn data_dir() -> PathBuf { home().join("Library/Application Support/3d-battery-life") }

fn status_text(on: bool) -> &'static str {
    if on { "● 배터리 기록: 켜짐 (백그라운드 · 앱과 무관)" } else { "○ 배터리 기록: 꺼짐" }
}

// The sidecar binary sits next to this executable inside the .app (Contents/MacOS/battery-life).
fn sidecar_bin() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|d| d.join("battery-life"))
}
// Run `battery-life record <sub>` (on|off|status) — sets up / tears down the launchd sampler.
fn run_record(sub: &'static str) {
    if let Some(bin) = sidecar_bin() {
        let _ = Sh::new(bin).args(["record", sub]).status();
    }
}

// First-run consent via a native macOS dialog (osascript — no extra plugin/permission needed).
fn ask_consent() -> bool {
    let script = "display dialog \"배터리 방전을 60초마다 자동 기록할까요?\n\n· 로그인 시 자동 시작, 백그라운드(거의 0% CPU)\n· 데이터는 이 맥에만 저장됩니다\n\n메뉴바 아이콘에서 언제든 켜고 끌 수 있어요.\" with title \"3D Battery Life\" buttons {\"나중에\", \"기록 켜기\"} default button \"기록 켜기\"";
    match Sh::new("osascript").args(["-e", script]).output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains("기록 켜기"),
        Err(_) => false,
    }
}

// macOS notification via osascript (no plugin / entitlement). Quotes sanitized.
fn notify(title: &str, body: &str) {
    let clean = |s: &str| s.replace('\\', "").replace('"', "'").replace(['\n', '\r'], " ");
    let script = format!(
        "display notification \"{}\" with title \"{}\" sound name \"Ping\"",
        clean(body), clean(title)
    );
    let _ = Sh::new("osascript").args(["-e", &script]).status();
}
// Low/high battery alerts (like Stats/iStat), with hysteresis so each crossing fires once.
// Long-form ETA for notification bodies, e.g. "1시간 20분" / "45분"; "" when unknown.
fn fmt_eta(min: Option<i64>) -> String {
    match min {
        Some(m) if m > 0 && m >= 60 => format!("{}시간 {}분", m / 60, m % 60),
        Some(m) if m > 0 => format!("{m}분"),
        _ => String::new(),
    }
}

fn notify_check(l: &live::Live, cfg: &live::Cfg, low: &mut bool, crit: &mut bool, high: &mut bool) {
    let pct = l.pct.round() as i64;
    let eta = fmt_eta(l.time_min);
    let low_t = cfg.low_pct as f64;    // 0 = off
    let high_t = cfg.high_pct as f64;  // 0 = off
    if l.discharging {
        *high = false;
        let left = if eta.is_empty() { String::new() } else { format!(" (약 {eta} 남음)") };
        // "매우 부족" is a hard floor at 10% (or the user's low threshold if they set it below 10).
        let crit_t = low_t.min(10.0);
        if low_t > 0.0 {
            if l.pct <= crit_t && !*crit { notify("배터리 매우 부족", &format!("{pct}% 남음{left} — 지금 충전하세요")); *crit = true; *low = true; }
            else if l.pct <= low_t && !*low { notify("배터리 부족", &format!("{pct}% 남음{left} — 곧 충전하세요")); *low = true; }
        }
        if l.pct > low_t + 5.0 { *low = false; *crit = false; }   // hysteresis: re-arm above threshold
    } else if l.charging {
        *low = false; *crit = false;
        let full = if eta.is_empty() { String::new() } else { format!(" (완충까지 약 {eta})") };
        if high_t > 0.0 && l.pct >= high_t && !*high { notify(&format!("충전 {}% 도달", high_t as i64), &format!("배터리 수명을 위해 뽑아도 좋아요{full}")); *high = true; }
        if l.pct < high_t - 5.0 { *high = false; }
    } else {
        // AC idle / full / on-hold — reset the LOW side (we're plugged) but keep HIGH sticky so
        // optimized-charging flapping between Charging↔AC-idle can't re-fire the high alert.
        *low = false; *crit = false;
        if l.pct < high_t - 5.0 { *high = false; }
    }
}

fn main() {
    // keep the serve sidecar's handle so quitting the app kills it (otherwise it's orphaned
    // and the next launch fails on the busy port)
    let sidecar: Arc<Mutex<Option<CommandChild>>> = Arc::new(Mutex::new(None));
    let sidecar_for_exit = sidecar.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            // 1) start the local server (bundled single binary) as a sidecar
            let cmd = app.shell().sidecar("battery-life").expect("sidecar 'battery-life' missing").args(["serve"]);
            let (mut rx, child) = cmd.spawn().expect("failed to spawn battery-life serve");
            *sidecar.lock().unwrap() = Some(child);
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = rx.recv().await {
                    if let CommandEvent::Stdout(b) | CommandEvent::Stderr(b) = ev {
                        print!("{}", String::from_utf8_lossy(&b));
                    }
                }
            });

            // 2) tray menu (menu-bar item).
            // Recording (launchd) is INDEPENDENT of the app — quitting the app never stops it.
            let recording = plist_path().exists();
            let cfg = Arc::new(Mutex::new(live::load_cfg()));
            let c0 = cfg.lock().unwrap().clone();
            let status = MenuItem::with_id(app, "status", status_text(recording), false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "3D 리포트 열기", true, None::<&str>)?;
            let info_item = MenuItem::with_id(app, "info", format!("메뉴바 표시: {}", live::INFO_LABELS[c0.info as usize % 6]), true, None::<&str>)?;
            let color_item = MenuItem::with_id(app, "color", format!("아이콘 색상: {}", if c0.colorize { "켜짐" } else { "꺼짐" }), true, None::<&str>)?;
            let low_item = MenuItem::with_id(app, "low_alert", live::alert_label("배터리 부족 알림", c0.low_pct), true, None::<&str>)?;
            let high_item = MenuItem::with_id(app, "high_alert", live::alert_label("충전 완료 알림", c0.high_pct), true, None::<&str>)?;
            // one recording item that toggles (was separate 시작/중지 — no need for both)
            let rec_item = MenuItem::with_id(app, "rec_toggle", if recording { "배터리 기록 중지" } else { "배터리 기록 시작" }, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "앱 종료 (기록은 계속됨)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&status, &open, &info_item, &color_item, &low_item, &high_item, &rec_item, &quit])?;
            let status_for_menu = status.clone();
            let cfg_menu = cfg.clone();
            let info_for_menu = info_item.clone();
            let color_for_menu = color_item.clone();
            let low_for_menu = low_item.clone();
            let high_for_menu = high_item.clone();
            let rec_for_menu = rec_item.clone();
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("3D Battery Life")
                .menu(&menu)
                .show_menu_on_left_click(false)   // left-click = popover; right-click = menu
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
                        // rect is the icon's screen box in PHYSICAL px, top-left origin (tray-icon flips
                        // macOS' bottom-left coords for us). Position/Size are dpi enums → already the
                        // Physical variant here, so to_physical just casts (scale arg ignored).
                        let p = rect.position.to_physical::<f64>(1.0);
                        let sz = rect.size.to_physical::<f64>(1.0);
                        let anchor = (p.x, p.y, sz.width, sz.height);
                        toggle_popover(tray.app_handle(), Some(anchor));
                    }
                })
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "info" => {
                        if let Ok(mut g) = cfg_menu.lock() {
                            g.info = (g.info + 1) % 6;
                            live::save_cfg(&g);
                            let _ = info_for_menu.set_text(format!("메뉴바 표시: {}", live::INFO_LABELS[g.info as usize]));
                        }
                    }
                    "color" => {
                        if let Ok(mut g) = cfg_menu.lock() {
                            g.colorize = !g.colorize;
                            live::save_cfg(&g);
                            let _ = color_for_menu.set_text(format!("아이콘 색상: {}", if g.colorize { "켜짐" } else { "꺼짐" }));
                        }
                    }
                    "low_alert" => {
                        if let Ok(mut g) = cfg_menu.lock() {
                            g.low_pct = live::next_step(&live::LOW_STEPS, g.low_pct);
                            live::save_cfg(&g);
                            let _ = low_for_menu.set_text(live::alert_label("배터리 부족 알림", g.low_pct));
                        }
                    }
                    "high_alert" => {
                        if let Ok(mut g) = cfg_menu.lock() {
                            g.high_pct = live::next_step(&live::HIGH_STEPS, g.high_pct);
                            live::save_cfg(&g);
                            let _ = high_for_menu.set_text(live::alert_label("충전 완료 알림", g.high_pct));
                        }
                    }
                    "rec_toggle" => {
                        let turning_on = !plist_path().exists();   // toggle relative to the live launchd state
                        let _ = status_for_menu.set_text(status_text(turning_on));
                        let _ = rec_for_menu.set_text(if turning_on { "배터리 기록 중지" } else { "배터리 기록 시작" });
                        std::thread::spawn(move || run_record(if turning_on { "on" } else { "off" }));
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // 3) first-run consent — only if recording isn't set up and we haven't asked before.
            //    The marker is written AFTER the dialog resolves: writing it up-front meant a
            //    quit/crash while the dialog was open suppressed consent forever.
            let marker = data_dir().join(".consent-asked");
            if !plist_path().exists() && !marker.exists() {
                let status_for_consent = status.clone();
                let rec_for_consent = rec_item.clone();
                std::thread::spawn(move || {
                    let yes = ask_consent();
                    let _ = std::fs::create_dir_all(data_dir());
                    let _ = std::fs::write(&marker, if yes { "yes\n" } else { "later\n" });
                    if yes {
                        run_record("on");
                        let _ = status_for_consent.set_text(status_text(true));
                        let _ = rec_for_consent.set_text("배터리 기록 중지");   // keep the toggle in sync
                    }
                });
            }

            // 4) live tray title — a 2s ticker reads the battery natively and shows "87% · 5.2W" (or ⚡)
            //    next to the menu-bar icon, so the app earns its always-resident spot (Stats-parity).
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut reader = live::Reader::new();
                let smc = smc::Smc::open();   // live temp/system-power (real-time; ioreg is 60s-quantized)
                if smc.is_some() { let _ = std::fs::create_dir_all(data_dir()); }   // so the bridge write can't silently fail
                let mut last_key = String::new();
                let (mut low, mut crit, mut high) = (false, false, false);
                loop {
                    let l = reader.read();
                    let c = live::load_cfg();   // re-read each tick so menu AND popover-settings changes apply live
                    if l.ok { notify_check(&l, &c, &mut low, &mut crit, &mut high); }
                    // read SMC once per tick: feeds both the live-smc.json bridge and the menu-bar W.
                    let mut sys_w = None;
                    if let Some(ref s) = smc {
                        sys_w = s.system_watts();
                        let f = |o: Option<f64>| o.map(|v| v.to_string()).unwrap_or_else(|| "null".into());
                        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                        let j = format!("{{\"tempC\":{},\"systemW\":{},\"adapterW\":{},\"at\":{}}}",
                            f(s.battery_temp_c()), f(sys_w), f(s.adapter_watts()), now);
                        let _ = std::fs::write(data_dir().join("live-smc.json"), j);
                    }
                    if let Some(tray) = handle.tray_by_id("tray") {
                        // menu-bar "W" = live system draw (SMC) when we have it, else battery-rail watts
                        let title = live::tray_title(&l, c.info, sys_w.unwrap_or(l.watts));
                        let _ = tray.set_title(if title.is_empty() { None } else { Some(title) });
                        // redraw the glyph when the visible state changes (level / charging / colorize)
                        let key = format!("{}-{}-{}-{}", l.pct.round() as i64, l.charging, l.full, c.colorize);
                        if l.ok && key != last_key {
                            last_key = key;
                            let (rgba, w, h) = live::battery_icon(&l, c.colorize);
                            let _ = tray.set_icon(Some(tauri::image::Image::new_owned(rgba, w, h)));
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // closing the viewer window must not quit the tray app — hide it instead
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // popover auto-hides when it loses focus (menu-bar popover convention)
                WindowEvent::Focused(false) if window.label() == "popover" => {
                    note_popover_hidden();   // so a tray click that caused this doesn't re-show it
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_app, event| {
        if let RunEvent::Exit = event {
            // covers menu quit AND Cmd+Q / logout: take the sidecar and kill it
            if let Some(child) = sidecar_for_exit.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Left-click popover: a small borderless window loading the node server's /popover.html (pure web,
// no Tauri commands → safe to load from localhost). Lazily created, then toggled.
fn toggle_popover(app: &AppHandle, anchor: Option<(f64, f64, f64, f64)>) {
    if let Some(w) = app.get_webview_window("popover") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else if !hidden_just_now() {   // this same click may have just hidden it via focus-loss
            place_popover(&w, anchor);
            let _ = w.show();
            let _ = w.set_focus();
        }
        return;
    }
    let built = WebviewWindowBuilder::new(
        app,
        "popover",
        WebviewUrl::External("http://localhost:4317/popover.html".parse().unwrap()),
    )
    .title("배터리")
    .inner_size(320.0, 560.0)
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build();
    if let Ok(w) = built {
        place_popover(&w, anchor);
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Anchor the popover just below the clicked menu-bar icon, horizontally centered under it and
// clamped to that icon's monitor. `anchor` = the icon's screen rect in PHYSICAL px, top-left
// origin (exactly what the tray Click event gives). Everything here — anchor, monitor position/
// size, and the popover position — is in the same global physical coordinate space, so no
// scale-factor juggling between rails. Fallback (no anchor): menu-bar monitor's top-right corner.
fn place_popover(w: &tauri::WebviewWindow, anchor: Option<(f64, f64, f64, f64)>) {
    // Pick the monitor under the icon (multi-monitor safe), else the primary one.
    let mon = anchor
        .and_then(|(x, y, aw, ah)| {
            let (cx, cy) = (x + aw / 2.0, y + ah / 2.0);
            w.available_monitors().ok().and_then(|ms| {
                ms.into_iter().find(|m| {
                    let (p, s) = (m.position(), m.size());
                    let (l, t) = (p.x as f64, p.y as f64);
                    cx >= l && cx < l + s.width as f64 && cy >= t && cy < t + s.height as f64
                })
            })
        })
        .or_else(|| w.primary_monitor().ok().flatten());
    let Some(mon) = mon else { return; };
    let sf = mon.scale_factor();
    let (ml, mt, mw) = (mon.position().x as f64, mon.position().y as f64, mon.size().width as f64);
    let pop_w = 320.0 * sf;          // logical inner width → physical
    let gap = 6.0 * sf;
    let (x, y) = match anchor {
        Some((ax, ay, aw, ah)) => {
            let center = ax + aw / 2.0;
            let lo = ml + gap;
            let hi = (ml + mw - pop_w - gap).max(lo);   // never let hi < lo on a very narrow display
            ((center - pop_w / 2.0).clamp(lo, hi), ay + ah + 2.0 * sf)
        }
        None => ((ml + mw - pop_w - gap).max(ml + gap), mt + 32.0 * sf),
    };
    let _ = w.set_position(PhysicalPosition::new(x, y));
}
