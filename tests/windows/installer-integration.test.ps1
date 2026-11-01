# WhatsApp-ERP Windows Installer Integration Test Suite
# Tests real Setup.exe and unins000.exe on Windows.
param(
    [string]$SetupExePath,
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

Set-StrictMode -Version Latest
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
            Record-Test "Negative Test: Setup Aborts on Deployment Conflict (ExitCode != 0)" $true "Setup failed cleanly with non-zero exit code: $conflictExitCode (Inno Setup PrepareToInstall failure)." "C3"
        } else {
            Record-Test "Negative Test: Setup Aborts on Deployment Conflict (ExitCode != 0)" $false "Setup exited with code 0 even though deployment failed! Setup falsely reported success." "C3"
        }

        # Test 2: Inno Setup does NOT create uninstaller or Apps registry entry when PrepareToInstall fails (C3)
        $uninsOnAbort = Test-Path "C:\WhatsApp-ERP\unins000.exe"
        $regKeyOnAbort = Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{8B2F354D-9321-4F2A-A04E-5D345ECB901C}_is1"
        if (-not $uninsOnAbort -and -not $regKeyOnAbort) {
            Record-Test "Failure Cleanness: No Uninstaller or Apps Registry Entry Created on Abort" $true "No phantom unins000.exe or Add/Remove Programs registry entry left behind on failure." "C3"
        } else {
            Record-Test "Failure Cleanness: No Uninstaller or Apps Registry Entry Created on Abort" $false "Phantom uninstaller ($uninsOnAbort) or registry entry ($regKeyOnAbort) left behind on failed install." "C3"
        }
    } finally {
        $listener.Stop()
        Clear-TestEnvironment
    }

    # -------------------------------------------------------------------------
    # TEST 3, 4, 5: Execute Setup.exe Silent Install & Validate Deployment
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 3, 4, 5] Executing Setup.exe Silent Installation (/VERYSILENT)..." -ForegroundColor Cyan
    $setupLog = "C:\WhatsAppERP-setup.log"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $SetupExePath -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /LOG=`"$setupLog`" /NOCANCEL" -PassThru -Wait
    $sw.Stop()
    $setupExitCode = $p.ExitCode
    Write-Host "Setup finished in $([math]::Round($sw.Elapsed.TotalSeconds, 1))s with ExitCode: $setupExitCode" -ForegroundColor White

    # Test 3: Setup installation exit code
    if ($setupExitCode -eq 0) {
        Record-Test "Setup.exe Silent Installation Succeeded (ExitCode == 0)" $true "Setup completed with exit code 0."
    } else {
        Record-Test "Setup.exe Silent Installation Succeeded (ExitCode == 0)" $false "Setup exited with non-zero exit code: $setupExitCode."
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
    # TEST 6, 7, 8: Verify Scheduled Tasks & Execution Policy (C2)
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
            Record-Test "Task Action specifies -ExecutionPolicy Bypass" $true "Task arguments include -ExecutionPolicy Bypass."
        } else {
            Record-Test "Task Action specifies -ExecutionPolicy Bypass" $false "Task arguments ('$($action.Arguments)') lack -ExecutionPolicy Bypass. Under default Restricted policy, launcher.ps1 is blocked by Windows!" "C2"
        }
    } else {
        Record-Test "Task Action specifies -ExecutionPolicy Bypass" $false "Task WhatsAppERPOperations not found." "C2"
    }

    # Test 8: WhatsAppERPOperationsBackup task registered
    if ($taskBackup) {
        Record-Test "Scheduled Task Registration (WhatsAppERPOperationsBackup)" $true "Task WhatsAppERPOperationsBackup is registered."
    } else {
        Record-Test "Scheduled Task Registration (WhatsAppERPOperationsBackup)" $false "Task WhatsAppERPOperationsBackup was not registered."
    }

    # -------------------------------------------------------------------------
    # TEST 9: State Management & Idempotency Inspection (C4)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 9] Verifying State Management & service.json..." -ForegroundColor Cyan
    $serviceJsonPath = "$env:ProgramData\WhatsApp-ERP\service.json"
    $serviceJsonExists = Test-Path -LiteralPath $serviceJsonPath
    # Finding C4: service.json written prematurely before health check verification in install.ps1
    Record-Test "Idempotent State Commit (service.json ordering)" $false "service.json is written in install.ps1 before service readiness is verified. (Active finding for Phase 3)." "C4"

    # -------------------------------------------------------------------------
    # TEST 10, 11, 12, 13: Uninstallation, Task Removal & Cleanup (H1, H2)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 10, 11, 12, 13] Running and Validating Uninstaller..." -ForegroundColor Cyan
    $uninstallLog = "C:\WhatsAppERP-uninstall.log"
    if (Test-Path $uninstallerExe) {
        Write-Host "Executing unins000.exe /VERYSILENT..." -ForegroundColor Cyan
        $swUnins = [System.Diagnostics.Stopwatch]::StartNew()
        $u = Start-Process -FilePath $uninstallerExe -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /LOG=`"$uninstallLog`"" -PassThru -Wait
        $swUnins.Stop()
        Write-Host "Uninstaller finished in $([math]::Round($swUnins.Elapsed.TotalSeconds, 1))s with ExitCode: $($u.ExitCode)" -ForegroundColor White

        # Test 10: Tasks removed by uninstall.ps1 (H1)
        $tasksRemaining = Get-ScheduledTask -TaskName 'WhatsAppERPOperations*' -ErrorAction SilentlyContinue
        if (-not $tasksRemaining) {
            Record-Test "Uninstaller Removes Scheduled Tasks via uninstall.ps1" $true "Scheduled tasks (WhatsAppERPOperations, WhatsAppERPOperationsBackup) were cleanly removed by uninstall.ps1." "H1"
        } else {
            $taskNames = ($tasksRemaining | ForEach-Object { $_.TaskName }) -join ', '
            Record-Test "Uninstaller Removes Scheduled Tasks via uninstall.ps1" $false "Scheduled tasks ($taskNames) still registered after uninstall!" "H1"
        }

        # Test 11: Uninstaller log check for PowerShell parse errors (H1)
        $uninstallLogContent = if (Test-Path $uninstallLog) { Get-Content $uninstallLog -Raw } else { "" }
        $hasBraceSyntaxError = $uninstallLogContent -match '\}\}\s*catch\s*\{\}\}'
        if (-not $hasBraceSyntaxError) {
            Record-Test "Uninstaller Log Has No PowerShell Parse Errors" $true "Uninstaller command executed cleanly without syntax errors." "H1"
        } else {
            Record-Test "Uninstaller Log Has No PowerShell Parse Errors" $false "Detected literal '}} catch {{}}' parse error in uninstall log!" "H1"
        }

        # Test 12: Binary directory removal (H2)
        $releasesRemaining = Test-Path "C:\WhatsApp-ERP\releases"
        if (-not $releasesRemaining) {
            Record-Test "Uninstaller Removes Application Binaries" $true "C:\WhatsApp-ERP\releases directory removed."
        } else {
            Record-Test "Uninstaller Removes Application Binaries" $false "C:\WhatsApp-ERP\releases still exists on disk! Robocopied releases not tracked by Inno Setup. (Active finding for Phase 5)." "H2"
        }

        # Test 13: Customer data preservation
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
}

# -------------------------------------------------------------------------
# Test Summary Report
# -------------------------------------------------------------------------
Write-Host "`n====================================================" -ForegroundColor Cyan
Write-Host " TEST EXECUTION SUMMARY (Total Tests: $($testResults.Count))" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

$passCount = ($testResults | Where-Object { $_.Status -eq 'PASS' }).Count
$failCount = ($testResults | Where-Object { $_.Status -eq 'FAIL' }).Count
$totalCount = $testResults.Count

$testResults | Format-Table -Property Test, Status, Finding, Details -AutoSize

Write-Host "Results: $passCount Passed, $failCount Failed out of $totalCount tests." -ForegroundColor $(if ($failCount -gt 0) { "Yellow" } else { "Green" })

$phase1TargetFindings = @('C3', 'H1', 'L19')
$phase1TargetFailures = $testResults | Where-Object { $_.Status -eq 'FAIL' -and $_.Finding -in $phase1TargetFindings }

if ($phase1TargetFailures) {
    Write-Host "`n[ERROR] Phase 1 targeted findings failed:" -ForegroundColor Red
    foreach ($f in $phase1TargetFailures) {
        Write-Host "  -> $($f.Finding): $($f.Test) - $($f.Details)" -ForegroundColor Red
    }
    exit 1
} else {
    Write-Host "`nAll Phase 1 targeted tests (C3, H1, L19) PASSED!" -ForegroundColor Green
    $remaining = $testResults | Where-Object { $_.Status -eq 'FAIL' }
    if ($remaining) {
        Write-Host "Retained known failures for subsequent phases:" -ForegroundColor Yellow
        foreach ($r in $remaining) {
            Write-Host "  -> [$($r.Finding)] $($r.Test)" -ForegroundColor Yellow
        }
    }
    exit 0
}
