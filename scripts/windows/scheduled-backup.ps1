param([string]$StateRoot="$env:ProgramData\WhatsApp-ERP")
$ErrorActionPreference='Stop'
$config=Get-Content (Join-Path $StateRoot 'service.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (Test-Path (Join-Path $StateRoot 'maintenance.flag')) { exit 0 }
& (Join-Path $config.ReleasePath 'scripts\windows\backup.ps1') -StateRoot $StateRoot
