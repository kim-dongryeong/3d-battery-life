# coconutBattery — EXHAUSTIVE Feature & Data-Field Inventory (for feature-parity)

Sources are cited inline as (src: domain) and listed at the end. App researched: **coconutBattery 4.x** by coconut-flavour.com (Christoph Sinai / "coconut-flavour"), the app formerly at v3.x; trusted-since-2005 Mac battery-health utility. Free version is donationware; paid tier is **coconutBattery Plus** (one-time purchase, ~$9.95; a higher "family"/multi-device tier is listed by some resellers at ~$17.95).

## KEY ARCHITECTURAL FINDING (important for your competing app)
- coconutBattery is a **pure read-only diagnostic/telemetry app**. It reads battery/SMC/SMART/IOKit data and displays/logs/uploads it. **It writes NO hardware and needs NO elevated privilege / no charge-limiting / no SMC writes** (unlike AlDente or Battery Toolkit). Therefore essentially every feature below is **[DISPLAY]**. The only non-DISPLAY items are app-level toggles ("run in background", "send to online service", "print") which I mark **[CONFIG]** — none of these are [CONTROL] hardware writes. **Net: you can reach 100% parity with coconutBattery without any privileged hardware control.** (src: coconut-flavour.com, macworld.com)

---

## 1) BUILT-IN MAC BATTERY — main window fields
All **[DISPLAY]**. Two headline "gauge" panels: the top panel = **This Mac**, the battery panel below = live battery. Exact labels observed across versions:
- **Current charge** — live charge in **mAh** and **%** (the "% charged right now"). (src: chriswrites.com, macworld.com)
- **Maximum charge** / **Full charge capacity** — the battery's present real maximum capacity in **mAh** ("what your Mac considers 100% right now"). (src: macworld.com, techspot.com)
- **Design capacity** — factory/original capacity in **mAh** ("capacity when it left the factory"). (src: chriswrites.com, techspot.com)
- **Battery health / capacity %** — computed = Full-charge ÷ Design capacity, shown as a big **percentage** with a colored bar. Red/low bar semantics: capacity shown as a colored bar; when **under ~80%** the app signals it should be replaced. (src: getjuicy.app, search: macrumors/apple discussions)
- **Cycle count** — labeled **"Battery loadcycles"** in older builds / "Cycle count"; number of full charge-discharge cycles. (src: techspot.com, chriswrites.com)
- **Battery temperature** — live internal battery temperature; **toggleable °C / °F** in prefs. (src: techspot.com, chriswrites.com)
- **Charging / discharging power** — live **watts**; e.g. displays "**Charging with [X] watts**" (drops as it nears full); on battery shows discharge draw ("Battery usage"/power consumption in W). (src: macworld.com, search: macrumors)
- **Charge state text** — Charging / Discharging / Charged / "on AC / on battery" status.
- **Battery condition** — surfaces macOS condition string (**Normal** ↔ **Service Recommended**), i.e. the same data macOS uses. (src: search macrumors/apple discussions)

## 2) "This Mac" panel / Mac & device metadata (click Mac or Battery info to expand)
All **[DISPLAY]**:
- **Mac model** name + **model identifier** (Apple ID string), and **Mac age** (derived from serial). (src: macworld.com, trms.me)
- **macOS / system version** context; **serial number**; **MLB serial** (logic-board serial, added in 4.3.3); **manufacture country**; **storage manufacturer** (added 4.3.3). (src: techspot.com)
- **Manufacture date / age in days** — decoded from the (old-format) serial number to show battery/device age; **FAQ note: for newer devices with Apple's randomized serial format, manufacture date can NOT be shown**. (src: coconut-flavour.com support FAQ, chriswrites.com)
- **Battery serial number** — shown in the **Device details / battery info** popover. (src: macworld.com)
- **Battery manufacturer / model** — shown in detailed/advanced battery info (e.g. cell vendor). (src: techspot "Model" = Apple identification string; observed in advanced details) — *flagged as detail-view field.*
- **"Device details" button** → popover with serial number, age in days, and current charger kind. (src: macworld.com)

## 3) POWER ADAPTER / CHARGER
All **[DISPLAY]**:
- **Power adapter connected?** (yes/no) and the **wattage at which power is transferring**. (src: macworld.com)
- **Adapter description / rated wattage** (e.g. "96W USB-C Power Adapter") and whether it's charging at its rated capacity. (src: search macworld/macrumors)
- **Current charger "kind"** shown in the Device-details popover. (src: macworld.com)
- Adapter serial/family/ID may appear in **Advanced details** (Plus). (src: coconut-flavour.com)

## 4) ADVANCED VIEWER / "Advanced details" — Plus only
All **[DISPLAY]**:
- **Internal SSD statistics**: data **read** and **write** totals (TBW-style), and other SMART-derived drive stats "depending on device". (src: coconut-flavour.com, softpedia, techspot)
- **USB device connection details** (added v4.1.0, Sept 2025). (src: search softpedia changelog)
- Extra low-level battery/SMC fields beyond the main gauges. (src: coconut-flavour.com)

## 5) BATTERY LIFETIME ANALYZER — Plus only
All **[DISPLAY]** — detailed lifetime aggregates:
- **Temperature**: maximum, minimum, average. (src: softpedia, coconut-flavour.com)
- **Voltage ranges** (min/max). (src: softpedia)
- **Charge / discharge rate ranges**. (src: softpedia)
- **Battery operating time** / total lifetime info. (src: softpedia)

## 6) CONNECTED iOS / iPadOS / iPod DEVICE (over USB; Wi-Fi = Plus)
All **[DISPLAY]** — same metric set as the Mac battery:
- **Current charge** (mAh + %), **Full charge capacity** (mAh), **Design capacity** (mAh), **health %**. (src: macworld.com)
- **Cycle count** for the iOS device. (src: search macworld)
- **Battery temperature**, **charging watts / power adapter** connected + wattage. (src: macworld.com, search)
- **Device details** popover: **serial number**, **age in days**, current charger kind, device model. (src: macworld.com)
- **Connection**: works over **USB** (free) or **Wi-Fi** (Plus — "no USB cable needed once Wi-Fi enabled"). (src: macworld.com, coconut-flavour.com)
- **Unlimited devices** = Plus; free tier limits number of tracked devices. (src: coconut-flavour.com)
- iOS device battery details can also be surfaced in the **menu-bar dropdown**. (src: macworld.com, coconut-flavour.com)

## 7) LOCAL HISTORY ("Save Battery Health Info") — History tab/Viewer
Mostly **[DISPLAY]**; the save action is **[CONFIG]**:
- **History tab**: click **"+"** to save a timestamped snapshot; **"–"** / right-click context-menu to delete an entry. (src: chriswrites.com, softpedia)
- Each saved record tracks over time: **device age**, **Health** (max % of design capacity), **charge cycle count**, capacity. (src: macworld.com)
- **Save Battery Health Info** = Plus feature (persisting long-term history, incl. for iOS devices). (src: coconut-flavour.com)

## 8) coconutBattery ONLINE (the online history / benchmarking service)
- **[CONFIG]** — opt-in upload: **anonymized battery information is sent to the coconutBattery server**; IP is anonymized; data auto-deleted after **365 days**; site uses **no cookies**; Matomo analytics anonymized. (src: coconut-flavour.com privacy/FAQ)
- **[DISPLAY]** comparison view: **compare your Mac's battery against other Macs of the same model**. Two graphs: (a) **battery capacity over time vs. the average of that model**, (b) **capacity relative to charge cycles**. Your own battery is drawn as a **dark-green line**; model-average shown for benchmarking. (src: chriswrites.com, coconut-flavour.com, search)

## 9) MENU-BAR PLUGIN behavior
- **[CONFIG]** Enable via Preferences → **General** tab → checkbox **"Run coconutBattery in background and show information in Menu Bar"** (also a manual "enable the menu bar" option added later). (src: switchingtomac.com, softpedia changelog)
- **[DISPLAY]** Default menu-bar text = **battery percentage**.
- **[CONFIG]** **Format** field: type/insert **placeholders**; an **icon next to the field reveals the list of parameters**. Available tokens include **percentage, time remaining / time-until-empty, charge cycles, watt usage, temperature, health, condition**. (src: switchingtomac.com, search)
- **[CONFIG]** **"Show charge icon"** checkbox → shows a battery glyph next to the chosen text. (src: switchingtomac.com)
- **[DISPLAY]** Clicking the menu-bar item opens a **dropdown** with expanded live info: time remaining, temperature, cycle count, and — optionally — **connected iOS/iPad device battery details** ("Mac Battery Details in Menu Bar" + "iPhone/iPad Battery Details in Menu Bar"). (src: switchingtomac.com, coconut-flavour.com)
- Menu-bar N/A-display bug history confirms it renders the live token even when detached (context). (src: softpedia changelog v4.0.4)

## 10) NOTIFICATIONS — Plus only
- **[DISPLAY]/[CONFIG]** macOS notifications for **battery percentage** thresholds and **remaining-time** alerts (i.e. low-battery / full-charge style alerts), configurable in settings. (src: techspot.com, coconut-flavour.com) — *Note: a generic search result attributed low/high threshold "sliders" to a different app (Battery Medic); coconutBattery's own docs describe percentage + time-remaining notification alerts.*

## 11) PRINTING / EXPORT — Plus only
- **[DISPLAY]/[CONFIG]** **Custom Printing Templates** — **HTML-based** report templates you can print/save. (src: coconut-flavour.com, techspot.com)

## 12) PREFERENCES / SETTINGS (app-level, all [CONFIG])
- **General**: run-in-background + menu-bar toggle; menu-bar **Format** string; **Show charge icon**. (src: switchingtomac.com)
- **Temperature unit** toggle **°C / °F**. (src: techspot.com)
- **Free trial**: "activate in app settings — allows starting coconutBattery **10 times in Plus-Mode**." (src: coconut-flavour.com FAQ)
- **License**: enter Plus license; coconutBattery 3 Plus licenses recognized in v4 (after a fix). (src: softpedia changelog)
- **Wi-Fi pairing** setup for iOS devices (Plus). (src: coconut-flavour.com)
- **Localization** incl. Chinese (4.3.3). (src: techspot.com)
- Distribution note: **only available via coconut-flavour.com**; Plus is **one-time purchase**. (src: coconut-flavour.com FAQ)

## 13) FREE vs PLUS matrix (for parity scoping)
- **Free**: Mac Battery Diagnostic; Mac Battery Details in Menu Bar; iPhone/iPad Battery Diagnostic (USB, limited # devices); iPhone/iPad Battery Details in Menu Bar; coconutBattery Online comparison. (src: coconut-flavour.com)
- **Plus** (one-time): **WiFi Support**; **Advanced Viewer (SSD stats etc.)**; **Save Battery Health Info** (history); **Custom Printing Templates**; **Notifications**; **Unlimited devices**; **Battery Lifetime Analyzer**. (src: coconut-flavour.com, techspot.com)

---

## MARKING SUMMARY
- **[DISPLAY]** (read-only, safe to implement, no privilege): every battery/SSD/adapter/device metric in sections 1-9, the online comparison graphs, menu-bar readout, and notification content. This is ~all of the app.
- **[CONFIG]** (app-level toggles, NOT hardware writes): run-in-background/menu-bar enable, Format string, Show-charge-icon, temperature unit, save-to-history, opt-in online upload, print, license/trial, Wi-Fi pairing.
- **[CONTROL]** (writes hardware / needs elevated privilege): **NONE.** coconutBattery has zero charge-limiting, SMC-write, or privileged control features.

## Notable gaps competitors call out
- No proactive alerts in the free version ("won't tell you anything unless you open it"); single-window UI; menu-bar customization via Format string is powerful but "not as easy" as rivals. (src: getjuicy.app)

## Sources
- Official product page — https://coconut-flavour.com/coconutbattery/
- Official support/FAQ + privacy — https://coconut-flavour.com/support/coconutbattery/
- Macworld review — https://www.macworld.com/article/542901/coconutbattery-review-mac-gems.html
- TechSpot download/feature list + 4.3.3 notes — https://www.techspot.com/downloads/6461-coconutbattery.html
- ChrisWrites walkthrough (field labels, History, Online) — https://www.chriswrites.com/how-to-check-the-health-of-your-macbook-battery-using-coconutbattery/
- switchingtomac (menu-bar Format field, Show charge icon, prefs) — https://www.switchingtomac.com/tutorials/how-to-show-battery-percentage-in-macos-big-sur/
- MacMenuBar listing — https://macmenubar.com/coconutbattery/
- Softpedia changelog (Lifetime Analyzer, SSD, menu-bar, USB details, license) — https://mac.softpedia.com/progChangelog/coconutBattery-Changelog-9183.html
- getjuicy review (free/Plus, pricing, gaps) — https://getjuicy.app/directory/mac-battery-apps/coconut-battery/
- trms.me walkthrough — https://trms.me/check-your-macs-battery-health-with-coconutbattery/
- MacRumors / Apple Discussions threads (condition, watts, capacity color) — forums.macrumors.com; discussions.apple.com

Note: coconutBattery is **closed-source** (no GitHub repo; the "coconutBattery-Mac-*" GitHub orgs in results are SEO/spam mirrors, not the real source), so field labels above are drawn from the official site, official FAQ, and hands-on reviews rather than source code. A handful of detail-view fields (battery manufacturer/model, adapter serial) are flagged where confidence is lower.