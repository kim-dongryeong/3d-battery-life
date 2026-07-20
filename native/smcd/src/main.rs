// joule-smcd — launchd(KeepAlive) 상주 데몬. 트레이 앱이 꺼져 있어도 기록 파이프라인을
// 완전하게 유지한다:
//   1) 0.5초마다 SMC(PSTR/PDTR/PPBR/VD0R/ID0R/TB*T)를 표본해 60초 롤링 윈도우로 시간가중
//      사다리꼴 1분 평균을 만들고 live-smc.json에 발행 — 트레이 앱의 sample_smc()와 동일 스키마.
//   2) 60초마다 옆의 `joule sample`(one-shot 레코더)을 직접 실행해 분당 기록을 보장 —
//      launchd StartInterval(ProcessType=Background)의 타이머 지연으로 생기던 기록 구멍 방지.
// 트레이 앱이 실행 중이면 둘 다 양보한다(앱의 발행자·상주 레코더가 담당). 앱 존재는 2초마다
// pgrep으로 확인하고, 양보 중에도 SMC 표본은 계속 쌓아 인계 시 60초 윈도우가 이미 따뜻하다.
mod smc;
use smc::Smc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// (a) 데이터 경로 마이그레이션: 옛 폴더가 있고 새 폴더가 없으면 통째로 rename.
//     둘 다 있으면 손대지 않는다(병합 금지 — 중복 위험). 앱/CLI가 먼저 도는 정상 경로에서는
//     이미 이전이 끝나 있을 것 — 여기는 smcd만 먼저 뜨는 극단적 케이스를 위한 최소 안전망.
fn migrate_legacy_data_dir(home: &str) {
    let old = std::path::Path::new(home).join("Library/Application Support/3d-battery-life");
    let new = std::path::Path::new(home).join("Library/Application Support/joule");
    if old.is_dir() && !new.exists() {
        let _ = std::fs::rename(&old, &new);
    }
}

fn data_dir() -> std::path::PathBuf {
    if let Ok(d) = std::env::var("JOULE_DATA") { return d.into(); }
    if let Ok(d) = std::env::var("BATTERY_DATA") { return d.into(); }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    migrate_legacy_data_dir(&home);
    std::path::Path::new(&home).join("Library/Application Support/joule")
}

fn tray_app_running() -> bool {
    std::process::Command::new("/usr/bin/pgrep")
        .args(["-x", "joule-desktop"])
        .stdout(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

// 분당 레코더: 이 바이너리 옆의 joule(컴파일 CLI)를 one-shot으로 실행.
// appendSample의 락+55초 recency guard가 launchd 샘플러와의 이중 기록을 막는다.
fn spawn_sampler() {
    let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) else { return };
    let bin = dir.join("joule");
    if !bin.exists() { return; }
    let _ = std::process::Command::new(bin)
        .arg("sample")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();   // fire-and-forget — 결과는 sampler 로그/파일 락이 처리
}

fn main() {
    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let smc = Smc::open();
    if smc.is_none() { eprintln!("smcd: SMC open failed — publishing disabled (recorder spawn still active)"); }

    let t0 = Instant::now();
    let mut seq: u64 = 0;
    let mut pwin: Vec<(u64, f64, f64, f64)> = Vec::new();   // (t, sysW, adpW, batW) — 60s rolling
    let mut app_up = tray_app_running();
    let mut tick: u64 = 0;

    loop {
        std::thread::sleep(Duration::from_millis(500));
        tick = tick.wrapping_add(1);
        if tick % 4 == 0 { app_up = tray_app_running(); }   // 2초마다 앱 존재 확인

        if let Some(ref s) = smc {
            let sys_w = s.system_watts();
            let adp_w = s.adapter_watts();
            let bat_w = s.battery_watts();
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            if let (Some(sw), Some(aw), Some(bw)) = (sys_w, adp_w, bat_w) { pwin.push((now, sw, aw, bw)); }
            pwin.retain(|(t, ..)| now.saturating_sub(*t) <= 60);

            // 앱이 없을 때만 발행 (있으면 앱의 sample_smc가 발행자 — 이중 발행 시 seq가 튀어
            // 측정 세션 dedup을 흔든다). 표본 수집은 계속 → 인계 시 평균이 끊기지 않음.
            if !app_up {
                // 시간가중 사다리꼴 1분 평균 (src-tauri/src/main.rs sample_smc와 동일)
                let (mut asys, mut aadp, mut abat, mut span) = (0.0, 0.0, 0.0, 0.0);
                for w in pwin.windows(2) {
                    let dt = w[1].0.saturating_sub(w[0].0) as f64;
                    if dt <= 0.0 { continue; }
                    asys += (w[0].1 + w[1].1) / 2.0 * dt;
                    aadp += (w[0].2 + w[1].2) / 2.0 * dt;
                    abat += (w[0].3 + w[1].3) / 2.0 * dt;
                    span += dt;
                }
                let last = pwin.last().copied();
                let av_sys = if span > 0.0 { Some(asys / span) } else { last.map(|x| x.1) };
                let av_adp = if span > 0.0 { Some(aadp / span) } else { last.map(|x| x.2) };
                let av_bat = if span > 0.0 { Some(abat / span) } else { last.map(|x| x.3) };
                let f = |o: Option<f64>| o.map(|v| format!("{:.3}", v)).unwrap_or_else(|| "null".into());
                seq += 1;
                let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                let mono_ms = t0.elapsed().as_millis() as u64;
                let j = format!("{{\"tempC\":{},\"systemW\":{},\"adapterW\":{},\"batteryW\":{},\"systemWAvg\":{},\"adapterWAvg\":{},\"batteryWAvg\":{},\"dcInV\":{},\"dcInA\":{},\"at\":{},\"seq\":{},\"sampleAtMs\":{},\"monoMs\":{}}}",
                    f(s.battery_temp_c()), f(sys_w), f(adp_w), f(bat_w), f(av_sys), f(av_adp), f(av_bat), f(s.dc_in_volts()), f(s.dc_in_amps()), now, seq, now_ms, mono_ms);
                // atomic publish (tmp+rename): 소비자가 찢어진 JSON을 보지 않게
                let (tmp, fin) = (dir.join("live-smc.json.tmp"), dir.join("live-smc.json"));
                if std::fs::write(&tmp, j).is_ok() { let _ = std::fs::rename(&tmp, &fin); }
            }
        }

        // 60초마다 분당 레코드 — 앱이 없을 때만 (있으면 sidecar 서버의 상주 레코더가 담당)
        if tick % 120 == 0 && !app_up { spawn_sampler(); }
    }
}
