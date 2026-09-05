<#
.SYNOPSIS
  Installs the StoreOS Print Hub as an auto-start background task on a Windows
  cashier PC / mini-PC. The Hub long-polls StoreOS for print jobs from tablet/iPad
  POS and prints them to the store's LAN receipt printer.

.DESCRIPTION
  - Writes scripts/print-hub.config.json
  - Registers a Scheduled Task "StoreOSPrintHub" that runs at logon and restarts
    automatically if it stops
  - Starts the Hub immediately

  Run from an elevated PowerShell (Run as Administrator):
    powershell -ExecutionPolicy Bypass -File install-windows.ps1 `
      -ServerUrl "https://store-os-manage.vercel.app" `
      -StoreId   "<store-uuid>" `
      -HubToken  "<hub-token-from-settings>"

.NOTES
  Get StoreId + HubToken from StoreOS → ตั้งค่า (Settings) → Print Hub.
#>

param(
  [string] $ServerUrl,
  [string] $StoreId,
  [string] $HubToken,
  [int] $PollIntervalMs = 2500
)

$ErrorActionPreference = "Stop"
$TaskName = "StoreOSPrintHub"

# หา print-hub.mjs ให้เจอทั้งสอง layout:
#   แพ็กเกจที่ร้านโหลด : storeos-launcher\print-hub\{install-windows.ps1, print-hub.mjs}
#   repo               : scripts\print-hub\install-windows.ps1 + scripts\print-hub.mjs
# เดิมมองหาแต่โฟลเดอร์แม่ ทำให้แพ็กเกจจริงติดตั้งไม่ได้ ("ไม่พบ print-hub.mjs")
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$AgentSource = @(
  (Join-Path $ScriptDir "print-hub.mjs"),
  (Join-Path (Split-Path -Parent $ScriptDir) "print-hub.mjs")
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $AgentSource) {
  throw "ไม่พบ print-hub.mjs ทั้งใน $ScriptDir และโฟลเดอร์แม่ — แตกไฟล์แพ็กเกจให้ครบก่อนติดตั้ง"
}

# ติดตั้งตัว agent ลง LocalAppData ไม่ใช่รันจากโฟลเดอร์ Downloads
# เหตุผล: โฟลเดอร์ที่โหลดมาถูกลบ/ย้าย/โหลดซ้ำเป็น "(1)" ได้ตลอด ถ้า Scheduled Task
# ชี้ไปที่นั่น Hub จะพังเงียบ ๆ ภายหลัง และ config ต้องอยู่ที่เดียวกับที่ Launcher
# เขียนให้ตอน auto-provision ($env:LOCALAPPDATA\StoreOSPrintHub) ไม่งั้นต่างคนต่างอ่านคนละไฟล์
$InstallRoot = Join-Path $env:LOCALAPPDATA "StoreOSPrintHub"
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
$AgentPath = Join-Path $InstallRoot "print-hub.mjs"
Copy-Item -Path $AgentSource -Destination $AgentPath -Force
Write-Host "ติดตั้งตัวช่วยพิมพ์ไว้ที่: $AgentPath" -ForegroundColor Green

$ScriptsDir = $InstallRoot
$ConfigPath = Join-Path $InstallRoot "print-hub.config.json"

# ถ้าผู้ใช้วาง print-hub.config.json ไว้ข้างตัวติดตั้ง (วิธีที่คู่มือบอก) ให้ย้ายเข้า
# ที่ทางการให้เลย จะได้ไม่มีไฟล์ config สองใบที่ค่าไม่ตรงกัน
# หาไฟล์ที่ผู้ใช้ดาวน์โหลดมาให้ครอบทุกที่ที่คนวางจริง เรียงจากใกล้ตัวติดตั้งออกไป:
#   print-hub\ → storeos-launcher\ → Downloads\ (ที่ไฟล์ตกลงมาตอนกดดาวน์โหลด)
#   → โฟลเดอร์ที่กด install.cmd → Downloads ของผู้ใช้ตรง ๆ
# เคสจริง: ไฟล์อยู่ที่ Downloads แต่สคริปต์อยู่ลึกลงไปสองชั้น เลยหาไม่เจอ
$PackageRoot = Split-Path -Parent $ScriptDir
$DroppedConfig = @(
  (Join-Path $ScriptDir "print-hub.config.json"),
  (Join-Path $PackageRoot "print-hub.config.json"),
  (Join-Path (Split-Path -Parent $PackageRoot) "print-hub.config.json"),
  (Join-Path (Get-Location).Path "print-hub.config.json"),
  (Join-Path (Join-Path $env:USERPROFILE "Downloads") "print-hub.config.json")
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($DroppedConfig -and -not (Test-Path $ConfigPath)) {
  Copy-Item -Path $DroppedConfig -Destination $ConfigPath -Force
  Write-Host "ย้ายไฟล์ตั้งค่าเข้าที่ทางการแล้ว: $ConfigPath" -ForegroundColor Green
}

# Node runtime is required. Resolve it automatically so a non-technical operator
# never has to install Node by hand, and so re-running the installer never
# re-downloads Node: system PATH -> ProgramFiles -> saved portable copy -> winget
# -> download portable (once) into a stable per-user folder.
$PortableNodeRoot = Join-Path $env:LOCALAPPDATA "StoreOSPrintHub\node"

function Find-PortableNode {
  if (-not (Test-Path $PortableNodeRoot)) { return $null }
  $exe = Get-ChildItem -Path $PortableNodeRoot -Recurse -Filter "node.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($exe) { return $exe.FullName }
  return $null
}

function Resolve-NodePath {
  # 1) Already on PATH.
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  # 2) Default install location (winget/MSI) even if PATH was not refreshed.
  $pf = Join-Path $env:ProgramFiles "nodejs\node.exe"
  if (Test-Path $pf) { return $pf }

  # 3) A portable Node this installer downloaded before (survives re-extracting
  #    the kit to a new folder, so re-installing does NOT re-download Node).
  $saved = Find-PortableNode
  if ($saved) {
    Write-Host "ใช้ Node.js แบบพกพาที่เคยติดตั้งไว้: $saved" -ForegroundColor Green
    return $saved
  }

  # 4) Try winget (Windows 10 1809+/11).
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "ไม่พบ Node.js — กำลังติดตั้งผ่าน winget..." -ForegroundColor Yellow
    try {
      & winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Null
    } catch { }
    if (Test-Path $pf) { return $pf }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }

  # 5) Last resort: download a portable Node runtime ONCE into a stable per-user
  #    folder (%LOCALAPPDATA%\StoreOSPrintHub\node). The scheduled task points at
  #    this exe; it is outside the kit folder so re-extracting the kit is safe.
  Write-Host "กำลังดาวน์โหลด Node.js แบบพกพา (ครั้งเดียว ~30MB)..." -ForegroundColor Yellow
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = "SilentlyContinue"
  $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
  $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
  if (-not $lts) { throw "หา Node.js LTS ไม่พบ" }
  $ver = $lts.version
  $url = "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip"
  $zip = Join-Path $env:TEMP "node-$ver-win-x64.zip"
  Invoke-WebRequest -Uri $url -OutFile $zip
  if (Test-Path $PortableNodeRoot) { Remove-Item -Recurse -Force $PortableNodeRoot }
  New-Item -ItemType Directory -Force -Path $PortableNodeRoot | Out-Null
  Expand-Archive -Path $zip -DestinationPath $PortableNodeRoot -Force
  Remove-Item -Force $zip -ErrorAction SilentlyContinue
  $exe = Find-PortableNode
  if (-not $exe) { throw "แตกไฟล์ Node.js ไม่สำเร็จ" }
  return $exe
}

$NodePath = Resolve-NodePath
if (-not $NodePath -or -not (Test-Path $NodePath)) {
  throw "ติดตั้ง Node.js อัตโนมัติไม่สำเร็จ — ติดตั้งเองจาก https://nodejs.org แล้วรันใหม่"
}
Write-Host "ใช้ Node.js: $NodePath" -ForegroundColor Green

# Config can come from -ServerUrl/-StoreId/-HubToken params, OR from a
# print-hub.config.json the operator downloaded from Settings and dropped next to
# the agent (the double-click installer path). Params win when provided.
$HaveParams = $ServerUrl -and $StoreId -and $HubToken
if ($HaveParams) {
  # Write config (UTF-8 WITHOUT a BOM — PS 5.1 `Out-File -Encoding UTF8` prepends
  # a BOM that breaks Node's JSON.parse, so use .NET to write clean UTF-8).
  $Config = [ordered]@{
    serverUrl      = $ServerUrl.TrimEnd("/")
    storeId        = $StoreId
    hubToken       = $HubToken
    pollIntervalMs = $PollIntervalMs
  }
  $Json = $Config | ConvertTo-Json
  [System.IO.File]::WriteAllText($ConfigPath, $Json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "เขียน config แล้ว: $ConfigPath" -ForegroundColor Green
}
elseif (Test-Path $ConfigPath) {
  # Validate the dropped config has the required fields before continuing.
  try {
    $existing = Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json
  } catch {
    throw "อ่าน print-hub.config.json ไม่สำเร็จ (ไฟล์เสียหรือไม่ใช่ JSON) — ดาวน์โหลดไฟล์ตั้งค่าใหม่จากหน้า Settings"
  }
  if (-not $existing.serverUrl -or -not $existing.storeId -or -not $existing.hubToken) {
    throw "print-hub.config.json ไม่ครบ (ต้องมี serverUrl, storeId, hubToken) — ดาวน์โหลดไฟล์ตั้งค่าใหม่จากหน้า Settings"
  }
  Write-Host "ใช้ค่าตั้งค่าจาก: $ConfigPath" -ForegroundColor Green
}
else {
  # ไม่มี config = ไม่ใช่ความผิดพลาดอีกต่อไป
  # StoreOS Launcher จะขอ config ให้เครื่องนี้เองตอนเปิดโปรแกรมแล้วล็อกอิน
  # (POST /api/print/hub/provision) แล้วเขียนลง $ConfigPath นี้ พร้อมสั่ง restart task ให้
  # การ throw ตรงนี้จะทำให้ติดตั้งไม่จบ ทั้งที่อีกไม่กี่วินาทีก็ได้ค่ามาเองอยู่ดี
  $PendingProvision = $true
  Write-Host "ยังไม่มีค่าตั้งค่า — ติดตั้งไว้ก่อน" -ForegroundColor Yellow
  Write-Host "  เปิด StoreOS แล้วล็อกอิน ระบบจะตั้งค่าตัวช่วยพิมพ์ให้อัตโนมัติ" -ForegroundColor Yellow
  Write-Host "  (หรือดาวน์โหลด print-hub.config.json จาก ตั้งค่า > Print Hub มาวางไว้ที่ $InstallRoot)" -ForegroundColor DarkGray
}

# The config file contains the hub token secret — restrict it to the current
# user only (plan F2/Task 8: config secret ตั้ง ACL เฉพาะ user).
if (Test-Path $ConfigPath) {
  icacls $ConfigPath /inheritance:r /grant:r "${env:USERNAME}:F" | Out-Null
  Write-Host "ตั้งสิทธิ์ไฟล์ config (icacls) ให้เข้าถึงได้เฉพาะผู้ใช้นี้แล้ว" -ForegroundColor Green
}

# หยุด agent ตัวเก่าที่ยังเปิดค้างอยู่ก่อน
# เคสจริงที่เจอ: ร้านเคยเปิด print-hub.cmd ด้วยมือ ทำให้มี node.exe ค้างถือ config เก่า
# ยิง 401 วนไม่หยุด ต่อให้ติดตั้งใหม่แล้วก็ยังมีตัวเก่าแย่งทำงานอยู่
# กรองด้วย command line ที่มี print-hub.mjs เท่านั้น — ห้ามไปปิด node ของงานอื่นบนเครื่อง
try {
  $stale = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'print-hub\.mjs' }
  foreach ($proc in $stale) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "ปิดตัวช่วยพิมพ์ที่ค้างอยู่ (PID $($proc.ProcessId))" -ForegroundColor Yellow
  }
} catch {
  Write-Host "ข้ามการปิด agent ตัวเก่า (ตรวจ process ไม่ได้)" -ForegroundColor DarkGray
}

# ขั้นตอนนี้ต้องใช้สิทธิ์ Administrator — บอกให้ชัดตั้งแต่ก่อนลงมือ
# ไม่ใช่ปล่อยให้ล้มด้วย CimException "Access is denied" ที่ผู้ใช้ตีความไม่ออก
$IsAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
  Write-Host ""
  Write-Warning "ขั้นตอนตั้งค่าให้เปิดเองอัตโนมัติต้องใช้สิทธิ์ผู้ดูแลเครื่อง (Administrator)"
  Write-Host "  ตัวช่วยพิมพ์และค่าตั้งค่าถูกติดตั้งไว้เรียบร้อยแล้วที่ $InstallRoot" -ForegroundColor Green
  Write-Host "  วิธีทำต่อ: คลิกขวาที่ install.cmd แล้วเลือก 'Run as administrator'" -ForegroundColor Cyan
  Write-Host "  (หรือเปิดใช้เองชั่วคราวด้วยการดับเบิลคลิก print-hub.cmd)" -ForegroundColor DarkGray
  exit 1
}

# (Re)register the scheduled task.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$Action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$AgentPath`"" -WorkingDirectory $ScriptsDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -RestartCount 9999 `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0)
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger `
  -Settings $Settings -Principal $Principal -Force | Out-Null
Write-Host "ลงทะเบียน Scheduled Task '$TaskName' (เปิดเองตอน logon) แล้ว" -ForegroundColor Green

if ($PendingProvision) {
  # ยังไม่มี config → agent จะออกทันทีที่เริ่ม การรอ "Running" จึงขึ้น warning ทั้งที่ปกติ
  # Launcher จะเขียน config แล้วสั่ง restart task ให้เองหลังผู้ใช้ล็อกอิน
  Write-Host ""
  Write-Host "ติดตั้งเรียบร้อย — เหลือขั้นตอนเดียว" -ForegroundColor Cyan
  Write-Host "  1) เปิด StoreOS จากไอคอนบนเดสก์ท็อป" -ForegroundColor Cyan
  Write-Host "  2) ล็อกอินด้วยบัญชีที่มีสิทธิ์จัดการเครื่องพิมพ์" -ForegroundColor Cyan
  Write-Host "  3) ระบบจะตั้งค่าตัวช่วยพิมพ์ให้เอง แล้วสถานะที่หน้า Print Hub จะเปลี่ยนเป็น 'Hub ออนไลน์'" -ForegroundColor Cyan
  return
}

Start-ScheduledTask -TaskName $TaskName
# Local health check: prove the task actually launched (Running). The REAL
# success signal is the cloud heartbeat — the StoreOS Print Hub page flipping
# to "Hub ออนไลน์" — which the installer deliberately does not fake.
$deadline = (Get-Date).AddSeconds(30)
$state = $null
do {
  Start-Sleep -Milliseconds 800
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $state = if ($task) { $task.State } else { $null }
} while ($state -ne "Running" -and (Get-Date) -lt $deadline)
$info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
if ($state -eq "Running") {
  $lastRun = if ($info) { ", last run $($info.LastRunTime)" } else { "" }
  Write-Host "Health check: task '$TaskName' กำลังทำงาน (Running)$lastRun" -ForegroundColor Green
  Write-Host "ขั้นสุดท้าย: กลับไปที่หน้า StoreOS > ตั้งค่า > Print Hub แล้วรอสถานะเปลี่ยนเป็น 'Hub ออนไลน์' (heartbeat ฝั่งคลาวด์) จึงถือว่าติดตั้งสำเร็จสมบูรณ์" -ForegroundColor Cyan
} else {
  Write-Warning "Health check: task '$TaskName' ยังไม่ขึ้น Running ภายใน 30 วินาที (state=$state) — เปิด Task Scheduler ดู task '$TaskName' หรือรันติดตั้งใหม่"
}
