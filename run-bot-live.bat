@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

title Polymarket Bot - Live Trading

echo.
echo  Polymarket Sports Trading Bot - LIVE TRADING MODE
echo  ===================================================
echo.
echo  WARNING: Live mode places REAL orders on Polymarket with real funds.
echo           Ensure PRIVATE_KEY and CLOB API credentials are set in .env
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo         Download from https://nodejs.org/ ^(Node 20+ required^)
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo Node.js !NODE_VER! detected

if not exist ".env" (
  if exist ".env.example" (
    echo Creating .env from .env.example...
    copy /Y ".env.example" ".env" >nul
    echo.
    echo [ERROR] .env was just created from the template.
    echo         Add your PRIVATE_KEY and CLOB API credentials, then re-run.
    pause
    exit /b 1
  ) else (
    echo [ERROR] .env file not found. Copy .env.example to .env and add credentials.
    pause
    exit /b 1
  )
)

findstr /R /C:"^PRIVATE_KEY=." ".env" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] PRIVATE_KEY is not set in .env
  pause
  exit /b 1
)

findstr /R /C:"^CLOB_API_KEY=." ".env" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] CLOB_API_KEY is not set in .env
  pause
  exit /b 1
)

set /p CONFIRM=Type YES to start live trading: 
if /i not "!CONFIRM!"=="YES" (
  echo Aborted.
  pause
  exit /b 1
)

if not exist "logs" mkdir logs

echo.
echo [1/3] Installing npm dependencies...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)

echo.
echo [2/3] Building TypeScript...
call npm run build
if errorlevel 1 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

echo.
echo [3/3] Starting bot via PM2 ^(live mode^)...
echo       Dashboard controls: [p] pause  [f] flatten  [q] quit
echo       Press Ctrl+C to stop PM2 and the bot.
echo.

call npx pm2-runtime start ecosystem.config.cjs --only polymarket-bot-live

echo.
echo Bot stopped.
pause
