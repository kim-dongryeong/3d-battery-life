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
// 2026-07-22: "usb brick"·"미상" 추가 — web/main.js의 표시명 보강(chargerName())이 참조하는
// 일반명 판별과 목록을 맞췄다(그쪽은 브라우저 전용이라 이 파일을 import 못 해 사본을 둔다).
const GENERIC_NAME_RE = /^(pd charger|usb host|usb brick|usb-c|adapter|charger|unknown|미상)$/i;

// 연속 AC run(재협상 브리징·플러그 세션 귀속 공용) — ac=true가 지속되고 틱 간격이 180s 이하인 동안
// 같은 run으로 묶는다. samples 인덱스의 배열들을 반환(원본 미변형).
function computeRuns(samples) {
  const runs = [];
  let cur = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.ac !== true) { if (cur.length) runs.push(cur); cur = []; continue; }
    if (cur.length && s.t - samples[cur[cur.length - 1]].t > 180) { runs.push(cur); cur = []; }
    cur.push(i);
  }
  if (cur.length) runs.push(cur);
  return runs;
}

// 2026-07-22 kdr 요구 (1) 정체 브리징: 재협상 과도기에 ioreg가 한 틱만 정체(adapterName/adapterId)를
// 비우는 스냅샷(예: 7/17 08:34 — 전후 Apple 35W#28699, 그 사이 한 틱만 'pd charger'#0)을 상속으로
// 메운다. 같은 연속 AC run 안에서 이름이 일반명이거나 adapterId가 없는(0/null) 샘플을 찾아, 양옆
// (직전·직후) 3틱 내에 동일 Wnom·Vnom·familyCode + 구체 정체(이름·id)를 가진 이웃이 있으면 그 정체를
// 상속시킨다. 원본 samples 배열/원소는 변형하지 않고, 바뀐 원소만 얕은 복사로 교체한 새 배열을 반환.
function bridgeGenericIdentity(samples) {
  const runs = computeRuns(samples);
  const out = samples.slice();
  const isConcrete = s => s.adapterName && !GENERIC_NAME_RE.test(String(s.adapterName).trim()) && !!s.adapterId;
  for (const run of runs) {
    for (let ri = 0; ri < run.length; ri++) {
      const idx = run[ri];
      const s = out[idx];
      const nameGeneric = !s.adapterName || GENERIC_NAME_RE.test(String(s.adapterName).trim());
      const idMissing = !s.adapterId;
      if (!(nameGeneric || idMissing)) continue;                 // 이미 구체 정체 — 브리징 불필요
      if (s.adapterWnom == null || s.adapterVnom == null || !s.familyCode) continue;   // 매칭 기준 자체가 없음
      let donor = null;
      for (let off = 1; off <= 3 && !donor; off++) {
        for (const dir of [-1, 1]) {
          const ni = ri + off * dir;
          if (ni < 0 || ni >= run.length) continue;
          const ns = out[run[ni]];
          if (isConcrete(ns) && ns.adapterWnom === s.adapterWnom && ns.adapterVnom === s.adapterVnom && ns.familyCode === s.familyCode) {
            donor = ns; break;
          }
        }
      }
      if (donor) out[idx] = { ...s, adapterName: donor.adapterName, adapterId: donor.adapterId };
    }
  }
  return out;
}

// 최소 union-find(문자열 키). find()는 경로 압축.
class UnionFind {
  constructor() { this.parent = new Map(); }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let p = this.parent.get(x);
    if (p !== x) { p = this.find(p); this.parent.set(x, p); }
    return p;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// 2026-07-22 kdr 요구 (2) 플러그 세션 귀속: 같은 연속 AC run 안에서 등장한 chargerKey들은 같은
// 물리 충전기(듀얼포트 재협상·만충 등으로 계약만 바뀜)로 간주해 union-find로 연결한다. 단, run 안의
// 인접 샘플 사이에서 tech 또는 familyCode가 다르거나 둘 다 구체적인 이름이 서로 다르면(실제 충전기
// 교체 — 예: usb host 5V → PD 27W) 그 경계에서는 연결하지 않는다.
function buildSessionLinks(samples, runs) {
  const uf = new UnionFind();
  for (const run of runs) {
    for (let i = 1; i < run.length; i++) {
      const a = samples[run[i - 1]], b = samples[run[i]];
      const ka = chargerKey(a), kb = chargerKey(b);
      if (!ka || !kb || ka === kb) continue;
      const techA = a.familyCode ? adapterTech(a.familyCode) : null;
      const techB = b.familyCode ? adapterTech(b.familyCode) : null;
      const techDiffers = !!(techA && techB && techA !== techB);
      const famDiffers = !!(a.familyCode && b.familyCode && a.familyCode !== b.familyCode);
      const concreteA = a.adapterName && !GENERIC_NAME_RE.test(String(a.adapterName).trim());
      const concreteB = b.adapterName && !GENERIC_NAME_RE.test(String(b.adapterName).trim());
      const nameDiffers = !!(concreteA && concreteB && a.adapterName.trim() !== b.adapterName.trim());
      if (techDiffers || famDiffers || nameDiffers) continue;    // 경계 — 실제 충전기 교체로 판단, 연결 안 함
      uf.union(ka, kb);
    }
  }
  return uf;
}

const round5 = w => Math.round(w / 5) * 5;
// hvcMenu(충전기가 제공하는 PD 프로필 목록) 중 최대 W(v×a) — "이 메뉴로 낼 수 있는 최댓값".
function menuMaxW(menu) {
  if (!menu || !menu.length) return null;
  return Math.max(...menu.map(p => p.v * p.a));
}

// hvcMenu를 (v,a) 쌍 단위로 정규화·정렬해 직렬화한 "메뉴 지문" — 서로 다른 실물이 같은 최대 W로
// 반올림돼 오병합되는 걸 막는다(2026-07-22 kdr 실물 확인: 67W 보조배터리와 65W/45W 보조배터리는
// 서로 다른 실물인데, round5(67)=round5(65)=65라 예전엔 같은 클래스로 뭉쳤다). 소수 2자리 반올림은
// 부동소수 표현 노이즈 제거일 뿐, 값 자체를 뭉개는 반올림이 아니다 — 다른 프로필이면 여전히 다른 지문.
function menuFingerprint(menu) {
  if (!menu || !menu.length) return null;
  return menu.map(p => `${+p.v.toFixed(2)}x${+p.a.toFixed(2)}`).sort().join(',');
}

// 모델 그룹핑 키. 이름이 구체적이고(비-일반명) adapterId도 있으면 그것만으로 충분히 물리 충전기를
// 구분할 수 있다(예: "35W USB-C Power Adapter"+id 28699). 그렇지 않으면(이름이 일반명이거나
// adapterId가 없음/0) 같은 이름표를 쓰는 서로 다른 실물을 오인 병합하지 않도록 "정확한 메뉴 지문"
// (hvcMenu 그대로, 반올림 없음)을 덧붙인다 — 메뉴가 없으면 정격 W를 그대로 쓴다(역시 반올림 없음).
// 2026-07-22 kdr 실물 확인 이전엔 여기서 5W 단위로 반올림한 "전력 클래스(|cNN)"를 썼는데, 65W와
// 67W(서로 다른 실물!)가 같은 클래스로 오병합됐다. 이제 메뉴 지문이 다르면 이 키만으로는 절대 안
// 묶인다 — 같은 물리 충전기라면(재협상 등) buildSessionLinks()의 플러그 세션 증거로만 묶인다.
function modelKeyOf(row, adapters) {
  const { family, adapterId } = parseKeyIds(row.key);
  const name = row.name;
  let mk = `${family || '?'}#${adapterId || 0}|${name || '?'}`;
  const idMissing = !adapterId;                                    // 0/NaN/null 전부 "없음"
  const genericName = !name || GENERIC_NAME_RE.test(name.trim());
  if (idMissing || genericName) {
    const menu = adapters[row.key] && adapters[row.key].hvcMenu;
    const fp = menuFingerprint(menu);
    mk += fp != null ? `|m${fp}` : `|w${row.wattsNom != null ? row.wattsNom : 0}`;
  }
  return mk;
}

// 레거시(반올림 클래스) 모델 키 — 그룹핑엔 더 이상 쓰지 않는다. 오직 charger-labels.json 마이그레이션
// (reconcileLabels)에서 "이 옛 라벨 키가 가리켰던 원시 chargerKey 집합"을 되짚어보는 용도로만 남긴다.
function legacyModelKeyOf(row, adapters) {
  const { family, adapterId } = parseKeyIds(row.key);
  const name = row.name;
  let mk = `${family || '?'}#${adapterId || 0}|${name || '?'}`;
  const idMissing = !adapterId;
  const genericName = !name || GENERIC_NAME_RE.test((name || '').trim());
  if (idMissing || genericName) {
    const menu = adapters[row.key] && adapters[row.key].hvcMenu;
    const mx = menuMaxW(menu);
    const src = mx != null ? mx : (row.wattsNom != null ? row.wattsNom : 0);
    mk += `|c${round5(src)}`;
  }
  return mk;
}

// 모델 내에서 offeredMenu(풀 메뉴) 말고 관측된 "축소 메뉴"들 — 듀얼포트 어댑터가 다른 포트와
// 전력을 분배할 때 협상하는 메뉴들이다. offeredMenu와 같은 최대 W는 제외, 반올림해 중복 제거
// (같은 최대 W면 대표 메뉴 하나만), 내림차순. 메뉴가 한 종류뿐이면(=풀 메뉴만 관측) 빈 배열.
// 반환: [{maxW, menu:[{v,a,w}]}] — menu의 {v,a,w} 매핑은 pickOfferedMenu()와 같은 관례.
function pickMenuVariants(rows, adapters, offeredMaxW) {
  const offeredRounded = offeredMaxW != null ? Math.round(offeredMaxW) : null;
  const seen = new Map();   // roundedMaxW -> menu(대표 하나)
  for (const r of rows) {
    const menu = adapters[r.key] && adapters[r.key].hvcMenu;
    if (!menu || !menu.length) continue;
    const mx = menuMaxW(menu);
    if (mx == null) continue;
    const rounded = Math.round(mx);
    if (rounded === offeredRounded) continue;
    if (!seen.has(rounded)) {
      seen.set(rounded, menu.map(p => ({ v: p.v, a: p.a, w: Math.round(p.v * p.a) })));
    }
  }
  return [...seen.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([maxW, menu]) => ({ maxW, menu }));
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
  // ---- 전처리: (1) 정체 브리징 → (2) 플러그 세션(run) 단위 chargerKey 연결(union-find) ----
  samples = bridgeGenericIdentity(samples);          // 원본 배열/원소 미변형, 얕은 복사로 교체
  const runs = computeRuns(samples);
  const sessionUF = buildSessionLinks(samples, runs);

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
    const { wattsNom, voltsNom: keyV } = parseKeyRating(key);
    const meta = adapters[key] || null;
    // 표시용 협상 전압은 사전의 원값 우선 — 키는 안정성 위해 반올림하지만(20.3→"20V") 그대로
    // 보여주면 20.3V·3.3A(벤더 확장 단)와 20V·3.25A(표준 PD)가 같아 보인다(kdr 발견 2026-07-22).
    const voltsNom = (meta && meta.voltage != null) ? meta.voltage : keyV;
    const tech = (meta && meta.tech) || (acc.familyCode ? adapterTech(acc.familyCode) : null);
    const name = (meta && meta.name) || null;
    const manufacturer = (meta && meta.manufacturer) || null;
    const serial = (meta && meta.serial) || null;   // 충전기 개체(현물) 식별 증거 — (b)
    return {
      key, name, manufacturer, serial, tech, wattsNom, voltsNom,
      maxW: acc.maxW != null ? +acc.maxW.toFixed(2) : null,
      avgW: acc.wSec > 0 ? +(acc.wSum / acc.wSec).toFixed(2) : null,
      // 계약(chargerKey) 단위 실측 V/A — 모델 단위(macc)와 같은 시간가중 공식, 게이트만 이 acc로 국한.
      avgV: acc.vSec > 0 ? +(acc.vSum / acc.vSec).toFixed(1) : null,
      maxA: acc.maxA != null ? +acc.maxA.toFixed(2) : null,
      avgA: acc.aSec > 0 ? +(acc.aSum / acc.aSec).toFixed(2) : null,
      minutes: Math.round(acc.minSec / 60),
      energyWh: acc.wSec > 0 ? +(acc.wSum / 3600).toFixed(1) : null,
      firstSeen: acc.firstSeen,
      lastSeen: acc.lastSeen,
      isPowerBank: isPowerBank({ voltsNom, wattsNom, tech, name }),
      pairCount: acc.pairCount,
      acc,   // 모델 단위 재집계용 원시 누적치(응답엔 포함 안 됨)
    };
  });

  // ---- 세션 연결과 modelKeyOf 그룹핑 합성: 같은 run에서 이어진 chargerKey들의 modelKey를 하나로 묶는다 ----
  // (플러그 세션 연결이 modelKeyOf보다 우선 — 재협상으로 name/adapterId 클래스가 갈려도 같은 run이면 병합)
  const modelUF = new UnionFind();
  const modelKeyByChargerKey = new Map();
  for (const row of keyRows) modelKeyByChargerKey.set(row.key, modelKeyOf(row, adapters));
  const rootGroups = new Map();   // sessionUF root -> [chargerKey,...]
  for (const key of modelKeyByChargerKey.keys()) {
    const root = sessionUF.find(key);
    const arr = rootGroups.get(root) || []; arr.push(key); rootGroups.set(root, arr);
  }
  for (const arr of rootGroups.values()) {
    for (let i = 1; i < arr.length; i++) modelUF.union(modelKeyByChargerKey.get(arr[0]), modelKeyByChargerKey.get(arr[i]));
  }

  // ---- 모델(물리 충전기) 그룹핑: modelKey(세션 연결로 합성된)로 묶어 원시 누적치를 다시 풀링(시간가중 평균 재계산) ----
  const models = new Map();   // modelKey -> { rows: [계약 행], macc: 풀링된 누적치 }
  for (const row of keyRows) {
    const modelKey = modelUF.find(modelKeyOf(row, adapters));
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
    const serial = krows.map(r => r.serial).find(Boolean) || null;   // 있으면(대개 1개 계약만) 모델 행에 노출 — (b)
    const tech = krows.map(r => r.tech).find(Boolean) || null;
    const offeredMenu = pickOfferedMenu(krows, adapters);
    const offeredMaxW = offeredMenu ? Math.max(...offeredMenu.map(p => p.w)) : null;
    const menuVariants = pickMenuVariants(krows, adapters, offeredMaxW);
    const ratedFallback = Math.max(0, ...krows.map(r => r.wattsNom || 0)) || null;
    // 계약(chargerKey)별 실측 통계 — 모델 전체 실측 라인(아래 maxW/avgW/…)과 별개로, 어느 계약이
    // 얼마나 쓰였고 실제로 어떤 W/V/A를 냈는지 계약 단위로도 보여준다(V2.1: (1)).
    const profiles = krows
      .map(r => ({
        wnom: r.wattsNom, vnom: r.voltsNom, minutes: r.minutes, energyWh: r.energyWh,
        maxW: r.maxW, avgW: r.avgW, avgV: r.avgV, maxA: r.maxA, avgA: r.avgA,
        lastSeen: r.lastSeen,
      }))
      .sort((x, y) => y.minutes - x.minutes);
    return {
      modelKey, name, manufacturer, serial, tech,
      chargerKeys: krows.map(r => r.key),   // 이 모델을 구성하는 원시 chargerKey들 — 라벨 마이그레이션(reconcileLabels)이 참조
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
      menuVariants,
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

// 2026-07-22 kdr 요구 (3): modelKeyOf가 반올림 클래스 → 메뉴 지문으로 바뀌면서 charger-labels.json에
// 저장된 옛 modelKey(예: "e000400a#0|pd charger|c65")가 현재 모델 목록에 없는 "고아"가 될 수 있다.
// 순수함수: 고아 라벨마다, 그 옛 키가 legacyModelKeyOf() 기준으로 가리켰을 원시 chargerKey 집합을
// 오늘의 각 모델(chargers[].chargerKeys)에서 역산해 겹치는 개수를 센다. 겹침이 가장 많은 모델로
// 1회 마이그레이션(동점이면 그 모델 내 비중 — 겹침/모델 chargerKey 수 — 이 더 높은 쪽 우선: 예를
// 들어 67W 단독 모델은 겹침 1/1=100%인 반면 65W+45W 병합 모델은 겹침 1/2=50%라 전자가 이긴다).
// 겹침이 전부 0(애매)이면 그 라벨은 건드리지 않는다(유지만, 화면엔 안 보임 — 현재 모델에 없으므로).
// adapters: readAdapters() 사전(메뉴 조회용, modelKeyOf/legacyModelKeyOf와 동일 관례).
export function reconcileLabels(labels, chargers, adapters = {}) {
  const currentKeys = new Set(chargers.map(c => c.modelKey));
  const out = { ...labels };
  const migrations = [];
  for (const [oldKey, label] of Object.entries(labels)) {
    if (currentKeys.has(oldKey)) continue;   // 여전히 유효한 모델 — 손대지 않음
    let bestModelKey = null, bestOverlap = 0, bestFrac = -1;
    for (const c of chargers) {
      const keys = c.chargerKeys || [];
      if (!keys.length) continue;
      const overlap = keys.filter(k => {
        const { wattsNom } = parseKeyRating(k);
        return legacyModelKeyOf({ key: k, name: c.name, wattsNom }, adapters) === oldKey;
      }).length;
      if (overlap === 0) continue;
      const frac = overlap / keys.length;
      if (overlap > bestOverlap || (overlap === bestOverlap && frac > bestFrac)) {
        bestOverlap = overlap; bestFrac = frac; bestModelKey = c.modelKey;
      }
    }
    if (bestModelKey) {
      delete out[oldKey];
      out[bestModelKey] = label;
      migrations.push({ from: oldKey, to: bestModelKey, label });
    }
    // bestModelKey가 없으면(겹침 0) out엔 oldKey가 그대로 남는다 — 유지만, 미표시(현재 모델에 없으므로).
  }
  return { labels: out, migrations };
}
