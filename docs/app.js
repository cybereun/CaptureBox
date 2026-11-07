'use strict';
/* 최신 릴리즈 정보(버전·다운로드 링크) 불러오기, 등장 효과, 이미지 확대 */
(() => {
  const REPO = 'cybereun/CaptureBox';
  const FALLBACK = `https://github.com/${REPO}/releases/latest`;

  // 최신 버전과 설치 파일 링크. 실패하면(제한·오프라인) 기본 링크를 그대로 쓴다.
  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((rel) => {
      const ver = String(rel.tag_name || '').replace(/^v/, '');
      const exe = (rel.assets || []).find((a) => /Setup.*\.exe$/i.test(a.name));
      document.querySelectorAll('[data-version]').forEach((el) => { if (ver) el.textContent = `v${ver}`; });
      document.querySelectorAll('[data-download]').forEach((el) => {
        if (exe) el.href = exe.browser_download_url;
        const label = el.querySelector('[data-file]');
        if (label && exe) label.textContent = `${exe.name} · ${(exe.size / 1048576).toFixed(0)}MB`;
      });
    })
    .catch(() => { document.querySelectorAll('[data-download]').forEach((el) => { el.href = FALLBACK; }); });

  // 등장 효과
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.15 })
    : null;
  document.querySelectorAll('.reveal').forEach((el) => (io ? io.observe(el) : el.classList.add('in')));

  // 갤러리 확대
  const box = document.getElementById('lightbox');
  const big = box && box.querySelector('img');
  document.querySelectorAll('.shot').forEach((b) => b.addEventListener('click', () => { big.src = b.dataset.full; big.alt = b.dataset.alt || ''; box.classList.add('on'); }));
  if (box) {
    box.addEventListener('click', () => box.classList.remove('on'));
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') box.classList.remove('on'); });
  }
})();
