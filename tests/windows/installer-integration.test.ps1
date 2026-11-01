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

# 3. Configure Test Environment: Simulate Windows 10/11 Default ExecutionPolicy
$origPolicy = (Get-ExecutionPolicy -Scope LocalMachine)
Write-Host "`nConfiguring ExecutionPolicy to Restricted (Windows 10/11 default)..." -ForegroundColor Cyan
Set-ExecutionPolicy -ExecutionPolicy Restricted -Scope LocalMachine -Force
$effectivePolicy = (Get-ExecutionPolicy -Scope LocalMachine)
Write-Host "LocalMachine ExecutionPolicy: $effectivePolicy" -ForegroundColor Yellow

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

try {
    # 4. Cleanup baseline before testing
    Write-Host "`n[Baseline] Cleaning any previous test state..." -ForegroundColor Cyan
    Stop-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'WhatsAppERPOperations' -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'WhatsAppERPOperationsBackup' -Confirm:$false -ErrorAction SilentlyContinue
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith('C:\WhatsApp-ERP') } | Stop-Process -Force -ErrorAction SilentlyContinue
    
    $setupLog = "C:\WhatsAppERP-setup.log"
    $uninstallLog = "C:\WhatsAppERP-uninstall.log"
    $conflictLog = "C:\WhatsAppERP-setup-conflict.log"
    Remove-Item $setupLog, $uninstallLog, $conflictLog -Force -ErrorAction SilentlyContinue
    if (Test-Path 'C:\WhatsApp-ERP') {
        Remove-Item 'C:\WhatsApp-ERP' -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path "$env:ProgramData\WhatsApp-ERP") {
        Remove-Item "$env:ProgramData\WhatsApp-ERP" -Recurse -Force -ErrorAction SilentlyContinue
    }

    # -------------------------------------------------------------------------
    # TEST 1: Execute Setup.exe Silent Install
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 1] Running Setup.exe silent installation (/VERYSILENT)..." -ForegroundColor Cyan
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $SetupExePath -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /LOG=`"$setupLog`" /NOCANCEL" -PassThru -Wait
    $sw.Stop()
    $setupExitCode = $p.ExitCode
    Write-Host "Setup finished in $([math]::Round($sw.Elapsed.TotalSeconds, 1))s with ExitCode: $setupExitCode" -ForegroundColor White

    $setupLogContent = if (Test-Path $setupLog) { Get-Content $setupLog -Raw } else { "" }
    $curStepException = $setupLogContent -match 'CurStepChanged raised an exception'

    # -------------------------------------------------------------------------
    # TEST 2: Verify Scheduled Task Registration & Execution Policy (C2)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 2] Verifying Scheduled Tasks..." -ForegroundColor Cyan
    $task = Get-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    $taskBackup = Get-ScheduledTask -TaskName 'WhatsAppERPOperationsBackup' -ErrorAction SilentlyContinue
    
    if (-not $task) {
        Record-Test "Scheduled Task Registration (WhatsAppERPOperations)" $false "Task WhatsAppERPOperations was not registered." "C2"
    } else {
        Record-Test "Scheduled Task Registration (WhatsAppERPOperations)" $true "Task WhatsAppERPOperations is registered."
        
        # Check action arguments for -ExecutionPolicy Bypass
        $action = $task.Actions | Select-Object -First 1
        $hasBypass = $action.Arguments -match '-ExecutionPolicy\s+Bypass'
        if (-not $hasBypass) {
            Record-Test "Task Action specifies -ExecutionPolicy Bypass" $false "Task arguments ('$($action.Arguments)') lack -ExecutionPolicy Bypass. Under default Restricted policy, launcher.ps1 is blocked by Windows!" "C2"
        } else {
            Record-Test "Task Action specifies -ExecutionPolicy Bypass" $true "Task arguments include -ExecutionPolicy Bypass."
        }

        # Check Principal
        $principal = $task.Principal
        Write-Host "       Task Principal UserId: $($principal.UserId), LogonType: $($principal.LogonType)" -ForegroundColor Gray

        # Query LastTaskResult
        $info = Get-ScheduledTaskInfo -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
        Write-Host "       LastTaskResult: $($info.LastTaskResult), LastRunTime: $($info.LastRunTime)" -ForegroundColor Gray
    }

    if (-not $taskBackup) {
        Record-Test "Scheduled Task Registration (WhatsAppERPOperationsBackup)" $false "Task WhatsAppERPOperationsBackup was not registered."
    } else {
        Record-Test "Scheduled Task Registration (WhatsAppERPOperationsBackup)" $true "Task WhatsAppERPOperationsBackup is registered."
    }

    # -------------------------------------------------------------------------
    # TEST 3: Backend Startup and HTTP Readiness Check
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 3] Verifying Backend Startup & Health Endpoint (http://127.0.0.1:3211/healthz)..." -ForegroundColor Cyan
    $healthOk = $false
    $healthDetails = ""
    for ($i = 0; $i -lt 15; $i++) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:3211/healthz" -TimeoutSec 2 -ErrorAction Stop
            if ($resp.ok -eq $true) {
                $healthOk = $true
                $healthDetails = "Health check responded successfully: ok=$($resp.ok), version=$($resp.version)"
                break
            }
        } catch {
            $healthDetails = $_.Exception.Message
        }
        Start-Sleep -Seconds 2
    }

    if ($healthOk) {
        Record-Test "Backend HTTP Health Check" $true $healthDetails
    } else {
        Record-Test "Backend HTTP Health Check" $false "Backend failed to respond on 3211: $healthDetails" "C2"
    }

    # -------------------------------------------------------------------------
    # TEST 4: Detection of C3 (False Success on Deployment Failure)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 4] Evaluating Deployment Outcome vs Exit Code Truthfulness..." -ForegroundColor Cyan
    if ($curStepException -and $setupExitCode -eq 0) {
        Record-Test "Exit Code Truthfulness (Setup fails on deployment error)" $false "Setup log reported 'CurStepChanged raised an exception', yet Setup.exe exited with code 0! Setup reports success despite deployment failure." "C3"
    } elseif (-not $healthOk -and $setupExitCode -eq 0) {
        Record-Test "Exit Code Truthfulness (Setup fails on deployment error)" $false "Backend failed to start, yet Setup.exe exited with code 0!" "C3"
    } else {
        Record-Test "Exit Code Truthfulness (Setup fails on deployment error)" $true "Setup exit code ($setupExitCode) aligns with actual deployment state."
    }

    # -------------------------------------------------------------------------
    # TEST 5: State Directory & Premature service.json Commit (C4)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 5] Verifying State Management & service.json Ordering..." -ForegroundColor Cyan
    $serviceJsonPath = "$env:ProgramData\WhatsApp-ERP\service.json"
    $serviceJsonExists = Test-Path -LiteralPath $serviceJsonPath
    $releaseDirExists = Test-Path "C:\WhatsApp-ERP\releases"

    if ($serviceJsonExists -and -not $healthOk) {
        Record-Test "Idempotent State Commit (service.json written only when healthy)" $false "service.json was written before service was verified ready. Any failure blocks retry/repair because target release exists." "C4"
    } else {
        Record-Test "Idempotent State Commit (service.json written only when healthy)" $true "service.json state conforms to health status."
    }

    # -------------------------------------------------------------------------
    # TEST 6: Uninstaller Execution, Task Teardown & Residual Cleanup (H1, H2)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 6] Running and Validating Uninstaller..." -ForegroundColor Cyan
    $uninstallerExe = "C:\WhatsApp-ERP\unins000.exe"
    if (-not (Test-Path $uninstallerExe)) {
        Record-Test "Uninstaller Binary Present" $false "unins000.exe not found at $uninstallerExe."
    } else {
        Record-Test "Uninstaller Binary Present" $true "unins000.exe is present."

        Write-Host "Executing unins000.exe /VERYSILENT..." -ForegroundColor Cyan
        $u = Start-Process -FilePath $uninstallerExe -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /LOG=`"$uninstallLog`"" -PassThru -Wait
        Write-Host "Uninstaller finished with ExitCode: $($u.ExitCode)" -ForegroundColor White

        # Check uninstall log for PowerShell parser error (H1)
        $uninstallLogContent = if (Test-Path $uninstallLog) { Get-Content $uninstallLog -Raw } else { "" }
        $hasBraceSyntaxError = $uninstallLogContent -match '\}\}\s*catch\s*\{\}\}'
        if ($hasBraceSyntaxError) {
            Write-Host "       Detected literal '}} catch {{}}' in uninstaller command!" -ForegroundColor Red
        }

        # Check if tasks were removed (H1)
        $tasksRemaining = Get-ScheduledTask -TaskName 'WhatsAppERPOperations*' -ErrorAction SilentlyContinue
        if ($tasksRemaining) {
            $taskNames = ($tasksRemaining | ForEach-Object { $_.TaskName }) -join ', '
            Record-Test "Uninstaller Removes Scheduled Tasks" $false "Scheduled tasks ($taskNames) still registered after uninstall! Caused by invalid PowerShell command syntax in UninstallRun." "H1"
        } else {
            Record-Test "Uninstaller Removes Scheduled Tasks" $true "Scheduled tasks were successfully removed."
        }

        # Check running processes (H2)
        $orphanedProcs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith('C:\WhatsApp-ERP') }
        if ($orphanedProcs) {
            $procNames = ($orphanedProcs | ForEach-Object { "$($_.ProcessName) (PID $($_.Id))" }) -join ', '
            Record-Test "Uninstaller Terminates Running Application Processes" $false "Processes still running from C:\WhatsApp-ERP: $procNames" "H2"
        } else {
            Record-Test "Uninstaller Terminates Running Application Processes" $true "No processes running from install directory."
        }

        # Check port 3211
        $portBound = Get-NetTCPConnection -LocalPort 3211 -State Listen -ErrorAction SilentlyContinue
        if ($portBound) {
            Record-Test "Uninstaller Releases Port 3211" $false "Port 3211 is still in LISTEN state after uninstall." "H2"
        } else {
            Record-Test "Uninstaller Releases Port 3211" $true "Port 3211 is free."
        }

        # Check binaries removal (H2)
        $releasesRemaining = Test-Path "C:\WhatsApp-ERP\releases"
        if ($releasesRemaining) {
            Record-Test "Uninstaller Removes Application Binaries" $false "C:\WhatsApp-ERP\releases still exists on disk! Inno Setup has no record of robocopied releases." "H2"
        } else {
            Record-Test "Uninstaller Removes Application Binaries" $true "C:\WhatsApp-ERP\releases directory removed."
        }

        # Check customer data preservation
        $dataPreserved = Test-Path "$env:ProgramData\WhatsApp-ERP"
        Record-Test "Uninstaller Preserves Customer State Directory" $dataPreserved "Customer state directory ($env:ProgramData\WhatsApp-ERP) preserved: $dataPreserved"
    }

    # -------------------------------------------------------------------------
    # TEST 7: Negative Test — Port Conflict / Abort Truthfulness (C3)
    # -------------------------------------------------------------------------
    Write-Host "`n[Test 7] Negative Test: Forced Deployment Failure (Port Conflict)..." -ForegroundColor Cyan
    # Clean previous state to isolate port conflict condition
    Stop-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'WhatsAppERPOperations' -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'WhatsAppERPOperationsBackup' -Confirm:$false -ErrorAction SilentlyContinue
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith('C:\WhatsApp-ERP') } | Stop-Process -Force -ErrorAction SilentlyContinue
    if (Test-Path 'C:\WhatsApp-ERP') {
        Remove-Item 'C:\WhatsApp-ERP' -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path "$env:ProgramData\WhatsApp-ERP") {
        Remove-Item "$env:ProgramData\WhatsApp-ERP" -Recurse -Force -ErrorAction SilentlyContinue
    }

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 3211)
    try {
        $listener.Start()
        Write-Host "Bound dummy listener to port 3211. Running Setup.exe..." -ForegroundColor White

        $pConflict = Start-Process -FilePath $SetupExePath -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /LOG=`"$conflictLog`" /NOCANCEL" -PassThru -Wait
        $conflictExitCode = $pConflict.ExitCode
        Write-Host "Setup with port conflict exited with: $conflictExitCode" -ForegroundColor White

        if ($conflictExitCode -eq 0) {
            Record-Test "Negative Test: Setup Aborts on Deployment Conflict" $false "Setup exited with code 0 even though port 3211 was occupied and install.ps1 failed! Proves finding C3." "C3"
        } else {
            Record-Test "Negative Test: Setup Aborts on Deployment Conflict" $true "Setup failed cleanly with non-zero exit code: $conflictExitCode"
        }
    } finally {
        $listener.Stop()
    }

}
finally {
    # Restore original ExecutionPolicy
    Write-Host "`nRestoring ExecutionPolicy to $origPolicy..." -ForegroundColor Cyan
    Set-ExecutionPolicy -ExecutionPolicy $origPolicy -Scope LocalMachine -Force
}

# -------------------------------------------------------------------------
# Test Summary Report
# -------------------------------------------------------------------------
Write-Host "`n====================================================" -ForegroundColor Cyan
Write-Host " TEST EXECUTION SUMMARY" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

$passCount = ($testResults | Where-Object { $_.Status -eq 'PASS' }).Count
$failCount = ($testResults | Where-Object { $_.Status -eq 'FAIL' }).Count
$totalCount = $testResults.Count

$testResults | Format-Table -Property Test, Status, Finding, Details -AutoSize

Write-Host "Results: $passCount Passed, $failCount Failed out of $totalCount tests." -ForegroundColor $(if ($failCount -gt 0) { "Red" } else { "Green" })

if ($failCount -gt 0) {
    Write-Host "`nDetected active findings under real Windows conditions:" -ForegroundColor Red
    $findings = $testResults | Where-Object { $_.Status -eq 'FAIL' -and $_.Finding } | Select-Object -ExpandProperty Finding -Unique
    foreach ($f in $findings) {
        Write-Host "  -> Finding $f confirmed by real test execution" -ForegroundColor Red
    }
    exit 1
} else {
    Write-Host "`nAll Windows installer integration tests PASSED!" -ForegroundColor Green
    exit 0
}
