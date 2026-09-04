<#
.SYNOPSIS
  ติดตั้ง StoreOS Launcher บนเครื่องแคชเชียร์ Windows พร้อมของที่จำเป็นทั้งหมด

.DESCRIPTION
  ร้านดาวน์โหลดไฟล์ zip จากหน้าเว็บ แตกไฟล์ แล้วดับเบิลคลิก install.cmd ครั้งเดียวจบ
  สคริปต์นี้จะ:
    1. ตรวจว่าเป็น Windows x64 ที่รองรับ
    2. ติดตั้ง Microsoft Edge WebView2 Runtime ให้ ถ้ายังไม่มี (Windows 11 มักมีมาแล้ว)
    3. ติดตั้ง .NET Desktop Runtime ให้ เฉพาะกรณีที่ไฟล์ในชุดเป็นแบบต้องพึ่ง runtime
       (ค่าเริ่มต้นเราแจกแบบ self-contained อยู่แล้ว = ไม่ต้องลง .NET อะไรเลย)
    4. คัดลอกโปรแกรมไปที่ %LOCALAPPDATA%\StoreOS\Launcher
    5. สร้างทางลัดที่ Start Menu / เดสก์ท็อป และตั้งให้เปิดเองตอนล็อกอิน (ถ้าสั่ง -Autostart)
    6. ติดตั้ง Print Hub ต่อให้อัตโนมัติ ถ้ามีชุด Print Hub มาในโฟลเดอร์เดียวกัน

  หมายเหตุสำคัญ: **ไม่ต้องติดตั้ง .NET SDK บนเครื่องร้าน** — SDK เป็นเครื่องมือสำหรับ
  ตอน "สร้าง" โปรแกรม ไม่ใช่ตอนใช้งาน (ดู build-launcher.ps1 / install-build-prereqs.ps1)

.PARAMETER Autostart
  ตั้งให้ Launcher เปิดเองทุกครั้งที่ล็อกอินเข้าเครื่อง (เหมาะกับเครื่องแคชเชียร์)

.PARAMETER SkipPrintHub
  ข้ามการติดตั้ง Print Hub (กรณีเครื่องนี้ไม่ได้ต่อเครื่องพิมพ์)
#>

[CmdletBinding()]
param(
  [switch]$Autostart,
  [switch]$SkipPrintHub
)

$ErrorActionPreference = "Stop"
$Root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Join-Path $env:LOCALAPPDATA "StoreOS\Launcher"
$ExeName    = "StoreOS.Launcher.exe"

function Write-Step { param([string]$Text) Write-Host "`n== $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "   $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "   $Text" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# 1. ตรวจเครื่อง
# ---------------------------------------------------------------------------
Write-Step "ตรวจเครื่อง"
$os = Get-CimInstance Win32_OperatingSystem
Write-Host "   $($os.Caption) build $($os.BuildNumber) ($($os.OSArchitecture))"
if ($os.OSArchitecture -notlike "*64*") {
  throw "StoreOS Launcher รองรับเฉพาะ Windows 64-bit — เครื่องนี้เป็น $($os.OSArchitecture)"
}
if ([int]$os.BuildNumber -lt 17763) {
  throw "ต้องใช้ Windows 10 เวอร์ชัน 1809 ขึ้นไป (build 17763+) — เครื่องนี้ build $($os.BuildNumber)"
}

# ---------------------------------------------------------------------------
# 2. WebView2 Runtime — Launcher ใช้แสดงหน้า POS
# ---------------------------------------------------------------------------
function Get-WebView2Version {
  foreach ($path in @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  )) {
    if (Test-Path $path) {
      $pv = (Get-ItemProperty $path -ErrorAction SilentlyContinue).pv
      if ($pv) { return $pv }
    }
  }
  return $null
}

Write-Step "ตรวจ Microsoft Edge WebView2 Runtime"
$webview2 = Get-WebView2Version
if ($webview2) {
  Write-Ok "พบแล้ว (เวอร์ชัน $webview2)"
} else {
  Write-Warn "ยังไม่มี — กำลังติดตั้งให้อัตโนมัติ"
  $bootstrapper = Join-Path $env:TEMP "MicrosoftEdgeWebview2Setup.exe"
  $local = Join-Path $Root "prereq\MicrosoftEdgeWebview2Setup.exe"
  try {
    if (Test-Path $local) {
      Copy-Item $local $bootstrapper -Force
    } else {
      # ตัวติดตั้งขนาดเล็ก (evergreen bootstrapper) จาก Microsoft
      Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $bootstrapper -UseBasicParsing
    }
    Start-Process -FilePath $bootstrapper -ArgumentList "/silent","/install" -Wait
    $webview2 = Get-WebView2Version
    if ($webview2) { Write-Ok "ติดตั้งแล้ว (เวอร์ชัน $webview2)" }
    else { Write-Warn "ติดตั้งแล้วแต่ยังตรวจไม่พบ — ถ้าเปิดโปรแกรมไม่ขึ้น ให้รีสตาร์ตเครื่องหนึ่งครั้ง" }
  } catch {
    Write-Warn "ติดตั้ง WebView2 อัตโนมัติไม่สำเร็จ: $($_.Exception.Message)"
    Write-Warn "ดาวน์โหลดเองได้ที่ https://developer.microsoft.com/microsoft-edge/webview2/ แล้วรันสคริปต์นี้ใหม่"
  } finally {
    Remove-Item $bootstrapper -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------------------
# 3. .NET Desktop Runtime — ต้องการเฉพาะชุดแบบ framework-dependent
# ---------------------------------------------------------------------------
$needsDotnet = Test-Path (Join-Path $Root "REQUIRES_DOTNET_RUNTIME")
if ($needsDotnet) {
  Write-Step "ตรวจ .NET Desktop Runtime 8"
  $dotnetExe = Get-Command dotnet -ErrorAction SilentlyContinue
  $hasRuntime = $false
  if ($dotnetExe) {
    $hasRuntime = (& $dotnetExe.Source --list-runtimes 2>$null) -match "Microsoft\.WindowsDesktop\.App 8\."
  }
  if ($hasRuntime) {
    Write-Ok "พบแล้ว"
  } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Warn "ยังไม่มี — กำลังติดตั้งผ่าน winget"
    & winget install -e --id Microsoft.DotNet.DesktopRuntime.8 --silent --accept-package-agreements --accept-source-agreements | Out-Null
  } else {
    Write-Warn "เครื่องนี้ไม่มี winget — ดาวน์โหลด .NET Desktop Runtime 8 เองที่ https://dotnet.microsoft.com/download/dotnet/8.0"
  }
} else {
  Write-Step ".NET Runtime"
  Write-Ok "ชุดนี้เป็นแบบ self-contained — ไม่ต้องติดตั้ง .NET บนเครื่องนี้"
}

# ---------------------------------------------------------------------------
# 4. คัดลอกโปรแกรม
# ---------------------------------------------------------------------------
Write-Step "ติดตั้งโปรแกรม"
$source = Join-Path $Root "app"
if (-not (Test-Path (Join-Path $source $ExeName))) {
  throw "ไม่พบ $ExeName ในโฟลเดอร์ app — แตกไฟล์ zip ให้ครบก่อนรันตัวติดตั้ง"
}
# ปิดโปรแกรมเดิมก่อนเขียนทับ (อัปเดตทับได้โดยไม่ต้องถอนก่อน)
Get-Process -Name "StoreOS.Launcher" -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Warn "ปิด StoreOS Launcher ที่เปิดอยู่ก่อนอัปเดต"
  $_ | Stop-Process -Force
  Start-Sleep -Milliseconds 500
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $source "*") -Destination $InstallDir -Recurse -Force
Write-Ok "ติดตั้งที่ $InstallDir"

# ---------------------------------------------------------------------------
# 5. ทางลัด + เปิดเองตอนล็อกอิน
# ---------------------------------------------------------------------------
Write-Step "สร้างทางลัด"
$exePath  = Join-Path $InstallDir $ExeName
$shell    = New-Object -ComObject WScript.Shell
foreach ($dir in @(
  [Environment]::GetFolderPath("Desktop"),
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs")
)) {
  $lnk = $shell.CreateShortcut((Join-Path $dir "StoreOS.lnk"))
  $lnk.TargetPath = $exePath
  $lnk.WorkingDirectory = $InstallDir
  $lnk.Description = "StoreOS POS"
  $lnk.Save()
}
Write-Ok "สร้างทางลัดบนเดสก์ท็อปและ Start Menu แล้ว"

$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
if ($Autostart) {
  Set-ItemProperty -Path $runKey -Name "StoreOSLauncher" -Value "`"$exePath`""
  Write-Ok "ตั้งให้เปิดเองตอนล็อกอินแล้ว"
} else {
  Write-Host "   (ถ้าต้องการให้เปิดเองตอนเปิดเครื่อง ให้รันใหม่ด้วย -Autostart)"
}

# ---------------------------------------------------------------------------
# 6. Print Hub (ถ้ามีในชุด)
# ---------------------------------------------------------------------------
$hubInstaller = Join-Path $Root "print-hub\install-windows.ps1"
if ($SkipPrintHub) {
  Write-Step "ข้ามการติดตั้ง Print Hub ตามที่สั่ง"
} elseif (Test-Path $hubInstaller) {
  Write-Step "ติดตั้ง Print Hub (ตัวช่วยพิมพ์)"
  & powershell -NoProfile -ExecutionPolicy Bypass -File $hubInstaller
} else {
  Write-Step "Print Hub"
  Write-Warn "ไม่มีชุด Print Hub มาด้วย — ติดตั้งภายหลังได้จากหน้าตั้งค่า Print Hub ใน StoreOS"
}

Write-Host "`nติดตั้งเสร็จแล้ว" -ForegroundColor Green
Write-Host "เปิดใช้งานได้จากไอคอน StoreOS บนเดสก์ท็อป" -ForegroundColor Green
