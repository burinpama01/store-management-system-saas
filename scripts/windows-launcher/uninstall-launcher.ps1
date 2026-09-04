<#
.SYNOPSIS
  ถอนการติดตั้ง StoreOS Launcher ออกจากเครื่องนี้

.DESCRIPTION
  ลบเฉพาะของ Launcher: โฟลเดอร์โปรแกรม ทางลัด และค่าเปิดเองตอนล็อกอิน
  **ไม่แตะ Print Hub** (ถอนแยกด้วย scripts/print-hub/uninstall-windows.ps1)
  และไม่ถอน WebView2 / .NET ออก เพราะโปรแกรมอื่นบนเครื่องอาจใช้อยู่
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$InstallDir = Join-Path $env:LOCALAPPDATA "StoreOS\Launcher"

Get-Process -Name "StoreOS.Launcher" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "StoreOSLauncher" -ErrorAction SilentlyContinue

foreach ($dir in @(
  [Environment]::GetFolderPath("Desktop"),
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs")
)) {
  Remove-Item (Join-Path $dir "StoreOS.lnk") -ErrorAction SilentlyContinue
}

if (Test-Path $InstallDir) {
  Remove-Item $InstallDir -Recurse -Force
  Write-Host "ลบ $InstallDir แล้ว" -ForegroundColor Green
} else {
  Write-Host "ไม่พบโฟลเดอร์ติดตั้ง — อาจถอนไปแล้ว" -ForegroundColor Yellow
}

Write-Host "ถอน StoreOS Launcher เรียบร้อย (Print Hub ยังอยู่)" -ForegroundColor Green
