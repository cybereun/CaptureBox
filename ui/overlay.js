'use strict';
const $ = (id) => document.getElementById(id);
const sel = $('sel'), tag = $('tag'), dim = $('dim');
let start = null;
let rect = null;

overlay.onInit(({ shot, mode }) => {
  $('bg').style.backgroundImage = `url(${shot})`;
  if (mode === 'scroll') $('hint').textContent = '스크롤할 영역을 드래그하세요 (페이지의 스크롤되는 부분) · Esc 취소';
});

function update(e) {
  const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
  const w = Math.abs(e.clientX - start.x), h = Math.abs(e.clientY - start.y);
  rect = { x, y, w, h };
  Object.assign(sel.style, { display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  tag.textContent = `${w} × ${h}`;
  Object.assign(tag.style, { display: 'block', left: x + 'px', top: Math.max(0, y - 28) + 'px' });
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return overlay.cancel();
  start = { x: e.clientX, y: e.clientY };
  dim.style.display = 'none';
  $('hint').style.display = 'none';
});
window.addEventListener('mousemove', (e) => { if (start) update(e); });
window.addEventListener('mouseup', (e) => {
  if (!start) return;
  update(e);
  if (rect.w < 8 || rect.h < 8) { start = null; sel.style.display = tag.style.display = 'none'; dim.style.display = ''; return; }
  overlay.done(rect);
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.cancel(); });
window.addEventListener('contextmenu', (e) => { e.preventDefault(); overlay.cancel(); });
