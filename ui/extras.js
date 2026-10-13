'use strict';
/* 글자 인식(OCR) 결과 창, 화면 고정(핀) */
(() => {
  const $ = (id) => document.getElementById(id);
  const sel = () => (typeof selectedId !== 'undefined' ? selectedId : null);

  $('ocr').addEventListener('click', async () => {
    const id = sel();
    if (!id) return;
    const btn = $('ocr');
    btn.disabled = true;
    toast('글자를 인식하는 중…');
    let r;
    try { r = await snap.ocr(id); } catch (e) { r = { ok: false, message: e.message }; }
    btn.disabled = false;
    if (!r.ok) { toast(`글자 인식 실패: ${r.message}`); return; }
    if (!r.text) { toast(r.message || '인식된 글자가 없습니다'); return; }
    $('ocrText').value = r.text;
    const eng = r.engine === 'precise' ? '정밀 모드' : 'Windows 내장';
    $('ocrInfo').textContent = `${r.text.length.toLocaleString()}자 · ${eng} · 클립보드에 복사됨${r.note ? ` · ${r.note}` : ''}`;
    $('ocrBox').hidden = false;
    toast('글자를 인식해 클립보드에 복사했습니다');
  });
  $('ocrCopy').addEventListener('click', async () => { await snap.copyText($('ocrText').value); toast('클립보드에 복사했습니다'); });
  $('ocrClose').addEventListener('click', () => ($('ocrBox').hidden = true));
  $('ocrBox').addEventListener('click', (e) => { if (e.target === $('ocrBox')) $('ocrBox').hidden = true; });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('ocrBox').hidden) $('ocrBox').hidden = true; });

  $('pinBtn').addEventListener('click', async () => {
    const id = sel();
    if (!id) return;
    if (await snap.pin(id)) toast('화면에 고정했습니다 (더블클릭하면 닫혀요)');
  });
})();
