// 2D 연속 시간축(평면 보기)의 "시간 창" 상태 전이 — 순수 함수 모듈.
// 이 기능의 핵심 위험은 THREE가 아니라 창 상태 전이라서(Codex 리뷰), DOM/THREE 없이
// 여기서 분리해 node:test 로 검증한다 (tests/flatViewport.test.js).
// 규약: window 는 {t0, t1}(epoch 초) 또는 null(= 전체 기간). 모든 전이는 normalizeWindow 를
// 거쳐 "전체와 사실상 같은 창은 null" 로 정규화된다.

export const FUTURE_PAD = 24 * 3600;   // 미래(예상선) 쪽으로 팬 허용 여유
export const MIN_DUR = 600;            // 최소 창 폭 10분

// 전체 기간: 첫 샘플의 로컬 자정 ~ max(마지막 샘플, now)
export function span(report, now = Date.now() / 1000) {
  const d0 = new Date(((report && report.firstT) || now) * 1000);
  d0.setHours(0, 0, 0, 0);
  const min = d0.getTime() / 1000;
  const last = (report && report.latest && report.latest.t) || min + 86400;
  return { min, max: Math.max(last, now) };
}

// 후보 창을 [min, max+futurePad] 안으로, 폭은 [minDur, 전체+pad] 로 클램프.
// 전체를 (±1초 오차로) 덮으면 null 로 정규화 — "전체 보기"의 유일 표현.
export function normalizeWindow(cand, sp, minDur = MIN_DUR, futurePad = FUTURE_PAD) {
  if (!cand) return null;
  const hardMax = sp.max + futurePad;
  let dur = Math.max(minDur, Math.min(cand.t1 - cand.t0, hardMax - sp.min));
  let t0 = Math.max(sp.min, Math.min(cand.t0, hardMax - dur));
  const t1 = t0 + dur;
  if (t0 <= sp.min + 1 && t1 >= sp.max - 1) return null;
  return { t0, t1 };
}

const resolve = (win, sp) => win || { t0: sp.min, t1: sp.max };

// 커서(anchorT)가 가리키는 시간의 화면 X 비율을 유지하며 폭을 factor 배로.
export function zoomAt(win, sp, anchorT, factor, minDur = MIN_DUR, futurePad = FUTURE_PAD) {
  const { t0, t1 } = resolve(win, sp);
  const a = Math.max(t0, Math.min(anchorT, t1));
  const r = (a - t0) / (t1 - t0);
  const dur = (t1 - t0) * factor;
  return normalizeWindow({ t0: a - dur * r, t1: a + dur * (1 - r) }, sp, minDur, futurePad);
}

// 창 폭을 바꾸지 않고 평행 이동 (경계에서 클램프 — normalizeWindow 가 폭을 보존한다).
export function panBy(win, sp, dSec, minDur = MIN_DUR, futurePad = FUTURE_PAD) {
  const { t0, t1 } = resolve(win, sp);
  return normalizeWindow({ t0: t0 + dSec, t1: t1 + dSec }, sp, minDur, futurePad);
}

// 기간 프리셋: 'all' | '30d' | '7d' | '24h' | 'end'(현재 폭 유지, 최신 끝으로).
export function presetWindow(kind, win, sp, minDur = MIN_DUR, futurePad = FUTURE_PAD) {
  if (kind === 'all') return null;
  if (kind === 'end') {
    const { t0, t1 } = resolve(win, sp);
    return normalizeWindow({ t0: sp.max - (t1 - t0), t1: sp.max }, sp, minDur, futurePad);
  }
  const H = { '30d': 720, '7d': 168, '24h': 24 }[kind];
  if (!H) return win;
  return normalizeWindow({ t0: sp.max - H * 3600, t1: sp.max }, sp, minDur, futurePad);
}

// 새 report 도착: 이전에 끝(최신)을 보고 있었다면 폭을 유지한 채 새 끝을 따라간다.
// wasFollowing 은 fetch "이전" 창과 "이전" span 으로 판정해 둘 것 (P0-4: 판정을 늦게 하면
// 절전/네트워크 공백이 길 때 붙어 있던 창도 추적을 잃는다).
export function isFollowingEnd(win, sp, slack = 180) {
  return !win || win.t1 >= sp.max - slack;
}
// "지금" 기준 상대 위치를 보존하며 창을 시간과 함께 민다: Δ = 새 끝 − 이전 끝 만큼 평행이동.
// (끝점을 newSp.max 로 스냅하면, 미래 패드로 팬해 둔 창이 매 갱신마다 왼쪽으로 튄다 — kdr 발견)
export function followEnd(win, newSp, oldMax, minDur = MIN_DUR, futurePad = FUTURE_PAD) {
  if (!win) return null;   // 전체 보기는 그대로 전체
  const d = oldMax != null ? newSp.max - oldMax : newSp.max - win.t1;
  return normalizeWindow({ t0: win.t0 + d, t1: win.t1 + d }, newSp, minDur, futurePad);
}

// 달력 눈금 — DST 안전: 고정 86400초 증가 대신 Date 의 달력 연산(setMinutes/setDate)으로
// 로컬 자정·정시를 전진시킨다 (P1: DST 전환일은 하루가 23/25시간이라 +86400 이 자정을 1시간 벗어남).
// 두 단계 사다리: "라벨 눈금"은 ≤12개가 되는 가장 촘촘한 단계, "세부선(minor)"은 그보다 한 단계
// 이상 촘촘하면서 ≤64개 — 줌 정도에 따라 개수가 다이나믹하게 바뀌고, 라벨이 붙기 전에도
// 시각을 가늠할 세부선이 먼저 나타난다 (kdr: "시각이 나타나는 줌이 늦다").
// 반환: [{t, label|null, major}] — major=자정(날짜), label=null 은 선만 긋는 세부선.
const LADDER_MIN = [30, 60, 180, 360, 720, 1440, 2880, 4320, 10080, 21600, 43200, 129600];   // 30분…90일
export function calendarTicks(win, sp, locale = 'ko') {
  const { t0: w0, t1: w1 } = resolve(win, sp);
  const spanMin = (w1 - w0) / 60;
  const labeled = LADDER_MIN.find(s => spanMin / s <= 12) ?? LADDER_MIN[LADDER_MIN.length - 1];
  const finer = LADDER_MIN.filter(s => s < labeled && spanMin / s <= 64);
  const step = finer.length ? finer[finer.length - 1] : labeled;   // 세부선 단계 (없으면 라벨 단계)
  const dayFmt = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' });
  const hourFmt = new Intl.DateTimeFormat(locale, { hour: 'numeric' });
  const ticks = [];
  if (step < 1440) {
    // 하루 미만 단계: 로컬 자정 기준 "분 오프셋"이 step 배수인 지점 — 30분 격자로 달력 전진
    const d = new Date(w0 * 1000); d.setSeconds(0, 0);
    d.setMinutes(Math.floor(d.getMinutes() / 30) * 30);
    while (d.getTime() / 1000 <= w1) {
      const t = d.getTime() / 1000, mo = d.getHours() * 60 + d.getMinutes();
      if (t >= w0 && mo % step === 0) {
        const isLab = labeled >= 1440 ? mo === 0 : mo % labeled === 0;
        const mid = mo === 0;
        ticks.push({ t, label: isLab ? (mid ? dayFmt.format(d) : hourFmt.format(d)) : null, major: mid });
      }
      d.setMinutes(d.getMinutes() + 30);
    }
  } else {
    // 일 단위: 자정을 하루씩 전진, 고정 일번호(dayNo) 모듈로로 골라 팬해도 눈금이 안 튄다
    const stepD = Math.round(step / 1440), labD = Math.round(labeled / 1440);
    const d = new Date(w0 * 1000); d.setHours(0, 0, 0, 0);
    if (d.getTime() / 1000 < w0) d.setDate(d.getDate() + 1);
    while (d.getTime() / 1000 <= w1) {
      const t = d.getTime() / 1000, dayNo = Math.round(t / 86400);
      if (dayNo % stepD === 0) {
        const isLab = dayNo % labD === 0;
        ticks.push({ t, label: isLab ? dayFmt.format(d) : null, major: isLab });
      }
      d.setDate(d.getDate() + 1);
    }
  }
  return ticks;
}
