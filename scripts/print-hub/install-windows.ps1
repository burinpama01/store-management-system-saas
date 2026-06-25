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
  [Parameter(Mandatory = $true)] [string] $ServerUrl,
  [Parameter(Mandatory = $true)] [string] $StoreId,
  [Parameter(Mandatory = $true)] [string] $HubToken,
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

# Node runtime is required.
$Node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $Node) {
  throw "ไม่พบ Node.js — ติดตั้ง Node LTS จาก https://nodejs.org ก่อน แล้วรันสคริปต์นี้อีกครั้ง"
}
$NodePath = $Node.Source

# Write config (UTF-8, no BOM-sensitive consumers — JSON.parse handles it).
$Config = [ordered]@{
  serverUrl      = $ServerUrl.TrimEnd("/")
  storeId        = $StoreId
  hubToken       = $HubToken
  pollIntervalMs = $PollIntervalMs
}
# Write UTF-8 WITHOUT a BOM. PowerShell 5.1's `Out-File -Encoding UTF8` prepends
# a BOM that breaks Node's JSON.parse, so use .NET to write clean UTF-8.
$Json = $Config | ConvertTo-Json
[System.IO.File]::WriteAllText($ConfigPath, $Json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "เขียน config แล้ว: $ConfigPath" -ForegroundColor Green

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
