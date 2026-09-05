@echo off
REM ตัวช่วยติดตั้ง StoreOS Launcher — ดับเบิลคลิกไฟล์นี้ได้เลย
REM (ห่อ PowerShell ไว้เพื่อให้ผู้ใช้ไม่ต้องยุ่งกับ ExecutionPolicy)
setlocal
cd /d "%~dp0"

REM --- ขอสิทธิ์ Administrator ตั้งแต่ครั้งแรก ---
REM ขั้นตอนลงทะเบียน Scheduled Task ของ Print Hub ต้องใช้สิทธิ์ Admin
REM ถ้าไม่ขอตั้งแต่ต้น ผู้ใช้จะติดตั้งไปเกือบจบแล้วเจอ "Access is denied" กลางทาง
REM (เครื่องร้านเจอจริง 2026-09-05) — เด้ง UAC ทีเดียวตอนเริ่มดีกว่าพังตอนท้าย
net session >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [..] ขอสิทธิ์ผู้ดูแลเครื่อง ^(Administrator^) — กด "ใช่" ในหน้าต่างที่เด้งขึ้นมา
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-launcher.ps1" -Autostart
echo.
pause
endlocal
