@echo off
REM Manual launcher for the StoreOS Print Hub (for testing / running without the
REM scheduled task). Reads scripts\print-hub.config.json. Press Ctrl+C to stop.
setlocal
set "HERE=%~dp0"
node "%HERE%..\print-hub.mjs"
endlocal
