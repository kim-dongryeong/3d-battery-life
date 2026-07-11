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
export function followEnd(win, newSp, minDur = MIN_DUR, futurePad = FUTURE_PAD) {
  if (!win) return null;   // 전체 보기는 그대로 전체
  return normalizeWindow({ t0: newSp.max - (win.t1 - win.t0), t1: newSp.max }, newSp, minDur, futurePad);
}

// 달력 눈금 — DST 안전: 고정 86400초 증가 대신 Date 의 달력 연산(setDate/setHours)으로
// 로컬 자정·정시를 전진시킨다 (P1: DST 전환일은 하루가 23/25시간이라 +86400 이 자정을 1시간 벗어남).
// 반환: [{t, label, major}] — major 는 자정(날짜 라벨).
export function calendarTicks(win, sp, locale = 'ko') {
  const { t0: w0, t1: w1 } = resolve(win, sp);
  const spanH = (w1 - w0) / 3600;
  const ticks = [];
  const dayFmt = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' });
  if (spanH <= 48) {
    const step = spanH <= 12 ? 1 : 3;   // 시간 간격
    const hourFmt = new Intl.DateTimeFormat(locale, { hour: 'numeric' });
    const d = new Date(w0 * 1000); d.setMinutes(0, 0, 0);
    while (d.getTime() / 1000 <= w1) {
      const t = d.getTime() / 1000;
      if (t >= w0 && d.getHours() % step === 0) {
        const mid = d.getHours() === 0;
        ticks.push({ t, label: mid ? dayFmt.format(d) : hourFmt.format(d), major: mid });
      }
      d.setHours(d.getHours() + 1);     // 달력 연산 — DST 경계에서도 로컬 정시 유지
    }
  } else {
    const days = Math.ceil(spanH / 24), stepD = Math.max(1, Math.ceil(days / 12));
    const d = new Date(w0 * 1000); d.setHours(0, 0, 0, 0);
    if (d.getTime() / 1000 < w0) d.setDate(d.getDate() + 1);   // 창 시작 이후의 첫 자정부터
    while (d.getTime() / 1000 <= w1) {
      ticks.push({ t: d.getTime() / 1000, label: dayFmt.format(d), major: true });
      d.setDate(d.getDate() + stepD);   // 달력 연산 (DST 안전)
    }
  }
  return ticks;
}
