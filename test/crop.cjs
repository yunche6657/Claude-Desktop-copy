// Crop a region of a PNG for close inspection: node crop.cjs <src> <out> <x> <y> <w> <h> [scale]
const { execFileSync } = require('node:child_process');
const [src, out, x, y, w, h, scale = '2'] = process.argv.slice(2);
const ps = String.raw`
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($env:SRC)
$x=[int]$env:X; $y=[int]$env:Y; $w=[int]$env:W; $hh=[int]$env:H; $s=[double]$env:S
$rect = New-Object System.Drawing.Rectangle $x, $y, $w, $hh
$crop = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($crop)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0,0,$w,$hh), $rect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$big = New-Object System.Drawing.Bitmap ([int]($w*$s)), ([int]($hh*$s))
$g2 = [System.Drawing.Graphics]::FromImage($big)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$g2.DrawImage($crop, 0, 0, [int]($w*$s), [int]($hh*$s))
$g2.Dispose()
$big.Save($env:OUT, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose(); $crop.Dispose(); $src.Dispose()
Write-Output "cropped $w x $hh -> $([int]($w*$s)) x $([int]($hh*$s))"
`;
console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], {
  env: { ...process.env, SRC: src, OUT: out, X: x, Y: y, W: w, H: h, S: scale },
  encoding: 'utf8',
}).trim());
