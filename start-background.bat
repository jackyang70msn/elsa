@echo off
setlocal

:: Elsa — background launcher (Windows)
:: Usage: Double-click or run in cmd

cd /d "%~dp0"

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Error: Node.js is not installed.
    echo Install it from https://nodejs.org
    pause
    exit /b 1
)

:: Install dependencies if needed
if not exist "node_modules" (
    echo Installing dependencies...
    npm install
    if %errorlevel% neq 0 (
        echo Failed to install dependencies.
        pause
        exit /b 1
    )
    echo.
)

:: Kill any existing Elsa daemon
for /f "tokens=2" %%p in ('tasklist /fi "WINDOWTITLE eq Elsa Daemon" 2^>nul ^| findstr node') do (
    taskkill /PID %%p /F >nul 2>&1
)

:: Start in background (hidden window)
echo Starting Elsa in background...
start "Elsa Daemon" /min cmd /c "title Elsa Daemon && node --import tsx src/daemon.ts"

:: Verify it started
timeout /t 2 /nobreak >nul
tasklist /fi "WINDOWTITLE eq Elsa Daemon" 2>nul | findstr node >nul
if %errorlevel% equ 0 (
    echo Elsa is running in background.
    echo To stop: run stop.bat or close "Elsa Daemon" from taskbar.
) else (
    echo Failed to start Elsa. Run start.bat to see errors.
)

timeout /t 3 /nobreak >nul
