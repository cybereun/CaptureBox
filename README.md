<div align="center">

<img src="assets/icon.png" width="128" alt="CaptureBox">

# CaptureBox

**캡처하고, 꾸미고, 보관하는 Windows 캡처 앱**

[![Developer](https://img.shields.io/badge/Developer-cybereun-181717?logo=github&logoColor=white)](https://github.com/cybereun)
[![Release](https://img.shields.io/github/v/release/cybereun/CaptureBox?label=release&color=7c3aed)](https://github.com/cybereun/CaptureBox/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/cybereun/CaptureBox/total?color=4c8dff)](https://github.com/cybereun/CaptureBox/releases)
![Platform](https://img.shields.io/badge/Platform-Windows-0078d4?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-47848f?logo=electron&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

</div>

---

## 특징

- **4가지 캡처 모드**: 영역 · 창 · 전체 화면 · **스크롤 캡처**(긴 페이지를 자동으로 내리며 한 장으로 이어 붙임)
- **에셋 패널**: 캡처마다 자동 보관. 목록에서 미리보기, 더블클릭 복사, 카톡·문서·폴더로 **끌어서 바로 놓기**
- **편집기**: 사각틀 · 원형틀 · 선/밑줄 · 화살표 · 문자(배경 박스 지원) · 형광펜 · 번호 스티커 · 모자이크/블러 · 자르기, **그린 주석 선택·이동·삭제·색 변경**, 실행 취소/다시 실행. 편집본은 **새 에셋으로 저장**되어 원본은 그대로 남습니다
- **트레이 상주**: 창을 닫아도 트레이에 남아 단축키(`Ctrl+Alt+1/2/3`)로 바로 캡처, 트레이 우클릭 메뉴에서 종료
- **글자 인식(OCR)**: 캡처 안의 글자를 읽어 클립보드로 복사. 기본은 **정밀 모드**(PP-OCRv5 한국어, 오프라인·모델 내장)이고, 설정에서 Windows 내장 방식으로 바꿀 수 있습니다. 정밀 모드를 쓸 수 없으면 자동으로 Windows 내장으로 대체합니다
- **화면에 고정(핀)**: 캡처를 작은 창으로 모든 창 위에 계속 띄워 두기 (끌어서 이동, Ctrl+휠 크기, Alt+휠 투명도)
- **확대·축소**: 미리보기에서 `Ctrl + 마우스 휠`
- **단축키 직접 지정**과 **윈도우 시작 시 자동 실행**(트레이로 시작) 옵션: 설정에서 변경
- **저장 폴더 지정**: 기본값은 `사진\Screenshots` 폴더. 설정에서 한 번 지정하면 다시 바꾸기 전까지 유지
- **지연 캡처**(3/5/10초), 캡처 후 **자동 클립보드 복사**
- **자동 업데이트**: 새 버전이 올라오면 앱이 알려주고, 클릭 한 번으로 재설치 후 다시 실행

## 설치

1. [**Releases**](https://github.com/cybereun/CaptureBox/releases/latest) 에서 `CaptureBox-Setup-x.x.x.exe` 를 내려받습니다.
2. 실행하면 바로 설치되고 앱이 시작됩니다. (관리자 권한 불필요)
3. 코드 서명이 없어서 처음에 Windows SmartScreen 경고가 뜰 수 있습니다. **추가 정보 → 실행** 을 누르세요.

이후 업데이트는 앱 안에서 자동으로 안내됩니다.

## 사용 방법

### 캡처

| 모드 | 설명 | 단축키 |
|---|---|---|
| 영역 | 화면이 멈추면 드래그로 영역 선택 (Esc 취소) | `Ctrl+Alt+1` |
| 창 | 열려 있는 창 목록(썸네일)에서 선택 | – |
| 전체 화면 | 마우스가 있는 모니터 전체 | `Ctrl+Alt+2` |
| 스크롤 | 스크롤되는 부분만 드래그하면 자동으로 내려가며 이어 붙임 | `Ctrl+Alt+3` |

> 스크롤 캡처는 고정 헤더/사이드바를 제외하고 선택하면 결과가 깔끔합니다. 영상·애니메이션 영역과 무한 스크롤 페이지는 정확도가 떨어질 수 있습니다.

### 에셋 패널

- 클릭: 미리보기 · 더블클릭: 복사 · 끌어서 다른 앱에 놓기
- 이름 변경, PNG/JPG로 저장, 폴더에서 보기, `Delete` 삭제, `Ctrl+C` 복사
- **여러 개 삭제**: 에셋 목록 위 `선택` 버튼 → 항목을 눌러 체크(`Shift`+클릭은 범위, `전체`는 모두) → `삭제`. 확인 창을 거치며 되돌릴 수 없습니다

### 편집

에셋을 선택하고 **편집** 버튼을 누릅니다.

| 도구 | 키 | 비고 |
|---|---|---|
| 선택 | `V` | 주석을 눌러 이동 · `Delete` 삭제 · 위쪽 색/굵기/크기 변경 |
| 사각틀 / 원형틀 | `R` / `O` | `Shift` = 정사각형 / 정원 |
| 선·밑줄 / 화살표 | `L` / `A` | `Shift` = 45° 단위 고정 |
| 문자 | `T` | 클릭 후 입력, `Enter` 확정 · ‘글자 배경’으로 색 박스 |
| 형광펜 | `H` | 드래그한 영역에 반투명 색 |
| 번호 스티커 | `N` | 클릭할 때마다 ①②③… 자동 증가 |
| 모자이크 / 블러 | `M` / `B` | 가릴 영역 드래그, 굵기로 강도 조절 |
| 자르기 | `C` | 드래그 후 `Enter` 로 적용 |

`Ctrl+Z` / `Ctrl+Y` 로 취소·다시 실행, **새 에셋으로 저장** 으로 마무리합니다.

### 글자 인식 · 화면 고정

에셋을 선택하고 **글자 인식** 을 누르면 이미지 안의 글자가 클립보드에 복사되고 결과 창에 표시됩니다. **고정** 을 누르면 캡처가 작은 창으로 화면 위에 계속 떠 있습니다(더블클릭·Esc로 닫기).

### 설정 ⚙

저장 폴더 변경(기존 캡처도 함께 이동), 업데이트 확인, 사용 도움말.

## 개발

```bash
npm install
npm start        # 실행
npm test         # 스크롤 이어붙이기 로직 테스트
npm run models   # 정밀 OCR 모델 내려받기 (models/, dist 전에 자동 실행)
npm run dist     # 설치 파일 빌드 (dist/)
npm run verify   # 설치본 자동 검증 (빌드 후 실제 앱을 실행해 핵심 기능을 시험)
```

> 구글 드라이브 같은 가상 드라이브 위에서는 `npm install` 이 실패할 수 있으니 로컬 디스크에서 실행하세요.

### 릴리즈

1. `package.json` 의 `version` 을 올립니다.
2. `npm run verify` 로 빌드하고 **설치본 자동 검증**을 통과시킵니다. (모든 모니터에서 화면/스크롤/영역 캡처, OCR, 핀, 단축키, 자동 실행, 트레이 상주를 실제로 실행해 확인합니다. 실행 중 화면이 몇 번 어두워지고 테스트 창이 뜹니다.)
3. GitHub Release(태그 `vX.Y.Z`)에 `CaptureBox-Setup-X.Y.Z.exe`, `.blockmap`, `latest.yml` 을 올립니다.

설치된 앱은 시작 직후, 이후 3분마다, 창을 다시 켤 때마다 최신 릴리즈를 확인해 자동으로 내려받고, 알림 카드/푸터의 버튼으로 재설치합니다.

## 오픈소스 고지

정밀 글자 인식은 PaddleOCR PP-OCRv5(Apache-2.0) 모델과 ONNX Runtime(MIT)을 쓰고, 추론 방식은 [kordoc](https://github.com/chrisryugj/kordoc)(MIT)을 참고했습니다. 자세한 내용은 [THIRD_PARTY.md](THIRD_PARTY.md).

## 라이선스

MIT © [cybereun](https://github.com/cybereun)
