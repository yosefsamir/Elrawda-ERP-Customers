param([string]$StateRoot = "$env:ProgramData\WhatsApp-ERP", [string]$InstallRoot = 'C:\WhatsApp-ERP')
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
$config = Read-ServiceConfig $StateRoot
$packageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Verify-Release $packageRoot
$version = (Get-Content (Join-Path $packageRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$target = Join-Path $InstallRoot "releases\$version"
if (Test-Path $target) { throw "Release already exists: $target. Use a new version or rollback.ps1." }
$stage = $target + '.staging-' + [guid]::NewGuid().ToString('N')
Copy-Release $packageRoot $stage
Install-Dependencies $stage $config.NodePath $config.CacheDir
Move-Item -LiteralPath $stage -Destination $target
$oldRelease = $config.ReleasePath
$flag = Join-Path $StateRoot 'maintenance.flag'
if (Test-Path $flag) { throw 'Maintenance is already active. Inspect the running maintenance operation first.' }
[IO.File]::WriteAllText($flag, 'update')
$backup = Join-Path $StateRoot ('backups\before-' + $version + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$stopped = $false
$switched = $false
try {
    Invoke-Admin $config @('stop')
    $stopped = $true
    Invoke-Admin $config @('backup','--output',$backup,'--offline')
    # Boot the new runtime against an isolated copy first, without starting its server/WhatsApp worker.
    $probe = Join-Path $StateRoot ('migration-probe-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $probe | Out-Null
    Copy-Item (Join-Path $backup 'app.sqlite') (Join-Path $probe 'app.sqlite')
    & $config.NodePath (Join-Path $target 'dist\runtime\scripts\maintenance\probe.js') $probe
    if ($LASTEXITCODE -ne 0) { throw 'Migration preflight failed; the live database has not been migrated.' }
    Remove-Item -LiteralPath $probe -Recurse -Force
    $config.PreviousRelease = $oldRelease
    $config.ReleasePath = $target
    Write-JsonFile (Join-Path $StateRoot 'service.json') $config
    $switched = $true
    Remove-Item $flag
    Wait-Ready $config
    Write-Host "Updated to $version. Backup: $backup. Verify SQL sync and WhatsApp readiness in the UI."
} catch {
    if (-not $stopped) { throw "Shutdown did not finish. Maintenance remains enabled. Inspect logs before resuming. $($_.Exception.Message)" }
    if (-not $switched) { Remove-Item $flag -ErrorAction SilentlyContinue }
    # After switching, never restore a DB automatically: remote effects may already have happened.
    throw "Update failed. Previous release: $oldRelease. Backup: $backup. Use rollback.ps1 after checking logs. $($_.Exception.Message)"
}
