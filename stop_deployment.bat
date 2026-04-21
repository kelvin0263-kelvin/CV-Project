@echo off
setlocal
set "PROJECT_ROOT=%~dp0"
set "BACKEND_PORT=8000"
set "NGINX_DIR="
set "BACKEND_FOUND=0"

echo.
echo [Stop] Stopping Nginx

if defined NGINX_ROOT (
    set "NGINX_DIR=%NGINX_ROOT%"
) else (
    for /d %%D in ("%PROJECT_ROOT%nginx-*") do (
        set "NGINX_DIR=%%~fD"
        goto :nginx_dir_found
    )
    for /d %%D in ("%PROJECT_ROOT%..\nginx-*") do (
        set "NGINX_DIR=%%~fD"
        goto :nginx_dir_found
    )
)

:nginx_dir_found
if defined NGINX_DIR (
    if exist "%NGINX_DIR%\nginx.exe" (
        pushd "%NGINX_DIR%" >nul
        .\nginx.exe -s quit >nul 2>&1
        popd >nul
        timeout /t 2 /nobreak >nul
    )
)

taskkill /F /IM nginx.exe >nul 2>&1
if errorlevel 1 (
    echo Nginx is not running.
) else (
    echo Nginx stopped.
)

echo.
echo [Stop] Stopping backend on port %BACKEND_PORT%

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%BACKEND_PORT% .*LISTENING"') do (
    set "BACKEND_FOUND=1"
    echo Stopping PID %%P
    taskkill /F /PID %%P >nul 2>&1
)

if "%BACKEND_FOUND%"=="0" (
    echo No backend process is listening on port %BACKEND_PORT%.
)

echo.
echo [Stop] Done
echo Nginx and backend stop routine completed.
