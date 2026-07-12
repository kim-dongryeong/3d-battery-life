// 충전 통계 — 10% 밴드 × 충전기 프로필(chargerKey) + 계층 폴백 + 에너지 수지(energy-balance) ETA.
// 설계 문서: docs/plans/charger-aware-charge-projection.md
import { chargerKey } from './adapters.js';
import { adapterTech } from './battery.js';

// 클래스 = 기술 × 정격 W 밴드 — 프로필 표본이 모자랄 때의 1차 폴백 그룹
const W_BAND = w => w == null ? '?' : w <= 20 ? '≤20W' : w <= 45 ? '21–45W' : w <= 70 ? '46–70W' : '71W+';
export const classKey = r => `${(r && r.familyCode ? adapterTech(r.familyCode) : null) || '?'}:${W_BAND(r && r.adapterWnom)}`;

// ---- 밴드×프로필 누적 -------------------------------------------------------------------------
// PAIR 단위 귀속: 연속 두 샘플이 모두 충전 중이고 잔량이 올랐으면, 상승분을 걸친 10% 밴드들에
// 시간 비례로 배분한다(방전 bucketStats와 같은 수학). run 분할이 필요 없다 — 충전 중 어댑터를
// 바꾸면 그 쌍부터 새 프로필로 귀속될 뿐이다. onHold(최적화 충전 대기)는 charging=false라 자연 제외.
export function chargeStats(samples, level = 'rawcap') {
  const lvl = s => level === 'pct' ? s.pct : (s.rawMax > 0 && s.rawCap != null ? s.rawCap / s.rawMax * 100 : s.pct);
  const mk = () => Array.from({ length: 10 }, () => ({ rise: 0, sec: 0 }));
  const profiles = {}, classes = {}, global = mk();
  let sysWSum = 0, sysWSec = 0;   // 충전 중 시스템 전력의 시간가중 평균 — 물리 추정(정격 스케일링)의 기준값
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const dt = b.t - a.t;
    if (!(dt > 0) || dt > 3600) continue;                    // sleep/공백 쌍 제외
    if (!a.charging || !b.charging) continue;                // 충전 쌍만
    const la = lvl(a), lb = lvl(b);
    if (la == null || lb == null || lb <= la) continue;      // 상승만
    const pk = chargerKey(a) || 'unknown';                   // 과거 데이터(어댑터 필드 없음) → "unknown"
    const ck = classKey(a);
    profiles[pk] ??= mk(); classes[ck] ??= mk();
    if (a.systemW != null) { sysWSum += a.systemW * dt; sysWSec += dt; }
    for (let k = 0; k < 10; k++) {                           // band k = (10k, 10k+10]
      const bot = Math.max(la, 10 * k), top = Math.min(lb, 10 * k + 10);
      if (top <= bot) continue;
      const rise = top - bot, sec = dt * rise / (lb - la);
      for (const acc of [global, profiles[pk], classes[ck]]) { acc[k].rise += rise; acc[k].sec += sec; }
    }
  }
  const fin = acc => {
    const byBand = {}, secByBand = {};
    let totalSec = 0;
    acc.forEach((bnd, k) => {
      totalSec += bnd.sec;
      secByBand[10 * k + 10] = Math.round(bnd.sec);
      if (bnd.sec > 0 && bnd.rise > 0) byBand[10 * k + 10] = +(bnd.rise / (bnd.sec / 60)).toFixed(4);   // %/min
    });
    return { byBand, secByBand, totalMin: Math.round(totalSec / 60) };
  };
  const mapFin = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fin(v)]));
  return { profiles: mapFin(profiles), classes: mapFin(classes), global: fin(global),
    avgSysChargeW: sysWSec > 0 ? +(sysWSum / sysWSec).toFixed(2) : null };
}

// ---- 계층 폴백 --------------------------------------------------------------------------------
// 밴드별로 ① 이 충전기 프로필 → ①′ 레거시 부분 키(어댑터 필드 기록 전의 같은 충전기: 정격·전압이
// 같으면 "15W@5V/?#?" 꼴 — 새 완전 지문과 이력이 끊기는 문제를 잇는다) → ② 같은 클래스 → ③ 전체
// pooled 순서로, 표본 시간이 MIN_SEC 이상인 첫 계층을 쓴다.
// 반환: { byBand: {band: rate}, tierByBand, tier(지배적 계층), totalMin(프로필+레거시 이력) }
export function ratesWithFallback(stats, key, cls, minSec = 480) {
  // "30W@20V/e000400a#7" → 레거시 "30W@20V/?#?" (자기 자신이 부분 키면 중복 계층 생략)
  const legacyKey = key && !key.endsWith('/?#?') ? key.replace(/\/[^/]*$/, '/?#?') : null;
  const tiers = [
    ['profile', key ? stats.profiles[key] : null],
    ['profile', legacyKey ? stats.profiles[legacyKey] : null],   // 같은 충전기의 과거(부분 키) 이력
    ['class', cls ? stats.classes[cls] : null],
    ['global', stats.global],
  ];
  const byBand = {}, tierByBand = {};
  const count = { profile: 0, class: 0, global: 0 };
  for (let band = 10; band <= 100; band += 10) {
    for (const [name, t] of tiers) {
      if (!t || t.byBand[band] == null) continue;
      const enough = name === 'global' ? t.secByBand[band] > 0 : t.secByBand[band] >= minSec;
      if (enough) { byBand[band] = t.byBand[band]; tierByBand[band] = name; count[name]++; break; }
    }
  }
  const tier = count.profile >= count.class && count.profile >= count.global ? 'profile'
    : count.class >= count.global ? 'class' : 'global';
  return { byBand, tierByBand, tier: Object.keys(byBand).length ? tier : null,
    totalMin: ((key && stats.profiles[key]) ? stats.profiles[key].totalMin : 0)
      + ((legacyKey && stats.profiles[legacyKey]) ? stats.profiles[legacyKey].totalMin : 0) };
}

// ---- 에너지 수지 ETA (kdr 제안, 2026-07-10) ----------------------------------------------------
// 잔여 에너지 E ÷ (어댑터 입력 − 시스템 전력)으로 완충 시간을 낸다. 시스템 전력은 "예상 시간만큼의
// 과거 평균"을 써야 자기일관적이므로, 후보 창들을 스캔해 |T − ETA(T)| 최소인 창을 고른다(고정점).
// 레짐: 어댑터 포화(실측≈정격, 작은 충전기) → 창 스캔 · 배터리 제한(큰 충전기) → 현재 수지 그대로.
// 유효 구간은 벌크(CC)뿐이므로 targetPct(기본 80)까지만 — CV 꼬리는 밴드 통계로 이어붙일 것.
const WINDOWS_H = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8];
const CHG_EFF = 0.92;   // 충전 효율(변환+발열 손실)
export function energyBalanceETA({ samples, live, targetPct = 80 }) {
  if (!live || !live.charging) return null;
  const rawCap = live.rawCap, rawMax = live.rawMax, V = live.voltage;
  const adpW = live.adapterW, sysW = live.systemW, wnom = live.adapterWnom;
  if (!(rawMax > 0) || rawCap == null || !(V > 0) || adpW == null || sysW == null) return null;
  const capTarget = rawMax * targetPct / 100;
  if (rawCap >= capTarget) return { minutes: 0, pBat: null, regime: null, window: null, feasible: true, targetPct };
  const eWh = (capTarget - rawCap) / 1000 * V / CHG_EFF;    // 남은 에너지(Wh, 효율 반영)
  const nowT = live.t ?? Math.round(Date.now() / 1000);
  const saturated = wnom != null && adpW >= wnom * 0.85;    // 어댑터가 정격 근처로 포화 → 부하가 배터리 몫을 잠식
  if (!saturated) {
    // 배터리 제한 레짐: 부하 변동은 어댑터 입력이 흡수 — 현재 수지(어댑터−시스템)가 곧 충전 전력
    const pBat = adpW - sysW;
    if (pBat <= 0.3) return { minutes: null, pBat: +pBat.toFixed(2), regime: 'battery-limited', window: null, feasible: false, targetPct };
    return { minutes: Math.round(eWh / pBat * 60), pBat: +pBat.toFixed(2), regime: 'battery-limited', window: null, feasible: true, targetPct };
  }
  // 어댑터 포화 레짐: P_bat(T) = 현재 입력 − avgSys(지난 T시간) → 자기일관 창 스캔
  const avgSys = hours => {
    const from = nowT - hours * 3600;
    let sum = 0, n = 0;
    for (let i = samples.length - 1; i >= 0; i--) {
      const s = samples[i];
      if (s.t < from) break;
      if (s.systemW != null) { sum += s.systemW; n++; }
    }
    return n >= hours * 30 ? sum / n : null;   // 창의 절반(분당 표본 기준) 미만 커버리지 → 무효
  };
  let best = null;
  for (const h of WINDOWS_H) {
    const sys = avgSys(h);
    if (sys == null) continue;
    const pBat = adpW - sys;
    const eta = pBat > 0.3 ? eWh / pBat * 60 : Infinity;    // 분
    const miss = Math.abs(h * 60 - eta);
    if (!best || miss < best.miss) best = { miss, h, pBat, eta, sys };
  }
  if (!best) {   // 시스템 전력 이력 부족 → 현재값으로 단순 계산
    const pBat = adpW - sysW;
    if (pBat <= 0.3) return { minutes: null, pBat: +pBat.toFixed(2), regime: 'adapter-limited', window: null, feasible: false, targetPct };
    return { minutes: Math.round(eWh / pBat * 60), pBat: +pBat.toFixed(2), regime: 'adapter-limited', window: null, feasible: true, targetPct };
  }
  if (!Number.isFinite(best.eta)) {
    return { minutes: null, pBat: +best.pBat.toFixed(2), regime: 'adapter-limited', window: best.h, feasible: false, targetPct };
  }
  return { minutes: Math.round(best.eta), pBat: +best.pBat.toFixed(2), regime: 'adapter-limited',
    window: best.h, avgSysW: +best.sys.toFixed(2), feasible: true, targetPct };
}
