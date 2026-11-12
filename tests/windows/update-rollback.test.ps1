# Executes the real update script with disposable files and mocked Windows
# services. Checks failure handling without installing or touching a live app.
param([string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path)
$ErrorActionPreference = 'Stop'
$base = Join-Path ([IO.Path]::GetTempPath()) ('gemini-update-tests-' + [guid]::NewGuid().ToString('N'))
$mockCommon = @'
function Assert-Administrator {}
function Write-InstallStage($Stage) {}
function Verify-Release($Path) {}
function Read-ServiceConfig($StateRoot) { Get-Content (Join-Path $StateRoot 'service.json') -Raw | ConvertFrom-Json }
function Write-JsonFile($Path, $Value) { $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path }
function Copy-Release($Source, $Target) { New-Item -ItemType Directory -Path $Target -Force | Out-Null; Copy-Item (Join-Path $Source '*') $Target -Recurse -Force }
function Assert-ReleaseReady($Path) {}
function Move-ItemWithRetry($Source, $Target) { Move-Item $Source $Target }
function Set-InstallRootAcl($Path) {}
function Set-StateAcl($Path, $Task) {}
function Get-GeminiWorkerUserName($Config) { 'worker-user' }
function Get-GeminiWorkerTaskName($Config) { 'worker-task' }
function Ensure-GeminiWorkerAccount($Root, $User) { [pscustomobject]@{ UserName=$User; Sid='test-sid'; Credential='test-credential' } }
function Ensure-GeminiWorkerBatchLogonRight($User, $Sid) {}
function Initialize-GeminiWorkerUserProfile($Root, $Credential, $Sid) {}
function Set-GeminiWorkerAcl($Root, $Task, $Sid) { $global:ElrawdaUpdateProbe.Calls.Add('acl:' + (Read-ServiceConfig $Root).ReleasePath) }
function Assert-ServiceBrowser($Release, $State) {}
function Get-NodePath($Release) { 'Invoke-FakeNode' }
function Invoke-FakeNode { $global:LASTEXITCODE = 0 }
function Stop-ServiceProcessTree($Config) { $global:ElrawdaUpdateProbe.Calls.Add('stop') }
function Invoke-Admin($Config, [string[]]$CommandArgs) {
    if ($global:ElrawdaUpdateProbe.Mode -eq 'backup') { throw 'injected backup failure' }
    if ($CommandArgs[0] -eq 'backup') {
        New-Item -ItemType Directory -Path $CommandArgs[2] -Force | Out-Null
        Set-Content (Join-Path $CommandArgs[2] 'app.sqlite') 'test database'
    }
}
function Register-ApplicationTasks($Config, $Root) {}
function Register-GeminiWorkerTask($Config, $Root, $Credential) {
    if ($global:ElrawdaUpdateProbe.Mode -eq 'registration') { throw 'injected registration failure' }
}
function Start-ScheduledTask($TaskName) { $global:ElrawdaUpdateProbe.Calls.Add('start:' + $TaskName) }
function Wait-Ready($Config, $TimeoutSec, [switch]$SkipGeminiWorkerCheck) {
    if ($Config.ReleasePath -ne $global:ElrawdaUpdateProbe.Old) { throw 'injected new release readiness failure' }
}
'@
try {
    foreach ($mode in @('backup', 'registration', 'readiness')) {
        $caseDir = Join-Path $base $mode
        $package = Join-Path $caseDir 'package'
        $install = Join-Path $caseDir 'install'
        $old = Join-Path $install 'releases\1.0.7'
        $state = Join-Path $caseDir 'state'
        foreach ($path in @((Join-Path $package 'scripts\windows'), (Join-Path $old 'scripts\windows'), (Join-Path $state 'data'), (Join-Path $state 'backups'))) {
            New-Item -ItemType Directory -Path $path -Force | Out-Null
        }
        foreach ($root in @($package, $old)) {
            foreach ($name in @('launcher.ps1', 'gemini-worker-launcher.ps1', 'scheduled-backup.ps1')) { Set-Content (Join-Path $root ('scripts\windows\' + $name)) '# fixture' }
        }
        Set-Content (Join-Path $package 'package.json') '{"version":"1.0.8"}'
        Set-Content (Join-Path $old 'package.json') '{"version":"1.0.7"}'
        $config = [pscustomobject]@{ ReleasePath=$old; PreviousRelease=''; NodePath='Invoke-FakeNode'; DataDir=(Join-Path $state 'data'); TaskName='main-task'; GeminiWorkerUser='worker-user'; GeminiWorkerTaskName='worker-task' }
        $config | ConvertTo-Json | Set-Content (Join-Path $state 'service.json')
        Set-Content (Join-Path $package 'scripts\windows\common.ps1') $mockCommon
        Copy-Item (Join-Path $RepoRoot 'scripts\windows\update.ps1') (Join-Path $package 'scripts\windows\update.ps1')
        $global:ElrawdaUpdateProbe = @{ Mode=$mode; Old=$old; Calls=[System.Collections.Generic.List[string]]::new() }
        $failed = $false
        try {
            & (Join-Path $package 'scripts\windows\update.ps1') -StateRoot $state -InstallRoot $install
        } catch {
            $failed = $true
            if ($_.Exception.Message -notmatch 'injected') { throw }
        }
        if (-not $failed) { throw "Expected $mode failure was not reported." }
        $after = Get-Content (Join-Path $state 'service.json') -Raw | ConvertFrom-Json
        if ($after.ReleasePath -ne $old) { throw "$mode failure left service.json pointing at the broken release." }
        foreach ($task in @('main-task', 'worker-task')) {
            if (-not $global:ElrawdaUpdateProbe.Calls.Contains('start:' + $task)) { throw "$mode failure did not restart $task." }
        }
        if ($mode -ne 'backup' -and -not $global:ElrawdaUpdateProbe.Calls.Contains('acl:' + $old)) { throw "$mode rollback did not restore the worker's config ACL." }
        if (Test-Path (Join-Path $state 'data\maintenance.flag')) { throw "$mode failure left a maintenance flag after safe recovery." }
        Write-Host "PASS: $mode failure preserves the old release and restarts both tasks."
    }
} finally {
    Remove-Variable -Name ElrawdaUpdateProbe -Scope Global -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
}
