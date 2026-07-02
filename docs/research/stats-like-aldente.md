# AlDente (apphousekitchen.com) — Exhaustive Feature & Mechanism Inventory

Prepared for a competing macOS battery app seeking full feature parity. Each item tagged **[DISPLAY]** (read-only sensor/UI — safe, no privilege) or **[CONTROL]** (writes hardware/SMC — requires a privileged root helper, risky). AlDente is **closed-source proprietary** as of current versions (the GitHub repo `AppHouseKitchen/AlDente-Battery_Care_and_Monitoring` is now only an issue tracker + archived legacy code; the README explicitly states "This project is no longer open source"). Exact SMC keys below are corroborated from open-source clones that use the identical mechanism (`bclm`, `batt`, `actuallymentor/battery`, `Battery-Toolkit`).

================================================================
## A. THE CRUCIAL PART — TECHNICAL MECHANISM (how it actually controls charging)
================================================================

**It writes SMC (System Management Controller) keys. That is the entire trick.** There is no public/Apple API for charge limiting; AlDente reaches the SMC through Apple's `AppleSMC` IOKit service and writes register values. Writing SMC keys requires **root**, so AlDente does NOT run the whole app as root — it ships a **privileged helper tool**.

### Privileged helper architecture [CONTROL — this is the risky/privileged part]
- On **first launch the app prompts the user to authorize installing a helper tool** ("AlDente Helper"), which requires the admin password once. Source: bclm gist FAQ ("on the first start, the application is going to ask you to allow installing a helper tool"); TheSweetBits review confirms it installs "the **AlDente Helper** application for the app to work completely fine."
- Mechanism is Apple's **`SMJobBless` / Service Management framework** (older builds) → helper binary placed in **`/Library/PrivilegedHelperTools/`**, launched by **`launchd`** as a **root LaunchDaemon** with a plist in **`/Library/LaunchDaemons/`**. Modern equivalent is `SMAppService`/`SMAppService.daemon` on Ventura+. The Service Management framework uses **code signatures** to bind helper↔app so only the expected signed app can invoke the helper.
- **Security boundary claim:** "no full root access is granted even if the application is compromised" — the helper exposes only a minimal XPC protocol to write battery SMC values, so a compromised GUI can't do arbitrary root actions. (This mirrors the open-source `Battery-Toolkit` design: GUI app + minimal-protocol XPC service authenticating a privileged daemon `me.mhaeuser.batterytoolkitd`.)
- **Entitlements / signing:** app is **notarized** and Developer-ID signed; the helper is signed and its `SMAuthorizedClients`/`SMPrivilegedExecutables` designated-requirement strings pin the app's Team ID + bundle ID. **No special Apple "battery" entitlement exists** — charge control is not an entitlement, it is raw SMC writes done as root by the helper. (This is why the App Store version cannot limit charging and it's sold only as a direct/Setapp download.)
- **NO kernel extension (kext) and NO DriverKit dext is required.** SMC access is via the in-kernel `AppleSMC` IOKit driver from userspace root; that's why it survives modern macOS with SIP on. Confirmed by every open-source clone (all are pure userspace + `sudo`).
- **Uninstall requirement (side-effect of SMC persistence):** FAQ instructs users to "**set the charging limit back to 100%, wait 30 seconds** for changes to take place, quit the app, and delete AlDente." If you delete without resetting, the SMC key stays written and the Mac keeps refusing to charge past the limit — proof the state lives in hardware, not the app.
- **Supported macOS:** "macOS 11 Big Sur up to macOS 26 Tahoe." Apple Silicon supported.

### Intel vs Apple Silicon — the keys differ [CONTROL]
**Intel Macs — single key `BCLM` ("Battery Charge Level Max"):**
- Write the max-charge percentage into `BCLM`. Because macOS overshoots ~3%, tools set `BCLM = 77` to actually hold ~80% displayed.
- The value is **lost on an SMC reset**, so it must be **persisted** via a LaunchDaemon that re-writes `BCLM` at boot (bclm's `persist` creates a plist in `/Library/LaunchDaemons` + `launchctl load`).
- Continuous range supported (any %), unlike Apple Silicon.

**Apple Silicon Macs — no `BCLM`; charging is gated by discrete keys (exact values from `actuallymentor/battery` `battery.sh` + `batt`):**
- **Disable charging:** `CH0B = 0x02` **and** `CH0C = 0x02`. **Enable charging:** `CH0B = 0x00`, `CH0C = 0x00`.
- **Newer Macs / macOS Tahoe path:** `CHTE` — write `0x01000000` to stop charging, `0x00000000` to allow (replaces CH0B/CH0C on latest firmware).
- **Force discharge / cut the adapter (run on battery while plugged in):** `CHIE = 0x08` (or fallback `CH0J = 0x01` / `CH0I = 0x01`) to enable discharging; `= 0x00` to stop discharging. This "inhibits" input power so the pack drains even on AC.
- **`CHWA` = Apple's own optimized-charging toggle** (the 80% firmware feature); as a level it only accepts **80 or 100** and needs **firmware ≥ 13.0**. `bclm`/AlDente use CHWA on some AS models for the coarse 80% clamp.
- **MagSafe LED control key `ACLC`:** `0x03` = **green** (charging disabled/limit held), `0x04` = **orange** (charging/enabled), `0x00`/`0x01` = reset. This is how AlDente changes the MagSafe 3 LED color to reflect state.
- Because there is no persistent max-% register on AS, AlDente must **keep running** to hold the limit — when the app quits or the Mac powers off, the SMC gate resets and the Mac charges to 100% (hence the "Stop Charging when App Closed" Pro feature and the caveat that AS resets to 100% when powered off).
- **`e00002bc` write errors** occur on Macs lacking MagSafe/certain keys — real hardware-compat edge case any parity app inherits.

### Sensor reads used by AlDente [DISPLAY — safe]
- Battery temperature via SMC (e.g. `TB0T`/battery temp sensors) → drives Heat Protection threshold.
- "**Hardware Battery Percentage**" read directly from the battery management IC/SMC raw registers, which "**typically differs 2–7% from the macOS display**" (macOS shows a smoothed value). This is a marketed differentiator and is pure read-only.
- Max capacity, cycle count, system load, wattage/amperage/voltage (for Stats & Power Flow) — all IOKit `AppleSmartBattery` / SMC reads.

================================================================
## B. FEATURE INVENTORY (exact labels, numbers, defaults)
================================================================

Note on tiering: AlDente's own GitHub README splits **Free = Charge Limiter + Discharge only**; **Pro = Heat Protection, Sailing Mode, Top Up, Calibration Mode, "…" + better design & live status icons.** The current apphousekitchen pricing page renders a comparison table that appears to show many features under Free as well — tiering has shifted over versions, so treat the README split as the conservative baseline and verify per-version. Prices: **Free €0**; **Pro subscription €11.49/yr** (auto-renew); **Pro lifetime €23.99 one-time**; **Setapp €9.99/mo bundle**. (A US review lists $13.99/yr, $24.99 lifetime — regional.)

### Core charging control
- **Charge Limiter** [CONTROL][Free] — "limit your MacBook from charging above a certain percentage." Range **20%–100%**, set by **slider or numeric text input**. Change takes **~1–2 minutes** to register in hardware. Writes BCLM (Intel) or CH0B/CH0C/CHTE (AS).
- **Discharge** [CONTROL][Free] — "run completely on Battery even if it is plugged in… actively discharge to a healthier percentage." Uses `CHIE/CH0I/CH0J` (adapter inhibit) + MagSafe. **Clamshell (lid-closed) discharge NOT supported in Free** (technical limitation — needs to keep the system awake); **Discharge in Clamshell Mode is Pro-only.**
- **Automatic Discharge** [CONTROL][Pro] — when you lower the charge limit **below the current battery %**, it automatically discharges down to the new limit instead of just waiting.
- **Top Up** [CONTROL][Pro] — one-tap "temporarily set limit to **100%** until the **first unplug**," then it snaps back to your normal limit. For when you need a full charge before travel.

### Longevity / protection
- **Sailing Mode** [CONTROL][Pro] — a **lower+upper band** instead of a hard ceiling, so charging isn't micro-cycling at the ceiling. Example given by AlDente: **band 75%–80%** — after hitting 80% it **lets the battery drift down to 75%** on battery power before charging resumes. Suggested interval **5–10%**. Reduces tiny charge/discharge cycles that count toward wear.
- **Heat Protection** [CONTROL][Pro] — "charging will automatically stop when battery temperature is too high." User-set threshold; **Apple's referenced max is 35°C**. Uses **~5-minute hysteresis intervals** so it doesn't flap on/off. Pauses charging (CH0B/CH0C) until temp drops.
- **Calibration Mode** [CONTROL][Pro] — periodically runs a **full cycle to re-calibrate the gauge**: AlDente drives **~15% → 100%**, then **holds ~1 hour**, then returns to your limit. Recommended cadence **once a month (every ~3–6 weeks)**. Prevents gauge drift from living in a narrow 20–70% band.

### Sleep / power orchestration (needed because AS won't hold a limit unattended)
- **Disable Sleep until Charge Limit** [CONTROL/OS-assertion][Pro] — keeps the Mac awake while charging up to the limit (power assertion / `caffeinate`-style, not SMC).
- **Stop Charging when Sleeping** [CONTROL][Pro] — pauses charging just before sleep.
- **Stop Charging when App Closed** [CONTROL][Pro] — attempts to hold the limit on Apple Silicon even after quit (note: **AS resets to 100% when the Mac is powered off**, unavoidable).

### Hardware indicators
- **Control MagSafe LED** [CONTROL][Pro] — recolors the MagSafe 3 charger LED to reflect state: **green = limit reached / not charging**, **orange = charging or discharging**, **blinking orange = actively discharging** on MagSafe 3. Writes `ACLC` (0x03 green / 0x04 orange).

### Monitoring / stats (all read-only)
- **Hardware Battery Percentage** [DISPLAY][Pro] — true pack % from the battery IC, **2–7% off from macOS**'s displayed number.
- **Stats** [DISPLAY][Pro] — panel of sensor data: **maximum battery capacity**, **temperature**, **system load**, wattage, and more "battery and power health" metrics.
- **Power Flow** [DISPLAY][Pro] — real-time **Sankey diagram** of energy distribution (how many watts go to the battery vs the system vs from the adapter).

### Automation / integration
- **Schedule** [CONTROL trigger][Pro] — automate limit/actions with repeat options: **Daily, Weekdays, Weekly, Biweekly, Monthly, Never**.
- **Apple Shortcuts Integration** [mixed][Pro] — **15+ commands**: get battery %, get/set charge limit, get charge state, get temperature, run/stop calibration, start/stop discharge, etc. (getters are DISPLAY, setters are CONTROL.)
- **Fast User Switching** support [DISPLAY/infra][Pro] — coordinates settings across multiple logged-in macOS user accounts. License activates on **up to 3 macOS user accounts**.

================================================================
## C. MENU-BAR & UI BEHAVIOR (exact)
================================================================
- **Menu-bar icon is customizable** [DISPLAY]: user can **toggle showing the percentage number** and **pick from many icon styles**; it can effectively **replace the default system battery indicator**.
- **Live Status Icons** [DISPLAY]: icon reflects **charging state, power source, and battery-flow status** in real time (charging / discharging / holding / on-battery).
- **Dropdown / popup window** [DISPLAY + control buttons]: shows the **current charge-limit %**, a **slider/percentage control to change the limit right from the menu bar**, and two quick-action buttons **"Top Up"** and **"Discharge."** Popup layout is customizable ("Customizable Popup Window").
- Marketing stats on site: **700,000+ downloads, 2,500+ reviews, 98% rating on Setapp, "20+ features."**

================================================================
## D. DISPLAY vs CONTROL — what a parity app can safely ship
================================================================
**[DISPLAY] — implementable with zero privilege (IOKit `AppleSmartBattery` + SMC reads, no helper):**
- Current battery %, hardware/raw battery % (2–7% delta), battery temperature, max capacity / health, cycle count, wattage/volts/amps, adapter status, time-to-full/empty.
- Stats panel, Power-Flow Sankey, customizable menu-bar icon + percentage, live status icon, notifications, Shortcuts *getters*.
- These are exactly the kind of thing your own 3D-battery tracker already reads — safe, no root, no notarized helper needed.

**[CONTROL] — requires the privileged root helper + SMC writes (risky, needs authorization, notarization, careful uninstall):**
- Charge Limiter, Sailing Mode, Heat Protection (charge pause), Calibration cycles, Discharge / Auto-Discharge / Clamshell discharge, Top Up, MagSafe LED color, Stop-charging-on-sleep/close, Schedule actions, Shortcuts *setters*.
- To match these you MUST: (1) ship a **signed+notarized privileged helper** installed via `SMAppService`/`SMJobBless`, (2) get **one-time admin authorization**, (3) write SMC keys as **root** (`BCLM` on Intel; `CH0B`/`CH0C`/`CHTE`/`CHIE`/`CH0I`/`CHWA`/`ACLC` on Apple Silicon), (4) **persist on Intel** via a LaunchDaemon (survives SMC reset), (5) handle the **quit/power-off resets to 100%** on Apple Silicon, (6) provide a **reset-to-100%-then-wait-30s** uninstall path. No kext/dext or special Apple entitlement is required or available — it's raw root SMC access.

================================================================
## Sources
================================================================
- AlDente Features: https://apphousekitchen.com/aldente-overview/features/
- AlDente overview: https://apphousekitchen.com/aldente-overview/
- AlDente pricing (Free vs Pro table, prices): https://apphousekitchen.com/aldente-overview/pricing/
- AlDente FAQ (macOS support, uninstall, clamshell): https://apphousekitchen.com/faq/
- AlDente GitHub (closed-source statement, Free vs Pro split): https://github.com/AppHouseKitchen/AlDente-Battery_Care_and_Monitoring
- `zackelia/bclm` (Intel BCLM, ~3% overshoot → set 77, root, persist LaunchDaemon, AS CHWA 80/100 fw≥13): https://github.com/zackelia/bclm and issue #20 (Apple Silicon): https://github.com/AppHouseKitchen/AlDente-Battery_Care_and_Monitoring (referenced commit 77119a1)
- `actuallymentor/battery` `battery.sh` (exact keys/values CH0B/CH0C=02, CHTE, CHIE/CH0I/CH0J, ACLC LED 03/04): https://raw.githubusercontent.com/actuallymentor/battery/main/battery.sh ; SMCWriteKey e00002bc issue #343: https://github.com/actuallymentor/battery/issues/343
- `charlie0129/batt` (SMC control, root requirement, gosmc): https://github.com/charlie0129/batt
- `mhaeuser/Battery-Toolkit` (privileged daemon me.mhaeuser.batterytoolkitd, XPC, upper/lower limit, disable adapter): https://github.com/mhaeuser/Battery-Toolkit
- SMJobBless / privileged helper mechanism (/Library/PrivilegedHelperTools, launchd root, code-signature binding): https://github.com/cntrump/SMJobBless
- TheSweetBits AlDente review (menu-bar icon, Top Up/Discharge buttons, AlDente Helper install, Power Flow): https://thesweetbits.com/tools/aldente-pro-review/

Note: exact SMC values are cited from open-source tools using the same technique; AlDente itself is closed-source so its internal key choices per model can't be byte-verified, but behavior (limit hold, discharge, MagSafe LED, Intel persistence, quit-resets-to-100% on AS) matches these keys exactly.