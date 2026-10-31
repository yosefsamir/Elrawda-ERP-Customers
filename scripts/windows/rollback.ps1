param([string]$StateRoot = "$env:ProgramData\WhatsApp-ERP")
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
$config = Read-ServiceConfig $StateRoot
if (-not $config.PreviousRelease -or -not (Test-Path $config.PreviousRelease)) { throw 'No previous release recorded.' }
$flag = Join-Path $StateRoot 'maintenance.flag'
[IO.File]::WriteAllText($flag,'rollback')
# A crashed server has no runtime lock; if metadata is stale, verify process status before proceeding.
if (Test-Path (Join-Path $config.DataDir 'shutdown.json')) { Invoke-Admin $config @('stop') }
& $config.NodePath (Join-Path $config.PreviousRelease 'dist\runtime\scripts\maintenance\probe.js') $config.DataDir --readonly
if ($LASTEXITCODE -ne 0) { throw 'Previous release cannot read the current schema. Maintenance remains enabled; no database was restored.' }
$previous = $config.PreviousRelease
$config.PreviousRelease = $config.ReleasePath
$config.ReleasePath = $previous
Write-JsonFile (Join-Path $StateRoot 'service.json') $config
Remove-Item $flag
Wait-Ready $config
Write-Host 'Previous release started using current customer data. No database backup was restored.'
