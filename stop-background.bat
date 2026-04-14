@echo off
setlocal

:: Elsa — stop daemon (Windows)

set FOUND=0
for /f "tokens=2" %%p in ('tasklist /fi "WINDOWTITLE eq Elsa Daemon" 2^>nul ^| findstr node') do (
    taskkill /PID %%p /F >nul 2>&1
    set FOUND=1
)

if %FOUND% equ 1 (
    echo Elsa stopped.
) else (
    echo Elsa is not running.
)

timeout /t 2 /nobreak >nul
