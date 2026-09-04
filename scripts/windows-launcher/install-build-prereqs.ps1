<#
.SYNOPSIS
  ติดตั้งเครื่องมือที่ต้องใช้ "ตอนสร้าง" StoreOS Launcher (.NET SDK 8)

.DESCRIPTION
  สคริปต์นี้สำหรับ **เครื่องนักพัฒนา/เครื่องที่ใช้ build** เท่านั้น ไม่ใช่เครื่องร้าน

  ความต่างที่ต้องแยกให้ชัด:
    * .NET SDK             = เครื่องมือสร้างโปรแกรม (ใหญ่ ~1 GB) ต้องมีเฉพาะตอน build
    * .NET Desktop Runtime = ตัวรันโปรแกรม (เล็กกว่ามาก) ต้องมีบนเครื่องปลายทาง
      **เฉพาะกรณี** ที่ publish แบบ framework-dependent
  ค่าเริ่มต้นของ build-launcher.ps1 คือ self-contained ดังนั้นเครื่องร้าน
  **ไม่ต้องติดตั้ง .NET อะไรเลย** — การเอา SDK ไปแจกร้านจึงเป็นการเพิ่มขั้นตอนที่ไม่จำเป็น

.PARAMETER Force
  ติดตั้งซ้ำแม้ตรวจพบ SDK อยู่แล้ว
#>

[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = "Stop"

function Resolve-Dotnet {
  $cmd = Get-Command dotnet -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $fallback = Join-Path $env:ProgramFiles "dotnet\dotnet.exe"
  if (Test-Path $fallback) { return $fallback }
  return $null
}

Write-Host "== ตรวจ .NET SDK บนเครื่องนี้" -ForegroundColor Cyan
$dotnet = Resolve-Dotnet
$sdks = @()
if ($dotnet) {
  $sdks = @(& $dotnet --list-sdks 2>$null)
  Write-Host "   dotnet: $dotnet"
  if ($sdks.Count -gt 0) { $sdks | ForEach-Object { Write-Host "   SDK: $_" } }
  else { Write-Host "   พบเฉพาะ runtime ยังไม่มี SDK" -ForegroundColor Yellow }
} else {
  Write-Host "   ยังไม่มี .NET เลย" -ForegroundColor Yellow
}

$hasSdk8 = ($sdks -join "`n") -match "^8\."
if ($hasSdk8 -and -not $Force) {
  Write-Host "`nมี .NET SDK 8 อยู่แล้ว — พร้อม build (ใช้ -Force ถ้าต้องการติดตั้งซ้ำ)" -ForegroundColor Green
  exit 0
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Write-Warning "เครื่องนี้ไม่มี winget — ดาวน์โหลด .NET SDK 8 เองที่ https://dotnet.microsoft.com/download/dotnet/8.0"
  exit 1
}

Write-Host "`n== ติดตั้ง .NET SDK 8 ผ่าน winget (ดาวน์โหลดประมาณ 1 GB)" -ForegroundColor Cyan
& winget install -e --id Microsoft.DotNet.SDK.8 --silent --accept-package-agreements --accept-source-agreements
if ($LASTEXITCODE -ne 0) {
  throw "ติดตั้ง .NET SDK ไม่สำเร็จ (winget exit $LASTEXITCODE)"
}

Write-Host "`nติดตั้งเสร็จ — เปิดหน้าต่าง PowerShell ใหม่แล้วรัน:" -ForegroundColor Green
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\windows-launcher\build-launcher.ps1" -ForegroundColor Green
