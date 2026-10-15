# Generate images/icon.png (128x128) for Claude Token Usage Bar Ext.
#
# Same look as the original icon (purple->coral rounded square with
# segmented bar gauges), but with three rows: context, cache and plan usage.
# Rendered at 4x and downscaled for smooth antialiased edges.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/make_icon.ps1 [out.png]

param([string]$Out = (Join-Path (Split-Path $PSScriptRoot) 'images\icon.png'))

Add-Type -AssemblyName System.Drawing

$S = 512      # supersample canvas
$OUT_SIZE = 128

function RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$bmp = New-Object System.Drawing.Bitmap $S, $S, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# --- vertical gradient background in a rounded square ---
$top = [System.Drawing.Color]::FromArgb(124, 92, 214)   # purple #7c5cd6
$bot = [System.Drawing.Color]::FromArgb(217, 119, 87)   # coral  #d97757
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point 0, $S), $top, $bot
$g.FillPath($bg, (RoundedRect 0 0 ($S - 1) ($S - 1) 112))

# --- three stacked bar gauges: context, cache, plan usage ---
$on = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
$off = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(75, 255, 255, 255))

function BarRow([float]$y0, [float]$barH, [int]$segs, [int]$filled) {
  $margin = 92
  $gap = 20
  $barW = $S - 2 * $margin
  $segW = ($barW - $gap * ($segs - 1)) / $segs
  for ($i = 0; $i -lt $segs; $i++) {
    $x0 = $margin + $i * ($segW + $gap)
    $brush = if ($i -lt $filled) { $on } else { $off }
    $g.FillPath($brush, (RoundedRect $x0 $y0 $segW $barH ([Math]::Min($segW, $barH) / 2)))
  }
}

$bh = 62
$rowGap = 42
$y = ($S - (3 * $bh + 2 * $rowGap)) / 2
BarRow $y $bh 6 4                                 # context
BarRow ($y + $bh + $rowGap) $bh 6 3               # cache
BarRow ($y + 2 * ($bh + $rowGap)) $bh 6 2         # plan usage

# --- downscale ---
$icon = New-Object System.Drawing.Bitmap $OUT_SIZE, $OUT_SIZE, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g2 = [System.Drawing.Graphics]::FromImage($icon)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g2.DrawImage($bmp, 0, 0, $OUT_SIZE, $OUT_SIZE)

New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$icon.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "wrote $Out ($OUT_SIZE x $OUT_SIZE)"
