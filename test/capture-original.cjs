// Restore a minimized window, capture it with PrintWindow, then minimize it again.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const out = process.argv[2];
const hwnd = process.argv[3];
fs.mkdirSync(path.dirname(out), { recursive: true });

const ps = String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class W2 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct RECT { public int L,T,R,B; }
}
'@
[W2]::SetProcessDPIAware() | Out-Null
$h = [IntPtr]::new([Int64]$env:CAP_HWND)
$wasMin = [W2]::IsIconic($h)
if ($wasMin) { [W2]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 900 }
[W2]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 700
$r = New-Object 'W2+RECT'
[W2]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L; $ht = $r.B - $r.T
Write-Output "size=$w x $ht wasMinimized=$wasMin"
if ($w -gt 0 -and $ht -gt 0) {
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  $ok = [W2]::PrintWindow($h, $dc, 2)
  $g.ReleaseHdc($dc); $g.Dispose()
  Write-Output "printwindow=$ok"
  $bmp.Save($env:CAP_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
if ($wasMin) { [W2]::ShowWindow($h, 6) | Out-Null; Write-Output 'reminimized' }
Write-Output 'done'
`;

try {
  const stdout = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
    env: { ...process.env, CAP_OUT: out, CAP_HWND: hwnd },
    encoding: 'utf8',
  });
  console.log(stdout.trim());
  console.log('exists=' + fs.existsSync(out) + ' bytes=' + (fs.existsSync(out) ? fs.statSync(out).size : 0));
} catch (error) {
  console.error(String(error.stderr || error.message).slice(0, 1200));
  process.exitCode = 1;
}
