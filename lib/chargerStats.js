// 내 충전기·보조배터리 통계 — samples.jsonl 전체를 물리 충전기(모델) 단위로 집계하는 순수함수.
// 서버 조립(캐시·API 응답 포장)은 server.js의 /api/chargers가 맡는다.
// 식별 키는 lib/adapters.js의 chargerKey 관례("15W@5V/e0004009#10")를 그대로 재사용한다.
//
// 스키마 v2: 협상 계약(chargerKey) 하나가 아니라 "물리 충전기 1개 = 행 1개"로 묶는다. 듀얼포트
// 어댑터(예: Apple 35W)는 다른 포트의 부하에 따라 전력을 재협상해 35W@20V·27W@20V·17W@20V처럼
// 여러 chargerKey로 갈라지므로, 그대로 두면 같은 물리 충전기가 여러 행으로 쪼개져 보인다.
// → 1) chargerKey별로 먼저 원본 집계(예전과 동일한 로직) → 2) 레거시 부분키 병합(예전과 동일,
//   모델 그룹핑 "이전" 단계) → 3) modelKey로 묶어 모델 행 산출(신규) → 4) 모델 단위로 노이즈 드롭.
import { chargerKey } from './adapters.js';
import { adapterTech } from './battery.js';

const NOISE_MIN = 10;   // 이 미만은 소음으로 드롭 — 단, 전부 드롭되면 최장 사용 1개는 남긴다(방금 산 충전기 혼란 방지). v2부터 "모델 행" 레벨에 적용.

// chargerKey 포맷("15W@5V/…")에서 wattsNom·voltsNom을 되뽑는다 — main.js chargerLabel()과 같은 관례.
// 'unknown'(어댑터 필드 없음)이면 매치되지 않아 둘 다 null.
function parseKeyRating(key) {
  const m = /^([\d.]+)W@(-?[\d.]+)V\//.exec(key || '');
  return m ? { wattsNom: +m[1], voltsNom: +m[2] } : { wattsNom: null, voltsNom: null };
}

// chargerKey 포맷에서 family(FamilyCode)·adapterId를 되뽑는다. 'unknown'이거나 형식이 안 맞으면 둘 다 null.
// 레거시 부분키("15W@5V/?#?")처럼 '?'인 필드도 null(= 정보 없음)로 취급한다.
function parseKeyIds(key) {
  if (!key || key === 'unknown') return { family: null, adapterId: null };
  const m = /\/([^#]+)#(.+)$/.exec(key);
  if (!m) return { family: null, adapterId: null };
  const family = m[1] === '?' ? null : m[1];
  const idNum = m[2] === '?' ? NaN : Number(m[2]);
  return { family, adapterId: Number.isFinite(idNum) ? idNum : null };
}

// 보조배터리 휴리스틱: 5V·저전력(≤20W) 계약이거나 USB-C 5V(비-PD) 기술이거나 이름에 "power bank/보조 배터리"가 있으면.
function isPowerBank({ voltsNom, wattsNom, tech, name }) {
  return (voltsNom === 5 && wattsNom != null && wattsNom <= 20)
    || tech === 'usbc-5v'
    || /power\s*bank|보조\s*배터리/i.test(name || '');
}

// macOS가 붙이는 자리표시자성 이름 — 물리적으로 다른 충전기라도 같은 문구를 쓸 수 있어 이름만으론
// 구분이 안 된다(예: 서드파티 PD 충전기 다수가 전부 "pd charger"). 이 경우 adapterId도 보통 0(미상)이라
// modelKey에 hvcMenu 기반 전력 클래스(|cNN)를 덧붙여 구분한다.
const GENERIC_NAME_RE = /^(pd charger|usb host|usb-c|adapter|charger|unknown)$/i;

const round5 = w => Math.round(w / 5) * 5;
// hvcMenu(충전기가 제공하는 PD 프로필 목록) 중 최대 W(v×a) — "이 메뉴로 낼 수 있는 최댓값".
function menuMaxW(menu) {
  if (!menu || !menu.length) return null;
  return Math.max(...menu.map(p => p.v * p.a));
}

// 모델 그룹핑 키. 이름이 구체적이고(비-일반명) adapterId도 있으면 그것만으로 충분히 물리 충전기를
// 구분할 수 있다(예: "35W USB-C Power Adapter"+id 28699). 그렇지 않으면(이름이 일반명이거나
// adapterId가 없음/0) 같은 이름표를 쓰는 서로 다른 실물을 오인 병합하지 않도록 hvcMenu 최대 W를
// 5W 단위로 반올림한 "전력 클래스"를 덧붙인다 — 65W와 67W(협상 오차)는 같은 클래스(65)로 합치되
// 90W·45W·20W처럼 명백히 다른 정격은 갈라둔다.
function modelKeyOf(row, adapters) {
  const { family, adapterId } = parseKeyIds(row.key);
  const name = row.name;
  let mk = `${family || '?'}#${adapterId || 0}|${name || '?'}`;
  const idMissing = !adapterId;                                    // 0/NaN/null 전부 "없음"
  const genericName = !name || GENERIC_NAME_RE.test(name.trim());
  if (idMissing || genericName) {
    const menu = adapters[row.key] && adapters[row.key].hvcMenu;
    const mx = menuMaxW(menu);
    const src = mx != null ? mx : (row.wattsNom != null ? row.wattsNom : 0);   // 메뉴 없으면 정격 W 사용
    mk += `|c${round5(src)}`;
  }
  return mk;
}

// 모델 내 여러 chargerKey가 서로 다른 이름을 가진 드문 경우, 일반명보다 구체적인 이름을 우선한다.
function pickName(rows) {
  const specific = rows.find(r => r.name && !GENERIC_NAME_RE.test(r.name.trim()));
  if (specific) return specific.name;
  const named = rows.find(r => r.name);
  return named ? named.name : null;
}

// 모델 내 각 chargerKey의 hvcMenu 중 "총 최대 W가 가장 큰 메뉴" = 그 포트를 단독 사용할 때의 풀 메뉴.
// (듀얼포트 어댑터는 다른 포트가 물려 있을 때 축소된 메뉴를 협상하므로, 축소판이 아니라 풀 메뉴를 보여준다.)
function pickOfferedMenu(rows, adapters) {
  let best = null, bestMax = -1;
  for (const r of rows) {
    const menu = adapters[r.key] && adapters[r.key].hvcMenu;
    if (!menu || !menu.length) continue;
    const mx = menuMaxW(menu);
    if (mx > bestMax) { bestMax = mx; best = menu; }
  }
  return best ? best.map(p => ({ v: p.v, a: p.a, w: Math.round(p.v * p.a) })) : null;
}

// samples: readSource('real')의 정렬된(오름차순 t) 레코드 배열. adapters: readAdapters()의 사전(이름·제조사·hvcMenu 보강용).
export function aggregateChargers(samples, adapters = {}) {
  const buckets = new Map();   // chargerKey -> 원시 누적치(계약 단위, 아직 모델로 안 묶임)
  const mk = () => ({
    minSec: 0, wSec: 0, wSum: 0, maxW: null,
    vSec: 0, vSum: 0, aSec: 0, aSum: 0, maxA: null,   // 실측 V/A(dcInV/dcInA) 누적 — W와 별도 게이트
    firstSeen: null, lastSeen: null, pairCount: 0, familyCode: null,
  });

  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const dt = b.t - a.t;
    if (!(dt > 0) || dt > 3600) continue;                  // 중복 타임스탬프·sleep 공백 쌍 제외
    if (a.ac !== true || b.ac !== true) continue;           // 둘 다 AC 연결 중일 때만(충전 여부는 안 따짐 — 사용 통계이지 충전 통계가 아님)
    const ka = chargerKey(a), kb = chargerKey(b);
    if (ka !== kb) continue;                                // 충전기 전환 경계 쌍은 어느 쪽에도 귀속하지 않음
    const pk = ka || 'unknown';                              // ac인데 adapterWnom 없음(이름 없는 어댑터) → 단일 'unknown' 버킷
    const acc = buckets.get(pk) || mk(); buckets.set(pk, acc);

    acc.minSec += dt; acc.pairCount++;
    acc.firstSeen = acc.firstSeen == null ? a.t : Math.min(acc.firstSeen, a.t);
    acc.lastSeen = acc.lastSeen == null ? b.t : Math.max(acc.lastSeen, b.t);
    if (!acc.familyCode && a.familyCode) acc.familyCode = a.familyCode;

    // 실측 W(SMC adapterW)는 앱 실행 중에만 존재 — 두 샘플 다 있을 때만 사다리꼴 적분·최대값에 반영.
    // 한쪽만 있거나 둘 다 없으면 이 쌍은 minutes만 기여하고 maxW/avgW/energyWh엔 미기여(정격으로 대체 추정 안 함).
    if (a.adapterW != null && b.adapterW != null) {
      const wAvg = (a.adapterW + b.adapterW) / 2;
      acc.wSec += dt; acc.wSum += wAvg * dt;                 // wSum(W·sec) → /wSec = 시간가중 평균, /3600 = Wh
      const pairMax = Math.max(a.adapterW, b.adapterW);
      acc.maxW = acc.maxW == null ? pairMax : Math.max(acc.maxW, pairMax);
    }
    // 실측 V/A(SMC dcInV/dcInA)도 같은 쌍 귀속 규칙 위에서, 둘 다 있는 쌍만 기여(W와 독립 게이트).
    if (a.dcInV != null && a.dcInA != null && b.dcInV != null && b.dcInA != null) {
      const vAvg = (a.dcInV + b.dcInV) / 2;
      acc.vSec += dt; acc.vSum += vAvg * dt;
      const aAbsA = Math.abs(a.dcInA), aAbsB = Math.abs(b.dcInA);
      const aAvg = (aAbsA + aAbsB) / 2;
      acc.aSec += dt; acc.aSum += aAvg * dt;
      const pairMaxA = Math.max(aAbsA, aAbsB);
      acc.maxA = acc.maxA == null ? pairMaxA : Math.max(acc.maxA, pairMaxA);
    }
  }

  // ---- 레거시 부분 키 병합(모델 그룹핑 이전 단계): "15W@5V/?#?"는 같은 프리픽스의 완전 키가 정확히 1개일 때만 그 키로 흡수 ----
  for (const pk of [...buckets.keys()]) {
    if (!pk.endsWith('/?#?')) continue;
    const acc = buckets.get(pk);
    const prefix = pk.slice(0, -'/?#?'.length);              // "15W@5V"
    const candidates = [...buckets.keys()].filter(k => k !== pk && k.startsWith(prefix + '/') && !k.endsWith('/?#?'));
    if (candidates.length !== 1) continue;                   // 후보 0개/2개 이상이면 병합하지 않고 별도 행 유지
    const full = buckets.get(candidates[0]);
    full.minSec += acc.minSec; full.wSec += acc.wSec; full.wSum += acc.wSum; full.pairCount += acc.pairCount;
    if (acc.maxW != null) full.maxW = full.maxW == null ? acc.maxW : Math.max(full.maxW, acc.maxW);
    full.vSec += acc.vSec; full.vSum += acc.vSum; full.aSec += acc.aSec; full.aSum += acc.aSum;
    if (acc.maxA != null) full.maxA = full.maxA == null ? acc.maxA : Math.max(full.maxA, acc.maxA);
    full.firstSeen = Math.min(full.firstSeen, acc.firstSeen);
    full.lastSeen = Math.max(full.lastSeen, acc.lastSeen);
    buckets.delete(pk);
  }

  // ---- 계약(chargerKey) 단위 행 산출 — 여기선 노이즈 드롭 안 함(모델이 살아있으면 1분짜리 계약도 표시) ----
  const keyRows = [...buckets.entries()].map(([key, acc]) => {
    const { wattsNom, voltsNom } = parseKeyRating(key);
    const meta = adapters[key] || null;
    const tech = (meta && meta.tech) || (acc.familyCode ? adapterTech(acc.familyCode) : null);
    const name = (meta && meta.name) || null;
    const manufacturer = (meta && meta.manufacturer) || null;
    return {
      key, name, manufacturer, tech, wattsNom, voltsNom,
      maxW: acc.maxW != null ? +acc.maxW.toFixed(2) : null,
      avgW: acc.wSec > 0 ? +(acc.wSum / acc.wSec).toFixed(2) : null,
      minutes: Math.round(acc.minSec / 60),
      energyWh: acc.wSec > 0 ? +(acc.wSum / 3600).toFixed(1) : null,
      firstSeen: acc.firstSeen,
      lastSeen: acc.lastSeen,
      isPowerBank: isPowerBank({ voltsNom, wattsNom, tech, name }),
      pairCount: acc.pairCount,
      acc,   // 모델 단위 재집계용 원시 누적치(응답엔 포함 안 됨)
    };
  });

  // ---- 모델(물리 충전기) 그룹핑: modelKey로 묶어 원시 누적치를 다시 풀링(시간가중 평균 재계산) ----
  const models = new Map();   // modelKey -> { rows: [계약 행], macc: 풀링된 누적치 }
  for (const row of keyRows) {
    const modelKey = modelKeyOf(row, adapters);
    let g = models.get(modelKey);
    if (!g) {
      g = { rows: [], macc: { minSec: 0, wSec: 0, wSum: 0, maxW: null, vSec: 0, vSum: 0, aSec: 0, aSum: 0, maxA: null, firstSeen: null, lastSeen: null, pairCount: 0 } };
      models.set(modelKey, g);
    }
    g.rows.push(row);
    const a = row.acc, m = g.macc;
    m.minSec += a.minSec; m.wSec += a.wSec; m.wSum += a.wSum; m.pairCount += a.pairCount;
    if (a.maxW != null) m.maxW = m.maxW == null ? a.maxW : Math.max(m.maxW, a.maxW);
    m.vSec += a.vSec; m.vSum += a.vSum; m.aSec += a.aSec; m.aSum += a.aSum;
    if (a.maxA != null) m.maxA = m.maxA == null ? a.maxA : Math.max(m.maxA, a.maxA);
    m.firstSeen = m.firstSeen == null ? a.firstSeen : Math.min(m.firstSeen, a.firstSeen);
    m.lastSeen = m.lastSeen == null ? a.lastSeen : Math.max(m.lastSeen, a.lastSeen);
  }

  let rows = [...models.entries()].map(([modelKey, { rows: krows, macc: m }]) => {
    const name = pickName(krows);
    const manufacturer = krows.map(r => r.manufacturer).find(Boolean) || null;
    const tech = krows.map(r => r.tech).find(Boolean) || null;
    const offeredMenu = pickOfferedMenu(krows, adapters);
    const offeredMaxW = offeredMenu ? Math.max(...offeredMenu.map(p => p.w)) : null;
    const ratedFallback = Math.max(0, ...krows.map(r => r.wattsNom || 0)) || null;
    const profiles = krows
      .map(r => ({ wnom: r.wattsNom, vnom: r.voltsNom, minutes: r.minutes, energyWh: r.energyWh, lastSeen: r.lastSeen }))
      .sort((x, y) => y.minutes - x.minutes);
    return {
      modelKey, name, manufacturer, tech,
      isPowerBank: krows.some(r => r.isPowerBank),
      ratedW: offeredMaxW != null ? offeredMaxW : ratedFallback,   // 바 트랙 기준값(정격 최대)
      maxW: m.maxW != null ? +m.maxW.toFixed(2) : null,
      avgW: m.wSec > 0 ? +(m.wSum / m.wSec).toFixed(2) : null,
      minutes: Math.round(m.minSec / 60),
      energyWh: m.wSec > 0 ? +(m.wSum / 3600).toFixed(1) : null,
      avgV: m.vSec > 0 ? +(m.vSum / m.vSec).toFixed(1) : null,
      maxA: m.maxA != null ? +m.maxA.toFixed(2) : null,
      avgA: m.aSec > 0 ? +(m.aSum / m.aSec).toFixed(2) : null,
      firstSeen: m.firstSeen,
      lastSeen: m.lastSeen,
      pairCount: m.pairCount,
      offeredMenu,
      profiles,
    };
  });

  // ---- 노이즈 드롭(모델 행 레벨): minutes<10 제외, 단 전부 드롭되면 가장 오래 쓴 1개는 유지 ----
  const kept = rows.filter(r => r.minutes >= NOISE_MIN);
  if (!kept.length && rows.length) rows = [rows.reduce((a, b) => (b.minutes > a.minutes ? b : a))];
  else rows = kept;

  // 정렬은 클라이언트 몫 — 여기선 키 사전순으로만 결정성 보장
  rows.sort((a, b) => (a.modelKey < b.modelKey ? -1 : a.modelKey > b.modelKey ? 1 : 0));
  return rows;
}
