@echo off
setlocal

where node.exe >nul 2>nul
if errorlevel 1 (
  echo VI Media Processor requires Node.js 20 or newer. 1>&2
  exit /b 1
)

node "%~dp0bin\vi-media.mjs" %*
exit /b %errorlevel%
