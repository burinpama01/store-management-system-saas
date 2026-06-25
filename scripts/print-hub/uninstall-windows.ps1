<#
.SYNOPSIS
  Removes the StoreOS Print Hub auto-start task and its config.
  Run from an elevated PowerShell:
    powershell -ExecutionPolicy Bypass -File uninstall-windows.ps1
#>

$ErrorActionPreference = "Stop"
$TaskName = "StoreOSPrintHub"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ScriptsDir = Split-Path -Parent $ScriptDir
$ConfigPath = Join-Path $ScriptsDir "print-hub.config.json"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "ลบ Scheduled Task '$TaskName' แล้ว" -ForegroundColor Green
} else {
  Write-Host "ไม่พบ Scheduled Task '$TaskName' (อาจถูกลบไปแล้ว)" -ForegroundColor Yellow
}

if (Test-Path $ConfigPath) {
  Remove-Item $ConfigPath -Force
  Write-Host "ลบ config: $ConfigPath" -ForegroundColor Green
}
Write-Host "ถอนการติดตั้ง StoreOS Print Hub เสร็จสิ้น" -ForegroundColor Cyan
