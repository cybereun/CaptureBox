'use strict';
const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, clipboard, nativeImage,
  dialog, globalShortcut, shell, ClipboardItem,
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
const defaultDir = () => path.join(app.getPath('userData'), 'assets');

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
        fullscreenable: false, show: false, enableLargerThanScreen: true, backgroundColor: '#000',
        webPreferences: { preload: path.join(__dirname, 'ui', 'overlay-preload.js'), sandbox: true },
      });
      w.setAlwaysOnTop(true, 'screen-saver');
      w.setBounds(d.bounds);
      overlayCtx.set(w.webContents.id, { display: d, shot: shots[i] });
      w.loadFile(path.join(__dirname, 'ui', 'overlay.html'));
      w.webContents.once('did-finish-load', () => {
        w.webContents.send('overlay:init', { shot: shots[i].toDataURL(), mode });
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
function startInput() {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'input.ps1')], {
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

    for (let guard = 0; guard < 120; guard++) {
      await input.send(`wheel ${-notches}`);
      await sleep(450);
      let r = st.add(await grabCrop());

      if (r.status === 'end') { // 스크롤 애니메이션 지연일 수 있어 한 번 더 확인
        await sleep(600);
        r = st.add(await grabCrop());
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
function checkUpdate() {
  if (!app.isPackaged || !updater) return sendUpdate({ state: 'dev' });
  if (['checking', 'downloading', 'ready'].includes(upd.state)) return;
  sendUpdate({ state: 'checking', message: '' });
  updater.checkForUpdates().catch((e) => sendUpdate({ state: 'error', message: friendlyError(e) }));
}
function initUpdater() {
  if (!app.isPackaged || !updater) { upd.state = 'dev'; return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-available', (i) => sendUpdate({ state: 'downloading', latest: i.version, percent: 0 }));
  updater.on('update-not-available', () => sendUpdate({ state: 'latest' }));
  updater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (i) => sendUpdate({ state: 'ready', latest: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes : '' }));
  updater.on('error', (e) => sendUpdate({ state: 'error', message: friendlyError(e) }));
  setTimeout(checkUpdate, 4000);
  setInterval(checkUpdate, 30 * 60 * 1000);
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

/* ---------- 앱 ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 820, minHeight: 520, title: 'CaptureBox',
    backgroundColor: '#14171f', autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

app.whenReady().then(() => {
  initStore();
  createWindow();
  initUpdater();
  const hk = { 'CommandOrControl+Alt+1': 'region', 'CommandOrControl+Alt+2': 'fullscreen', 'CommandOrControl+Alt+3': 'scroll' };
  for (const [key, mode] of Object.entries(hk)) globalShortcut.register(key, () => runCapture(mode, 0));
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (!busy) app.quit(); });
