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

# Resolve paths (this script lives in scripts/print-hub/, the agent in scripts/).
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ScriptsDir = Split-Path -Parent $ScriptDir
$AgentPath = Join-Path $ScriptsDir "print-hub.mjs"
$ConfigPath = Join-Path $ScriptsDir "print-hub.config.json"

if (-not (Test-Path $AgentPath)) {
  throw "ไม่พบ print-hub.mjs ที่ $AgentPath — โปรดวางโฟลเดอร์ scripts ให้ครบก่อนติดตั้ง"
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
  throw "ไม่พบค่าตั้งค่า — ดาวน์โหลด print-hub.config.json จากหน้า StoreOS > ตั้งค่า > Print Hub มาวางไว้ในโฟลเดอร์นี้ก่อน (หรือส่ง -ServerUrl -StoreId -HubToken)"
}

# (Re)register the scheduled task.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
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

Start-ScheduledTask -TaskName $TaskName
Write-Host "เริ่ม StoreOS Print Hub แล้ว — ลองสั่งพิมพ์ทดสอบจากหน้า Settings ได้เลย" -ForegroundColor Cyan
