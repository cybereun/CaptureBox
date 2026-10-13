'use strict';
/* 푸터(버전/업데이트), 설정 창, 업데이트 알림 카드 */
(() => {
  const $ = (id) => document.getElementById(id);
  let u = { state: 'idle', version: '' };
  let dismissed = '';

  function label(s) {
    switch (s.state) {
      case 'checking': return '업데이트 확인 중…';
      case 'downloading': return `새 버전 ${s.latest || ''} 다운로드 중 ${s.percent || 0}%`;
      case 'ready': return `새 버전 ${s.latest} 준비됨`;
      case 'latest': return '최신 버전입니다';
      case 'dev': return '개발 모드 – 자동 업데이트는 설치본에서만 동작합니다';
      case 'error': return `업데이트 확인 실패: ${s.message || ''}`;
      default: return '';
    }
  }

  function render() {
    $('ftVersion').textContent = u.version ? `v${u.version}` : '';
    $('brandVer').textContent = u.version ? `v${u.version}` : '';
    $('setVer').textContent = u.version ? `v${u.version}` : '';
    const ready = u.state === 'ready', busy = u.state === 'checking' || u.state === 'downloading';
    const ft = $('ftUpdate');
    ft.hidden = !(ready || u.state === 'downloading');
    ft.classList.toggle('ready', ready);
    ft.textContent = ready ? `⟳ v${u.latest} 업데이트` : `v${u.latest || ''} 다운로드 ${u.percent || 0}%`;
    ft.disabled = !ready;
    $('ftStatus').textContent = ['error', 'checking', 'latest'].includes(u.state) ? label(u) : '';
    $('setUpd').textContent = label(u);
    $('setCheck').disabled = busy;
    $('setInstall').hidden = !ready;
    const showCard = ready && dismissed !== u.latest;
    $('updCard').hidden = !showCard;
    if (showCard) {
      $('updTitle').textContent = `새 버전 v${u.latest} 이(가) 있습니다`;
      $('updNote').textContent = u.notes ? u.notes.replace(/<[^>]+>/g, '').trim() : '지금 업데이트하면 앱이 재설치되고 자동으로 다시 실행됩니다.';
    }
  }

  const install = () => snap.installUpdate();
  $('ftUpdate').addEventListener('click', install);
  $('updNow').addEventListener('click', install);
  $('setInstall').addEventListener('click', install);
  $('updLater').addEventListener('click', () => { dismissed = u.latest; render(); });
  $('setCheck').addEventListener('click', () => snap.checkUpdate());
  $('openSettings').addEventListener('click', () => { $('settings').hidden = false; });
  $('setClose').addEventListener('click', () => ($('settings').hidden = true));
  $('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').hidden = true; });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('settings').hidden) $('settings').hidden = true; });

  async function loadStore(r) {
    const i = r || (await snap.getStore());
    $('storeDir').textContent = i.dir;
    $('storeReset').disabled = i.isDefault;
    const msg = i.message || i.error || '';
    $('storeMsg').textContent = msg;
    $('storeMsg').classList.toggle('err', !!msg);
  }
  $('storeChoose').addEventListener('click', async () => {
    const r = await snap.chooseStore();
    if (r.canceled) return;
    await loadStore(r);
    if (r.ok) toast('저장 폴더를 변경했습니다');
  });
  $('storeReset').addEventListener('click', async () => {
    const r = await snap.resetStore();
    await loadStore(r);
    if (r.ok) toast('기본 위치로 되돌렸습니다');
  });
  $('storeOpen').addEventListener('click', () => snap.openStore());
  $('openSettings').addEventListener('click', () => loadStore());

  /* 탭 / 도움말 아코디언 */
  $('setNav').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const n of $('setNav').children) n.classList.toggle('on', n === b);
    for (const s of document.querySelectorAll('.spane')) s.hidden = s.id !== b.dataset.pane;
  });
  for (const h of document.querySelectorAll('.acc-h')) {
    h.addEventListener('click', () => {
      const open = h.getAttribute('aria-expanded') !== 'true';
      for (const o of document.querySelectorAll('.acc-h')) {
        o.setAttribute('aria-expanded', String(o === h && open));
        o.nextElementSibling.hidden = !(o === h && open);
      }
    });
  }

  snap.onUpdate((s) => { u = s; render(); });
  snap.getUpdate().then((s) => { u = s; render(); });
})();
