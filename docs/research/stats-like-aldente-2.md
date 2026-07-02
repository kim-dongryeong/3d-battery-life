
# AlDente (AppHouseKitchen) — Exhaustive Competitive Feature Inventory

Legend: **[DISPLAY]** = read-only, safe for us to implement (reads IOKit/SMC/pmset). **[CONTROL]** = writes hardware SMC keys → requires a root-privileged helper → risky/privileged.

IMPORTANT CAVEAT ON SOURCING: AlDente was originally open-source (David Wernhart, `davidwernhart/AlDente-Charge-Limiter`) but is now **proprietary and closed-source** — the current GitHub repo (`AppHouseKitchen/AlDente-Battery_Care_and_Monitoring`) explicitly states "This project is no longer open source… the current version of the software is proprietary and closed-source"; it is now only a release-distribution + issue tracker. So exact current SMC-key values are not published by AHK. The SMC-key specifics below are drawn from (a) AHK's own docs/FAQ, and (b) the identical mechanism as documented in maintained open-source equivalents (`charlie0129/batt`, `actuallymentor/battery`, `zackelia/bclm`, `killerk3emstar/OpenDente`). These tools use the same SMC keys AlDente uses; treat them as authoritative for "how the control works," and AHK docs as authoritative for "what AlDente exposes."

---

## 1. IDENTITY / DISTRIBUTION
- Name: AlDente / AlDente Pro. Vendor: AppHouseKitchen (apphousekitchen.com). Bundle id: `com.apphousekitchen.aldente-pro`. Menu-bar emblem: 🍝 spaghetti icon (you click it to open the popover).
- Category: menu-bar charge-limiting / battery-care app. Positioning: "match & beat" macOS's own native Charge Limit (macOS 14+), by offering finer control (any %, not just 80) plus discharge/heat/calibration/sailing.
- Platforms: Apple Silicon (M1–M4/M5) **and** Intel. macOS support window: macOS 11 Big Sur → macOS 26 Tahoe (per FAQ). Footprint: <20 MB.
- Two SKUs: **Free** and **Pro**. (See §7 pricing.)

---

## 2. ★ THE CRUCIAL TECHNICAL MECHANISM ★ (privilege / helper / SMC)
This is the load-bearing part for your parity decision:

- **YES — it WRITES SMC keys.** AHK's own wording: "The tool writes the desired value to your MacBook's SMC (System Management Controller), which handles the rest." Charge limiting, discharge, heat cutoff, calibration, and MagSafe-LED are all implemented by *writing* SMC keys. [CONTROL]
- **YES — it REQUIRES a privileged (root) helper.** AHK FAQ/overview: "On the first start, the application is going to ask you to allow installing a helper tool. This is necessary, since writing SMC Keys requires root privileges." The main app is unprivileged; a small **helper/daemon runs as root** and is the only component that touches SMC. The app talks to it over **XPC**.
- **Helper install mechanism:** historically **`SMJobBless`** (Service Management framework — helper embedded in the app bundle, blessed into `/Library/PrivilegedHelperTools/`, authorized via an admin-password Authorization Services prompt; app `Info.plist` carries `SMPrivilegedExecutables` pinning the helper's code-signing requirement). Modern versions moved to **`SMAppService`** (the macOS 13+ replacement for SMJobBless) shipping the privileged component as a registered LaunchDaemon. Either way: **you get an admin-password prompt on first run / after some macOS updates**, and there is a "**Reinstall Helper**" button because the helper frequently breaks after OS updates (many open issues about "stuck at install helper" infinite spinner). This is the single biggest UX friction of the control path.
- **NO kernel extension (kext) and NO DriverKit.** Charging control is pure user-space SMC writes via **IOKit `AppleSMC`** (`IOConnectCallStructMethod` to the `AppleSMC` IOService). No SIP disablement required. No kext load, no `systemextensionsctl`. (Open-source equivalents confirm: "No kernel extension is mentioned as being required.")
- **Entitlements / signing:** app + helper are **Apple-notarized, Developer-ID signed**. The helper is not sandboxed (a sandboxed process cannot write SMC). Code-signing pinning between app↔helper is what SMJobBless/SMAppService enforce.
- **macOS 15+ entitlement-enforcement wrinkle (competitively important):** Apple began enforcing an entitlement on the classic Intel `BCLM` write path — the `bclm` project warns "BCLM does not work on macOS >= 15.0 due to new entitlement enforcement." AlDente works around this on modern Macs by using the **CH0B/CH0C (or CHTE) charge-inhibit keys instead of BCLM**. Also note the mid-2025 breakage: a "**silent SMC firmware update**" on Apple Silicon (~macOS 15.5 / Tahoe betas) broke charge limiting until AHK re-implemented it. Lesson for us: the CONTROL path is a **maintenance treadmill** — Apple changes SMC firmware/keys and you must chase it.
- **Reads that DON'T need the helper:** all battery telemetry (%, capacity, cycles, temperature, wattage, adapter info) is read from **IOKit (`IOPMPowerSource` / `AppleSmartBattery`)** and SMC *reads*, which are unprivileged. i.e. every **[DISPLAY]** feature below is implementable **without** a helper, without a password prompt, without risk.

---

## 3. ★ EXACT SMC KEYS (the control primitives) ★
Values below are hex bytes written via the `smc` primitive; verified from the maintained equivalents that mirror AlDente's mechanism. **All of these are [CONTROL].**

- **Charge inhibit — Apple Silicon (current path):**
  - `CH0B` : `00` = allow charging, `02` = inhibit charging.
  - `CH0C` : `00` = allow, `02` = inhibit. (AlDente writes **both** CH0B and CH0C together; they must agree.)
  - `CHTE` (newer firmware / macOS 26 "Tahoe"-era): `00000000` = allow, `01000000` = inhibit. (4-byte key; replaces/augments CH0B/CH0C on latest firmware — this is the key that "silently changed" and broke tools mid-2025.)
- **Apple's native 80% hardware limit key — Apple Silicon:**
  - `CHWA` : `00` = off (charge to 100%), `01` = on (Apple's built-in "stop ~80%, resume <75%"). Only supports the discrete values **80 and 100**, requires firmware ≥ 13.0. This is what macOS's own "Optimized/Charge Limit" toggles. AlDente can piggyback on it but prefers CH0B/CH0C because those give **any %**, not just 80.
- **Charge limit — Intel ("Classic SMC Key"):**
  - `BCLM` : write the max-charge percentage directly (e.g. `50` = 0x32 … `100`). Note macOS overshoots ~3%, so `bclm` recommends writing **77** to actually cap at 80. **KEY ADVANTAGE:** BCLM is enforced by SMC firmware itself, so it **persists and limits even while the Mac is asleep or shut down** — which is why AlDente's "**Use Classic SMC Key (Intel)**" option works when the machine is off. Downside: **no discharge** possible in this mode, **Intel-only**.
- **Force discharge (run on battery while plugged in) — Apple Silicon:**
  - `CH0I` : `01` = force discharge on, `00` = off. (newer variants: `CHIE`=`08`/`00`, or `CH0J`=`01`/`00` depending on firmware.) This makes the Mac draw from the battery even though AC is connected — the primitive behind **Discharge**, **Auto-Discharge**, and the discharge phase of **Calibration**.
- **MagSafe LED color — Apple Silicon (MagSafe 3):**
  - `ACLC` : `03` = **green**, `04` = **orange/amber**, `00` = reset/default. Primitive behind "Control MagSafe LED."
- **Heat / thermal — reads (no write):** battery-temperature SMC/IOKit keys (`TB0T`/`TB1T`/`TB2T` battery-thermistors; legacy `TA0P`, `TC0F`, etc.). Heat Protection *reads* temp then *writes* CH0B/CH0C to inhibit — so the cutoff is [CONTROL] but the temperature readout itself is [DISPLAY].

---

## 4. CHARGE-CONTROL FEATURE INVENTORY

- **Charge Limiter** [CONTROL] — core feature; **FREE**. "Set which charge level your MacBook should hold when plugged in." Range **20–100%** (some docs say settable 20–100; recommended band **50–80%**, with **80% called "a good to very good charge level for battery longevity"**). Two input methods in the popover: (a) drag the **slider**, or (b) click the **percentage display below the "Charge Limit" label and type the number + Enter**. On Apple Silicon it must *actively* flip the CH0B/CH0C gate as the battery crosses the threshold (Apple Silicon charging is binary — no firmware "hold at X"); on Intel it can hand the value to `BCLM` firmware.
- **Use Classic SMC Key (Intel)** [CONTROL] — Intel-only alt path using `BCLM`. Benefit: **inhibits charging even when the MacBook is turned off / asleep**. Tradeoff: **"Allow Discharge" is unavailable while this is active.** Also branded as usable via "**Intel Mode**" for **Boot Camp / Windows** so the limit is enforced under Windows too.
- **Discharge** [CONTROL] — **FREE**. "Simulate unplugging" — battery discharges *while still plugged in* down to the chosen limit, then resumes AC. Menu-bar button labeled **Discharge**. Uses `CH0I`/`CHIE`. (Original beta name: "Allow Discharge," lowers SoC even while plugged.)
- **Automatic Discharge** [CONTROL] — when you lower the charge limit below the current %, it **auto-discharges** down to the new limit instead of just waiting. "Automatically disabled during Calibration Mode."
- **Top Up** [CONTROL] — one-shot: **temporarily sets the limit to 100%**, charges to full, then **auto-deactivates after you unplug** (reverts to your saved limit). Menu-bar button labeled **Top Up**. Temporarily suspends Sailing Mode while active.
- **Sailing Mode** [CONTROL] — **PRO**. Defines a *hysteresis band* below the limit so the battery isn't micro-/trickle-charged at the ceiling. Example given by AHK: limit 80% → after hitting 80% it **lets the battery drift down (e.g. to 75%) on adapter power, only re-charging when it falls to the lower bound.** Recommended interval **5–10%** ("depending on your own judgment and use case"). While the limit is held, the **power adapter is used as the primary power source** (battery isn't cycled). Temporarily deactivates during Top Up and Calibration.
- **Calibration Mode** [CONTROL] — **PRO**. Automated full cycle to fix drifted battery gauge. Exact sequence per AHK: **Charge → 100% → Discharge → 10% → Charge → 100% → hold 1 hour → return to preset limit.** (Older docs describe the cycle as **15%–100%**.) Recommended cadence: **every 4–6 weeks** for typical users; **every 3 weeks** if always-plugged. Suspends Sailing + Auto-Discharge during the run.
- **Heat Protection** [CONTROL] — **PRO**. Reads battery temperature; **stops charging when temp exceeds a threshold**. Default recommended threshold **35 °C**. Uses **5-minute hysteresis intervals** to avoid rapid on/off toggling. Resumes when cool. (Temperature read = DISPLAY; the charge cutoff = CONTROL.)
- **Disable Sleep until Charge Limit** [CONTROL-adjacent] — keeps the Mac awake until it reaches the target %, then **re-enables sleep automatically on unplug**. (Implemented via power-assertion, not SMC — but tied to the charging flow.)
- **Stop Charging when Sleeping** [CONTROL] — **PRO**. Pauses charging just before the Mac sleeps so it doesn't creep to 100% overnight. (Addresses the FREE limitation: "AlDente Free cannot control charging while asleep or shut down; it will continue to charge to 100%.")
- **Stop Charging when App Closed / powered off** [CONTROL] — **PRO**, **Apple Silicon only** — "Ensures the set charge limit remains active even when the AlDente app is closed." Plus "Stop charging when powered off."
- **Control MagSafe LED** [CONTROL] — **PRO** (Apple Silicon, MagSafe 3). Overrides the connector LED: **Green = limit reached**, **Orange/amber = charging or discharging**, **Blinking orange = discharging on MagSafe 3**. Writes `ACLC`.

---

## 5. DISPLAY / MONITORING FEATURE INVENTORY (all safe for us — no helper)

- **Hardware Battery Percentage** [DISPLAY] — reads the **actual battery-management-system SoC** (from the smart-battery gauge) rather than the macOS-displayed %. AHK notes these **typically differ by 2–7%**. A headline "we show the *real* number" feature. Pure IOKit read.
- **Stats panel / Advanced Statistics** [DISPLAY] (Pro surfaces more): **maximum (current full-charge) capacity, design capacity, battery health %, cycle count, battery serial number, temperature, system load, voltage/electrical specs, power/wattage.** All from `AppleSmartBattery`/IOKit — no privilege.
- **Power Flow (Sankey diagram)** [DISPLAY] — **PRO**. Real-time **Sankey visualization** of energy: charger → battery / charger → system / battery → system, showing draw & charge wattage. Read-only telemetry rendered as a flow diagram.
- **Live Status Icons** [DISPLAY] — **PRO**. Menu-bar/popover status glyphs indicating **energy source and charging state** (on adapter / on battery / charging / discharging / limit-held).
- **Temperature readout** [DISPLAY] — current battery temp (°C) shown; drives Heat Protection but the number itself is a read.

---

## 6. UI / MENU-BAR / NOTIFICATIONS (exact behaviors)

- **Menu-bar icon:** 🍝 spaghetti glyph. Single click opens the popover. Popover header shows **current desired charge limit**; body has the **slider** + editable **percentage field**; action buttons **Top Up** and **Discharge**; you can **change the target limit directly from the menu-bar widget**. It can **replace the system battery indicator** (option to hide macOS's own battery icon).
- **Customizable menu-bar icons / popup window** [DISPLAY] — even the FREE tier lists "customizable menubar icons and popup window." Multiple icon styles; can show numeric % in the bar.
- **MagSafe LED as an ambient indicator** — see Control MagSafe LED (green/orange/blinking).
- **Fast User Switching support** [DISPLAY/behavioral] — multi-account aware; charge-control features "activate only on the logged-in account."
- **Notifications:** the app posts state notifications (limit reached / charging paused / calibration started/finished / discharge complete). Exact strings are not published by AHK on the marketing pages; do not quote verbatim without confirming in-app.

---

## 7. AUTOMATION / INTEGRATION

- **Schedule** [CONTROL] — **PRO**. Time-based automation. **Five actions:** *Set Charge Limit, Start Calibration Mode, Top Up, Pause Charging, Discharge to.* **Intervals:** Daily, Weekdays, Weekly, Biweekly, Monthly, Never.
- **Apple Shortcuts integration** [mixed] — **20+ shortcuts**. Read/DISPLAY ones: *Get Battery Percentage, Get Charge Limit, Get State, Get Temperature.* Write/CONTROL ones: *Set Charge Limit, Start Discharge, Set MagSafe LED,* plus macOS **power-mode toggles** (Low Power Mode etc.).
- **Uninstall flow** (FAQ, note for parity): set limit back to **100%**, **wait 30 s** for the SMC change to apply, quit, delete the app — i.e. you must un-write the SMC key before removing, or the limit persists.

---

## 8. PRICING / TIERS (as of 2026)
- **AlDente Free — $0:** Charge Limiter, Discharge, and (per current pricing page) even Heat Protection / Sailing / MagSafe LED / Top Up / Calibration / Shortcuts are *listed* under free on the pricing page — but multiple reviews and the GitHub README state the **Pro-gated set is Heat Protection, Sailing Mode, Top Up, Calibration Mode, Live status icons, better design, advanced stats, Power Flow, Schedule**. (AHK's marketing tables are inconsistent; treat Discharge + basic Charge Limiter as the guaranteed-free core, everything else effectively Pro.)
- **AlDente Pro — Annual:** ≈ **€11.49 / ~$12–13.99 per year**.
- **AlDente Pro — Lifetime:** ≈ **€23.99 / ~$24.99 one-time**.
- **Via Setapp:** €9.99/$9.99 per month (bundle of 240+ apps); free trial via Setapp.
- **License scope:** one key across **up to 3 macOS user accounts on up to 3 different MacBooks**. Student discount ~20%.

---

## 9. NET TAKEAWAY FOR OUR COMPETING APP
- **Everything in §5 (DISPLAY) we can ship with zero risk / zero privilege** — hardware %, capacity, health, cycles, temperature, voltage, wattage, power-flow Sankey, live status, menu-bar readout. This is pure IOKit/SMC-read + `pmset` (which our codebase already touches, e.g. `live.rs`). No helper, no password, no notarized daemon.
- **Everything in §4 (CONTROL) — charge limit, discharge, sailing, calibration, heat cutoff, MagSafe LED — is the hard/risky path:** it mandates a **root privileged helper** (SMJobBless/SMAppService), an **admin-password prompt**, Developer-ID **notarization**, unsandboxed helper, XPC IPC, and an ongoing **maintenance treadmill** as Apple mutates SMC keys/firmware (BCLM entitlement lockout on macOS 15, CH0B/CH0C → CHTE transition, the mid-2025 "silent SMC firmware update" breakage). No kext is needed, but the privilege + fragility cost is real.
- **Cheapest credible differentiator vs AlDente without the CONTROL burden:** beat their **DISPLAY** surface (accurate hardware %, richer history/graphs — which your 3D discharge-history viewer already does) and, if you ever want the 80%-limit feature specifically, the *lowest-risk* control primitive is **`CHWA` = 01** (Apple's own supported 80/100 key on Apple Silicon fw ≥13) rather than the finer-grained CH0B/CH0C juggling — but it still needs the root helper.

---

## SOURCES
- AlDente Features — https://apphousekitchen.com/aldente-overview/features/
- AlDente Overview — https://apphousekitchen.com/aldente-overview/
- AlDente FAQ — https://apphousekitchen.com/faq/
- AlDente Pricing — https://apphousekitchen.com/aldente-overview/pricing/
- AlDente GitHub (now closed-source; issues/releases + README) — https://github.com/AppHouseKitchen/AlDente-Battery_Care_and_Monitoring
- Legacy open-source AlDente (David Wernhart) — https://github.com/davidwernhart/AlDente-Charge-Limiter
- "SMC firmware update broke charge limiting" discussion #1534 — https://github.com/AppHouseKitchen/AlDente-Battery_Care_and_Monitoring/discussions/1534
- "Stuck at install helper" issue #1030 (helper/SMAppService) — https://github.com/AppHouseKitchen/AlDente-Battery_Care_and_Monitoring/issues/1030
- SMC keys (CH0B/CH0C/CHTE/CH0I/CHIE/CH0J/ACLC) — actuallymentor/battery `battery.sh` — https://github.com/actuallymentor/battery
- SMC / root-daemon architecture — charlie0129/batt — https://github.com/charlie0129/batt
- Intel BCLM + CHWA + macOS 15 entitlement lockout — zackelia/bclm — https://github.com/zackelia/bclm
- Open-source AlDente alternative confirming key set — killerk3emstar/OpenDente — https://github.com/killerk3emstar/OpenDente
- SMJobBless / SMAppService privileged-helper mechanism — https://github.com/OCForks/SMJobBless , https://github.com/alienator88/HelperToolApp
- Review with UI/pricing/menu-bar detail — TheSweetBits AlDente Pro review — https://thesweetbits.com/tools/aldente-pro-review/
- Apple native Charge Limit / Optimized Charging (context) — https://support.apple.com/en-us/102338
