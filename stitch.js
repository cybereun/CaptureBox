'use strict';
// 스크롤 캡처용 이미지 이어붙이기. 프레임은 { data: BGRA Buffer, width, height }.

const MAX_HEIGHT = 30000; // Skia 이미지 한계보다 낮게

function sampleLayout(width) {
  const colStep = Math.max(1, Math.floor(width / 160));
  const cols = [];
  for (let x = 0; x < width; x += colStep) cols.push(x * 4);
  return cols;
}

// prev의 s행 이후와 next의 0행 이후를 비교한 평균 채널 차이 (early exit 지원)
function scoreShift(prev, next, s, rowCount, cols, limit) {
  const overlap = prev.height - s;
  const stride = prev.width * 4;
  const total = rowCount * cols.length * 3;
  const cap = limit * total;
  let sum = 0;
  for (let k = 0; k < rowCount; k++) {
    const nr = Math.floor((k * overlap) / rowCount);
    const pOff = (nr + s) * stride;
    const nOff = nr * stride;
    for (let c = 0; c < cols.length; c++) {
      const i = cols[c];
      sum += Math.abs(prev.data[pOff + i] - next.data[nOff + i]);
      sum += Math.abs(prev.data[pOff + i + 1] - next.data[nOff + i + 1]);
      sum += Math.abs(prev.data[pOff + i + 2] - next.data[nOff + i + 2]);
    }
    if (sum > cap) return Infinity;
  }
  return sum / total;
}

function findShift(prev, next, hint) {
  const h = prev.height;
  const cols = sampleLayout(prev.width);

  // 변화 없음 → 끝에 도달
  if (scoreShift(prev, next, 0, Math.min(h, 64), cols, 1.0) < 1.0) return { status: 'end' };

  const minOverlap = Math.max(16, Math.floor(h * 0.1));
  const rows = Math.min(48, minOverlap);
  let best = Infinity;
  let bestShift = -1;
  for (let s = 1; s <= h - minOverlap; s++) {
    const penalty = (0.3 * Math.abs(s - hint)) / h;
    const limit = best - penalty;
    if (limit <= 0) continue;
    const raw = scoreShift(prev, next, s, rows, cols, limit);
    if (raw === Infinity) continue;
    const score = raw + penalty;
    if (score < best) {
      best = score;
      bestShift = s;
    }
  }
  if (bestShift < 0 || best > 10) return { status: 'nomatch' };
  return { status: 'added', shift: bestShift, score: best };
}

class Stitcher {
  constructor(first) {
    this.width = first.width;
    this.height = first.height;
    this.last = first;
    this.parts = [first.data];
    this.totalHeight = first.height;
    this.hint = Math.floor(first.height * 0.6);
  }

  add(frame) {
    if (frame.width !== this.width || frame.height !== this.height) return { status: 'nomatch' };
    const r = findShift(this.last, frame, this.hint);
    if (r.status !== 'added') return r;
    if (this.totalHeight + r.shift > MAX_HEIGHT) return { status: 'limit' };
    const stride = this.width * 4;
    this.parts.push(frame.data.subarray((frame.height - r.shift) * stride));
    this.totalHeight += r.shift;
    this.last = frame;
    this.hint = r.shift;
    return r;
  }

  result() {
    return { data: Buffer.concat(this.parts), width: this.width, height: this.totalHeight };
  }
}

module.exports = { Stitcher, findShift };
