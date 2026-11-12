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
if ($health.PSObject.Properties['geminiWorker'] -and $health.geminiWorker) {
    Write-Host '=== Gemini Worker Status ===' -ForegroundColor Cyan
    $health.geminiWorker | Format-List
    if ($health.geminiWorker.worker) {
        $health.geminiWorker.worker | Format-List
    }
}
$workerTask = Get-GeminiWorkerTaskName $config
$taskNames = @($config.TaskName, ($config.TaskName + 'Backup'), $workerTask)
Get-ScheduledTask -TaskName $taskNames -ErrorAction SilentlyContinue | Select-Object TaskName,State,@{Name='LogonType';Expression={$_.Principal.LogonType}},@{Name='UserId';Expression={$_.Principal.UserId}}
foreach ($t in @($config.TaskName, $workerTask)) {
    $info = Get-ScheduledTaskInfo -TaskName $t -ErrorAction SilentlyContinue
    if ($info) {
        [pscustomobject]@{ TaskName = $t; LastRunTime = $info.LastRunTime; LastTaskResult = $info.LastTaskResult }
    }
}
$bridgeExists = Test-Path -LiteralPath (Get-GeminiBridgeTokenPath $StateRoot)
$profileStateExists = Test-Path -LiteralPath (Join-Path (Get-GeminiWorkerRoot $StateRoot) 'profile\Local State')
$authStateExists = Test-Path -LiteralPath (Join-Path (Get-GeminiWorkerRoot $StateRoot) '.locks\auth-state.json')
Write-Host ("BridgeToken={0} ProfileLocalState={1} AuthState={2}" -f $bridgeExists, $profileStateExists, $authStateExists)
Write-Host "Logs: $(Join-Path $StateRoot 'logs'). SQL and WhatsApp readiness must also be checked in the UI."
