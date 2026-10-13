# Windows 내장 OCR(Windows.Media.Ocr)로 이미지 파일의 글자를 읽는다.
# 사용: powershell -File ocr.ps1 <png1> [<png2> ...]
# 출력: 파일마다 인식된 줄들 + 구분선("<<<CB-CHUNK>>>"). 실패 시 stderr에 메시지, 종료 코드 2.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  function Await($op, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }

  # 한국어 우선, 없으면 사용자 프로필 언어, 그다음 영어
  $engine = $null
  foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
    if ($l.LanguageTag -like 'ko*') { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($l); break }
  }
  if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if ($null -eq $engine) {
    foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
      if ($l.LanguageTag -like 'en*') { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($l); break }
    }
  }
  if ($null -eq $engine) { throw 'OCR 엔진을 만들 수 없습니다. 설정 > 시간 및 언어 > 언어에서 한국어(또는 영어) 언어 팩의 "텍스트 인식"을 설치해 주세요.' }

  foreach ($path in $args) {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    foreach ($line in $result.Lines) { [Console]::Out.WriteLine($line.Text) }
    [Console]::Out.WriteLine('<<<CB-CHUNK>>>')
    $stream.Dispose()
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
