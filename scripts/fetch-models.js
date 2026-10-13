'use strict';
/*
 * 정밀 글자 인식(PP-OCRv5 한국어) 모델을 내려받아 models/ppocr/ 에 둔다 (npm run models, dist 전에 자동 실행).
 * 모델은 PaddlePaddle 공식 PP-OCRv5 의 ONNX 변환본(Apache-2.0)이며, SHA-256 으로 무결성을 검증한다.
 * 이미 받아 둔 파일이 해시와 맞으면 건너뛴다. 설치 파일에는 extraResources 로 함께 들어간다.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'models', 'ppocr');
const MODELS = [
  { name: 'det.onnx', url: 'https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx', sha256: 'a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d' },
  { name: 'rec_korean.onnx', url: 'https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx', sha256: '92f0b7785e64fc9090106a241cf4c1eb97472824558272751b88a2a4476d3a08' },
  { name: 'rec_korean.yml', url: 'https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.yml', sha256: 'f757fa1c40e99edcf27e9cce879b93eb2a51fa46f5ef39095689b8c37dd75998' },
];
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  for (const m of MODELS) {
    const file = path.join(DIR, m.name);
    if (fs.existsSync(file) && sha(fs.readFileSync(file)) === m.sha256) { console.log(`✔ ${m.name} (이미 있음)`); continue; }
    process.stdout.write(`↓ ${m.name} 내려받는 중… `);
    const res = await fetch(m.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${m.name}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha(buf) !== m.sha256) throw new Error(`${m.name}: SHA-256 불일치 (손상되었거나 모델이 바뀌었습니다)`);
    fs.writeFileSync(file, buf);
    console.log(`${(buf.length / 1048576).toFixed(1)}MB OK`);
  }
})().catch((e) => { console.error('모델 준비 실패:', e.message); process.exit(1); });
