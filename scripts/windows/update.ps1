param([string]$StateRoot = "$env:ProgramData\WhatsApp-ERP", [string]$InstallRoot = 'C:\WhatsApp-ERP')
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator

$config = Read-ServiceConfig $StateRoot
$packageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Verify-Release $packageRoot

$version = (Get-Content (Join-Path $packageRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$target = Join-Path $InstallRoot "releases\$version"
if (Test-Path $target) {
    throw "Release destination already exists: $target. Use a new version or run rollback.ps1."
}

# Stage new release and validate bundled runtime completely before touching live service
$stage = $target + '.staging-' + [guid]::NewGuid().ToString('N')
try {
    Write-Host "Staging release payload for version $version..." -ForegroundColor Cyan
    Copy-Release $packageRoot $stage
    Assert-ReleaseReady $stage
    Move-Item -LiteralPath $stage -Destination $target
} catch {
    if (Test-Path $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
}

$oldRelease = $config.ReleasePath
$targetNode = Get-NodePath $target
$flag = Join-Path $StateRoot 'maintenance.flag'
if (Test-Path $flag) {
    throw 'Maintenance mode is already active. Inspect the existing maintenance operation before updating.'
}

[IO.File]::WriteAllText($flag, 'update')
$backup = Join-Path $StateRoot ('backups\before-' + $version + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$stopped = $false
$switched = $false

try {
    Write-Host "Stopping current running service gracefully..." -ForegroundColor Cyan
    Invoke-Admin $config @('stop')
    $stopped = $true

    Write-Host "Creating consistent offline pre-update backup..." -ForegroundColor Cyan
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
    Write-JsonFile (Join-Path $StateRoot 'service.json') $config

    Copy-Item (Join-Path $target 'scripts\windows\launcher.ps1') (Join-Path $StateRoot 'launcher.ps1') -Force
    Copy-Item (Join-Path $target 'scripts\windows\scheduled-backup.ps1') (Join-Path $StateRoot 'scheduled-backup.ps1') -Force

    $switched = $true
    Remove-Item $flag -Force
    Wait-Ready $config
    Write-Host "Successfully updated to $version. Backup preserved at: $backup." -ForegroundColor Green
} catch {
    $err = $_.Exception.Message
    if (-not $switched) {
        Remove-Item $flag -Force -ErrorAction SilentlyContinue
        if ($stopped) {
            Start-ScheduledTask -TaskName $config.TaskName -ErrorAction SilentlyContinue
        }
        throw "Update aborted before activation. The existing release has been retained. Error: $err"
    } else {
        # Activation was performed, but server failed to become ready
        [IO.File]::WriteAllText($flag, 'recovery')
        $oldNode = Get-NodePath $oldRelease
        $canRollback = $false
        try {
            & $oldNode (Join-Path $oldRelease 'dist\runtime\scripts\maintenance\probe.js') $config.DataDir --readonly
            if ($LASTEXITCODE -eq 0) { $canRollback = $true }
        } catch {}

        if ($canRollback) {
            Write-Warning "New release failed readiness checks. Database schema is compatible with previous release. Automatically rolling back to $oldRelease..."
            $config.ReleasePath = $oldRelease
            $config.NodePath = $oldNode
            Write-JsonFile (Join-Path $StateRoot 'service.json') $config
            Copy-Item (Join-Path $oldRelease 'scripts\windows\launcher.ps1') (Join-Path $StateRoot 'launcher.ps1') -Force
            Remove-Item $flag -Force
            Wait-Ready $config
            throw "Update to $version failed during startup verification, but automatically rolled back to $oldRelease. Customer state preserved. Backup: $backup. Error: $err"
        } else {
            throw "Update to $version failed and schema cannot be safely read by previous release. Maintenance mode remains active to prevent data loss. Backup preserved at: $backup. Inspect logs at $(Join-Path $StateRoot 'logs'). Error: $err"
        }
    }
}
