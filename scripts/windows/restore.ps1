param([Parameter(Mandatory=$true)][string]$BackupPath,[string]$StateRoot="$env:ProgramData\WhatsApp-ERP")
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
$config=Read-ServiceConfig $StateRoot
Invoke-Admin $config @('verify-backup','--input',$BackupPath)
$flag=Join-Path $StateRoot 'maintenance.flag'
if(Test-Path $flag){throw 'Maintenance is already active. Inspect it before restoring.'}
[IO.File]::WriteAllText($flag,'restore')
Invoke-Admin $config @('stop')
# Restoring historical state requires human reconciliation before live processing resumes.
Invoke-Admin $config @('restore','--input',$BackupPath)
Remove-Item $flag
Wait-Ready $config
Write-Host 'Restored. All companies are paused in Preview. Reconcile operations since the backup before enabling Live.'
