@echo off
setlocal
cd /d "%~dp0\..\.."

if not defined EMOJI_DATA_DIR set "EMOJI_DATA_DIR=%ProgramData%\WhatsApp-ERP\data"
if not defined PUPPETEER_CACHE_DIR set "PUPPETEER_CACHE_DIR=%ProgramData%\WhatsApp-ERP\chromium"

if exist "%ProgramData%\WhatsApp-ERP\service.json" (
  for /f "usebackq delims=" %%D in (`runtime\node.exe -e "try{const fs=require('fs');const s=JSON.parse(fs.readFileSync(process.env.ProgramData+'\\\\WhatsApp-ERP\\\\service.json','utf8'));if(s.dataDir)console.log(s.dataDir)}catch{}" 2^>nul`) do (
    if not "%%D"=="" set "EMOJI_DATA_DIR=%%D"
  )
)

set "NODE_ENV=production"
if exist "dist\runtime\apps\server\image-processing\cli.js" (
  runtime\node.exe dist\runtime\apps\server\image-processing\cli.js login
) else (
  call npm run gemini:login
)

set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Failed to complete Gemini Web login (exit code %EXIT_CODE%).
  pause
)
exit /b %EXIT_CODE%
