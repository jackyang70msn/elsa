@echo off
setlocal

:: Elsa — one-click launcher (Windows)
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

title Elsa Daemon
echo Starting Elsa...
echo Press Ctrl+C to stop.
echo.

npx tsx src/daemon.ts

pause
