// Native live battery read for the menu-bar tray title (Stats-parity live glance).
// Uses `starship-battery` (IOKit under the hood, ~0.4ms) so the 2s ticker never spawns a subprocess.
// The rich popover reads the node server's /api/live (fresh ioreg sample) instead — this module only
// needs enough for the tray title: level %, power (W), and charge state.
use starship_battery::units::{
    electric_potential::volt, energy::watt_hour, power::watt, ratio::percent,
    thermodynamic_temperature::degree_celsius, time::second,
};
use starship_battery::{Manager, State};

#[derive(Clone, Default, serde::Serialize)]
pub struct Live {
    pub ok: bool,
    pub pct: f64,          // 0..100
    pub watts: f64,        // |energy_rate| magnitude
    pub charging: bool,
    pub discharging: bool,
    pub full: bool,
    pub volts: f64,
    pub temp_c: Option<f64>,
    pub cycles: Option<u32>,
    pub health_pct: Option<f64>,
    pub time_min: Option<i64>, // to-empty (discharging) or to-full (charging)
    pub state: String,         // 충전 / 방전 / 완충 / AC
}

// A reusable reader — hold the Manager + Battery across ticks and just refresh().
// Everything is fallible (no panics): this runs on a detached ticker thread, so a panic here
// would freeze the tray title forever. On any failure it returns Live::default() and retries next tick.
pub struct Reader {
    manager: Option<Manager>,
    battery: Option<starship_battery::Battery>,
}

impl Reader {
    pub fn new() -> Self {
        let manager = Manager::new().ok();
        let battery = manager
            .as_ref()
            .and_then(|m| m.batteries().ok().and_then(|mut it| it.next().and_then(Result::ok)));
        Reader { manager, battery }
    }

    pub fn read(&mut self) -> Live {
        if self.manager.is_none() {
            self.manager = Manager::new().ok();
        }
        let Some(manager) = self.manager.as_ref() else { return Live::default() };
        if self.battery.is_none() {
            self.battery = manager.batteries().ok().and_then(|mut it| it.next().and_then(Result::ok));
        }
        let Some(b) = self.battery.as_mut() else { return Live::default() };
        if manager.refresh(b).is_err() {
            self.battery = None;
            return Live::default();
        }
        let st = b.state();
        let charging = st == State::Charging;
        let discharging = st == State::Discharging;
        let full = st == State::Full;
        let full_wh = b.energy_full().get::<watt_hour>() as f64;
        let design_wh = b.energy_full_design().get::<watt_hour>() as f64;
        let health = if design_wh > 0.0 { Some((full_wh / design_wh * 100.0 * 10.0).round() / 10.0) } else { None };
        // only a meaningful time while actively charging/discharging (full/AC-idle → no countdown)
        let secs = if charging { b.time_to_full().map(|t| t.get::<second>() as f64) }
            else if discharging { b.time_to_empty().map(|t| t.get::<second>() as f64) }
            else { None };
        Live {
            ok: true,
            pct: (b.state_of_charge().get::<percent>() as f64 * 10.0).round() / 10.0,
            watts: (b.energy_rate().get::<watt>() as f64).abs(),
            charging,
            discharging,
            full,
            volts: (b.voltage().get::<volt>() as f64 * 100.0).round() / 100.0,
            temp_c: b.temperature().map(|t| (t.get::<degree_celsius>() as f64 * 10.0).round() / 10.0),
            cycles: b.cycle_count(),
            health_pct: health,
            time_min: secs.map(|s| (s / 60.0).round() as i64).filter(|&m| m > 0),
            state: if charging { "충전".into() } else if full { "완충".into() } else if discharging { "방전".into() } else { "외부 전원".into() },   // 파워뱅크도 포함 — "AC"라 부르지 않는다
        }
    }
}

// ---- menu-bar display settings (persisted; changed from the tray menu) ----
// The persisted settings, shared by the menu-bar (Rust) and the popover settings panel
// (which reads/writes them through the node server's /api/config → the same tray.json).
// Every field has a #[serde(default)] so a partial or older JSON still deserializes.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Cfg {
    #[serde(default = "d_info")] pub info: u8,      // LEGACY title enum (0–7) — superseded by text_*; kept so old tray.json still works
    #[serde(default = "d_true")] pub colorize: bool,// color the glyph fill by level (else monochrome except red <20%)
    #[serde(default = "d_low")] pub low_pct: u8,    // discharge warning at ≤ this % (0 = off)
    #[serde(default = "d_high")] pub high_pct: u8,  // charge-complete alert at ≥ this % (0 = off)
    #[serde(default = "d_widget")] pub widget: String, // menu-bar widget: "icon" | "iconpct" | "combo" | "stack" | "bar" | "text"
    #[serde(default)] pub glyph_xl: bool,           // draw the glyph at a larger body size ("icon" style only)
    #[serde(default = "d_true")] pub shortcut: bool, // register a global ⌥⌃B to open the popover (default on)
    // independent title items (the popover's 텍스트 chips). None = file predates the chips UI →
    // fall back to the legacy `info` enum (see title_items) so old configs keep their meaning.
    #[serde(default)] pub text_pct: Option<bool>,   // append "67%"
    #[serde(default)] pub text_time: Option<bool>,  // append "5:12" (time to empty/full, when known)
    #[serde(default)] pub text_w: Option<bool>,     // LEGACY single power chip (with w_src) — superseded by text_w_sys/bat
    #[serde(default)] pub w_src: Option<String>,    // LEGACY: which W the single chip meant ("sys" | "bat")
    #[serde(default)] pub text_w_sys: Option<bool>, // append system power "7.4W"
    #[serde(default)] pub text_w_bat: Option<bool>, // append battery-rail power "3.1W" (both may be on)
    #[serde(default)] pub w7_src: Option<String>,   // widget "wstack" power source: "sys" | "bat"
    #[serde(default = "d_true")] pub digit_deco: bool, // stack digits: state color + outline (false = plain white)
    #[serde(default = "d_bolt_style")] pub bolt_style: String, // charging bolt: "classic" | "bold"
    #[serde(default)] pub text_temp: Option<bool>,  // append battery temperature "31°" (SMC, when known)
    #[serde(default)] pub text_adp: Option<bool>,   // append adapter measured power "60.2W" (AC only)
    // 충전 중 저잔량에서 채움이 번개에 가리는 문제의 표시 방식 (wstack 계열):
    // "current" 기존 | "waterline" 수위선 | "thermo" 온도계 번개 | "swap" 사이드 스왑
    // | "outline" 윤곽선 번개(컷아웃 없음) | "badge" 미니 배지 | "hybrid" 윤곽선+온도계
    #[serde(default = "d_chg_fill")] pub chg_fill: String,
    #[serde(default)] pub small_unit: bool,         // 전력 단위 W를 작게(아이콘: 실제 축소, 텍스트: ᵂ) — 메뉴바 폭 절약
}

impl Cfg {
    // Effective side-text items as (pct, time, w_sys, w_bat, adp, temp) — system & battery power
    // are INDEPENDENT (both can show). Precedence: explicit text_w_sys/bat > the old single
    // text_w+w_src > the original 표시 텍스트 enum (0 none·1 %·2 time·3 sysW·4 %+sysW·5 %+time·
    // 6 batW·7 %+batW). temp/adp are post-chips additions: absent = off, no legacy meaning.
    pub fn title_items(&self) -> (bool, bool, bool, bool, bool, bool) {
        let temp = self.text_temp.unwrap_or(false);
        let adp = self.text_adp.unwrap_or(false);
        // no chip keys at all → file predates the chips UI → map the legacy enum
        if self.text_pct.is_none() && self.text_time.is_none() && self.text_w.is_none()
            && self.text_w_sys.is_none() && self.text_w_bat.is_none() {
            let i = if self.info > 7 { 4 } else { self.info };
            return (matches!(i, 1 | 4 | 5 | 7), matches!(i, 2 | 5), matches!(i, 3 | 4), matches!(i, 6 | 7), adp, temp);
        }
        let (w_sys, w_bat) = if self.text_w_sys.is_some() || self.text_w_bat.is_some() {
            (self.text_w_sys.unwrap_or(false), self.text_w_bat.unwrap_or(false))
        } else {   // migrate the old single power chip
            let tw = self.text_w.unwrap_or(false);
            let bat = self.w_src.as_deref() == Some("bat");
            (tw && !bat, tw && bat)
        };
        (self.text_pct.unwrap_or(false), self.text_time.unwrap_or(false), w_sys, w_bat, adp, temp)
    }
    // styles that draw the % digits inside the glyph — the % title item is redundant there
    // (the settings UI shows this as a locked "아이콘에 포함" chip, so the rule is visible)
    pub fn digits_in_icon(&self) -> bool { matches!(self.widget.as_str(), "combo" | "iconpct" | "stack" | "wstack") }
    // widget "wstack": which power feeds the top number
    pub fn w7_battery(&self) -> bool { self.w7_src.as_deref() == Some("bat") }
    pub fn bold_bolt(&self) -> bool { self.bolt_style == "bold" }
    // chg_fill 문자열 → 렌더 모드 번호 (아이디어 시트의 0~6과 일치)
    pub fn chg_mode(&self) -> u8 {
        match self.chg_fill.as_str() {
            "waterline" => 1, "thermo" => 2, "swap" => 3, "outline" => 4, "badge" => 5, "hybrid" => 6,
            _ => 0,   // "current"/미지정 → 기존 렌더
        }
    }
}
fn d_info() -> u8 { 4 }
fn d_true() -> bool { true }
fn d_low() -> u8 { 20 }
fn d_high() -> u8 { 80 }
fn d_widget() -> String { "icon".into() }
fn d_bolt_style() -> String { "bold".into() }   // 기본 번개 = Bowie (Aladdin Sane풍 만화체)
fn d_chg_fill() -> String { "current".into() }
impl Default for Cfg {
    fn default() -> Self {
        Cfg { info: 4, colorize: true, low_pct: 20, high_pct: 80, widget: "icon".into(), glyph_xl: false, shortcut: true,
              text_pct: None, text_time: None, text_w: None, w_src: None,   // None → title_items falls back to `info`
              text_w_sys: None, text_w_bat: None, w7_src: None, digit_deco: true, bolt_style: d_bolt_style(),
              text_temp: None, text_adp: None, chg_fill: d_chg_fill(), small_unit: false }
    }
}
pub fn cfg_path() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join("Library/Application Support/3d-battery-life/tray.json")
}
// The popover's settings panel writes tray.json (via the node server's /api/config); the tray
// menu no longer mutates it, so we only ever READ it here.
pub fn load_cfg() -> Cfg {
    let mut c: Cfg = std::fs::read_to_string(cfg_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    if c.info > 7 { c.info = 4; }   // clamp the menu-bar text mode to a valid variant
    if !matches!(c.bolt_style.as_str(), "classic" | "bold") { c.bolt_style = d_bolt_style(); }
    c
}
fn time_str(l: &Live) -> String {
    match l.time_min {
        Some(m) if m > 0 => format!("{}:{:02}", m / 60, m % 60),
        _ => "–".into(),
    }
}

// SIGNED battery power for display — Live.watts is a magnitude, so the sign is reconstructed from
// state: + while charging (into the battery), − while discharging (out), 0 when idle/full.
pub fn signed_watts(l: &Live) -> f64 {
    if l.charging { l.watts } else if l.discharging { -l.watts } else { 0.0 }
}
// "+3.1W" / "−2.4W" / "0.0W" — one decimal, explicit sign so charge vs discharge reads at a glance
fn fmt_signed_w(w: f64) -> String {
    if w.abs() < 0.05 { "0.0W".into() }
    else { format!("{}{:.1}W", if w > 0.0 { "+" } else { "−" }, w.abs()) }
}

// macOS's DISPLAYED battery % (`pmset -g batt` → "… 67%; discharging …"). starship's energy-ratio
// % can sit 1–2% off the number macOS itself shows — the tray digits must match the system's own
// figure (and the popover's ioreg %), so when this parses the ticker overrides Live.pct with it.
pub fn displayed_pct() -> Option<f64> {
    parse_pmset_pct(&cmd_timeout("pmset", &["-g", "batt"], 1500)?)
}

// Command::output() has NO timeout — a hung child would block the caller (the tray ticker!)
// forever. Spawn with a piped stdout, poll try_wait against a deadline, kill on timeout.
// (Output is read after exit; fine for small outputs like pmset's, well under the pipe buffer.)
pub fn cmd_timeout(bin: &str, args: &[&str], ms: u64) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut child = Command::new(bin).args(args).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ms);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); return None; }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(_) => { let _ = child.kill(); let _ = child.wait(); return None; }
        }
    }
    let mut s = String::new();
    child.stdout.take()?.read_to_string(&mut s).ok()?;
    Some(s)
}
fn parse_pmset_pct(s: &str) -> Option<f64> {
    let head = &s[..s.find('%')?];
    let start = head.rfind(|c: char| !c.is_ascii_digit()).map_or(0, |j| j + 1);
    head[start..].parse::<f64>().ok().filter(|p| (0.0..=100.0).contains(p))
}

// Menu-bar glyph ink: WHITE with a subtle dark shadow — the way macOS itself (and every other
// menu-bar app) draws bar contents over the wallpaper, in light AND dark system mode. The shadow
// is what keeps white legible on light backdrops, so no appearance detection is needed (an
// AppleInterfaceStyle-based dark-ink variant looked alien next to the neighboring icons).
const INK: (u8, u8, u8, u8) = (255, 255, 255, 255);
const SHADOW: (u8, u8, u8, u8) = (0, 0, 0, 70);         // faint drop under body outlines
const DIGIT_SHADOW: (u8, u8, u8, u8) = (0, 0, 0, 140);  // soft backing for digits/bolt/plug

// ---- anti-aliased rendering core -----------------------------------------------------------
// The old pixel-art path (opaque rects on a tiny buffer) could never match the system icons —
// they're vector shapes + real type. Here every glyph is rasterized at SS× the output buffer
// with analytic rounded-rect/polygon inside-tests, digits are stamped from the SYSTEM FONT
// (San Francisco via fontdue), and a box-downsample produces the anti-aliased result.
const SS: i32 = 3;   // supersample factor (AA quality)
// Output DENSITY over the logical (18pt) layout. The menu-bar glyph is displayed at 22pt (we
// enlarge it past tray-icon's 18pt cap), so a plain 18pt-dense image would upscale ~1.22× and
// soften. Rendering 1.3× denser makes the image downscale at BOTH 18pt and 22pt → always crisp.
// Layout coords stay in logical units; only the pixel buffer gets denser.
const GLYPH_DENS: f32 = 1.30;

struct Hi { w: i32, h: i32, buf: Vec<u8>, s: f32 }   // straight-alpha RGBA at (logical × s), s = SS·density
impl Hi {
    fn new(w: u32, h: u32) -> Hi {
        let s = SS as f32 * GLYPH_DENS;
        let bw = (((w as f32 * s).round() as i32) / SS).max(1) * SS;   // divisible by SS
        let bh = (((h as f32 * s).round() as i32) / SS).max(1) * SS;
        Hi { w: bw, h: bh, buf: vec![0u8; (bw * bh * 4) as usize], s }
    }
    // knock a shape OUT of what's already drawn (alpha → 0 by coverage) — used for the 1px
    // transparent rim around digits/bolt over the battery fill (macOS's own cutout grammar)
    fn erase(&mut self, x: i32, y: i32, cov: f32) {
        if x < 0 || y < 0 || x >= self.w || y >= self.h || cov <= 0.0 { return; }
        let i = ((y * self.w + x) * 4 + 3) as usize;
        self.buf[i] = (self.buf[i] as f32 * (1.0 - cov.min(1.0))).round() as u8;
    }
    fn blend(&mut self, x: i32, y: i32, c: (u8, u8, u8, u8), cov: f32) {
        if x < 0 || y < 0 || x >= self.w || y >= self.h || cov <= 0.0 { return; }
        let i = ((y * self.w + x) * 4) as usize;
        let sa = cov.min(1.0) * c.3 as f32 / 255.0;
        if sa <= 0.0 { return; }
        let da = self.buf[i + 3] as f32 / 255.0;
        let oa = sa + da * (1.0 - sa);
        let src = [c.0, c.1, c.2];
        for k in 0..3 {
            let v = (src[k] as f32 * sa + self.buf[i + k] as f32 * da * (1.0 - sa)) / oa;
            self.buf[i + k] = v.round() as u8;
        }
        self.buf[i + 3] = (oa * 255.0).round() as u8;
    }
    // coords below are in OUTPUT units (f32) — scaled to the supersample grid internally
    fn fill_rrect(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, r: f32, c: (u8, u8, u8, u8)) {
        let s = self.s;
        let (hx0, hy0, hx1, hy1) = (x0 * s, y0 * s, x1 * s, y1 * s);
        let r = (r * s).min((hx1 - hx0) / 2.0).min((hy1 - hy0) / 2.0).max(0.0);
        for y in (hy0.floor() as i32).max(0)..(hy1.ceil() as i32).min(self.h) {
            for x in (hx0.floor() as i32).max(0)..(hx1.ceil() as i32).min(self.w) {
                if in_rr(x as f32 + 0.5, y as f32 + 0.5, hx0, hy0, hx1, hy1, r) { self.blend(x, y, c, 1.0); }
            }
        }
    }
    fn stroke_rrect(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, r: f32, sw: f32, c: (u8, u8, u8, u8)) {
        let s = self.s;
        let (hx0, hy0, hx1, hy1) = (x0 * s, y0 * s, x1 * s, y1 * s);
        let r = (r * s).min((hx1 - hx0) / 2.0).min((hy1 - hy0) / 2.0).max(0.0);
        let sw = sw * s;
        for y in (hy0.floor() as i32).max(0)..(hy1.ceil() as i32).min(self.h) {
            for x in (hx0.floor() as i32).max(0)..(hx1.ceil() as i32).min(self.w) {
                let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
                if in_rr(px, py, hx0, hy0, hx1, hy1, r)
                    && !in_rr(px, py, hx0 + sw, hy0 + sw, hx1 - sw, hy1 - sw, (r - sw).max(0.0)) {
                    self.blend(x, y, c, 1.0);
                }
            }
        }
    }
    fn fill_poly(&mut self, pts: &[(f32, f32)], c: (u8, u8, u8, u8)) {
        let s = self.s;
        let p: Vec<(f32, f32)> = pts.iter().map(|&(x, y)| (x * s, y * s)).collect();
        let (x0, x1) = p.iter().fold((f32::MAX, f32::MIN), |a, q| (a.0.min(q.0), a.1.max(q.0)));
        let (y0, y1) = p.iter().fold((f32::MAX, f32::MIN), |a, q| (a.0.min(q.1), a.1.max(q.1)));
        for y in (y0.floor() as i32).max(0)..(y1.ceil() as i32).min(self.h) {
            for x in (x0.floor() as i32).max(0)..(x1.ceil() as i32).min(self.w) {
                let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
                let mut inside = false;
                let mut j = p.len() - 1;
                for i in 0..p.len() {
                    let (xi, yi) = p[i];
                    let (xj, yj) = p[j];
                    if (yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi { inside = !inside; }
                    j = i;
                }
                if inside { self.blend(x, y, c, 1.0); }
            }
        }
    }
    fn down(self) -> (Vec<u8>, u32, u32) {   // alpha-weighted box average (no dark fringes)
        let (ow, oh) = ((self.w / SS) as u32, (self.h / SS) as u32);
        let mut out = vec![0u8; (ow * oh * 4) as usize];
        for oy in 0..oh as i32 {
            for ox in 0..ow as i32 {
                let (mut r, mut g, mut b, mut a) = (0f32, 0f32, 0f32, 0f32);
                for sy in 0..SS {
                    for sx in 0..SS {
                        let i = (((oy * SS + sy) * self.w + ox * SS + sx) * 4) as usize;
                        let al = self.buf[i + 3] as f32 / 255.0;
                        r += self.buf[i] as f32 * al; g += self.buf[i + 1] as f32 * al; b += self.buf[i + 2] as f32 * al; a += al;
                    }
                }
                let o = ((oy as u32 * ow + ox as u32) * 4) as usize;
                if a > 0.0 {
                    out[o] = (r / a).round() as u8;
                    out[o + 1] = (g / a).round() as u8;
                    out[o + 2] = (b / a).round() as u8;
                    out[o + 3] = (a / (SS * SS) as f32 * 255.0).round() as u8;
                }
            }
        }
        (out, ow, oh)
    }
}
fn in_rr(px: f32, py: f32, x0: f32, y0: f32, x1: f32, y1: f32, r: f32) -> bool {
    if px < x0 || px > x1 || py < y0 || py > y1 { return false; }
    // NOT f32::clamp: when r equals the half-extent (thin fill at low battery), float error can
    // leave lo microscopically ABOVE hi and std's clamp PANICS ("min > max", off by ~2e-6) —
    // this froze the tray twice at ≤20%. Order min/max by hand and fall back to the midpoint.
    let safe = |v: f32, lo: f32, hi: f32| if hi < lo { (lo + hi) * 0.5 } else { v.max(lo).min(hi) };
    let dx = px - safe(px, x0 + r, x1 - r);
    let dy = py - safe(py, y0 + r, y1 - r);
    dx * dx + dy * dy <= r * r
}

// System font for the glyph digits (REAL type, like the menu bar itself). Loaded once; falls
// back through Helvetica and finally to the 5×7 pixel font if nothing parses.
static SYS_FONT: std::sync::OnceLock<Option<fontdue::Font>> = std::sync::OnceLock::new();
fn sys_font() -> Option<&'static fontdue::Font> {
    SYS_FONT.get_or_init(|| {
        for p in ["/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/SFNSRounded.ttf",
                  "/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/HelveticaNeue.ttc"] {
            if let Ok(b) = std::fs::read(p) {
                if let Ok(f) = fontdue::Font::from_bytes(b, fontdue::FontSettings::default()) { return Some(f); }
            }
        }
        None
    }).as_ref()
}
// rasterize `text` centered at (cx, cy) and feed every glyph pixel (x, y, coverage) to `f` —
// the shared layout core under stamp_text (ink) and stamp_digits_cut (halo erase)
fn glyph_px(s: f32, text: &str, size: f32, cx: f32, cy: f32, mut f: impl FnMut(i32, i32, f32)) -> bool {
    let Some(font) = sys_font() else { return false };
    let px = size * s;
    let gs: Vec<(fontdue::Metrics, Vec<u8>)> = text.chars().map(|ch| font.rasterize(ch, px)).collect();
    let total: f32 = gs.iter().map(|(m, _)| m.advance_width).sum();
    let cap = gs.iter().map(|(m, _)| m.height).max().unwrap_or(0) as f32;
    let left = cx * s - total / 2.0;
    let top = cy * s - cap / 2.0;
    let mut pen = left;
    for (m, bm) in &gs {
        let gx = (pen + m.xmin as f32).round() as i32;
        let gy = (top + cap - m.height as f32 - m.ymin as f32).round() as i32;
        for row in 0..m.height {
            for col in 0..m.width {
                f(gx + col as i32, gy + row as i32, bm[row * m.width + col] as f32 / 255.0);
            }
        }
        pen += m.advance_width;
    }
    true
}
fn stamp_text(hi: &mut Hi, text: &str, size: f32, cx: f32, cy: f32, c: (u8, u8, u8, u8)) -> bool {
    let s = hi.s;
    glyph_px(s, text, size, cx, cy, |x, y, cov| hi.blend(x, y, c, cov))
}
// clip rect in OUTPUT units → an (x0, y0, x1, y1) test in hi-buffer pixels. The cutout stamps
// clip to the battery's INNER zone so the halo can knock out the fill but never the body outline.
fn clip_test(s: f32, clip: (f32, f32, f32, f32)) -> impl Fn(i32, i32) -> bool {
    let (x0, y0, x1, y1) = (clip.0 * s, clip.1 * s, clip.2 * s, clip.3 * s);
    move |x, y| { let (px, py) = (x as f32 + 0.5, y as f32 + 0.5); px >= x0 && px <= x1 && py >= y0 && py <= y1 }
}
// erase the text's shape dilated by `r` output px (9 offset stamps ≈ a round dilation) — punch
// the transparent rim BEFORE stamp_digits draws the shadow+ink into the hole
fn stamp_digits_cut(hi: &mut Hi, text: &str, size: f32, cx: f32, cy: f32, r: f32, clip: (f32, f32, f32, f32)) {
    let s = hi.s;
    let inside = clip_test(s, clip);
    let d = r * 0.7071;
    for (ox, oy) in [(0.0f32, 0.0f32), (r, 0.0), (-r, 0.0), (0.0, r), (0.0, -r), (d, d), (d, -d), (-d, d), (-d, -d)] {
        let _ = glyph_px(s, text, size, cx + ox, cy + oy, |x, y, cov| if inside(x, y) { hi.erase(x, y, cov) });
    }
}
// digits with the tray's soft shadow; pixel-font fallback keeps the tray alive without a font
// stamp_digits, but shrink the font to keep the text within `max_w` output units (e.g. a longer
// "−12.3W" must still fit the wstack canvas instead of clipping at the edges)
fn stamp_digits_fit(hi: &mut Hi, text: &str, size: f32, max_w: f32, cx: f32, cy: f32, c: (u8, u8, u8, u8), shadow: bool) {
    let mut size = size;
    if let Some(f) = sys_font() {
        let px = size * hi.s;
        let total: f32 = text.chars().map(|ch| f.metrics(ch, px).advance_width).sum::<f32>() / hi.s;
        if total > max_w { size *= max_w / total; }
    }
    stamp_digits(hi, text, size, cx, cy, c, shadow);
}
// Power readout with an optional SMALL trailing unit: "8.4W" → value at full size + "W" at ~58%
// riding low (subscript-ish). Saves menu-bar width and de-emphasizes the unit. Falls back to the
// plain one-string stamp when small_unit is off, the text has no W, or no system font is loaded.
fn stamp_power_fit(hi: &mut Hi, text: &str, size: f32, max_w: f32, cx: f32, cy: f32, c: (u8, u8, u8, u8), shadow: bool, small_unit: bool) {
    if !small_unit || !text.ends_with('W') { stamp_digits_fit(hi, text, size, max_w, cx, cy, c, shadow); return; }
    let Some(f) = sys_font() else { stamp_digits_fit(hi, text, size, max_w, cx, cy, c, shadow); return; };
    let val = &text[..text.len() - 1];
    let s = hi.s;
    let wof = |t: &str, sz: f32| t.chars().map(|ch| f.metrics(ch, sz * s).advance_width).sum::<f32>() / s;
    let (mut vs, mut us, gap) = (size, size * 0.58, 0.5f32);
    let mut total = wof(val, vs) + gap + wof("W", us);
    if total > max_w { let k = max_w / total; vs *= k; us *= k; total = max_w; }
    let vx = cx - total / 2.0 + wof(val, vs) / 2.0;
    let ux = cx + total / 2.0 - wof("W", us) / 2.0;
    let ucy = cy + (vs - us) * 0.42;   // 아래 첨자 느낌: 단위가 베이스라인 쪽에 낮게 붙음
    stamp_digits(hi, val, vs, vx, cy, c, shadow);
    stamp_digits(hi, "W", us, ux, ucy, c, shadow);
}
fn stamp_digits(hi: &mut Hi, text: &str, size: f32, cx: f32, cy: f32, c: (u8, u8, u8, u8), shadow: bool) {
    if sys_font().is_some() {
        if shadow { let _ = stamp_text(hi, text, size, cx, cy + 0.7, DIGIT_SHADOW); }
        let _ = stamp_text(hi, text, size, cx, cy, c);
        return;
    }
    let b = size / 7.0;
    let dw = 6.0 * b;
    let total = text.len() as f32 * dw - b;
    let mut x = cx - total / 2.0;
    let y0 = cy - 3.5 * b;
    for ch in text.chars() {
        let g = DIGITS57[(ch as u8).wrapping_sub(b'0') as usize % 10];
        for (row, bits) in g.iter().enumerate() {
            for col in 0..5 {
                if bits & (1 << (4 - col)) != 0 {
                    hi.fill_rrect(x + col as f32 * b, y0 + row as f32 * b, x + (col + 1) as f32 * b, y0 + (row + 1) as f32 * b, 0.0, c);
                }
            }
        }
        x += dw;
    }
}
// charge-state overlays: the SF-style bolt + plug, white over a soft dark backing
const BOLT: [(f32, f32); 6] = [(0.62, 0.0), (0.08, 0.60), (0.45, 0.60), (0.36, 1.0), (0.92, 0.38), (0.50, 0.38)];
const BOLT_SLIM: [(f32, f32); 6] = [(0.62, 0.0), (0.08, 0.53), (0.45, 0.53), (0.36, 1.0), (0.92, 0.47), (0.50, 0.47)];
// Broad comic-style bolt traced from the user-provided reference: wide flat crown, right notch,
// long lower point. Normalized coordinates keep it reusable at every widget's existing bounds.
const BOLT_BOLD: [(f32, f32); 7] = [(0.355, 0.0), (1.0, 0.0), (0.545, 0.407), (0.842, 0.371), (0.0, 1.0), (0.391, 0.504), (0.038, 0.563)];
// The broad silhouette carries more visual mass on its left flank. In layouts where the bolt
// shares the battery body with digits, nudge only BOLT_BOLD right to restore optical balance.
const BOLD_BOLT_DIGITS_X_SHIFT: f32 = 2.0;
fn digits_bolt_x(cx: f32, bold: bool) -> f32 { cx + if bold { BOLD_BOLT_DIGITS_X_SHIFT } else { 0.0 } }
fn bolt_pts(cx: f32, cy: f32, w: f32, h: f32, slim: bool, bold: bool) -> Vec<(f32, f32)> {
    let shape: &[(f32, f32)] = if bold { &BOLT_BOLD } else if slim { &BOLT_SLIM } else { &BOLT };
    shape.iter().map(|&(u, v)| (cx - w / 2.0 + u * w, cy - h / 2.0 + v * h)).collect()
}
fn bolt_shape(hi: &mut Hi, cx: f32, cy: f32, w: f32, h: f32, slim: bool, bold: bool, c: (u8, u8, u8, u8)) {
    hi.fill_poly(&bolt_pts(cx, cy, w, h, slim, bold), c);
}
fn plug(hi: &mut Hi, cx: f32, top: f32, s: f32, c: (u8, u8, u8, u8)) {
    let pw = s * 0.09;
    for dx in [-s * 0.17, s * 0.17] { hi.fill_rrect(cx + dx - pw, top, cx + dx + pw, top + s * 0.30, pw, c); }
    hi.fill_rrect(cx - s * 0.32, top + s * 0.22, cx + s * 0.32, top + s * 0.62, s * 0.10, c);
    hi.fill_rrect(cx - s * 0.05, top + s * 0.60, cx + s * 0.05, top + s, s * 0.05, c);
}
fn charge_overlay_shape(hi: &mut Hi, l: &Live, cx: f32, cy: f32, w: f32, h: f32, slim: bool, bold: bool) {
    if l.charging {
        bolt_shape(hi, cx + 0.4, cy + 0.7, w, h, slim, bold, DIGIT_SHADOW);
        bolt_shape(hi, cx, cy, w, h, slim, bold, INK);
    } else if l.full {
        plug(hi, cx + 0.4, cy - h / 2.0 + 0.7, h, DIGIT_SHADOW);
        plug(hi, cx, cy - h / 2.0, h, INK);
    }
}
// erase variants of the overlay shapes — the same geometry enlarged by ~`r` and knocked out of
// the canvas (clipped to the battery's inner zone) so the ink lands inside a transparent rim
fn erase_poly(hi: &mut Hi, pts: &[(f32, f32)], clip: (f32, f32, f32, f32)) {
    let s = hi.s;
    let inside = clip_test(s, clip);
    let p: Vec<(f32, f32)> = pts.iter().map(|&(x, y)| (x * s, y * s)).collect();
    let (x0, x1) = p.iter().fold((f32::MAX, f32::MIN), |a, q| (a.0.min(q.0), a.1.max(q.0)));
    let (y0, y1) = p.iter().fold((f32::MAX, f32::MIN), |a, q| (a.0.min(q.1), a.1.max(q.1)));
    for y in (y0.floor() as i32).max(0)..(y1.ceil() as i32).min(hi.h) {
        for x in (x0.floor() as i32).max(0)..(x1.ceil() as i32).min(hi.w) {
            if !inside(x, y) { continue; }
            let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
            let mut hit = false;
            let mut j = p.len() - 1;
            for i in 0..p.len() {
                let (xi, yi) = p[i];
                let (xj, yj) = p[j];
                if (yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi { hit = !hit; }
                j = i;
            }
            if hit { hi.erase(x, y, 1.0); }
        }
    }
}
// True round dilation of a polygon by `r` output pixels. Unlike scaling the polygon's bounding box,
// this measures the shortest Euclidean distance to every edge, so slanted sides and sharp tips get
// the same-width transparent rim. Supersampling supplies the antialiasing at the boundary.
fn erase_poly_dilated(hi: &mut Hi, pts: &[(f32, f32)], r: f32, clip: (f32, f32, f32, f32)) {
    let s = hi.s;
    let inside_clip = clip_test(s, clip);
    let p: Vec<(f32, f32)> = pts.iter().map(|&(x, y)| (x * s, y * s)).collect();
    let rr = (r * s).max(0.0);
    let rr2 = rr * rr;
    let (x0, x1) = p.iter().fold((f32::MAX, f32::MIN), |a, q| (a.0.min(q.0), a.1.max(q.0)));
    let (y0, y1) = p.iter().fold((f32::MAX, f32::MIN), |a, q| (a.0.min(q.1), a.1.max(q.1)));
    for y in ((y0 - rr).floor() as i32).max(0)..((y1 + rr).ceil() as i32).min(hi.h) {
        for x in ((x0 - rr).floor() as i32).max(0)..((x1 + rr).ceil() as i32).min(hi.w) {
            if !inside_clip(x, y) { continue; }
            let q = (x as f32 + 0.5, y as f32 + 0.5);
            let mut within = false;
            let mut j = p.len() - 1;
            for i in 0..p.len() {
                let (a, b) = (p[j], p[i]);
                let (vx, vy) = (b.0 - a.0, b.1 - a.1);
                let len2 = vx * vx + vy * vy;
                let t = if len2 > 0.0 { ((q.0 - a.0) * vx + (q.1 - a.1) * vy) / len2 } else { 0.0 }.clamp(0.0, 1.0);
                let (dx, dy) = (q.0 - (a.0 + t * vx), q.1 - (a.1 + t * vy));
                if dx * dx + dy * dy <= rr2 { within = true; break; }
                j = i;
            }
            // Edge distance covers the rim; the original fill covers the polygon interior.
            if within { hi.erase(x, y, 1.0); }
        }
    }
    erase_poly(hi, pts, clip);
}
// PAINT a polygon but only inside `clip` — the "온도계 번개": the bolt repainted in the fill color
// left of the fill edge, so the bolt itself reads as a level gauge while charging.
fn fill_poly_clip(hi: &mut Hi, pts: &[(f32, f32)], c: (u8, u8, u8, u8), clip: (f32, f32, f32, f32)) {
    let s = hi.s;
    let inside_clip = clip_test(s, clip);
    let p: Vec<(f32, f32)> = pts.iter().map(|&(x, y)| (x * s, y * s)).collect();
    let (x0, x1) = p.iter().fold((f32::MAX, f32::MIN), |a, q| (a.0.min(q.0), a.1.max(q.0)));
    let (y0, y1) = p.iter().fold((f32::MAX, f32::MIN), |a, q| (a.0.min(q.1), a.1.max(q.1)));
    for y in (y0.floor() as i32).max(0)..(y1.ceil() as i32).min(hi.h) {
        for x in (x0.floor() as i32).max(0)..(x1.ceil() as i32).min(hi.w) {
            if !inside_clip(x, y) { continue; }
            let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
            let mut hit = false;
            let mut j = p.len() - 1;
            for i in 0..p.len() {
                let (xi, yi) = p[i];
                let (xj, yj) = p[j];
                if (yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi { hit = !hit; }
                j = i;
            }
            if hit { hi.blend(x, y, c, 1.0); }
        }
    }
}
// PAINT the round-dilated silhouette of a polygon (same Euclidean-distance math as
// erase_poly_dilated, but drawing) — a uniform dark OUTLINE ring for the cutout-less bolt modes.
fn fill_poly_dilated(hi: &mut Hi, pts: &[(f32, f32)], r: f32, c: (u8, u8, u8, u8)) {
    let s = hi.s;
    let p: Vec<(f32, f32)> = pts.iter().map(|&(x, y)| (x * s, y * s)).collect();
    let rr = (r * s).max(0.0);
    let rr2 = rr * rr;
    let (x0, x1) = p.iter().fold((f32::MAX, f32::MIN), |a, q| (a.0.min(q.0), a.1.max(q.0)));
    let (y0, y1) = p.iter().fold((f32::MAX, f32::MIN), |a, q| (a.0.min(q.1), a.1.max(q.1)));
    for y in ((y0 - rr).floor() as i32).max(0)..((y1 + rr).ceil() as i32).min(hi.h) {
        for x in ((x0 - rr).floor() as i32).max(0)..((x1 + rr).ceil() as i32).min(hi.w) {
            let q = (x as f32 + 0.5, y as f32 + 0.5);
            let mut within = false;
            let mut j = p.len() - 1;
            for i in 0..p.len() {
                let (a, b) = (p[j], p[i]);
                let (vx, vy) = (b.0 - a.0, b.1 - a.1);
                let len2 = vx * vx + vy * vy;
                let t = if len2 > 0.0 { ((q.0 - a.0) * vx + (q.1 - a.1) * vy) / len2 } else { 0.0 }.clamp(0.0, 1.0);
                let (dx, dy) = (q.0 - (a.0 + t * vx), q.1 - (a.1 + t * vy));
                if dx * dx + dy * dy <= rr2 { within = true; break; }
                j = i;
            }
            if within { hi.blend(x, y, c, 1.0); }
        }
    }
    hi.fill_poly(pts, c);   // interior too (the white bolt is drawn over it, leaving only the ring)
}
fn erase_rrect(hi: &mut Hi, x0: f32, y0: f32, x1: f32, y1: f32, r: f32, clip: (f32, f32, f32, f32)) {
    let s = hi.s;
    let inside = clip_test(s, clip);
    let (hx0, hy0, hx1, hy1) = (x0 * s, y0 * s, x1 * s, y1 * s);
    let r = (r * s).min((hx1 - hx0) / 2.0).min((hy1 - hy0) / 2.0).max(0.0);
    for y in (hy0.floor() as i32).max(0)..(hy1.ceil() as i32).min(hi.h) {
        for x in (hx0.floor() as i32).max(0)..(hx1.ceil() as i32).min(hi.w) {
            if inside(x, y) && in_rr(x as f32 + 0.5, y as f32 + 0.5, hx0, hy0, hx1, hy1, r) { hi.erase(x, y, 1.0); }
        }
    }
}
fn plug_erase(hi: &mut Hi, cx: f32, top: f32, s: f32, r: f32, clip: (f32, f32, f32, f32)) {
    let pw = s * 0.09 + r;
    for dx in [-s * 0.17, s * 0.17] { erase_rrect(hi, cx + dx - pw, top - r, cx + dx + pw, top + s * 0.30 + r, pw, clip); }
    erase_rrect(hi, cx - s * 0.32 - r, top + s * 0.22 - r, cx + s * 0.32 + r, top + s * 0.62 + r, s * 0.10, clip);
    erase_rrect(hi, cx - s * 0.05 - r, top + s * 0.60 - r, cx + s * 0.05 + r, top + s + r, s * 0.05, clip);
}
// Transparent rim under the bolt/plug: knock the enlarged shape out of the existing drawing first,
// then draw the normal shadow+ink into the hole. Most glyphs clip this to the battery's inner zone;
// wstack deliberately includes the outline so its oversized Stats-style bolt can break through it.
fn charge_overlay_cut_r(hi: &mut Hi, l: &Live, cx: f32, cy: f32, w: f32, h: f32, r: f32, slim: bool, bold: bool, clip: (f32, f32, f32, f32)) {
    if l.charging {
        erase_poly_dilated(hi, &bolt_pts(cx, cy, w, h, slim, bold), r, clip);
    } else if l.full {
        plug_erase(hi, cx, cy - h / 2.0, h, r, clip);
    }
    charge_overlay_shape(hi, l, cx, cy, w, h, slim, bold);
}
fn charge_overlay_cut(hi: &mut Hi, l: &Live, cx: f32, cy: f32, w: f32, h: f32, bold: bool, clip: (f32, f32, f32, f32)) {
    charge_overlay_cut_r(hi, l, cx, cy, w, h, 1.0, false, bold, clip);
}

// Level → fill color (shared by the icon + bar glyphs). Low Power Mode → yellow, like macOS' own
// battery icon (overrides level). Else: red <20% always, orange <40% / green, the app's bright
// 연두 while charging/full; monochrome gray when colorize is off.
// VIVID inks only (macOS system palette + brand accent) — muted fills read as lifeless up there.
fn fill_color(l: &Live, colorize: bool, lpm: bool) -> (u8, u8, u8, u8) {
    if lpm { return (255, 204, 10, 255); }   // macOS systemYellow — the LPM signal
    let pct = l.pct.clamp(0.0, 100.0);
    if pct <= 20.0 { (255, 69, 58, 255) }                   // systemRed
    else if !colorize { (170, 176, 188, 255) }
    else if l.charging || l.full { (168, 255, 51, 255) }    // app accent 연두 (#a8ff33)
    else if pct <= 40.0 { (255, 159, 10, 255) }             // systemOrange
    else { (48, 209, 88, 255) }                             // systemGreen
}

// Which menu-bar glyph to draw. Packs varying amounts of info into a tight menu-bar slot:
//   "text"    → None (title only)
//   "bar"     → thin vertical cell filling from the bottom
//   "iconpct" → battery outline with the % number inside (no fill)
//   "combo"   → battery FILLED by % + number overlaid + charge status (max info, min width)
//   "stack"   → % number stacked ABOVE a mini filled battery (narrowest footprint)
//   _ (icon)  → filled battery + charge status
pub fn menu_icon(l: &Live, colorize: bool, widget: &str, xl: bool, lpm: bool, deco: bool, w_val: f64, w_signed: bool, bold_bolt: bool, chg_mode: u8, small_unit: bool) -> Option<(Vec<u8>, u32, u32)> {
    match widget {
        "text" => None,
        "bar" => Some(bar_glyph(l, colorize, lpm, bold_bolt)),
        "iconpct" => Some(battery_pct_icon(l, colorize, lpm, bold_bolt)),
        "combo" => Some(combo_icon(l, colorize, lpm, bold_bolt)),
        "stack" => Some(stack_icon(l, colorize, lpm, deco, bold_bolt)),
        "wstack" => Some(wstack_icon(l, colorize, lpm, w_val, w_signed, bold_bolt, chg_mode, small_unit)),   // widget 7: power on top, level in battery
        _ => Some(battery_icon(l, colorize, xl, lpm, bold_bolt)),
    }
}

// 5×7 pixel font (low 5 bits per row) — LAST-RESORT digit fallback when no system font parses
const DIGITS57: [[u8; 7]; 10] = [
    [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],   // 0
    [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],   // 1
    [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],   // 2
    [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],   // 3
    [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],   // 4
    [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],   // 5
    [0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],   // 6
    [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],   // 7
    [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],   // 8
    [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110],   // 9
];

// Battery outline with the % number inside, digits colored by state (macOS "show percentage in
// icon" style). Compact: the number lives in the icon, so no separate title text is needed.
pub fn battery_pct_icon(l: &Live, colorize: bool, lpm: bool, bold_bolt: bool) -> (Vec<u8>, u32, u32) {
    let (w, h) = (80u32, 40u32);
    let mut hi = Hi::new(w, h);
    let ink = fill_color(l, colorize, lpm);   // number colored by level / LPM
    // thin rounded outline + nub, soft drop shadow under the white
    hi.stroke_rrect(2.0, 4.8, 66.0, 36.8, 6.0, 2.0, SHADOW);
    hi.fill_rrect(66.5, 16.8, 70.5, 24.8, 2.0, SHADOW);
    hi.stroke_rrect(2.0, 4.0, 66.0, 36.0, 6.0, 2.0, INK);
    hi.fill_rrect(66.5, 16.0, 70.5, 24.0, 2.0, INK);
    // left indicator so iconpct still shows charge state: bolt (charging) / plug (full), in ink.
    // 번개를 큼지막하게 → 그만큼 숫자 자리를 오른쪽으로 더 확보(ind)
    let ind = if l.charging || l.full { 15.0f32 } else { 0.0 };
    if l.charging { bolt_shape(&mut hi, digits_bolt_x(13.0, bold_bolt), 20.0, 12.0, 27.0, false, bold_bolt, ink); }
    else if l.full { plug(&mut hi, 13.0, 9.0, 20.0, ink); }
    let digits = format!("{}", l.pct.clamp(0.0, 100.0).round() as u32);
    stamp_digits(&mut hi, &digits, 21.0, (6.0 + ind + 62.0) / 2.0, 20.0, ink, true);
    hi.down()
}

// Compact single cell: battery FILLED proportional to % (color by level) + % number overlaid
// (white with a dark shadow so it reads over both the fill and the empty part) + charge status
// bolt/plug. Max info in one battery-width slot — no separate title text needed.
pub fn combo_icon(l: &Live, colorize: bool, lpm: bool, bold_bolt: bool) -> (Vec<u8>, u32, u32) {
    let (w, h) = (80u32, 40u32);
    let mut hi = Hi::new(w, h);
    let pct = l.pct.clamp(0.0, 100.0);
    let fill = fill_color(l, colorize, lpm);
    // rounded body + nub (shadowed), proportional fill with an air gap to the outline
    hi.stroke_rrect(2.0, 4.8, 66.0, 36.8, 6.0, 2.0, SHADOW);
    hi.fill_rrect(66.5, 16.8, 70.5, 24.8, 2.0, SHADOW);
    hi.stroke_rrect(2.0, 4.0, 66.0, 36.0, 6.0, 2.0, INK);
    hi.fill_rrect(66.5, 16.0, 70.5, 24.0, 2.0, INK);
    let fw = (56.0 * pct as f32 / 100.0).max(3.0);
    hi.fill_rrect(6.0, 8.0, 6.0 + fw, 32.0, 3.0, fill);
    // charge status at the left + the % as real type over the fill — both punch a 1px
    // transparent rim out of the fill first so they stay crisp on the colored bar
    const CLIP: (f32, f32, f32, f32) = (4.0, 6.0, 64.0, 34.0);   // inner zone (outline untouched)
    let ind = if l.charging || l.full { 12.0f32 } else { 0.0 };
    charge_overlay_cut(&mut hi, l, digits_bolt_x(12.0, bold_bolt), 20.0, 12.0, 26.0, bold_bolt, CLIP);   // combo: 큼지막한 번개
    let digits = format!("{}", pct.round() as u32);
    stamp_digits_cut(&mut hi, &digits, 21.0, (6.0 + ind + 62.0) / 2.0, 20.0, 1.0, CLIP);
    stamp_digits(&mut hi, &digits, 21.0, (6.0 + ind + 62.0) / 2.0, 20.0, INK, true);
    hi.down()
}

// % number stacked ABOVE a mini horizontal battery — narrowest horizontal footprint for a tight
// menu bar. The number is the hero: sized to leave only ~1px headroom, with the battery body
// taking the former bottom slack. `deco`=false → plain white digits: no tint, no shadow.
pub fn stack_icon(l: &Live, colorize: bool, lpm: bool, deco: bool, bold_bolt: bool) -> (Vec<u8>, u32, u32) {
    let (w, h) = (44u32, 36u32);
    let mut hi = Hi::new(w, h);
    let pct = l.pct.clamp(0.0, 100.0);
    let fill = fill_color(l, colorize, lpm);
    let dcol = if deco && (l.charging || l.full || lpm) { fill } else { INK };
    let digits = format!("{}", pct.round() as u32);
    stamp_digits(&mut hi, &digits, 19.0, 22.0, 7.3, dcol, deco);
    // mini rounded battery below — digits hug the ceiling and the body takes every remaining
    // pixel down to the canvas floor (only the soft shadow hangs past the ink). The outline
    // shadow is a touch stronger here: on light menu bars the white outline washes out and the
    // FILL then reads as the battery's edge, making the body look smaller than it is.
    let body_sh = (0u8, 0u8, 0u8, 95u8);
    hi.stroke_rrect(1.0, 15.7, 41.0, 36.0, 5.0, 2.0, body_sh);
    hi.fill_rrect(41.5, 22.2, 44.0, 28.2, 1.5, body_sh);
    hi.stroke_rrect(1.0, 15.0, 41.0, 35.3, 5.0, 2.0, INK);
    hi.fill_rrect(41.5, 21.5, 44.0, 27.5, 1.5, INK);
    // slim air gap (1px) so the visible fill mass carries the body's height
    let fw = (34.0 * pct as f32 / 100.0).max(2.5);
    hi.fill_rrect(4.0, 18.0, 4.0 + fw, 32.3, 3.0, fill);
    charge_overlay_cut(&mut hi, l, 21.0, 26.0, 13.0, 18.0, bold_bolt, (3.0, 17.0, 39.0, 33.3));   // stack: 미니 배터리를 꽉 채우는 번개
    hi.down()
}

// Widget 7 ("wstack"): POWER on top (system or battery W, chosen in settings), a mini battery
// below FILLED by level with the level % drawn inside it. Charging shows as the green fill (the
// power number already conveys draw), so no bolt clutters the tight cell. `watt` = the resolved
// power the ticker passes in (sys or battery per w7_src).
pub fn wstack_icon(l: &Live, colorize: bool, lpm: bool, w_val: f64, signed: bool, bold_bolt: bool, chg_mode: u8, small_unit: bool) -> (Vec<u8>, u32, u32) {
    // Keep the original width: charge-state artwork must not make this menu-bar item grow sideways.
    let (w, h) = (48u32, 39u32);   // extra height only, for the bolt tips beyond the battery outline
    let mut hi = Hi::new(w, h);
    let pct = l.pct.clamp(0.0, 100.0);
    let fill = fill_color(l, colorize, lpm);
    // top: power as real type, ONE DECIMAL for both sources ("3.5W" / "−4.3W") — battery adds
    // the sign (+charge/−discharge). Longer strings auto-shrink to fit the canvas width.
    let wtxt = if signed {
        if w_val.abs() < 0.05 { "0W".into() }
        else { format!("{}{:.1}W", if w_val > 0.0 { "+" } else { "−" }, w_val.abs()) }
    } else { format!("{:.1}W", w_val.max(0.0)) };
    stamp_power_fit(&mut hi, &wtxt, 15.5, 46.0, 24.0, 6.6, INK, true, small_unit);
    // bottom: mini rounded battery, fill by level, with the level % inside (combo-style).
    // Pushed 1px toward the canvas floor so the bolt's tip (and its transparent cutout)
    // clears the power digits above; the clip top guards the digits explicitly.
    let body_sh = (0u8, 0u8, 0u8, 95u8);
    hi.stroke_rrect(1.0, 16.7, 45.0, 37.0, 5.0, 2.0, body_sh);
    hi.fill_rrect(45.5, 23.2, 48.0, 29.2, 1.5, body_sh);
    hi.stroke_rrect(1.0, 16.0, 45.0, 36.3, 5.0, 2.0, INK);
    hi.fill_rrect(45.5, 22.5, 48.0, 28.5, 1.5, INK);
    let fw = (40.0 * pct as f32 / 100.0).max(2.5);
    let fx = 4.0 + fw;   // fill edge x — 저잔량 가시성 모드들이 참조
    hi.fill_rrect(4.0, 19.0, fx, 33.3, 3.0, fill);
    // Charging: a tall, slim Stats-style bolt crosses the battery's top/bottom outline. Its 2px
    // transparent cutout includes the fill AND outline, so the white bolt never melts into either.
    // chg_mode(설정 '충전 표시')가 저잔량에서 채움이 번개에 가리는 문제의 해법을 고른다:
    // 0 기존 · 1 수위선 · 2 온도계 번개 · 3 사이드 스왑 · 4 윤곽선 · 5 미니 배지 · 6 윤곽선+온도계.
    // Full keeps the compact plug. Neither state is allowed to shrink the level digits.
    const WCLIP: (f32, f32, f32, f32) = (0.0, 13.4, 46.0, 39.0);
    const OUTLINE: (u8, u8, u8, u8) = (10, 22, 4, 235);   // 윤곽선 모드의 얇은 어두운 테 (연두 대비)
    let mut dcx = 23.0f32;   // 잔량 % 중심 — 모드가 번개 배치에 맞춰 조정
    if l.charging {
        let cx = digits_bolt_x(8.5, bold_bolt);
        let pts = bolt_pts(cx, 26.2, 13.5, 25.2, true, bold_bolt);
        match chg_mode {
            1 => {   // 수위선: 기존 그대로 + 채움 오른쪽 끝을 밝은 세로선으로 맨 위에 재표시
                charge_overlay_cut_r(&mut hi, l, cx, 26.2, 13.5, 25.2, 2.0, true, bold_bolt, WCLIP);
                hi.fill_rrect(fx - 1.4, 18.2, fx + 1.4, 34.1, 1.4, (0, 0, 0, 115));   // 어두운 테
                hi.fill_rrect(fx - 0.8, 18.8, fx + 0.8, 33.5, 0.8, fill);
                dcx = (3.0 + 15.5 + 43.0) / 2.0;
            }
            2 => {   // 온도계 번개: 컷아웃 유지, 채움 경계 왼쪽의 번개를 채움색으로 재도색
                charge_overlay_cut_r(&mut hi, l, cx, 26.2, 13.5, 25.2, 2.0, true, bold_bolt, WCLIP);
                fill_poly_clip(&mut hi, &pts, fill, (0.0, 13.4, fx, 39.0));
                dcx = (3.0 + 15.5 + 43.0) / 2.0;
            }
            3 => {   // 사이드 스왑: 잔량 <50%면 번개가 빈(오른쪽) 영역으로, 숫자는 왼쪽으로
                if pct < 50.0 {
                    charge_overlay_cut_r(&mut hi, l, 36.5, 26.2, 13.5, 25.2, 2.0, true, bold_bolt, WCLIP);
                    dcx = 14.0;
                } else {
                    charge_overlay_cut_r(&mut hi, l, cx, 26.2, 13.5, 25.2, 2.0, true, bold_bolt, WCLIP);
                    dcx = (3.0 + 15.5 + 43.0) / 2.0;
                }
            }
            4 => {   // 윤곽선 번개: 컷아웃 없음 — 얇은 어두운 테두리만, 채움 손실은 실루엣뿐
                bolt_shape(&mut hi, cx + 0.4, 26.9, 13.5, 25.2, true, bold_bolt, DIGIT_SHADOW);
                fill_poly_dilated(&mut hi, &pts, 0.9, OUTLINE);
                hi.fill_poly(&pts, INK);
                dcx = (3.0 + 15.5 + 43.0) / 2.0;
            }
            5 => {   // 미니 배지: 작은 번개(10.5×16.5)를 우상단 모서리에 — 채움·숫자 불간섭
                // cy 21.0: 배지 상단(12.75)이 전력 숫자 바닥(~12.7) 아래 — 위 텍스트와 겹치지 않게
                charge_overlay_cut_r(&mut hi, l, 40.0, 21.0, 10.5, 16.5, 1.5, true, bold_bolt, (0.0, 13.4, 48.0, 39.0));
                dcx = 21.0;   // 숫자는 중앙 근처(배지와 겹치지 않게 살짝 왼쪽)
            }
            6 => {   // 하이브리드: 윤곽선(컷아웃 없음) + 온도계 채색
                bolt_shape(&mut hi, cx + 0.4, 26.9, 13.5, 25.2, true, bold_bolt, DIGIT_SHADOW);
                fill_poly_dilated(&mut hi, &pts, 0.9, OUTLINE);
                hi.fill_poly(&pts, INK);
                fill_poly_clip(&mut hi, &pts, fill, (0.0, 13.4, fx, 39.0));
                dcx = (3.0 + 15.5 + 43.0) / 2.0;
            }
            _ => {   // 기존
                charge_overlay_cut_r(&mut hi, l, cx, 26.2, 13.5, 25.2, 2.0, true, bold_bolt, WCLIP);
                dcx = (3.0 + 15.5 + 43.0) / 2.0;
            }
        }
    } else if l.full {
        charge_overlay_cut(&mut hi, l, 10.0, 26.2, 9.0, 14.0, bold_bolt, WCLIP);
        dcx = (3.0 + 12.0 + 43.0) / 2.0;
    }
    let digits = format!("{}", pct.round() as u32);
    stamp_digits_cut(&mut hi, &digits, 16.2, dcx, 26.3, 1.0, WCLIP);   // 1px rim in the fill
    stamp_digits(&mut hi, &digits, 16.2, dcx, 26.3, INK, true);        // level % inside the battery
    hi.down()
}

// ---- menu-bar battery GLYPH (like Stats): a battery outline filling proportional to charge,
// teal + bolt while charging, plug while plugged-and-holding. `xl` shrinks the vertical margin so
// the body fills more of the canvas — since macOS scales the tray image to the menu-bar height,
// that renders the glyph visibly larger. Returns raw RGBA + dims.
pub fn battery_icon(l: &Live, colorize: bool, xl: bool, lpm: bool, bold_bolt: bool) -> (Vec<u8>, u32, u32) {
    let (w, h) = (80u32, 40u32);
    let mut hi = Hi::new(w, h);
    let pct = l.pct.clamp(0.0, 100.0);
    let fill = fill_color(l, colorize, lpm);
    // rounded body + nub (shadowed). XL uses a smaller vertical margin so the body is taller.
    let m = if xl { 2.0f32 } else { 6.0 };
    hi.stroke_rrect(2.0, m + 0.8, 66.0, 40.0 - m + 0.8, 6.0, 2.0, SHADOW);
    hi.fill_rrect(66.5, 16.8, 70.5, 24.8, 2.0, SHADOW);
    hi.stroke_rrect(2.0, m, 66.0, 40.0 - m, 6.0, 2.0, INK);
    hi.fill_rrect(66.5, 16.0, 70.5, 24.0, 2.0, INK);
    // fill with an air gap to the outline (macOS's own battery-icon grammar)
    let fw = (56.0 * pct as f32 / 100.0).max(3.0);
    hi.fill_rrect(6.0, m + 4.0, 6.0 + fw, 36.0 - m, 3.0, fill);
    charge_overlay_cut(&mut hi, l, 34.0, 20.0, 17.0, 27.0, bold_bolt, (4.0, m + 2.0, 64.0, 38.0 - m));   // icon: 몸통 중앙의 큼지막한 번개
    hi.down()
}

// ---- settings-panel preview bridge ----------------------------------------------------------
// Dumps every widget style (× colorized/mono × normal/XL) for the current battery state plus
// three fixed demo states (충전/부족/저전력) as raw-RGBA-base64 JSON. The popover's settings panel
// renders these directly, so the preview IS the tray renderer's output — zero drift by
// construction. Written only when the visible inputs change (~every 1% of battery), read via
// the node server's /api/tray-preview.
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = ((c[0] as u32) << 16) | ((*c.get(1).unwrap_or(&0) as u32) << 8) | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}
fn render_style(style: &str, l: &Live, colorize: bool, lpm: bool, sys_w: f64, bold_bolt: bool, chg_mode: u8, small_unit: bool) -> (Vec<u8>, u32, u32) {
    match style {
        "icon_xl" => battery_icon(l, colorize, true, lpm, bold_bolt),
        "combo" => combo_icon(l, colorize, lpm, bold_bolt),
        "iconpct" => battery_pct_icon(l, colorize, lpm, bold_bolt),
        "stack" => stack_icon(l, colorize, lpm, true, bold_bolt),
        "stack_plain" => stack_icon(l, colorize, lpm, false, bold_bolt),  // 민무늬 digits variant
        "wstack" => wstack_icon(l, colorize, lpm, sys_w, false, bold_bolt, chg_mode, small_unit),            // widget 7 · system power (plain)
        "wstack_bat" => wstack_icon(l, colorize, lpm, signed_watts(l), true, bold_bolt, chg_mode, small_unit), // widget 7 · battery power (signed)
        "bar" => bar_glyph(l, colorize, lpm, bold_bolt),
        _ => battery_icon(l, colorize, false, lpm, bold_bolt),
    }
}
pub fn write_preview(dir: &std::path::Path, cur: &Live, lpm: bool, chg_mode: u8, small_unit: bool) {
    let mk = |pct: f64, charging: bool, min: i64, w: f64| Live {
        ok: true, pct, charging, discharging: !charging, time_min: Some(min), watts: w, ..Default::default()
    };
    // fixed demo states so the panel can preview 충전/부족/저전력 without waiting for them; the
    // popover composes the "cur" state's text from /api/live, so no live numbers are needed here
    let states = [
        ("cur", cur.clone(), lpm, 0.0),
        ("chg", mk(45.0, true, 78, 28.5), false, 31.2),
        ("low", mk(12.0, false, 54, 5.8), false, 6.1),
        ("lpm", mk(33.0, false, 190, 4.6), true, 4.8),
    ];
    let mut glyphs = serde_json::Map::new();
    let mut meta = serde_json::Map::new();
    for (name, l, is_lpm, sys_w) in &states {
        let mut styles = serde_json::Map::new();
        for style in ["icon", "icon_xl", "combo", "iconpct", "stack", "stack_plain", "wstack", "wstack_bat", "bar"] {
            for (suffix, bold_bolt) in [("", false), ("_bold", true)] {
                let (col, w, h) = render_style(style, l, true, *is_lpm, *sys_w, bold_bolt, chg_mode, small_unit);
                let (mono, ..) = render_style(style, l, false, *is_lpm, *sys_w, bold_bolt, chg_mode, small_unit);
                styles.insert(format!("{style}{suffix}"), serde_json::json!({ "w": w, "h": h, "c": b64(&col), "m": b64(&mono) }));
            }
        }
        glyphs.insert((*name).into(), styles.into());
        // demo temp/adapter for the 온도·어댑터 chips' preview text (adapter only while charging;
        // the popover uses live values for "cur" so these fixed ones never show there)
        let (temp_c, adp_w) = match *name {
            "chg" => (serde_json::json!(32.0), serde_json::json!(60.2)),
            "low" => (serde_json::json!(33.5), serde_json::Value::Null),
            _ => (serde_json::json!(30.5), serde_json::Value::Null),
        };
        meta.insert((*name).into(), serde_json::json!({
            "pct": l.pct.round(), "charging": l.charging, "full": l.full, "lpm": is_lpm,
            "min": l.time_min, "sysW": sys_w, "batW": signed_watts(l),   // SIGNED (+charge/−discharge)
            "tempC": temp_c, "adpW": adp_w,
        }));
    }
    let out = serde_json::json!({ "states": meta, "glyphs": glyphs }).to_string();
    // tmp + rename so a concurrent /api/tray-preview read never sees a half-written file
    let tmp = dir.join("tray-preview.json.tmp");
    if std::fs::write(&tmp, out).is_ok() { let _ = std::fs::rename(&tmp, dir.join("tray-preview.json")); }
}

// ---- vertical bar glyph (Stats' "bar_chart"): a thin upright cell filling from the bottom.
pub fn bar_glyph(l: &Live, colorize: bool, lpm: bool, bold_bolt: bool) -> (Vec<u8>, u32, u32) {
    let (w, h) = (28u32, 40u32);
    let mut hi = Hi::new(w, h);
    let pct = l.pct.clamp(0.0, 100.0);
    let fill = fill_color(l, colorize, lpm);
    // upright rounded cell + top terminal, fill rising from the bottom behind an air gap
    hi.stroke_rrect(6.0, 3.3, 22.0, 38.8, 5.0, 2.0, SHADOW);
    hi.fill_rrect(10.0, 0.8, 18.0, 3.3, 1.2, SHADOW);
    hi.stroke_rrect(6.0, 2.5, 22.0, 38.0, 5.0, 2.0, INK);
    hi.fill_rrect(10.0, 0.0, 18.0, 2.5, 1.2, INK);
    let fh = (27.5f32 * pct as f32 / 100.0).max(2.5);
    hi.fill_rrect(10.0, 34.0 - fh, 18.0, 34.0, 2.0, fill);
    charge_overlay_cut(&mut hi, l, 14.0, 20.0, 11.0, 27.0, bold_bolt, (8.0, 4.5, 20.0, 36.0));   // bar: 셀을 세로로 채우는 큰 번개
    hi.down()
}

// The compact tray-title text macOS shows next to the icon, composed from the independent
// title items (잔량/시간/전력/어댑터/온도 chips) joined with a plain space — kdr dropped the
// old " · " separators to save menu-bar width. `sys_w` is the live SMC system draw when
// available, falling back to the battery-rail watts (0 while plugged/holding).
// Rules the settings UI mirrors 1:1 (nothing hidden): % is skipped when the glyph already draws
// it; time is skipped while unknown (no countdown); adapter power only while it reads (AC);
// temperature only when the SMC sensor reads; a text-only widget never goes blank.
pub fn tray_title(l: &Live, c: &Cfg, sys_w: f64, bat_w: f64, adp_w: Option<f64>, temp_c: Option<f64>) -> String {
    if !l.ok {
        return String::new();
    }
    let (pct_on, time_on, wsys_on, wbat_on, adp_on, temp_on) = c.title_items();
    let pct = l.pct.round() as i64;
    let mut parts: Vec<String> = Vec::new();
    if pct_on && !c.digits_in_icon() { parts.push(format!("{pct}%")); }
    if time_on && matches!(l.time_min, Some(m) if m > 0) { parts.push(time_str(l)); }
    if wsys_on { parts.push(format!("{sys_w:.1}W")); }   // system draw (SMC) — always ≥0  (small_unit은 main.rs가 attributed 아래첨자로 처리)
    if wbat_on { parts.push(fmt_signed_w(bat_w)); }      // battery — SIGNED, 혼합(방전 PPBR·충전 수지) from the ticker
    if adp_on { if let Some(a) = adp_w { parts.push(format!("{a:.1}W")); } }   // adapter measured (PDTR) — AC only
    if temp_on { if let Some(t) = temp_c { parts.push(format!("{}°", t.round() as i64)); } }   // battery temp (SMC, °C)
    if c.widget == "text" && parts.is_empty() { parts.push(format!("{pct}%")); }   // no glyph to fall back on
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(pct: f64, min: Option<i64>, watts: f64) -> Live {
        Live { ok: true, pct, watts, discharging: watts > 0.0, time_min: min, ..Default::default() }
    }

    // old tray.json (no text_* keys) must keep its legacy `info` meaning through title_items
    #[test]
    fn legacy_info_maps_to_chips() {
        let mut c = Cfg::default();
        for (info, want) in [
            (0u8, (false, false, false, false, false, false)),
            (1, (true, false, false, false, false, false)),
            (2, (false, true, false, false, false, false)),
            (3, (false, false, true, false, false, false)),   // sysW
            (4, (true, false, true, false, false, false)),    // %+sysW
            (5, (true, true, false, false, false, false)),
            (6, (false, false, false, true, false, false)),   // batW (independent from sys now)
            (7, (true, false, false, true, false, false)),    // %+batW
            (99, (true, false, true, false, false, false)),   // out of range → default (4)
        ] {
            c.info = info;
            assert_eq!(c.title_items(), want, "info={info}");
        }
        // explicit chips win over the legacy enum
        c.info = 0;
        c.text_time = Some(true);
        assert_eq!(c.title_items(), (false, true, false, false, false, false));
        // system AND battery power can both be on (the new independent chips); battery is SIGNED
        let both = Cfg { text_w_sys: Some(true), text_w_bat: Some(true), ..Cfg::default() };
        assert_eq!(both.title_items(), (false, false, true, true, false, false));
        let dis = Live { ok: true, watts: 3.1, discharging: true, ..Default::default() };
        assert_eq!(tray_title(&dis, &both, 7.4, signed_watts(&dis), None, None), "7.4W −3.1W");   // discharging → negative
        let chg = Live { ok: true, watts: 3.1, charging: true, ..Default::default() };
        assert_eq!(tray_title(&chg, &both, 7.4, signed_watts(&chg), None, None), "7.4W +3.1W");   // charging → positive
    }

    #[test]
    fn title_composition_rules() {
        let l = live(67.4, Some(312), 7.44);
        let mut c = Cfg { text_pct: Some(true), text_time: Some(true), text_w: Some(true), ..Cfg::default() };
        assert_eq!(tray_title(&l, &c, 9.96, signed_watts(&l), None, None), "67% 5:12 10.0W");
        c.w_src = Some("bat".into());
        assert_eq!(tray_title(&l, &c, 9.96, signed_watts(&l), None, None), "67% 5:12 −7.4W");   // battery discharging → negative
        c.widget = "combo".into();                                   // % drawn in the glyph → skipped in text
        assert_eq!(tray_title(&l, &c, 9.96, signed_watts(&l), None, None), "5:12 −7.4W");
        let idle = live(67.4, None, 0.0);                            // unknown countdown → time part skipped
        assert_eq!(tray_title(&idle, &c, 9.96, signed_watts(&idle), None, None), "0.0W");             // no flow → unsigned zero
        // 온도·어댑터 chips: appended when the value reads, silently skipped when it doesn't
        c.text_temp = Some(true); c.text_adp = Some(true);
        assert_eq!(tray_title(&l, &c, 9.96, signed_watts(&l), Some(60.24), Some(31.6)), "5:12 −7.4W 60.2W 32°");
        assert_eq!(tray_title(&l, &c, 9.96, signed_watts(&l), None, None), "5:12 −7.4W");   // no AC/no sensor → skipped
        let mut t = Cfg { text_pct: Some(false), text_time: Some(false), text_w: Some(false), ..Cfg::default() };
        t.widget = "text".into();                                    // text-only never goes blank
        assert_eq!(tray_title(&l, &t, 9.96, signed_watts(&l), None, None), "67%");
        t.widget = "icon".into();
        assert_eq!(tray_title(&l, &t, 9.96, signed_watts(&l), None, None), "");                    // icon-only: no title at all
    }

    // the digits should be REAL type — a system font must parse on any macOS (else the 5×7
    // fallback kicks in and the tray silently degrades to pixel digits)
    #[test]
    fn system_font_loads() {
        assert!(sys_font().is_some(), "no system font parsed — digits will fall back to the pixel font");
    }

    // every style must render at EVERY level 0..100 — the in_rr clamp panic only fired when the
    // fill was thin enough that the corner radius met the half-extent (≤20%, float-order dependent)
    #[test]
    fn glyphs_render_all_levels() {
        for pct in 0..=100 {
            for (chg, full) in [(false, false), (true, false), (false, true)] {   // 방전·충전·완충(플러그 컷아웃)
                let l = Live { ok: true, pct: pct as f64, charging: chg, full, discharging: !chg && !full, watts: 4.3, ..Default::default() };
                for style in ["icon", "icon_xl", "combo", "iconpct", "stack", "stack_plain", "wstack", "wstack_bat", "bar"] {
                    for m in 0u8..=6 {
                        let _ = render_style(style, &l, true, false, 6.2, false, m, false);
                        let _ = render_style(style, &l, true, false, 6.2, true, m, true);
                    }
                }
            }
        }
    }

    #[test]
    fn pmset_pct_parse() {
        let out = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=5505123)\t67%; discharging; 5:12 remaining present: true\n";
        assert_eq!(parse_pmset_pct(out), Some(67.0));
        assert_eq!(parse_pmset_pct("no percent here"), None);
        assert_eq!(parse_pmset_pct("100%; charged"), Some(100.0));
    }

    // the preview dump must contain every state × style with RGBA buffers of the declared size
    #[test]
    fn preview_dump_shape() {
        let dir = std::env::temp_dir().join("bl-preview-test");
        let _ = std::fs::create_dir_all(&dir);
        write_preview(&dir, &live(67.0, Some(312), 7.4), false, 0, false);
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("tray-preview.json")).unwrap()).unwrap();
        for s in ["cur", "chg", "low", "lpm"] {
            assert!(v["states"][s]["pct"].is_number(), "state {s}");
            for g in ["icon", "icon_xl", "combo", "iconpct", "stack", "stack_plain", "wstack", "wstack_bat", "bar"] {
                for suffix in ["", "_bold"] {
                    let key = format!("{g}{suffix}");
                    let e = &v["glyphs"][s][&key];
                    let n = (e["w"].as_u64().unwrap() * e["h"].as_u64().unwrap() * 4) as usize;
                    for k in ["c", "m"] {
                        assert_eq!(e[k].as_str().unwrap().len(), n.div_ceil(3) * 4, "{s}/{key}/{k}");
                    }
                }
            }
        }
    }
}
