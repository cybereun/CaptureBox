'use strict';
/*
 * 설치본 자체 검증 (npm run verify 에서 사용).
 * CB_SELFTEST=<리포트 경로> 로 앱을 실행하면 main.js 가 이 모듈을 불러, 핵심 기능을 실제로 돌려 보고서(JSON)를 쓴다.
 * 개발 모드가 아니라 "패키징된 앱"에서 돌리는 것이 핵심이다 (asar 경로 문제 같은 설치본 전용 버그를 잡기 위해).
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 스크롤 캡처 결과 분석: 테스트 페이지는 행마다 어두운 2px 경계선이 있다. 경계선 간격이 일정해야 이어붙임이 정확한 것.
function analyzeStitch(img, sf) {
  const { width, height } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const col = 5;
  const starts = [];
  let prev = false;
  for (let y = 0; y < height; y++) {
    const o = (y * width + col) * 4;
    const dark = bmp[o + 2] < 90 && bmp[o + 1] < 90 && bmp[o] < 90;
    if (dark && !prev) starts.push(y);
    prev = dark;
  }
  const gaps = starts.slice(1).map((v, i) => v - starts[i]);
  const expected = Math.round(102 * sf);
  const bad = gaps.filter((g) => Math.abs(g - expected) > 2);
  return { width, height, borders: starts.length, expectedGap: expected, badGaps: bad.length, gaps: [...new Set(gaps)] };
}

const mean = (img) => {
  const b = img.toBitmap();
  let s = 0, n = 0;
  for (let i = 0; i < b.length; i += 4 * 97) { s += (b[i] + b[i + 1] + b[i + 2]) / 3; n++; }
  return n ? s / n : 0;
};

exports.run = async (ctx) => {
  const { app, screen, BrowserWindow, nativeImage, ipcMain, globalShortcut, fs, path } = ctx;
  const reportPath = process.env.CB_SELFTEST;
  const hiddenRun = process.env.CB_SELFTEST_HIDDEN === '1';
  const results = [];
  const rec = (name, status, detail = '') => results.push({ name, status, detail });
  const only = process.env.CB_SELFTEST_ONLY;   // 이름에 이 문자열이 들어간 단계만 실행 (디버깅용)
  const step = async (name, fn) => {
    if (only && !name.includes(only)) return;
    try {
      const r = await fn();
      if (r && typeof r === 'object' && r.status) rec(name, r.status, r.detail || '');
      else rec(name, 'pass', r || '');
    } catch (e) { rec(name, 'fail', e && e.message ? e.message : String(e)); }
  };
  const H = (n, ...a) => ipcMain._invokeHandlers.get(n)({}, ...a);
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  await step('환경', () => `v${app.getVersion()} · 패키징=${app.isPackaged} · 모니터 ${displays.length}대: ` +
    displays.map((d) => `${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}x(${d.bounds.x},${d.bounds.y})`).join(', '));

  await step('패키징 확인 (app.asar / 업데이트 설정)', () => {
    if (!app.isPackaged) return { status: 'warn', detail: '개발 모드: 설치본이 아닙니다' };
    const upd = path.join(process.resourcesPath, 'app-update.yml');
    if (!fs.existsSync(upd)) throw new Error('app-update.yml 없음 (자동 업데이트 설정 누락)');
    if (!fs.existsSync(ctx.unpackedPath('input.ps1')) || !fs.existsSync(ctx.unpackedPath('ocr.ps1'))) throw new Error('app.asar.unpacked 에 PowerShell 스크립트가 없습니다');
    const bind = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime_binding.node');
    if (!fs.existsSync(bind)) throw new Error('onnxruntime-node 네이티브 모듈이 unpacked 에 없습니다 (정밀 OCR 불가)');
    for (const f of ['det.onnx', 'rec_korean.onnx', 'rec_korean.yml']) if (!fs.existsSync(path.join(ctx.ocrModelDir(), f))) throw new Error(`OCR 모델 파일 없음: ${f}`);
    return 'app-update.yml · 스크립트·onnxruntime unpacked · OCR 모델 3개 OK';
  });

  await step('트레이 아이콘', () => { if (!ctx.tray || ctx.tray.isDestroyed()) throw new Error('트레이가 만들어지지 않았습니다'); return 'OK'; });

  if (hiddenRun) {
    await step('자동 실행(--hidden) 시작: 창이 보이지 않아야 함', () => {
      if (!ctx.startHidden) throw new Error('--hidden 인자가 인식되지 않았습니다');
      if (ctx.win.isVisible()) throw new Error('창이 보이고 있습니다');
      return '창 없이 트레이로만 시작';
    });
  } else {
    await step('창 표시 + 제목줄 버전', () => {
      if (!ctx.win.isVisible()) throw new Error('창이 보이지 않습니다');
      const t = ctx.win.getTitle();
      if (!t.includes(app.getVersion())) throw new Error(`제목줄에 버전이 없습니다: ${t}`);
      return t;
    });

    await step('창 닫기 → 트레이 상주', async () => {
      ctx.win.close();
      await sleep(600);
      if (ctx.win.isDestroyed() || ctx.win.isVisible()) throw new Error('창이 숨겨지지 않았거나 파괴되었습니다');
      ctx.win.show();
      return '닫아도 앱이 남고 창만 숨겨짐';
    });

    for (const [i, d] of displays.entries()) {
      const tag = `모니터 ${i + 1}/${displays.length} (${d.bounds.width}x${d.bounds.height} @${d.scaleFactor}x)`;
      await step(`${tag} 화면 캡처 크기`, async () => {
        const img = await ctx.grabDisplay(d);
        const { width, height } = img.getSize();
        const ew = Math.round(d.size.width * d.scaleFactor), eh = Math.round(d.size.height * d.scaleFactor);
        if (Math.abs(width - ew) > 2 || Math.abs(height - eh) > 2) throw new Error(`기대 ${ew}x${eh}, 실제 ${width}x${height}`);
        if (mean(img) < 1) throw new Error('캡처 이미지가 완전히 검은색입니다');
        return `${width}x${height}`;
      });
    }

    await step('입력 도우미(PowerShell) 시작', async () => {
      const input = await ctx.startInput();
      await input.send('move 5 5');
      input.close();
      return 'OK';
    });

    for (const [i, d] of displays.entries()) {
      const tag = `모니터 ${i + 1}/${displays.length}`;
      await step(`${tag} 스크롤 캡처 (긴 페이지 이어붙이기)`, async () => {
        const sf = d.scaleFactor;
        const tw = new BrowserWindow({ x: d.bounds.x + 100, y: d.bounds.y + 100, width: 700, height: 500, frame: false, alwaysOnTop: true, show: true, webPreferences: { sandbox: true } });
        try {
          let rows = '';
          for (let n = 1; n <= 40; n++) rows += `<div style="height:100px;padding-left:30px;border-bottom:2px solid #333;font:700 40px sans-serif;background:hsl(${n * 37 % 360} 70% 80%)">ROW ${n} - ${'#'.repeat(n % 7 + 3)}</div>`;
          await tw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="margin:0">${rows}</body>`));
          await sleep(800);
          const rect = { x: 100, y: 100, w: 700, h: 500 };
          const crop = { x: Math.round(100 * sf), y: Math.round(100 * sf), width: Math.round(700 * sf), height: Math.round(500 * sf) };
          const log = [];
          const img = await ctx.scrollCapture({ display: d, rect, crop }, log);
          const a = analyzeStitch(img, sf);
          const trace = ` · 진행기록: ${log.join(' | ')}`;
          if (a.borders < 38) throw new Error(`행 경계 ${a.borders}개만 인식됨 (기대 ≥38) · ${JSON.stringify(a)}${trace}`);
          if (a.badGaps > 0) throw new Error(`이어붙임이 어긋난 곳 ${a.badGaps}개 · 간격 ${a.gaps.join(',')} (기대 ${a.expectedGap})${trace}`);
          return `${a.width}x${a.height}px, 행 ${a.borders}개, 간격 ${a.gaps.join(',')} (기대 ${a.expectedGap})`;
        } finally { if (!tw.isDestroyed()) tw.destroy(); }
      });
    }

    for (const [i, d] of displays.entries()) {
      const tag = `모니터 ${i + 1}/${displays.length}`;
      await step(`${tag} 영역 캡처 전체 흐름 (투명 오버레이 → 선택 → 저장)`, async () => {
        const before = ctx.assets.length;
        const p = ctx.runCapture('region', 0);
        for (let t = 0; t < 80 && ctx.overlayCtx.size < displays.length; t++) await sleep(100);
        if (ctx.overlayCtx.size < displays.length) throw new Error('오버레이 창이 모든 모니터에 뜨지 않았습니다');
        await sleep(1200);
        const entry = [...ctx.overlayCtx.entries()].find(([, v]) => v.display.id === d.id);
        if (!entry) throw new Error('이 모니터의 오버레이를 찾지 못했습니다');
        ipcMain.emit('overlay:done', { sender: { id: entry[0] } }, { x: 100, y: 100, w: 400, h: 300 });
        await p;
        if (ctx.assets.length !== before + 1) throw new Error('캡처 결과가 저장되지 않았습니다');
        const a = ctx.assets[0];
        const ew = Math.round(400 * d.scaleFactor), eh = Math.round(300 * d.scaleFactor);
        if (Math.abs(a.width - ew) > 2 || Math.abs(a.height - eh) > 2) throw new Error(`기대 ${ew}x${eh}, 실제 ${a.width}x${a.height}`);
        return `${a.width}x${a.height}px 저장`;
      });
    }

    // OCR: 한국어/영어 + 긴 이미지(분할 인식)
    const makeTextImage = async (h, draw) => {
      const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      try {
        await w.loadURL('data:text/html,<body></body>');
        const url = await w.webContents.executeJavaScript(`(function(){const c=document.createElement('canvas');c.width=1500;c.height=${h};const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.fillStyle='#000';x.textBaseline='top';x.font='700 64px "Malgun Gothic", sans-serif';${draw};return c.toDataURL('image/png')})()`);
        return nativeImage.createFromDataURL(url);
      } finally { w.destroy(); }
    };
    await step('정밀 OCR 엔진 로드 (onnxruntime + 모델)', async () => {
      const t0 = Date.now();
      await ctx.getPrecise();
      return `${Date.now() - t0}ms`;
    });
    const precise = async (img) => {
      const r = await ctx.ocrImage(img, 'precise');
      if (r.engine !== 'precise') throw new Error(`정밀 엔진이 쓰이지 않고 대체되었습니다: ${r.note}`);
      return r.text;
    };
    await step('정밀 OCR: 영어·숫자', async () => {
      const img = await makeTextImage(260, "x.fillText('CaptureBox OCR 12345', 40, 40);x.fillText('Hello World 2026', 40, 140)");
      const t = await precise(img);
      const low = t.replace(/\s+/g, '').toLowerCase();
      if (!low.includes('capturebox') || !low.includes('ocr12345') || !low.includes('helloworld2026')) throw new Error(`인식 결과가 다릅니다: "${t.slice(0, 80)}"`);
      return `"${t.split('\n').join(' / ')}"`;
    });
    await step('정밀 OCR: 한국어 (두 줄 모두 정확해야 함)', async () => {
      const img = await makeTextImage(260, "x.fillText('캡처박스 글자 인식 테스트', 40, 40);x.fillText('안녕하세요 반갑습니다', 40, 140)");
      const t = await precise(img);
      const low = t.replace(/\s+/g, '');
      if (!low.includes('캡처박스글자인식테스트') || !low.includes('안녕하세요반갑습니다')) throw new Error(`한국어 인식 결과가 다릅니다: "${t.slice(0, 80)}"`);
      if (t.split('\n').length !== 2) throw new Error(`줄바꿈이 보존되지 않았습니다 (${t.split('\n').length}줄)`);
      return `"${t.split('\n').join(' / ')}"`;
    });
    await step('정밀 OCR: 긴 이미지 분할 인식 (4200px)', async () => {
      const img = await makeTextImage(4200, "x.fillText('FIRST LINE 111', 40, 60);x.fillText('MIDDLE LINE 555', 40, 2100);x.fillText('LAST LINE 999', 40, 4000)");
      const t = await precise(img);
      const low = t.replace(/\s+/g, '').toLowerCase();
      if (!low.includes('firstline111') || !low.includes('middleline555') || !low.includes('lastline999')) throw new Error(`위·중간·아래 글자를 모두 읽지 못했습니다: "${t.slice(0, 100)}"`);
      return '맨 위·중간·맨 아래 글자 모두 인식 (타일 경계에서 글자가 잘리지 않음)';
    });
    await step('OCR 버튼 경로(IPC): 에셋 → 정밀 인식 → 클립보드 복사', async () => {
      const img = await makeTextImage(260, "x.fillText('버튼 경로 테스트 ABC 123', 40, 40);x.fillText('두 번째 줄입니다', 40, 140)");
      const a = ctx.addAsset(img, 'edit');
      const r = await H('asset:ocr', a.id);
      if (!r.ok || r.engine !== 'precise') throw new Error(`결과: ok=${r.ok} engine=${r.engine} ${r.message || r.note || ''}`);
      const raw = require('electron').clipboard.readText();
      const clip = raw && typeof raw.then === 'function' ? await raw : raw;   // Electron 44 에서는 비동기일 수 있다
      if (clip !== r.text) throw new Error(`클립보드 불일치: readText 반환형=${raw && raw.then ? 'Promise' : typeof raw}, 읽은 값="${String(clip).slice(0, 40)}", 기대="${r.text.slice(0, 40)}"`);
      if (!r.text.replace(/\s+/g, '').includes('버튼경로테스트ABC123')) throw new Error(`인식 결과가 다릅니다: "${r.text}"`);
      return `"${r.text.split('\n').join(' / ')}" → 클립보드 OK`;
    });
    await step('OCR 방식 설정(IPC): 정밀(기본) ↔ Windows 내장', async () => {
      const d = await H('ocr:get');
      if (d.mode !== 'precise' || !d.preciseAvailable) throw new Error(`기본값이 정밀이 아닙니다: ${JSON.stringify(d)}`);
      const w = await H('ocr:set', 'windows');
      const img = await makeTextImage(200, "x.fillText('Windows Mode 777', 40, 60)");
      const rw = await ctx.ocrImage(img);
      await H('ocr:set', 'precise');
      if (w.mode !== 'windows' || rw.engine !== 'windows') throw new Error(`windows 설정이 반영되지 않았습니다 (${w.mode}, ${rw.engine})`);
      const rp = await ctx.ocrImage(img);
      if (rp.engine !== 'precise') throw new Error('정밀로 되돌리지 못했습니다');
      return '기본=정밀, 전환 OK';
    });
    await step('정밀 모드 불가 시 Windows OCR 로 자동 대체 (모델 파일 없음 → 복구)', async () => {
      const dir = ctx.ocrModelDir(), off = dir + '_off';
      const img = await makeTextImage(200, "x.fillText('Fallback Test 4242', 40, 60)");
      ctx.resetPrecise();
      fs.renameSync(dir, off);
      let r;
      try { r = await ctx.ocrImage(img, 'precise'); } finally { fs.renameSync(off, dir); ctx.resetPrecise(); }
      if (r.engine !== 'windows' || !r.note || !r.text.replace(/\s+/g, '').toLowerCase().includes('fallbacktest')) throw new Error(`대체 결과가 이상합니다: engine=${r.engine} note=${r.note} text="${r.text}"`);
      const back = await ctx.ocrImage(img, 'precise');
      if (back.engine !== 'precise') throw new Error('모델 복구 후 정밀 모드로 돌아오지 못했습니다');
      return `대체 OK ("${r.note.slice(0, 40)}…") · 복구 후 정밀 재개`;
    });
    await step('Windows OCR(대체 수단) 동작', async () => {
      const img = await makeTextImage(260, "x.fillText('CaptureBox OCR 12345', 40, 40);x.fillText('Hello World 2026', 40, 140)");
      const r = await ctx.ocrImage(img, 'windows');
      const low = r.text.replace(/\s+/g, '').toLowerCase();
      if (r.engine !== 'windows' || !low.includes('capturebox')) throw new Error(`인식 결과가 다릅니다: "${r.text.slice(0, 80)}"`);
      return `"${r.text.split('\n')[0]}"`;
    });

    // 핀
    for (const [i, d] of displays.entries()) {
      await step(`화면 고정(핀): 끌어서 이동해도 크기 유지 — 모니터 ${i + 1}/${displays.length} (@${d.scaleFactor}x)`, async () => {
        const w = new BrowserWindow({ show: false });
        await w.loadURL('data:text/html,<body></body>');
        const url = await w.webContents.executeJavaScript("(function(){const c=document.createElement('canvas');c.width=800;c.height=500;const x=c.getContext('2d');x.fillStyle='#4c8dff';x.fillRect(0,0,800,500);return c.toDataURL('image/png')})()");
        w.destroy();
        const a = ctx.addAsset(nativeImage.createFromDataURL(url), 'edit');
        const input = await ctx.startInput();
        const c = screen.dipToScreenPoint({ x: d.bounds.x + d.bounds.width / 2, y: d.bounds.y + d.bounds.height / 2 });
        const cx = Math.round(c.x), cy = Math.round(c.y);
        await input.send(`move ${cx} ${cy}`);
        await sleep(250);
        const pw = ctx.createPin(a.id);
        await sleep(900);
        const sfD = d.scaleFactor, k0 = Math.min(1, 560 / (800 / sfD), 420 / (500 / sfD));
        const want = { width: Math.max(100, Math.round(800 / sfD * k0)), height: Math.max(70, Math.round(500 / sfD * k0)) };   // createPin 이 의도한 크기
        const b0 = pw.getBounds();
        if (Math.abs(b0.width - want.width) > 2 || Math.abs(b0.height - want.height) > 2) throw new Error(`처음 크기가 의도와 다릅니다: 기대 ${want.width}x${want.height}, 실제 ${b0.width}x${b0.height}`);
        const sender = { sender: pw.webContents };
        ipcMain.emit('pin:begin', sender);
        // 끌기를 여러 번(8회 × 15걸음) 반복해도 크기가 쌓여서 커지지 않아야 한다. 환산 반올림으로 ±2px 차이는 허용.
        let grewAt = -1, step = 0;
        for (let g = 0; g < 8; g++) {
          ipcMain.emit('pin:begin', sender);
          const bx = cx + g * 90, by = cy + g * 20;
          for (let k = 1; k <= 15; k++) {
            await input.send(`move ${bx + k * 7} ${by + k * 3}`);
            await sleep(20);
            ipcMain.emit('pin:drag', sender);
            step++;
            const b = pw.getBounds();
            if (grewAt < 0 && (Math.abs(b.width - want.width) > 2 || Math.abs(b.height - want.height) > 2)) grewAt = step;
          }
        }
        const b1 = pw.getBounds();
        ipcMain.emit('pin:close', sender);
        await sleep(300);
        input.close();
        if (grewAt >= 0 || Math.abs(b1.width - want.width) > 2 || Math.abs(b1.height - want.height) > 2) throw new Error(`크기가 변했습니다: 기대 ${want.width}x${want.height} → ${b1.width}x${b1.height} (${grewAt}번째 이동부터)`);
        return `${b0.width}x${b0.height} → ${b1.width}x${b1.height} (8번 끌기·120걸음, 이동 거리 ${b1.x - b0.x}px)`;
      });
    }
    if (displays.length > 1) {
      await step(`화면 고정(핀): 모니터 사이를 끌어서 넘어가도 크기 유지 (${displays.length}대 가로지름)`, async () => {
        const w = new BrowserWindow({ show: false });
        await w.loadURL('data:text/html,<body></body>');
        const url = await w.webContents.executeJavaScript("(function(){const c=document.createElement('canvas');c.width=800;c.height=500;const x=c.getContext('2d');x.fillStyle='#4c8dff';x.fillRect(0,0,800,500);return c.toDataURL('image/png')})()");
        w.destroy();
        const a = ctx.addAsset(nativeImage.createFromDataURL(url), 'edit');
        const input = await ctx.startInput();
        const center = (d) => { const c = screen.dipToScreenPoint({ x: d.bounds.x + d.bounds.width / 2, y: d.bounds.y + d.bounds.height / 2 }); return { x: Math.round(c.x), y: Math.round(c.y) }; };
        const first = center(primary);
        await input.send(`move ${first.x} ${first.y}`);
        await sleep(250);
        const pw = ctx.createPin(a.id);
        await sleep(900);
        const sf0 = primary.scaleFactor, k0 = Math.min(1, 560 / (800 / sf0), 420 / (500 / sf0));
        const want = { width: Math.round(800 / sf0 * k0), height: Math.round(500 / sf0 * k0) };
        const sender = { sender: pw.webContents };
        let worst = 0, where = '';
        // 기본 모니터 중앙 → 다른 모니터 중앙들을 차례로 지나가며 끈다
        let cur = first;
        const route = displays.filter((d) => d.id !== primary.id).map(center);
        route.push(first);
        for (const to of route) {
          ipcMain.emit('pin:begin', sender);
          for (let k = 1; k <= 30; k++) {
            const x = Math.round(cur.x + (to.x - cur.x) * k / 30), y = Math.round(cur.y + (to.y - cur.y) * k / 30);
            await input.send(`move ${x} ${y}`);
            await sleep(25);
            ipcMain.emit('pin:drag', sender);
            const b = pw.getBounds();
            const dev = Math.max(Math.abs(b.width - want.width), Math.abs(b.height - want.height));
            if (dev > worst) { worst = dev; where = `${b.width}x${b.height} @(${b.x},${b.y})`; }
          }
          cur = to;
        }
        ipcMain.emit('pin:close', sender);
        await sleep(300);
        input.close();
        if (worst > 6) throw new Error(`모니터를 넘는 동안 크기가 어긋났습니다: 기대 ${want.width}x${want.height}, 최대 편차 ${worst}px (${where})`);
        return `기대 ${want.width}x${want.height}, 가로지르는 동안 최대 편차 ${worst}px`;
      });
    }
    await step('화면 고정(핀): 생성·크기 조절·닫기', async () => {
      const w = new BrowserWindow({ show: false });
      await w.loadURL('data:text/html,<body></body>');
      const url = await w.webContents.executeJavaScript("(function(){const c=document.createElement('canvas');c.width=800;c.height=500;const x=c.getContext('2d');x.fillStyle='#4c8dff';x.fillRect(0,0,800,500);return c.toDataURL('image/png')})()");
      w.destroy();
      const a = ctx.addAsset(nativeImage.createFromDataURL(url), 'edit');
      const pw = ctx.createPin(a.id);
      if (!pw) throw new Error('핀 창을 만들지 못했습니다');
      await sleep(900);
      if (!pw.isAlwaysOnTop()) throw new Error('항상 위가 아닙니다');
      const [w0] = pw.getContentSize();
      ipcMain.emit('pin:zoom', { sender: pw.webContents }, 1);
      await sleep(200);
      const [w1] = pw.getContentSize();
      if (w1 <= w0) throw new Error(`확대가 적용되지 않았습니다 (${w0} → ${w1})`);
      ipcMain.emit('pin:close', { sender: pw.webContents });
      await sleep(400);
      if (ctx.pins.size !== 0) throw new Error('핀 창이 닫히지 않았습니다');
      return `창 너비 ${w0} → ${w1}, 닫기 OK`;
    });

    // 단축키
    await step('단축키 변경·중복 거부·기본값 복원', async () => {
      const r1 = await H('hotkeys:set', 'region', 'Ctrl+Alt+Shift+F9');
      if (!r1.ok || !globalShortcut.isRegistered('CommandOrControl+Alt+Shift+F9')) throw new Error('새 단축키가 등록되지 않았습니다');
      const dup = await H('hotkeys:set', 'fullscreen', 'Ctrl+Alt+Shift+F9');
      if (dup.ok) throw new Error('중복 단축키가 거부되지 않았습니다');
      const bad = await H('hotkeys:set', 'fullscreen', 'A');
      if (bad.ok) throw new Error('수식키 없는 단축키가 거부되지 않았습니다');
      await H('hotkeys:reset');
      if (globalShortcut.isRegistered('CommandOrControl+Alt+Shift+F9')) throw new Error('기본값 복원 후에도 이전 단축키가 남아 있습니다');
      return 'OK';
    });

    await step('윈도우 시작 시 자동 실행 켜기/끄기', async () => {
      if (!app.isPackaged) return { status: 'warn', detail: '개발 모드에서는 건너뜀' };
      const on = await H('login:set', true);
      const off = await H('login:set', false);
      if (!on.enabled || off.enabled) throw new Error(`켜기=${on.enabled}, 끄기=${off.enabled}`);
      return 'OK (레지스트리 원복됨)';
    });
  }

  const failed = results.filter((r) => r.status === 'fail').length;
  const report = { version: app.getVersion(), electron: process.versions.electron, hiddenRun, failed, results };
  try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 1)); } catch { /* 무시 */ }
  app.exit(failed ? 1 : 0);
};
