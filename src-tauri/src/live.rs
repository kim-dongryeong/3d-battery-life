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
            state: if charging { "충전".into() } else if full { "완충".into() } else if discharging { "방전".into() } else { "AC".into() },
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
}

impl Cfg {
    // Effective side-text items as (pct, time, w_sys, w_bat) — system & battery power are now
    // INDEPENDENT (both can show). Precedence: explicit text_w_sys/bat > the old single text_w+w_src
    // > the original 표시 텍스트 enum (0 none·1 %·2 time·3 sysW·4 %+sysW·5 %+time·6 batW·7 %+batW).
    pub fn title_items(&self) -> (bool, bool, bool, bool) {
        // no chip keys at all → file predates the chips UI → map the legacy enum
        if self.text_pct.is_none() && self.text_time.is_none() && self.text_w.is_none()
            && self.text_w_sys.is_none() && self.text_w_bat.is_none() {
            let i = if self.info > 7 { 4 } else { self.info };
            return (matches!(i, 1 | 4 | 5 | 7), matches!(i, 2 | 5), matches!(i, 3 | 4), matches!(i, 6 | 7));
        }
        let (w_sys, w_bat) = if self.text_w_sys.is_some() || self.text_w_bat.is_some() {
            (self.text_w_sys.unwrap_or(false), self.text_w_bat.unwrap_or(false))
        } else {   // migrate the old single power chip
            let tw = self.text_w.unwrap_or(false);
            let bat = self.w_src.as_deref() == Some("bat");
            (tw && !bat, tw && bat)
        };
        (self.text_pct.unwrap_or(false), self.text_time.unwrap_or(false), w_sys, w_bat)
    }
    // styles that draw the % digits inside the glyph — the % title item is redundant there
    // (the settings UI shows this as a locked "아이콘에 포함" chip, so the rule is visible)
    pub fn digits_in_icon(&self) -> bool { matches!(self.widget.as_str(), "combo" | "iconpct" | "stack" | "wstack") }
    // widget "wstack": which power feeds the top number
    pub fn w7_battery(&self) -> bool { self.w7_src.as_deref() == Some("bat") }
}
fn d_info() -> u8 { 4 }
fn d_true() -> bool { true }
fn d_low() -> u8 { 20 }
fn d_high() -> u8 { 80 }
fn d_widget() -> String { "icon".into() }
impl Default for Cfg {
    fn default() -> Self {
        Cfg { info: 4, colorize: true, low_pct: 20, high_pct: 80, widget: "icon".into(), glyph_xl: false, shortcut: true,
              text_pct: None, text_time: None, text_w: None, w_src: None,   // None → title_items falls back to `info`
              text_w_sys: None, text_w_bat: None, w7_src: None, digit_deco: true }
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
    c
}
fn time_str(l: &Live) -> String {
    match l.time_min {
        Some(m) if m > 0 => format!("{}:{:02}", m / 60, m % 60),
        _ => "–".into(),
    }
}

// macOS's DISPLAYED battery % (`pmset -g batt` → "… 67%; discharging …"). starship's energy-ratio
// % can sit 1–2% off the number macOS itself shows — the tray digits must match the system's own
// figure (and the popover's ioreg %), so when this parses the ticker overrides Live.pct with it.
pub fn displayed_pct() -> Option<f64> {
    let out = std::process::Command::new("pmset").args(["-g", "batt"]).output().ok()?;
    parse_pmset_pct(&String::from_utf8_lossy(&out.stdout))
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
    let dx = px - px.clamp(x0 + r, x1 - r);
    let dy = py - py.clamp(y0 + r, y1 - r);
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
fn stamp_text(hi: &mut Hi, text: &str, size: f32, cx: f32, cy: f32, c: (u8, u8, u8, u8)) -> bool {
    let Some(f) = sys_font() else { return false };
    let px = size * hi.s;
    let gs: Vec<(fontdue::Metrics, Vec<u8>)> = text.chars().map(|ch| f.rasterize(ch, px)).collect();
    let total: f32 = gs.iter().map(|(m, _)| m.advance_width).sum();
    let cap = gs.iter().map(|(m, _)| m.height).max().unwrap_or(0) as f32;
    let left = cx * hi.s - total / 2.0;
    let top = cy * hi.s - cap / 2.0;
    let mut pen = left;
    for (m, bm) in &gs {
        let gx = (pen + m.xmin as f32).round() as i32;
        let gy = (top + cap - m.height as f32 - m.ymin as f32).round() as i32;
        for row in 0..m.height {
            for col in 0..m.width {
                hi.blend(gx + col as i32, gy + row as i32, c, bm[row * m.width + col] as f32 / 255.0);
            }
        }
        pen += m.advance_width;
    }
    true
}
// digits with the tray's soft shadow; pixel-font fallback keeps the tray alive without a font
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
fn bolt(hi: &mut Hi, cx: f32, cy: f32, w: f32, h: f32, c: (u8, u8, u8, u8)) {
    const P: [(f32, f32); 6] = [(0.62, 0.0), (0.08, 0.60), (0.45, 0.60), (0.36, 1.0), (0.92, 0.38), (0.50, 0.38)];
    let pts: Vec<(f32, f32)> = P.iter().map(|&(u, v)| (cx - w / 2.0 + u * w, cy - h / 2.0 + v * h)).collect();
    hi.fill_poly(&pts, c);
}
fn plug(hi: &mut Hi, cx: f32, top: f32, s: f32, c: (u8, u8, u8, u8)) {
    let pw = s * 0.09;
    for dx in [-s * 0.17, s * 0.17] { hi.fill_rrect(cx + dx - pw, top, cx + dx + pw, top + s * 0.30, pw, c); }
    hi.fill_rrect(cx - s * 0.32, top + s * 0.22, cx + s * 0.32, top + s * 0.62, s * 0.10, c);
    hi.fill_rrect(cx - s * 0.05, top + s * 0.60, cx + s * 0.05, top + s, s * 0.05, c);
}
fn charge_overlay(hi: &mut Hi, l: &Live, cx: f32, cy: f32, w: f32, h: f32) {
    if l.charging {
        bolt(hi, cx + 0.4, cy + 0.7, w, h, DIGIT_SHADOW);
        bolt(hi, cx, cy, w, h, INK);
    } else if l.full {
        plug(hi, cx + 0.4, cy - h / 2.0 + 0.7, h, DIGIT_SHADOW);
        plug(hi, cx, cy - h / 2.0, h, INK);
    }
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
pub fn menu_icon(l: &Live, colorize: bool, widget: &str, xl: bool, lpm: bool, deco: bool, w_val: f64) -> Option<(Vec<u8>, u32, u32)> {
    match widget {
        "text" => None,
        "bar" => Some(bar_glyph(l, colorize, lpm)),
        "iconpct" => Some(battery_pct_icon(l, colorize, lpm)),
        "combo" => Some(combo_icon(l, colorize, lpm)),
        "stack" => Some(stack_icon(l, colorize, lpm, deco)),
        "wstack" => Some(wstack_icon(l, colorize, lpm, w_val)),   // widget 7: power on top, level in battery
        _ => Some(battery_icon(l, colorize, xl, lpm)),
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
pub fn battery_pct_icon(l: &Live, colorize: bool, lpm: bool) -> (Vec<u8>, u32, u32) {
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
    if l.charging { bolt(&mut hi, 13.0, 20.0, 12.0, 27.0, ink); }
    else if l.full { plug(&mut hi, 13.0, 9.0, 20.0, ink); }
    let digits = format!("{}", l.pct.clamp(0.0, 100.0).round() as u32);
    stamp_digits(&mut hi, &digits, 21.0, (6.0 + ind + 62.0) / 2.0, 20.0, ink, true);
    hi.down()
}

// Compact single cell: battery FILLED proportional to % (color by level) + % number overlaid
// (white with a dark shadow so it reads over both the fill and the empty part) + charge status
// bolt/plug. Max info in one battery-width slot — no separate title text needed.
pub fn combo_icon(l: &Live, colorize: bool, lpm: bool) -> (Vec<u8>, u32, u32) {
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
    // charge status at the left + the % as real type over the fill
    let ind = if l.charging || l.full { 12.0f32 } else { 0.0 };
    charge_overlay(&mut hi, l, 12.0, 20.0, 12.0, 26.0);   // combo: 큼지막한 번개
    let digits = format!("{}", pct.round() as u32);
    stamp_digits(&mut hi, &digits, 21.0, (6.0 + ind + 62.0) / 2.0, 20.0, INK, true);
    hi.down()
}

// % number stacked ABOVE a mini horizontal battery — narrowest horizontal footprint for a tight
// menu bar. The number is the hero: sized to leave only ~1px headroom, with the battery body
// taking the former bottom slack. `deco`=false → plain white digits: no tint, no shadow.
pub fn stack_icon(l: &Live, colorize: bool, lpm: bool, deco: bool) -> (Vec<u8>, u32, u32) {
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
    charge_overlay(&mut hi, l, 21.0, 26.0, 13.0, 18.0);   // stack: 미니 배터리를 꽉 채우는 번개
    hi.down()
}

// Widget 7 ("wstack"): POWER on top (system or battery W, chosen in settings), a mini battery
// below FILLED by level with the level % drawn inside it. Charging shows as the green fill (the
// power number already conveys draw), so no bolt clutters the tight cell. `watt` = the resolved
// power the ticker passes in (sys or battery per w7_src).
pub fn wstack_icon(l: &Live, colorize: bool, lpm: bool, w_val: f64) -> (Vec<u8>, u32, u32) {
    let (w, h) = (48u32, 36u32);   // a hair wider than stack so the level digits fit inside the battery
    let mut hi = Hi::new(w, h);
    let pct = l.pct.clamp(0.0, 100.0);
    let fill = fill_color(l, colorize, lpm);
    // top: power as real type ("31W"), hugging the ceiling
    let wtxt = format!("{}W", w_val.max(0.0).round() as u32);
    stamp_digits(&mut hi, &wtxt, 13.0, 24.0, 7.0, INK, true);
    // bottom: mini rounded battery, fill by level, with the level % inside (combo-style)
    let body_sh = (0u8, 0u8, 0u8, 95u8);
    hi.stroke_rrect(1.0, 15.7, 45.0, 36.0, 5.0, 2.0, body_sh);
    hi.fill_rrect(45.5, 22.2, 48.0, 28.2, 1.5, body_sh);
    hi.stroke_rrect(1.0, 15.0, 45.0, 35.3, 5.0, 2.0, INK);
    hi.fill_rrect(45.5, 21.5, 48.0, 27.5, 1.5, INK);
    let fw = (40.0 * pct as f32 / 100.0).max(2.5);
    hi.fill_rrect(4.0, 18.0, 4.0 + fw, 32.3, 3.0, fill);
    let digits = format!("{}", pct.round() as u32);
    stamp_digits(&mut hi, &digits, 14.5, 23.0, 25.2, INK, true);   // level % inside the battery
    hi.down()
}

// ---- menu-bar battery GLYPH (like Stats): a battery outline filling proportional to charge,
// teal + bolt while charging, plug while plugged-and-holding. `xl` shrinks the vertical margin so
// the body fills more of the canvas — since macOS scales the tray image to the menu-bar height,
// that renders the glyph visibly larger. Returns raw RGBA + dims.
pub fn battery_icon(l: &Live, colorize: bool, xl: bool, lpm: bool) -> (Vec<u8>, u32, u32) {
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
    charge_overlay(&mut hi, l, 34.0, 20.0, 17.0, 27.0);   // icon: 몸통 중앙의 큼지막한 번개
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
fn render_style(style: &str, l: &Live, colorize: bool, lpm: bool, sys_w: f64) -> (Vec<u8>, u32, u32) {
    match style {
        "icon_xl" => battery_icon(l, colorize, true, lpm),
        "combo" => combo_icon(l, colorize, lpm),
        "iconpct" => battery_pct_icon(l, colorize, lpm),
        "stack" => stack_icon(l, colorize, lpm, true),
        "stack_plain" => stack_icon(l, colorize, lpm, false),  // 민무늬 digits variant
        "wstack" => wstack_icon(l, colorize, lpm, sys_w),          // widget 7 · system power
        "wstack_bat" => wstack_icon(l, colorize, lpm, l.watts),    // widget 7 · battery power
        "bar" => bar_glyph(l, colorize, lpm),
        _ => battery_icon(l, colorize, false, lpm),
    }
}
pub fn write_preview(dir: &std::path::Path, cur: &Live, lpm: bool) {
    let mk = |pct: f64, charging: bool, min: i64, w: f64| Live {
        ok: true, pct, charging, time_min: Some(min), watts: w, ..Default::default()
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
            let (col, w, h) = render_style(style, l, true, *is_lpm, *sys_w);
            let (mono, ..) = render_style(style, l, false, *is_lpm, *sys_w);
            styles.insert(style.into(), serde_json::json!({ "w": w, "h": h, "c": b64(&col), "m": b64(&mono) }));
        }
        glyphs.insert((*name).into(), styles.into());
        meta.insert((*name).into(), serde_json::json!({
            "pct": l.pct.round(), "charging": l.charging, "full": l.full, "lpm": is_lpm,
            "min": l.time_min, "sysW": sys_w, "batW": l.watts,
        }));
    }
    let out = serde_json::json!({ "states": meta, "glyphs": glyphs }).to_string();
    // tmp + rename so a concurrent /api/tray-preview read never sees a half-written file
    let tmp = dir.join("tray-preview.json.tmp");
    if std::fs::write(&tmp, out).is_ok() { let _ = std::fs::rename(&tmp, dir.join("tray-preview.json")); }
}

// ---- vertical bar glyph (Stats' "bar_chart"): a thin upright cell filling from the bottom.
pub fn bar_glyph(l: &Live, colorize: bool, lpm: bool) -> (Vec<u8>, u32, u32) {
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
    charge_overlay(&mut hi, l, 14.0, 20.0, 11.0, 27.0);   // bar: 셀을 세로로 채우는 큰 번개
    hi.down()
}

// The compact tray-title text macOS shows next to the icon, composed from the independent
// title items (잔량/시간/전력 chips) joined with " · ". `sys_w` is the live SMC system draw when
// available, falling back to the battery-rail watts (0 while plugged/holding).
// Rules the settings UI mirrors 1:1 (nothing hidden): % is skipped when the glyph already draws
// it; time is skipped while unknown (no countdown); a text-only widget never goes blank.
pub fn tray_title(l: &Live, c: &Cfg, sys_w: f64) -> String {
    if !l.ok {
        return String::new();
    }
    let (pct_on, time_on, wsys_on, wbat_on) = c.title_items();
    let pct = l.pct.round() as i64;
    let mut parts: Vec<String> = Vec::new();
    if pct_on && !c.digits_in_icon() { parts.push(format!("{pct}%")); }
    if time_on && matches!(l.time_min, Some(m) if m > 0) { parts.push(time_str(l)); }
    if wsys_on { parts.push(format!("{sys_w:.1}W")); }        // system draw (SMC)
    if wbat_on { parts.push(format!("{:.1}W", l.watts.abs())); }   // battery rail — both may show
    if c.widget == "text" && parts.is_empty() { parts.push(format!("{pct}%")); }   // no glyph to fall back on
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(pct: f64, min: Option<i64>, watts: f64) -> Live {
        Live { ok: true, pct, watts, time_min: min, ..Default::default() }
    }

    // old tray.json (no text_* keys) must keep its legacy `info` meaning through title_items
    #[test]
    fn legacy_info_maps_to_chips() {
        let mut c = Cfg::default();
        for (info, want) in [
            (0u8, (false, false, false, false)),
            (1, (true, false, false, false)),
            (2, (false, true, false, false)),
            (3, (false, false, true, false)),   // sysW
            (4, (true, false, true, false)),    // %+sysW
            (5, (true, true, false, false)),
            (6, (false, false, false, true)),   // batW (independent from sys now)
            (7, (true, false, false, true)),    // %+batW
            (99, (true, false, true, false)),   // out of range → default (4)
        ] {
            c.info = info;
            assert_eq!(c.title_items(), want, "info={info}");
        }
        // explicit chips win over the legacy enum
        c.info = 0;
        c.text_time = Some(true);
        assert_eq!(c.title_items(), (false, true, false, false));
        // system AND battery power can both be on (the new independent chips)
        let both = Cfg { text_w_sys: Some(true), text_w_bat: Some(true), ..Cfg::default() };
        assert_eq!(both.title_items(), (false, false, true, true));
        assert_eq!(tray_title(&Live { ok: true, watts: 3.1, ..Default::default() }, &both, 7.4), "7.4W · 3.1W");
    }

    #[test]
    fn title_composition_rules() {
        let l = live(67.4, Some(312), 7.44);
        let mut c = Cfg { text_pct: Some(true), text_time: Some(true), text_w: Some(true), ..Cfg::default() };
        assert_eq!(tray_title(&l, &c, 9.96), "67% · 5:12 · 10.0W");
        c.w_src = Some("bat".into());
        assert_eq!(tray_title(&l, &c, 9.96), "67% · 5:12 · 7.4W");
        c.widget = "combo".into();                                   // % drawn in the glyph → skipped in text
        assert_eq!(tray_title(&l, &c, 9.96), "5:12 · 7.4W");
        let idle = live(67.4, None, 0.0);                            // unknown countdown → time part skipped
        assert_eq!(tray_title(&idle, &c, 9.96), "0.0W");
        let mut t = Cfg { text_pct: Some(false), text_time: Some(false), text_w: Some(false), ..Cfg::default() };
        t.widget = "text".into();                                    // text-only never goes blank
        assert_eq!(tray_title(&l, &t, 9.96), "67%");
        t.widget = "icon".into();
        assert_eq!(tray_title(&l, &t, 9.96), "");                    // icon-only: no title at all
    }

    // the digits should be REAL type — a system font must parse on any macOS (else the 5×7
    // fallback kicks in and the tray silently degrades to pixel digits)
    #[test]
    fn system_font_loads() {
        assert!(sys_font().is_some(), "no system font parsed — digits will fall back to the pixel font");
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
        write_preview(&dir, &live(67.0, Some(312), 7.4), false);
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("tray-preview.json")).unwrap()).unwrap();
        for s in ["cur", "chg", "low", "lpm"] {
            assert!(v["states"][s]["pct"].is_number(), "state {s}");
            for g in ["icon", "icon_xl", "combo", "iconpct", "stack", "stack_plain", "wstack", "wstack_bat", "bar"] {
                let e = &v["glyphs"][s][g];
                let n = (e["w"].as_u64().unwrap() * e["h"].as_u64().unwrap() * 4) as usize;
                for k in ["c", "m"] {
                    assert_eq!(e[k].as_str().unwrap().len(), n.div_ceil(3) * 4, "{s}/{g}/{k}");
                }
            }
        }
    }
}
