@echo off
setlocal enabledelayedexpansion

:: Elsa — background launcher (Windows)
:: Usage: Double-click or run in cmd / PowerShell

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
        )
    )
)

:: Remove stale PID file before starting
if exist "%PID_FILE%" del "%PID_FILE%"

:: Resolve node path
for /f "tokens=*" %%i in ('where node') do set "NODE_EXE=%%i"

:: Write a temporary VBScript to launch node completely hidden (no window at all)
set "VBS_FILE=%TEMP%\elsa_start.vbs"
set "WORK_DIR=%cd%"
(
    echo Set oShell = CreateObject("WScript.Shell"^)
    echo oShell.CurrentDirectory = "%WORK_DIR%"
    echo oShell.Run """%NODE_EXE%"" --import tsx src/daemon.ts", 0, False
) > "%VBS_FILE%"

echo Starting Elsa in background...
wscript //nologo "%VBS_FILE%"

:: Wait for PID file to appear (daemon writes it on startup)
set ATTEMPTS=0
:WAIT_LOOP
timeout /t 1 /nobreak >nul
set /a ATTEMPTS+=1
if exist "%PID_FILE%" goto STARTED
if %ATTEMPTS% geq 10 goto FAILED
goto WAIT_LOOP

:STARTED
set /p NEW_PID=<"%PID_FILE%"
echo Elsa is running in background (PID %NEW_PID%).
echo To stop: run stop-background.bat
del "%VBS_FILE%" >nul 2>&1
timeout /t 2 /nobreak >nul
exit /b 0

:FAILED
echo Failed to start Elsa. Run start.bat to see errors.
del "%VBS_FILE%" >nul 2>&1
pause
exit /b 1
