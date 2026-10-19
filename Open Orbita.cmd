@echo off
setlocal
if exist "%~dp0.runtime\electron\electron.exe" (
  start "" "%~dp0.runtime\electron\electron.exe" "%~dp0."
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 20 or newer, then open this file again.
  echo https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0launch.cjs"
if errorlevel 1 pause
