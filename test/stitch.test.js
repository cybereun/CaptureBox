'use strict';
const assert = require('assert');
const { Stitcher } = require('../stitch');

const W = 320;
const H = 500;
const TOTAL = 2250;

// 줄마다 고유한 무늬를 가진 합성 "페이지"
function makePage() {
  const data = Buffer.alloc(W * TOTAL * 4);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < TOTAL; y++) {
    const base = [rnd() * 255, rnd() * 255, rnd() * 255];
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const v = (x * 7 + y * 13) % 41 > 20 ? 1 : 0.6;
      data[o] = base[0] * v;
      data[o + 1] = base[1] * v;
      data[o + 2] = base[2] * v;
      data[o + 3] = 255;
    }
  }
  return data;
}

function frameAt(page, top) {
  return { data: Buffer.from(page.subarray(top * W * 4, (top + H) * W * 4)), width: W, height: H };
}

const page = makePage();
const st = new Stitcher(frameAt(page, 0));
for (const top of [300, 600, 900, 1200, 1500]) {
  const r = st.add(frameAt(page, top));
  assert.strictEqual(r.status, 'added', `top=${top}: ${r.status}`);
  assert.strictEqual(r.shift, 300);
}
// 마지막: 끝에서 일부만 스크롤됨
let r = st.add(frameAt(page, 1500));
assert.strictEqual(r.status, 'end');
r = st.add(frameAt(page, TOTAL - H));
assert.strictEqual(r.status, 'added');
assert.strictEqual(r.shift, TOTAL - H - 1500);

const out = st.result();
assert.strictEqual(out.height, TOTAL);
assert.ok(out.data.equals(page), '이어붙인 결과가 원본과 다릅니다');

// 매칭 불가
const bad = { data: Buffer.alloc(W * H * 4, 7), width: W, height: H };
assert.strictEqual(new Stitcher(frameAt(page, 0)).add(bad).status, 'nomatch');

console.log('stitch tests passed');
