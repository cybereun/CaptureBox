# 제3자 소프트웨어 고지

CaptureBox의 OCR과 Windows 데스크톱 앱은 아래 제3자 구성요소를 포함합니다. 배포 패키지에는 이 문서, 앱의 `LICENSE`, 읽기 쉬운 `THIRD_PARTY_NOTICES.txt`, 그리고 `licenses/`의 라이선스 전문이 포함됩니다.

배포 패키지에 포함된 전체 고지는 `THIRD_PARTY_NOTICES.txt`를 확인하세요.

## 앱

- CaptureBox — MIT License, Copyright (c) 2026 cybereun. 전문은 배포된 `LICENSE` 파일에 있습니다.

## OCR 모델

- `PP-OCRv5_mobile_det_onnx` — PaddlePaddle, Apache License 2.0: https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx
- `korean_PP-OCRv5_mobile_rec_onnx` — PaddlePaddle, Apache License 2.0: https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx
- 두 모델 파일과 인식 사전은 빌드 시 내려받아 SHA-256을 확인한 뒤 패키지에 포함합니다. 모델의 Apache-2.0 전문은 `licenses/Apache-2.0.txt`에 있습니다.

## 추론 런타임

- ONNX Runtime Node.js 1.30.0 (`onnxruntime-node`, `onnxruntime-common`) 및 함께 제공되는 네이티브 런타임 — MIT License, Copyright (c) Microsoft Corporation.
- ONNX Runtime의 제3자 구성요소 및 별도 고지는 `licenses/ONNXRuntime-ThirdPartyNotices.txt`에 포함합니다. MIT 전문은 `licenses/ONNXRuntime-MIT-LICENSE.txt`에 있습니다.

## 앱 런타임 의존성

- `electron-updater`와 배포 패키지에 포함된 npm 런타임 의존성의 이름·버전·SPDX 라이선스는 `THIRD_PARTY_NOTICES.txt`에 기재합니다. 각 패키지의 라이선스 파일은 `app.asar` 안의 해당 패키지 폴더에 보존하며, 패키지 원본에 별도 라이선스 파일이 없던 `lazy-val`의 MIT 전문은 `licenses/lazy-val-MIT-LICENSE.txt`에 포함합니다.
- Electron Builder는 Electron의 `LICENSE.electron.txt`와 Chromium의 `LICENSES.chromium.html`을 앱 패키지에 포함합니다.
- `electron-builder`는 빌드 전용 개발 의존성이므로 앱 런타임에 포함하지 않습니다.

## 알고리즘 참고

- `ppocr.js`는 kordoc의 OCR 전·후처리 흐름을 참고하여 다시 작성했습니다. kordoc의 소스 코드는 CaptureBox에 포함하지 않습니다. 출처: https://github.com/chrisryugj/kordoc (MIT License; 전문은 `licenses/kordoc-MIT-LICENSE.txt`).
