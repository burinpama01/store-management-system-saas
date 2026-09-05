<#
.SYNOPSIS
  Removes the StoreOS Print Hub auto-start task and its config.
  Run from an elevated PowerShell:
    powershell -ExecutionPolicy Bypass -File uninstall-windows.ps1
#>

$ErrorActionPreference = "Stop"
$TaskName = "StoreOSPrintHub"

# ตัวติดตั้งย้ายทั้ง agent และ config ไปอยู่ที่ LocalAppData แล้ว (ดู install-windows.ps1)
# แต่ยังต้องเก็บกวาดไฟล์ของการติดตั้งรุ่นเก่าที่วางไว้ข้างสคริปต์ด้วย
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$InstallRoot = Join-Path $env:LOCALAPPDATA "StoreOSPrintHub"
$ConfigPaths = @(
  (Join-Path $InstallRoot "print-hub.config.json"),
  (Join-Path (Split-Path -Parent $ScriptDir) "print-hub.config.json"),
  (Join-Path $ScriptDir "print-hub.config.json")
) | Select-Object -Unique
$AgentCopy = Join-Path $InstallRoot "print-hub.mjs"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "ลบ Scheduled Task '$TaskName' แล้ว" -ForegroundColor Green
} else {
  Write-Host "ไม่พบ Scheduled Task '$TaskName' (อาจถูกลบไปแล้ว)" -ForegroundColor Yellow
}

foreach ($ConfigPath in $ConfigPaths) {
  if (Test-Path $ConfigPath) {
    Remove-Item $ConfigPath -Force
    Write-Host "ลบ config: $ConfigPath" -ForegroundColor Green
  }
}

if (Test-Path $AgentCopy) {
  Remove-Item $AgentCopy -Force
  Write-Host "ลบตัวช่วยพิมพ์ที่ติดตั้งไว้: $AgentCopy" -ForegroundColor Green
}
Write-Host "ถอนการติดตั้ง StoreOS Print Hub เสร็จสิ้น" -ForegroundColor Cyan
