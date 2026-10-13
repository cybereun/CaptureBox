# 스크롤 캡처용 입력 주입기. stdin 명령: "move X Y" / "wheel N"(음수=아래로) / "quit"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SnapInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
}
"@
[SnapInput]::SetProcessDPIAware() | Out-Null
[Console]::Out.WriteLine("ready")
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $p = $line.Split(' ')
  switch ($p[0]) {
    'move'  { [SnapInput]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null }
    'wheel' { [SnapInput]::mouse_event(0x0800, 0, 0, [int]$p[1] * 120, [UIntPtr]::Zero) }
    'quit'  { exit }
  }
  [Console]::Out.WriteLine("ok")
}
