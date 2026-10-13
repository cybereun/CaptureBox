// 투명 배경 아이콘 생성기: node build-icon.js  → assets/icon.png, assets/icon.ico
const fs = require('fs'), zlib = require('zlib'), path = require('path');

const sdRound = (x, y, cx, cy, hw, hh, r) => {
  const dx = Math.abs(x - cx) - (hw - r), dy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
};
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// 좌표는 0..1 정규화. 반환: [r,g,b,a] 또는 null(투명)
function shade(u, v) {
  if (sdRound(u, v, .5, .5, .49, .49, .22) > 0) return null;           // 둥근 사각형(캔버스 거의 꽉 참)
  let c = mix([79, 140, 255], [124, 58, 237], (u + v) / 2);              // 파랑→보라 그라데이션
  const w = .045, L = .17, lo = .2, hi = .8;                             // 캡처 브래킷
  const inB = (cx, cy) => {
    const sx = cx < .5 ? 1 : -1, sy = cy < .5 ? 1 : -1;
    const ax = Math.abs(u - cx), ay = Math.abs(v - cy);
    const horiz = sdRound(u, v, cx + sx * L / 2 - sx * w / 2, cy, L / 2, w / 2, w / 2) < 0;
    const vert = sdRound(u, v, cx, cy + sy * L / 2 - sy * w / 2, w / 2, L / 2, w / 2) < 0;
    return horiz || vert;
  };
  if (inB(lo, lo) || inB(hi, lo) || inB(lo, hi) || inB(hi, hi)) return [255, 255, 255, 255];
  // 중앙: 선반(에셋) 3단
  if (sdRound(u, v, .5, .43, .21, .075, .03) < 0) return [255, 255, 255, 255];
  if (sdRound(u, v, .5, .58, .21, .045, .02) < 0) return [255, 255, 255, 215];
  return c.concat(255);
}

function render(size) {
  const S = 3, buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const p = shade((x + (sx + .5) / S) / size, (y + (sy + .5) / S) / size);
      if (!p) continue;
      const pa = p[3] / 255; r += p[0] * pa; g += p[1] * pa; b += p[2] * pa; a += pa;
    }
    const o = (y * size + x) * 4, n = S * S;
    if (a > 0) { buf[o] = r / a; buf[o + 1] = g / a; buf[o + 2] = b / a; buf[o + 3] = Math.round(255 * a / n); }
  }
  return buf;
}

const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
function png(size) {
  const px = render(size), raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const out = path.join(__dirname, 'assets'); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), png(512));
const sizes = [16, 32, 48, 64, 128, 256], imgs = sizes.map(png);
const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let off = 6 + 16 * sizes.length;
const dir = sizes.map((s, i) => { const e = Buffer.alloc(16); e[0] = s % 256; e[1] = s % 256; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(imgs[i].length, 8); e.writeUInt32LE(off, 12); off += imgs[i].length; return e; });
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([head, ...dir, ...imgs]));
console.log('done');
