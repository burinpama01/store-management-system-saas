<#
.SYNOPSIS
  ถอนการติดตั้ง StoreOS POS (ลบโปรแกรมและทางลัด - เก็บ log/ข้อมูลล็อกอินไว้ ถ้าจะลบด้วยใส่ -RemoveData)
#>
[CmdletBinding()]
param([switch]$RemoveData)

$ErrorActionPreference = "Stop"
Get-Process -Name "StoreOS.PosLauncher" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
foreach ($lnk in @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "StoreOS POS.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Programs")) "StoreOS POS.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Startup")) "StoreOS POS.lnk"))) {
  if (Test-Path $lnk) { Remove-Item $lnk -Force }
}
$base = Join-Path $env:LOCALAPPDATA "StoreOS\PosLauncher"
$app = Join-Path $base "app"
if (Test-Path $app) { Remove-Item $app -Recurse -Force }
if ($RemoveData -and (Test-Path $base)) { Remove-Item $base -Recurse -Force }
Write-Host "ถอนการติดตั้ง StoreOS POS แล้ว" -ForegroundColor Green
