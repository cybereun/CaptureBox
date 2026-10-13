'use strict';
/* 편집기: 사각/원/선/화살표/문자/자르기 + 실행 취소. 저장 시 새 에셋으로 추가. */
(() => {
  const $ = (id) => document.getElementById(id);
  const cv = $('edCanvas'), ctx = cv.getContext('2d');
  let base = null;          // 현재 바탕(자르기 후 갱신) – canvas
  let shapes = [];
  let undo = [], redo = [];
  let tool = 'rect', draft = null, cropRect = null, baseId = null, textInput = null;

  const snap0 = () => ({ base, shapes: JSON.parse(JSON.stringify(shapes)) });
  function pushUndo() { undo.push(snap0()); redo = []; sync(); }
  function restore(st) { base = st.base; shapes = st.shapes; cv.width = base.width; cv.height = base.height; draw(); sync(); }
  function sync() { $('edUndo').disabled = !undo.length; $('edRedo').disabled = !redo.length; }

  function drawShape(c, s) {
    c.strokeStyle = c.fillStyle = s.color; c.lineWidth = s.w; c.lineCap = c.lineJoin = 'round';
    if (s.t === 'rect') c.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
    else if (s.t === 'ellipse') {
      c.beginPath();
      c.ellipse((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2, Math.abs(s.x2 - s.x1) / 2, Math.abs(s.y2 - s.y1) / 2, 0, 0, Math.PI * 2);
      c.stroke();
    } else if (s.t === 'line' || s.t === 'arrow') {
      c.beginPath(); c.moveTo(s.x1, s.y1); c.lineTo(s.x2, s.y2); c.stroke();
      if (s.t === 'arrow') {
        const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1), h = Math.max(12, s.w * 4);
        c.beginPath();
        c.moveTo(s.x2, s.y2);
        c.lineTo(s.x2 - h * Math.cos(a - Math.PI / 6), s.y2 - h * Math.sin(a - Math.PI / 6));
        c.lineTo(s.x2 - h * Math.cos(a + Math.PI / 6), s.y2 - h * Math.sin(a + Math.PI / 6));
        c.closePath(); c.fill();
      }
    } else if (s.t === 'text') {
      c.font = `700 ${s.size}px "Malgun Gothic", sans-serif`; c.textBaseline = 'top';
      s.text.split('\n').forEach((ln, i) => c.fillText(ln, s.x1, s.y1 + i * s.size * 1.2));
    }
  }

  function draw() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(base, 0, 0);
    for (const s of shapes) drawShape(ctx, s);
    if (draft) drawShape(ctx, draft);
    if (cropRect) {
      const r = cropRect;
      ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fillRect(0, 0, cv.width, r.y); ctx.fillRect(0, r.y + r.h, cv.width, cv.height - r.y - r.h);
      ctx.fillRect(0, r.y, r.x, r.h); ctx.fillRect(r.x + r.w, r.y, cv.width - r.x - r.w, r.h);
      ctx.strokeStyle = '#fff'; ctx.setLineDash([8, 6]); ctx.lineWidth = Math.max(2, cv.width / 600);
      ctx.strokeRect(r.x, r.y, r.w, r.h); ctx.restore();
    }
  }

  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height };
  };
  const clampPt = (p) => ({ x: Math.min(cv.width, Math.max(0, p.x)), y: Math.min(cv.height, Math.max(0, p.y)) });

  function constrain(s, shift) {
    if (!shift) return;
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    if (s.t === 'rect' || s.t === 'ellipse') { const m = Math.max(Math.abs(dx), Math.abs(dy)); s.x2 = s.x1 + Math.sign(dx || 1) * m; s.y2 = s.y1 + Math.sign(dy || 1) * m; }
    else { const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), d = Math.hypot(dx, dy); s.x2 = s.x1 + d * Math.cos(a); s.y2 = s.y1 + d * Math.sin(a); }
  }

  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    commitText();
    const p = clampPt(pos(e));
    if (tool === 'text') { startText(p); return; }
    cv.setPointerCapture(e.pointerId);
    if (tool === 'crop') { cropRect = { x: p.x, y: p.y, w: 0, h: 0, ox: p.x, oy: p.y }; return; }
    draft = { t: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: $('edColor').value, w: Number($('edWidth').value) };
  });
  cv.addEventListener('pointermove', (e) => {
    const p = clampPt(pos(e));
    if (cropRect && e.buttons) {
      cropRect.x = Math.min(cropRect.ox, p.x); cropRect.y = Math.min(cropRect.oy, p.y);
      cropRect.w = Math.abs(p.x - cropRect.ox); cropRect.h = Math.abs(p.y - cropRect.oy); draw();
    } else if (draft) { draft.x2 = p.x; draft.y2 = p.y; constrain(draft, e.shiftKey); draw(); }
  });
  cv.addEventListener('pointerup', () => {
    if (draft) {
      const d = draft; draft = null;
      if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > 3) { pushUndo(); shapes.push(d); }
      draw();
    } else if (cropRect) {
      if (cropRect.w < 4 || cropRect.h < 4) { cropRect = null; draw(); return; }
      applyCrop();
    }
  });

  function applyCrop() {
    const r = cropRect; cropRect = null;
    pushUndo();
    const out = document.createElement('canvas');
    out.width = Math.round(r.w); out.height = Math.round(r.h);
    const c = out.getContext('2d');
    c.drawImage(base, -Math.round(r.x), -Math.round(r.y));
    c.translate(-Math.round(r.x), -Math.round(r.y));
    for (const s of shapes) drawShape(c, s);   // 주석을 바탕에 합쳐서 확정
    base = out; shapes = [];
    cv.width = out.width; cv.height = out.height;
    draw();
  }

  function startText(p) {
    const size = Number($('edSize').value), k = cv.clientWidth / cv.width;
    const inp = document.createElement('input');
    inp.className = 'tin'; inp.style.color = $('edColor').value;
    inp.style.left = `${p.x * k}px`; inp.style.top = `${p.y * k}px`; inp.style.fontSize = `${size * k}px`;
    inp._pt = { x: p.x, y: p.y, size, color: $('edColor').value };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') commitText(); else if (e.key === 'Escape') { inp.value = ''; commitText(); } });
    inp.addEventListener('blur', () => commitText());
    $('edWrap').append(inp); textInput = inp;
    setTimeout(() => inp.focus(), 0);
  }
  function commitText() {
    const inp = textInput; if (!inp) return;
    textInput = null;
    const text = inp.value.trim(), pt = inp._pt;
    inp.remove();
    if (!text) return;
    pushUndo();
    shapes.push({ t: 'text', x1: pt.x, y1: pt.y, text, size: pt.size, color: pt.color });
    draw();
  }

  function setTool(t) {
    commitText(); cropRect = null; tool = t; draw();
    for (const b of $('edTools').children) b.classList.toggle('on', b.dataset.tool === t);
    cv.style.cursor = t === 'text' ? 'text' : 'crosshair';
  }
  $('edTools').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTool(b.dataset.tool); });

  const doUndo = () => { commitText(); if (!undo.length) return; redo.push(snap0()); restore(undo.pop()); };
  const doRedo = () => { if (!redo.length) return; undo.push(snap0()); restore(redo.pop()); };
  $('edUndo').addEventListener('click', doUndo);
  $('edRedo').addEventListener('click', doRedo);

  function close() { commitText(); $('editor').hidden = true; base = null; shapes = []; undo = []; redo = []; draft = cropRect = null; }
  $('edCancel').addEventListener('click', close);
  $('edSave').addEventListener('click', async () => {
    commitText();
    const out = document.createElement('canvas');
    out.width = base.width; out.height = base.height;
    const c = out.getContext('2d'); c.drawImage(base, 0, 0);
    for (const s of shapes) drawShape(c, s);
    const id = await snap.addEdited(baseId, out.toDataURL('image/png'));
    close();
    if (id) { await refresh(id); toast('새 에셋으로 저장했습니다'); } else toast('저장하지 못했습니다');
  });

  window.addEventListener('keydown', (e) => {
    if ($('editor').hidden) return;
    if (e.target.tagName === 'INPUT' && e.target.className === 'tin') return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); doRedo(); }
    else if (e.key === 'Escape') { if (cropRect) { cropRect = null; draw(); } else close(); }
    else if (e.key === 'Enter' && cropRect && cropRect.w > 3) applyCrop();
    else if (!e.ctrlKey && !e.altKey && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
      const m = { r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', t: 'text', c: 'crop' }[k];
      if (m) { e.preventDefault(); setTool(m); }
    }
  });

  window.openEditor = async (id) => {
    const url = await snap.getImageData(id);
    if (!url) return;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    base = document.createElement('canvas');
    base.width = img.naturalWidth; base.height = img.naturalHeight;
    base.getContext('2d').drawImage(img, 0, 0);
    baseId = id; shapes = []; undo = []; redo = []; draft = cropRect = null;
    cv.width = base.width; cv.height = base.height;
    $('editor').hidden = false;
    setTool('rect'); sync();
  };
  $('edit').addEventListener('click', () => selectedId && window.openEditor(selectedId));
})();
