@echo off
setlocal
title VidsSave - Setup and Start
cd /d "%~dp0"

echo.
echo ==========================================
echo        VidsSave Full Working Setup
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Install Node.js 18+ and run START.bat again.
  echo.
  pause
  exit /b 1
)

if not exist "bin" mkdir "bin"

if not exist "bin\yt-dlp.exe" (
  echo Downloading latest yt-dlp...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile 'bin\yt-dlp.exe'"
  if errorlevel 1 (
    echo Could not download yt-dlp. Check your internet connection.
    pause
    exit /b 1
  )
)

echo.
echo Installing Node dependencies and FFmpeg...
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

echo.
echo Starting VidsSave...
start "" "http://localhost:3000"
node server.js
pause
