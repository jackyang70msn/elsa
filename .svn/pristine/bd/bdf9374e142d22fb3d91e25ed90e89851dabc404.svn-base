@echo off
setlocal

:: Elsa — Windows setup (install + configure)
:: Usage: Double-click or run in cmd

cd /d "%~dp0"

set REQUIRED_NODE_MAJOR=18

echo Elsa — Setup
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Error: Node.js is required ^(^>= %REQUIRED_NODE_MAJOR%^).
    echo Install it from https://nodejs.org
    pause
    exit /b 1
)

:: Check Node.js version
for /f %%v in ('node -p "process.version.slice(1).split(`.`)[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% lss %REQUIRED_NODE_MAJOR% (
    echo Error: Node.js ^>= %REQUIRED_NODE_MAJOR% required, found %NODE_MAJOR%.
    echo Upgrade at https://nodejs.org
    pause
    exit /b 1
)

:: Check npm
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo Error: npm is required but not found.
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

:: Run interactive setup
echo.
npx tsx src/cli.ts setup

pause
