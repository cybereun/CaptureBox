'use strict';
const $ = (id) => document.getElementById(id);
const MODE_LABEL = { region: '영역', window: '창', fullscreen: '전체 화면', scroll: '스크롤' };

let assets = [];
let selectedId = null;
let toastTimer;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

const current = () => assets.find((a) => a.id === selectedId);
const fmtDate = (ts) => new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function refresh(select) {
  assets = await snap.listAssets();
  if (select) selectedId = select;
  if (!current()) selectedId = assets[0] ? assets[0].id : null;
  renderList();
  renderViewer();
}

function renderList() {
  $('count').textContent = assets.length;
  const list = $('list');
  list.replaceChildren();
  if (!assets.length) {
    const d = document.createElement('div');
    d.className = 'list-empty';
    d.textContent = '아직 캡처가 없습니다';
    list.append(d);
    return;
  }
  for (const a of assets) {
    const el = document.createElement('div');
    el.className = 'item' + (a.id === selectedId ? ' sel' : '');
    el.draggable = true;
    const img = document.createElement('img');
    img.src = a.thumbUrl;
    img.alt = '';
    img.draggable = false;
    const t = document.createElement('div');
    t.className = 't';
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = a.name;
    const m = document.createElement('div');
    m.className = 'm';
    m.textContent = `${a.width}×${a.height} · ${MODE_LABEL[a.mode] || ''} · ${fmtDate(a.createdAt)}`;
    t.append(n, m);
    el.append(img, t);
    el.addEventListener('click', () => { selectedId = a.id; renderList(); renderViewer(); });
    el.addEventListener('dblclick', async () => { await snap.copy(a.id); toast('클립보드에 복사했습니다'); });
    el.addEventListener('dragstart', (e) => { e.preventDefault(); snap.drag(a.id); });
    list.append(el);
  }
}

function renderViewer() {
  const a = current();
  $('empty').hidden = !!a;
  $('viewer').hidden = !a;
  $('ftAsset').hidden = !a;   // 이름·크기 정보는 아래쪽 푸터에 표시
  if (!a) return;
  if ($('preview').getAttribute('src') !== a.url) { setZoom(0); cvFull(false); }
  $('preview').src = a.url;
  if (document.activeElement !== $('name')) $('name').value = a.name;
  $('meta').textContent = `${a.width} × ${a.height} px · ${MODE_LABEL[a.mode] || ''}`;
}

/* 캡처 시작 */
for (const btn of document.querySelectorAll('.modes button')) {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    if (mode === 'window') return openPicker();
    snap.capture(mode, $('delay').value);
  });
}

async function openPicker() {
  const grid = $('winGrid');
  grid.replaceChildren();
  $('picker').hidden = false;
  const wins = await snap.listWindows();
  if (!wins.length) { grid.textContent = '캡처할 수 있는 창이 없습니다'; return; }
  for (const w of wins) {
    const b = document.createElement('button');
    b.className = 'win';
    const img = document.createElement('img');
    img.src = w.thumb;
    img.alt = '';
    const s = document.createElement('span');
    s.textContent = w.name;
    s.title = w.name;
    b.append(img, s);
    b.addEventListener('click', async () => {
      $('picker').hidden = true;
      const r = await snap.captureWindow(w.id);
      if (r.ok) { await refresh(r.select); toast(r.toast); } else toast(r.message);
    });
    grid.append(b);
  }
}
$('pickClose').addEventListener('click', () => ($('picker').hidden = true));
$('picker').addEventListener('click', (e) => { if (e.target === $('picker')) $('picker').hidden = true; });

/* 뷰어 동작 */
$('fit').addEventListener('click', toggleFit);
$('preview').addEventListener('click', toggleFit);
let zoom = 0; // 0 = 맞춤/100% 토글 모드, 그 외 = Ctrl+휠 배율
function setZoom(z) {
  zoom = z;
  const img = $('preview'), cv = $('canvas');
  cv.classList.toggle('zoomed', !!z);
  cv.classList.toggle('full', !!z);
  img.style.width = z ? `${Math.round(img.naturalWidth * z)}px` : '';
  img.style.height = z ? 'auto' : '';
  $('zoomLabel').textContent = z ? `${Math.round(z * 100)}%` : '';
  $('fit').textContent = z || cv.classList.contains('full') ? '맞춤' : '100%';
}
function toggleFit() {
  if (zoom) { setZoom(0); cvFull(false); return; }
  cvFull(!$('canvas').classList.contains('full'));
}
function cvFull(on) {
  $('canvas').classList.toggle('full', on);
  $('fit').textContent = on ? '맞춤' : '100%';
}
$('canvas').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const img = $('preview'), cv = $('canvas');
  if (!img.naturalWidth) return;
  const cur = zoom || (cv.classList.contains('full') ? 1 : Math.min(1, img.clientWidth / img.naturalWidth));
  const next = Math.min(8, Math.max(0.05, cur * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  const r = cv.getBoundingClientRect(), px = e.clientX - r.left + cv.scrollLeft, py = e.clientY - r.top + cv.scrollTop;
  setZoom(next);
  cv.scrollLeft = px * (next / cur) - (e.clientX - r.left);
  cv.scrollTop = py * (next / cur) - (e.clientY - r.top);
}, { passive: false });
$('copy').addEventListener('click', async () => { if (selectedId) { await snap.copy(selectedId); toast('클립보드에 복사했습니다'); } });
$('save').addEventListener('click', async () => { if (selectedId && (await snap.save(selectedId))) toast('저장했습니다'); });
$('reveal').addEventListener('click', () => selectedId && snap.reveal(selectedId));
$('del').addEventListener('click', deleteCurrent);
async function deleteCurrent() {
  if (!selectedId) return;
  const i = assets.findIndex((a) => a.id === selectedId);
  await snap.remove(selectedId);
  selectedId = null;
  await refresh();
  const next = assets[Math.min(i, assets.length - 1)];
  if (next) { selectedId = next.id; renderList(); renderViewer(); }
}
$('name').addEventListener('change', async () => {
  if (!selectedId) return;
  await snap.rename(selectedId, $('name').value);
  await refresh();
});
$('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

window.addEventListener('keydown', async (e) => {
  if (!$('editor').hidden || !$('ocrBox').hidden) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'Delete') deleteCurrent();
  else if (e.key === 'Escape') $('picker').hidden = true;
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selectedId) {
    await snap.copy(selectedId);
    toast('클립보드에 복사했습니다');
  }
});

/* 설정 / 이벤트 */
$('autoCopy').addEventListener('change', (e) => snap.setSettings({ autoCopy: e.target.checked }));
snap.onChanged(async (p) => {
  if (p.select) await refresh(p.select);
  if (p.toast) toast(p.toast);
});

(async () => {
  const s = await snap.getSettings();
  $('autoCopy').checked = !!s.autoCopy;
  await refresh();
})();
