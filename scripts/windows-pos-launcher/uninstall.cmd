@echo off
REM StoreOS POS uninstaller - double-click this file
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-pos-launcher.ps1" %*
echo.
pause
endlocal
