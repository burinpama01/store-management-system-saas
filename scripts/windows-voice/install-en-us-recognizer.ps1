<#
.SYNOPSIS
  ตรวจและติดตั้งชุดรู้จำเสียง en-US ที่ Voice Standby ต้องใช้ (แผน v1 W0 / v3 Task 9)

.DESCRIPTION
  Wake word "Hey StoreOS" ในแผน v1 ใช้ System.Speech (SpeechRecognitionEngine) ซึ่งทำงานได้
  ก็ต่อเมื่อเครื่องมี recognizer ของ Windows ติดตั้งอยู่จริง. เครื่อง Windows ที่ขายในไทย
  จำนวนมากไม่มี en-US recognizer มาให้ ทำให้ทั้งฟีเจอร์ใช้ไม่ได้ — นี่คือคำถามที่ W0 spike
  ต้องตอบก่อนลงทุนทำ W1-W12.

  สคริปต์นี้ทำสองโหมด:
    -Probe (ค่าเริ่มต้น)  อ่านอย่างเดียว ไม่แก้อะไรบนเครื่อง แล้วรายงานว่ามีอะไรบ้าง
    -Install              ติดตั้ง Windows capability "Language.Speech~~~en-US~0.0.1.0"
                          (ต้องรันแบบ Administrator และเครื่องต้องต่อเน็ต เพราะดึงจาก Windows Update)

  ผลลัพธ์เป็น JSON บรรทัดเดียวท้ายสุด เพื่อให้แนบเป็นหลักฐานของ W0 ได้ตรง ๆ

.NOTES
  * สคริปต์นี้ไม่ติดตั้งอะไรถ้าไม่ได้สั่ง -Install อย่างชัดเจน
  * ไม่ส่งข้อมูลออกนอกเครื่อง ไม่แตะไมโครโฟน และไม่บันทึกเสียงใด ๆ
  * ยังไม่ได้ทดสอบบนเครื่องหน้าร้านจริง — ต้องรันบนเครื่อง POS จริงเพื่อปิด gate W0
#>

[CmdletBinding()]
param(
  [switch]$Install,
  [string]$Culture = "en-US"
)

$ErrorActionPreference = "Stop"

function Get-InstalledRecognizers {
  # System.Speech อยู่ใน .NET Framework ที่ติดมากับ Windows — โหลดตรง ๆ ได้โดยไม่ต้องลงอะไร
  try {
    Add-Type -AssemblyName System.Speech
    return @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object {
      [pscustomobject]@{
        id      = $_.Id
        name    = $_.Name
        culture = $_.Culture.Name
      }
    })
  } catch {
    Write-Warning "โหลด System.Speech ไม่ได้: $($_.Exception.Message)"
    return @()
  }
}

function Get-SpeechCapability {
  param([string]$CultureName)
  try {
    $name = "Language.Speech~~~$CultureName~0.0.1.0"
    $cap = Get-WindowsCapability -Online -Name $name -ErrorAction Stop
    return [pscustomobject]@{ name = $cap.Name; state = "$($cap.State)" }
  } catch {
    return [pscustomobject]@{ name = "Language.Speech~~~$CultureName~0.0.1.0"; state = "Unavailable" }
  }
}

function Test-Admin {
  $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

Write-Host "StoreOS — ตรวจชุดรู้จำเสียงสำหรับ Voice Standby" -ForegroundColor Cyan
Write-Host ""

$os = Get-CimInstance Win32_OperatingSystem
Write-Host "Windows : $($os.Caption) build $($os.BuildNumber) ($($os.OSArchitecture))"

$recognizers = Get-InstalledRecognizers
if ($recognizers.Count -eq 0) {
  Write-Host "recognizer  : ไม่พบเลย" -ForegroundColor Yellow
} else {
  Write-Host "recognizer  : พบ $($recognizers.Count) ตัว"
  $recognizers | ForEach-Object { Write-Host "              - $($_.name) [$($_.culture)]" }
}

$hasCulture = @($recognizers | Where-Object { $_.culture -eq $Culture }).Count -gt 0
$capability = Get-SpeechCapability -CultureName $Culture

Write-Host "capability  : $($capability.name) = $($capability.state)"
Write-Host ""

$installAttempted = $false
$installResult    = "skipped"

if ($hasCulture) {
  Write-Host "OK: เครื่องนี้มี recognizer $Culture อยู่แล้ว — Voice Standby ผ่านเงื่อนไขข้อนี้" -ForegroundColor Green
} elseif (-not $Install) {
  Write-Host "ยังไม่มี recognizer $Culture บนเครื่องนี้" -ForegroundColor Yellow
  Write-Host "ถ้าต้องการติดตั้ง ให้เปิด PowerShell แบบ Administrator แล้วรัน:" -ForegroundColor Yellow
  Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Install" -ForegroundColor Yellow
} else {
  if (-not (Test-Admin)) {
    Write-Error "ต้องรันแบบ Administrator ถึงจะติดตั้ง Windows capability ได้ (คลิกขวา PowerShell > Run as administrator)"
    exit 2
  }
  $installAttempted = $true
  Write-Host "กำลังติดตั้ง $($capability.name) จาก Windows Update ..." -ForegroundColor Cyan
  try {
    Add-WindowsCapability -Online -Name $capability.name | Out-Null
    $installResult = "installed"
    Write-Host "ติดตั้งเสร็จ — ปิดแล้วเปิดเครื่องใหม่หนึ่งครั้งก่อนทดสอบ wake word" -ForegroundColor Green
  } catch {
    $installResult = "failed"
    Write-Error "ติดตั้งไม่สำเร็จ: $($_.Exception.Message)"
  }
  # อ่านซ้ำหลังติดตั้งเพื่อบันทึกผลจริง ไม่ใช่ผลที่คาดว่าจะเป็น
  $recognizers = Get-InstalledRecognizers
  $hasCulture  = @($recognizers | Where-Object { $_.culture -eq $Culture }).Count -gt 0
  $capability  = Get-SpeechCapability -CultureName $Culture
}

# WebView2 runtime เป็นอีกเงื่อนไขของ W0 (Launcher ใช้แสดง POS)
$webview2 = $null
foreach ($path in @(
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
  "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
)) {
  if (Test-Path $path) { $webview2 = (Get-ItemProperty $path).pv; break }
}
Write-Host "WebView2    : $(if ($webview2) { $webview2 } else { 'ไม่พบ' })"

$report = [pscustomobject]@{
  checkedAt        = (Get-Date).ToString("o")
  windows          = "$($os.Caption) $($os.BuildNumber) $($os.OSArchitecture)"
  culture          = $Culture
  hasRecognizer    = $hasCulture
  recognizers      = $recognizers
  capabilityState  = $capability.state
  webview2Version  = $webview2
  installAttempted = $installAttempted
  installResult    = $installResult
  # เกณฑ์ผ่านของ W0 ข้อ 1 (แผน v1): ต้องมี recognizer ที่ใช้ได้ + WebView2 runtime
  w0Gate1Pass      = ($hasCulture -and $null -ne $webview2)
}

Write-Host ""
Write-Host "----- JSON (แนบเป็นหลักฐาน W0) -----"
$report | ConvertTo-Json -Compress -Depth 4
