@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js LTS from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm.cmd ci
  if errorlevel 1 goto failed
)
if not exist .env.local copy .env.example .env.local >nul
call npm.cmd run db:migrate
if errorlevel 1 goto failed
node scripts/launch.mjs
if errorlevel 1 goto failed
exit /b 0
:failed
echo AURA could not start. Read the error above before closing this window.
pause
exit /b 1
