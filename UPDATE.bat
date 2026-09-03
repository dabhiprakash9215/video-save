@echo off
cd /d "%~dp0"
if not exist "bin" mkdir "bin"
echo Updating yt-dlp...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile 'bin\yt-dlp.exe'"
echo Updating npm packages...
call npm install
echo Done.
pause
