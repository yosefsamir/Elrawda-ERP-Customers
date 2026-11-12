param(
    [switch]$AuditOnly,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($AuditOnly) {
        $argList += '-AuditOnly'
    }
    if ($NoPause) {
        $argList += '-NoPause'
    }
    $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -Wait -PassThru
    exit $proc.ExitCode
}

$PoCUser = 'GeminiPoCTest'
$PoCTaskName = 'GeminiPoCTest_Startup'
$PoCRoot = 'C:\Temp\gemini-poc'
$ProdTaskName = 'WhatsAppERPOperations'
$ProdDataRoot = 'C:\ProgramData\WhatsApp-ERP'

function Resolve-PrincipalDisplay {
    param([string]$Token)

    $trimmed = $Token.Trim()
    if (-not $trimmed) {
        return $trimmed
    }
    if ($trimmed.StartsWith('*')) {
        $sidText = $trimmed.Substring(1)
        try {
            $sidObj = New-Object System.Security.Principal.SecurityIdentifier($sidText)
            $nt = $sidObj.Translate([System.Security.Principal.NTAccount])
            return "$trimmed ($($nt.Value))"
        } catch {
            return "$trimmed (unresolved SID)"
        }
    }
    return $trimmed
}

function Get-UserRightsAssignment {
    param([string[]]$RightNames = @('SeBatchLogonRight', 'SeDenyBatchLogonRight'))

    $tmpDir = Join-Path $env:TEMP ("gemini-poc-sec-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    try {
        $exportCfg = Join-Path $tmpDir 'user-rights.inf'
        $exportLog = Join-Path $tmpDir 'secedit-export.log'
        $output = & secedit.exe /export /cfg $exportCfg /areas USER_RIGHTS /log $exportLog 2>&1
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exportCfg)) {
            $joined = ($output | ForEach-Object { "$_" }) -join ' '
            throw "secedit /export failed (exit=$LASTEXITCODE): $joined"
        }

        $result = @{}
        foreach ($name in $RightNames) {
            $result[$name] = @()
        }

        $inPrivilegeSection = $false
        foreach ($line in (Get-Content -LiteralPath $exportCfg)) {
            $trimmed = $line.Trim()
            if ($trimmed -match '^\[(.+)\]$') {
                $inPrivilegeSection = ($Matches[1] -ieq 'Privilege Rights')
                continue
            }
            if (-not $inPrivilegeSection -or -not ($trimmed -match '^([^=]+?)\s*=\s*(.*)$')) {
                continue
            }
            $key = $Matches[1].Trim()
            $rawVal = $Matches[2].Trim()
            foreach ($name in $RightNames) {
                if ($key -ieq $name) {
                    if ($rawVal) {
                        $result[$name] = @($rawVal.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
                    } else {
                        $result[$name] = @()
                    }
                }
            }
        }
        return $result
    } finally {
        if (Test-Path -LiteralPath $tmpDir) {
            Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Remove-TokenFromSeBatchLogonRight {
    param(
        [string]$AccountName,
        [string]$AccountSid
    )

    $rights = Get-UserRightsAssignment -RightNames @('SeBatchLogonRight')
    $current = @($rights['SeBatchLogonRight'])
    if ($current.Count -eq 0) {
        return @{ Changed = $false; Removed = @(); Remaining = @() }
    }

    $targets = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    [void]$targets.Add($AccountName)
    [void]$targets.Add("$env:COMPUTERNAME\$AccountName")
    [void]$targets.Add(".\$AccountName")
    if ($AccountSid) {
        [void]$targets.Add("*$AccountSid")
        [void]$targets.Add($AccountSid)
    }

    $removed = @()
    $remaining = @()
    foreach ($token in $current) {
        if ($targets.Contains($token)) {
            $removed += $token
        } else {
            $remaining += $token
        }
    }

    if ($removed.Count -eq 0) {
        return @{ Changed = $false; Removed = @(); Remaining = $current }
    }

    $tmpDir = Join-Path $env:TEMP ("gemini-poc-secset-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    try {
        $infPath = Join-Path $tmpDir 'update-batch-right.inf'
        $sdbPath = Join-Path $tmpDir 'update-batch-right.sdb'
        $logPath = Join-Path $tmpDir 'secedit-configure.log'

        $infLines = @(
            '[Unicode]',
            'Unicode=yes',
            '[Version]',
            'signature="$CHICAGO$"',
            'Revision=1',
            '[Privilege Rights]',
            ("SeBatchLogonRight = " + ($remaining -join ','))
        )
        # UTF-16LE with BOM is required by secedit.exe when Unicode=yes.
        Set-Content -LiteralPath $infPath -Value $infLines -Encoding Unicode

        $output = & secedit.exe /configure /db $sdbPath /cfg $infPath /areas USER_RIGHTS /log $logPath /quiet 2>&1
        if ($LASTEXITCODE -ne 0) {
            $joined = ($output | ForEach-Object { "$_" }) -join ' '
            throw "secedit /configure failed (exit=$LASTEXITCODE): $joined"
        }

        $verify = Get-UserRightsAssignment -RightNames @('SeBatchLogonRight')
        $stillPresent = @($verify['SeBatchLogonRight'] | Where-Object { $targets.Contains($_) })
        if ($stillPresent.Count -gt 0) {
            throw "PoC entry remained in SeBatchLogonRight after update: $($stillPresent -join ', ')"
        }

        return @{
            Changed = $true
            Removed = $removed
            Remaining = @($verify['SeBatchLogonRight'])
        }
    } finally {
        if (Test-Path -LiteralPath $tmpDir) {
            Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Find-PoCSid {
    param([string]$AccountName)

    $localUser = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
    if ($localUser -and $localUser.SID) {
        return $localUser.SID.Value
    }

    $profileListPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
    if (Test-Path -LiteralPath $profileListPath) {
        foreach ($key in (Get-ChildItem -LiteralPath $profileListPath -ErrorAction SilentlyContinue)) {
            $props = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
            if ($props -and $props.ProfileImagePath -and ($props.ProfileImagePath -match ("\\$([regex]::Escape($AccountName))(\..*)?$"))) {
                return $key.PSChildName
            }
        }
    }

    $wmiProfile = Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue |
        Where-Object { -not $_.Special -and $_.LocalPath -and ($_.LocalPath -match ("\\$([regex]::Escape($AccountName))(\..*)?$")) } |
        Select-Object -First 1
    if ($wmiProfile -and $wmiProfile.SID) {
        return $wmiProfile.SID
    }

    return $null
}

function Get-PoCProcesses {
    param(
        [string]$RootPath,
        [string]$AccountName
    )

    $matches = @()
    $allProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    foreach ($p in $allProcs) {
        if ($p.ProcessId -eq $PID) {
            continue
        }
        $isCmdMatch = $p.CommandLine -and ($p.CommandLine -like "*$RootPath*")
        $isOwnerMatch = $false
        if (-not $isCmdMatch) {
            try {
                $ownerInfo = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop
                if ($ownerInfo -and $ownerInfo.ReturnValue -eq 0 -and $ownerInfo.User -ieq $AccountName) {
                    $isOwnerMatch = $true
                }
            } catch {
            }
        }
        if ($isCmdMatch -or $isOwnerMatch) {
            $matches += $p
        }
    }
    return $matches
}

$exitCode = 0

try {
    if ($AuditOnly) {
        Write-Host '=== Gemini Dedicated User PoC - Read-Only Audit ===' -ForegroundColor Cyan
    } else {
        Write-Host '=== Gemini Dedicated User PoC - Step 4: Safe Cleanup ===' -ForegroundColor Cyan
    }
    Write-Host ''

    $localUser = Get-LocalUser -Name $PoCUser -ErrorAction SilentlyContinue
    $pocSid = Find-PoCSid -AccountName $PoCUser
    $pocTask = Get-ScheduledTask -TaskName $PoCTaskName -ErrorAction SilentlyContinue
    $pocProcs = @(Get-PoCProcesses -RootPath $PoCRoot -AccountName $PoCUser)
    $pocUserProfiles = @(Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue | Where-Object {
        -not $_.Special -and (
            ($pocSid -and $_.SID -eq $pocSid) -or
            ($_.LocalPath -and ($_.LocalPath -match ("\\$([regex]::Escape($PoCUser))(\..*)?$")))
        )
    })
    $pocProfileDirs = @(Get-ChildItem -Path 'C:\Users' -Directory -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -ieq $PoCUser -or $_.Name -ilike "$PoCUser.*"
    })
    $rights = Get-UserRightsAssignment -RightNames @('SeBatchLogonRight', 'SeDenyBatchLogonRight')

    if ($AuditOnly) {
        Write-Host ("[PoC Task]    {0}: {1}" -f $PoCTaskName, $(if ($pocTask) { "PRESENT (State=$($pocTask.State), LogonType=$($pocTask.Principal.LogonType))" } else { 'ABSENT' }))
        Write-Host ("[PoC User]    {0}: {1}" -f $PoCUser, $(if ($localUser) { "PRESENT (SID=$pocSid, Enabled=$($localUser.Enabled))" } elseif ($pocSid) { "ABSENT (leftover SID=$pocSid in profile registry)" } else { 'ABSENT' }))
        Write-Host ("[PoC Procs]   {0} matching process(es)" -f $pocProcs.Count)
        foreach ($p in $pocProcs) {
            Write-Host ("              PID=$($p.ProcessId) Name=$($p.Name)")
        }
        Write-Host ("[PoC Profile] Win32_UserProfile count=$($pocUserProfiles.Count); C:\Users folders=$($pocProfileDirs.Count)")
        foreach ($d in $pocProfileDirs) {
            Write-Host ("              Dir: $($d.FullName)")
        }
        Write-Host ("[PoC Folder]  {0}: {1}" -f $PoCRoot, $(if (Test-Path -LiteralPath $PoCRoot) { 'PRESENT' } else { 'ABSENT' }))
        Write-Host ''
        Write-Host '[Security Policy] SeBatchLogonRight current entries:' -ForegroundColor Yellow
        foreach ($entry in $rights['SeBatchLogonRight']) {
            Write-Host ("  - {0}" -f (Resolve-PrincipalDisplay -Token $entry))
        }
        Write-Host '[Security Policy] SeDenyBatchLogonRight current entries:' -ForegroundColor Yellow
        if ($rights['SeDenyBatchLogonRight'].Count -eq 0) {
            Write-Host '  (none)'
        } else {
            foreach ($entry in $rights['SeDenyBatchLogonRight']) {
                Write-Host ("  - {0}" -f (Resolve-PrincipalDisplay -Token $entry))
            }
        }
        Write-Host ''
        $prodTask = Get-ScheduledTask -TaskName $ProdTaskName -ErrorAction SilentlyContinue
        Write-Host ("[Untouched]   Task {0}: {1}" -f $ProdTaskName, $(if ($prodTask) { "PRESENT (State=$($prodTask.State))" } else { 'ABSENT' }))
        Write-Host ("[Untouched]   Data {0}: {1}" -f $ProdDataRoot, $(if (Test-Path -LiteralPath $ProdDataRoot) { 'PRESENT' } else { 'ABSENT' }))
        Write-Host ''
        Write-Host 'Audit complete. No files, tasks, users, or policies were modified.' -ForegroundColor Green
        exit 0
    }

    # 1. Stop and unregister only GeminiPoCTest_Startup
    if ($pocTask) {
        if ($pocTask.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $PoCTaskName -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
        Unregister-ScheduledTask -TaskName $PoCTaskName -Confirm:$false
        Write-Host "[OK] Unregistered Scheduled Task '$PoCTaskName'." -ForegroundColor Green
    } else {
        Write-Host "[INFO] Scheduled Task '$PoCTaskName' already absent." -ForegroundColor Gray
    }

    # 2. Stop only PoC-related processes (never touching production services/Chromium)
    foreach ($p in $pocProcs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "[OK] Stopped leftover PoC process PID $($p.ProcessId) ($($p.Name))." -ForegroundColor Green
    }
    if ($pocProcs.Count -gt 0) {
        Start-Sleep -Seconds 2
    }

    # 3. Surgically remove ONLY GeminiPoCTest from SeBatchLogonRight before deleting user
    $secResult = Remove-TokenFromSeBatchLogonRight -AccountName $PoCUser -AccountSid $pocSid
    if ($secResult.Changed) {
        Write-Host ("[OK] Removed PoC entry from SeBatchLogonRight ({0}); preserved {1} other entry/entries." -f ($secResult.Removed -join ', '), $secResult.Remaining.Count) -ForegroundColor Green
    } else {
        Write-Host "[INFO] No '$PoCUser' entry found in SeBatchLogonRight." -ForegroundColor Gray
    }

    # 4. Remove GeminiPoCTest Windows user profile (Win32_UserProfile + leftover dir) and local account
    foreach ($up in $pocUserProfiles) {
        try {
            Remove-CimInstance -InputObject $up -ErrorAction Stop
            Write-Host "[OK] Removed Windows user profile: $($up.LocalPath)" -ForegroundColor Green
        } catch {
            Write-Host "[WARN] Could not remove Win32_UserProfile '$($up.LocalPath)' cleanly ($($_.Exception.Message))." -ForegroundColor Yellow
        }
    }

    if ($localUser) {
        Remove-LocalUser -Name $PoCUser
        Write-Host "[OK] Removed local user '$PoCUser'." -ForegroundColor Green
    } else {
        Write-Host "[INFO] Local user '$PoCUser' already absent." -ForegroundColor Gray
    }

    $remainingDirs = @(Get-ChildItem -Path 'C:\Users' -Directory -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -ieq $PoCUser -or $_.Name -ilike "$PoCUser.*"
    })
    foreach ($dir in $remainingDirs) {
        try {
            Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction Stop
            Write-Host "[OK] Removed leftover profile directory '$($dir.FullName)'." -ForegroundColor Green
        } catch {
            Write-Host "[WARN] Could not remove '$($dir.FullName)' cleanly ($($_.Exception.Message))." -ForegroundColor Yellow
        }
    }

    # 5. Remove isolated C:\Temp\gemini-poc test folder (never touches C:\ProgramData\WhatsApp-ERP)
    if (Test-Path -LiteralPath $PoCRoot) {
        Remove-Item -LiteralPath $PoCRoot -Recurse -Force
        Write-Host "[OK] Removed isolated test folder '$PoCRoot'." -ForegroundColor Green
    } else {
        Write-Host "[INFO] Isolated test folder '$PoCRoot' already absent." -ForegroundColor Gray
    }

    # 6. Confirm production task & data untouched
    $prodTask = Get-ScheduledTask -TaskName $ProdTaskName -ErrorAction SilentlyContinue
    if ($prodTask) {
        Write-Host "[INFO] Production task $ProdTaskName untouched (state=$($prodTask.State))." -ForegroundColor Cyan
    }
    if (Test-Path -LiteralPath $ProdDataRoot) {
        Write-Host "[INFO] Production data folder $ProdDataRoot untouched." -ForegroundColor Cyan
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
