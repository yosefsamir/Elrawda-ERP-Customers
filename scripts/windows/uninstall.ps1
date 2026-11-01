# WhatsApp-ERP Uninstallation Helper Script
# Cleanly stops and unregisters scheduled tasks without removing persistent customer data
param(
    [string]$InstallRoot = 'C:\WhatsApp-ERP',
    [string]$StateRoot = "$env:ProgramData\WhatsApp-ERP"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$logDir = Join-Path $StateRoot 'logs'
if (Test-Path -LiteralPath $logDir) {
    $logFile = Join-Path $logDir 'uninstall.log'
    try { Start-Transcript -Path $logFile -Append -Force | Out-Null } catch {}
}

Write-Host "Stopping and unregistering WhatsApp-ERP scheduled tasks..." -ForegroundColor Cyan

# 1. Stop background service task
try {
    Stop-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
} catch {}

# 2. Unregister background service task
try {
    Unregister-ScheduledTask -TaskName 'WhatsAppERPOperations' -Confirm:$false -ErrorAction SilentlyContinue
} catch {}

# 3. Stop background backup task
try {
    Stop-ScheduledTask -TaskName 'WhatsAppERPOperationsBackup' -ErrorAction SilentlyContinue
} catch {}

# 4. Unregister background backup task
try {
    Unregister-ScheduledTask -TaskName 'WhatsAppERPOperationsBackup' -Confirm:$false -ErrorAction SilentlyContinue
} catch {}

Write-Host "WhatsApp-ERP scheduled tasks stopped and removed successfully." -ForegroundColor Green

if (Test-Path -LiteralPath $logDir) {
    try { Stop-Transcript | Out-Null } catch {}
}
