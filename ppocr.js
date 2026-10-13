'use strict';
/*
 * 정밀 글자 인식: PP-OCRv5 한국어(검출 DBNet + 인식 SVTR/CTC)를 ONNX Runtime(CPU)으로 돌린다. 줄 단위 결과를 낸다.
 *
 * 추론 방식과 전·후처리 값은 kordoc(MIT, https://github.com/chrisryugj/kordoc)의 src/ocr 을 참고해
 * 화면 캡처용으로 가볍게 다시 쓴 것이다 (문서 스캔용 보정 — 기울기, 목차 리더, 괘선 표 — 은 뺐다).
 * 모델은 PaddlePaddle 공식 PP-OCRv5 (Apache-2.0)의 ONNX 변환본이다. 자세한 출처는 THIRD_PARTY.md.
 *
 * 이미지 디코딩 라이브러리 없이 동작하도록 리사이즈는 직접 구현했다(OpenCV INTER_LINEAR 와 같은 반픽셀 중심 이중선형).
 */
const fs = require('fs');
const path = require('path');

const REC_H = 48;
const REC_MIN_W = 320;
const REC_MAX_W = 3200;
const DET_MIN = 3;
const DET_MAX_BOXES = 3000;
const DET_MEAN = [0.485, 0.456, 0.406];   // 모델 입력 순서: B, G, R
const DET_STD = [0.229, 0.224, 0.225];
const TUNE = { detThresh: 0.3, detBoxThresh: 0.6, unclip: 1.5, textScore: 0.5, minContrast: 25 };

/** inference.yml 의 character_dict 목록. CTC 클래스: 0=blank, 1..N=사전, N+1=공백 */
function parseCharacterDict(yml) {
  const chars = [];
  let inDict = false;
  let indent = -1;
  for (const line of yml.split('\n')) {
    if (!inDict) {
      const m = /^(\s*)character_dict:\s*$/.exec(line);
      if (m) { inDict = true; indent = m[1].length; }
      continue;
    }
    const m = /^(\s*)- (.*)$/.exec(line.replace(/\r$/, ''));
    if (m && m[1].length >= indent) {
      let v = m[2];
      if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) v = v.slice(1, -1).replace(/''/g, "'");
      chars.push(v);
      continue;
    }
    if (line.trim() !== '') break;
  }
  return chars;
}

/** 4채널 버퍼를 RGBA 로 맞춘다 (nativeImage.toBitmap 은 BGRA) */
function toRgba(data, bgra) {
  if (!bgra) return data;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) { out[i] = data[i + 2]; out[i + 1] = data[i + 1]; out[i + 2] = data[i]; out[i + 3] = data[i + 3]; }
  return out;
}

/** RGBA → 크기 변경된 RGB (이중선형, 반픽셀 중심) */
function resizeRgb(rgba, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 3);
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    let sy = (y + 0.5) * fy - 0.5; if (sy < 0) sy = 0;
    const y0 = Math.min(sh - 1, Math.floor(sy)), y1 = Math.min(sh - 1, y0 + 1), wy = sy - y0;
    for (let x = 0; x < dw; x++) {
      let sx = (x + 0.5) * fx - 0.5; if (sx < 0) sx = 0;
      const x0 = Math.min(sw - 1, Math.floor(sx)), x1 = Math.min(sw - 1, x0 + 1), wx = sx - x0;
      const a = (y0 * sw + x0) * 4, b = (y0 * sw + x1) * 4, c = (y1 * sw + x0) * 4, d = (y1 * sw + x1) * 4;
      const o = (y * dw + x) * 3;
      for (let k = 0; k < 3; k++) {
        const top = rgba[a + k] * (1 - wx) + rgba[b + k] * wx;
        const bot = rgba[c + k] * (1 - wx) + rgba[d + k] * wx;
        out[o + k] = Math.round(top * (1 - wy) + bot * wy);
      }
    }
  }
  return out;
}

/** 확률맵을 이진화해 4-연결 성분의 외접 사각형을 구한다 */
function componentBoxes(prob, w, h, thresh, boxThresh) {
  const visited = new Uint8Array(w * h);
  const boxes = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (visited[start] || prob[start] <= thresh) continue;
    let x1 = start % w, x2 = x1, y1 = (start / w) | 0, y2 = y1, sum = 0, count = 0;
    stack.length = 0; stack.push(start); visited[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      const px = p % w, py = (p / w) | 0;
      sum += prob[p]; count++;
      if (px < x1) x1 = px; if (px > x2) x2 = px; if (py < y1) y1 = py; if (py > y2) y2 = py;
      if (px > 0 && !visited[p - 1] && prob[p - 1] > thresh) { visited[p - 1] = 1; stack.push(p - 1); }
      if (px < w - 1 && !visited[p + 1] && prob[p + 1] > thresh) { visited[p + 1] = 1; stack.push(p + 1); }
      if (py > 0 && !visited[p - w] && prob[p - w] > thresh) { visited[p - w] = 1; stack.push(p - w); }
      if (py < h - 1 && !visited[p + w] && prob[p + w] > thresh) { visited[p + w] = 1; stack.push(p + w); }
    }
    if (x2 - x1 + 1 < DET_MIN && y2 - y1 + 1 < DET_MIN) continue;
    boxes.push({ x1, y1, x2, y2, score: sum / count });
  }
  return boxes.filter((b) => b.score >= boxThresh).sort((a, b) => (a.y1 - b.y1) || (a.x1 - b.x1));
}

/** CTC greedy 디코딩: 연속 중복 붕괴 → blank 제거 → 사전 매핑. 신뢰도는 선택된 글자들의 평균 확률 */
function ctcDecode(data, T, C, dict) {
  let text = '', sum = 0, n = 0, prev = -1;
  for (let t = 0; t < T; t++) {
    const off = t * C;
    let best = 0, bv = data[off];
    for (let c = 1; c < C; c++) { const v = data[off + c]; if (v > bv) { bv = v; best = c; } }
    const repeat = best === prev;
    prev = best;
    if (best === 0 || repeat) continue;
    let p = bv;
    if (p > 1.0001 || p < 0) { let den = 0; for (let c = 0; c < C; c++) den += Math.exp(data[off + c] - bv); p = 1 / den; }
    sum += p; n++;
    text += best >= 1 && best <= dict.length ? dict[best - 1] : best === dict.length + 1 ? ' ' : '';
  }
  return text ? { text, confidence: n ? sum / n : 0 } : null;
}

/** 박스를 높이 48 로 맞춘 RGB 로 잘라낸다 (폭은 비율 유지) */
function lineCrop(rgba, pageW, box) {
  const rw = Math.min(REC_MAX_W, Math.max(16, Math.round((box.w * REC_H) / box.h)));
  const rgb = new Uint8Array(rw * REC_H * 3);
  const fx = box.w / rw, fy = box.h / REC_H;
  for (let dy = 0; dy < REC_H; dy++) {
    let sy = (dy + 0.5) * fy - 0.5; if (sy < 0) sy = 0;
    const y0 = Math.min(box.h - 1, Math.floor(sy)), y1 = Math.min(box.h - 1, y0 + 1), wy = sy - y0;
    for (let dx = 0; dx < rw; dx++) {
      let sx = (dx + 0.5) * fx - 0.5; if (sx < 0) sx = 0;
      const x0 = Math.min(box.w - 1, Math.floor(sx)), x1 = Math.min(box.w - 1, x0 + 1), wx = sx - x0;
      const a = ((box.y + y0) * pageW + box.x + x0) * 4, b = ((box.y + y0) * pageW + box.x + x1) * 4;
      const c = ((box.y + y1) * pageW + box.x + x0) * 4, d = ((box.y + y1) * pageW + box.x + x1) * 4;
      const o = (dy * rw + dx) * 3;
      for (let k = 0; k < 3; k++) {
        const top = rgba[a + k] * (1 - wx) + rgba[b + k] * wx;
        const bot = rgba[c + k] * (1 - wx) + rgba[d + k] * wx;
        rgb[o + k] = Math.round(top * (1 - wy) + bot * wy);
      }
    }
  }
  return { rgb, w: rw };
}

/** 박스 안 밝기 대비(전경/배경 차). 대비가 너무 낮은 박스는 글자가 아니라 배경 무늬다 */
function boxContrast(rgba, pageW, box) {
  let min = 255, max = 0;
  const sx = Math.max(1, Math.floor(box.w / 64)), sy = Math.max(1, Math.floor(box.h / 16));
  for (let y = box.y; y < box.y + box.h; y += sy) {
    for (let x = box.x; x < box.x + box.w; x += sx) {
      const o = (y * pageW + x) * 4;
      const g = (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
      if (g < min) min = g; if (g > max) max = g;
    }
  }
  return max - min;
}

/** 검출된 조각들을 읽는 순서의 줄로 묶는다 */
function groupLines(items) {
  const sorted = [...items].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
  const rows = [];
  for (const it of sorted) {
    const cy = it.y + it.h / 2;
    let row = null;
    for (let i = rows.length - 1; i >= 0 && i >= rows.length - 4; i--) {
      const r = rows[i];
      if (Math.abs(cy - r.cy) <= 0.5 * Math.min(it.h, r.h)) { row = r; break; }
    }
    if (!row) { row = { items: [], cy, h: it.h }; rows.push(row); }
    row.items.push(it);
    row.cy = row.items.reduce((s, v) => s + v.y + v.h / 2, 0) / row.items.length;
    row.h = row.items.reduce((s, v) => s + v.h, 0) / row.items.length;
  }
  return rows.sort((a, b) => a.cy - b.cy).map((r) => {
    const its = r.items.sort((a, b) => a.x - b.x);
    let text = its[0].text;
    for (let i = 1; i < its.length; i++) {
      const gap = its[i].x - (its[i - 1].x + its[i - 1].w);
      text += (gap > 0.15 * r.h ? ' ' : '') + its[i].text;
    }
    const x = Math.min(...its.map((v) => v.x)), y = Math.min(...its.map((v) => v.y));
    return {
      text, x, y,
      w: Math.max(...its.map((v) => v.x + v.w)) - x,
      h: Math.max(...its.map((v) => v.y + v.h)) - y,
      confidence: Math.min(...its.map((v) => v.confidence)),
    };
  });
}

class PpOcr {
  constructor(parts) { Object.assign(this, parts); }

  /** modelDir 에는 det.onnx, rec_korean.onnx, rec_korean.yml 이 있어야 한다 */
  static async create({ modelDir, ort }) {
    process.env.ORT_DISABLE_TELEMETRY = '1';
    const opts = { graphOptimizationLevel: 'all', executionProviders: ['cpu'], logSeverityLevel: 3 };
    const [det, rec] = await Promise.all([
      ort.InferenceSession.create(path.join(modelDir, 'det.onnx'), opts),
      ort.InferenceSession.create(path.join(modelDir, 'rec_korean.onnx'), opts),
    ]);
    const dict = parseCharacterDict(fs.readFileSync(path.join(modelDir, 'rec_korean.yml'), 'utf8'));
    if (!dict.length) throw new Error('OCR 사전을 읽지 못했습니다');
    return new PpOcr({ det, rec, dict, ort });
  }

  async destroy() {
    for (const s of [this.det, this.rec]) { try { await s.release(); } catch { /* 무시 */ } }
  }

  async detect(rgba, width, height, longSide) {
    const ratio = longSide / Math.max(width, height);
    const dw = Math.max(32, Math.round((width * ratio) / 32) * 32);
    const dh = Math.max(32, Math.round((height * ratio) / 32) * 32);
    const rgb = resizeRgb(rgba, width, height, dw, dh);
    const plane = dw * dh;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      input[i] = (rgb[i * 3 + 2] / 255 - DET_MEAN[0]) / DET_STD[0];
      input[plane + i] = (rgb[i * 3 + 1] / 255 - DET_MEAN[1]) / DET_STD[1];
      input[2 * plane + i] = (rgb[i * 3] / 255 - DET_MEAN[2]) / DET_STD[2];
    }
    const out = await this.det.run({ [this.det.inputNames[0]]: new this.ort.Tensor('float32', input, [1, 3, dh, dw]) });
    const prob = out[this.det.outputNames[0]].data;
    const sx = width / dw, sy = height / dh;
    const boxes = [];
    for (const rb of componentBoxes(prob, dw, dh, TUNE.detThresh, TUNE.detBoxThresh).slice(0, DET_MAX_BOXES)) {
      const bw = rb.x2 - rb.x1 + 1, bh = rb.y2 - rb.y1 + 1;
      const delta = (bw * bh * TUNE.unclip) / (2 * (bw + bh));   // DB 는 학습할 때 영역을 줄이므로 되팽창
      const x1 = Math.max(0, Math.floor((rb.x1 - delta) * sx)), y1 = Math.max(0, Math.floor((rb.y1 - delta) * sy));
      const x2 = Math.min(width, Math.ceil((rb.x2 + 1 + delta) * sx)), y2 = Math.min(height, Math.ceil((rb.y2 + 1 + delta) * sy));
      if (x2 - x1 >= DET_MIN && y2 - y1 >= DET_MIN) boxes.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    }
    return boxes;
  }

  async readBox(rgba, width, box) {
    const c = lineCrop(rgba, width, box);
    const bw = Math.max(REC_MIN_W, c.w), p = REC_H * bw;
    const input = new Float32Array(3 * p);   // 오른쪽 남는 폭은 0 (공식 전처리의 zero-pad)
    for (let y = 0; y < REC_H; y++) {
      for (let x = 0; x < c.w; x++) {
        const s = (y * c.w + x) * 3, d = y * bw + x;
        input[d] = c.rgb[s + 2] / 127.5 - 1;
        input[d + p] = c.rgb[s + 1] / 127.5 - 1;
        input[d + 2 * p] = c.rgb[s] / 127.5 - 1;
      }
    }
    const out = await this.rec.run({ [this.rec.inputNames[0]]: new this.ort.Tensor('float32', input, [1, 3, REC_H, bw]) });
    const logits = out[this.rec.outputNames[0]];
    const [, T, C] = logits.dims;
    return ctcDecode(logits.data, T, C, this.dict);
  }

  /**
   * @param {{data: Uint8Array, width: number, height: number, bgra?: boolean}} image 4채널 픽셀 (nativeImage.toBitmap 은 bgra: true)
   * @returns {Promise<{text: string, lines: Array}>}
   */
  async recognize(image, { detLongSide } = {}) {
    const { width, height } = image;
    if (width < DET_MIN || height < DET_MIN) return { text: '', lines: [] };
    const rgba = toRgba(image.data, image.bgra);
    // 긴 변이 작은 이미지는 960 으로 키워서(작은 글자 보강), 큰 화면 캡처는 최대 1600 까지 유지해 작은 글자를 살린다
    const longSide = detLongSide || Math.min(1600, Math.max(960, Math.max(width, height)));
    const boxes = await this.detect(rgba, width, height, longSide);
    const items = [];
    for (const b of boxes) {
      if (boxContrast(rgba, width, b) < TUNE.minContrast) continue;   // 배경 무늬를 글자로 읽는 환각 방지
      const r = await this.readBox(rgba, width, b);
      if (!r || !r.text.trim() || r.confidence < TUNE.textScore) continue;
      items.push({ text: r.text.trim(), x: b.x, y: b.y, w: b.w, h: b.h, confidence: r.confidence });
    }
    const lines = groupLines(items);
    return { text: lines.map((l) => l.text).join('\n'), lines };
  }
}

module.exports = { PpOcr, parseCharacterDict, ctcDecode, componentBoxes, groupLines };
