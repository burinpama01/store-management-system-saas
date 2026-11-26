@echo off
REM StoreOS POS installer - double-click this file (no Administrator needed)
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-pos-launcher.ps1"
echo.
pause
endlocal
