param(
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($NoPause) {
        $argList += '-NoPause'
    }
    $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -Wait -PassThru
    exit $proc.ExitCode
}

$PoCUser = 'GeminiPoCTest'
$PoCTaskName = 'GeminiPoCTest_Startup'
$PoCRoot = 'C:\Temp\gemini-poc'
$LastRunFile = Join-Path $PoCRoot 'last-run.json'
$TaskLogFile = Join-Path $PoCRoot 'task-result.log'
$ReportFile = Join-Path $PoCRoot 'after-restart-report.txt'

$exitCode = 0
$reportLines = New-Object System.Collections.Generic.List[string]

function Write-Report {
    param(
        [string]$Line,
        [string]$Color = 'White'
    )
    $reportLines.Add($Line)
    Write-Host $Line -ForegroundColor $Color
}

try {
    Write-Report '=== Gemini Dedicated User PoC - Step 3: Post-Reboot Verification ===' 'Cyan'
    Write-Report ("Checked At (UTC): {0}" -f ([DateTime]::UtcNow.ToString('o'))) 'Gray'

    $os = Get-CimInstance Win32_OperatingSystem
    $lastBootUtc = ([DateTime]$os.LastBootUpTime).ToUniversalTime()
    Write-Report ("Windows LastBoot (UTC): {0}" -f $lastBootUtc.ToString('o')) 'Gray'
    Write-Report ("Current Interactive Operator: {0}" -f $identity.Name) 'Gray'

    $task = Get-ScheduledTask -TaskName $PoCTaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        Write-Report "[FAIL] Scheduled Task '$PoCTaskName' not found. Run 02-test-background.ps1 before rebooting." 'Red'
        Write-Report 'OVERALL RESULT: FAIL' 'Red'
        $exitCode = 1
    } else {
        # If the startup task is still running right after boot/login, wait briefly for it to complete.
        $waitDeadline = (Get-Date).AddSeconds(60)
        while ($task.State -eq 'Running' -and (Get-Date) -lt $waitDeadline) {
            Write-Host "[WAIT] '$PoCTaskName' is currently running... waiting for completion." -ForegroundColor Yellow
            Start-Sleep -Seconds 3
            $task = Get-ScheduledTask -TaskName $PoCTaskName
        }

        $taskInfo = Get-ScheduledTaskInfo -TaskName $PoCTaskName
        $logonType = [string]$task.Principal.LogonType
        $lastTaskRunUtc = if ($taskInfo.LastRunTime) { ([DateTime]$taskInfo.LastRunTime).ToUniversalTime() } else { [DateTime]::MinValue }

        # Check whether GeminiPoCTest has an interactive desktop session
        $interactivePocSession = $false
        try {
            $interactiveLogonIds = @(
                Get-CimInstance Win32_LogonSession -ErrorAction SilentlyContinue |
                    Where-Object { $_.LogonType -in @(2, 10, 11) } |
                    Select-Object -ExpandProperty LogonId
            )
            $loggedOn = Get-CimInstance Win32_LoggedOnUser -ErrorAction SilentlyContinue
            foreach ($entry in $loggedOn) {
                $accName = $entry.Antecedent.Name
                $logId = $entry.Dependent.LogonId
                if ($accName -eq $PoCUser -and ($interactiveLogonIds -contains $logId)) {
                    $interactivePocSession = $true
                }
            }
        } catch {
            # Leave false if CIM query is restricted
        }

        Write-Report '' 'White'
        Write-Report ("Scheduled Task State     : {0}" -f $task.State) 'Cyan'
        Write-Report ("Principal User / Logon   : {0} / {1}" -f $task.Principal.UserId, $logonType) 'Cyan'
        Write-Report ("Task LastRunTime (UTC)   : {0}" -f $lastTaskRunUtc.ToString('o')) 'Cyan'
        Write-Report ("Task LastTaskResult      : {0}" -f $taskInfo.LastTaskResult) 'Cyan'
        Write-Report ("GeminiPoCTest Interactive: {0}" -f $interactivePocSession) 'Cyan'

        $res = $null
        if (Test-Path -LiteralPath $LastRunFile) {
            $res = Get-Content -LiteralPath $LastRunFile -Raw | ConvertFrom-Json
        }

        if ($null -eq $res) {
            Write-Report "[FAIL] Missing $LastRunFile - startup task did not produce output." 'Red'
            Write-Report 'OVERALL RESULT: FAIL' 'Red'
            $exitCode = 1
        } else {
            $runStartUtc = [DateTime]::Parse([string]$res.runStartUtc).ToUniversalTime()
            $ranAfterBoot = ($runStartUtc -gt $lastBootUtc)

            $checks = @(
                @{ Name = 'Task uses Password logon (not S4U)'; Ok = ($logonType -eq 'Password'); Detail = "LogonType=$logonType" },
                @{ Name = 'Task ran automatically AFTER last reboot'; Ok = $ranAfterBoot; Detail = "runStart=$($runStartUtc.ToString('o')) > boot=$($lastBootUtc.ToString('o'))" },
                @{ Name = 'Ran as dedicated PoC user'; Ok = ([string]$res.windowsUser -like "*\$PoCUser"); Detail = "user=$($res.windowsUser)" },
                @{ Name = 'Ran non-interactively in Session 0'; Ok = ([int]$res.sessionId -eq 0); Detail = "SessionId=$($res.sessionId)" },
                @{ Name = 'GeminiPoCTest NOT interactively logged on'; Ok = (-not $interactivePocSession); Detail = "interactiveSession=$interactivePocSession" },
                @{ Name = 'Windows user profile NTUSER.DAT loaded'; Ok = ([bool]$res.ntUserDatExists); Detail = "profile=$($res.userProfile)" },
                @{ Name = 'DPAPI Unprotect succeeded on Local State'; Ok = ([bool]$res.dpapi.ok); Detail = "prefix=$($res.dpapi.prefix) keyBytes=$($res.dpapi.keyBytes) err=$($res.dpapi.error)" },
                @{ Name = 'Gemini headless authentication succeeded'; Ok = ([bool]$res.headless -and [bool]$res.headless.authOk); Detail = "url=$($res.headless.currentUrl) SID=$($res.headless.hasGoogleSid) signInVisible=$($res.headless.signInVisible) promptVisible=$($res.headless.promptVisible) captcha=$($res.headless.captchaVisible)" },
                @{ Name = 'Gemini minimal real operation succeeded'; Ok = ([bool]$res.headless -and [bool]$res.headless.geminiOp.ok); Detail = "ok=$($res.headless.geminiOp.ok) replyChars=$($res.headless.geminiOp.replyChars) preview=$($res.headless.geminiOp.preview) err=$($res.headless.geminiOp.error)" }
            )

            Write-Report '' 'White'
            $allPassed = $true
            foreach ($c in $checks) {
                if ($c.Ok) {
                    Write-Report ("[PASS] {0} ({1})" -f $c.Name, $c.Detail) 'Green'
                } else {
                    Write-Report ("[FAIL] {0} ({1})" -f $c.Name, $c.Detail) 'Red'
                    $allPassed = $false
                }
            }

            if ($res.headless -and $res.headless.geminiOp -and $res.headless.geminiOp.submitDiagnostics) {
                $sd = $res.headless.geminiOp.submitDiagnostics
                Write-Report ("Submit Diag: method={0} enabledBtn={1} waitMs={2} promptLenFill={3} promptLenAfter={4} userQ={5}->{6}" -f $sd.submitMethod, $sd.enabledSendBtnFound, $sd.enabledSendBtnWaitMs, $sd.promptLenAfterFill, $sd.promptLenAfterSubmit, $sd.beforeUserQueryCount, $sd.userQueryCountAfterSubmit) 'Gray'
            }

            if ($res.headless -and $res.headless.geminiOp -and $res.headless.geminiOp.failureDiag) {
                $fd = $res.headless.geminiOp.failureDiag
                if ($fd.screenshotPath) {
                    Write-Report ("Failure Screenshot: {0}" -f $fd.screenshotPath) 'Yellow'
                }
                if ($fd.domSummary) {
                    Write-Report ("Failure DOM: url={0} userQ={1} turns={2} broad={3} sendBtns={4} stopVis={5} text='{6}'" -f $fd.currentUrlAtFailure, $fd.domSummary.userQueryCount, $fd.domSummary.turnCount, $fd.domSummary.broadContainerCount, $fd.domSummary.sendSelectorCount, $fd.domSummary.stopVisibleCount, $fd.domSummary.mainTextSnippet) 'Yellow'
                }
            }

            if ($res.headless -and $res.headless.recentHttp) {
                Write-Report '' 'White'
                Write-Report 'Recent Sanitized HTTP Statuses:' 'Gray'
                foreach ($h in $res.headless.recentHttp) {
                    Write-Report ("  {0} {1}" -f $h.status, $h.url) 'Gray'
                }
            }

            Write-Report '' 'White'
            if ($allPassed) {
                Write-Report 'OVERALL RESULT: PASS' 'Green'
            } else {
                Write-Report 'OVERALL RESULT: FAIL' 'Red'
                $exitCode = 1
            }
        }
    }

    if (Test-Path -LiteralPath $TaskLogFile) {
        Write-Report '' 'White'
        Write-Report "--- Tail of $TaskLogFile ---" 'Gray'
        $tail = Get-Content -LiteralPath $TaskLogFile -Tail 25
        foreach ($line in $tail) {
            Write-Report $line 'Gray'
        }
    }

    New-Item -ItemType Directory -Path $PoCRoot -Force | Out-Null
    Set-Content -LiteralPath $ReportFile -Value $reportLines -Encoding UTF8 -Force
    Write-Host ''
    Write-Host "Saved sanitized report to: $ReportFile" -ForegroundColor Cyan
} catch {
    Write-Host ''
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
} finally {
    if (-not $NoPause -and $env:NO_PAUSE -ne '1') {
        Write-Host ''
        [void](Read-Host 'Press Enter to close this window')
    }
}

exit $exitCode
