// 내 충전기·보조배터리 통계 — samples.jsonl 전체를 충전기(chargerKey)별로 집계하는 순수함수.
// 서버 조립(캐시·API 응답 포장)은 server.js의 /api/chargers가 맡는다.
// 식별 키는 lib/adapters.js의 chargerKey 관례("15W@5V/e0004009#10")를 그대로 재사용한다.
import { chargerKey } from './adapters.js';
import { adapterTech } from './battery.js';

const NOISE_MIN = 10;   // 이 미만은 소음으로 드롭 — 단, 전부 드롭되면 최장 사용 1개는 남긴다(방금 산 충전기 혼란 방지)

// chargerKey 포맷("15W@5V/…")에서 wattsNom·voltsNom을 되뽑는다 — main.js chargerLabel()과 같은 관례.
// 'unknown'(어댑터 필드 없음)이면 매치되지 않아 둘 다 null.
function parseKeyRating(key) {
  const m = /^([\d.]+)W@(-?[\d.]+)V\//.exec(key || '');
  return m ? { wattsNom: +m[1], voltsNom: +m[2] } : { wattsNom: null, voltsNom: null };
}

// 보조배터리 휴리스틱: 5V·저전력(≤20W) 계약이거나 USB-C 5V(비-PD) 기술이거나 이름에 "power bank/보조 배터리"가 있으면.
function isPowerBank({ voltsNom, wattsNom, tech, name }) {
  return (voltsNom === 5 && wattsNom != null && wattsNom <= 20)
    || tech === 'usbc-5v'
    || /power\s*bank|보조\s*배터리/i.test(name || '');
}

// samples: readSource('real')의 정렬된(오름차순 t) 레코드 배열. adapters: readAdapters()의 사전(이름·제조사 보강용).
export function aggregateChargers(samples, adapters = {}) {
  const buckets = new Map();   // key -> accumulator
  const mk = () => ({ minSec: 0, wSec: 0, wSum: 0, maxW: null, firstSeen: null, lastSeen: null, pairCount: 0, familyCode: null });

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
  }

  // ---- 레거시 부분 키 병합: "15W@5V/?#?"는 같은 프리픽스의 완전 키가 정확히 1개일 때만 그 키로 흡수 ----
  for (const pk of [...buckets.keys()]) {
    if (!pk.endsWith('/?#?')) continue;
    const acc = buckets.get(pk);
    const prefix = pk.slice(0, -'/?#?'.length);              // "15W@5V"
    const candidates = [...buckets.keys()].filter(k => k !== pk && k.startsWith(prefix + '/') && !k.endsWith('/?#?'));
    if (candidates.length !== 1) continue;                   // 후보 0개/2개 이상이면 병합하지 않고 별도 행 유지
    const full = buckets.get(candidates[0]);
    full.minSec += acc.minSec; full.wSec += acc.wSec; full.wSum += acc.wSum; full.pairCount += acc.pairCount;
    if (acc.maxW != null) full.maxW = full.maxW == null ? acc.maxW : Math.max(full.maxW, acc.maxW);
    full.firstSeen = Math.min(full.firstSeen, acc.firstSeen);
    full.lastSeen = Math.max(full.lastSeen, acc.lastSeen);
    buckets.delete(pk);
  }

  let rows = [...buckets.entries()].map(([key, acc]) => {
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
    };
  });

  // ---- 노이즈 드롭: minutes<10 제외, 단 전부 드롭되면 가장 오래 쓴 1개는 유지 ----
  const kept = rows.filter(r => r.minutes >= NOISE_MIN);
  if (!kept.length && rows.length) rows = [rows.reduce((a, b) => (b.minutes > a.minutes ? b : a))];
  else rows = kept;

  // 정렬은 클라이언트 몫 — 여기선 키 사전순으로만 결정성 보장
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows;
}
