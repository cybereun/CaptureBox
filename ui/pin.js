'use strict';
const img = document.getElementById('img');
pin.onInit((url) => { img.src = url; });

let dragging = false;
img.addEventListener('mousedown', (e) => { if (e.button !== 0) return; dragging = true; pin.begin(); });
window.addEventListener('mousemove', (e) => { if (dragging && e.buttons & 1) pin.drag(); });
window.addEventListener('mouseup', () => { dragging = false; });
img.addEventListener('dblclick', () => pin.close());
document.getElementById('x').addEventListener('click', () => pin.close());
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') pin.close(); });
window.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey) pin.zoom(e.deltaY < 0 ? 1 : -1);
  else if (e.altKey) pin.opacity(e.deltaY < 0 ? 1 : -1);
}, { passive: false });
window.addEventListener('contextmenu', (e) => { e.preventDefault(); pin.close(); });
