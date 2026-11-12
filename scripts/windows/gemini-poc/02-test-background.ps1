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

$ReleaseRoot = 'C:\WhatsApp-ERP\releases\1.0.6'
$NodeExe = Join-Path $ReleaseRoot 'runtime\node.exe'
$PlaywrightDir = Join-Path $ReleaseRoot 'node_modules\playwright'
$PlaywrightCoreDir = Join-Path $ReleaseRoot 'node_modules\playwright-core'
$ChromeExe = Join-Path $ReleaseRoot 'runtime\chromium\chrome\win64-156.0.8078.47\chrome-win64\chrome.exe'

$PoCUser = 'GeminiPoCTest'
$PoCTaskName = 'GeminiPoCTest_Startup'
$PoCRoot = 'C:\Temp\gemini-poc'
$PoCProfileDir = Join-Path $PoCRoot 'profile'
$AdminOnlyDir = Join-Path $PoCRoot 'admin-only'
$CredFile = Join-Path $AdminOnlyDir 'poc-cred.dpapi'
$PocScriptSrc = Join-Path $PSScriptRoot 'poc.cjs'
$PocScriptDst = Join-Path $PoCRoot 'poc.cjs'
$TaskRunnerScript = Join-Path $PoCRoot 'run-task.ps1'
$LastRunFile = Join-Path $PoCRoot 'last-run.json'
$TaskLogFile = Join-Path $PoCRoot 'task-result.log'

$exitCode = 0
$secPassword = $null
$bstr = [IntPtr]::Zero
$plainPassword = $null

try {
    Write-Host '=== Gemini Dedicated User PoC - Step 2: Background Task & Headless Test ===' -ForegroundColor Cyan
    Write-Host ''

    # 1. Validate Windows 1.0.6 runtime and prerequisites from Step 1
    $requiredPaths = @(
        @{ Label = 'Windows 1.0.6 release root'; Path = $ReleaseRoot },
        @{ Label = 'Bundled Node.js runtime'; Path = $NodeExe },
        @{ Label = 'Playwright package'; Path = $PlaywrightDir },
        @{ Label = 'Playwright-core package'; Path = $PlaywrightCoreDir },
        @{ Label = 'Bundled Chrome 156 executable'; Path = $ChromeExe },
        @{ Label = 'Standalone poc.cjs'; Path = $PocScriptSrc },
        @{ Label = 'PoC Chromium profile directory'; Path = $PoCProfileDir },
        @{ Label = 'Chromium Local State'; Path = (Join-Path $PoCProfileDir 'Local State') }
    )

    $missing = @()
    foreach ($item in $requiredPaths) {
        if (-not (Test-Path -LiteralPath $item.Path)) {
            $missing += "$($item.Label): $($item.Path)"
        } else {
            Write-Host "[OK] $($item.Label): $($item.Path)" -ForegroundColor Green
        }
    }
    if ($missing.Count -gt 0) {
        throw ("Missing prerequisites (run 01-setup-and-login.ps1 first if profile/Local State is missing):`n - " + ($missing -join "`n - "))
    }

    $localUser = Get-LocalUser -Name $PoCUser -ErrorAction SilentlyContinue
    if ($null -eq $localUser) {
        throw "Local user '$PoCUser' does not exist. Run 01-setup-and-login.ps1 first."
    }

    # Ensure poc.cjs in C:\Temp\gemini-poc is up to date
    Copy-Item -LiteralPath $PocScriptSrc -Destination $PocScriptDst -Force

    # 2. Write standalone non-interactive task runner payload into C:\Temp\gemini-poc\run-task.ps1
    $runnerContent = @'
$ErrorActionPreference = 'Stop'

$PoCRoot = 'C:\Temp\gemini-poc'
$PoCProfileDir = Join-Path $PoCRoot 'profile'
$NodeExe = 'C:\WhatsApp-ERP\releases\1.0.6\runtime\node.exe'
$PocScript = Join-Path $PoCRoot 'poc.cjs'
$PocTempJson = Join-Path $PoCRoot 'poc-headless-raw.json'
$LastRunFile = Join-Path $PoCRoot 'last-run.json'
$TaskLogFile = Join-Path $PoCRoot 'task-result.log'

function Write-LogLine {
    param([string]$Message)
    $line = "[{0}] {1}" -f ([DateTime]::UtcNow.ToString('o')), $Message
    Add-Content -LiteralPath $TaskLogFile -Value $line -Encoding UTF8
}

New-Item -ItemType Directory -Path $PoCRoot -Force | Out-Null

$osInfo = Get-CimInstance Win32_OperatingSystem
$lastBootUtc = ([DateTime]$osInfo.LastBootUpTime).ToUniversalTime()
$runStartUtc = [DateTime]::UtcNow
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$sessionId = (Get-Process -Id $PID).SessionId
$userProfile = $env:USERPROFILE
$ntUserDatExists = [bool]($userProfile -and (Test-Path -LiteralPath (Join-Path $userProfile 'NTUSER.DAT')))

Write-LogLine '------------------------------------------------------------'
Write-LogLine ("TASK START user={0} sessionId={1} userProfile={2} ntUserDat={3} lastBootUtc={4}" -f $currentIdentity, $sessionId, $userProfile, $ntUserDatExists, $lastBootUtc.ToString('o'))

# 1) Verify Chrome OS Crypt DPAPI Unprotect under current Scheduled Task logon context
$dpapiResult = [ordered]@{
    ok = $false
    prefix = $null
    keyBytes = 0
    error = $null
}

$decrypted = $null
try {
    Add-Type -AssemblyName System.Security
    $localStatePath = Join-Path $PoCProfileDir 'Local State'
    if (-not (Test-Path -LiteralPath $localStatePath)) {
        throw "Missing Local State: $localStatePath"
    }
    $localState = Get-Content -LiteralPath $localStatePath -Raw | ConvertFrom-Json
    $b64 = [string]$localState.os_crypt.encrypted_key
    if (-not $b64) {
        throw 'os_crypt.encrypted_key is missing in Local State'
    }
    $raw = [Convert]::FromBase64String($b64)
    if ($raw.Length -le 5) {
        throw "encrypted_key length too short: $($raw.Length)"
    }
    $prefix = [System.Text.Encoding]::ASCII.GetString($raw, 0, 5)
    $dpapiResult.prefix = $prefix
    if ($prefix -ne 'DPAPI') {
        throw "Unexpected key prefix '$prefix' (expected 'DPAPI')"
    }
    $cipher = New-Object byte[] ($raw.Length - 5)
    [Array]::Copy($raw, 5, $cipher, 0, $cipher.Length)
    $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $cipher,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $dpapiResult.keyBytes = $decrypted.Length
    $dpapiResult.ok = ($decrypted.Length -gt 0)
    Write-LogLine ("DPAPI UNPROTECT OK prefix={0} keyBytes={1}" -f $dpapiResult.prefix, $dpapiResult.keyBytes)
} catch {
    $dpapiResult.error = $_.Exception.Message
    Write-LogLine ("DPAPI UNPROTECT FAIL error={0}" -f $dpapiResult.error)
} finally {
    if ($decrypted) {
        [Array]::Clear($decrypted, 0, $decrypted.Length)
    }
}

# 2) Wait briefly after Windows startup for DNS resolution before opening Chromium
$networkReady = $false
$networkWaitSec = 0
for ($attempt = 0; $attempt -lt 15; $attempt++) {
    try {
        $addrs = [System.Net.Dns]::GetHostAddresses('gemini.google.com')
        if ($addrs -and $addrs.Count -gt 0) {
            $networkReady = $true
            break
        }
    } catch {
        # Ignore transient DNS error at boot until retry limit is reached.
    }
    Start-Sleep -Seconds 3
    $networkWaitSec += 3
}
Write-LogLine ("NETWORK CHECK ready={0} waitSec={1}" -f $networkReady, $networkWaitSec)

# 3) Check whether Default\LOCK is an idle file or genuinely locked by a competing process
$lockFile = Join-Path $PoCProfileDir 'Default\LOCK'
$lockExistedBeforeRun = Test-Path -LiteralPath $lockFile
$lockFileHeldByProcess = $false
if ($lockExistedBeforeRun) {
    try {
        $lockStream = [System.IO.File]::Open(
            $lockFile,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
        $lockStream.Dispose()
    } catch {
        $lockFileHeldByProcess = $true
    }
}

$competingProcs = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.ProcessId -ne $PID -and
            $_.CommandLine -and
            $_.CommandLine -like "*$PoCProfileDir*"
        } |
        Select-Object ProcessId, Name
)
$competingProcsCount = $competingProcs.Count
Write-LogLine ("PROFILE LOCK BEFORE RUN filePresent={0} fileLockedByProcess={1} competingProcs={2}" -f $lockExistedBeforeRun, $lockFileHeldByProcess, $competingProcsCount)

# 4) Execute standalone Playwright headless PoC
if (Test-Path -LiteralPath $PocTempJson) {
    Remove-Item -LiteralPath $PocTempJson -Force -ErrorAction SilentlyContinue
}

$env:POC_PROFILE_DIR = $PoCProfileDir
$env:POC_RESULT_JSON = $PocTempJson
$env:POC_SCREENSHOT_PATH = (Join-Path $PoCRoot 'failure-screenshot.png')

$pocOutput = @()
$pocExitCode = 1
try {
    $pocOutput = & $NodeExe $PocScript 'headless' $PocTempJson 2>&1
    $pocExitCode = [int]$LASTEXITCODE
} catch {
    $pocOutput = @("Node execution error: $($_.Exception.Message)")
    $pocExitCode = 1
}

foreach ($line in $pocOutput) {
    $text = [string]$line
    if ($text.Trim()) {
        Write-LogLine ("NODE: {0}" -f $text)
    }
}

$headlessResult = $null
if (Test-Path -LiteralPath $PocTempJson) {
    try {
        $headlessResult = Get-Content -LiteralPath $PocTempJson -Raw | ConvertFrom-Json
    } catch {
        Write-LogLine ("WARN failed to parse poc-headless-raw.json: {0}" -f $_.Exception.Message)
    }
}

$overallOk = [bool](
    $dpapiResult.ok -and
    $headlessResult -and
    $headlessResult.authOk -and
    $headlessResult.geminiOp -and
    $headlessResult.geminiOp.ok -and
    ($pocExitCode -eq 0)
)

$summary = [ordered]@{
    schemaVersion = 1
    runStartUtc = $runStartUtc.ToString('o')
    runEndUtc = [DateTime]::UtcNow.ToString('o')
    lastBootUtc = $lastBootUtc.ToString('o')
    ranAfterLastBoot = ($runStartUtc -gt $lastBootUtc)
    windowsUser = $currentIdentity
    sessionId = $sessionId
    userProfile = $userProfile
    ntUserDatExists = $ntUserDatExists
    networkReady = $networkReady
    networkWaitSec = $networkWaitSec
    lockExistedBeforeRun = $lockExistedBeforeRun
    lockFileHeldByProcess = $lockFileHeldByProcess
    competingProcsCount = $competingProcsCount
    dpapi = $dpapiResult
    pocExitCode = $pocExitCode
    headless = $headlessResult
    overallOk = $overallOk
}

$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $LastRunFile -Encoding UTF8 -Force
Write-LogLine ("TASK END overallOk={0} pocExitCode={1}" -f $overallOk, $pocExitCode)

if ($overallOk) { exit 0 }
if ($pocExitCode -ne 0) { exit $pocExitCode }
exit 1
'@

    Set-Content -LiteralPath $TaskRunnerScript -Value $runnerContent -Encoding ASCII -Force
    Write-Host "[OK] Wrote task runner script: $TaskRunnerScript" -ForegroundColor Green

    # 3. Register (or refresh) Scheduled Task with Password logon (NOT S4U)
    $pocAccount = "$env:COMPUTERNAME\$PoCUser"
    $existingTask = Get-ScheduledTask -TaskName $PoCTaskName -ErrorAction SilentlyContinue

    if (Test-Path -LiteralPath $CredFile) {
        Write-Host "[STEP] Registering Scheduled Task '$PoCTaskName' using Password logon..." -ForegroundColor Cyan
        $encLine = Get-Content -LiteralPath $CredFile -Raw
        if (-not $encLine -or -not $encLine.Trim()) {
            throw "Credential file is empty: $CredFile"
        }
        $secPassword = ConvertTo-SecureString -String $encLine.Trim()

        $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
            -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$TaskRunnerScript`"" `
            -WorkingDirectory $PoCRoot
        $trigger = New-ScheduledTaskTrigger -AtStartup
        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -StartWhenAvailable `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPassword)
        $plainPassword = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($bstr)

        Register-ScheduledTask `
            -TaskName $PoCTaskName `
            -Action $action `
            -Trigger $trigger `
            -Settings $settings `
            -User $pocAccount `
            -Password $plainPassword `
            -RunLevel Limited `
            -Description 'Temporary standalone Gemini PoC task (Password logon, AtStartup)' `
            -Force | Out-Null

        $registered = Get-ScheduledTask -TaskName $PoCTaskName
        $logonType = [string]$registered.Principal.LogonType
        if ($logonType -ne 'Password') {
            Unregister-ScheduledTask -TaskName $PoCTaskName -Confirm:$false -ErrorAction SilentlyContinue
            throw "Task registered with unexpected LogonType '$logonType' instead of 'Password'."
        }
        Write-Host "[OK] Registered '$PoCTaskName' for '$pocAccount' (Principal.LogonType=$logonType, Trigger=AtStartup)." -ForegroundColor Green

        # Delete DPAPI credential file now that Task Scheduler holds the credential securely in LSA.
        Remove-Item -LiteralPath $CredFile -Force -ErrorAction SilentlyContinue
        Write-Host '[OK] Deleted temporary DPAPI credential blob from disk (Task Scheduler holds it cleanly).' -ForegroundColor Green
    } elseif ($existingTask -and ([string]$existingTask.Principal.LogonType -eq 'Password')) {
        Write-Host "[INFO] Existing Scheduled Task '$PoCTaskName' already uses Password logon; reusing registered credential." -ForegroundColor Yellow
    } else {
        throw "Missing DPAPI credential file ($CredFile) and no existing Password-logon task found. Re-run 01-setup-and-login.ps1."
    }

    # 4. Run Scheduled Task immediately in Session 0 background and wait for completion
    if (Test-Path -LiteralPath $LastRunFile) {
        Remove-Item -LiteralPath $LastRunFile -Force -ErrorAction SilentlyContinue
    }

    Write-Host ''
    Write-Host "[STEP] Triggering '$PoCTaskName' in non-interactive background (Session 0)..." -ForegroundColor Cyan
    Start-ScheduledTask -TaskName $PoCTaskName

    $deadline = (Get-Date).AddSeconds(120)
    Start-Sleep -Seconds 2
    while ((Get-Date) -lt $deadline) {
        $t = Get-ScheduledTask -TaskName $PoCTaskName
        if ($t.State -ne 'Running' -and (Test-Path -LiteralPath $LastRunFile)) {
            break
        }
        if ($t.State -ne 'Running' -and ((Get-Date) -gt $deadline.AddSeconds(-90))) {
            # Give a tiny grace if task ended fast without last-run.json
            break
        }
        Start-Sleep -Seconds 2
    }

    $taskInfo = Get-ScheduledTaskInfo -TaskName $PoCTaskName
    Write-Host ''
    Write-Host ("Task Info -> State={0}, LastRunTime={1}, LastTaskResult={2}" -f (Get-ScheduledTask -TaskName $PoCTaskName).State, $taskInfo.LastRunTime, $taskInfo.LastTaskResult) -ForegroundColor Cyan

    if (-not (Test-Path -LiteralPath $LastRunFile)) {
        Write-Host "[FAIL] Task did not write $LastRunFile. Check $TaskLogFile or Windows Task Scheduler History." -ForegroundColor Red
        $exitCode = 1
    } else {
        $res = Get-Content -LiteralPath $LastRunFile -Raw | ConvertFrom-Json
        Write-Host ''
        Write-Host '=== Background Run Diagnostic Summary ===' -ForegroundColor Cyan
        Write-Host ("Windows Identity : {0}" -f $res.windowsUser)
        Write-Host ("Session ID       : {0}" -f $res.sessionId)
        Write-Host ("NTUSER.DAT Ready : {0}" -f $res.ntUserDatExists)
        Write-Host ("DPAPI Unprotect  : ok={0} prefix={1} keyBytes={2} err={3}" -f $res.dpapi.ok, $res.dpapi.prefix, $res.dpapi.keyBytes, $res.dpapi.error)
        if ($res.headless) {
            Write-Host ("Chrome UA        : HeadlessToken={0} | {1}" -f $res.headless.userAgentHasHeadless, $res.headless.userAgent)
            Write-Host ("Profile Lock     : fileExists={0} lockedByProcess={1} competingProcs={2}" -f $res.lockExistedBeforeRun, $res.lockFileHeldByProcess, $res.competingProcsCount)
            Write-Host ("Current URL      : {0} (kind={1})" -f $res.headless.currentUrl, $res.headless.urlKind)
            Write-Host ("Cookies (flags)  : count={0} SID={1} SAPISID={2} LSID={3} OSID={4}" -f $res.headless.cookieCount, $res.headless.hasGoogleSid, $res.headless.hasGoogleSapisid, $res.headless.hasAccountsLsid, $res.headless.hasGeminiOsid)
            Write-Host ("Gemini UI        : signInVisible={0} promptVisible={1} captcha={2} authOk={3}" -f $res.headless.signInVisible, $res.headless.promptVisible, $res.headless.captchaVisible, $res.headless.authOk)
            Write-Host ("Gemini Real Op   : ok={0} err={1} replyChars={2} elapsedMs={3} preview={4}" -f $res.headless.geminiOp.ok, $res.headless.geminiOp.error, $res.headless.geminiOp.replyChars, $res.headless.geminiOp.elapsedMs, $res.headless.geminiOp.preview)
            if ($res.headless.geminiOp.submitDiagnostics) {
                $sd = $res.headless.geminiOp.submitDiagnostics
                Write-Host ("Submit Diag      : method={0} enabledBtn={1} waitMs={2} promptLenFill={3} promptLenAfter={4} userQ={5}->{6}" -f $sd.submitMethod, $sd.enabledSendBtnFound, $sd.enabledSendBtnWaitMs, $sd.promptLenAfterFill, $sd.promptLenAfterSubmit, $sd.beforeUserQueryCount, $sd.userQueryCountAfterSubmit)
            }
            if ($res.headless.streamGenerateEvents) {
                Write-Host ("StreamGenerate   : {0}" -f (($res.headless.streamGenerateEvents | ForEach-Object { "$($_.status)@$($_.tMs)ms" }) -join ', '))
            }
            if ($res.headless.geminiOp.failureDiag -and $res.headless.geminiOp.failureDiag.screenshotPath) {
                Write-Host ("Failure Shot     : {0}" -f $res.headless.geminiOp.failureDiag.screenshotPath) -ForegroundColor Yellow
            }
            if ($res.headless.geminiOp.failureDiag -and $res.headless.geminiOp.failureDiag.domSummary) {
                $ds = $res.headless.geminiOp.failureDiag.domSummary
                Write-Host ("Failure DOM      : userQ={0} turns={1} broad={2} msgContent={3} stopVis={4} text='{5}'" -f $ds.userQueryCount, $ds.turnCount, $ds.broadContainerCount, $ds.messageContentCount, $ds.stopVisibleCount, $ds.mainTextSnippet) -ForegroundColor Yellow
            }
        }
        Write-Host ''
        if ($res.overallOk) {
            Write-Host 'PRE-REBOOT BACKGROUND CHECK: PASS' -ForegroundColor Green
            Write-Host ''
            Write-Host 'Next step:' -ForegroundColor Yellow
            Write-Host '  1. RESTART Windows completely.' -ForegroundColor Yellow
            Write-Host '  2. Log back into your normal Windows account (do NOT sign into GeminiPoCTest).' -ForegroundColor Yellow
            Write-Host '  3. Wait ~30-60 seconds after desktop loads, then right-click 03-check-after-restart.ps1 -> Run with PowerShell.' -ForegroundColor Yellow
        } else {
            Write-Host 'PRE-REBOOT BACKGROUND CHECK: FAIL' -ForegroundColor Red
            Write-Host "Inspect log at: $TaskLogFile" -ForegroundColor Yellow
            $exitCode = 1
        }
    }
} catch {
    Write-Host ''
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
} finally {
    if ($bstr -ne [IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    $plainPassword = $null
    if ($secPassword) {
        $secPassword.Dispose()
    }
    [GC]::Collect()

    if (-not $NoPause -and $env:NO_PAUSE -ne '1') {
        Write-Host ''
        [void](Read-Host 'Press Enter to close this window')
    }
}

exit $exitCode
