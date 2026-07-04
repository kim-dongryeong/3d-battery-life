// Menu-bar (tray) desktop wrapper for 3D Battery Life.
// On launch it: spawns the bundled `battery-life serve` sidecar (local web server),
// on first run asks (once) whether to enable auto-recording, and shows a tray icon
// with "뷰어 열기 / 기록 시작 / 기록 중지 / 앱 종료". Build: see TAURI.md. Tauri v2.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod live;
mod smc;
mod power;

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
// Last tray-icon screen rect (physical px) so menu-triggered opens (설정 열기 / ⌥⌘B) can anchor
// under the icon too, not just left-clicks.
static LAST_ICON_RECT: LazyLock<Mutex<Option<(f64, f64, f64, f64)>>> = LazyLock::new(|| Mutex::new(None));
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

// Low Power Mode state (`pmset -g` → "lowpowermode  1"). Read on a slow cadence from the ticker.
fn low_power_mode() -> bool {
    std::process::Command::new("pmset").arg("-g").output().ok().is_some_and(|o| {
        String::from_utf8_lossy(&o.stdout)
            .lines()
            .any(|l| l.contains("lowpowermode") && l.split_whitespace().last() == Some("1"))
    })
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
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
            let status = MenuItem::with_id(app, "status", status_text(recording), false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "3D 분석 리포트 열기", true, None::<&str>)?;
            // all display/menu-bar/alert settings now live in the popover's settings panel (gear)
            let settings_item = MenuItem::with_id(app, "settings", "설정 열기…", true, None::<&str>)?;
            // one recording item that toggles (was separate 시작/중지 — no need for both)
            let rec_item = MenuItem::with_id(app, "rec_toggle", if recording { "배터리 기록 중지" } else { "배터리 기록 시작" }, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "앱 종료 (기록은 계속됨)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&status, &open, &settings_item, &rec_item, &quit])?;
            let status_for_menu = status.clone();
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
                        if let Ok(mut g) = LAST_ICON_RECT.lock() { *g = Some(anchor); }
                        toggle_popover(tray.app_handle(), Some(anchor));
                    }
                })
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "settings" => open_popover(app, true),   // show the popover straight in its settings panel
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
            let rec_ticker = rec_item.clone();      // keep the tray recording label in sync from the ticker
            let status_ticker = status.clone();
            let rec0 = recording;
            std::thread::spawn(move || {
                let mut reader = live::Reader::new();
                let smc = smc::Smc::open();   // live temp/system-power (real-time; ioreg is 60s-quantized)
                if smc.is_some() { let _ = std::fs::create_dir_all(data_dir()); }   // so the bridge write can't silently fail
                power::start_notifier();      // wake instantly on AC plug/unplug (else just the 2s poll)
                let mut last_key = String::new();
                let (mut low, mut crit, mut high) = (false, false, false);
                let mut sc_on = false;   // whether the global ⌥⌃B is currently registered
                let (mut lpm, mut tick) = (low_power_mode(), 0u32);
                let mut rec_state = rec0;
                let mut last_pop_h = 0.0f64;   // last height the popover reported (to size its window)
                let mut pwin: Vec<(u64, f64, f64, f64)> = Vec::new();   // rolling 60s (t, sysW, adpW, batW) → 1-min avg for the recorder
                loop {
                    let l = reader.read();
                    let c = live::load_cfg();   // re-read each tick so menu AND popover-settings changes apply live
                    if tick % 3 == 0 { lpm = low_power_mode(); }   // refresh Low Power Mode every ~6s
                    tick = tick.wrapping_add(1);
                    // keep the tray recording label synced to the real launchd state (menu/popover/external)
                    let now_rec = plist_path().exists();
                    if now_rec != rec_state {
                        rec_state = now_rec;
                        let (r, st) = (rec_ticker.clone(), status_ticker.clone());
                        let _ = handle.run_on_main_thread(move || {
                            let _ = r.set_text(if now_rec { "배터리 기록 중지" } else { "배터리 기록 시작" });
                            let _ = st.set_text(status_text(now_rec));
                        });
                    }
                    if l.ok { notify_check(&l, &c, &mut low, &mut crit, &mut high); }
                    // register/unregister the global open-popover hotkey to match the setting (live)
                    if c.shortcut != sc_on {
                        use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                        let gs = handle.global_shortcut();
                        let hk = Shortcut::new(Some(Modifiers::ALT | Modifiers::CONTROL), Code::KeyB); // ⌥⌃B
                        if c.shortcut {
                            let _ = gs.on_shortcut(hk, |app, _s, ev| {
                                // toggle: pressing it again (or ESC) closes the popover
                                if ev.state() == ShortcutState::Pressed { toggle_popover(app, None); }
                            });
                        } else {
                            let _ = gs.unregister(hk);
                        }
                        sc_on = c.shortcut;
                    }
                    // read SMC once per tick: feeds both the live-smc.json bridge and the menu-bar W.
                    let mut sys_w = None;
                    if let Some(ref s) = smc {
                        sys_w = s.system_watts();
                        let (adp_w, bat_w) = (s.adapter_watts(), s.battery_watts());
                        let f = |o: Option<f64>| o.map(|v| format!("{:.3}", v)).unwrap_or_else(|| "null".into());
                        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                        // accumulate a rolling 60s window so the recorder can log the minute's AVERAGE power
                        // (∫W dt / 60s) instead of a single instant — a 0.1s spike no longer skews a whole minute.
                        if let (Some(sw), Some(aw), Some(bw)) = (sys_w, adp_w, bat_w) { pwin.push((now, sw, aw, bw)); }
                        pwin.retain(|(t, ..)| now.saturating_sub(*t) <= 60);
                        let (mut ss, mut sa, mut sb) = (0.0, 0.0, 0.0);
                        for (_, sw, aw, bw) in &pwin { ss += sw; sa += aw; sb += bw; }
                        let n = pwin.len() as f64;
                        let av = |sum: f64| if n > 0.0 { Some(sum / n) } else { None };
                        let j = format!("{{\"tempC\":{},\"systemW\":{},\"adapterW\":{},\"batteryW\":{},\"systemWAvg\":{},\"adapterWAvg\":{},\"batteryWAvg\":{},\"dcInV\":{},\"dcInA\":{},\"at\":{}}}",
                            f(s.battery_temp_c()), f(sys_w), f(adp_w), f(bat_w), f(av(ss)), f(av(sa)), f(av(sb)), f(s.dc_in_volts()), f(s.dc_in_amps()), now);
                        let _ = std::fs::write(data_dir().join("live-smc.json"), j);
                    }
                    if let Some(tray) = handle.tray_by_id("tray") {
                        // menu-bar "W" = live system draw (SMC) when we have it, else battery-rail watts
                        let mut title = live::tray_title(&l, c.info, sys_w.unwrap_or(l.watts));
                        if c.widget == "iconpct" { title = String::new(); }   // % is drawn inside the icon
                        // text-only widget must never be blank (no glyph to fall back on)
                        else if c.widget == "text" && title.is_empty() { title = format!("{}%", l.pct.round() as i64); }
                        let _ = tray.set_title(if title.is_empty() { None } else { Some(title) });
                        // redraw the glyph only when something visible changes (level/charge/widget/color/xl/lpm)
                        let key = format!("{}-{}-{}-{}-{}-{}-{}", l.pct.round() as i64, l.charging, l.full, c.colorize, c.widget, c.glyph_xl, lpm);
                        if l.ok && key != last_key {
                            last_key = key;
                            match live::menu_icon(&l, c.colorize, &c.widget, c.glyph_xl, lpm) {
                                Some((rgba, w, h)) => { let _ = tray.set_icon(Some(tauri::image::Image::new_owned(rgba, w, h))); }
                                None => { let _ = tray.set_icon(None); }   // text-only widget
                            }
                        }
                    }
                    // ~2s cadence for the continuously-changing values (W/temp), but break early
                    // when IOKit signals a power-source change so plug/unplug reflects near-instantly.
                    // Also poll for popover overflow actions here so they respond within ~250ms.
                    for _ in 0..8 {
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        let af = data_dir().join("action");
                        if let Ok(a) = std::fs::read_to_string(&af) {
                            let _ = std::fs::remove_file(&af);
                            match a.trim() {
                                "report" => { let h = handle.clone(); let _ = handle.run_on_main_thread(move || { show_main(&h); if let Some(w) = h.get_webview_window("popover") { let _ = w.hide(); } }); }
                                "quit" => { let h = handle.clone(); let _ = handle.run_on_main_thread(move || h.exit(0)); }
                                "record" => { let on = !plist_path().exists(); std::thread::spawn(move || run_record(if on { "on" } else { "off" })); }
                                "hide" => { let h = handle.clone(); let _ = handle.run_on_main_thread(move || { if let Some(w) = h.get_webview_window("popover") { let _ = w.hide(); } }); }
                                _ => {}
                            }
                            break;   // re-read state promptly after acting
                        }
                        // popover reported its content height → size its window to fit exactly (no scrollbar)
                        if let Ok(h) = std::fs::read_to_string(data_dir().join("popover-h")).map(|s| s.trim().parse::<f64>()) {
                            if let Ok(h) = h {
                                if (h - last_pop_h).abs() > 1.0 {
                                    last_pop_h = h;
                                    let hh = handle.clone();
                                    let _ = handle.run_on_main_thread(move || {
                                        if let Some(w) = hh.get_webview_window("popover") { let _ = w.set_size(tauri::LogicalSize::new(320.0, h)); }
                                    });
                                }
                            }
                        }
                        if power::take_dirty() { break; }
                    }
                }
            });

            // pre-warm the popover once the sidecar server is up (loads the page hidden), so the
            // first icon click just show()s an already-rendered window — near-instant, like Stats.
            let prewarm = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1800));
                let p2 = prewarm.clone();
                let _ = prewarm.run_on_main_thread(move || { let _ = ensure_popover(&p2); });
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

// Round the popover's NATIVE window: making the webview background transparent (CSS) alone leaves a
// square opaque NSWindow behind the rounded body. Here we clip the content view's layer to a corner
// radius and clear the window background, so the window itself is a rounded, transparent card.
#[cfg(target_os = "macos")]
fn round_popover_window(w: &tauri::WebviewWindow) {
    use objc::runtime::{Object, NO, YES};
    use objc::{class, msg_send, sel, sel_impl};
    let Ok(ns_window) = w.ns_window() else { return };
    let ns_window = ns_window as *mut Object;
    unsafe {
        let _: () = msg_send![ns_window, setOpaque: NO];
        let clear: *mut Object = msg_send![class!(NSColor), clearColor];
        let _: () = msg_send![ns_window, setBackgroundColor: clear];
        let content_view: *mut Object = msg_send![ns_window, contentView];
        let _: () = msg_send![content_view, setWantsLayer: YES];
        let layer: *mut Object = msg_send![content_view, layer];
        let _: () = msg_send![layer, setCornerRadius: 34.0_f64];
        let _: () = msg_send![layer, setMasksToBounds: YES];
    }
}

// The popover: a small borderless window loading the node server's /popover.html (pure web,
// no Tauri commands → safe to load from localhost). Lazily created, then reused.
fn ensure_popover(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window("popover") { return Some(w); }
    let w = WebviewWindowBuilder::new(
        app,
        "popover",
        WebviewUrl::External("http://localhost:4317/popover.html".parse().unwrap()),
    )
    .title("배터리")
    .inner_size(320.0, 700.0)   // roomy fallback; popover.js fitWindow() trims it to content when it can
    .decorations(false)
    .transparent(true)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()
    .ok()?;
    #[cfg(target_os = "macos")]
    round_popover_window(&w);
    Some(w)
}

// Current on-screen rect of the tray icon (physical px) — so a shortcut/menu open (no click) still
// anchors the popover under the icon. Falls back to the last click rect, then place_popover's corner.
fn icon_anchor(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    if let Some(tray) = app.tray_by_id("tray") {
        if let Ok(Some(rect)) = tray.rect() {
            let p = rect.position.to_physical::<f64>(1.0);
            let sz = rect.size.to_physical::<f64>(1.0);
            return Some((p.x, p.y, sz.width, sz.height));
        }
    }
    LAST_ICON_RECT.lock().ok().and_then(|g| *g)
}

// Left-click a tray icon: toggle the popover, anchored under the clicked icon. A fresh show always
// lands on the dashboard (closeSettings), so re-opening never gets stuck in the settings panel.
fn toggle_popover(app: &AppHandle, anchor: Option<(f64, f64, f64, f64)>) {
    if let Some(w) = app.get_webview_window("popover") {
        if w.is_visible().unwrap_or(false) { let _ = w.hide(); return; }
        if hidden_just_now() { return; }   // this same click may have just hidden it via focus-loss
    }
    if let Some(w) = ensure_popover(app) {
        fit_popover(&w);
        place_popover(&w, anchor.or_else(|| icon_anchor(app)));
        let _ = w.eval("window.closeSettings&&closeSettings()");
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Size the popover to the height its web content last reported, so a fresh show is already
// fitted (no scrollbar, no square margin around the rounded/transparent body).
fn fit_popover(w: &tauri::WebviewWindow) {
    if let Ok(Ok(h)) = std::fs::read_to_string(data_dir().join("popover-h")).map(|s| s.trim().parse::<f64>()) {
        if (120.0..=2000.0).contains(&h) { let _ = w.set_size(tauri::LogicalSize::new(320.0, h)); }
    }
}

// Force-show the popover (menu "설정 열기" / global shortcut), anchored under the icon. `settings`
// opens it straight in the settings panel via the page's window.openSettings() hook — retried
// briefly in case the page is still loading.
fn open_popover(app: &AppHandle, settings: bool) {
    if let Some(w) = ensure_popover(app) {
        fit_popover(&w);
        place_popover(&w, icon_anchor(app));
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.eval(if settings {
            "(function r(n){if(window.openSettings){openSettings()}else if(n<40){setTimeout(function(){r(n+1)},50)}})(0)"
        } else {
            "window.closeSettings&&closeSettings()"
        });
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
