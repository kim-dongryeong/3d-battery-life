// 충전기 사전 — 목격한 충전기 프로필을 adapters.json(사용자 데이터 폴더, 개인 파일)에 누적한다.
// chargerKey = "15W@5V/e0004009#10" (정격W @ 협상V / FamilyCode # AdapterID).
// Serial은 여전히 이 키에서는 제외 — 같은 모델 두 개를 구분할 실익이 낮다(계약 프로필로는 충분).
// kdr 결정 2026-07-22: 다만 충전기 "개체"(현물) 식별 증거로 serial·hwVersion·fwVersion·rawDetails
// (AdapterDetails 원문, 몇백 바이트)는 entry에 로컬 저장한다 — adapters.json은 로컬 전용 파일이라
// 프라이버시 무관.
import fs from 'node:fs';
import path from 'node:path';
import { userDataDir } from './paths.js';
import { adapterTech } from './battery.js';

// sample() 레코드(또는 같은 필드를 가진 객체)에서 지문을 만든다. 과거 데이터처럼 familyCode/
// adapterId가 없으면 부분 키("15W@5V/?#?")가 되어 클래스 분류까지만 쓰인다.
export function chargerKey(r) {
  if (!r || r.adapterWnom == null) return null;
  const v = r.adapterVnom != null ? String(Math.round(r.adapterVnom)) : '?';
  return `${r.adapterWnom}W@${v}V/${r.familyCode || '?'}#${r.adapterId ?? '?'}`;
}

const fileOf = () => path.join(userDataDir(), 'adapters.json');
export function readAdapters() {
  try { return JSON.parse(fs.readFileSync(fileOf(), 'utf8')); } catch { return {}; }
}

// Merge one observation. `rec` = a sample record (minute cadence — chargeMin += 1 while charging);
// `adp` = detail().adapter for the richer fields (name/manufacturer/hvcMenu), merged when given.
// Best-effort tmp+rename write — a lost update costs one minute of bookkeeping, never data.
export function upsertAdapter(rec, adp = null) {
  const key = chargerKey(rec);
  if (!key) return null;
  const all = readAdapters();
  const e = all[key] || { firstSeen: rec.t, chargeMin: 0 };
  e.lastSeen = rec.t;
  e.watts = rec.adapterWnom;
  if (rec.adapterVnom != null) e.voltage = rec.adapterVnom;
  if (rec.adapterAnom != null) e.current = rec.adapterAnom;
  if (rec.familyCode) { e.family = rec.familyCode; e.tech = adapterTech(rec.familyCode); }
  if (rec.adapterName && !e.name) e.name = rec.adapterName;
  if (adp) {
    if (adp.name) e.name = adp.name;
    if (adp.manufacturer) e.manufacturer = adp.manufacturer;
    if (adp.hvcMenu && adp.hvcMenu.length) e.hvcMenu = adp.hvcMenu;   // 충전기가 제공하는 PD 프로필 목록
    if (adp.serial) e.serial = adp.serial;
    if (adp.hwVersion) e.hwVersion = adp.hwVersion;
    if (adp.fwVersion) e.fwVersion = adp.fwVersion;
    if (adp.rawDetails) e.rawDetails = adp.rawDetails;   // 마지막 관측 원문으로 매번 갱신(증거 보존)
  }
  if (rec.charging) e.chargeMin = (e.chargeMin || 0) + 1;   // 분당 1회 호출 전제(sampler/cli 캐덴스)
  all[key] = e;
  try {
    const tmp = fileOf() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all, null, 1));
    fs.renameSync(tmp, fileOf());
  } catch { /* best-effort */ }
  return key;
}
