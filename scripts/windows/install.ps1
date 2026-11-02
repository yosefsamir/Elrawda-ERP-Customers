param(
    [string]$InstallRoot = 'C:\WhatsApp-ERP',
    [string]$StateRoot = "$env:ProgramData\WhatsApp-ERP",
    [int]$Port = 3211,
    [switch]$Upgrade,
    [switch]$Repair
)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator

$logDir = Join-Path $StateRoot 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'install.log'
try { Start-Transcript -Path $logFile -Append -Force | Out-Null } catch {}

try {
    $packageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    Write-InstallStage 'verify'
    Verify-Release $packageRoot

    $version = (Get-Content (Join-Path $packageRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $target = Join-Path $InstallRoot "releases\$version"
    $targetNode = Join-Path $target 'runtime\node.exe'
    $serviceJsonPath = Join-Path $StateRoot 'service.json'

    # Lock the install root before any code is copied into it or run from it (H7)
    Set-InstallRootAcl $InstallRoot

    # Check for existing committed service.json
    if (Test-Path -LiteralPath $serviceJsonPath) {
        $existingConfig = Read-ServiceConfig $StateRoot
        $installedVersion = ''
        if (Test-Path (Join-Path $existingConfig.ReleasePath 'package.json')) {
            $installedVersion = (Get-Content (Join-Path $existingConfig.ReleasePath 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
        }

        # Determine mode: Upgrade vs Same-Version Repair
        if ($Upgrade -or ($installedVersion -and $version -ne $installedVersion)) {
            Write-Host "Existing installation (v$installedVersion) detected. Running zero-data-loss upgrade to v$version..." -ForegroundColor Cyan
            & (Join-Path $PSScriptRoot 'update.ps1') -StateRoot $StateRoot -InstallRoot $InstallRoot
            exit $LASTEXITCODE
        }

        # Same-version repair path (C4 & L18)
        Write-Host "Repairing existing installation of version $version in $InstallRoot..." -ForegroundColor Cyan
        Stop-ServiceProcessTree $existingConfig

        # Stage and validate
        $stage = $target + '.staging-' + [guid]::NewGuid().ToString('N')
        try {
            Write-Host "Staging release payload to $stage..." -ForegroundColor Cyan
            Write-InstallStage 'copy'
            Copy-Release $packageRoot $stage
            Write-InstallStage 'check'
            Assert-ReleaseReady $stage
            Copy-Release $stage $target
        } finally {
            if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
        }

        Set-StateAcl $StateRoot $existingConfig.TaskName
        Write-InstallStage 'browser'
        Assert-ServiceBrowser $target $StateRoot

        # Refresh launcher and backup scripts
        Copy-Item (Join-Path $target 'scripts\windows\launcher.ps1') (Join-Path $StateRoot 'launcher.ps1') -Force
        Copy-Item (Join-Path $target 'scripts\windows\scheduled-backup.ps1') (Join-Path $StateRoot 'scheduled-backup.ps1') -Force

        # Idempotently re-register scheduled tasks (M1)
        Register-ApplicationTasks $existingConfig $StateRoot

        # Verify service readiness
        Write-InstallStage 'service'
        Start-ScheduledTask -TaskName $existingConfig.TaskName -ErrorAction SilentlyContinue
        Wait-Ready $existingConfig
        Write-Host "Repaired WhatsApp-ERP version $version successfully. Customer data preserved." -ForegroundColor Green
        exit 0
    }

    # Fresh install or retry after an interrupted / failed install
    # 1. Clean up any leftover release directory from an aborted attempt (C4)
    if (Test-Path -LiteralPath $target) {
        Write-Host "Leftover release destination from interrupted install detected ($target). Re-staging cleanly..." -ForegroundColor Yellow
        Stop-ServiceProcessTree @{ InstallRoot = $InstallRoot; DataDir = (Join-Path $StateRoot 'data'); TaskName = 'WhatsAppERPOperations'; Port = $Port }
        Remove-Item -LiteralPath $target -Recurse -Force
    }

    # 2. Port conflict check (M4)
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $Port is already in use by another process. Please stop the conflicting service before installing."
    }

    # 3. Bundled Node verification
    $bundledNode = Get-NodePath $packageRoot
    if (-not (Test-Path -LiteralPath $bundledNode)) {
        throw "Bundled Node.js runtime not found in release package: $bundledNode"
    }

    # 4. Staging with automatic cleanup on failure (M3)
    $stage = $target + '.staging-' + [guid]::NewGuid().ToString('N')
    try {
        Write-Host "Staging release payload to $stage..." -ForegroundColor Cyan
        Write-InstallStage 'copy'
        Copy-Release $packageRoot $stage
        Write-InstallStage 'check'
        Assert-ReleaseReady $stage
        Copy-Release $stage $target
    } finally {
        if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    }

    # 5. Create persistent state directory structure (preserve existing customer data if reinstalling)
    Set-StateAcl $StateRoot 'WhatsAppERPOperations'
    Write-InstallStage 'browser'
    Assert-ServiceBrowser $target $StateRoot

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

    # Write installing marker to track active deployment
    $installMarker = Join-Path $StateRoot 'installing.flag'
    [IO.File]::WriteAllText($installMarker, 'installing', [Text.UTF8Encoding]::new($false))

    # Provision provisional service.json for launcher startup
    Write-JsonFile $serviceJsonPath $config

    # Register scheduled tasks idempotently
    Register-ApplicationTasks $config $StateRoot

    # Start service task and wait for HTTP readiness
    Write-InstallStage 'service'
    Start-ScheduledTask -TaskName $config.TaskName
    try {
        Wait-Ready $config
    } catch {
        # CRITICAL C4 FIX: If readiness verification fails, rollback service.json and stop task
        # so this failed attempt does not leave an unverified service.json behind!
        Write-Host "Deployment verification failed. Rolling back provisional service.json..." -ForegroundColor Red
        try { Stop-ServiceProcessTree $config } catch { Write-Warning $_.Exception.Message }
        foreach ($taskName in @($config.TaskName, ($config.TaskName + 'Backup'))) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $serviceJsonPath -Force -ErrorAction SilentlyContinue
        throw
    }

    # Readiness verified successfully! Remove installing marker.
    Remove-Item -LiteralPath $installMarker -Force -ErrorAction SilentlyContinue
    Write-Host "Installed $version successfully. Open http://127.0.0.1:$Port on this computer to access the management interface." -ForegroundColor Green
} finally {
    try { Stop-Transcript | Out-Null } catch {}
}
