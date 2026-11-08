'use strict';
const {
  app, BrowserWindow, ipcMain, protocol, desktopCapturer, screen, clipboard, nativeImage, safeStorage,
  dialog, globalShortcut, shell, ClipboardItem, Tray, Menu,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { isSamePhysicalPath, isPathWithin } = require('./store-paths');
const { Stitcher } = require('./stitch');
const { openVault } = require('./vault');
const { migrateIndexedFiles, resolveCaptureDirectory, resolveFallbackDirectory, shouldMigrateIndexedFiles } = require('./store-migration');
const { createAssetProtocolHandler } = require('./asset-protocol');

protocol.registerSchemesAsPrivileged([{
  scheme: 'capturebox-asset',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

// safeStorage uses Electron's session Local State file, while the process lock follows userData.
// Point both at one per-Windows-user directory before either facility initializes.
const packageUserDataDir = app.getPath('userData');
const sharedProfileDir = path.resolve(process.env.CB_SELFTEST_PROFILE_ROOT || path.join(
  process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'), 'CaptureBox',
));
fs.mkdirSync(sharedProfileDir, { recursive: true });
app.setPath('userData', sharedProfileDir);
app.setPath('sessionData', sharedProfileDir);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (process.env.CB_SELFTEST_LOCK_PROBE === '1') {
  if (hasSingleInstanceLock && process.env.CB_SELFTEST_LOCK_MARKER) {
    fs.writeFileSync(process.env.CB_SELFTEST_LOCK_MARKER, 'another instance acquired the shared lock');
  }
  process.exit(hasSingleInstanceLock ? 42 : 0);
} else if (!hasSingleInstanceLock) app.quit();

const MODE_LABEL = { region: '영역', window: '창', fullscreen: '전체 화면', scroll: '스크롤', edit: '편집' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null;
let busy = false;

/* ---------- 저장소 (에셋 + 설정) ---------- */
let assetsDir, indexFile, settingsFile, legacySettingsFile;
let temporaryExportsDir = '';
let vault = null;
let assets = [];
let settings = { autoCopy: true, clipOnly: false };

let storeError = '';
let storeReady = false;
let storeTransition = false;
let storeInitialization = null;
const defaultDir = () => process.env.CB_SELFTEST
  ? path.join(packageUserDataDir, 'selftest-captures')
  : path.join(app.getPath('pictures'), 'Screenshots');   // 윈도우 스크린샷 폴더
const legacyDir = () => path.join(packageUserDataDir, 'assets');              // v1.0.1 이하의 기본 위치

function parseSettings(bytes, label) {
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch (error) {
    throw new Error(`${label} is malformed: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} is invalid`);
  if (Object.hasOwn(parsed, 'assetsDir') && (typeof parsed.assetsDir !== 'string' || !path.isAbsolute(parsed.assetsDir))) {
    throw new Error(`${label} contains an invalid capture directory`);
  }
  return parsed;
}

function hasEncryptedData(directory) {
  if (typeof directory !== 'string' || !directory || !fs.existsSync(directory)) return false;
  try { return fs.readdirSync(directory).some((name) => name.endsWith('.cbx')); } catch { return false; }
}

function parseAssetIndex(bytes, label) {
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch (error) {
    throw new Error(`${label} is malformed: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((asset) => !asset || typeof asset !== 'object' || typeof asset.id !== 'string' || !/^[a-z0-9]{6,32}$/i.test(asset.id))) {
    throw new Error(`${label} is invalid`);
  }
  if (new Set(parsed.map((asset) => asset.id)).size !== parsed.length) throw new Error(`${label} contains duplicate asset IDs`);
  return parsed;
}

async function initStore() {
  storeReady = false;
  assets = [];
  const userData = sharedProfileDir;
  temporaryExportsDir = path.join(userData, 'temp-exports');
  settingsFile = path.join(userData, 'settings.cbx');
  legacySettingsFile = path.join(packageUserDataDir, 'settings.json');
  const keyFile = path.join(userData, 'vault-key.bin');
  const stateFile = path.join(userData, 'vault-state.bin');
  const legacySettings = !fs.existsSync(settingsFile) && fs.existsSync(legacySettingsFile)
    ? parseSettings(fs.readFileSync(legacySettingsFile), 'Legacy CaptureBox settings')
    : null;
  const candidates = [legacySettings && legacySettings.assetsDir, defaultDir(), legacyDir(), packageUserDataDir];
  const keyMustExist = fs.existsSync(stateFile) || fs.existsSync(settingsFile) || candidates.some(hasEncryptedData);
  vault = await openVault({ safeStorage, keyFile, stateFile, requireExistingKey: keyMustExist });

  // Store and GitHub builds use one protected state and one encrypted settings file.
  const sharedState = await vault.readState();
  let storedSettings = null;
  if (fs.existsSync(settingsFile)) storedSettings = parseSettings(vault.readFile(settingsFile), 'Encrypted CaptureBox settings');
  else if (legacySettings) storedSettings = legacySettings;
  settings = { autoCopy: true, clipOnly: false, ...(storedSettings || {}) };

  const selected = await resolveCaptureDirectory({
    vault,
    legacySettings: sharedState ? null : storedSettings,
    fallbackDirectory: resolveFallbackDirectory({
      legacyDirectory: legacyDir(),
      defaultDirectory: defaultDir(),
      legacyIndexExists: !sharedState && fs.existsSync(path.join(legacyDir(), 'index.json')),
    }),
  });
  assetsDir = selected.directory;
  if (isPathWithin(assetsDir, temporaryExportsDir)) {
    throw new Error('The CaptureBox library cannot be inside its temporary export folder');
  }
  try {
    const tempInfo = fs.lstatSync(temporaryExportsDir);
    if (tempInfo.isSymbolicLink()) throw new Error('CaptureBox temporary export path must not be a symbolic link');
    fs.rmSync(temporaryExportsDir, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`CaptureBox temporary exports could not be cleared: ${error.message}`);
  }
  fs.mkdirSync(temporaryExportsDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.accessSync(assetsDir, fs.constants.W_OK);
  indexFile = path.join(assetsDir, 'index.cbx');

  const encryptedIndexExists = fs.existsSync(indexFile);
  const legacyIndexPath = path.join(assetsDir, 'index.json');
  const legacyIndexExists = fs.existsSync(legacyIndexPath);
  if (encryptedIndexExists) {
    try { assets = parseAssetIndex(vault.readFile(indexFile), 'Encrypted CaptureBox index'); }
    catch (error) {
      if (!legacyIndexExists) throw error;
      assets = parseAssetIndex(fs.readFileSync(legacyIndexPath), 'Legacy CaptureBox index');
    }
  } else if (legacyIndexExists) {
    assets = parseAssetIndex(fs.readFileSync(legacyIndexPath), 'Legacy CaptureBox index');
  } else {
    if (hasEncryptedData(assetsDir)) throw new Error('CaptureBox encrypted files exist but the asset index is missing');
    assets = [];
  }

  const legacyIndexedFilesExist = assets.some((asset) => asset && typeof asset.id === 'string' && (
    fs.existsSync(path.join(assetsDir, `${asset.id}.png`)) || fs.existsSync(path.join(assetsDir, `${asset.id}.thumb.png`))
  ));
  if (shouldMigrateIndexedFiles({ encryptedIndexExists, legacyIndexExists, legacyIndexedFilesExist })) {
    await migrateIndexedFiles({ directory: assetsDir, assets, vault, makeThumbnail: makeThumbnailBytes });
  }

  if (!fs.existsSync(settingsFile)) {
    vault.writeFileAtomic(settingsFile, Buffer.from(JSON.stringify(settings)));
    const verified = parseSettings(vault.readFile(settingsFile), 'Encrypted CaptureBox settings');
    if (JSON.stringify(verified) !== JSON.stringify(settings)) throw new Error('Encrypted CaptureBox settings failed verification');
  }
  const settingsDirectoryBefore = settings.assetsDir;
  if (assetsDir.toLowerCase() === defaultDir().toLowerCase()) delete settings.assetsDir;
  else settings.assetsDir = assetsDir;
  if (selected.source !== 'shared-state' || settingsDirectoryBefore !== settings.assetsDir) {
    vault.writeFileAtomic(settingsFile, Buffer.from(JSON.stringify(settings)));
    const verifiedSettings = parseSettings(vault.readFile(settingsFile), 'Encrypted CaptureBox settings');
    if (JSON.stringify(verifiedSettings) !== JSON.stringify(settings)) throw new Error('Encrypted CaptureBox settings failed verification');
  }
  if (fs.existsSync(legacySettingsFile)) fs.rmSync(legacySettingsFile, { force: true });
  await vault.writeState(assetsDir);
  storeError = '';
  storeReady = true;
  return storeInfo();
}

async function retryStore() {
  if (storeInitialization) return storeInitialization;
  storeInitialization = (async () => {
    try {
      await initStore();
    } catch (error) {
      storeReady = false;
      assets = [];
      storeError = String(error && error.message || error).split(/\r?\n/)[0].slice(0, 240);
    }
    return storeInfo();
  })().finally(() => { storeInitialization = null; });
  return storeInitialization;
}

/* 저장 폴더 변경: 기존 에셋을 새 폴더로 복사(성공 후 원본 삭제)하고, 새 폴더에 있던 에셋과 합친다. */
async function moveStore(newDir) {
  assertStoreMutable();
  if (storeTransition) throw new Error('CaptureBox storage is already being moved');
  storeTransition = true;
  try { return await performStoreMove(newDir); }
  finally { storeTransition = false; }
}

async function performStoreMove(newDir) {
  assertStoreReady();
  if (busy) throw new Error('Wait for the current capture to finish before moving the CaptureBox folder');
  newDir = path.resolve(newDir);
  if (isPathWithin(newDir, temporaryExportsDir)) throw new Error('Choose a folder outside the CaptureBox temporary export folder');
  if (isSamePhysicalPath(newDir, assetsDir)) return { ok: true };
  fs.mkdirSync(newDir, { recursive: true });
  if (isPathWithin(newDir, temporaryExportsDir)) throw new Error('Choose a folder outside the CaptureBox temporary export folder');
  if (isSamePhysicalPath(newDir, assetsDir)) return { ok: true };
  const oldDir = path.resolve(assetsDir), oldAssets = [...assets];
  const destinationIndex = path.join(newDir, 'index.cbx');
  const legacyDestinationIndex = path.join(newDir, 'index.json');
  let existing = [];
  if (fs.existsSync(destinationIndex)) {
    try { existing = parseAssetIndex(vault.readFile(destinationIndex), 'Destination CaptureBox index'); }
    catch (error) {
      if (!fs.existsSync(legacyDestinationIndex)) throw error;
      existing = parseAssetIndex(fs.readFileSync(legacyDestinationIndex), 'Legacy destination CaptureBox index');
    }
  } else if (fs.existsSync(legacyDestinationIndex)) existing = parseAssetIndex(fs.readFileSync(legacyDestinationIndex), 'Legacy destination CaptureBox index');
  else if (hasEncryptedData(newDir)) throw new Error('Encrypted files exist in the selected folder but its index is missing');

  await migrateIndexedFiles({ directory: newDir, assets: existing, vault, makeThumbnail: makeThumbnailBytes });
  const existingById = new Map(existing.map((asset) => [asset.id, asset]));
  for (const asset of oldAssets) {
    const imageBytes = readAsset(asset.id);
    const existingAsset = existingById.get(asset.id);
    if (existingAsset) {
      const destinationBytes = vault.readFile(path.join(newDir, `${asset.id}.cbx`));
      if (!destinationBytes.equals(imageBytes)) throw new Error(`Capture ID collision while moving ${asset.id}`);
      continue;
    }
    vault.writeFileAtomic(path.join(newDir, `${asset.id}.cbx`), imageBytes);
    if (!vault.readFile(path.join(newDir, `${asset.id}.cbx`)).equals(imageBytes)) throw new Error(`Image copy failed verification for ${asset.id}`);
    const sourceThumb = path.join(oldDir, `${asset.id}.thumb.cbx`);
    const thumbBytes = fs.existsSync(sourceThumb) ? vault.readFile(sourceThumb) : await makeThumbnailBytes(imageBytes);
    vault.writeFileAtomic(path.join(newDir, `${asset.id}.thumb.cbx`), thumbBytes);
    if (!vault.readFile(path.join(newDir, `${asset.id}.thumb.cbx`)).equals(thumbBytes)) throw new Error(`Thumbnail copy failed verification for ${asset.id}`);
  }

  const newAssets = [...oldAssets, ...existing.filter((asset) => !oldAssets.some((old) => old.id === asset.id))]
    .sort((a, b) => b.createdAt - a.createdAt);
  const nextSettings = { ...settings };
  if (newDir.toLowerCase() === defaultDir().toLowerCase()) delete nextSettings.assetsDir;
  else nextSettings.assetsDir = newDir;
  vault.writeFileAtomic(destinationIndex, Buffer.from(JSON.stringify(newAssets, null, 1)));
  if (JSON.stringify(parseAssetIndex(vault.readFile(destinationIndex), 'Encrypted destination index')) !== JSON.stringify(newAssets)) {
    throw new Error('Encrypted destination index failed verification');
  }
  vault.writeFileAtomic(settingsFile, Buffer.from(JSON.stringify(nextSettings)));
  if (JSON.stringify(parseSettings(vault.readFile(settingsFile), 'Encrypted CaptureBox settings')) !== JSON.stringify(nextSettings)) {
    throw new Error('Encrypted CaptureBox settings failed verification');
  }
  await vault.writeState(newDir);
  assetsDir = newDir;
  indexFile = destinationIndex;
  assets = newAssets;
  settings = nextSettings;
  for (const asset of oldAssets) {
    for (const file of [path.join(oldDir, `${asset.id}.cbx`), path.join(oldDir, `${asset.id}.thumb.cbx`)]) {
      try { vault.removeFile(file); } catch { /* destination is verified; clean up on a later move if needed */ }
    }
  }
  try { vault.removeFile(path.join(oldDir, 'index.cbx')); } catch { /* old encrypted index is no longer active */ }
  storeError = '';
  return { ok: true };
}

async function makeThumbnailBytes(bytes) {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('CaptureBox thumbnail source image is invalid');
  return (image.getSize().width > 360 ? image.resize({ width: 360, quality: 'good' }) : image).toPNG();
}

function writeTemporaryExport(id) {
  assertStoreReady();
  if (!/^[a-z0-9]{6,32}$/i.test(id)) throw new Error('Invalid CaptureBox asset ID');
  fs.mkdirSync(temporaryExportsDir, { recursive: true });
  const filePath = path.join(temporaryExportsDir, `${id}-${crypto.randomUUID()}.png`);
  fs.writeFileSync(filePath, readAsset(id), { flag: 'wx', mode: 0o600 });
  return filePath;
}

function clearTemporaryExports() {
  if (!temporaryExportsDir) return;
  try { fs.rmSync(temporaryExportsDir, { recursive: true, force: true }); } catch { /* retry at next launch */ }
}
const storeInfo = () => ({ ready: storeReady, dir: assetsDir || '', isDefault: !!assetsDir && assetsDir.toLowerCase() === defaultDir().toLowerCase(), error: storeError, count: assets.length });
const assertStoreReady = () => { if (!storeReady || !vault) throw new Error(storeError || 'CaptureBox 보관함을 먼저 복구해야 합니다'); };
const assertStoreMutable = () => {
  assertStoreReady();
  if (storeTransition) throw new Error('CaptureBox 보관함 폴더를 옮기는 중입니다. 잠시 후 다시 시도해 주세요.');
};
const imgPath = (id) => path.join(assetsDir, `${id}.cbx`);
const thumbPath = (id) => path.join(assetsDir, `${id}.thumb.cbx`);
const readAsset = (id) => { assertStoreReady(); return vault.readFile(imgPath(id)); };
const readThumbnail = (id) => { assertStoreReady(); return vault.readFile(thumbPath(id)); };
const saveIndex = () => {
  assertStoreMutable();
  const bytes = Buffer.from(JSON.stringify(assets, null, 1));
  vault.writeFileAtomic(indexFile, bytes);
  if (!vault.readFile(indexFile).equals(bytes)) throw new Error('Encrypted CaptureBox index failed verification');
};
const saveSettings = () => {
  assertStoreMutable();
  const bytes = Buffer.from(JSON.stringify(settings));
  vault.writeFileAtomic(settingsFile, bytes);
  if (!vault.readFile(settingsFile).equals(bytes)) throw new Error('Encrypted CaptureBox settings failed verification');
};
function assetExportBytes(id, format) {
  const imageBytes = readAsset(id);
  if (format === 'png') return imageBytes;
  if (format === 'jpg' || format === 'jpeg') {
    const image = nativeImage.createFromBuffer(imageBytes);
    if (image.isEmpty()) throw new Error('이미지를 읽을 수 없습니다');
    return image.toJPEG(92);
  }
  throw new Error('지원하지 않는 이미지 형식입니다');
}

const view = (a) => ({ ...a, url: `capturebox-asset://asset/${encodeURIComponent(a.id)}?kind=image`, thumbUrl: `capturebox-asset://asset/${encodeURIComponent(a.id)}?kind=thumb` });
const findAsset = (id) => typeof id === 'string' && /^[a-z0-9]{6,32}$/i.test(id) ? assets.find((a) => a.id === id) : undefined;
function reportAssetError(id, error) {
  const asset = findAsset(id);
  if (win && !win.isDestroyed()) {
    win.webContents.send('assets:changed', { toast: `${asset ? asset.name : '캡처'} 이미지를 사용할 수 없습니다: ${error.message}` });
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

function addAsset(img, mode) {
  assertStoreMutable();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const { width, height } = img.getSize();
  try {
    vault.writeFileAtomic(imgPath(id), img.toPNG());
    const thumb = width > 360 ? img.resize({ width: 360, quality: 'good' }) : img;
    vault.writeFileAtomic(thumbPath(id), thumb.toPNG());
    const asset = { id, name: `${MODE_LABEL[mode]} ${stamp()}`, mode, width, height, createdAt: Date.now() };
    assets.unshift(asset);
    try { saveIndex(); } catch (error) { assets.shift(); throw error; }
    return asset;
  } catch (error) {
    vault.removeFile(imgPath(id));
    vault.removeFile(thumbPath(id));
    throw error;
  }
}

/* ---------- 클립보드 (Electron 44+는 비동기 ClipboardItem API) ---------- */
async function copyImage(img) {
  if (typeof clipboard.writeImage === 'function') return clipboard.writeImage(img);
  const blob = new Blob([img.toPNG()], { type: 'image/png' });
  await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/* ---------- 화면 캡처 ---------- */
async function grabDisplay(d) {
  const sf = d.scaleFactor;
  const srcs = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) },
  });
  const all = screen.getAllDisplays();
  const s = srcs.find((x) => x.display_id === String(d.id)) || srcs[all.findIndex((x) => x.id === d.id)] || srcs[0];
  return s.thumbnail;
}

/* ---------- 알림 배지 (카운트다운 / 스크롤 진행) ---------- */
function createBadge(display, avoid) {
  const w = 220, h = 52, m = 12;
  const b = display.workArea;
  const corners = [
    { x: b.x + b.width - w - m, y: b.y + m },
    { x: b.x + m, y: b.y + m },
    { x: b.x + b.width - w - m, y: b.y + b.height - h - m },
    { x: b.x + m, y: b.y + b.height - h - m },
  ];
  const hit = (c) => avoid && c.x < avoid.x + avoid.width && c.x + w > avoid.x && c.y < avoid.y + avoid.height && c.y + h > avoid.y;
  const pos = corners.find((c) => !hit(c));
  if (!pos) return { set() {}, close() {} };
  const bw = new BrowserWindow({
    x: pos.x, y: pos.y, width: w, height: h, frame: false, resizable: false, focusable: false,
    skipTaskbar: true, alwaysOnTop: true, show: false, webPreferences: { sandbox: true },
  });
  bw.setAlwaysOnTop(true, 'screen-saver');
  const html = '<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;' +
    'background:#1f2430;color:#fff;font:600 16px \'Segoe UI\',\'Malgun Gothic\',sans-serif;border:1px solid #4c8dff;box-sizing:border-box"></body>';
  bw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).then(() => bw.showInactive());
  return {
    set: (t) => { if (!bw.isDestroyed()) bw.webContents.executeJavaScript(`document.body.textContent=${JSON.stringify(t)}`).catch(() => {}); },
    close: () => { if (!bw.isDestroyed()) bw.destroy(); },
  };
}

/* ---------- 영역 선택 오버레이 ---------- */
const overlayCtx = new Map();
let finishPick = null;

function pickRegion(mode) {
  return new Promise(async (resolve) => {
    const displays = screen.getAllDisplays();
    const shots = await Promise.all(displays.map(grabDisplay));
    const wins = [];
    let settled = false;
    finishPick = (val) => {
      if (settled) return;
      settled = true;
      finishPick = null;
      overlayCtx.clear();
      wins.forEach((w) => !w.isDestroyed() && w.destroy());
      resolve(val);
    };
    displays.forEach((d, i) => {
      const w = new BrowserWindow({
        x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
        frame: false, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true,
        fullscreenable: false, show: false, enableLargerThanScreen: true,
        transparent: true, backgroundColor: '#00000000',   // 이미지가 그려지기 전 첫 프레임이 검게 번쩍이지 않도록 투명
        webPreferences: { preload: path.join(__dirname, 'ui', 'overlay-preload.js'), sandbox: true },
      });
      w.setAlwaysOnTop(true, 'screen-saver');
      w.setBounds(d.bounds);
      overlayCtx.set(w.webContents.id, { display: d, shot: shots[i], win: w });
      w.loadFile(path.join(__dirname, 'ui', 'overlay.html'));
      w.webContents.once('did-finish-load', () => {
        // JPEG가 PNG보다 훨씬 빨리 인코딩된다(표시용).
        w.webContents.send('overlay:init', { shot: 'data:image/jpeg;base64,' + shots[i].toJPEG(92).toString('base64'), mode });
        w.show();
        w.focus();
      });
      wins.push(w);
    });
  });
}

ipcMain.on('overlay:done', (e, rect) => {
  const ctx = overlayCtx.get(e.sender.id);
  if (!ctx || !finishPick) return;
  const sf = ctx.display.scaleFactor;
  const full = ctx.shot.getSize();
  const x = Math.max(0, Math.round(rect.x * sf));
  const y = Math.max(0, Math.round(rect.y * sf));
  const crop = {
    x, y,
    width: Math.max(1, Math.min(full.width - x, Math.round(rect.w * sf))),
    height: Math.max(1, Math.min(full.height - y, Math.round(rect.h * sf))),
  };
  finishPick({ display: ctx.display, rect, shot: ctx.shot, crop });
});
ipcMain.on('overlay:cancel', () => finishPick && finishPick(null));

/* ---------- 스크롤 캡처 ---------- */
// 설치본에서는 PowerShell이 app.asar 안의 파일을 읽지 못하므로 압축 해제된 위치(app.asar.unpacked)를 쓴다.
const unpackedPath = (f) => path.join(__dirname, f).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function startInput() {
  return new Promise((resolve, reject) => {
    // 설치본에서는 app.asar 안의 파일을 PowerShell이 읽지 못하므로 압축 해제된 위치(app.asar.unpacked)를 쓴다.
    const script = unpackedPath('input.ps1');
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true,
    });
    let buf = '';
    const waiters = [];
    let ready = false;
    ps.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'ready' && !ready) {
          ready = true;
          resolve(api);
        } else if (waiters.length) waiters.shift()();
      }
    });
    ps.on('error', reject);
    ps.on('exit', () => { if (!ready) reject(new Error('입력 도우미를 시작하지 못했습니다')); waiters.splice(0).forEach((w) => w()); });
    const api = {
      send: (cmd) => new Promise((r) => { waiters.push(r); ps.stdin.write(cmd + '\n'); }),
      close: () => { try { ps.stdin.write('quit\n'); ps.stdin.end(); } catch { /* 이미 종료 */ } },
    };
  });
}

async function scrollCapture(sel, log) {
  const { display: d, rect, crop } = sel;   // log: 진단용 배열(선택). 단계마다 상태를 기록한다
  const sf = d.scaleFactor;
  const regionDip = { x: d.bounds.x + rect.x, y: d.bounds.y + rect.y, width: rect.w, height: rect.h };
  const center = screen.dipToScreenPoint({ x: regionDip.x + rect.w / 2, y: regionDip.y + rect.h / 2 });

  const badge = createBadge(d, regionDip);
  badge.set('스크롤 캡처 준비 중…');
  let input;
  try {
    input = await startInput();
    await input.send(`move ${Math.round(center.x)} ${Math.round(center.y)}`);
    await sleep(300);

    const grabCrop = async () => {
      const c = (await grabDisplay(d)).crop(crop);
      const { width, height } = c.getSize();
      return { data: c.toBitmap(), width, height };
    };
    const first = await grabCrop();
    const st = new Stitcher(first);
    const target = 0.6 * first.height;
    let notches = 2;
    let step = 0;
    let nudges = 0;

    for (let guard = 0; guard < 120; guard++) {
      await input.send(`wheel ${-notches}`);
      await sleep(450);
      let r = st.add(await grabCrop());
      if (log) log.push(`g${guard} wheel${-notches} → ${r.status}${r.shift ? ' shift=' + r.shift : ''}${r.score !== undefined ? ' score=' + r.score.toFixed(2) : ''}`);

      if (r.status === 'end') { // 스크롤 애니메이션·렌더링 지연일 수 있어 여러 번 더 기다리며 확인 (진짜 끝일 때만 약 2초 더 걸림)
        for (let k = 0; k < 3 && r.status === 'end'; k++) {
          await sleep(700);
          r = st.add(await grabCrop());
          if (log) log.push(`   재확인${k + 1} → ${r.status}${r.shift ? ' shift=' + r.shift : ''}`);
        }
        // 아직 한 번도 스크롤되지 않았다면 첫 휠이 창에 전달되지 않았을 수 있다 — 커서를 살짝 흔들어 다시 시도한다
        if (r.status === 'end' && step === 0 && nudges < 2) {
          nudges++;
          await input.send(`move ${Math.round(center.x) + 2} ${Math.round(center.y) + 2}`);
          await input.send(`move ${Math.round(center.x)} ${Math.round(center.y)}`);
          await sleep(300);
          continue;
        }
        if (r.status === 'end') break;
      }
      if (r.status === 'limit') break;
      if (r.status === 'nomatch') {
        if (notches <= 1) break;
        await input.send(`wheel ${notches}`); // 되돌린 뒤 더 작게 재시도
        await sleep(450);
        notches = Math.max(1, Math.floor(notches / 2));
        continue;
      }
      step++;
      badge.set(`스크롤 캡처 중… ${step}`);
      notches = Math.max(1, Math.min(30, Math.round((target / r.shift) * notches)));
    }

    const out = st.result();
    return nativeImage.createFromBitmap(out.data, { width: out.width, height: out.height });
  } finally {
    badge.close();
    if (input) input.close();
  }
}

/* ---------- 캡처 흐름 ---------- */
async function prepare(delay) {
  win.hide();
  if (delay > 0) {
    const badge = createBadge(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
    for (let t = delay; t > 0; t--) {
      badge.set(`${t}초 후 캡처…`);
      await sleep(1000);
    }
    badge.close();
  }
  await sleep(300);
}

/* 클립보드 전용: 에셋에는 저장하되 대시보드는 열지 않은 채 복사하고, 작은 배지로 알린다. */
async function finishClipOnly(img, mode) {
  const a = addAsset(img, mode);
  await copyImage(img);
  win.webContents.send('assets:changed', { select: a.id });
  const badge = createBadge(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
  badge.set('클립보드에 복사됨');
  setTimeout(() => badge.close(), 1300);
}

async function finish(img, mode) {
  if (settings.clipOnly) return finishClipOnly(img, mode);
  const a = addAsset(img, mode);
  if (settings.autoCopy) await copyImage(img);
  win.show();
  win.focus();
  win.webContents.send('assets:changed', { select: a.id, toast: settings.autoCopy ? '캡처 완료 · 클립보드에 복사됨' : '캡처 완료' });
}

async function runCapture(mode, delay = 0) {
  if (storeTransition) {
    if (win && !win.isDestroyed()) win.webContents.send('assets:changed', { toast: '보관함 폴더를 옮기는 중입니다. 잠시 후 다시 시도해 주세요.' });
    return false;
  }
  if (!storeReady) {
    if (win && !win.isDestroyed()) win.webContents.send('assets:changed', { toast: storeError || '보관함을 먼저 복구해 주세요' });
    return false;
  }
  if (busy) return;
  busy = true;
  let done = false;
  const wasVisible = win.isVisible();
  try {
    await prepare(delay);
    if (mode === 'fullscreen') {
      const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      await finish(await grabDisplay(d), mode);
      done = true;
    } else {
      const sel = await pickRegion(mode);
      if (sel) {
        await sleep(250);
        const img = mode === 'region' ? sel.shot.crop(sel.crop) : await scrollCapture(sel);
        await finish(img, mode);
        done = true;
      }
    }
  } catch (err) {
    win.webContents.send('assets:changed', { toast: `캡처 실패: ${err.message}` });
  } finally {
    busy = false;
    // 클립보드 전용이면 취소해도 대시보드를 새로 띄우지 않는다(원래 열려 있었던 경우만 복원).
    if (!done && !win.isDestroyed() && (!settings.clipOnly || wasVisible)) { win.show(); win.focus(); }
  }
}

/* ---------- IPC ---------- */
ipcMain.handle('assets:list', () => storeReady ? assets.map(view) : []);
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => {
  assertStoreMutable();
  const previous = settings;
  settings = { ...settings, ...patch };
  try { saveSettings(); } catch (error) { settings = previous; throw error; }
  return settings;
});
ipcMain.handle('capture:start', (_e, mode, delay) => { assertStoreMutable(); return runCapture(mode, Number(delay) || 0); });

ipcMain.handle('windows:list', async () => {
  const srcs = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 420, height: 280 } });
  return srcs
    .filter((s) => s.name && s.name !== win.getTitle() && !s.thumbnail.isEmpty())
    .map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
});

ipcMain.handle('capture:window', async (_e, id) => {
  assertStoreMutable();
  const srcs = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 3840, height: 2160 } });
  const s = srcs.find((x) => x.id === id);
  if (!s || s.thumbnail.isEmpty()) return { ok: false, message: '창을 캡처할 수 없습니다 (최소화된 창일 수 있어요)' };
  const a = addAsset(s.thumbnail, 'window');
  const copied = settings.autoCopy || settings.clipOnly;
  if (copied) await copyImage(s.thumbnail);
  return { ok: true, select: a.id, toast: copied ? '창 캡처 완료 · 클립보드에 복사됨' : '창 캡처 완료' };
});

ipcMain.handle('asset:rename', (_e, id, name) => {
  assertStoreMutable();
  const a = findAsset(id);
  if (a && typeof name === 'string' && name.trim()) {
    const previous = a.name;
    a.name = name.trim().slice(0, 120);
    try { saveIndex(); } catch (error) { a.name = previous; throw error; }
  }
});
ipcMain.handle('asset:delete', (_e, id) => {
  assertStoreMutable();
  const i = assets.findIndex((a) => a.id === id);
  if (i < 0) return;
  const [removed] = assets.splice(i, 1);
  try { saveIndex(); } catch (error) { assets.splice(i, 0, removed); throw error; }
  for (const f of [imgPath(id), thumbPath(id)]) vault.removeFile(f);
});
ipcMain.handle('assets:deleteMany', (_e, ids) => {
  assertStoreMutable();
  const set = new Set(Array.isArray(ids) ? ids : []);
  const gone = assets.filter((a) => set.has(a.id));
  if (!gone.length) return 0;
  const previous = assets;
  assets = assets.filter((a) => !set.has(a.id));
  try { saveIndex(); } catch (error) { assets = previous; throw error; }
  for (const a of gone) for (const f of [imgPath(a.id), thumbPath(a.id)]) vault.removeFile(f);
  return gone.length;
});
ipcMain.handle('asset:copy', async (_e, id) => {
  assertStoreReady();
  if (!findAsset(id)) return;
  try { await copyImage(nativeImage.createFromBuffer(readAsset(id))); return true; }
  catch (error) { reportAssetError(id, error); return false; }
});
ipcMain.handle('asset:save', async (_e, id) => {
  assertStoreReady();
  const a = findAsset(id);
  if (!a) return false;
  try {
    const r = await dialog.showSaveDialog(win, {
      // 이름 속 점(시각 22.11.12 등)은 윈도우가 확장자로 착각해 .png/.jpg 가 붙지 않을 수 있으므로 쓰지 않는다.
      defaultPath: a.name.replace(/[\\/:*?"<>|.]/g, '-') + '.png',
      filters: [{ name: 'PNG', extensions: ['png'] }, { name: 'JPEG', extensions: ['jpg', 'jpeg'] }],
    });
    if (r.canceled || !r.filePath) return false;
    let out = r.filePath;
    if (!/\.(png|jpe?g)$/i.test(out)) out += '.png';
    fs.writeFileSync(out, /\.jpe?g$/i.test(out) ? assetExportBytes(id, 'jpeg') : assetExportBytes(id, 'png'));
    return true;
  } catch (error) {
    reportAssetError(id, error);
    return false;
  }
});
ipcMain.handle('asset:dataUrl', (_e, id) => {
  assertStoreReady();
  if (!findAsset(id)) return null;
  try { return 'data:image/png;base64,' + readAsset(id).toString('base64'); }
  catch (error) { reportAssetError(id, error); return null; }
});
ipcMain.handle('asset:addEdited', (_e, baseId, dataUrl) => {
  assertStoreMutable();
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) return null;
  const base = findAsset(baseId);
  const a = addAsset(img, 'edit');
  if (base) { a.name = `${base.name} (편집)`; saveIndex(); }
  return a.id;
});
ipcMain.handle('asset:print', (_e, id) => {
  assertStoreReady();
  if (!findAsset(id)) return { ok: false };
  const w = new BrowserWindow({
    width: 1000, height: 820, minWidth: 600, minHeight: 500, title: '인쇄 미리보기',
    parent: win || undefined, autoHideMenuBar: true, icon: path.join(__dirname, 'ui', 'icon.png'),
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  w.loadFile(path.join(__dirname, 'ui', 'print.html'), { query: { src: `capturebox-asset://asset/${encodeURIComponent(id)}?kind=image` } });
  return { ok: true, preview: true };
});
ipcMain.handle('asset:reveal', (_e, id) => {
  assertStoreReady();
  if (!findAsset(id)) return false;
  try { shell.showItemInFolder(writeTemporaryExport(id)); return true; }
  catch (error) { reportAssetError(id, error); return false; }
});
ipcMain.on('asset:drag', (e, id) => {
  try {
    assertStoreReady();
    if (!findAsset(id)) return;
    const filePath = writeTemporaryExport(id);
    const thumbnail = nativeImage.createFromBuffer(readThumbnail(id));
    e.sender.startDrag({ file: filePath, icon: thumbnail.resize({ width: 96 }) });
  } catch (error) {
    if (win && !win.isDestroyed()) win.webContents.send('assets:changed', { toast: `파일을 끌어 놓을 수 없습니다: ${error.message}` });
  }
});

/* ---------- 자동 업데이트 (GitHub Releases, 설치본에서만 동작) ---------- */
let updater = null;
try { updater = require('electron-updater').autoUpdater; } catch { /* 개발 환경: 미설치 */ }
let upd = { state: 'idle', version: app.getVersion() };
function sendUpdate(patch) {
  upd = { ...upd, ...patch };
  if (win && !win.isDestroyed()) win.webContents.send('update:status', upd);
}
function friendlyError(e) {
  const m = String((e && e.message) || e || '');
  if (/\b404\b/.test(m)) return '배포된 릴리즈를 찾을 수 없습니다';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::|network/i.test(m)) return '네트워크에 연결할 수 없습니다';
  if (/\b(401|403)\b/.test(m)) return '릴리즈에 접근할 수 없습니다';
  return m.split(/\r?\n/)[0].slice(0, 80);
}
let lastCheck = 0;
let startupRetries = 4;
function checkUpdate() {
  if (isStore) return sendUpdate({ state: 'store' });
  if (!app.isPackaged || !updater) return sendUpdate({ state: 'dev' });
  if (['checking', 'downloading', 'ready'].includes(upd.state)) return;
  lastCheck = Date.now();
  sendUpdate({ state: 'checking', message: '' });
  updater.checkForUpdates().catch(() => { /* 'error' 이벤트에서 처리 */ });
}
// Microsoft Store(MSIX) 버전: 업데이트는 Store 가 맡는다 (자체 업데이트는 Store 정책상 쓰지 않는다).
// CB_FORCE_STORE=1 은 자체 검증에서 Store 동작을 흉내 내기 위한 값이다.
const isStore = !!process.windowsStore || process.env.CB_FORCE_STORE === '1';
function initUpdater() {
  if (isStore) { upd.state = 'store'; return; }
  if (!app.isPackaged || !updater) { upd.state = 'dev'; return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-available', (i) => sendUpdate({ state: 'downloading', latest: i.version, percent: 0 }));
  updater.on('update-not-available', () => { startupRetries = 0; sendUpdate({ state: 'latest' }); });
  updater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (i) => { startupRetries = 0; sendUpdate({ state: 'ready', latest: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes : '' }); });
  updater.on('error', (e) => {
    sendUpdate({ state: 'error', message: friendlyError(e) });
    // 시작 직후 네트워크가 아직 준비되지 않았을 수 있어 몇 번 재시도한다.
    if (startupRetries > 0) { startupRetries--; setTimeout(checkUpdate, 15000); }
  });
  // 앱이 뜨자마자 바로 확인 (창이 로드되면 즉시), 이후 3분마다·창을 다시 켤 때마다 확인
  const first = () => setTimeout(checkUpdate, 500);
  if (win && !win.webContents.isLoading()) first(); else if (win) win.webContents.once('did-finish-load', first);
  setInterval(checkUpdate, 3 * 60 * 1000);
  if (win) win.on('focus', () => { if (Date.now() - lastCheck > 60 * 1000) checkUpdate(); });
}
ipcMain.handle('store:get', () => storeInfo());
ipcMain.handle('store:retry', async () => {
  const status = await retryStore();
  if (status.ready) {
    registerHotkeys();
    buildTrayMenu();
  }
  if (win && !win.isDestroyed()) win.webContents.send('store:status', status);
  return status;
});
ipcMain.handle('store:quit', () => { quitting = true; app.quit(); });
ipcMain.handle('store:choose', async () => {
  assertStoreMutable();
  const r = await dialog.showOpenDialog(win, { title: '저장할 폴더 선택', defaultPath: assetsDir, properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true, ...storeInfo() };
  try { await moveStore(r.filePaths[0]); } catch (e) { return { ok: false, message: e.message, ...storeInfo() }; }
  win.webContents.send('assets:changed', {});
  return { ok: true, ...storeInfo() };
});
ipcMain.handle('store:reset', async () => {
  assertStoreMutable();
  try { await moveStore(defaultDir()); } catch (e) { return { ok: false, message: e.message, ...storeInfo() }; }
  win.webContents.send('assets:changed', {});
  return { ok: true, ...storeInfo() };
});
ipcMain.handle('store:open', () => { assertStoreReady(); return shell.openPath(assetsDir); });
ipcMain.handle('notices:open', async () => {
  const noticePath = app.isPackaged
    ? path.join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt')
    : path.join(__dirname, 'store', 'THIRD_PARTY_NOTICES.txt');
  const error = await shell.openPath(noticePath);
  return error ? { ok: false, message: error } : { ok: true };
});
ipcMain.handle('privacy:open', async () => {
  const policyPath = app.isPackaged
    ? path.join(process.resourcesPath, 'privacy-policy-ko.txt')
    : path.join(__dirname, 'store', 'privacy-policy-ko.txt');
  const error = await shell.openPath(policyPath);
  return error ? { ok: false, message: error } : { ok: true };
});
ipcMain.handle('update:get', () => upd);
ipcMain.handle('update:check', () => checkUpdate());
ipcMain.handle('update:install', () => { if (updater && upd.state === 'ready') updater.quitAndInstall(true, true); });

/* ---------- 글자 인식 (Windows 내장 OCR) ---------- */
function runPowerShell(script, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { ps.kill(); reject(new Error('글자 인식 시간이 초과되었습니다')); }, timeoutMs);
    ps.stdout.on('data', (c) => { out += c.toString('utf8'); });
    ps.stderr.on('data', (c) => { err += c.toString('utf8'); });
    ps.on('error', (e) => { clearTimeout(timer); reject(e); });
    ps.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split(/\r?\n/)[0] || '글자 인식에 실패했습니다'));
    });
  });
}
// ── Windows 내장 OCR: 설치가 필요 없고 빠르지만, 작은 글자·한글에서 정확도가 떨어진다 (대체 수단)
// 긴 이미지(스크롤 캡처)는 세로로 나눠서 인식한다. OCR 엔진의 한 변 한도는 10000px.
async function ocrWindows(img) {
  let src = img;
  let { width, height } = src.getSize();
  if (width > 9000) { src = src.resize({ width: 9000 }); ({ width, height } = src.getSize()); }
  if (Math.max(width, height) < 600) { src = src.resize({ width: width * 2, height: height * 2, quality: 'best' }); ({ width, height } = src.getSize()); }
  const tmp = fs.mkdtempSync(path.join(temporaryExportsDir, 'ocr-'));
  try {
    const CH = 3500;
    const files = [];
    for (let y = 0, i = 0; y < height; y += CH, i++) {
      const part = height <= CH ? src : src.crop({ x: 0, y, width, height: Math.min(CH, height - y) });
      const f = path.join(tmp, `p${i}.png`);
      fs.writeFileSync(f, part.toPNG());
      files.push(f);
    }
    const out = await runPowerShell(unpackedPath('ocr.ps1'), files, 120000);
    return out.split('<<<CB-CHUNK>>>').map((c) => c.replace(/\r/g, '').trim()).filter(Boolean).join('\n').trim();
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 무시 */ }
  }
}

// ── 정밀 OCR (PP-OCRv5 한국어, ONNX Runtime CPU). 기본 방식이며, 쓸 수 없으면 Windows OCR 로 대체한다.
const ocrModelDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'models', 'ppocr') : path.join(__dirname, 'models', 'ppocr'));
let preciseEngine = null;
let preciseQueue = Promise.resolve();
function getPrecise() {
  if (!preciseEngine) {
    preciseEngine = (async () => {
      const dir = ocrModelDir();
      for (const f of ['det.onnx', 'rec_korean.onnx', 'rec_korean.yml']) {
        if (!fs.existsSync(path.join(dir, f))) throw new Error(`정밀 모드 모델 파일이 없습니다 (${f}). 개발 중이면 npm run models 를 실행하세요`);
      }
      const ort = require('onnxruntime-node');
      return require('./ppocr').PpOcr.create({ modelDir: dir, ort });
    })().catch((e) => { preciseEngine = null; throw e; });
  }
  return preciseEngine;
}
const preciseStatus = () => {
  const dir = ocrModelDir();
  return ['det.onnx', 'rec_korean.onnx', 'rec_korean.yml'].every((f) => fs.existsSync(path.join(dir, f)));
};
// 긴 이미지는 세로로 잘라 인식한다. 자르는 위치는 배경만 있는 가로줄(글자를 가르지 않도록)에서 고른다.
function pickCut(img, y0, want, width) {
  const search = Math.min(220, Math.floor(want / 4));
  const from = y0 + want - search;
  const strip = img.crop({ x: 0, y: from, width, height: search }).toBitmap();   // BGRA
  let bestRow = search - 1, bestVar = Infinity;
  for (let r = search - 1; r >= 0; r--) {
    let mn = 255, mx = 0;
    for (let x = 0; x < width; x += 4) {
      const o = (r * width + x) * 4;
      const g = (strip[o] + strip[o + 1] + strip[o + 2]) / 3;
      if (g < mn) mn = g; if (g > mx) mx = g;
    }
    if (mx - mn < bestVar) { bestVar = mx - mn; bestRow = r; }
    if (bestVar < 6) break;
  }
  return from + bestRow + 1 - y0;
}
async function ocrPrecise(img) {
  const run = async () => {
    const eng = await getPrecise();
    const { width, height } = img.getSize();
    const TILE = Math.max(1600, Math.min(2600, width));
    const parts = [];
    for (let y = 0; y < height;) {
      let h = Math.min(TILE, height - y);
      if (height - y > TILE * 1.15) h = pickCut(img, y, TILE, width); else h = height - y;
      const tile = y === 0 && h === height ? img : img.crop({ x: 0, y, width, height: h });
      const r = await eng.recognize({ data: tile.toBitmap(), width, height: h, bgra: true });
      if (r.text) parts.push(r.text);
      y += h;
    }
    return parts.join('\n').trim();
  };
  const p = preciseQueue.then(run, run);   // 한 번에 하나씩 (CPU·메모리 폭주 방지)
  preciseQueue = p.catch(() => {});
  return p;
}

/** mode: 'precise' | 'windows' (생략하면 설정값, 기본 정밀). 정밀이 실패하면 Windows OCR 로 대체한다 */
async function ocrImage(img, mode) {
  const want = mode || settings.ocrMode || 'precise';
  if (want === 'precise') {
    try { return { text: await ocrPrecise(img), engine: 'precise', note: '' }; } catch (e) {
      const note = `정밀 모드를 쓸 수 없어 Windows OCR 로 대체했습니다 (${String(e.message).split('\n')[0].slice(0, 120)})`;
      return { text: await ocrWindows(img), engine: 'windows', note };
    }
  }
  return { text: await ocrWindows(img), engine: 'windows', note: '' };
}
ipcMain.handle('asset:ocr', async (_e, id) => {
  assertStoreReady();
  if (!findAsset(id)) return { ok: false, message: '이미지를 찾을 수 없습니다' };
  try {
    const r = await ocrImage(nativeImage.createFromBuffer(readAsset(id)));
    if (!r.text) return { ok: true, text: '', engine: r.engine, message: '인식된 글자가 없습니다' };
    clipboard.writeText(r.text);
    return { ok: true, text: r.text, engine: r.engine, note: r.note };
  } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('ocr:get', () => ({ mode: settings.ocrMode || 'precise', preciseAvailable: preciseStatus() }));
ipcMain.handle('ocr:set', (_e, mode) => {
  assertStoreMutable();
  settings.ocrMode = mode === 'windows' ? 'windows' : 'precise';
  saveSettings();
  return { mode: settings.ocrMode, preciseAvailable: preciseStatus() };
});
ipcMain.handle('text:copy', (_e, text) => { clipboard.writeText(String(text || '')); return true; });

/* ---------- 화면에 고정 (핀) ---------- */
const pins = new Set();
const pinAnchor = new Map();
const pinSizes = new Map();   // 핀마다 "의도한" 크기. getBounds() 는 배율 환산 반올림으로 ±1px 달라질 수 있어 기준으로 쓰지 않는다
function createPin(id) {
  assertStoreReady();
  const a = findAsset(id);
  if (!a) return null;
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  let w = a.width / d.scaleFactor;
  let h = a.height / d.scaleFactor;
  const k = Math.min(1, 560 / w, 420 / h);
  w = Math.max(100, Math.round(w * k));
  h = Math.max(70, Math.round(h * k));
  const off = (pins.size % 6) * 28;
  const px = d.workArea.x + d.workArea.width - w - 24 - off, py = d.workArea.y + 24 + off;
  const pw = new BrowserWindow({
    x: px, y: py,
    width: w, height: h, useContentSize: true, frame: false, resizable: true, minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: true, backgroundColor: '#1f2430',
    webPreferences: { preload: path.join(__dirname, 'ui', 'pin-preload.js'), sandbox: true },
  });
  pw.setAlwaysOnTop(true, 'screen-saver');
  pw.setAspectRatio(w / h);
  setPinBounds(pw, px, py, w, h);   // 만들 때 배율 환산으로 몇 px 어긋나는 것을 바로잡는다
  pins.add(pw);
  pinSizes.set(pw.id, { w, h });
  const wid = pw.id;
  pw.on('closed', () => { pins.delete(pw); pinAnchor.delete(wid); pinSizes.delete(wid); });
  pw.loadFile(path.join(__dirname, 'ui', 'pin.html'));
  pw.webContents.once('did-finish-load', () => {
    try { pw.webContents.send('pin:init', 'data:image/png;base64,' + readAsset(id).toString('base64')); }
    catch (error) { reportAssetError(id, error); if (!pw.isDestroyed()) pw.close(); }
  });
  return pw;
}
const pinOf = (e) => BrowserWindow.fromWebContents(e.sender);
ipcMain.handle('asset:pin', (_e, id) => !!createPin(id));
// 창 이동·확대는 위치만 바꾸지 않고 크기도 함께 명시한다. 배율이 다른 모니터를 지나거나 소수 배율(1.5배)에서 setPosition 만 쓰면
// 창 크기가 다시 계산되어 끌 때마다 커지는 문제가 있었다.
function setPinBounds(w, x, y, width, height) {
  w.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
  const nb = w.getBounds();
  if (nb.width !== width || nb.height !== height) w.setBounds({ x: Math.round(x), y: Math.round(y), width, height });   // 모니터 경계에서 한 번 더
}
ipcMain.on('pin:begin', (e) => {
  const w = pinOf(e);
  if (w) {
    const b = w.getBounds(), sz = pinSizes.get(w.id) || { w: b.width, h: b.height };
    pinAnchor.set(w.id, { x: b.x, y: b.y, width: sz.w, height: sz.h, cur: screen.getCursorScreenPoint() });
  }
});
ipcMain.on('pin:drag', (e) => {
  const w = pinOf(e); const an = w && pinAnchor.get(w.id);
  if (!an) return;
  const c = screen.getCursorScreenPoint();
  setPinBounds(w, an.x + c.x - an.cur.x, an.y + c.y - an.cur.y, an.width, an.height);
});
ipcMain.on('pin:zoom', (e, dir) => {
  const w = pinOf(e); if (!w) return;
  const b = w.getBounds(), sz = pinSizes.get(w.id) || { w: b.width, h: b.height };
  const f = dir > 0 ? 1.1 : 1 / 1.1;
  const nw = Math.max(100, Math.min(4000, Math.round(sz.w * f)));
  const nh = Math.max(70, Math.round(nw * sz.h / sz.w));
  setPinBounds(w, b.x - (nw - sz.w) / 2, b.y - (nh - sz.h) / 2, nw, nh);
  pinSizes.set(w.id, { w: nw, h: nh });
  pinAnchor.delete(w.id);   // 크기가 바뀌었으니 다음 끌기에서 기준을 다시 잡는다
});
ipcMain.on('pin:opacity', (e, dir) => {
  const w = pinOf(e); if (!w) return;
  w.setOpacity(Math.max(0.2, Math.min(1, w.getOpacity() + (dir > 0 ? 0.1 : -0.1))));
});
ipcMain.on('pin:close', (e) => { const w = pinOf(e); if (w) w.close(); });

/* ---------- 단축키 (설정에서 변경 가능) ---------- */
const DEFAULT_KEYS = { region: 'CommandOrControl+Alt+1', fullscreen: 'CommandOrControl+Alt+2', scroll: 'CommandOrControl+Alt+3' };
let hotkeyErrors = {};
const hotkeyOf = (mode) => (settings.hotkeys && settings.hotkeys[mode]) || DEFAULT_KEYS[mode];
const prettyKey = (a) => String(a).replace('CommandOrControl', 'Ctrl');
const KEY_RE = /^((Ctrl|Alt|Shift|Super)\+)+([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Up|Down|Left|Right|Space|Tab|Home|End|PageUp|PageDown|Insert|Delete)$/;
function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyErrors = {};
  for (const mode of Object.keys(DEFAULT_KEYS)) {
    let ok = false;
    try { ok = globalShortcut.register(hotkeyOf(mode), () => runCapture(mode, 0)); } catch { ok = false; }
    if (!ok) hotkeyErrors[mode] = '다른 프로그램이 사용 중이어서 등록하지 못했습니다';
  }
}
const hotkeyState = () => ({ keys: Object.fromEntries(Object.keys(DEFAULT_KEYS).map((m) => [m, prettyKey(hotkeyOf(m))])), errors: hotkeyErrors });
ipcMain.handle('hotkeys:get', () => hotkeyState());
ipcMain.handle('hotkeys:set', (_e, mode, combo) => {
  assertStoreMutable();
  if (!DEFAULT_KEYS[mode]) return { ok: false, message: '알 수 없는 항목입니다', ...hotkeyState() };
  if (!KEY_RE.test(String(combo))) return { ok: false, message: 'Ctrl, Alt, Shift 중 하나 이상과 일반 키를 함께 눌러 주세요', ...hotkeyState() };
  const accel = String(combo).replace(/^Ctrl/, 'CommandOrControl').replace(/\+Ctrl\b/, '+CommandOrControl');
  const same = Object.keys(DEFAULT_KEYS).find((m) => m !== mode && hotkeyOf(m).toLowerCase() === accel.toLowerCase());
  if (same) return { ok: false, message: '이미 다른 기능에 지정된 단축키입니다', ...hotkeyState() };
  const prev = hotkeyOf(mode);
  globalShortcut.unregister(prev);
  let ok = false;
  try { ok = globalShortcut.register(accel, () => runCapture(mode, 0)); } catch { ok = false; }
  if (!ok) {
    try { globalShortcut.register(prev, () => runCapture(mode, 0)); } catch { /* 무시 */ }
    return { ok: false, message: '다른 프로그램이 사용 중이어서 등록하지 못했습니다', ...hotkeyState() };
  }
  settings.hotkeys = { ...(settings.hotkeys || {}), [mode]: accel };
  delete hotkeyErrors[mode];
  saveSettings();
  buildTrayMenu();
  return { ok: true, ...hotkeyState() };
});
ipcMain.handle('hotkeys:reset', () => {
  assertStoreMutable();
  delete settings.hotkeys;
  saveSettings();
  registerHotkeys();
  buildTrayMenu();
  return { ok: !Object.keys(hotkeyErrors).length, message: Object.keys(hotkeyErrors).length ? '일부 기본 단축키를 다른 프로그램이 사용 중입니다' : '', ...hotkeyState() };
});

/* ---------- 윈도우 시작 시 자동 실행 (설치본에서만) ---------- */
const LOGIN_ARGS = ['--hidden'];
// MSIX(Store) 패키지에서는 레지스트리 쓰기가 가상화되어 Run 키 방식의 자동 실행이 동작하지 않으므로 Store 버전에서는 쓰지 않는다.
const loginState = () => ({
  supported: app.isPackaged && !isStore,
  store: isStore,
  enabled: app.isPackaged && !isStore ? app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin : false,
});
ipcMain.handle('login:get', () => loginState());
ipcMain.handle('login:set', (_e, on) => {
  if (isStore) return { ...loginState(), message: 'Microsoft Store 버전에서는 지원하지 않습니다' };
  if (!app.isPackaged) return { ...loginState(), message: '설치본에서만 사용할 수 있습니다' };
  app.setLoginItemSettings({ openAtLogin: !!on, args: LOGIN_ARGS });
  return loginState();
});

/* ---------- 트레이 상주 ---------- */
let tray = null;
let quitting = false;
function showWin() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 32, height: 32 });
  tray = new Tray(icon);
  tray.setToolTip('CaptureBox');
  buildTrayMenu();
  tray.on('click', showWin);
}
function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'CaptureBox 열기', click: showWin },
    { type: 'separator' },
    { label: `영역 캡처   ${prettyKey(hotkeyOf('region'))}`, click: () => runCapture('region', 0) },
    { label: `전체 화면 캡처   ${prettyKey(hotkeyOf('fullscreen'))}`, click: () => runCapture('fullscreen', 0) },
    { label: `스크롤 캡처   ${prettyKey(hotkeyOf('scroll'))}`, click: () => runCapture('scroll', 0) },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } },
  ]));
}

/* ---------- 앱 ---------- */
const startHidden = process.argv.includes('--hidden');   // 윈도우 시작 시 자동 실행: 창 없이 트레이로만 시작
function createWindow() {
  win = new BrowserWindow({
    show: !startHidden,
    width: 1280, height: 800, minWidth: 820, minHeight: 520, title: `CaptureBox v${app.getVersion()}`,
    backgroundColor: '#14171f', autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true },
  });
  win.removeMenu();
  win.on('page-title-updated', (e) => e.preventDefault());   // 제목줄에 버전을 계속 표시
  win.on('close', (e) => {
    if (quitting || !tray) return;
    if (!storeReady) { e.preventDefault(); quitting = true; app.quit(); return; }
    e.preventDefault();
    win.hide();
    if (!settings.trayNoticeShown) {
      if (!storeTransition) {
        settings.trayNoticeShown = true;
        saveSettings();
      }
      try { tray.displayBalloon({ title: 'CaptureBox', content: '트레이에서 계속 실행 중입니다. 단축키로 바로 캡처할 수 있어요. 완전히 종료하려면 트레이 아이콘을 우클릭하세요.' }); } catch { /* 무시 */ }
    }
  });
  win.on('session-end', () => { quitting = true; });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

app.whenReady().then(async () => {
  protocol.handle('capturebox-asset', createAssetProtocolHandler({
    getDirectory: () => assetsDir,
    getAssets: () => assets,
    vault: { readFile: (filePath) => { assertStoreReady(); return vault.readFile(filePath); } },
    onError: (id, error) => {
      reportAssetError(id, error);
    },
  }));
  await retryStore();
  createWindow();
  createTray();
  initUpdater();
  registerHotkeys();
  buildTrayMenu();
  // 설치본 자체 검증 모드: CB_SELFTEST=<리포트 경로> 로 실행하면 핵심 기능을 실제로 돌려 보고서를 쓴다 (npm run verify)
  if (process.env.CB_SELFTEST) {
    setTimeout(() => require('./selftest').run({
      app, screen, BrowserWindow, nativeImage, ipcMain, globalShortcut, clipboard, fs, path,
      packageUserDataDir, sharedProfileDir,
      get win() { return win; }, get tray() { return tray; }, get assets() { return assets; },
      get assetsDir() { return assetsDir; }, get indexFile() { return indexFile; }, get settingsFile() { return settingsFile; },
      get temporaryExportsDir() { return temporaryExportsDir; }, get vault() { return vault; },
      readAsset, assetExportBytes, writeTemporaryExport, clearTemporaryExports, storeInfo, moveStore,
      isStore, pins, overlayCtx, startInput, scrollCapture, grabDisplay, ocrImage, getPrecise, ocrModelDir, resetPrecise: () => { preciseEngine = null; }, createPin, runCapture, addAsset, startHidden, unpackedPath,
    }), 2000);
  }
});
app.on('second-instance', showWin);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); clearTemporaryExports(); });
app.on('window-all-closed', () => { if (!tray && !busy) app.quit(); });
