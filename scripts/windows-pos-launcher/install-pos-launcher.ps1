<#
.SYNOPSIS
  ติดตั้ง StoreOS POS บนเครื่องขาย (ไม่ต้องใช้สิทธิ์ Administrator)

.DESCRIPTION
  1. ตรวจ Windows 10 1809+ 64-bit
  2. ติดตั้ง Microsoft Edge WebView2 Runtime ให้ ถ้ายังไม่มี (Windows 11 มีมาแล้ว)
  3. ปิดโปรแกรมตัวเดิมที่เปิดอยู่ แล้วคัดลอกไป %LOCALAPPDATA%\StoreOS\PosLauncher\app
  4. สร้างทางลัด "StoreOS POS" บนเดสก์ท็อป + Start Menu และให้เปิดเองตอนล็อกอิน
  ไม่แตะ StoreOS Launcher / Print Hub ตัวเดิม (ปิด Print Hub ทำแยกในเฟส D4)
#>
[CmdletBinding()]
param([switch]$NoAutostart)

$ErrorActionPreference = "Stop"
$Root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Join-Path $env:LOCALAPPDATA "StoreOS\PosLauncher\app"
$ExeName    = "StoreOS.PosLauncher.exe"

function Write-Step { param([string]$Text) Write-Host "`n== $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "   $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "   $Text" -ForegroundColor Yellow }

Write-Step "ตรวจเครื่อง"
$os = Get-CimInstance Win32_OperatingSystem
Write-Host "   $($os.Caption) build $($os.BuildNumber) ($($os.OSArchitecture))"
if ($os.OSArchitecture -notlike "*64*") { throw "StoreOS POS รองรับเฉพาะ Windows 64-bit" }
if ([int]$os.BuildNumber -lt 17763) { throw "ต้องใช้ Windows 10 เวอร์ชัน 1809 ขึ้นไป" }

Write-Step "ตรวจ Microsoft Edge WebView2 Runtime"
$wv = $null
foreach ($p in @(
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
  "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
  "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}")) {
  if (Test-Path $p) {
    $v = (Get-ItemProperty $p -ErrorAction SilentlyContinue).pv
    if ($v) { $wv = $v }
  }
}
if ($wv) {
  Write-Ok "พบแล้ว ($wv)"
} else {
  Write-Warn "ยังไม่มี - กำลังดาวน์โหลดและติดตั้ง (ต้องต่ออินเทอร์เน็ต)"
  $setup = Join-Path $env:TEMP "MicrosoftEdgeWebview2Setup.exe"
  Invoke-WebRequest "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $setup -UseBasicParsing
  Start-Process $setup -ArgumentList "/silent /install" -Wait
  Write-Ok "ติดตั้ง WebView2 แล้ว"
}

Write-Step "คัดลอกโปรแกรม"
# ปิดตัวเดิมแบบสุภาพก่อน (ให้งานพิมพ์ที่ค้างส่งจบ) แล้วค่อยบังคับปิดถ้าไม่ปิดใน 5 วิ
$running = Get-Process -Name "StoreOS.PosLauncher" -ErrorAction SilentlyContinue
if ($running) {
  $running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
  $running | Wait-Process -Timeout 5 -ErrorAction SilentlyContinue
  Get-Process -Name "StoreOS.PosLauncher" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $Root "app\*") $InstallDir -Recurse -Force
$exe = Join-Path $InstallDir $ExeName
if (-not (Test-Path $exe)) { throw "ไม่พบ $ExeName ในชุดติดตั้ง" }
Write-Ok $InstallDir

Write-Step "สร้างทางลัด"
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "StoreOS POS.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Programs")) "StoreOS POS.lnk"))
if (-not $NoAutostart) { $targets += (Join-Path ([Environment]::GetFolderPath("Startup")) "StoreOS POS.lnk") }
foreach ($lnk in $targets) {
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $exe
  $s.WorkingDirectory = $InstallDir
  $s.IconLocation = "$exe,0"
  $s.Description = "StoreOS POS - ขาย / เมนูสินค้า / เครื่องพิมพ์ (พิมพ์ตรง IP)"
  $s.Save()
  Write-Ok $lnk
}

Write-Step "เปิดโปรแกรม"
Start-Process $exe
Write-Ok "เสร็จแล้ว - ล็อกอินในโปรแกรม แล้วตั้ง IP เครื่องพิมพ์ในแท็บ 'เครื่องพิมพ์'"
