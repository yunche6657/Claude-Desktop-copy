param(
  [string]$Path,
  [string]$OutJson
)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Bitmap]::FromFile($Path)
$w = $img.Width; $h = $img.Height
$rect = New-Object System.Drawing.Rectangle 0,0,$w,$h
$data = $img.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$bytes = New-Object byte[] ($stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$img.UnlockBits($data)

function Hex([int]$x, [int]$y) {
  $i = $y * $stride + $x * 4
  return ('#{0:X2}{1:X2}{2:X2}' -f $bytes[$i+2], $bytes[$i+1], $bytes[$i])
}
function Lum([int]$x, [int]$y) {
  $i = $y * $stride + $x * 4
  return ([int]$bytes[$i+2] + [int]$bytes[$i+1] + [int]$bytes[$i])
}

# Horizontal transitions along a row: report where the colour changes.
function RowTransitions([int]$y, [int]$x0, [int]$x1) {
  $out = @(); $prev = ''
  for ($x = $x0; $x -lt $x1; $x++) {
    $c = Hex $x $y
    if ($c -ne $prev) { $out += "$x=$c"; $prev = $c }
  }
  return $out
}
function ColTransitions([int]$x, [int]$y0, [int]$y1) {
  $out = @(); $prev = ''
  for ($y = $y0; $y -lt $y1; $y++) {
    $c = Hex $x $y
    if ($c -ne $prev) { $out += "$y=$c"; $prev = $c }
  }
  return $out
}
function Bounds([int]$x0, [int]$y0, [int]$x1, [int]$y1, [int]$maxLum) {
  $minX = 999999; $maxX = -1; $minY = 999999; $maxY = -1
  for ($y = $y0; $y -lt $y1; $y++) {
    for ($x = $x0; $x -lt $x1; $x++) {
      if ((Lum $x $y) -lt $maxLum) {
        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  return "$minX,$minY .. $maxX,$maxY ($($maxX-$minX)x$($maxY-$minY))"
}

$result = [ordered]@{
  size = "$w x $h"
  row600 = (RowTransitions 600 0 200)
  col150 = (ColTransitions 150 0 120)
  col50  = (ColTransitions 50 0 60)
  textBounds = (Bounds 300 200 1900 900 200)
  sidebarSample = (Hex 150 500)
  mainSample = (Hex 900 500)
  titlebarSample = (Hex 900 12)
  sidebarTop = (Hex 150 12)
}
$result | ConvertTo-Json -Depth 4 | Set-Content -Path $OutJson -Encoding UTF8
Write-Output (Get-Content $OutJson -Raw)
