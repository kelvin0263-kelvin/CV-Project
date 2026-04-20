@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start_deployment.ps1"
exit /b 0
