# Microsoft Store 등록 정보 (Partner Center에 붙여 넣을 내용)

앱: **CaptureBox** · Store ID `9PMZV1PGNGGH` · 패키지 `LebiCybereun.CaptureBox` · 게시자 `Lebi_Cybereun`

## 1. 패키지 올리기
1. 로컬 디스크(구글 드라이브 X)에서 `npm ci` → `npm run msix`
2. 생성된 `dist-store/CaptureBox-Store-<버전>.appx` 를 Partner Center > 제출 > **패키지**에 올립니다.
   - `.appx`는 `.msix`와 같은 패키지 형식이며 Store가 둘 다 받습니다.
   - Store에 올리는 패키지는 **서명하지 않습니다**(Store가 서명). 그래서 내 PC에 직접 설치해 볼 수는 없습니다.
3. 새 제출마다 `package.json`의 `version`을 올려야 합니다 (패키지 버전은 `1.5.1` → `1.5.1.0` 으로 만들어집니다. 마지막 자리는 Store 예약값이라 0이어야 합니다).

## 2. 제품 설명
**짧은 설명 (100자 이내)**
```
캡처하고, 꾸미고, 글자까지 복사. 스크롤 캡처, 모자이크, 한국어 글자 인식(OCR), 화면 고정을 한 앱으로.
```

**설명**
```
스크린샷 한 장 정리하려고 앱 여러 개 열지 마세요. CaptureBox 하나로 캡처부터 꾸미기, 개인정보 가리기, 글자 복사까지 끝냅니다.

■ 캡처 4종 + 단축키
영역 · 창 · 전체 화면 · 스크롤 캡처. Ctrl+Alt+1/2/3 단축키로 창을 닫아도(트레이 대기) 바로 캡처하고, 단축키는 설정에서 바꿀 수 있어요.

■ 스크롤 캡처
긴 페이지를 자동으로 스크롤하면서 한 장으로 이어 붙여요.

■ 바로 꾸미기
사각틀 · 원 · 화살표 · 번호 스티커 · 형광펜 · 글자 · 자르기. 편집본은 새 파일로 저장되고 원본은 그대로 남아요.

■ 모자이크 · 블러
이름, 번호, 계좌 같은 개인정보를 공유하기 전에 한 번에 가려요.

■ 한국어 글자 인식(OCR)
이미지 속 글자를 읽어 클립보드로 복사해요. 한국어 정밀 모델이 앱에 들어 있어 인터넷 없이 동작합니다.

■ 화면에 고정
캡처를 작은 창으로 모든 창 위에 띄워 두세요. 끌어서 이동, Ctrl+휠로 크기, Alt+휠로 투명도.

■ 클립보드 · 인쇄
'캡처 시 대시보드 열지 않음'으로 바로 붙여넣기. Ctrl+P 인쇄 미리보기에서 용지, 방향, 여백도 고를 수 있어요.

■ 개인정보
계정도 광고도 없고, 캡처 이미지는 PC 밖으로 나가지 않아요. 앱이 직접 인터넷에 접속하지 않습니다.
```

**이 버전의 새로운 기능**
```
첫 Microsoft Store 출시입니다.
```

**검색 키워드 (최대 7개)**
`스크린샷`, `화면 캡처`, `스크롤 캡처`, `OCR`, `모자이크`, `캡처 도구`, `글자 인식`

**카테고리**: 유틸리티 및 도구 (또는 사진 및 비디오)

## 3. 필수 링크
| 항목 | 값 |
|---|---|
| 개인정보처리방침 URL | https://cybereun.github.io/CaptureBox/privacy.html |
| 웹사이트 | https://cybereun.github.io/CaptureBox/ |
| 지원 연락처 | https://github.com/cybereun/CaptureBox/issues |

## 4. 인증용 메모 (Partner Center > 제출 > 인증 메모, 그리고 `runFullTrust` 사유)
Electron 앱은 `runFullTrust` 제한 기능이 필요합니다. 사유 입력란에 아래를 붙여 넣으세요.

```
CaptureBox is a screen-capture utility built on Electron, which runs as a full-trust desktop app (runFullTrust).
Full trust is required for: (1) capturing the screen via the Chromium desktop capture API when the user presses a capture hotkey or button;
(2) registering global hotkeys (Ctrl+Alt+1/2/3) so capture works while the window is closed to the tray;
(3) for "scroll capture", injecting mouse-wheel events into the region the user selected, only while a scroll capture is running;
(4) launching the bundled PowerShell scripts (input helper and a Windows OCR fallback) that ship inside the package;
(5) saving screenshots to the folder the user chooses (default: Pictures\Screenshots).
No personal data is collected or transmitted. The app makes no network connections in the Store build (auto-update is disabled; the Store handles updates).
```

**테스트 방법 (인증 담당자용)**
```
No account or sign-in is required.
1. Launch CaptureBox. Press Ctrl+Alt+1, drag over any area of the screen -> the screenshot appears in the asset list on the right.
2. Select an asset and click "편집" (Edit) to annotate, or "글자 인식" (OCR) to extract text to the clipboard.
3. Closing the window keeps the app in the system tray; Ctrl+Alt+1/2/3 still captures. Right-click the tray icon > "종료" (Quit) to exit.
Notes: the Store build has auto-update and "start at login" disabled by design.
```

## 5. Store 버전과 GitHub 설치 버전의 차이 (고객 문의 대비)
- **자동 업데이트**: Store 버전은 Store가 업데이트합니다 (앱 내 업데이트 확인 버튼 없음).
- **윈도우 시작 시 자동 실행**: Store(MSIX) 패키지에서는 레지스트리 쓰기가 가상화되어 기존 방식이 동작하지 않아 Store 버전에서는 제공하지 않습니다.

## 6. 스크린샷 (제출 전 준비)
- PC 스크린샷 1~10장(권장 1920×1080, 최소 1366×768, PNG/JPG). 앱 화면에 개인정보가 없는지 확인하세요.
- 선택: 앱 아이콘 설명 이미지, 프로모션 이미지(1920×1080 등).

## 7. 가격 · 연령 등급
- 가격: 무료 · 앱 내 구매/광고 없음
- IARC 연령 등급 설문: 폭력·성적 콘텐츠·도박·사용자 간 소통 기능 모두 "아니요"
