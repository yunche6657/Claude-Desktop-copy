param([string]$Path, [string]$OutJson)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Bitmap]::FromFile($Path)
$w = $img.Width; $h = $img.Height
$rect = New-Object System.Drawing.Rectangle 0,0,$w,$h
$d = $img.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $d.Stride
$buf = New-Object byte[] ($stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($d.Scan0, $buf, 0, $buf.Length)
$img.UnlockBits($d)
function Hex([int]$x,[int]$y){ $i=$y*$stride+$x*4; return ('#{0:X2}{1:X2}{2:X2}' -f $buf[$i+2],$buf[$i+1],$buf[$i]) }
function Lum([int]$x,[int]$y){ $i=$y*$stride+$x*4; return ([int]$buf[$i+2]+[int]$buf[$i+1]+[int]$buf[$i]) }

# Sidebar/main boundary: scan a quiet row for the first x where the colour differs
# from the sidebar colour and stays different.
$side = Hex 150 600
$boundary = -1
for ($x = 250; $x -lt 400; $x++) {
  if ((Hex $x 600) -ne $side) {
    $stable = $true
    for ($k = 1; $k -le 6; $k++) { if ((Hex ($x+$k) 600) -eq $side) { $stable = $false; break } }
    if ($stable) { $boundary = $x; break }
  }
}

# Composer: find the largest white run on the composer row band.
$whiteRow = -1
for ($y = $h-40; $y -gt $h-300; $y--) {
  $run = 0; $best = 0
  for ($x = 300; $x -lt $w-20; $x++) {
    if ((Hex $x $y) -eq '#FFFFFF') { $run++; if ($run -gt $best) { $best = $run } } else { $run = 0 }
  }
  if ($best -gt 400) { $whiteRow = $y; break }
}
$cl = -1; $cr = -1
if ($whiteRow -gt 0) {
  for ($x = 300; $x -lt $w; $x++) { if ((Hex $x $whiteRow) -eq '#FFFFFF') { if ($cl -lt 0) { $cl = $x }; $cr = $x } }
}
# Composer vertical extent at its centre.
$ct = -1; $cb = -1
if ($cl -gt 0) {
  $cx = [int](($cl+$cr)/2)
  for ($y = $whiteRow; $y -gt 0; $y--) { if ((Hex $cx $y) -ne '#FFFFFF') { $ct = $y+1; break } }
  for ($y = $whiteRow; $y -lt $h; $y++) { if ((Hex $cx $y) -ne '#FFFFFF') { $cb = $y-1; break } }
}

# Text column: darkest pixels in the transcript area.
$minX = 999999; $maxX = -1
for ($y = 180; $y -lt 900; $y += 2) {
  for ($x = 300; $x -lt $w-20; $x++) {
    if ((Lum $x $y) -lt 200) { if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x } }
  }
}

# Title bar height: first row where the main column stops being the titlebar colour.
$titleColor = Hex 900 12
$titleBottom = -1
for ($y = 0; $y -lt 120; $y++) { if ((Hex 900 $y) -ne $titleColor) { $titleBottom = $y; break } }

$out = [ordered]@{
  size = "$w x $h"
  sidebarColor = $side
  sidebarBoundary = $boundary
  sidebarWidth = $(if ($boundary -gt 0) { $boundary } else { $null })
  mainColor = (Hex 900 600)
  titlebar = @{ color = $titleColor; bottom = $titleBottom }
  composer = @{ row = $whiteRow; left = $cl; right = $cr; width = $(if ($cl -gt 0) { $cr-$cl } else { $null }); top = $ct; bottom = $cb; height = $(if ($ct -gt 0) { $cb-$ct } else { $null }) }
  textColumn = @{ left = $minX; right = $maxX; width = $maxX-$minX }
  composerBorder = $(if ($cl -gt 0) { Hex ($cl-2) $whiteRow } else { $null })
}
$out | ConvertTo-Json -Depth 5 | Set-Content $OutJson -Encoding UTF8
Get-Content $OutJson -Raw
