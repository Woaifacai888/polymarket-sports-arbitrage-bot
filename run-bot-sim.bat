@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

title Polymarket Bot - Simulation

echo.
echo  Polymarket Sports Trading Bot - SIMULATION MODE
echo  ================================================
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
    echo Edit .env to customize settings.
  )
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
echo [3/3] Starting bot via PM2 ^(simulation mode^)...
echo       Dashboard controls: [p] pause  [f] flatten  [q] quit
echo       Press Ctrl+C to stop PM2 and the bot.
echo.

call npx pm2-runtime start ecosystem.config.cjs --only polymarket-bot-sim

echo.
echo Bot stopped.
pause
