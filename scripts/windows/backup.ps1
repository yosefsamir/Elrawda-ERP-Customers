param([string]$StateRoot = "$env:ProgramData\WhatsApp-ERP", [switch]$Offline, [string]$Label = 'manual')
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
$config = Read-ServiceConfig $StateRoot
$target = Join-Path $StateRoot ('backups\' + $Label + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
if ($Offline) {
    $flag=Join-Path $StateRoot 'data\maintenance.flag'
    if (Test-Path $flag) { throw 'Maintenance is already active.' }
    [IO.File]::WriteAllText($flag,'backup')
    Invoke-Admin $config @('stop')
    try { Invoke-Admin $config @('backup','--output',$target,'--offline') }
    finally { Remove-Item $flag }
    Wait-Ready $config
} else { Invoke-Admin $config @('backup','--output',$target) }
Write-Host "Backup: $target. Online backups include SQLite and the SQL encryption key; use -Offline to include WhatsApp authentication."
