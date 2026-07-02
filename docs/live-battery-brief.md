# Brief — Live menu-bar battery module (match & beat Stats' Battery module)

Repo: `/Users/kimdongryeong/dev/3d-battery-life` (macOS battery tracker; Tauri v2 tray app in `src-tauri/`,
web viewer in `web/`, node sidecar `battery-life serve`, launchd 60s sampler → shared `samples.jsonl`).

## GOAL
Make our Tauri tray app a FULL live battery monitor (parity with exelban/Stats' Battery module) **plus**
our unique longitudinal aging/load report. Three phases, all to ship:
- **P1** Live tray text (e.g. `87% · 5.2W`, low-power ⚡/🔋 glyph), updating ~every 2s.
- **P2** Left-click popover window: live Stats-parity rows (level, status, W, A, V, °C, health%, cycles,
  max/design mAh, adapter watts, "on hold"/optimized-charging, Low Power Mode) + top battery processes.
  Multiple UI versions, selectable.
- **P3** While the app runs, sample every 1–2s and write a **60s average** (W, °C) to `samples.jsonl`
  (more accurate than the launchd snapshot), with dedup so launchd doesn't double-write.

## Verified facts (measured this session)
- macOS updates the `AppleSmartBattery` ioreg node only ~every 60s (UpdateTime advances 60s); `Amperage`
  is already controller-smoothed → 1s ioreg polling yields identical values. So per-minute averaging only
  helps for **SMC-sourced** live values (PPBR watts, TB1T/TB2T temp), not ioreg.
- Native IOKit read ≈ **0.4 ms**; `ioreg` subprocess ≈ 19 ms — native is ~48× cheaper, right for a 2s tick.
- Stats' battery reader is **event-driven** (`IOPSNotificationCreateRunLoopSource`), no timer, `history:false`
  (no time-series — that's our moat). Stats reads IOPS + AppleSmartBattery registry + SMC (PPBR/TB1T) + `top -o power`.

## Proposed design (critique this)
- Rust: `starship-battery` crate for the live reader (%, energy_rate=W, voltage, temperature, state,
  cycle_count, time_to_empty/full, energy_full/energy_full_design→health) — no hand FFI. A 2s ticker thread
  updates the tray via `app.tray_by_id("tray").set_title(...)` and stores a snapshot in `Mutex<Live>`.
- `#[tauri::command] live_battery()` returns the snapshot; `top_battery_procs()` shells `top -o power -l 2`.
- Popover: pre-created hidden undecorated webview `popover` at `/popover.html`; `show_menu_on_left_click(false)`
  + `on_tray_icon_event` Left-click toggle; position under icon (tauri-plugin-positioner `TrayBottomCenter`
  or DIY from event rect); hide on `Focused(false)`.
- Low Power Mode: `NSProcessInfo::isLowPowerModeEnabled` (objc2-foundation) + change notification.
- P3 recorder: Rust accumulates SMC/ioreg every ~2s, flushes 60s avg to `samples.jsonl`; node sampler gets a
  **recency guard** (skip if last sample <55s old) so app-writes and launchd-writes don't duplicate.

## OPEN QUESTIONS (propose, with tradeoffs — don't assume)
1. **Live reader**: `starship-battery` vs raw `objc2-io-kit`. Is starship-battery's health (energy_full/design)
   correct on Apple Silicon vs our AppleRawMaxCapacity/DesignCapacity? Any missing Stats field (Amperage sign,
   "optimized charging / on hold", adapter watts)? Worth a thin objc2-io-kit supplement for those specific keys?
2. **SMC for accurate W/°C**: needed for P3 accuracy, but hand-writing SMC FFI is risky. Is there a maintained
   crate, or should P3 average the ioreg/starship values (accepting they're ~60s-quantized)?
3. **Tray from background thread**: correct Tauri v2 way to mutate the tray title every 2s (main-thread
   marshaling? `AppHandle` Send/Sync?). Pitfalls.
4. **Recording coordination**: recency-guard dedup vs the app **booting out the launchd agent while running**
   and re-installing on quit. Which is safer against gaps/dupes and crash-safety?
5. **Popover**: positioner plugin vs DIY rect. Focus-loss hide reliability on macOS. CSP/webview loading a
   local `/popover.html` from the node server vs a bundled file.

Reply with: which OPEN QUESTIONS you'd decide differently and why, plus any correctness/robustness pitfall in
the proposed design (threading, panics, notarization/entitlements for `top`, energy of a 2s tick, etc).
