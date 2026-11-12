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

$exitCode = 0

try {
    Write-Host '=== Gemini Dedicated User PoC - Step 4: Safe Cleanup ===' -ForegroundColor Cyan
    Write-Host ''

    # 1. Stop and unregister only GeminiPoCTest_Startup
    $task = Get-ScheduledTask -TaskName $PoCTaskName -ErrorAction SilentlyContinue
    if ($task) {
        if ($task.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $PoCTaskName -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
        Unregister-ScheduledTask -TaskName $PoCTaskName -Confirm:$false
        Write-Host "[OK] Unregistered Scheduled Task '$PoCTaskName'." -ForegroundColor Green
    } else {
        Write-Host "[INFO] Scheduled Task '$PoCTaskName' already absent." -ForegroundColor Gray
    }

    # 2. Stop only PoC-related processes (strictly matching C:\Temp\gemini-poc and never self)
    $pocProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessId -ne $PID -and
        $_.CommandLine -and
        $_.CommandLine -like "*$PoCRoot*"
    }
    foreach ($p in $pocProcs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "[OK] Stopped leftover PoC process PID $($p.ProcessId) ($($p.Name))." -ForegroundColor Green
    }
    Start-Sleep -Seconds 1

    # 3. Remove GeminiPoCTest Windows user profile (if loaded/created) and local account
    $localUser = Get-LocalUser -Name $PoCUser -ErrorAction SilentlyContinue
    if ($localUser) {
        $userSid = $localUser.SID.Value
        $userProfile = Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue |
            Where-Object { $_.SID -eq $userSid -and -not $_.Special } |
            Select-Object -First 1

        if ($userProfile) {
            try {
                Remove-CimInstance -InputObject $userProfile -ErrorAction Stop
                Write-Host "[OK] Removed Windows user profile: $($userProfile.LocalPath)" -ForegroundColor Green
            } catch {
                Write-Host "[WARN] Could not remove Win32_UserProfile cleanly right now ($($_.Exception.Message))." -ForegroundColor Yellow
            }
        }

        Remove-LocalUser -Name $PoCUser
        Write-Host "[OK] Removed local user '$PoCUser'." -ForegroundColor Green
    } else {
        Write-Host "[INFO] Local user '$PoCUser' already absent." -ForegroundColor Gray
    }

    # 4. Remove isolated C:\Temp\gemini-poc test folder (never touches C:\ProgramData\WhatsApp-ERP)
    if (Test-Path -LiteralPath $PoCRoot) {
        Remove-Item -LiteralPath $PoCRoot -Recurse -Force
        Write-Host "[OK] Removed isolated test folder '$PoCRoot'." -ForegroundColor Green
    } else {
        Write-Host "[INFO] Isolated test folder '$PoCRoot' already absent." -ForegroundColor Gray
    }

    # 5. Confirm production task status untouched
    $prodTask = Get-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    if ($prodTask) {
        Write-Host "[INFO] Production task WhatsAppERPOperations untouched (state=$($prodTask.State))." -ForegroundColor Cyan
    }

    Write-Host ''
    Write-Host 'Cleanup complete.' -ForegroundColor Green
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
