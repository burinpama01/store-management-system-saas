<#
.SYNOPSIS
  สร้างชุดติดตั้ง StoreOS POS (เครื่องผู้พัฒนา) -> dist\storeos-pos-launcher-<version>.zip

.DESCRIPTION
  build แบบ self-contained single-file (เครื่องร้านไม่ต้องลง .NET) แล้วรวม install.cmd /
  install-pos-launcher.ps1 / uninstall / README ไว้ใน zip เดียว
  ต้องมี .NET 8 SDK ที่ C:\Program Files\dotnet\dotnet.exe (ไม่อยู่ใน PATH บนเครื่องนี้)
#>
[CmdletBinding()]
param([string]$Dotnet = "C:\Program Files\dotnet\dotnet.exe")

$ErrorActionPreference = "Stop"
$Root    = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Project = Join-Path $Root "windows\StoreOS.PosLauncher\StoreOS.PosLauncher.csproj"
[xml]$csproj = Get-Content $Project -Encoding UTF8
$Version = ($csproj.Project.PropertyGroup | Where-Object { $_.Version } | Select-Object -First 1).Version
$Out     = Join-Path $Root "dist\pos-launcher-$Version"
$Stage   = Join-Path $Out "StoreOS POS"
$Zip     = Join-Path $Root "dist\storeos-pos-launcher-$Version.zip"

Write-Host "== build StoreOS POS $Version" -ForegroundColor Cyan
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
& $Dotnet publish $Project -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=none `
  -o (Join-Path $Stage "app")
if ($LASTEXITCODE -ne 0) { throw "dotnet publish ล้ม (exit $LASTEXITCODE)" }

foreach ($f in @("install.cmd", "install-pos-launcher.ps1", "uninstall-pos-launcher.ps1", "uninstall.cmd", "README-TH.txt")) {
  Copy-Item (Join-Path $PSScriptRoot $f) $Stage
}
if (Test-Path $Zip) { Remove-Item $Zip -Force }
Compress-Archive -Path $Stage -DestinationPath $Zip
$hash = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item $Zip).Length
Write-Host "   $Zip" -ForegroundColor Green
Write-Host "   size=$size sha256=$hash"
