param([string]$StateRoot="$env:ProgramData\WhatsApp-ERP",[int]$Keep=14)
$ErrorActionPreference='Stop'
$log=Join-Path $StateRoot 'logs\backup.log'
if (Test-Path (Join-Path $StateRoot 'data\maintenance.flag')) { exit 0 }
try {
    $config=Get-Content (Join-Path $StateRoot 'service.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    & (Join-Path $config.ReleasePath 'scripts\windows\backup.ps1') -StateRoot $StateRoot -Label 'daily'
    # Manual and pre-upgrade backups are never pruned
    Get-ChildItem -LiteralPath (Join-Path $StateRoot 'backups') -Directory -Filter 'daily-*' | Sort-Object Name -Descending | Select-Object -Skip $Keep | Remove-Item -Recurse -Force
    Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) OK daily backup completed"
} catch {
    Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) FAILED $($_.Exception.Message)"
    exit 1
}
