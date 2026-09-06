<#
.SYNOPSIS
  สร้างชุดติดตั้ง StoreOS Launcher (.zip) สำหรับอัปโหลดขึ้นหน้าดาวน์โหลด

.DESCRIPTION
  รันบน "เครื่องนักพัฒนา" เท่านั้น (ต้องมี .NET SDK — ติดตั้งด้วย install-build-prereqs.ps1)
  ผลลัพธ์คือ artifacts/launcher/storeos-launcher.zip ที่ร้านดาวน์โหลดไปแตกแล้วดับเบิลคลิก
  install.cmd ได้เลย

  ค่าเริ่มต้น publish แบบ **self-contained single file** เพื่อให้เครื่องร้านไม่ต้องติดตั้ง
  .NET อะไรเลย (ไฟล์ใหญ่ขึ้นราว 60-90 MB แต่แลกกับการติดตั้งที่ล้มน้อยลงมาก ซึ่งคุ้มกว่า
  สำหรับหน้าร้านที่ไม่มีคนไอที) ถ้าอยากได้ไฟล์เล็กให้ใส่ -FrameworkDependent แล้วตัวติดตั้ง
  ฝั่งร้านจะไปติดตั้ง .NET Desktop Runtime ให้แทน

.PARAMETER FrameworkDependent
  สร้างแบบพึ่ง .NET Desktop Runtime บนเครื่องปลายทาง (ไฟล์เล็กลง แต่ต้องติดตั้ง runtime)

.PARAMETER IncludePrintHub
  ใส่ชุด Print Hub ลงไปในไฟล์ zip เดียวกัน เพื่อให้ติดตั้งครั้งเดียวได้ทั้งสองอย่าง
#>

[CmdletBinding()]
param(
  [switch]$FrameworkDependent,
  [switch]$IncludePrintHub = $true,
  [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"

$RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Project    = Join-Path $RepoRoot "windows\StoreOS.Launcher\StoreOS.Launcher.csproj"
$TestProj   = Join-Path $RepoRoot "windows\StoreOS.Launcher.Tests\StoreOS.Launcher.Tests.csproj"
$OutRoot    = Join-Path $RepoRoot "artifacts\launcher"
$StageDir   = Join-Path $OutRoot "stage"
$ZipPath    = Join-Path $OutRoot "storeos-launcher.zip"

function Resolve-Dotnet {
  $cmd = Get-Command dotnet -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $fallback = Join-Path $env:ProgramFiles "dotnet\dotnet.exe"
  if (Test-Path $fallback) { return $fallback }
  throw "ไม่พบ dotnet — รัน scripts/windows-launcher/install-build-prereqs.ps1 ก่อน (ติดตั้ง .NET SDK 8)"
}

$dotnet = Resolve-Dotnet
Write-Host "dotnet: $dotnet" -ForegroundColor Cyan

# SDK (ไม่ใช่แค่ runtime) จำเป็นสำหรับการ build
$sdks = & $dotnet --list-sdks 2>$null
if (-not $sdks) {
  throw "เครื่องนี้มีแต่ .NET runtime ยังไม่มี SDK — รัน scripts/windows-launcher/install-build-prereqs.ps1 ก่อน"
}

Write-Host "`n== รันเทสต์ก่อนแพ็ก" -ForegroundColor Cyan
& $dotnet test $TestProj -c $Configuration --nologo
if ($LASTEXITCODE -ne 0) { throw "เทสต์ไม่ผ่าน — ไม่แพ็กชุดติดตั้ง" }

Write-Host "`n== publish" -ForegroundColor Cyan
if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
$appDir = Join-Path $StageDir "app"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

$publishArgs = @(
  "publish", $Project,
  "-c", $Configuration,
  "-r", "win-x64",
  "-o", $appDir,
  "--nologo",
  "/p:PublishSingleFile=true"
)
if ($FrameworkDependent) {
  $publishArgs += "--self-contained:false"
} else {
  $publishArgs += "--self-contained:true"
  # ตัดโค้ดที่ไม่ได้ใช้ออกเพื่อลดขนาดไฟล์
  $publishArgs += "/p:PublishTrimmed=false"
}
& $dotnet @publishArgs
if ($LASTEXITCODE -ne 0) { throw "publish ไม่สำเร็จ" }

# ---- ชุดข้อมูลเสียงของ Vosk (คำปลุก) ----
# ฝังมากับชุดติดตั้งเลย เพื่อให้ร้านติดตั้งจบในครั้งเดียวโดยไม่ต้องพึ่งเน็ตตอนติดตั้ง
# เก็บสำเนาไว้ที่เครื่อง build (ไม่เข้า git เพราะ 40 MB) แล้วคัดลอกลง stage ทุกครั้ง
$modelName  = "vosk-model-small-en-us-0.15"
$modelCache = Join-Path $env:LOCALAPPDATA "StoreOSBuild\$modelName"
if (-not (Test-Path $modelCache)) {
  Write-Host "`n== ดาวน์โหลดชุดข้อมูลเสียง (ครั้งแรกเท่านั้น ~40 MB)" -ForegroundColor Cyan
  $zip = Join-Path $env:TEMP "$modelName.zip"
  Invoke-WebRequest -Uri "https://alphacephei.com/vosk/models/$modelName.zip" -OutFile $zip
  $cacheRoot = Split-Path $modelCache
  New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
  Expand-Archive -Path $zip -DestinationPath $cacheRoot -Force
  Remove-Item $zip -Force
}
Write-Host "== ใส่ชุดข้อมูลเสียงคำปลุก" -ForegroundColor Cyan
$modelDest = Join-Path $appDir "vosk-model"
Copy-Item $modelCache $modelDest -Recurse -Force
# ที่มาและสัญญาอนุญาตของโมเดล — ต้องแนบไปกับไฟล์ที่แจกจ่าย
Set-Content -Path (Join-Path $modelDest "SOURCE.txt") -Encoding UTF8 -Value @"
ชุดข้อมูลเสียง: $modelName
ที่มา: https://alphacephei.com/vosk/models
สัญญาอนุญาต: Apache-2.0 (Vosk / Alpha Cephei)
ใช้สำหรับตรวจจับคำปลุก "Hello StoreOS" บนเครื่องเท่านั้น ไม่มีการส่งเสียงออกนอกเครื่อง
"@

# ตัวติดตั้งฝั่งร้านใช้ไฟล์หมายนี้ตัดสินว่าต้องลง .NET Desktop Runtime ให้หรือไม่
if ($FrameworkDependent) {
  Set-Content -Path (Join-Path $StageDir "REQUIRES_DOTNET_RUNTIME") -Value "1" -Encoding UTF8
}

Write-Host "`n== ใส่สคริปต์ติดตั้ง" -ForegroundColor Cyan
Copy-Item (Join-Path $PSScriptRoot "install-launcher.ps1")   $StageDir -Force
Copy-Item (Join-Path $PSScriptRoot "install.cmd")            $StageDir -Force
Copy-Item (Join-Path $PSScriptRoot "uninstall-launcher.ps1") $StageDir -Force
Copy-Item (Join-Path $RepoRoot "scripts\windows-voice\install-en-us-recognizer.ps1") $StageDir -Force -ErrorAction SilentlyContinue

if ($IncludePrintHub) {
  Write-Host "== ใส่ชุด Print Hub" -ForegroundColor Cyan
  $hubStage = Join-Path $StageDir "print-hub"
  New-Item -ItemType Directory -Force -Path $hubStage | Out-Null
  Copy-Item (Join-Path $RepoRoot "scripts\print-hub\*") $hubStage -Recurse -Force
  Copy-Item (Join-Path $RepoRoot "scripts\print-hub.mjs") $hubStage -Force
}

Write-Host "`n== แพ็กเป็น zip" -ForegroundColor Cyan
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
Compress-Archive -Path (Join-Path $StageDir "*") -DestinationPath $ZipPath -CompressionLevel Optimal

$sizeMb = [math]::Round((Get-Item $ZipPath).Length / 1MB, 1)
$hash   = (Get-FileHash $ZipPath -Algorithm SHA256).Hash

Write-Host "`nเสร็จแล้ว: $ZipPath ($sizeMb MB)" -ForegroundColor Green
Write-Host "SHA256: $hash" -ForegroundColor Green
Write-Host ""
Write-Host "ขั้นต่อไป: อัปโหลดไฟล์นี้ขึ้น Supabase storage bucket 'app' ชื่อ storeos-launcher.zip" -ForegroundColor Yellow
Write-Host "แล้วลิงก์ /download/windows-launcher จะชี้ไปหาไฟล์ใหม่ทันทีโดยไม่ต้อง deploy" -ForegroundColor Yellow
