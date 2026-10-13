'use strict';
const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, clipboard, nativeImage,
  dialog, globalShortcut, shell, ClipboardItem, Tray, Menu,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { Stitcher } = require('./stitch');

if (!app.requestSingleInstanceLock()) app.quit();

const MODE_LABEL = { region: '영역', window: '창', fullscreen: '전체 화면', scroll: '스크롤', edit: '편집' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null;
let busy = false;

/* ---------- 저장소 (에셋 + 설정) ---------- */
let assetsDir, indexFile, settingsFile;
let assets = [];
let settings = { autoCopy: true };

let storeError = '';
const defaultDir = () => path.join(app.getPath('pictures'), 'Screenshots');   // 윈도우 스크린샷 폴더
const legacyDir = () => path.join(app.getPath('userData'), 'assets');         // v1.0.1 이하의 기본 위치

function initStore() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { /* 기본값 */ }
  // 사용자가 지정한 폴더는 다시 바꾸기 전까지 유지한다. 쓸 수 없으면 이번 실행만 기본 위치를 쓰고 설정은 그대로 둔다.
  assetsDir = defaultDir();
  if (settings.assetsDir) {
    try {
      fs.mkdirSync(settings.assetsDir, { recursive: true });
      fs.accessSync(settings.assetsDir, fs.constants.W_OK);
      assetsDir = settings.assetsDir;
    } catch { storeError = `지정한 폴더를 사용할 수 없어 임시로 기본 위치를 사용합니다: ${settings.assetsDir}`; }
  }
  // 예전 기본 위치에 보관함이 있으면 새 기본 위치로 옮긴다.
  if (!settings.assetsDir && fs.existsSync(path.join(legacyDir(), 'index.json'))) {
    const target = assetsDir;
    assetsDir = legacyDir();
    indexFile = path.join(assetsDir, 'index.json');
    try { assets = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { assets = []; }
    assets = assets.filter((a) => fs.existsSync(imgPath(a.id)));
    try { moveStore(target); } catch (e) { storeError = `기본 폴더로 옮기지 못했습니다: ${e.message}`; }
    return;
  }
  fs.mkdirSync(assetsDir, { recursive: true });
  indexFile = path.join(assetsDir, 'index.json');
  try { assets = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { assets = []; }
  assets = assets.filter((a) => fs.existsSync(imgPath(a.id)));
}

/* 저장 폴더 변경: 기존 에셋을 새 폴더로 복사(성공 후 원본 삭제)하고, 새 폴더에 있던 에셋과 합친다. */
function moveStore(newDir) {
  newDir = path.resolve(newDir);
  if (newDir.toLowerCase() === path.resolve(assetsDir).toLowerCase()) return { ok: true };
  fs.mkdirSync(newDir, { recursive: true });
  const oldDir = assetsDir, oldAssets = assets;
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(path.join(newDir, 'index.json'), 'utf8')); } catch { /* 없음 */ }
  const files = (id) => [`${id}.png`, `${id}.thumb.png`];
  // 원본 이미지가 없는 항목은 건너뛰고, 썸네일이 없으면 이미지에서 다시 만든다.
  const movable = oldAssets.filter((a) => fs.existsSync(path.join(oldDir, `${a.id}.png`)));
  for (const a of movable) {
    fs.copyFileSync(path.join(oldDir, `${a.id}.png`), path.join(newDir, `${a.id}.png`));
    const t = path.join(oldDir, `${a.id}.thumb.png`);
    if (fs.existsSync(t)) fs.copyFileSync(t, path.join(newDir, `${a.id}.thumb.png`));
    else {
      const img = nativeImage.createFromPath(path.join(oldDir, `${a.id}.png`));
      fs.writeFileSync(path.join(newDir, `${a.id}.thumb.png`), (img.getSize().width > 360 ? img.resize({ width: 360, quality: 'good' }) : img).toPNG());
    }
  }
  const have = new Set(movable.map((a) => a.id));
  assetsDir = newDir;
  indexFile = path.join(newDir, 'index.json');
  assets = [...movable, ...existing.filter((a) => !have.has(a.id))]
    .filter((a) => fs.existsSync(imgPath(a.id))).sort((x, y) => y.createdAt - x.createdAt);
  saveIndex();
  for (const a of oldAssets) for (const f of files(a.id)) { try { fs.unlinkSync(path.join(oldDir, f)); } catch { /* 무시 */ } }
  try { fs.unlinkSync(path.join(oldDir, 'index.json')); } catch { /* 무시 */ }
  if (newDir.toLowerCase() === defaultDir().toLowerCase()) delete settings.assetsDir; else settings.assetsDir = newDir;
  storeError = '';
  saveSettings();
  return { ok: true };
}
const storeInfo = () => ({ dir: assetsDir, isDefault: assetsDir.toLowerCase() === defaultDir().toLowerCase(), error: storeError, count: assets.length });
const imgPath = (id) => path.join(assetsDir, `${id}.png`);
const thumbPath = (id) => path.join(assetsDir, `${id}.thumb.png`);
const saveIndex = () => fs.writeFileSync(indexFile, JSON.stringify(assets, null, 1));
const saveSettings = () => fs.writeFileSync(settingsFile, JSON.stringify(settings));

const view = (a) => ({ ...a, url: pathToFileURL(imgPath(a.id)).href, thumbUrl: pathToFileURL(thumbPath(a.id)).href });
const findAsset = (id) => assets.find((a) => a.id === id);

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

function addAsset(img, mode) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const { width, height } = img.getSize();
  fs.writeFileSync(imgPath(id), img.toPNG());
  const thumb = width > 360 ? img.resize({ width: 360, quality: 'good' }) : img;
  fs.writeFileSync(thumbPath(id), thumb.toPNG());
  const asset = { id, name: `${MODE_LABEL[mode]} ${stamp()}`, mode, width, height, createdAt: Date.now() };
  assets.unshift(asset);
  saveIndex();
  return asset;
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

async function scrollCapture(sel) {
  const { display: d, rect, crop } = sel;
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

      if (r.status === 'end') { // 스크롤 애니메이션·렌더링 지연일 수 있어 여러 번 더 기다리며 확인 (진짜 끝일 때만 약 2초 더 걸림)
        for (let k = 0; k < 3 && r.status === 'end'; k++) {
          await sleep(700);
          r = st.add(await grabCrop());
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

async function finish(img, mode) {
  const a = addAsset(img, mode);
  if (settings.autoCopy) await copyImage(img);
  win.show();
  win.focus();
  win.webContents.send('assets:changed', { select: a.id, toast: settings.autoCopy ? '캡처 완료 · 클립보드에 복사됨' : '캡처 완료' });
}

async function runCapture(mode, delay = 0) {
  if (busy) return;
  busy = true;
  let done = false;
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
    if (!done && !win.isDestroyed()) { win.show(); win.focus(); }
  }
}

/* ---------- IPC ---------- */
ipcMain.handle('assets:list', () => assets.map(view));
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => { settings = { ...settings, ...patch }; saveSettings(); return settings; });
ipcMain.handle('capture:start', (_e, mode, delay) => { runCapture(mode, Number(delay) || 0); });

ipcMain.handle('windows:list', async () => {
  const srcs = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 420, height: 280 } });
  return srcs
    .filter((s) => s.name && s.name !== win.getTitle() && !s.thumbnail.isEmpty())
    .map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
});

ipcMain.handle('capture:window', async (_e, id) => {
  const srcs = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 3840, height: 2160 } });
  const s = srcs.find((x) => x.id === id);
  if (!s || s.thumbnail.isEmpty()) return { ok: false, message: '창을 캡처할 수 없습니다 (최소화된 창일 수 있어요)' };
  const a = addAsset(s.thumbnail, 'window');
  if (settings.autoCopy) await copyImage(s.thumbnail);
  return { ok: true, select: a.id, toast: settings.autoCopy ? '창 캡처 완료 · 클립보드에 복사됨' : '창 캡처 완료' };
});

ipcMain.handle('asset:rename', (_e, id, name) => {
  const a = findAsset(id);
  if (a && name.trim()) { a.name = name.trim().slice(0, 120); saveIndex(); }
});
ipcMain.handle('asset:delete', (_e, id) => {
  const i = assets.findIndex((a) => a.id === id);
  if (i < 0) return;
  assets.splice(i, 1);
  for (const f of [imgPath(id), thumbPath(id)]) fs.rm(f, { force: true }, () => {});
  saveIndex();
});
ipcMain.handle('asset:copy', async (_e, id) => {
  if (!findAsset(id)) return;
  await copyImage(nativeImage.createFromPath(imgPath(id)));
});
ipcMain.handle('asset:save', async (_e, id) => {
  const a = findAsset(id);
  if (!a) return false;
  const r = await dialog.showSaveDialog(win, {
    defaultPath: a.name.replace(/[\\/:*?"<>|]/g, '-') + '.png',
    filters: [{ name: 'PNG', extensions: ['png'] }, { name: 'JPEG', extensions: ['jpg'] }],
  });
  if (r.canceled || !r.filePath) return false;
  const img = nativeImage.createFromPath(imgPath(id));
  fs.writeFileSync(r.filePath, /\.jpe?g$/i.test(r.filePath) ? img.toJPEG(92) : img.toPNG());
  return true;
});
ipcMain.handle('asset:dataUrl', (_e, id) => {
  if (!findAsset(id)) return null;
  return 'data:image/png;base64,' + fs.readFileSync(imgPath(id)).toString('base64');
});
ipcMain.handle('asset:addEdited', (_e, baseId, dataUrl) => {
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) return null;
  const base = findAsset(baseId);
  const a = addAsset(img, 'edit');
  if (base) { a.name = `${base.name} (편집)`; saveIndex(); }
  return a.id;
});
ipcMain.handle('asset:reveal', (_e, id) => { if (findAsset(id)) shell.showItemInFolder(imgPath(id)); });
ipcMain.on('asset:drag', (e, id) => {
  if (!findAsset(id)) return;
  e.sender.startDrag({ file: imgPath(id), icon: nativeImage.createFromPath(thumbPath(id)).resize({ width: 96 }) });
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
  if (!app.isPackaged || !updater) return sendUpdate({ state: 'dev' });
  if (['checking', 'downloading', 'ready'].includes(upd.state)) return;
  lastCheck = Date.now();
  sendUpdate({ state: 'checking', message: '' });
  updater.checkForUpdates().catch(() => { /* 'error' 이벤트에서 처리 */ });
}
function initUpdater() {
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
ipcMain.handle('store:choose', async () => {
  const r = await dialog.showOpenDialog(win, { title: '저장할 폴더 선택', defaultPath: assetsDir, properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true, ...storeInfo() };
  try { moveStore(r.filePaths[0]); } catch (e) { return { ok: false, message: e.message, ...storeInfo() }; }
  win.webContents.send('assets:changed', {});
  return { ok: true, ...storeInfo() };
});
ipcMain.handle('store:reset', () => {
  try { moveStore(defaultDir()); } catch (e) { return { ok: false, message: e.message, ...storeInfo() }; }
  win.webContents.send('assets:changed', {});
  return { ok: true, ...storeInfo() };
});
ipcMain.handle('store:open', () => shell.openPath(assetsDir));
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
  const tmp = fs.mkdtempSync(path.join(app.getPath('temp'), 'capturebox-ocr-'));
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
  if (!findAsset(id)) return { ok: false, message: '이미지를 찾을 수 없습니다' };
  try {
    const r = await ocrImage(nativeImage.createFromPath(imgPath(id)));
    if (!r.text) return { ok: true, text: '', engine: r.engine, message: '인식된 글자가 없습니다' };
    clipboard.writeText(r.text);
    return { ok: true, text: r.text, engine: r.engine, note: r.note };
  } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('ocr:get', () => ({ mode: settings.ocrMode || 'precise', preciseAvailable: preciseStatus() }));
ipcMain.handle('ocr:set', (_e, mode) => {
  settings.ocrMode = mode === 'windows' ? 'windows' : 'precise';
  saveSettings();
  return { mode: settings.ocrMode, preciseAvailable: preciseStatus() };
});
ipcMain.handle('text:copy', (_e, text) => { clipboard.writeText(String(text || '')); return true; });

/* ---------- 화면에 고정 (핀) ---------- */
const pins = new Set();
const pinAnchor = new Map();
function createPin(id) {
  const a = findAsset(id);
  if (!a) return null;
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  let w = a.width / d.scaleFactor;
  let h = a.height / d.scaleFactor;
  const k = Math.min(1, 560 / w, 420 / h);
  w = Math.max(100, Math.round(w * k));
  h = Math.max(70, Math.round(h * k));
  const off = (pins.size % 6) * 28;
  const pw = new BrowserWindow({
    x: d.workArea.x + d.workArea.width - w - 24 - off, y: d.workArea.y + 24 + off,
    width: w, height: h, useContentSize: true, frame: false, resizable: true, minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: true, backgroundColor: '#1f2430',
    webPreferences: { preload: path.join(__dirname, 'ui', 'pin-preload.js'), sandbox: true },
  });
  pw.setAlwaysOnTop(true, 'screen-saver');
  pw.setAspectRatio(w / h);
  pins.add(pw);
  pw.on('closed', () => { pins.delete(pw); pinAnchor.delete(pw.id); });
  pw.loadFile(path.join(__dirname, 'ui', 'pin.html'));
  pw.webContents.once('did-finish-load', () => {
    pw.webContents.send('pin:init', 'data:image/png;base64,' + fs.readFileSync(imgPath(id)).toString('base64'));
  });
  return pw;
}
const pinOf = (e) => BrowserWindow.fromWebContents(e.sender);
ipcMain.handle('asset:pin', (_e, id) => !!createPin(id));
ipcMain.on('pin:begin', (e) => { const w = pinOf(e); if (w) pinAnchor.set(w.id, { pos: w.getPosition(), cur: screen.getCursorScreenPoint() }); });
ipcMain.on('pin:drag', (e) => {
  const w = pinOf(e); const an = w && pinAnchor.get(w.id);
  if (!an) return;
  const c = screen.getCursorScreenPoint();
  w.setPosition(an.pos[0] + c.x - an.cur.x, an.pos[1] + c.y - an.cur.y);
});
ipcMain.on('pin:zoom', (e, dir) => {
  const w = pinOf(e); if (!w) return;
  const [cw, ch] = w.getContentSize();
  const [x, y] = w.getPosition();
  const f = dir > 0 ? 1.1 : 1 / 1.1;
  const nw = Math.max(100, Math.min(4000, Math.round(cw * f)));
  const nh = Math.max(70, Math.round(nw * ch / cw));
  w.setPosition(Math.round(x - (nw - cw) / 2), Math.round(y - (nh - ch) / 2));
  w.setContentSize(nw, nh);
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
  delete settings.hotkeys;
  saveSettings();
  registerHotkeys();
  buildTrayMenu();
  return { ok: !Object.keys(hotkeyErrors).length, message: Object.keys(hotkeyErrors).length ? '일부 기본 단축키를 다른 프로그램이 사용 중입니다' : '', ...hotkeyState() };
});

/* ---------- 윈도우 시작 시 자동 실행 (설치본에서만) ---------- */
const LOGIN_ARGS = ['--hidden'];
const loginState = () => ({
  supported: app.isPackaged,
  enabled: app.isPackaged ? app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin : false,
});
ipcMain.handle('login:get', () => loginState());
ipcMain.handle('login:set', (_e, on) => {
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
    e.preventDefault();
    win.hide();
    if (!settings.trayNoticeShown) {
      settings.trayNoticeShown = true;
      saveSettings();
      try { tray.displayBalloon({ title: 'CaptureBox', content: '트레이에서 계속 실행 중입니다. 단축키로 바로 캡처할 수 있어요. 완전히 종료하려면 트레이 아이콘을 우클릭하세요.' }); } catch { /* 무시 */ }
    }
  });
  win.on('session-end', () => { quitting = true; });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

app.whenReady().then(() => {
  initStore();
  createWindow();
  createTray();
  initUpdater();
  registerHotkeys();
  buildTrayMenu();
  // 설치본 자체 검증 모드: CB_SELFTEST=<리포트 경로> 로 실행하면 핵심 기능을 실제로 돌려 보고서를 쓴다 (npm run verify)
  if (process.env.CB_SELFTEST) {
    setTimeout(() => require('./selftest').run({
      app, screen, BrowserWindow, nativeImage, ipcMain, globalShortcut, fs, path,
      get win() { return win; }, get tray() { return tray; }, get assets() { return assets; },
      pins, overlayCtx, startInput, scrollCapture, grabDisplay, ocrImage, getPrecise, ocrModelDir, resetPrecise: () => { preciseEngine = null; }, createPin, runCapture, addAsset, startHidden, unpackedPath,
    }), 2000);
  }
});
app.on('second-instance', showWin);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (!tray && !busy) app.quit(); });
