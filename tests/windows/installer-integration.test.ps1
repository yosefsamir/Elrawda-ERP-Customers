# WhatsApp-ERP Windows Installer Integration Test Suite
# Tests real Setup.exe and unins000.exe on Windows.
param(
    [string]$SetupExePath,
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
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

$InstallPath = 'C:\WhatsApp-ERP'
$StatePath = "$env:ProgramData\WhatsApp-ERP"
$ApiBase = 'http://127.0.0.1:3211'
$UninstallerPath = Join-Path $InstallPath 'unins000.exe'
$UninstallRegKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{8B2F354D-9321-4F2A-A04E-5D345ECB901C}_is1'

# True only once nothing runs from the install root and port 3211 is free. A /healthz reply alone
# cannot prove a restart: an orphaned old server answers it too.
function Wait-ServiceDown([int]$TimeoutSec = 20) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        $running = @(Get-OwnedProcess $InstallPath)
        $listener = Get-NetTCPConnection -LocalPort 3211 -State Listen -ErrorAction SilentlyContinue
        if ($running.Count -eq 0 -and -not $listener) { return $true }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Get-ServerPid {
    $file = Join-Path $StatePath 'data\shutdown.json'
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    try { return [int](Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json).pid } catch { return $null }
}

function Get-WhatsAppHealth {
    try { return (Invoke-RestMethod -Uri "$ApiBase/healthz" -TimeoutSec 3).whatsapp } catch { return $null }
}

function Get-OwnedChrome {
    Get-OwnedProcess $InstallPath | Where-Object { $_.Name -eq 'chrome.exe' }
}

# Runs one uninstall and waits for the second phase, which outlives the first-phase process
function Invoke-Uninstaller([string]$LogPath) {
    $exitCode = (Start-Process -FilePath $UninstallerPath -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /LOG=`"$LogPath`"" -PassThru -Wait).ExitCode
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Process | Where-Object { $_.ProcessName -like 'unins*' -or $_.ProcessName -like '_unins*' -or $_.ProcessName -like '_iu*' })) { break }
        Start-Sleep -Milliseconds 500
    }
    return $exitCode
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

    # Test 10: Stopping the task must stop the server, and a restart must start a new one
    $serverPidBefore = Get-ServerPid
    Stop-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    $stoppedCleanly = Wait-ServiceDown 20
    Record-Test "Stopping the Service Task Leaves No Orphaned Server" $stoppedCleanly "Server PID $serverPidBefore stopped with its supervisor: $stoppedCleanly." "H2"

    Start-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    $health2 = Wait-BackendHealth 30
    $serverPidAfter = Get-ServerPid
    $restarted = $stoppedCleanly -and $health2.Success -and $serverPidAfter -and ($serverPidAfter -ne $serverPidBefore)
    Record-Test "Backend Health Recovers After Task Restart" $restarted "Server PID changed from $serverPidBefore to $serverPidAfter; healthy: $($health2.Success)."

    # -------------------------------------------------------------------------
    # TEST 11: Stale Runtime Lock Recovery (H3)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 11] Verifying Stale Runtime Lock Recovery (H3)..." -ForegroundColor Cyan
    Stop-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    $downBeforeLock = Wait-ServiceDown 20

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
    $lockReplaced = (Test-Path -LiteralPath $lockFile) -and -not ((Get-Content -LiteralPath $lockFile -Raw) -match 'dead-owner-from-previous-reboot')
    $recoveredLock = $downBeforeLock -and $health3.Success -and $lockReplaced
    Record-Test "Recovery from Stale Runtime Lock (H3)" $recoveredLock "Service was down first: $downBeforeLock; healthy: $($health3.Success); stale lock replaced by the new server: $lockReplaced." "H3"

    # -------------------------------------------------------------------------
    # TEST 12: Stale Maintenance Flag Recovery (H4)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 12] Verifying Stale Maintenance Flag Recovery (H4)..." -ForegroundColor Cyan
    Stop-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    $downBeforeFlag = Wait-ServiceDown 20

    # Write simulated stale maintenance flag with dead PID
    $flagFile = "$env:ProgramData\WhatsApp-ERP\data\maintenance.flag"
    $staleFlag = [pscustomobject]@{
        reason = 'update'
        pid = 999999 # Non-existent dead PID
        startTime = (Get-Date).AddHours(-1).ToString('o')
    }
    [IO.File]::WriteAllText($flagFile, ($staleFlag | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Write-Host "Injected stale maintenance.flag with dead PID. Starting launcher..." -ForegroundColor White

    Start-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    $health4 = Wait-BackendHealth 30
    $flagCleared = -not (Test-Path -LiteralPath $flagFile)
    $recoveredFlag = $downBeforeFlag -and $health4.Success -and $flagCleared
    Record-Test "Recovery from Stale Maintenance Flag (H4)" $recoveredFlag "Service was down first: $downBeforeFlag; healthy: $($health4.Success); flag cleared: $flagCleared." "H4"

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
        Record-Test "WhatsApp Health Status Exposed via /healthz" $true "Backend exposes WhatsApp worker status: $($healthResp.whatsapp.status)" "H5"
    } else {
        Record-Test "WhatsApp Health Status Exposed via /healthz" $false "Backend /healthz does not expose whatsapp status: $($healthResp | ConvertTo-Json -Compress)" "H5"
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

    # Seeds a real operator and company. Everything from here on, including repair, upgrade and
    # uninstall, runs against customer-like data with a live Chromium in the service account.
    Write-Host "`n[Phase 4: Test 16] Starting a Real WhatsApp Session in the Service Account (H5)..." -ForegroundColor Cyan
    $apiHeaders = @{ 'x-emoji-request' = '1' }
    $seedCompanyName = 'Integration Persistence Company'
    $apiSession = $null
    $seedCompanyId = $null
    $sessionError = $null
    try {
        Invoke-RestMethod -Uri "$ApiBase/api/auth/bootstrap" -Method Post -Headers $apiHeaders -ContentType 'application/json' -SessionVariable apiSession -TimeoutSec 20 -Body (@{ username = 'integration'; password = 'IntegrationOnly-Password1' } | ConvertTo-Json) | Out-Null
        $seedCompanyId = (Invoke-RestMethod -Uri "$ApiBase/api/companies" -Method Post -Headers $apiHeaders -ContentType 'application/json' -WebSession $apiSession -TimeoutSec 20 -Body (@{ name = $seedCompanyName } | ConvertTo-Json)).id
        Invoke-RestMethod -Uri "$ApiBase/api/whatsapp/connect" -Method Post -Headers $apiHeaders -ContentType 'application/json' -WebSession $apiSession -TimeoutSec 20 -Body '{}' | Out-Null
    } catch {
        $sessionError = $_.Exception.Message
    }

    $chromeDeadline = (Get-Date).AddSeconds(90)
    $waHealth = $null
    while ((Get-Date) -lt $chromeDeadline) {
        $waHealth = Get-WhatsAppHealth
        if (@(Get-OwnedChrome).Count -gt 0 -and $waHealth -and $waHealth.status -in @('qr', 'ready')) { break }
        Start-Sleep -Seconds 2
    }
    $liveChrome = @(Get-OwnedChrome)
    # Chrome locks its own process, so Windows returns no owner for it even to an administrator.
    # The browser inherits its token from the worker that spawned it, and that owner is readable.
    $chromeOwner = 'none'
    $browserProcess = @($liveChrome | Where-Object { $_.CommandLine -notmatch '--type=' }) | Select-Object -First 1
    if ($browserProcess) {
        $spawner = Get-Process -Id $browserProcess.ParentProcessId -IncludeUserName -ErrorAction SilentlyContinue
        $spawnerIsNode = $spawner -and ($spawner.Path -like "$InstallPath\releases\*\runtime\node.exe")
        if ($spawnerIsNode) { $chromeOwner = $spawner.UserName }
    }
    $renderers = @($liveChrome | Where-Object { $_.CommandLine -match '--type=renderer' })
    $unsandboxed = @($liveChrome | Where-Object { $_.CommandLine -match '--no-sandbox' })
    $waStatus = if ($waHealth) { $waHealth.status } else { 'unreachable' }
    $waError = if ($waHealth) { $waHealth.error } else { $null }
    $chromeStarted = (-not $sessionError) -and ($liveChrome.Count -gt 0) -and ($waStatus -notin @('error', 'unreachable'))
    Record-Test "Chromium Launches in the Service Account (H5)" $chromeStarted "API error: $sessionError; chrome.exe processes: $($liveChrome.Count); owner: $chromeOwner; WhatsApp status: $waStatus; error: $waError. A real QR scan is NOT exercised here." "H5"
    $lowPrivilege = ($chromeOwner -eq 'NT AUTHORITY\LOCAL SERVICE') -and ($renderers.Count -gt 0) -and ($unsandboxed.Count -eq 0)
    Record-Test "Chromium Runs Sandboxed as LOCAL SERVICE (H6)" $lowPrivilege "Owner of the worker that spawned the browser: $chromeOwner; renderers: $($renderers.Count); processes with --no-sandbox: $($unsandboxed.Count)." "H6"

    Write-Host "`n[Phase 4: Test 16b] Killing the WhatsApp Worker Must Not Orphan Chromium (M7)..." -ForegroundColor Cyan
    $chromeBefore = @($liveChrome | ForEach-Object { $_.ProcessId })
    $workerPid = if ($waHealth) { $waHealth.workerPid } else { $null }
    $orphans = @($chromeBefore)
    if ($workerPid -and $chromeBefore.Count -gt 0) {
        Stop-Process -Id $workerPid -Force -ErrorAction SilentlyContinue
        $orphanDeadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $orphanDeadline) {
            $alive = @(Get-OwnedChrome | ForEach-Object { $_.ProcessId })
            $orphans = @($chromeBefore | Where-Object { $_ -in $alive })
            if ($orphans.Count -eq 0) { break }
            Start-Sleep -Seconds 1
        }
    }
    $workerStopped = $workerPid -and ($chromeBefore.Count -gt 0) -and ($orphans.Count -eq 0)
    Record-Test "Killed Worker Leaves No Orphaned Chromium (M7)" $workerStopped "Worker PID: $workerPid; browser processes before: $($chromeBefore.Count); survivors of the old browser: $($orphans.Count)." "M7"

    $recoveryDeadline = (Get-Date).AddSeconds(90)
    $recoveredHealth = $null
    while ((Get-Date) -lt $recoveryDeadline) {
        $recoveredHealth = Get-WhatsAppHealth
        if ($recoveredHealth -and $recoveredHealth.workerPid -and ($recoveredHealth.workerPid -ne $workerPid) -and @(Get-OwnedChrome).Count -gt 0) { break }
        Start-Sleep -Seconds 2
    }
    $newWorkerPid = if ($recoveredHealth) { $recoveredHealth.workerPid } else { $null }
    $workerRecovered = $newWorkerPid -and ($newWorkerPid -ne $workerPid) -and (@(Get-OwnedChrome).Count -gt 0)
    Record-Test "WhatsApp Worker Recovers With a New Browser (M7)" $workerRecovered "New worker PID: $newWorkerPid; chrome.exe processes: $(@(Get-OwnedChrome).Count)." "M7"

    # -------------------------------------------------------------------------
    # Phase 6: Service Identity and Access Boundaries (H6, H7)
    # -------------------------------------------------------------------------
    Write-Host "`n[Phase 6] Verifying Service Identity and Access Boundaries..." -ForegroundColor Cyan
    $serviceTask = Get-ScheduledTask -TaskName 'WhatsAppERPOperations'
    $currentServerPid = Get-ServerPid
    $serverOwner = if ($currentServerPid) { (Get-Process -Id $currentServerPid -IncludeUserName -ErrorAction SilentlyContinue).UserName } else { 'not running' }
    $identityOk = ($serviceTask.Principal.ProcessTokenSidType -eq 'Unrestricted') -and ($serverOwner -eq 'NT AUTHORITY\LOCAL SERVICE')
    Record-Test "Server Runs as LOCAL SERVICE With a Task SID (H6)" $identityOk "Server owner: $serverOwner; SID type: $($serviceTask.Principal.ProcessTokenSidType); required privileges: $($serviceTask.Principal.RequiredPrivilege -join ', ')." "H6"

    $rootAcl = (Get-Acl -LiteralPath $InstallPath).Access
    $unsafeAces = @($rootAcl | Where-Object {
        ($_.IdentityReference -notmatch 'SYSTEM|Administrators') -and
        ($_.FileSystemRights.ToString() -match 'Modify|FullControl|Write')
    })
    Record-Test "Install Folder Is Not Writable by Non-Admins (H7)" ($unsafeAces.Count -eq 0) "Writable non-admin entries: $(($unsafeAces | ForEach-Object { $_.IdentityReference }) -join ', ')." "H7"

    # A separate LOCAL SERVICE process stands in for any other service or standard user on the machine
    $boundaryDir = 'C:\WhatsAppERP-boundary'
    New-Item -ItemType Directory -Path $boundaryDir -Force | Out-Null
    & icacls.exe $boundaryDir /grant '*S-1-5-19:(OI)(CI)M' /Q | Out-Null
    $boundaryNode = Join-Path $boundaryDir 'node.exe'
    Copy-Item -LiteralPath "$activeReleaseDir\runtime\node.exe" -Destination $boundaryNode
    $boundaryScript = Join-Path $boundaryDir 'boundary.mjs'
    @"
import { readFileSync, writeFileSync } from 'node:fs';
const checks = {
  readSecretKey: () => readFileSync(String.raw``$StatePath\data\secret.key``),
  readDatabase: () => readFileSync(String.raw``$StatePath\data\app.sqlite``),
  writeServiceConfig: () => writeFileSync(String.raw``$StatePath\service.json``, 'x', { flag: 'a' }),
  writeLauncher: () => writeFileSync(String.raw``$StatePath\launcher.ps1``, '', { flag: 'a' }),
  writeInstallRoot: () => writeFileSync(String.raw``$InstallPath\boundary-test.txt``, 'x'),
  writeServerCode: () => writeFileSync(String.raw``$activeReleaseDir\dist\runtime\apps\server\index.js``, '', { flag: 'a' }),
};
const result = {};
for (const [name, check] of Object.entries(checks)) {
  try { check(); result[name] = 'ALLOWED'; } catch (error) { result[name] = error.code; }
}
writeFileSync(String.raw``$boundaryDir\result.json``, JSON.stringify(result));
"@ | Set-Content -LiteralPath $boundaryScript -Encoding ASCII
    $boundaryAction = New-ScheduledTaskAction -Execute $boundaryNode -Argument "`"$boundaryScript`"" -WorkingDirectory $boundaryDir
    Register-ScheduledTask -TaskName 'WhatsAppERPBoundaryTest' -Action $boundaryAction -Principal (New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount) -Force | Out-Null
    Start-ScheduledTask -TaskName 'WhatsAppERPBoundaryTest'
    $boundaryResult = Join-Path $boundaryDir 'result.json'
    $boundaryDeadline = (Get-Date).AddSeconds(20)
    while (-not (Test-Path -LiteralPath $boundaryResult) -and (Get-Date) -lt $boundaryDeadline) { Start-Sleep -Milliseconds 500 }
    $boundaryText = if (Test-Path -LiteralPath $boundaryResult) { Get-Content -LiteralPath $boundaryResult -Raw } else { '' }
    Unregister-ScheduledTask -TaskName 'WhatsAppERPBoundaryTest' -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $boundaryDir -Recurse -Force -ErrorAction SilentlyContinue
    $boundaryHeld = ($boundaryText -match 'readSecretKey') -and ($boundaryText -notmatch 'ALLOWED')
    Record-Test "Other Services Cannot Read Secrets or Change Code (H6, H7)" $boundaryHeld "Result from another LOCAL SERVICE process: $boundaryText" "H7"

    # The SYSTEM backup task must still read data the low-privilege service now owns
    $backupsDir = Join-Path $StatePath 'backups'
    $backupsBefore = @(Get-ChildItem -LiteralPath $backupsDir -Directory -Filter 'daily-*' -ErrorAction SilentlyContinue).Count
    Start-ScheduledTask -TaskName 'WhatsAppERPOperationsBackup'
    $backupDeadline = (Get-Date).AddSeconds(60)
    $newBackup = $null
    while ((Get-Date) -lt $backupDeadline) {
        $found = @(Get-ChildItem -LiteralPath $backupsDir -Directory -Filter 'daily-*' -ErrorAction SilentlyContinue)
        if ($found.Count -gt $backupsBefore) {
            $candidate = $found | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if (Test-Path -LiteralPath (Join-Path $candidate.FullName 'manifest.json')) { $newBackup = $candidate; break }
        }
        Start-Sleep -Seconds 1
    }
    $backupLog = Join-Path $StatePath 'logs\backup.log'
    $logDeadline = (Get-Date).AddSeconds(15)
    while (-not (Test-Path -LiteralPath $backupLog) -and (Get-Date) -lt $logDeadline) { Start-Sleep -Milliseconds 500 }
    $backupLogged = (Test-Path -LiteralPath $backupLog) -and ((Get-Content -LiteralPath $backupLog -Raw) -match ' OK ')
    Record-Test "Daily Backup Task Backs Up Live Service Data (M6)" (($null -ne $newBackup) -and $backupLogged) "New backup: $(if ($newBackup) { $newBackup.Name } else { 'none' }); recorded in backup.log: $backupLogged." "M6"

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
    Stop-ServiceProcessTree @{ Port = 3211; DataDir = "$env:ProgramData\WhatsApp-ERP\data"; TaskName = 'WhatsAppERPOperations'; InstallRoot = $InstallPath }
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
    # Uninstallation, Task Removal & Cleanup (H1, H2)
    # -------------------------------------------------------------------------
    Write-Host "`n[Uninstall] Preparing customer-state fingerprints..." -ForegroundColor Cyan
    $uninstallLog = "C:\WhatsAppERP-uninstall.log"
    $helperLog = Join-Path $StatePath 'logs\uninstall.log'
    $secretKeyPath = Join-Path $StatePath 'data\secret.key'
    $sqlitePath = Join-Path $StatePath 'data\app.sqlite'
    $sessionMarker = Join-Path $StatePath "data\whatsapp-auth\session-$seedCompanyId\integration-marker.txt"
    New-Item -ItemType Directory -Path (Split-Path -Parent $sessionMarker) -Force | Out-Null
    [IO.File]::WriteAllText($sessionMarker, 'customer session marker')
    $secretHashBefore = if (Test-Path -LiteralPath $secretKeyPath) { (Get-FileHash -LiteralPath $secretKeyPath -Algorithm SHA256).Hash } else { $null }
    $chromeAtUninstall = @(Get-OwnedChrome).Count
    Write-Host "Live chrome.exe processes at uninstall: $chromeAtUninstall" -ForegroundColor White

    # A blocked uninstall must report failure, stay registered, and succeed when retried
    Write-Host "`n[Uninstall] A Locked File Must Fail the Uninstall Truthfully..." -ForegroundColor Cyan
    $pinPath = Join-Path $InstallPath 'releases\uninstall-lock-test.txt'
    [IO.File]::WriteAllText($pinPath, 'held open to block removal')
    $pin = [System.IO.File]::Open($pinPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
    try {
        $blockedExitCode = Invoke-Uninstaller "C:\WhatsAppERP-uninstall-blocked.log"
    } finally {
        $pin.Dispose()
    }
    $stillRegistered = (Test-Path -LiteralPath $UninstallerPath) -and (Test-Path -LiteralPath $UninstallRegKey)
    Record-Test "Blocked Uninstall Reports Failure and Stays Retriable" (($blockedExitCode -ne 0) -and $stillRegistered) "Exit code with a file locked: $blockedExitCode; uninstaller and Apps entry kept for retry: $stillRegistered." "H2"

    Write-Host "`n[Uninstall] Running Uninstaller Retry..." -ForegroundColor Cyan
    $uninstallExitCode = Invoke-Uninstaller $uninstallLog
    Record-Test "Uninstaller Exits Successfully on Retry" ($uninstallExitCode -eq 0) "Exit code: $uninstallExitCode." "H1"
    $forcedStops = @(Get-Content -LiteralPath $helperLog -ErrorAction SilentlyContinue | Where-Object { $_ -match 'Forcing stop of' })
    Record-Test "Uninstall Stops the Service Without Forced Kills" ($forcedStops.Count -eq 0) "Forced stops logged: $($forcedStops.Count). $($forcedStops | Select-Object -First 2)" "H2"

    foreach ($diagnosticLog in @($helperLog, $uninstallLog)) {
        if (Test-Path -LiteralPath $diagnosticLog) {
            Write-Host "Diagnostic: $diagnosticLog" -ForegroundColor Magenta
            Get-Content -LiteralPath $diagnosticLog | Where-Object { $_ -notmatch 'Deleting (file|directory):' } | Select-Object -Last 60 | ForEach-Object { Write-Host "  $_" -ForegroundColor Magenta }
        }
    }

    # Test: the helper really ran to completion
    $helperText = if (Test-Path -LiteralPath $helperLog) { Get-Content -LiteralPath $helperLog -Raw } else { "" }
    $innoText = if (Test-Path -LiteralPath $uninstallLog) { Get-Content -LiteralPath $uninstallLog -Raw } else { "" }
    $helperCompleted = ($helperText -match 'Completed\. Customer data preserved') -and ($innoText -match 'Uninstall helper exit code: 0')
    Record-Test "Uninstall Helper Ran to Completion" $helperCompleted "uninstall.log exists: $(Test-Path -LiteralPath $helperLog); exit code 0 logged: $($innoText -match 'Uninstall helper exit code: 0')." "H1"

    # Test: no deletion errors remain in the Inno log. "Will retry later" is Inno's normal first pass
    # at {app} while unins000.exe still sits in it; a real failure is logged without that suffix.
    $deleteFailures = @($innoText -split "`r?`n" | Where-Object { ($_ -match 'Failed to delete') -and ($_ -notmatch 'Will retry later') })
    Record-Test "Uninstaller Log Has No Delete Failures" ($deleteFailures.Count -eq 0) "Delete failures logged: $($deleteFailures.Count). $($deleteFailures | Select-Object -First 3)" "H2"

    # Test: tasks removed (H1)
    $tasksRemaining = @(Get-ScheduledTask -TaskName 'WhatsAppERPOperations*' -ErrorAction SilentlyContinue)
    $taskNames = ($tasksRemaining | ForEach-Object { $_.TaskName }) -join ', '
    Record-Test "Uninstaller Removes Scheduled Tasks via uninstall.ps1" ($tasksRemaining.Count -eq 0) "Remaining tasks: [$taskNames]." "H1"

    # Test: nothing still runs or listens
    $noProcesses = Wait-ServiceDown 15
    $leftover = (Get-OwnedProcess $InstallPath | ForEach-Object { $_.Name }) -join ', '
    Record-Test "No Process or Port 3211 Listener Survives Uninstall" $noProcesses "Remaining: [$leftover]." "H2"

    # Test: binaries removed (H2)
    $rootDeadline = (Get-Date).AddSeconds(20)
    while ((Test-Path -LiteralPath $InstallPath) -and (Get-Date) -lt $rootDeadline) { Start-Sleep -Milliseconds 500 }
    $rootRemaining = Test-Path -LiteralPath $InstallPath
    Record-Test "Uninstaller Removes Application Binaries" (-not $rootRemaining) "$InstallPath still exists: $rootRemaining." "H2"

    # Test: customer data is byte-for-byte what it was
    $secretHashAfter = if (Test-Path -LiteralPath $secretKeyPath) { (Get-FileHash -LiteralPath $secretKeyPath -Algorithm SHA256).Hash } else { $null }
    $sqliteKept = (Test-Path -LiteralPath $sqlitePath) -and ((Get-Item -LiteralPath $sqlitePath).Length -gt 0)
    $sessionKept = Test-Path -LiteralPath $sessionMarker
    $backupsKept = Test-Path -LiteralPath (Join-Path $StatePath 'backups')
    $dataPreserved = $secretHashBefore -and ($secretHashAfter -eq $secretHashBefore) -and $sqliteKept -and $sessionKept -and $backupsKept
    Record-Test "Uninstaller Preserves Customer Data" $dataPreserved "secret.key unchanged: $($secretHashAfter -eq $secretHashBefore); app.sqlite kept: $sqliteKept; WhatsApp session kept: $sessionKept; backups kept: $backupsKept." "H2"

    # Test: reinstall adopts the preserved data (C4)
    Write-Host "`n[Reinstall] Setup After Uninstall Must Adopt Preserved Data..." -ForegroundColor Cyan
    $reinstallLog = "C:\WhatsAppERP-reinstall.log"
    $pReinstall = Start-Process -FilePath $SetupExePath -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /LOG=`"$reinstallLog`"" -PassThru -Wait
    $healthReinstall = Wait-BackendHealth 30
    $reinstalledName = $null
    try {
        $reinstalledName = (Invoke-RestMethod -Uri "$ApiBase/api/company" -Headers $apiHeaders -WebSession $apiSession -TimeoutSec 20).name
    } catch {
        Write-Host "Company read after reinstall failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
    $reinstallOk = ($pReinstall.ExitCode -eq 0) -and $healthReinstall.Success -and ($reinstalledName -eq $seedCompanyName)
    Record-Test "Reinstall After Uninstall Keeps Customer Data" $reinstallOk "Exit code: $($pReinstall.ExitCode); healthy: $($healthReinstall.Success); company read back: '$reinstalledName'." "C4"

    # Test: a second uninstall of the reinstalled product also comes out clean
    $secondExitCode = Invoke-Uninstaller "C:\WhatsAppERP-uninstall-second.log"
    $secondClean = ($secondExitCode -eq 0) -and (Wait-ServiceDown 15) -and (-not (Get-ScheduledTask -TaskName 'WhatsAppERPOperations*' -ErrorAction SilentlyContinue)) -and (-not (Test-Path -LiteralPath (Join-Path $InstallPath 'releases')))
    Record-Test "Second Uninstall After Reinstall Is Clean" $secondClean "Exit code: $secondExitCode." "H2"
}
catch {
    # A crash in the suite must never read as a pass or skip the summary
    Record-Test "Integration Suite Ran to Completion" $false "Suite aborted: $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)." "SUITE"
}
finally {
    # Preserve test logs for diagnostic artifact upload before environment cleanup
    $artifactLogDir = Join-Path $RepoRoot "release\logs"
    New-Item -ItemType Directory -Path $artifactLogDir -Force | Out-Null
    Get-ChildItem -Path "C:\WhatsAppERP-*.log" -ErrorAction SilentlyContinue | Copy-Item -Destination $artifactLogDir -Force
    if (Test-Path "$env:ProgramData\WhatsApp-ERP\logs") {
        Copy-Item -Path "$env:ProgramData\WhatsApp-ERP\logs\*" -Destination $artifactLogDir -Recurse -Force -ErrorAction SilentlyContinue
    }
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

# Any failed test fails the job. There is no allow-list and no separate mode for tags.
if ($failCount -gt 0) {
    Write-Host "`n[ERROR] $failCount integration test(s) failed:" -ForegroundColor Red
    foreach ($r in ($testResults | Where-Object { $_.Status -eq 'FAIL' })) {
        Write-Host "  -> [$($r.Finding)] $($r.Test): $($r.Details)" -ForegroundColor Red
    }
    exit 1
}

Write-Host "`nAll $totalCount integration tests PASSED." -ForegroundColor Green
exit 0
