param([string]$StateRoot="$env:ProgramData\WhatsApp-ERP")
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
$config=Read-ServiceConfig $StateRoot
Set-ServiceEnvironment $config
& $config.NodePath (Join-Path $config.ReleasePath 'dist\runtime\scripts\maintenance\preflight.js')
if($LASTEXITCODE -ne 0){throw 'Runtime dependency check failed'}
Invoke-Admin $config @('check')
$health=Invoke-RestMethod -Uri "http://127.0.0.1:$($config.Port)/healthz" -TimeoutSec 5
$health | Format-List
Get-ScheduledTask -TaskName $config.TaskName,($config.TaskName+'Backup') | Select-Object TaskName,State
Get-ScheduledTaskInfo -TaskName $config.TaskName | Select-Object LastRunTime,LastTaskResult
Write-Host "Logs: $(Join-Path $StateRoot 'logs'). SQL and WhatsApp readiness must also be checked in the UI."
