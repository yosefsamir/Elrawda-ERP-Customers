param([string]$StateRoot = "$env:ProgramData\WhatsApp-ERP")
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator

$config = Read-ServiceConfig $StateRoot
if (-not $config.PreviousRelease -or -not (Test-Path $config.PreviousRelease)) {
    throw 'No previous release recorded.'
}

$flag = Join-Path $StateRoot 'data\maintenance.flag'
[IO.File]::WriteAllText($flag, 'rollback')

try {
    # If server is running, stop it gracefully
    if (Test-Path (Join-Path $config.DataDir 'shutdown.json')) {
        Invoke-Admin $config @('stop')
    }

    $previousNode = Get-NodePath $config.PreviousRelease
    & $previousNode (Join-Path $config.PreviousRelease 'dist\runtime\scripts\maintenance\probe.js') $config.DataDir --readonly
    if ($LASTEXITCODE -ne 0) {
        throw 'Previous release cannot read the current schema. Maintenance remains enabled; no database was restored.'
    }

    $previous = $config.PreviousRelease
    $config.PreviousRelease = $config.ReleasePath
    $config.ReleasePath = $previous
    $config.NodePath = $previousNode
    Write-JsonFile (Join-Path $StateRoot 'service.json') $config

    Copy-Item (Join-Path $previous 'scripts\windows\launcher.ps1') (Join-Path $StateRoot 'launcher.ps1') -Force
    Copy-Item (Join-Path $previous 'scripts\windows\scheduled-backup.ps1') (Join-Path $StateRoot 'scheduled-backup.ps1') -Force

    Remove-Item $flag -Force
    Wait-Ready $config
    Write-Host "Previous release started successfully using current customer data. No database backup was restored." -ForegroundColor Green
} catch {
    throw "Rollback failed: $($_.Exception.Message)"
}
