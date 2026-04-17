@echo off
setlocal enabledelayedexpansion

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
    echo(
)

:: Check for existing Elsa daemon via PID file
set "PID_FILE=%USERPROFILE%\.elsa\daemon.pid"
if exist "%PID_FILE%" (
    set /p EXISTING_PID=<"%PID_FILE%"
    if defined EXISTING_PID (
        tasklist /FI "PID eq !EXISTING_PID!" 2>nul | findstr /I "node" >nul
        if !errorlevel! equ 0 (
            echo(
            echo ERROR: Another Elsa is already running ^(PID !EXISTING_PID!^).
            echo        Stop it first: run stop-background.bat
            echo(
            pause
            exit /b 1
        ) else (
            del /f /q "%PID_FILE%" >nul 2>&1
        )
    )
)

title Elsa Daemon
echo Starting Elsa...
echo Press Ctrl+C to stop.
echo(

npx tsx src/daemon.ts

pause
