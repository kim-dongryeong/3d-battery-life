# Translations / 번역

The viewer speaks **Korean** by default and can be switched to any language a locale file exists for
(gear ⚙ → **언어 / Language**). Adding a language needs **no code** — just a JSON file.

## Add your language

1. **Copy** [`en.json`](en.json) to `web/locales/<code>.json`, where `<code>` is a BCP-47 code
   (`ja`, `zh`, `de`, `fr`, `es`, `pt-BR`, …).
2. **Translate every value.** The **key is the original Korean string** — leave keys unchanged and
   translate only the value after the colon:
   ```json
   "배터리 %": "Battery %",   ←  translate this  →   "배터리 %": "バッテリー %"
   ```
   Any key you omit (or leave in Korean) simply **falls back to Korean** — partial translations are fine.
3. **Register it** in [`index.json`](index.json):
   ```json
   [ { "code": "ko", "name": "한국어" },
     { "code": "en", "name": "English" },
     { "code": "ja", "name": "日本語" } ]
   ```
4. Reload, pick your language in the gear menu, and check it. Open a PR — that's it. 🎉

## How it works (for maintainers)

- `web/i18n.js` loads `/locales/<code>.json` (a flat `{ "한국어": "translation" }` dict) and, at page
  load, walks the text nodes and `title` attributes inside every `data-i18n` scope, swapping any
  **exact-match** Korean string for its translation. Language change persists to `localStorage` and reloads.
- **Static** viewer chrome (the right-hand control panel + header) is covered because it's marked
  `data-i18n`. **Dynamic** JS-rendered text (left HUD, buckets, tooltips) is opt-in: wrap the Korean
  string in `t('한국어')` (exported from `i18n.js`) and add the key to the locale files. Coverage grows
  incrementally — nothing breaks if a string isn't wrapped yet.
- To translate a new static block, add `data-i18n` to its container and add its strings to `en.json`
  (the canonical key list) so other languages can pick them up.
