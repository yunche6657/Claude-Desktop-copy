// Click a point inside a target window (client coords), capture, then restore.
// Used to switch the original app's Cowork/Code segmented control so the Code
// view can be captured for layout comparison. Reversible: the original tab is
// clicked back at the end.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const [hwnd, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });

const ps = String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class U {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref P p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct R { public int L,T,Ri,B; }
  public struct P { public int X,Y; }
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }
}
'@
[U]::SetProcessDPIAware() | Out-Null
$h = [IntPtr]::new([Int64]$env:TARGET_HWND)
$wasMin = [U]::IsIconic($h)
if ($wasMin) { [U]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 1200 }
[U]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 800

$wr = New-Object 'U+R'; [U]::GetWindowRect($h, [ref]$wr) | Out-Null
$cr = New-Object 'U+R'; [U]::GetClientRect($h, [ref]$cr) | Out-Null
$origin = New-Object 'U+P'; [U]::ClientToScreen($h, [ref]$origin) | Out-Null
Write-Output "window=$($wr.L),$($wr.T) size=$($wr.Ri-$wr.L)x$($wr.B-$wr.T) client=$($cr.Ri)x$($cr.B) origin=$($origin.X),$($origin.Y)"

function Capture($path) {
  $r = New-Object 'U+R'; [U]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.Ri - $r.L; $ht = $r.B - $r.T
  if ($w -le 0 -or $ht -le 0) { Write-Output 'badrect'; return }
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  $ok = [U]::PrintWindow($h, $dc, 2)
  $g.ReleaseHdc($dc); $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "captured=$ok ($w x $ht) -> $path"
}

function ClickClient($cx, $cy) {
  [U]::Click($origin.X + $cx, $origin.Y + $cy)
  Start-Sleep -Milliseconds 900
}

# Focus the window first: the restored window ignores the first click.
ClickClient 900 12
Start-Sleep -Milliseconds 400

# Code tab: right half of the segmented control (client x=195, y=62).
ClickClient 195 62
Capture "$env:OUT_DIR/code-view.png"

# Back to Cowork so the user's app is left as found.
ClickClient 90 62
Capture "$env:OUT_DIR/cowork-restored.png"

if ($wasMin) { [U]::ShowWindow($h, 6) | Out-Null; Write-Output 'reminimized' }
`;

try {
  console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], {
    env: { ...process.env, TARGET_HWND: hwnd, OUT_DIR: outDir },
    encoding: 'utf8',
  }).trim());
} catch (error) {
  console.error(String(error.stderr || error.message).slice(0, 1500));
  process.exitCode = 1;
}
