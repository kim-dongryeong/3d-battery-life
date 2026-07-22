// 충전기 별명(라벨) — 사용자가 지정한 modelKey → 별명 사전을 charger-labels.json(사용자 데이터
// 폴더, 개인 파일)에 보관한다. adapters.json과 같은 tmp+rename 최선노력 쓰기 관례를 따른다.
// 병합 로직(mergeLabel)만 순수함수로 분리 — 테스트는 tests/chargerLabels.test.js.
import fs from 'node:fs';
import path from 'node:path';
import { userDataDir } from './paths.js';

const fileOf = () => path.join(userDataDir(), 'charger-labels.json');

export function readLabels() {
  try { return JSON.parse(fs.readFileSync(fileOf(), 'utf8')); } catch { return {}; }
}

// 순수함수: 기존 사전에 하나를 병합한다. label이 빈 문자열/공백뿐이면 그 key를 삭제(별명 해제).
export function mergeLabel(labels, key, label) {
  const out = { ...labels };
  const trimmed = String(label ?? '').trim();
  if (trimmed) out[key] = trimmed;
  else delete out[key];
  return out;
}

export function writeLabels(labels) {
  const f = fileOf();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(labels, null, 1));
    fs.renameSync(tmp, f);
  } catch { /* best-effort — 잃어도 라벨 하나뿐, 다음 저장에서 재시도 */ }
}

// server.js가 쓰는 원샷 헬퍼: 읽기→병합→쓰기 후 최신 사전을 반환한다.
export function setLabel(key, label) {
  const labels = mergeLabel(readLabels(), key, label);
  writeLabels(labels);
  return labels;
}
