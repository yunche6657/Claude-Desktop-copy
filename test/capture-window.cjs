// Capture one native window into a PNG using Win32 GDI, no external dependencies.
const ffi = null; // placeholder to keep this file self-documenting
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ps = String.raw`
Add-Type -AssemblyName System.Drawing
$sig = @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int L,T,R,B; }
}
'@
Add-Type -TypeDefinition $sig
[W]::SetProcessDPIAware() | Out-Null
$h = [IntPtr]::new([Int64]$env:CAP_HWND)
$r = New-Object 'W+RECT'
if (-not [W]::GetWindowRect($h, [ref]$r)) { Write-Output 'norect'; exit 1 }
$w = $r.R - $r.L; $ht = $r.B - $r.T
Write-Output "size=$w x $ht"
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
$ok = [W]::PrintWindow($h, $dc, 2)
$g.ReleaseHdc($dc)
$g.Dispose()
if (-not $ok) { Write-Output 'printwindow-failed' }
$bmp.Save($env:CAP_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output 'saved'
`;
const out = process.argv[2];
const hwnd = process.argv[3];
fs.mkdirSync(path.dirname(out), { recursive: true });
try {
  const stdout = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
    env: { ...process.env, CAP_OUT: out, CAP_HWND: hwnd },
    encoding: 'utf8',
  });
  console.log(stdout.trim());
  console.log('exists=' + fs.existsSync(out) + ' bytes=' + (fs.existsSync(out) ? fs.statSync(out).size : 0));
} catch (error) {
  console.error(String(error.stderr || error.message).slice(0, 800));
  process.exitCode = 1;
}
