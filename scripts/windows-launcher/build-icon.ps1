<#
.SYNOPSIS
  สร้างไอคอนแอป (.ico) ของ StoreOS Launcher จากโลโก้ของระบบ

.DESCRIPTION
  ทำไมต้องมีสคริปต์ ไม่ใช่แค่วางไฟล์ .ico ไว้เฉย ๆ:
    * โลโก้ต้นทาง (public/logo.png) มีขอบขาวรอบตัวมาก ถ้าย่อทั้งภาพเป็น 32px
      ตัวมาร์กจะเล็กจนดูไม่ออกบนแถบงาน — ต้องครอปให้ชิดตัวมาร์กก่อนเสมอ
    * พื้นขาวรอบนอกต้องกลายเป็นโปร่งใส แต่สีขาว "ข้างใน" (ไอคอนช้อนส้อม/QR/ร้าน)
      ต้องอยู่ครบ จึงใช้การไล่จากขอบภาพเข้ามา ไม่ใช่ลบสีขาวทั้งภาพ
    * ต้องมีหลายขนาดในไฟล์เดียว ไม่งั้น Windows จะย่อ/ขยายเองแล้วขอบแตก
  เมื่อโลโก้เปลี่ยน ให้รันซ้ำแทนการแก้ไฟล์ไอคอนด้วยมือ

  รัน: powershell -ExecutionPolicy Bypass -File scripts\windows-launcher\build-icon.ps1
#>

[CmdletBinding()]
param(
  [string]$Source = "public\logo.png",
  [string]$Output = "windows\StoreOS.Launcher\Assets\storeos.ico"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$repoRoot   = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$sourcePath = Join-Path $repoRoot $Source
$outputPath = Join-Path $repoRoot $Output

if (-not (Test-Path $sourcePath)) { throw "ไม่พบไฟล์โลโก้: $sourcePath" }
New-Item -ItemType Directory -Force -Path (Split-Path $outputPath) | Out-Null

Write-Host "อ่านโลโก้: $sourcePath" -ForegroundColor Cyan
$original = [System.Drawing.Bitmap]::FromFile($sourcePath)

# ---- 1. หากรอบของตัวมาร์ก (พิกเซลที่ไม่ใช่ขาว) ----
# ใช้ LockBits เพราะ GetPixel ทีละจุดบนภาพ 1254x1254 ช้าเกินไปใน PowerShell
$rect = New-Object System.Drawing.Rectangle 0, 0, $original.Width, $original.Height
$data = $original.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * $original.Height)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$original.UnlockBits($data)

$whiteCut = 245   # เข้มกว่านี้ถือว่าเป็นตัวมาร์ก
$minX = $original.Width; $minY = $original.Height; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $original.Height; $y++) {
  $row = $y * $data.Stride
  for ($x = 0; $x -lt $original.Width; $x++) {
    $i = $row + $x * 4
    if ($bytes[$i + 3] -lt 16) { continue }                                   # โปร่งใสอยู่แล้ว
    if ($bytes[$i] -ge $whiteCut -and $bytes[$i+1] -ge $whiteCut -and $bytes[$i+2] -ge $whiteCut) { continue }
    if ($x -lt $minX) { $minX = $x }
    if ($x -gt $maxX) { $maxX = $x }
    if ($y -lt $minY) { $minY = $y }
    if ($y -gt $maxY) { $maxY = $y }
  }
}
if ($maxX -lt 0) { throw "หาตัวมาร์กในโลโก้ไม่เจอ (ภาพขาวทั้งหมด?)" }

# ทำให้เป็นสี่เหลี่ยมจัตุรัสและเผื่อขอบ 6% เพื่อไม่ให้ชนขอบไอคอน
$side   = [Math]::Max($maxX - $minX + 1, $maxY - $minY + 1)
$pad    = [int]($side * 0.06)
$side   = $side + $pad * 2
$cx     = [int](($minX + $maxX) / 2)
$cy     = [int](($minY + $maxY) / 2)
$cropX  = [Math]::Max(0, $cx - [int]($side / 2))
$cropY  = [Math]::Max(0, $cy - [int]($side / 2))
$side   = [Math]::Min($side, [Math]::Min($original.Width - $cropX, $original.Height - $cropY))
Write-Host ("ครอป: {0},{1} ขนาด {2}px (เดิม {3}x{4})" -f $cropX, $cropY, $side, $original.Width, $original.Height)

# ---- 2. ย่อเป็น 256 แล้วทำพื้นนอกให้โปร่งใส ----
$base = New-Object System.Drawing.Bitmap 256, 256, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($base)
$g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.DrawImage($original, (New-Object System.Drawing.Rectangle 0, 0, 256, 256),
             $cropX, $cropY, $side, $side, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$original.Dispose()

# ไล่จากขอบภาพเข้ามา (flood fill) — ลบเฉพาะพื้นขาวที่ต่อกับขอบ
# สีขาว "ข้างใน" ตัวมาร์ก (ช้อนส้อม/QR/ร้าน) จึงไม่หายไปด้วย
$transparent = [System.Drawing.Color]::FromArgb(0, 255, 255, 255)
$queue = New-Object System.Collections.Generic.Queue[int]
$seen  = New-Object bool[] (256 * 256)
for ($i = 0; $i -lt 256; $i++) {
  foreach ($p in @($i, (255 * 256 + $i), ($i * 256), ($i * 256 + 255))) {
    if (-not $seen[$p]) { $seen[$p] = $true; $queue.Enqueue($p) }
  }
}
$cleared = 0
while ($queue.Count -gt 0) {
  $p = $queue.Dequeue()
  # ต้องใช้ Floor: การแคสต์ [int] ของ PowerShell เป็นการ "ปัดเศษ" ไม่ใช่ตัดทิ้ง
  # ทำให้แถวสุดท้าย (65535/256 = 255.99) กลายเป็น 256 แล้วหลุดขอบภาพ
  $y = [int][Math]::Floor($p / 256); $x = $p % 256
  $c = $base.GetPixel($x, $y)
  if ($c.A -gt 16 -and ($c.R -lt $whiteCut -or $c.G -lt $whiteCut -or $c.B -lt $whiteCut)) { continue }
  $base.SetPixel($x, $y, $transparent)
  $cleared++
  foreach ($n in @(($p - 1), ($p + 1), ($p - 256), ($p + 256))) {
    if ($n -lt 0 -or $n -ge 65536) { continue }
    if ([Math]::Abs((($n % 256)) - $x) -gt 1) { continue }   # ไม่ข้ามขอบซ้าย-ขวา
    if (-not $seen[$n]) { $seen[$n] = $true; $queue.Enqueue($n) }
  }
}
Write-Host "ทำพื้นนอกโปร่งใส: $cleared พิกเซล"

# ---- 3. เขียนไฟล์ .ico หลายขนาด (ใช้ PNG ภายใน รองรับ Windows Vista ขึ้นไป) ----
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()
foreach ($size in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gg = [System.Drawing.Graphics]::FromImage($bmp)
  $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gg.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $gg.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $gg.DrawImage($base, 0, 0, $size, $size)
  $gg.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $images += ,@{ size = $size; bytes = $ms.ToArray() }
  $ms.Dispose(); $bmp.Dispose()
}
$base.Dispose()

$out = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($out)
$writer.Write([UInt16]0)                 # reserved
$writer.Write([UInt16]1)                 # type = icon
$writer.Write([UInt16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($image in $images) {
  $dim = if ($image.size -ge 256) { 0 } else { $image.size }   # 256 เขียนเป็น 0 ตามสเปก
  $writer.Write([byte]$dim); $writer.Write([byte]$dim)
  $writer.Write([byte]0); $writer.Write([byte]0)               # palette / reserved
  $writer.Write([UInt16]1); $writer.Write([UInt16]32)          # planes / bpp
  $writer.Write([UInt32]$image.bytes.Length)
  $writer.Write([UInt32]$offset)
  $offset += $image.bytes.Length
}
foreach ($image in $images) { $writer.Write($image.bytes) }
$writer.Flush()
[System.IO.File]::WriteAllBytes($outputPath, $out.ToArray())
$writer.Dispose(); $out.Dispose()

$sizeKb = [Math]::Round((Get-Item $outputPath).Length / 1KB, 1)
Write-Host "`nเสร็จแล้ว: $outputPath ($sizeKb KB, $($images.Count) ขนาด)" -ForegroundColor Green
