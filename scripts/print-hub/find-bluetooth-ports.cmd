@echo off
REM ============================================================
REM  StoreOS Print Hub - find Bluetooth / serial COM ports
REM  Lists every COM port and its device name so you know which
REM  COM number to enter for a Bluetooth printer.
REM ============================================================
setlocal
echo Searching for serial / Bluetooth COM ports...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\(COM\d+\)' } | ForEach-Object { [PSCustomObject]@{ Port = [regex]::Match($_.Name,'COM\d+').Value; Device = ($_.Name -replace '\s*\(COM\d+\)','') } } | Sort-Object Port | Format-Table -AutoSize"
echo.
echo Tip: a Bluetooth printer usually shows as "Standard Serial over Bluetooth link".
echo Use its COM number (e.g. COM5) in StoreOS ^> Settings ^> Receipt ^> Bluetooth printer.
echo.
pause
endlocal
