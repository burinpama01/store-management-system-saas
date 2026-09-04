@echo off
REM ตัวช่วยติดตั้ง StoreOS Launcher — ดับเบิลคลิกไฟล์นี้ได้เลย
REM (ห่อ PowerShell ไว้เพื่อให้ผู้ใช้ไม่ต้องยุ่งกับ ExecutionPolicy)
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-launcher.ps1" -Autostart
echo.
pause
