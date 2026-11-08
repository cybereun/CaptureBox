'use strict';
/*
 * 릴리즈 전 설치본 검증: npm run verify
 *   1) npm run dist 로 설치 파일까지 빌드 (--no-build 로 건너뛰기 가능). 릴리즈 파일(dist/)을 그대로 검사합니다
 *   2) 패키징된 CaptureBox.exe 를 자체 검증 모드로 두 번 실행 (일반 시작 / --hidden 자동 실행 시작)
 *   3) 결과 표를 출력하고, 하나라도 실패하면 종료 코드 1
 * 주의: 실행 중 화면에 테스트 창과 어두운 캡처 화면이 잠깐씩 나타납니다. 끝날 때까지 마우스/키보드를 건드리지 마세요.
 * 구글 드라이브 같은 가상 드라이브가 아니라 로컬 디스크에서 실행하세요.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const exe = path.join(root, 'dist', 'win-unpacked', 'CaptureBox.exe');
let sharedProfile = '';

function removeVerificationDirectory(candidate) {
  const absolute = path.resolve(candidate);
  const temporaryRoot = path.resolve(os.tmpdir());
  const relative = path.relative(temporaryRoot, absolute);
  if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || relative === '..' ||
      path.dirname(absolute) !== temporaryRoot || !path.basename(absolute).startsWith('cb-verify')) {
    throw new Error(`Refusing to clear an unexpected verification path: ${absolute}`);
  }
  fs.rmSync(absolute, { recursive: true, force: true });
}

if (!process.argv.includes('--no-build')) {
  console.log('> 설치 파일까지 빌드 중 (npm run dist) … 릴리즈에 올릴 파일과 같은 빌드를 검사합니다');
  const b = spawnSync('npm', ['run', 'dist'], { cwd: root, stdio: 'inherit', shell: true });
  if (b.status !== 0) { console.error('패키징에 실패했습니다.'); process.exit(1); }
}
if (!fs.existsSync(exe)) { console.error(`실행 파일이 없습니다: ${exe}`); process.exit(1); }
sharedProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-verify-shared-'));

function run(label, args, env) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-verify-'));
  const reportPath = path.join(userData, 'report.json');
  if (env.CB_SELFTEST_SEED === '1') {
    const captures = path.join(userData, 'assets');
    fs.mkdirSync(captures, { recursive: true });
    const legacyPng = fs.readFileSync(path.join(root, 'assets', 'icon.png'));
    const legacyId = 'verifylegacy01';
    const asset = {
      id: legacyId,
      name: 'Legacy migration fixture',
      mode: 'region',
      width: legacyPng.readUInt32BE(16),
      height: legacyPng.readUInt32BE(20),
      createdAt: 1700000000000,
    };
    fs.writeFileSync(path.join(captures, `${legacyId}.png`), legacyPng);
    fs.writeFileSync(path.join(captures, 'index.json'), JSON.stringify([asset], null, 1));
    fs.writeFileSync(path.join(captures, 'keep-this-file.txt'), 'unindexed user file: keep unchanged');
    fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ autoCopy: false, clipOnly: false }));
    fs.mkdirSync(path.join(sharedProfile, 'temp-exports'), { recursive: true });
    fs.writeFileSync(path.join(sharedProfile, 'temp-exports', 'leftover.png'), legacyPng);
  }
  console.log(`\n> ${label} 실행 중 …`);
  const r = spawnSync(exe, [`--user-data-dir=${userData}`, ...args], {
    env: { ...process.env, CB_SELFTEST: reportPath, CB_SELFTEST_PROFILE_ROOT: sharedProfile, ...env },
    timeout: 8 * 60 * 1000,
  });
  let report = null;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { /* 보고서 없음 */ }
  if (!report) return { label, userData, error: `보고서가 만들어지지 않았습니다 (종료 코드 ${r.status}, 신호 ${r.signal || '-'})` };
  return { label, report, userData };
}

const first = run('일반 시작', [], { CB_SELFTEST_SEED: '1' });
const second = run('별도 앱 프로필 · 자동 실행(--hidden) 시작', ['--hidden'], {
  CB_SELFTEST_HIDDEN: '1',
  CB_SELFTEST_EXPECT_SHARED: '1',
  CB_SELFTEST_EXPECT_DIR: path.join(first.userData || '', 'assets'),
});
const runs = [first, second];

const ICON = { pass: '✔', fail: '✘', warn: '△' };
let failed = 0, warned = 0;
for (const r of runs) {
  console.log(`\n=== ${r.label} ===`);
  if (r.error) { console.log(`✘ ${r.error}`); failed++; continue; }
  console.log(`CaptureBox v${r.report.version} (Electron ${r.report.electron})`);
  for (const t of r.report.results) {
    console.log(`${ICON[t.status] || '?'} ${t.name}${t.detail ? `  —  ${t.detail}` : ''}`);
    if (t.status === 'fail') failed++;
    if (t.status === 'warn') warned++;
  }
}
console.log(`\n결과: ${failed ? `실패 ${failed}개` : '모두 통과'}${warned ? ` (경고 ${warned}개)` : ''}`);
for (const r of runs) if (r.userData) { try { removeVerificationDirectory(r.userData); } catch { /* 무시 */ } }
try { removeVerificationDirectory(sharedProfile); } catch { /* 무시 */ }
process.exit(failed ? 1 : 0);
