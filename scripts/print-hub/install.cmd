@echo off
REM ============================================================
REM  StoreOS Print Hub - one double-click installer
REM  1) picks up print-hub.config.json (from this folder or Downloads)
REM  2) elevates to Administrator
REM  3) runs the installer, which installs Node.js automatically
REM     (winget, or a portable download) if it is missing
REM  Thai instructions: see README-TH.txt
REM ============================================================
setlocal EnableExtensions
cd /d "%~dp0"

REM --- 1) Bring the downloaded config into this folder if needed ---
if not exist "print-hub.config.json" if exist "%USERPROFILE%\Downloads\print-hub.config.json" copy /y "%USERPROFILE%\Downloads\print-hub.config.json" "print-hub.config.json" >nul

if not exist "print-hub.config.json" (
  echo.
  echo  [X] Config file not found: print-hub.config.json
  echo      Download it from StoreOS ^> Settings ^> Print Hub,
  echo      then put it in THIS folder and run again.
  echo.
  pause
  exit /b 1
)

REM --- 2) Elevate to Administrator if needed ---
net session >nul 2>nul
if errorlevel 1 (
  echo  [..] Requesting administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"

REM --- 3) Run the installer (installs Node.js automatically if missing) ---
powershell -NoProfile -ExecutionPolicy Bypass -File ".\print-hub\install-windows.ps1"
echo.
echo  Done. Go back to the Print Hub page in StoreOS and click "Test print".
pause
endlocal
