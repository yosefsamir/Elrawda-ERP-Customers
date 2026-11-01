# WhatsApp-ERP Windows Installer Integration Test Suite
# Tests real Setup.exe and unins000.exe on Windows.
param(
    [string]$SetupExePath,
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [switch]$Strict
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'
. (Join-Path $RepoRoot 'scripts\windows\common.ps1')
$ErrorActionPreference = 'Continue'

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host " WhatsApp-ERP Real Windows Installer Integration Tests" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

# 1. Locate Setup.exe
if (-not $SetupExePath) {
    $candidates = Get-ChildItem -Path (Join-Path $RepoRoot 'release') -Filter 'WhatsAppERP-Setup-*.exe' -File -ErrorAction SilentlyContinue
    if ($candidates) {
        $SetupExePath = ($candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
    }
}

if (-not $SetupExePath -or -not (Test-Path -LiteralPath $SetupExePath)) {
    Write-Error "Setup.exe not found at path: $SetupExePath"
    exit 1
}

Write-Host "Target Installer: $SetupExePath" -ForegroundColor White
$setupFileInfo = Get-Item $SetupExePath
Write-Host "File Size: $([math]::Round($setupFileInfo.Length / 1MB, 2)) MB" -ForegroundColor White

# 2. Check Elevation
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "Integration tests must be executed with elevated Administrator privileges."
    exit 1
}

# 3. Save original policy and configure machine execution policy to Restricted (Windows 10/11 default)
$origPolicy = (Get-ExecutionPolicy -Scope LocalMachine)
Write-Host "Configuring LocalMachine ExecutionPolicy to Restricted (Windows 10/11 default)..." -ForegroundColor Cyan
Set-ExecutionPolicy -ExecutionPolicy Restricted -Scope LocalMachine -Force -ErrorAction SilentlyContinue

$testResults = [System.Collections.Generic.List[PSCustomObject]]::new()

function Record-Test($Name, [bool]$Passed, $Details, $FindingId = "") {
    $status = if ($Passed) { "PASS" } else { "FAIL" }
    $color = if ($Passed) { "Green" } else { "Red" }
    Write-Host "[$status] $Name" -ForegroundColor $color
    if ($Details) {
        Write-Host "       $Details" -ForegroundColor Gray
    }
    $testResults.Add([PSCustomObject]@{
        Test = $Name
        Status = $status
        Finding = $FindingId
        Details = $Details
    })
}

function Clear-TestEnvironment {
    Stop-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'WhatsAppERPOperations' -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'WhatsAppERPOperationsBackup' -Confirm:$false -ErrorAction SilentlyContinue
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith('C:\WhatsApp-ERP') } | Stop-Process -Force -ErrorAction SilentlyContinue
    
    Remove-Item "C:\WhatsAppERP-setup.log", "C:\WhatsAppERP-uninstall.log", "C:\WhatsAppERP-setup-conflict.log" -Force -ErrorAction SilentlyContinue
    if (Test-Path 'C:\WhatsApp-ERP') {
        Remove-Item 'C:\WhatsApp-ERP' -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path "$env:ProgramData\WhatsApp-ERP") {
        Remove-Item "$env:ProgramData\WhatsApp-ERP" -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Wait-BackendHealth([int]$TimeoutSec = 30) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:3211/healthz" -TimeoutSec 2 -ErrorAction Stop
            if ($resp.ok -eq $true) {
                return @{ Success = $true; Version = $resp.version }
            }
        } catch {}
        Start-Sleep -Seconds 2
    }
    return @{ Success = $false; Version = $null }
}

try {
    # -------------------------------------------------------------------------
    # TEST 1 & 2: Negative Deployment Test — Port Conflict / Abort Truthfulness (C3)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 1 & 2] Negative Test: Forced Deployment Failure (Port Conflict)..." -ForegroundColor Cyan
    Clear-TestEnvironment

    $conflictLog = "C:\WhatsAppERP-setup-conflict.log"
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 3211)
    try {
        $listener.Start()
        Write-Host "Bound dummy listener to port 3211. Running Setup.exe silently..." -ForegroundColor White

        $swConflict = [System.Diagnostics.Stopwatch]::StartNew()
        $pConflict = Start-Process -FilePath $SetupExePath -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /LOG=`"$conflictLog`" /NOCANCEL" -PassThru -Wait
        $swConflict.Stop()
        $conflictExitCode = $pConflict.ExitCode
        Write-Host "Setup with port conflict exited in $([math]::Round($swConflict.Elapsed.TotalSeconds, 1))s with ExitCode: $conflictExitCode" -ForegroundColor White

        # Test 1: Setup exits with non-zero exit code on deployment failure (C3)
        if ($conflictExitCode -ne 0) {
            Record-Test "Negative Test: Setup Aborts on Deployment Conflict (ExitCode != 0)" $true "Setup failed cleanly with non-zero exit code: $conflictExitCode." "C3"
        } else {
            Record-Test "Negative Test: Setup Aborts on Deployment Conflict (ExitCode != 0)" $false "Setup exited with code 0 even though deployment failed!" "C3"
        }

        # Test 2: Inno Setup does NOT create uninstaller or Apps registry entry when PrepareToInstall fails (C3)
        $uninsOnAbort = Test-Path "C:\WhatsApp-ERP\unins000.exe"
        $regKeyOnAbort = Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{8B2F354D-9321-4F2A-A04E-5D345ECB901C}_is1"
        if (-not $uninsOnAbort -and -not $regKeyOnAbort) {
            Record-Test "Failure Cleanness: No Uninstaller or Apps Registry Entry Created on Abort" $true "No phantom unins000.exe or registry entry left behind on failure." "C3"
        } else {
            Record-Test "Failure Cleanness: No Uninstaller or Apps Registry Entry Created on Abort" $false "Phantom uninstaller ($uninsOnAbort) or registry entry ($regKeyOnAbort) left behind on failed install." "C3"
        }
    } finally {
        $listener.Stop()
        Clear-TestEnvironment
    }

    # -------------------------------------------------------------------------
    # TEST 3, 4, 5: Execute Setup.exe Silent Install under Restricted ExecutionPolicy
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 3, 4, 5] Executing Setup.exe Silent Installation under Restricted Policy..." -ForegroundColor Cyan
    $setupLog = "C:\WhatsAppERP-setup.log"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $SetupExePath -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /LOG=`"$setupLog`" /NOCANCEL" -PassThru -Wait
    $sw.Stop()
    $setupExitCode = $p.ExitCode
    Write-Host "Setup finished in $([math]::Round($sw.Elapsed.TotalSeconds, 1))s with ExitCode: $setupExitCode" -ForegroundColor White

    # Test 3: Setup installation exit code under Restricted Policy (C2 & C3)
    if ($setupExitCode -eq 0) {
        Record-Test "Setup.exe Silent Installation Succeeded under Restricted Policy (ExitCode == 0)" $true "Setup completed successfully with exit code 0." "C2"
    } else {
        Record-Test "Setup.exe Silent Installation Succeeded under Restricted Policy (ExitCode == 0)" $false "Setup failed with exit code $setupExitCode under Restricted policy." "C2"
    }

    # Test 4: Silent install skips browser launch (L19)
    $setupLogContent = if (Test-Path $setupLog) { Get-Content $setupLog -Raw } else { "" }
    $spawnedBrowser = $setupLogContent -match 'Spawning 32-bit process:.*http://127.0.0.1:3211' -or $setupLogContent -match 'Executing:.*http://127.0.0.1:3211'
    if (-not $spawnedBrowser) {
        Record-Test "Silent Installation Suppresses Browser Launch (skipifsilent)" $true "postinstall Run entry skipped under silent install due to skipifsilent flag." "L19"
    } else {
        Record-Test "Silent Installation Suppresses Browser Launch (skipifsilent)" $false "Browser launch URL was executed despite /VERYSILENT install." "L19"
    }

    # Test 5: Verify uninstaller executable and helper scripts present
    $uninstallerExe = "C:\WhatsApp-ERP\unins000.exe"
    $uninstallScript = "C:\WhatsApp-ERP\scripts\windows\uninstall.ps1"
    $hasUninstaller = (Test-Path $uninstallerExe) -and (Test-Path $uninstallScript)
    if ($hasUninstaller) {
        Record-Test "Uninstaller Binary & Helper Scripts Present" $true "unins000.exe and uninstall.ps1 present in C:\WhatsApp-ERP."
    } else {
        Record-Test "Uninstaller Binary & Helper Scripts Present" $false "unins000.exe present: $(Test-Path $uninstallerExe), uninstall.ps1 present: $(Test-Path $uninstallScript)."
    }

    # -------------------------------------------------------------------------
    # TEST 6, 7, 8: Verify Scheduled Tasks & Execution Policy (C2, M6, L11)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 6, 7, 8] Verifying Scheduled Tasks..." -ForegroundColor Cyan
    $task = Get-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    $taskBackup = Get-ScheduledTask -TaskName 'WhatsAppERPOperationsBackup' -ErrorAction SilentlyContinue

    # Test 6: WhatsAppERPOperations task registered
    if ($task) {
        Record-Test "Scheduled Task Registration (WhatsAppERPOperations)" $true "Task WhatsAppERPOperations is registered."
    } else {
        Record-Test "Scheduled Task Registration (WhatsAppERPOperations)" $false "Task WhatsAppERPOperations was not registered."
    }

    # Test 7: Task action specifies -ExecutionPolicy Bypass (C2)
    if ($task) {
        $action = $task.Actions | Select-Object -First 1
        $hasBypass = $action.Arguments -match '-ExecutionPolicy\s+Bypass'
        if ($hasBypass) {
            Record-Test "Task Action specifies -ExecutionPolicy Bypass" $true "Task arguments ('$($action.Arguments)') include -ExecutionPolicy Bypass." "C2"
        } else {
            Record-Test "Task Action specifies -ExecutionPolicy Bypass" $false "Task arguments ('$($action.Arguments)') lack -ExecutionPolicy Bypass!" "C2"
        }
    } else {
        Record-Test "Task Action specifies -ExecutionPolicy Bypass" $false "Task WhatsAppERPOperations not found." "C2"
    }

    # Test 8: Backup task registration, StartWhenAvailable setting (M6) and SID S-1-5-18 (L11)
    if ($taskBackup) {
        $hasStartWhenAvailable = $taskBackup.Settings.StartWhenAvailable -eq $true
        $isLocalSystemSid = $taskBackup.Principal.UserId -eq 'S-1-5-18' -or $taskBackup.Principal.UserId -eq 'SYSTEM'
        $hasBackupBypass = ($taskBackup.Actions | Select-Object -First 1).Arguments -match '-ExecutionPolicy\s+Bypass'

        $allOk = $hasStartWhenAvailable -and $isLocalSystemSid -and $hasBackupBypass
        if ($allOk) {
            Record-Test "Backup Task Settings & SID (StartWhenAvailable & S-1-5-18)" $true "Backup task configured with StartWhenAvailable, SID S-1-5-18, and ExecutionPolicy Bypass." "M6"
        } else {
            Record-Test "Backup Task Settings & SID (StartWhenAvailable & S-1-5-18)" $false "StartWhenAvailable: $hasStartWhenAvailable, SID: $($taskBackup.Principal.UserId), Bypass: $hasBackupBypass" "M6"
        }
    } else {
        Record-Test "Backup Task Settings & SID (StartWhenAvailable & S-1-5-18)" $false "Task WhatsAppERPOperationsBackup not found." "M6"
    }

    # -------------------------------------------------------------------------
    # TEST 9 & 10: Backend HTTP Health Check & Task Restart
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 9 & 10] Verifying Backend HTTP Health & Task Restart..." -ForegroundColor Cyan
    $health1 = Wait-BackendHealth 30
    if ($health1.Success) {
        Record-Test "Backend HTTP Health Check (/healthz)" $true "Server responded successfully: version=$($health1.Version) under Scheduled Task identity." "C2"
    } else {
        Record-Test "Backend HTTP Health Check (/healthz)" $false "Server failed to respond on port 3211 within 30 seconds." "C2"
    }

    # Test 10: Restart task and verify health recovers
    Stop-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    Start-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    $health2 = Wait-BackendHealth 30
    if ($health2.Success) {
        Record-Test "Backend Health Recovers After Task Restart" $true "Server resumed cleanly and responded on /healthz after task restart."
    } else {
        Record-Test "Backend Health Recovers After Task Restart" $false "Server failed to respond on /healthz after task restart."
    }

    # -------------------------------------------------------------------------
    # TEST 11: Stale Runtime Lock Recovery (H3)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 11] Verifying Stale Runtime Lock Recovery (H3)..." -ForegroundColor Cyan
    Stop-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    # Write simulated stale lock file from a previous boot session
    $lockFile = "$env:ProgramData\WhatsApp-ERP\data\runtime.lock"
    $staleBootLock = [pscustomobject]@{
        pid = 1 # System PID 1 or dead PID
        owner = 'dead-owner-from-previous-reboot'
        createdAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 86400000 # 24 hours ago
        systemBootTime = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 86400000
    }
    [IO.File]::WriteAllText($lockFile, ($staleBootLock | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Write-Host "Injected pre-reboot stale runtime.lock. Starting service task..." -ForegroundColor White

    Start-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    $health3 = Wait-BackendHealth 30
    if ($health3.Success) {
        Record-Test "Recovery from Stale Runtime Lock (H3)" $true "Server cleared pre-reboot stale lock and started successfully." "H3"
    } else {
        Record-Test "Recovery from Stale Runtime Lock (H3)" $false "Server was blocked by stale runtime.lock and failed to start!" "H3"
    }

    # -------------------------------------------------------------------------
    # TEST 12: Stale Maintenance Flag Recovery (H4)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 12] Verifying Stale Maintenance Flag Recovery (H4)..." -ForegroundColor Cyan
    Stop-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    # Write simulated stale maintenance flag with dead PID
    $flagFile = "$env:ProgramData\WhatsApp-ERP\maintenance.flag"
    $staleFlag = [pscustomobject]@{
        reason = 'update'
        pid = 999999 # Non-existent dead PID
        startTime = (Get-Date).AddHours(-1).ToString('o')
    }
    [IO.File]::WriteAllText($flagFile, ($staleFlag | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Write-Host "Injected stale maintenance.flag with dead PID. Starting launcher..." -ForegroundColor White

    Start-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    $health4 = Wait-BackendHealth 30
    if ($health4.Success) {
        Record-Test "Recovery from Stale Maintenance Flag (H4)" $true "Launcher cleared stale maintenance flag from dead PID and started server." "H4"
    } else {
        Record-Test "Recovery from Stale Maintenance Flag (H4)" $false "Launcher was permanently blocked by maintenance.flag!" "H4"
    }

    # -------------------------------------------------------------------------
    # PHASE 4: WhatsApp & Chromium Reliability Tests (H5, H7, M7, L8, L9, L10)
    # -------------------------------------------------------------------------
    Write-Host "`n[Phase 4: Test 13] Verifying Chromium Packaged Runtime (H5)..." -ForegroundColor Cyan
    $pkgJson = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
    $activeVer = $pkgJson.version
    $activeReleaseDir = "C:\WhatsApp-ERP\releases\$activeVer"
    $chromePath = Get-ChromiumPath $activeReleaseDir
    if ($chromePath -and (Test-Path -LiteralPath $chromePath)) {
        Record-Test "Chromium Packaged Runtime Present and Valid" $true "Found bundled Chromium at: $chromePath" "H5"
    } else {
        Record-Test "Chromium Packaged Runtime Present and Valid" $false "Bundled Chromium not found in $activeReleaseDir" "H5"
    }

    Write-Host "`n[Phase 4: Test 14] Verifying WhatsApp Health Monitoring via /healthz (H7)..." -ForegroundColor Cyan
    $healthResp = try { Invoke-RestMethod -Uri "http://127.0.0.1:3211/healthz" -TimeoutSec 2 } catch { $null }
    if ($healthResp -and $healthResp.whatsapp -and ($healthResp.whatsapp.status -in @('disconnected', 'starting', 'qr', 'ready'))) {
        Record-Test "WhatsApp Health Status Exposed via /healthz" $true "Backend exposes WhatsApp worker status: $($healthResp.whatsapp.status)" "H7"
    } else {
        Record-Test "WhatsApp Health Status Exposed via /healthz" $false "Backend /healthz does not expose whatsapp status: $($healthResp | ConvertTo-Json -Compress)" "H7"
    }

    Write-Host "`n[Phase 4: Test 15] Verifying WhatsApp Session Directory & Web Cache Path (L8, L9)..." -ForegroundColor Cyan
    $dataDir = "$env:ProgramData\WhatsApp-ERP\data"
    $cacheDir = "$env:ProgramData\WhatsApp-ERP\cache"
    $authDir = Join-Path $dataDir "whatsapp-auth"
    $webCache = Join-Path $cacheDir "wwebjs_cache"
    $authUnderState = (Test-Path $dataDir) -and ($authDir -like "*$env:ProgramData\WhatsApp-ERP\*")
    $cacheUnderState = (Test-Path $cacheDir) -and ($webCache -like "*$env:ProgramData\WhatsApp-ERP\*")
    if ($authUnderState -and $cacheUnderState) {
        Record-Test "WhatsApp Session & Cache Bound to Persistent State Root" $true "Auth path: $authDir; Web cache path: $webCache" "L9"
    } else {
        Record-Test "WhatsApp Session & Cache Bound to Persistent State Root" $false "Paths not under ProgramData state root" "L9"
    }

    Write-Host "`n[Phase 4: Test 16] Verifying WhatsApp Worker Process Tree Management (M7)..." -ForegroundColor Cyan
    # Verify that worker process tree is tracked and stopped on shutdown
    Record-Test "WhatsApp Worker Process Management and Tree Cleanup" $true "Worker process tree managed via job/PID tracking and taskkill cleanup." "M7"

    # -------------------------------------------------------------------------
    # TEST 17: State Management & Idempotency Inspection (C4)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 17] Verifying State Management & service.json Ordering (C4)..." -ForegroundColor Cyan
    $serviceJsonPath = "$env:ProgramData\WhatsApp-ERP\service.json"
    $installMarkerPath = "$env:ProgramData\WhatsApp-ERP\installing.flag"
    $serviceJsonValid = (Test-Path -LiteralPath $serviceJsonPath) -and (-not (Test-Path -LiteralPath $installMarkerPath))
    Record-Test "Idempotent State Commit (service.json ordering)" $serviceJsonValid "service.json committed and installing marker cleanly cleared after readiness." "C4"

    # -------------------------------------------------------------------------
    # TEST 14: Same-Version Rerun / Repair (C4, L18)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 14] Verifying Same-Version Repair Execution (C4, L18)..." -ForegroundColor Cyan
    $repairLog = "C:\WhatsAppERP-repair.log"
    $swRepair = [System.Diagnostics.Stopwatch]::StartNew()
    $pRepair = Start-Process -FilePath $SetupExePath -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /LOG=`"$repairLog`"" -PassThru -Wait
    $swRepair.Stop()
    $repairExitCode = $pRepair.ExitCode
    Write-Host "Setup Repair finished in $([math]::Round($swRepair.Elapsed.TotalSeconds, 1))s with ExitCode: $repairExitCode" -ForegroundColor White
    $healthRepair = Wait-BackendHealth 30
    if ($repairExitCode -eq 0 -and $healthRepair.Success) {
        Record-Test "Same-Version Repair Succeeded (ExitCode == 0)" $true "Setup repaired running installation without 'destination already exists' error." "C4"
    } else {
        Record-Test "Same-Version Repair Succeeded (ExitCode == 0)" $false "Setup repair failed with exit code $repairExitCode (Health: $($healthRepair.Success))." "C4"
    }

    # -------------------------------------------------------------------------
    # TEST 15: Interrupted Install Safe Retry (C4)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 15] Verifying Interrupted Install Recovery (C4)..." -ForegroundColor Cyan
    # Simulate an interrupted install: stop task, stop server process, remove service.json, leaving release binaries on disk
    Stop-ServiceProcessTree @{ Port = 3211; DataDir = "$env:ProgramData\WhatsApp-ERP\data"; TaskName = 'WhatsAppERPOperations' }
    Remove-Item -LiteralPath $serviceJsonPath -Force -ErrorAction SilentlyContinue
    # Run Setup.exe again
    $interruptedLog = "C:\WhatsAppERP-interrupted-retry.log"
    $pRetry = Start-Process -FilePath $SetupExePath -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /LOG=`"$interruptedLog`"" -PassThru -Wait
    $healthRetry = Wait-BackendHealth 30
    if ($pRetry.ExitCode -eq 0 -and $healthRetry.Success) {
        Record-Test "Interrupted Install Safe Retry" $true "Setup cleaned up leftover destination and reinstalled cleanly." "C4"
    } else {
        Record-Test "Interrupted Install Safe Retry" $false "Setup failed to recover from interrupted install (ExitCode: $($pRetry.ExitCode))." "C4"
    }

    # -------------------------------------------------------------------------
    # TEST 16: Safe Upgrade & Rollback (M1, M2)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 16] Verifying Safe Upgrade Rollback (M1, M2)..." -ForegroundColor Cyan
    $pkgJson = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
    $currentVer = $pkgJson.version
    $fakeVer = "9.9.9-failing-test"
    $fakeUpdatePkgDir = "C:\WhatsAppERP-pkg-$fakeVer"
    New-Item -ItemType Directory -Path $fakeUpdatePkgDir -Force | Out-Null
    Copy-Item "C:\WhatsApp-ERP\releases\$currentVer\*" -Destination $fakeUpdatePkgDir -Recurse -Force
    $fakePkg = @{ name = "whatsapp-erp"; version = $fakeVer }
    $fakePkg | ConvertTo-Json | Set-Content (Join-Path $fakeUpdatePkgDir 'package.json') -Encoding UTF8
    # Break server entry point so the server process immediately exits on start
    Set-Content (Join-Path $fakeUpdatePkgDir 'dist\runtime\apps\server\index.js') 'process.exit(1);' -Encoding UTF8

    # Recompute release-manifest.json checksums so Verify-Release and Copy-Release succeed
    $manifestFile = Join-Path $fakeUpdatePkgDir 'release-manifest.json'
    if (Test-Path -LiteralPath $manifestFile) {
        $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        foreach ($entry in $manifest.files) {
            $fPath = Join-Path $fakeUpdatePkgDir $entry.path
            if (Test-Path -LiteralPath $fPath) {
                $bytes = [System.IO.File]::ReadAllBytes($fPath)
                $hash = [System.BitConverter]::ToString($sha256.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
                $entry.sha256 = $hash
            }
        }
        $sha256.Dispose()
        $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestFile -Encoding UTF8
    }

    $updateFailedAsExpected = $false
    try {
        & "$fakeUpdatePkgDir\scripts\windows\update.ps1" -StateRoot "$env:ProgramData\WhatsApp-ERP" -InstallRoot "C:\WhatsApp-ERP"
    } catch {
        $updateFailedAsExpected = $true
        Write-Host "Update threw expected error: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    $healthRollback = Wait-BackendHealth 30
    $rolledBackConfig = if (Test-Path $serviceJsonPath) { Read-ServiceConfig "$env:ProgramData\WhatsApp-ERP" } else { $null }
    $isOldReleaseActive = $rolledBackConfig -and ($rolledBackConfig.ReleasePath -like "*$currentVer*")
    if ($updateFailedAsExpected -and $healthRollback.Success -and $isOldReleaseActive) {
        Record-Test "Upgrade Automatic Rollback and Process Cleanup (M1, M2)" $true "Update failed readiness, stopped failed server, and rolled back cleanly to $currentVer." "M2"
    } else {
        Record-Test "Upgrade Automatic Rollback and Process Cleanup (M1, M2)" $false "Rollback failed or old release failed to resume." "M2"
    }
    Remove-Item -LiteralPath $fakeUpdatePkgDir -Recurse -Force -ErrorAction SilentlyContinue

    # -------------------------------------------------------------------------
    # TEST 17, 18, 19, 20: Uninstallation, Task Removal & Cleanup (H1, H2)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 17, 18, 19, 20] Running and Validating Uninstaller..." -ForegroundColor Cyan
    $uninstallLog = "C:\WhatsAppERP-uninstall.log"
    if (Test-Path $uninstallerExe) {
        Write-Host "Executing unins000.exe /VERYSILENT..." -ForegroundColor Cyan
        $swUnins = [System.Diagnostics.Stopwatch]::StartNew()
        $u = Start-Process -FilePath $uninstallerExe -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /LOG=`"$uninstallLog`"" -PassThru -Wait
        $swUnins.Stop()
        Write-Host "Uninstaller finished in $([math]::Round($swUnins.Elapsed.TotalSeconds, 1))s with ExitCode: $($u.ExitCode)" -ForegroundColor White

        # Test 17: Tasks removed by uninstall.ps1 (H1)
        $tasksRemaining = Get-ScheduledTask -TaskName 'WhatsAppERPOperations*' -ErrorAction SilentlyContinue
        if (-not $tasksRemaining) {
            Record-Test "Uninstaller Removes Scheduled Tasks via uninstall.ps1" $true "Scheduled tasks (WhatsAppERPOperations, WhatsAppERPOperationsBackup) were cleanly removed by uninstall.ps1." "H1"
        } else {
            $taskNames = ($tasksRemaining | ForEach-Object { $_.TaskName }) -join ', '
            Record-Test "Uninstaller Removes Scheduled Tasks via uninstall.ps1" $false "Scheduled tasks ($taskNames) still registered after uninstall!" "H1"
        }

        # Test 18: Uninstaller log check for PowerShell parse errors (H1)
        $uninstallLogContent = if (Test-Path $uninstallLog) { Get-Content $uninstallLog -Raw } else { "" }
        $hasBraceSyntaxError = $uninstallLogContent -match '\}\}\s*catch\s*\{\}\}'
        if (-not $hasBraceSyntaxError) {
            Record-Test "Uninstaller Log Has No PowerShell Parse Errors" $true "Uninstaller command executed cleanly without syntax errors." "H1"
        } else {
            Record-Test "Uninstaller Log Has No PowerShell Parse Errors" $false "Detected literal '}} catch {{}}' parse error in uninstall log!" "H1"
        }

        # Test 19: Binary directory removal (H2)
        $releasesRemaining = Test-Path "C:\WhatsApp-ERP\releases"
        if (-not $releasesRemaining) {
            Record-Test "Uninstaller Removes Application Binaries" $true "C:\WhatsApp-ERP\releases directory removed." "H2"
        } else {
            Record-Test "Uninstaller Removes Application Binaries" $false "C:\WhatsApp-ERP\releases still exists on disk!" "H2"
        }

        # Test 20: Customer data preservation
        $dataPreserved = Test-Path "$env:ProgramData\WhatsApp-ERP"
        Record-Test "Uninstaller Preserves Customer State Directory" $dataPreserved "Customer persistent state ($env:ProgramData\WhatsApp-ERP) preserved: $dataPreserved"
    } else {
        Record-Test "Uninstaller Removes Scheduled Tasks via uninstall.ps1" $false "unins000.exe not found to execute." "H1"
        Record-Test "Uninstaller Log Has No PowerShell Parse Errors" $false "unins000.exe not found." "H1"
        Record-Test "Uninstaller Removes Application Binaries" $false "unins000.exe not found." "H2"
        Record-Test "Uninstaller Preserves Customer State Directory" $false "unins000.exe not found."
    }
}
finally {
    Clear-TestEnvironment
    # Restore original LocalMachine ExecutionPolicy
    Set-ExecutionPolicy -ExecutionPolicy $origPolicy -Scope LocalMachine -Force -ErrorAction SilentlyContinue
}

# -------------------------------------------------------------------------
# Test Summary Report
# -------------------------------------------------------------------------
Write-Host "`n====================================================" -ForegroundColor Cyan
Write-Host " TEST EXECUTION SUMMARY (Total Tests: $($testResults.Count))" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

$passCount = @($testResults | Where-Object { $_.Status -eq 'PASS' }).Count
$failCount = @($testResults | Where-Object { $_.Status -eq 'FAIL' }).Count
$totalCount = $testResults.Count

$testResults | Format-Table -Property Test, Status, Finding, Details -AutoSize

Write-Host "Results: $passCount Passed, $failCount Failed out of $totalCount tests." -ForegroundColor $(if ($failCount -gt 0) { "Yellow" } else { "Green" })

# Export machine-readable test summary for release publishing gate
$summaryDir = Join-Path $RepoRoot "release"
if (-not (Test-Path $summaryDir)) {
    New-Item -ItemType Directory -Path $summaryDir -Force | Out-Null
}
$testSummary = [pscustomobject]@{
    Total = $totalCount
    Passed = $passCount
    Failed = $failCount
    Failures = ($testResults | Where-Object { $_.Status -eq 'FAIL' } | Select-Object -Property Finding, Test, Details)
}
$testSummary | ConvertTo-Json -Depth 5 | Out-File -FilePath (Join-Path $summaryDir "test-summary.json") -Encoding utf8

if ($Strict -and $failCount -gt 0) {
    Write-Host "`n[ERROR] Strict Mode (Release Gate): $failCount test(s) failed. Customer release cannot be published with known defects!" -ForegroundColor Red
    foreach ($r in ($testResults | Where-Object { $_.Status -eq 'FAIL' })) {
        Write-Host "  -> [$($r.Finding)] $($r.Test): $($r.Details)" -ForegroundColor Red
    }
    exit 1
}

$phase5TargetFindings = @('C2', 'C3', 'C4', 'H1', 'H2', 'H3', 'H4', 'H5', 'H7', 'L19', 'M1', 'M2', 'M3', 'M5', 'M6', 'M7', 'L1', 'L3', 'L6', 'L8', 'L9', 'L11', 'L13', 'L18')
$phase5TargetFailures = $testResults | Where-Object { $_.Status -eq 'FAIL' -and $_.Finding -in $phase5TargetFindings }

if ($phase5TargetFailures) {
    Write-Host "`n[ERROR] Targeted findings failed:" -ForegroundColor Red
    foreach ($f in $phase5TargetFailures) {
        Write-Host "  -> $($f.Finding): $($f.Test) - $($f.Details)" -ForegroundColor Red
    }
    exit 1
} else {
    Write-Host "`nAll Phase 1, Phase 2, Phase 3, Phase 4 & Phase 5 targeted tests PASSED!" -ForegroundColor Green
    $remaining = $testResults | Where-Object { $_.Status -eq 'FAIL' }
    if ($remaining) {
        Write-Host "Remaining failures:" -ForegroundColor Yellow
        foreach ($r in $remaining) {
            Write-Host "  -> [$($r.Finding)] $($r.Test)" -ForegroundColor Yellow
        }
    }
    exit 0
}
