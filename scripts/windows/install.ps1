param(
    [string]$InstallRoot = 'C:\WhatsApp-ERP',
    [string]$StateRoot = "$env:ProgramData\WhatsApp-ERP",
    [int]$Port = 3211,
    [switch]$Upgrade
)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator

$logDir = Join-Path $StateRoot 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'install.log'
try { Start-Transcript -Path $logFile -Append -Force | Out-Null } catch {}

try {
    $packageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    Verify-Release $packageRoot

    if (Test-Path (Join-Path $StateRoot 'service.json')) {
        if ($Upgrade) {
            Write-Host "Existing installation detected in $StateRoot. Running safe zero-data-loss upgrade..." -ForegroundColor Cyan
            & (Join-Path $PSScriptRoot 'update.ps1') -StateRoot $StateRoot -InstallRoot $InstallRoot
            exit $LASTEXITCODE
        }
        throw 'Already installed. Use update.ps1 or run install.ps1 with -Upgrade for updates; existing customer data has not been changed.'
    }

    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $Port is already in use. Please stop the conflicting service or choose an alternate port."
    }

    if (Test-Path (Join-Path $StateRoot 'data\app.sqlite')) {
        throw 'Existing unconfigured data detected. Configure or migrate it explicitly before installation.'
    }

    # Verify that the package contains the self-contained Node.js runtime and packaged Chromium
    $bundledNode = Get-NodePath $packageRoot
    if (-not (Test-Path -LiteralPath $bundledNode)) {
        throw "Bundled Node.js runtime not found in release package: $bundledNode"
    }

    $version = (Get-Content (Join-Path $packageRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $target = Join-Path $InstallRoot "releases\$version"
    if (Test-Path $target) {
        throw "Release destination already exists: $target"
    }

    # Staging with automatic cleanup on failure
    $stage = $target + '.staging-' + [guid]::NewGuid().ToString('N')
    try {
        Write-Host "Staging release payload to $stage..." -ForegroundColor Cyan
        Copy-Release $packageRoot $stage
        Assert-ReleaseReady $stage
    } catch {
        if (Test-Path $stage) {
            Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        }
        throw
    }

    # Create persistent state directory structure
    New-Item -ItemType Directory -Path (Join-Path $StateRoot 'data') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $StateRoot 'cache') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $StateRoot 'temp') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $StateRoot 'backups') -Force | Out-Null

    # Customer state contains SQL credentials and WhatsApp authentication. Allow SYSTEM and administrators only.
    & icacls.exe $StateRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not apply secure access control lists to the application state directory.'
    }

    # Move validated staging to final release path
    Move-Item -LiteralPath $stage -Destination $target

    $targetNode = Join-Path $target 'runtime\node.exe'
    $config = [pscustomobject]@{
        ReleasePath = $target
        PreviousRelease = ''
        NodePath = $targetNode
        DataDir = (Join-Path $StateRoot 'data')
        CacheDir = (Join-Path $StateRoot 'cache')
        Port = $Port
        TaskName = 'WhatsAppERPOperations'
    }

    Copy-Item (Join-Path $target 'scripts\windows\launcher.ps1') (Join-Path $StateRoot 'launcher.ps1') -Force
    Copy-Item (Join-Path $target 'scripts\windows\scheduled-backup.ps1') (Join-Path $StateRoot 'scheduled-backup.ps1') -Force
    Write-JsonFile (Join-Path $StateRoot 'service.json') $config

    # Register automatic startup Scheduled Task running under LocalSystem SID (S-1-5-18)
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $StateRoot 'launcher.ps1')`" -StateRoot `"$StateRoot`"" -WorkingDirectory $StateRoot
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount
    Register-ScheduledTask -TaskName $config.TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

    # Register daily backup task (03:00) with StartWhenAvailable to ensure missed backups run after boot
    $backupAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $StateRoot 'scheduled-backup.ps1')`" -StateRoot `"$StateRoot`""
    $backupTrigger = New-ScheduledTaskTrigger -Daily -At '03:00'
    $backupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    Register-ScheduledTask -TaskName ($config.TaskName + 'Backup') -Action $backupAction -Trigger $backupTrigger -Principal $principal -Settings $backupSettings -Force | Out-Null

    # Start service task and wait for HTTP readiness
    Start-ScheduledTask -TaskName $config.TaskName
    Wait-Ready $config
    Write-Host "Installed $version successfully. Open http://127.0.0.1:$Port on this computer to access the management interface." -ForegroundColor Green
} finally {
    try { Stop-Transcript | Out-Null } catch {}
}
