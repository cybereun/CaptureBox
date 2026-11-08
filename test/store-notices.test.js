'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (file) => fs.readFileSync(require('node:path').join(__dirname, '..', file), 'utf8');
const packageJson = JSON.parse(read('package.json'));

test('Store package exposes app and third-party license notices as resources', () => {
  const resources = packageJson.build.extraResources;
  const sources = resources.map((resource) => resource.from);

  assert.ok(sources.includes('LICENSE'), 'app MIT license must be included outside app.asar');
  assert.ok(sources.includes('THIRD_PARTY.md'), 'third-party component summary must be included');
  assert.ok(sources.includes('store/THIRD_PARTY_NOTICES.txt'), 'readable third-party notice must be included');
  assert.ok(sources.includes('store/privacy-policy-ko.txt'), 'current privacy policy must be included');
  assert.ok(sources.includes('store/licenses'), 'full third-party license texts and notices must be included');
});

test('Help opens the bundled OCR license notice and describes the actual OCR engines', () => {
  const html = read('ui/index.html');
  const preload = read('preload.js');
  const main = read('main.js');

  assert.match(html, /openNotices/, 'Help must provide an open-source notices control');
  assert.match(html, /PP-OCRv5/, 'Help must describe the bundled PP-OCRv5 default');
  assert.match(html, /Windows OCR/, 'Help must describe the Windows OCR fallback');
  assert.doesNotMatch(html, /Windows에 내장된 OCR을 쓰므로 별도 설치가 필요/,
    'Help must not claim Windows OCR is the only OCR engine');
  assert.match(preload, /openNotices: \(\) => ipcRenderer\.invoke\('notices:open'\)/);
  assert.match(html, /openPrivacyPolicy/);
  assert.match(preload, /openPrivacyPolicy: \(\) => ipcRenderer\.invoke\('privacy:open'\)/);
  assert.match(main, /ipcMain\.handle\('notices:open'/);
  assert.match(main, /ipcMain\.handle\('privacy:open'/);
  assert.match(main, /process\.resourcesPath, 'privacy-policy-ko\.txt'/,
    'Store Help must open the packaged policy instead of a potentially stale website');
  assert.doesNotMatch(main, /STORE_PRIVACY_URL|shell\.openExternal\(STORE_PRIVACY_URL\)/);
  const policy = read('store/privacy-policy-ko.txt');
  assert.match(policy, /AES-256-GCM/);
  assert.match(policy, /Windows DPAPI/);
  assert.match(policy, /일반 PNG/);
});

test('Store notice lists the included OCR models and runtime license sources', () => {
  const notices = read('store/THIRD_PARTY_NOTICES.txt');
  assert.match(notices, /CaptureBox 1\.5\.3/);
  assert.match(notices, /package-lock\.json 자체는 앱에 포함되지 않습니다/);
  for (const item of [
    'PP-OCRv5_mobile_det_onnx',
    'korean_PP-OCRv5_mobile_rec_onnx',
    'onnxruntime-node 1.30.0',
    'onnxruntime-common 1.30.0',
    'lazy-val 1.0.5',
    'ThirdPartyNotices.txt',
  ]) assert.ok(notices.includes(item), `third-party notice must mention ${item}`);

  for (const file of [
    'store/licenses/Apache-2.0.txt',
    'store/licenses/ONNXRuntime-MIT-LICENSE.txt',
    'store/licenses/ONNXRuntime-ThirdPartyNotices.txt',
    'store/licenses/lazy-val-MIT-LICENSE.txt',
    'store/licenses/kordoc-MIT-LICENSE.txt',
  ]) assert.ok(fs.statSync(require('node:path').join(__dirname, '..', file)).size > 100,
    `full license text must exist: ${file}`);

  const lock = JSON.parse(read('package-lock.json'));
  for (const [key, pkg] of Object.entries(lock.packages)) {
    if (!key.startsWith('node_modules/') || pkg.dev || pkg.devOptional || !pkg.license) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const license = pkg.license.replace(/[()]/g, '');
    assert.ok(notices.includes(`${name.split('/').at(-1)} ${pkg.version} — ${license}`),
      `runtime dependency must be listed: ${name}@${pkg.version}`);
  }
});

test('Store submission guide matches the package version and privacy declaration', () => {
  const listing = read('store/listing-ko.md');
  assert.ok(listing.includes(`CaptureBox-Store-${packageJson.version}.appx`));
  assert.doesNotMatch(listing, /CaptureBox-Store-1\.5\.2\.appx/);
  assert.match(listing, /개인정보 항목은 `예`로 선언합니다/);
  assert.match(listing, /store\/privacy-policy-ko\.txt/);
  assert.match(listing, /최신 암호화 설명이 반영되지 않았으므로/);
});
