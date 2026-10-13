# 제3자 소프트웨어 고지

CaptureBox 의 정밀 글자 인식(OCR)은 아래 오픈소스 구성요소를 사용합니다.

## 모델 — PaddleOCR PP-OCRv5 (Apache License 2.0)
- 검출: `PP-OCRv5_mobile_det` · 인식: `korean_PP-OCRv5_mobile_rec` (PaddlePaddle 공식 ONNX 변환본)
- 출처: https://huggingface.co/PaddlePaddle , https://github.com/PaddlePaddle/PaddleOCR
- 모델 파일은 빌드할 때 내려받아(SHA-256 검증) 설치 파일에 함께 넣습니다 (`scripts/fetch-models.js`).

## 추론 방식 참고 — kordoc (MIT License)
- `ppocr.js` 의 전·후처리 값과 추론 흐름(검출 → 박스 확장 → 줄 인식 → CTC 디코딩)은 kordoc 의 `src/ocr` 을 참고해
  화면 캡처용으로 다시 작성했습니다.
- 출처: https://github.com/chrisryugj/kordoc — Copyright (c) 2026 chrisryugj, MIT License

## 런타임 — ONNX Runtime (MIT License)
- `onnxruntime-node` — https://github.com/microsoft/onnxruntime , Copyright (c) Microsoft Corporation

## 그 밖
- Electron (MIT), electron-updater / electron-builder (MIT)
