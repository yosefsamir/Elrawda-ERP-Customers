# WhatsApp-ERP Uninstallation Helper Script
# Run by the uninstaller at usUninstall, before Inno removes any file. Exits non-zero unless the
# service is stopped, its tasks are gone and its binaries are removed, so a failure stops the
# uninstall and can be retried. Customer data, backups and logs under StateRoot are never touched.
param(
    [string]$InstallRoot = 'C:\WhatsApp-ERP',
    [string]$StateRoot = "$env:ProgramData\WhatsApp-ERP"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$logDir = Join-Path $StateRoot 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
try { Start-Transcript -Path (Join-Path $logDir 'uninstall.log') -Append -Force | Out-Null } catch {}

$failures = [System.Collections.Generic.List[string]]::new()
$taskNames = @('WhatsAppERPOperationsBackup', 'WhatsAppERPOperations')

function Invoke-UninstallStep([string]$Name, [scriptblock]$Action) {
    Write-Host "[uninstall] $Name"
    try {
        & $Action
    } catch {
        $failures.Add("${Name}: $($_.Exception.Message)")
        Write-Warning "${Name} failed: $($_.Exception.Message)"
    }
}

. (Join-Path $PSScriptRoot 'common.ps1')

Invoke-UninstallStep 'Stop service' {
    Stop-ScheduledTask -TaskName $taskNames[0] -ErrorAction SilentlyContinue
    $config = @{ TaskName = $taskNames[1]; DataDir = (Join-Path $StateRoot 'data'); Port = 3211; InstallRoot = $InstallRoot }
    $serviceJson = Join-Path $StateRoot 'service.json'
    if (Test-Path -LiteralPath $serviceJson) {
        try {
            $saved = Read-ServiceConfig $StateRoot
            $config.ReleasePath = Get-ConfigProperty $saved 'ReleasePath'
            $config.CacheDir = Get-ConfigProperty $saved 'CacheDir'
            $config.Port = Get-ConfigProperty $saved 'Port' 3211
        } catch {
            Write-Warning "service.json is unreadable, stopping by install root only: $($_.Exception.Message)"
        }
    }
    Stop-ServiceProcessTree $config
}

Invoke-UninstallStep 'Unregister scheduled tasks' {
    foreach ($taskName in $taskNames) {
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            throw "Scheduled task is still registered: $taskName"
        }
    }
}

Invoke-UninstallStep 'Remove application binaries' {
    $releasesDir = Join-Path $InstallRoot 'releases'
    for ($attempt = 1; (Test-Path -LiteralPath $releasesDir) -and $attempt -le 10; $attempt++) {
        try {
            Remove-Item -LiteralPath $releasesDir -Recurse -Force
        } catch {
            Write-Warning "Attempt $attempt to remove $releasesDir failed: $($_.Exception.Message)"
            Start-Sleep -Seconds 2
        }
    }
    if (Test-Path -LiteralPath $releasesDir) { throw "Could not remove $releasesDir" }
}

# service.json must go so a later Setup is a fresh install that adopts the preserved data,
# not an upgrade of a release that no longer exists. Everything listed here is regenerated.
Invoke-UninstallStep 'Remove service registration from state folder' {
    $generated = @(
        'service.json', 'launcher.ps1', 'scheduled-backup.ps1', 'maintenance.flag', 'installing.flag',
        'data\runtime.lock', 'data\shutdown.json'
    )
    foreach ($name in $generated) {
        $path = Join-Path $StateRoot $name
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
}

$exitCode = 0
if ($failures.Count -gt 0) {
    $exitCode = 1
    foreach ($failure in $failures) { Write-Host "[uninstall] FAILED: $failure" -ForegroundColor Red }
} else {
    Write-Host '[uninstall] Completed. Customer data preserved.' -ForegroundColor Green
}

try { Stop-Transcript | Out-Null } catch {}
exit $exitCode
