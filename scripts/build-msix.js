'use strict';
/*
 * Microsoft Store 제출용 패키지 만들기: npm run msix
 *   - store/identity.json (Partner Center > 제품 ID) 의 값으로 MSIX 계열 패키지(.appx)를 만든다.
 *   - 결과: dist-store/CaptureBox-Store-<버전>.appx  → Partner Center > 패키지 에 그대로 올린다.
 *   - Store 에 올리는 패키지는 서명하지 않는다 (Store 가 서명한다). 그래서 내 PC 에 직접 설치해 볼 수는 없다.
 * 구글 드라이브 같은 가상 드라이브가 아니라 로컬 디스크에서 실행하세요.
 */
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const id = JSON.parse(fs.readFileSync(path.join(root, 'store', 'identity.json'), 'utf8'));
for (const k of ['identityName', 'publisher', 'publisherDisplayName']) {
  if (!id[k] || /REPLACE|여기에/.test(id[k])) { console.error(`store/identity.json 의 ${k} 값을 Partner Center 의 제품 ID 로 채워 주세요.`); process.exit(1); }
}
if (!/^CN=/.test(id.publisher)) { console.error('publisher 는 "CN=..." 형식이어야 합니다 (Partner Center 의 Package/Identity/Publisher 값).'); process.exit(1); }

// 1) 타일·로고 이미지, OCR 모델 준비
for (const s of ['make-store-assets.js', 'fetch-models.js']) {
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}

// 2) 빌드 설정 = package.json 의 build 설정 + appx 설정 (자동 업데이트용 publish 설정은 뺀다)
const out = path.join(root, 'dist-store');
fs.mkdirSync(out, { recursive: true });
const expectedNames = [`CaptureBox-Store-${pkg.version}.appx`, `CaptureBox-Store-${pkg.version}.msix`];
const existingVersioned = expectedNames.find((name) => fs.existsSync(path.join(out, name)));
if (existingVersioned) {
  console.error(`같은 버전 패키지가 이미 있습니다: ${path.join(out, existingVersioned)}. package.json 버전을 올려 기존 파일을 보존하세요.`);
  process.exit(1);
}
const build = JSON.parse(JSON.stringify(pkg.build));
delete build.publish;
delete build.nsis;
build.directories = { ...(build.directories || {}), output: 'dist-store' };
// 매니페스트의 Description 은 한글이 깨져 들어가므로(빌드 도구가 윈도우 코드페이지로 넘김) 이 빌드에서만 영어 설명을 쓴다. Store 에 보이는 설명은 Partner Center 에 따로 입력한다.
build.extraMetadata = { ...(build.extraMetadata || {}), description: 'Capture, annotate and copy text from screenshots' };
build.win = { ...(build.win || {}), target: [{ target: 'appx', arch: ['x64'] }] };
build.appx = {
  applicationId: id.applicationId || 'CaptureBox',
  displayName: id.displayName || 'CaptureBox',
  identityName: id.identityName,
  publisher: id.publisher,
  publisherDisplayName: id.publisherDisplayName,
  languages: ['ko-KR', 'en-US'],
  backgroundColor: '#0d1230',
  showNameOnTiles: false,
  artifactName: 'CaptureBox-Store-${version}.${ext}',
};
const cfg = path.join(os.tmpdir(), `capturebox-msix-${crypto.randomUUID()}.json`);
let r;
try {
  fs.writeFileSync(cfg, JSON.stringify(build, null, 2), { flag: 'wx' });
  console.log(`> MSIX(appx) 빌드 중 … ${id.identityName} v${pkg.version}`);
  r = spawnSync('npx', ['electron-builder', '--win', 'appx', '--x64', '--publish', 'never', '--config', cfg], { cwd: root, stdio: 'inherit', shell: true });
} finally { fs.rmSync(cfg, { force: true }); }
if (r.status !== 0) { console.error('빌드에 실패했습니다.'); process.exit(r.status || 1); }
const made = fs.readdirSync(out).filter((f) => f.startsWith(`CaptureBox-Store-${pkg.version}.`) && /\.(appx|msix)$/i.test(f));
if (!made.length) { console.error('패키지 파일이 만들어지지 않았습니다.'); process.exit(1); }
for (const f of made) console.log(`✔ ${path.join('dist-store', f)}  (${(fs.statSync(path.join(out, f)).size / 1048576).toFixed(1)}MB)`);
console.log('\nPartner Center > 제출 > 패키지 에서 위 파일을 올리세요. (제출 전에 store/listing-ko.md 의 내용을 확인하세요)');
