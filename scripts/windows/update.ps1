param([string]$StateRoot = "$env:ProgramData\WhatsApp-ERP", [string]$InstallRoot = 'C:\WhatsApp-ERP')
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator

$config = Read-ServiceConfig $StateRoot
$packageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Write-InstallStage 'verify'
Verify-Release $packageRoot

$version = (Get-Content (Join-Path $packageRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$target = Join-Path $InstallRoot "releases\$version"
if (Test-Path -LiteralPath $target) {
    if ($config.ReleasePath -ne $target) {
        Write-Host "Detected leftover release destination from previously aborted update ($target). Cleaning up for clean update retry..." -ForegroundColor Yellow
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "Current active release is already $version."
        return
    }
}

# Stage new release and validate bundled runtime completely before touching live service
$stage = $target + '.staging-' + [guid]::NewGuid().ToString('N')
try {
    Write-Host "Staging release payload for version $version..." -ForegroundColor Cyan
    Write-InstallStage 'copy'
    Copy-Release $packageRoot $stage
    Write-InstallStage 'check'
    Assert-ReleaseReady $stage
    Move-ItemWithRetry $stage $target
} catch {
    if (Test-Path $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
}

# Machines installed before the low-privilege identity get their permissions corrected here
Set-InstallRootAcl $InstallRoot
Set-StateAcl $StateRoot $config.TaskName
$workerUser = Get-GeminiWorkerUserName $config
$workerTask = Get-GeminiWorkerTaskName $config
$workerAccount = $null
try {
    $workerAccount = Ensure-GeminiWorkerAccount $StateRoot $workerUser
    [void](Ensure-GeminiWorkerBatchLogonRight $workerAccount.UserName $workerAccount.Sid)
    Initialize-GeminiWorkerUserProfile $StateRoot $workerAccount.Credential $workerAccount.Sid
    Set-GeminiWorkerAcl $StateRoot $config.TaskName $workerAccount.Sid
} catch {
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
}
Write-InstallStage 'browser'
Assert-ServiceBrowser $target $StateRoot

$oldRelease = $config.ReleasePath
$targetNode = Get-NodePath $target
$flag = Join-Path $StateRoot 'data\maintenance.flag'
if (Test-Path $flag) {
    $existing = $null
    try {
        $existing = Get-Content -LiteralPath $flag -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {}
    if ($existing -and $existing.pid -and -not (Get-Process -Id $existing.pid -ErrorAction SilentlyContinue)) {
        Write-Host "Overriding stale maintenance flag from dead PID $($existing.pid)..." -ForegroundColor Yellow
        Remove-Item -LiteralPath $flag -Force -ErrorAction SilentlyContinue
    } else {
        throw 'Maintenance mode is already active. Inspect the existing maintenance operation before updating.'
    }
}

$flagData = [pscustomobject]@{
    reason = 'update'
    pid = $PID
    startTime = (Get-Date -Format o)
}
[IO.File]::WriteAllText($flag, ($flagData | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
$backup = Join-Path $StateRoot ('backups\before-' + $version + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$stopped = $false
$switched = $false

try {
    Write-Host "Stopping current running service gracefully..." -ForegroundColor Cyan
    $stopped = $true
    Stop-ServiceProcessTree $config

    Write-Host "Creating consistent offline pre-update backup..." -ForegroundColor Cyan
    Write-InstallStage 'backup'
    Invoke-Admin $config @('backup', '--output', $backup, '--offline')
    Invoke-Admin $config @('verify-backup', '--input', $backup)

    # Boot the new runtime against an isolated copy first, without starting its server/WhatsApp worker
    $probe = Join-Path $StateRoot ('migration-probe-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $probe | Out-Null
    Copy-Item (Join-Path $backup 'app.sqlite') (Join-Path $probe 'app.sqlite')
    try {
        & $targetNode (Join-Path $target 'dist\runtime\scripts\maintenance\probe.js') $probe
        if ($LASTEXITCODE -ne 0) {
            throw 'Migration preflight failed on isolated test copy; live database has not been touched.'
        }
    } finally {
        Remove-Item -LiteralPath $probe -Recurse -Force -ErrorAction SilentlyContinue
    }

    # Activate new release
    Write-Host "Activating new release $version..." -ForegroundColor Cyan
    $config.PreviousRelease = $oldRelease
    $config.ReleasePath = $target
    $config.NodePath = $targetNode
    if (-not $config.PSObject.Properties['GeminiWorkerUser']) {
        Add-Member -InputObject $config -NotePropertyName 'GeminiWorkerUser' -NotePropertyValue $workerUser -Force
    }
    if (-not $config.PSObject.Properties['GeminiWorkerTaskName']) {
        Add-Member -InputObject $config -NotePropertyName 'GeminiWorkerTaskName' -NotePropertyValue $workerTask -Force
    }
    # From the first persisted activation change onward, failures require rollback.
    # Task registration and ACL setup can throw before readiness is checked.
    $switched = $true
    Write-JsonFile (Join-Path $StateRoot 'service.json') $config

    Copy-Item (Join-Path $target 'scripts\windows\launcher.ps1') (Join-Path $StateRoot 'launcher.ps1') -Force
    Copy-Item (Join-Path $target 'scripts\windows\gemini-worker-launcher.ps1') (Join-Path $StateRoot 'gemini-worker-launcher.ps1') -Force
    Copy-Item (Join-Path $target 'scripts\windows\scheduled-backup.ps1') (Join-Path $StateRoot 'scheduled-backup.ps1') -Force
    Set-GeminiWorkerAcl $StateRoot $config.TaskName $workerAccount.Sid

    # Idempotently re-register scheduled tasks with latest settings (M1)
    Register-ApplicationTasks $config $StateRoot
    Register-GeminiWorkerTask $config $StateRoot $workerAccount.Credential

    Remove-Item $flag -Force
    Write-InstallStage 'service'
    Start-ScheduledTask -TaskName $config.TaskName -ErrorAction SilentlyContinue
    try {
        Start-ScheduledTask -TaskName $workerTask
    } catch {
        throw "Failed to start Gemini worker task '$workerTask': $($_.Exception.Message). $(Get-GeminiWorkerStartFailureDiagnostic $workerTask $StateRoot)"
    }
    Wait-Ready $config -TimeoutSec 60

    # Prune older releases (keep active release and previous release only) (L13)
    try {
        $releasesDir = Join-Path $InstallRoot 'releases'
        if (Test-Path -LiteralPath $releasesDir) {
            $allReleases = Get-ChildItem -LiteralPath $releasesDir -Directory
            foreach ($rel in $allReleases) {
                if ($rel.FullName -ne $config.ReleasePath -and $rel.FullName -ne $config.PreviousRelease) {
                    Write-Host "Pruning old release folder: $($rel.FullName)" -ForegroundColor Cyan
                    Remove-Item -LiteralPath $rel.FullName -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
        }
    } catch {}

    Write-Host "Successfully updated to $version. Backup preserved at: $backup." -ForegroundColor Green
} catch {
    $err = $_.Exception.Message
    if (-not $switched) {
        Remove-Item $flag -Force -ErrorAction SilentlyContinue
        if ($stopped) {
            Start-ScheduledTask -TaskName $config.TaskName -ErrorAction SilentlyContinue
            Start-ScheduledTask -TaskName $workerTask -ErrorAction SilentlyContinue
        }
        throw "Update aborted before activation. The existing release has been retained. Error: $err"
    } else {
        # Activation was performed, but server failed to become ready
        [IO.File]::WriteAllText($flag, (([pscustomobject]@{ reason = 'recovery'; pid = $null; startTime = (Get-Date -Format o) }) | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
        $oldNode = Get-NodePath $oldRelease
        $canRollback = $false
        try {
            & $oldNode (Join-Path $oldRelease 'dist\runtime\scripts\maintenance\probe.js') $config.DataDir --readonly
            if ($LASTEXITCODE -eq 0) { $canRollback = $true }
        } catch {}

        if ($canRollback) {
            Write-Warning "New release failed readiness checks. Database schema is compatible with previous release. Automatically rolling back to $oldRelease..."
            # Stop failed new release server process tree before switching back (M2)
            Stop-ServiceProcessTree $config
            $config.ReleasePath = $oldRelease
            $config.NodePath = $oldNode
            Write-JsonFile (Join-Path $StateRoot 'service.json') $config
            Copy-Item (Join-Path $oldRelease 'scripts\windows\launcher.ps1') (Join-Path $StateRoot 'launcher.ps1') -Force
            Copy-Item (Join-Path $oldRelease 'scripts\windows\scheduled-backup.ps1') (Join-Path $StateRoot 'scheduled-backup.ps1') -Force
            $oldWorkerLauncher = Join-Path $oldRelease 'scripts\windows\gemini-worker-launcher.ps1'
            if (Test-Path -LiteralPath $oldWorkerLauncher) {
                Copy-Item $oldWorkerLauncher (Join-Path $StateRoot 'gemini-worker-launcher.ps1') -Force
                # Write-JsonFile replaces service.json and loses its explicit worker ACE.
                Set-GeminiWorkerAcl $StateRoot $config.TaskName $workerAccount.Sid
            } else {
                Unregister-ScheduledTask -TaskName $workerTask -Confirm:$false -ErrorAction SilentlyContinue
            }
            Remove-Item $flag -Force
            # Clean up the aborted release folder so future update retry works cleanly (C4)
            Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
            Start-ScheduledTask -TaskName $config.TaskName -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $oldWorkerLauncher) {
                Start-ScheduledTask -TaskName $workerTask -ErrorAction SilentlyContinue
                Wait-Ready $config -TimeoutSec 45
            } else {
                Wait-Ready $config -TimeoutSec 25 -SkipGeminiWorkerCheck
            }
            throw "Update to $version failed during startup verification, but automatically rolled back to $oldRelease. Customer state preserved. Backup: $backup. Error: $err"
        } else {
            throw "Update to $version failed and schema cannot be safely read by previous release. Maintenance mode remains active to prevent data loss. Backup preserved at: $backup. Inspect logs at $(Join-Path $StateRoot 'logs'). Error: $err"
        }
    }
}
