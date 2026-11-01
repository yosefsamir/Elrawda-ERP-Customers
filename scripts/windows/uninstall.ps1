# WhatsApp-ERP Uninstallation Helper Script
# Cleanly stops and unregisters scheduled tasks and removes application binaries (H1, H2)
# Preserves persistent customer data, SQLite databases, WhatsApp sessions, and backups
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

Write-Host "Stopping and unregistering WhatsApp-ERP scheduled tasks and background processes..." -ForegroundColor Cyan

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

# 5. Stop process tree and release port 3211
$commonScript = Join-Path $PSScriptRoot 'common.ps1'
if (Test-Path -LiteralPath $commonScript) {
    try {
        . $commonScript
        $serviceJson = Join-Path $StateRoot 'service.json'
        if (Test-Path -LiteralPath $serviceJson) {
            $config = Read-ServiceConfig $StateRoot
            Stop-ServiceProcessTree $config
        } else {
            Stop-ServiceProcessTree @{ Port = 3211; DataDir = (Join-Path $StateRoot 'data'); TaskName = 'WhatsAppERPOperations' }
        }
    } catch {}
}

# Ensure any orphaned node.exe or chrome.exe under the install root are terminated
Get-Process -Name 'node', 'chrome' -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and $_.Path -like "$InstallRoot*" } catch { $false }
} | ForEach-Object {
    try { & taskkill.exe /PID $_.Id /T /F | Out-Null } catch {}
}

# 6. Remove application releases directory (H2)
$releasesDir = Join-Path $InstallRoot 'releases'
if (Test-Path -LiteralPath $releasesDir) {
    Write-Host "Removing application binaries from $releasesDir..." -ForegroundColor Cyan
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            Remove-Item -LiteralPath $releasesDir -Recurse -Force -ErrorAction Stop
            break
        } catch {
            if ($attempt -eq 5) {
                Write-Warning "Could not remove all files in $releasesDir: $($_.Exception.Message)"
            } else {
                Start-Sleep -Seconds 1
            }
        }
    }
}

# 7. Clean transient locks from state root, preserving customer data, backups, and WhatsApp sessions
$lockFile = Join-Path $StateRoot 'data\runtime.lock'
if (Test-Path -LiteralPath $lockFile) { Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue }
$maintFile = Join-Path $StateRoot 'maintenance.flag'
if (Test-Path -LiteralPath $maintFile) { Remove-Item -LiteralPath $maintFile -Force -ErrorAction SilentlyContinue }

Write-Host "WhatsApp-ERP uninstallation helper completed successfully. Customer state preserved." -ForegroundColor Green

if (Test-Path -LiteralPath $logDir) {
    try { Stop-Transcript | Out-Null } catch {}
}

