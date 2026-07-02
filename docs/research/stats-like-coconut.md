# coconutBattery — Exhaustive Feature & Data-Field Inventory

Scope note on `[DISPLAY]` vs `[CONTROL]`: coconutBattery is almost entirely a **read-only diagnostic** — it reads Apple's IOKit / SMC / `AppleSmartBattery` keys and the iOS `mobiledevice`/`lockdown` framework. It does **not** write, calibrate, charge-limit, or otherwise modify battery hardware (that is what apps like AlDente do). Therefore nearly every item below is `[DISPLAY]`. The few `[CONTROL]`-style items are app-level *actions/settings* (export a file, upload anonymized stats, set a notification threshold, pair over Wi‑Fi, trust a USB device) — none write hardware, though some need OS privileges (USB pairing trust, notification permission, network). I mark those explicitly.

---

## 1) BUILT-IN MAC BATTERY (main window, top panel)

Exact field labels coconutBattery uses (confirmed across FileHorse, TechSpot, ChrisWrites, Macworld):

- `[DISPLAY]` **Current charge** — present charge in **mAh** ("The current battery charge (in mAh - milliampere‑hour)") AND as a **%** of full-charge capacity. Shown as a bar/gauge. [FileHorse, TechSpot]
- `[DISPLAY]` **Full charge capacity** (a.k.a. "Maximum charge") — "The maximum capacity your battery can be charged with," in **mAh** — i.e., what the Mac currently treats as 100%. [FileHorse, TechSpot, Macworld]
- `[DISPLAY]` **Design capacity** — "The capacity your battery could be charged with when it left the factory," in **mAh**. [FileHorse, TechSpot, Macworld, ChrisWrites]
- `[DISPLAY]` **Battery health / Maximum capacity %** — Full-charge capacity expressed as a percentage "in relation to the original (design) capacity." This is the headline number (e.g., "94%"). [FileHorse]
- `[DISPLAY]` **Cycle count** ("Load cycles" / "Battery loadcycles") — "How often was your battery loaded from 0% to 100%" — exact charge-cycle count read directly (no Terminal). [FileHorse, TechSpot, ChrisWrites]
- `[DISPLAY]` **Battery temperature** — "The current temperature inside your battery," with a **Celsius/Fahrenheit toggle** (click the temperature to switch units). [FileHorse, TechSpot; unit-toggle per WebSearch]
- `[DISPLAY]` **Power / battery usage in Watts** — "The current power consumption of your MacBook" (real-time draw), and whether the Mac is **charging or discharging**; shows charging wattage. Labeled as battery usage / power. [FileHorse, TechSpot, WebSearch]
- `[DISPLAY]` **Power adapter** — connection status + wattage transfer rate; indicates "whether the connected charger is operating at its rated capacity" (adapter wattage & description). [Macworld, WebSearch]
- `[DISPLAY]` **Age of your Mac** — device age computed from the production/manufacture date "based on a date Apple encodes in it." [Macworld, FileHorse]
- `[DISPLAY]` **Manufacture date** — derived from the serial number's date coding. **Caveat surfaced in FAQ:** "Apple switched to a randomized serial number format a few years ago, which prevents reading the manufacturing date" → on newer machines this field can be unavailable. [ChrisWrites, coconut-flavour FAQ]
- `[DISPLAY]` **Battery serial number** — used internally to derive manufacture date/age; also exposed in the info/advanced views. [ChrisWrites, Macworld]
- `[DISPLAY]` **Battery manufacturer** — battery cell/pack manufacturer string (varies by device). [general reviews]
- `[DISPLAY]` **Mac model / model identifier** — "The Apple model identification string for your Mac" (e.g., MacBookPro18,3), plus human-readable model name. [FileHorse, TechSpot]
- `[DISPLAY]` **Mac Info / Advanced Viewer extras (Plus)** — see §6: MLB serial, manufacture country, storage (SSD) manufacturer, SSD read/write stats.

---

## 2) CONNECTED iOS / iPhone / iPad (and iPod touch) OVER USB — and Wi‑Fi (Plus)

coconutBattery reads the device's own battery registers (not just what iOS Settings shows). Fields mirror the Mac panel [Macworld, The Apple Geek, TechSpot]:

- `[CONTROL-ish]` **Connection** — requires plugging the iOS device in via USB **and trusting the computer** (needs pairing/lockdown trust; a privilege prompt on the device). Plus adds **Wi‑Fi** reading after one-time pairing so "you no longer need a USB connection." [coconut-flavour FAQ]
- `[DISPLAY]` **Current charge** — in **mAh** and **%**. [The Apple Geek, Macworld]
- `[DISPLAY]` **Full charge capacity** — current 100% capacity, mAh. [Macworld]
- `[DISPLAY]` **Design capacity** — factory capacity, mAh. [Macworld]
- `[DISPLAY]` **Battery health %** — full-charge vs design capacity (e.g., iPhone 7 Plus example). [The Apple Geek]
- `[DISPLAY]` **Cycle count** — e.g., "269 cycles" shown for an iPhone. [The Apple Geek]
- `[DISPLAY]` **Battery temperature** — current device battery temp. [WebSearch/Advanced]
- `[DISPLAY]` **Device age** — from Apple-encoded manufacture date. [Macworld]
- `[DISPLAY]` **Manufacture date** — from device serial coding. [Macworld]
- `[DISPLAY]` **Device serial number** — "pull up the serial number… through the Device Info section." [WebSearch/Advanced]
- `[DISPLAY]` **Device model** — model identifier / marketing name (iPhone/iPad/iPod touch). [FileHorse]
- `[DISPLAY]` **iOS/iPadOS version & other Device Info** — surfaced in the Advanced Viewer "Device Info." [WebSearch]
- `[DISPLAY]` **Power adapter details** while the iOS device charges. [Macworld]
- `[DISPLAY]` **Battery Lifetime Analyzer (Plus) for iOS** — max/min/avg temperature, voltage, charge/discharge-rate ranges, battery operating time (see §6). [coconut-flavour FAQ]

---

## 3) ONLINE HISTORY / TRACKING — "coconutBattery Online" + local history

- `[DISPLAY]` **History tab** — saved readings over time to "see how the battery health depreciates," charting Health %, cycle count, and capacity across dates. [FileHorse, Macworld]
- `[CONTROL — action, file write]` **Save Battery Health Info** (Plus) — snapshot/store current readings as historical log entries for longitudinal analysis. [coconut-flavour features]
- `[CONTROL — action, file write]` **Export / backup** — export readings to **CSV** or archive files "so you will be able to preserve the information even if you reinstall." [WebSearch/FileHorse]
- `[CONTROL — action, network upload]` **coconutBattery Online** — sends **anonymized battery information** to the cloud service to build model-level aggregates. [coconut-flavour FAQ]
- `[DISPLAY]` **"Battery capacity over time" comparison graph (coconutBattery Online tab)** — plots:
  - a **dark-green line** = the battery health of *your specific Mac* over time,
  - a **light-green line** = the *average* health of *your specific Mac model*,
  - a **pale-green band/range** around them = the full range of all battery-health data collected for that model. [WebSearch, community]
  - Lets you **compare your battery against other users** with the same model. [Macworld, FileHorse]
- `[DISPLAY]` **Privacy / retention (site telemetry)** — Matomo analytics with **IP anonymization**; server logs deleted after **365 days**; OS/visit-source only. [coconut-flavour privacy]

---

## 4) MENU-BAR PLUGIN ("Live Display") — Plus feature

- `[DISPLAY]` **Two menu-bar live displays** listed as distinct Plus features: **"Mac Battery Details in Menu Bar"** and **"iPhone/iPad Battery Details in Menu Bar."** [coconut-flavour features]
- `[DISPLAY]` **Persistent menu-bar readout** — shows live battery info without opening the main window; note that in the **Free** version the app "lives in a window — not in your menu bar," so the menu bar is a paid capability. [getjuicy]
- `[CONTROL — app setting]` **Configurable metrics** in the menu-bar item / dropdown, including: **battery charge %**, **capacity/health %**, **temperature**, **charging state + charging wattage**, **current charge in mAh**, and (in dropdown) **iOS/iPadOS device battery details**. "Configurable details about battery status." [WebSearch, Macworld]
- `[CONTROL — app setting]` **Unit toggle** — click temperature in the menu/app to switch °C/°F. [WebSearch]

---

## 5) NOTIFICATIONS (Plus)

- `[CONTROL — app setting, needs Notification permission]` **Mac low-battery alert** — "Get notified when your Mac battery drops below a set percentage **or remaining time**" (user-set threshold). [coconut-flavour FAQ]
- `[CONTROL — app setting]` **iOS/iPad low-battery alert** — "receive alerts when your iPhone or iPad battery percentage falls below a **customizable threshold**." [coconut-flavour features]
- Note: exact default threshold values and exact notification body strings are not published on the site; thresholds are user-defined.

---

## 6) ADVANCED VIEWER / BATTERY LIFETIME ANALYZER / SSD (Plus)

- `[DISPLAY]` **Battery Lifetime Analyzer** — "detailed lifetime information, including **maximum, minimum, and average temperature**, **voltage**, **charge/discharge-rate ranges**, and **battery operating time**." [coconut-flavour features/FAQ]
- `[DISPLAY]` **Advanced Viewer** — "comprehensive information about your Mac, iPhone, and iPad." [coconut-flavour features]
- `[DISPLAY]` **Mac SSD stats** — internal SSD "**data read and write statistics**" (i.e., total bytes read/written / TBW-style counters). [coconut-flavour features, TechSpot]
- `[DISPLAY]` **Additional Mac hardware IDs** — "MLB serial, manufacture country, and storage manufacturer information for Macs." "Available information varies by device." [TechSpot]
- `[DISPLAY]` **Device Info** — serial number + age for Mac/iPhone/iPad. [WebSearch]

---

## 7) PRINTING / REPORTS (Plus)

- `[CONTROL — action]` **Custom Printing Templates** — print/generate battery reports "using HTML formats" (custom templates). [coconut-flavour features, TechSpot]
- `[CONTROL — action]` **Export battery reports** for future reference. [FileHorse]

---

## 8) SETTINGS / PREFERENCES / DEFAULTS

- `[CONTROL — app setting]` **Temperature unit** — °C / °F toggle. [WebSearch]
- `[CONTROL — app setting]` **Wi‑Fi communication** enable/pair between Mac ↔ iPhone/iPad (Plus). [coconut-flavour FAQ]
- `[CONTROL — app setting]` **Menu-bar content** configuration (which metrics show). [WebSearch]
- `[CONTROL — app setting]` **Notification thresholds** (% and remaining time). [coconut-flavour FAQ]
- `[CONTROL — app setting]` **coconutBattery Online opt-in** (share anonymized data). [coconut-flavour FAQ]
- `[CONTROL — app setting]` **Plus free-trial toggle** — "activated in the app settings… start coconutBattery **10 times in Plus‑Mode**." [coconut-flavour FAQ]
- `[DISPLAY]` **Battery-care tips** in FAQ (avoid heat, limit fast charging, enable Apple's Optimized Battery Charging) — informational only. [coconut-flavour FAQ]

---

## 9) EDITIONS, PRICING, PLATFORM

- **Free (coconutBattery):** Mac Battery Diagnostic + iPhone/iPad Battery Diagnostic (USB), including health, cycle count, capacity, temperature. [coconut-flavour, getjuicy]
- **Plus** adds: Save Battery Health Info, Mac + iPhone/iPad menu-bar details, Wi‑Fi support, Battery Lifetime Analyzer, Advanced Viewer (SSD etc.), Custom Printing Templates, Notifications. [coconut-flavour comparison table]
- **Plus editions:** **"Lifetime Edition"** ("complete package," Unlimited devices, **all future Plus updates included**) vs **"coconutBattery 4 (Standard)"** (Unlimited devices, **only v4.x updates**). [coconut-flavour order page]
- **Pricing:** Purchase is a **one-time payment** (not subscription). Published/reported figures vary by source and era: legacy Macworld lists **US $9.95**; 2026 directory listings cite **~$17.95 lifetime** for the top tier. Exact current numbers weren't machine-readable from the JS order page — verify live on coconut‑flavour.com/order. [Macworld ($9.95); getjuicy/FileHorse ($17.95 lifetime); coconut-flavour FAQ (one-time purchase)]
- **Distribution:** "coconutBattery is only available via coconut‑flavour.com" (not the Mac App Store). [coconut-flavour FAQ]
- **System requirement:** **macOS 12 Monterey or later** (v4.x). [coconut-flavour]
- **Legacy builds** offered for older OS: 3.9.18, 3.6.4, 3.3.4, 2.8, 2.6.7. [coconut-flavour FAQ]
- **Recent changelog (v4.3.x)** examples of scope: fixed power-usage display on Intel MacBooks, corrected delayed-mode charge display, MacBook Air 2025 compatibility, improved Wi‑Fi reliability, Chinese localization. [TechSpot]

---

## 10) FEATURE-PARITY CHECKLIST FOR A COMPETING APP (condensed, all `[DISPLAY]` unless noted)

Mac: current charge (mAh + %), full charge capacity (mAh), design capacity (mAh), health/max-capacity %, cycle count, temperature (°C/°F toggle), live power in W, charge/discharge state, power-adapter wattage + description/rated-capacity check, Mac age, manufacture date (with randomized-serial caveat), battery serial, battery manufacturer, model identifier, SSD read/write + storage maker + MLB serial + manufacture country.
iOS: same battery set over USB (+ Wi‑Fi in Plus), device serial, device model, iOS version, device age — `[CONTROL-ish]` requires USB trust/pairing.
History/Online: local history charts, Save snapshot, CSV/archive export `[CONTROL-action]`, cloud upload of anonymized data `[CONTROL-action/network]`, model-average comparison graph (dark-green = you, light-green = model avg, pale-green band = model range).
Menu bar (Plus): configurable live readout (%/health/temp/W/mAh/charge state) + iOS details in dropdown `[CONTROL-app-setting]`.
Notifications (Plus): Mac below-% or below-time; iOS below-% `[CONTROL-app-setting]`.
Lifetime Analyzer (Plus): min/max/avg temperature, voltage, charge/discharge-rate ranges, operating time.
Printing (Plus): HTML custom templates `[CONTROL-action]`.

**Bottom line for parity:** everything coconutBattery *shows* is `[DISPLAY]` and re-implementable from IOKit (`AppleSmartBattery`, SMC) + the iOS lockdown/mobiledevice framework. There is **no hardware-writing `[CONTROL]`** anywhere in coconutBattery — the only "control" surfaces are app settings, file exports, cloud opt-in, USB-trust, and notification permissions.

---

## Sources
- coconutBattery 4 official product page — https://coconut-flavour.com/coconutbattery/
- coconutBattery FAQ (trial, WiFi, notifications, serial/manufacture-date caveat, distribution) — https://coconut-flavour.com/faq/coconutbattery/
- coconutBattery order/editions page — https://coconut-flavour.com/order/
- Macworld review (fields, iOS, online history, menu bar, price) — https://www.macworld.com/article/542901/coconutbattery-review-mac-gems.html
- ChrisWrites tutorial (Current charge / Full charge capacity / Design capacity / Manufacture date / Cycle count / Battery temperature labels) — https://www.chriswrites.com/how-to-check-the-health-of-your-macbook-battery-using-coconutbattery/
- FileHorse listing (exact mAh field descriptions, °C/°F toggle, health %, load cycles, export, online) — https://mac.filehorse.com/download-coconutbattery/
- TechSpot listing + changelog (SSD read/write, MLB serial, manufacture country, notifications, printing templates, v4.3.3 notes) — https://www.techspot.com/downloads/6461-coconutbattery.html
- The Apple Geek (iOS cycle count/health example) — https://www.theapplegeek.co.uk/blog/coconut-battery
- Juicy directory review (menu-bar-is-Plus, no-alerts-in-free, ~$17.95 lifetime) — https://getjuicy.app/directory/mac-battery-apps/coconut-battery/
- Apple Wiki / Fandom (background) — https://apple.fandom.com/wiki/CoconutBattery