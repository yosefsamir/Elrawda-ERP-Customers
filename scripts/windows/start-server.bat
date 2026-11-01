@echo off
cd /d "%~dp0\..\.."
if not defined EMOJI_DATA_DIR set "EMOJI_DATA_DIR=%ProgramData%\WhatsApp-ERP\data"
if not defined PUPPETEER_CACHE_DIR set "PUPPETEER_CACHE_DIR=%ProgramData%\WhatsApp-ERP\chromium"
set "NODE_ENV=production"
runtime\node.exe dist\runtime\apps\server\index.js
exit /b %ERRORLEVEL%
