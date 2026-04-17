@echo off
setlocal enabledelayedexpansion

:: Elsa — stop daemon (Windows)

set "PID_FILE=%USERPROFILE%\.elsa\daemon.pid"
set FOUND=0

:: Prefer PID file (works for hidden VBS-launched daemons)
if exist "%PID_FILE%" (
    set /p DAEMON_PID=<"%PID_FILE%"
    if defined DAEMON_PID (
        tasklist /FI "PID eq !DAEMON_PID!" 2>nul | findstr /I "node" >nul
        if !errorlevel! equ 0 (
            taskkill /PID !DAEMON_PID! /T /F >nul 2>&1
            set FOUND=1
        )
    )
    del /f /q "%PID_FILE%" >nul 2>&1
)

:: Fallback: foreground daemon launched with `title Elsa Daemon`
if !FOUND! equ 0 (
    for /f "tokens=2" %%p in ('tasklist /fi "WINDOWTITLE eq Elsa Daemon" 2^>nul ^| findstr node') do (
        taskkill /PID %%p /T /F >nul 2>&1
        set FOUND=1
    )
)

if !FOUND! equ 1 (
    echo Elsa stopped.
) else (
    echo Elsa is not running.
)

timeout /t 2 /nobreak >nul
