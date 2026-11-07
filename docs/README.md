# CaptureBox 사이트

[CaptureBox](https://github.com/cybereun/CaptureBox) — 캡처하고, 꾸미고, 글자까지 복사하는 Windows 캡처 앱의 홍보 사이트입니다.

- 사이트: https://cybereun.github.io/CaptureBox/
- 앱 내려받기: https://github.com/cybereun/CaptureBox/releases/latest

이 패키지에는 사이트의 정적 파일(`index.html`, `style.css`, `app.js`, `img/`)이 들어 있습니다.
저장소의 `docs/` 폴더가 GitHub Pages로 게시되고, 같은 내용이 GitHub Actions로 이 패키지에도 게시됩니다.

## 내려받기

```bash
npm install @cybereun/capturebox-site --registry=https://npm.pkg.github.com
```

GitHub Packages는 읽기에도 인증이 필요할 수 있습니다. 그럴 때는 `~/.npmrc` 에 아래를 추가하세요.

```
@cybereun:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<read:packages 권한이 있는 토큰>
```

## 라이선스

MIT
