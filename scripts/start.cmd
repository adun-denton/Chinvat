@echo off
REM Double-click launcher for the Chinvat hub.
setlocal
cd /d "%~dp0.."
if not exist "hub\dist\index.js" (
  echo Building Chinvat for the first time...
  call npm install --no-fund --no-audit
  call npm run build
)
start "" http://localhost:7777
node hub\dist\index.js
