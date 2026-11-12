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
$taskNames = @('WhatsAppERPOperationsBackup', 'WhatsAppERPOperations', 'WhatsAppERPGeminiWorker')
$workerUserName = 'WhatsAppERPGemini'

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
            $savedWorkerUser = Get-ConfigProperty $saved 'GeminiWorkerUser'
            if ($savedWorkerUser) { $workerUserName = [string]$savedWorkerUser }
            $savedWorkerTask = Get-ConfigProperty $saved 'GeminiWorkerTaskName'
            if ($savedWorkerTask) { $taskNames = @('WhatsAppERPOperationsBackup', 'WhatsAppERPOperations', [string]$savedWorkerTask) }
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
# Dedicated Gemini worker account, DPAPI credential, and browser profile are cleaned up
# here while preserving customer data\, backups\, and logs\.
Invoke-UninstallStep 'Remove service registration and Gemini worker account' {
    $generated = @(
        'service.json', 'launcher.ps1', 'gemini-worker-launcher.ps1', 'scheduled-backup.ps1',
        'gemini-bridge.json', 'installing.flag', 'data\maintenance.flag', 'data\runtime.lock', 'data\shutdown.json'
    )
    foreach ($name in $generated) {
        $path = Join-Path $StateRoot $name
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }

    $workerRoot = Join-Path $StateRoot 'gemini-worker'
    if (Test-Path -LiteralPath $workerRoot) {
        Remove-Item -LiteralPath $workerRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    $workerUser = Get-LocalUser -Name $workerUserName -ErrorAction SilentlyContinue
    if ($workerUser) {
        $workerSid = $workerUser.SID.Value
        Remove-LocalUser -Name $workerUserName -ErrorAction SilentlyContinue
        if ($workerSid) {
            $profileObj = Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue |
                Where-Object { $_.SID -eq $workerSid } |
                Select-Object -First 1
            if ($profileObj) {
                Remove-CimInstance -InputObject $profileObj -ErrorAction SilentlyContinue
            }
        }
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
