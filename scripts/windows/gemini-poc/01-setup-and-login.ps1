param(
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

# Self-elevate to Administrator so local user creation, ACL setup, and Task Scheduler work cleanly.
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
$PoCRoot = 'C:\Temp\gemini-poc'
$PoCProfileDir = Join-Path $PoCRoot 'profile'
$AdminOnlyDir = Join-Path $PoCRoot 'admin-only'
$CredFile = Join-Path $AdminOnlyDir 'poc-cred.dpapi'
$PocScriptSrc = Join-Path $PSScriptRoot 'poc.cjs'
$PocScriptDst = Join-Path $PoCRoot 'poc.cjs'
$LoginResultJson = Join-Path $PoCRoot 'login-result.json'

function New-CryptoRandomSecurePassword {
    param([int]$Length = 24)

    $upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
    $lower = 'abcdefghijkmnopqrstuvwxyz'
    $digits = '23456789'
    $symbols = '!@#$%^*_-+='
    $all = $upper + $lower + $digits + $symbols

    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $chars = New-Object char[] $Length
        $buf = New-Object byte[] 4

        function Get-RandomIndex([int]$MaxExclusive) {
            $rng.GetBytes($buf)
            $val = [BitConverter]::ToUInt32($buf, 0)
            return [int]($val % [uint32]$MaxExclusive)
        }

        $chars[0] = $upper[(Get-RandomIndex $upper.Length)]
        $chars[1] = $lower[(Get-RandomIndex $lower.Length)]
        $chars[2] = $digits[(Get-RandomIndex $digits.Length)]
        $chars[3] = $symbols[(Get-RandomIndex $symbols.Length)]

        for ($i = 4; $i -lt $Length; $i++) {
            $chars[$i] = $all[(Get-RandomIndex $all.Length)]
        }

        # Fisher-Yates shuffle
        for ($i = $Length - 1; $i -gt 0; $i--) {
            $j = Get-RandomIndex ($i + 1)
            $tmp = $chars[$i]
            $chars[$i] = $chars[$j]
            $chars[$j] = $tmp
        }

        $sec = New-Object System.Security.SecureString
        foreach ($c in $chars) {
            $sec.AppendChar($c)
        }
        $sec.MakeReadOnly()
        return $sec
    } finally {
        if ($chars) { [Array]::Clear($chars, 0, $chars.Length) }
        if ($buf) { [Array]::Clear($buf, 0, $buf.Length) }
        $rng.Dispose()
    }
}

function Invoke-IcaclsChecked {
    param([string[]]$Arguments)
    $out = & icacls.exe @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "icacls failed ($LASTEXITCODE): $($out -join ' ')"
    }
}

$exitCode = 0
$secPassword = $null
$cred = $null

try {
    Write-Host '=== Gemini Dedicated User PoC - Step 1: Setup & Interactive Login ===' -ForegroundColor Cyan
    Write-Host ''

    # 1. Validate Windows 1.0.6 runtime, Playwright, Chromium, and poc.cjs paths
    $requiredPaths = @(
        @{ Label = 'Windows 1.0.6 release root'; Path = $ReleaseRoot },
        @{ Label = 'Bundled Node.js runtime'; Path = $NodeExe },
        @{ Label = 'Playwright package'; Path = $PlaywrightDir },
        @{ Label = 'Playwright-core package'; Path = $PlaywrightCoreDir },
        @{ Label = 'Bundled Chrome 156 executable'; Path = $ChromeExe },
        @{ Label = 'Standalone poc.cjs'; Path = $PocScriptSrc }
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
        throw ("Required Windows 1.0.6 runtime files are missing:`n - " + ($missing -join "`n - "))
    }

    # Verify we do not touch production task or profile
    $prodTask = Get-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue
    if ($prodTask) {
        Write-Host "[INFO] Production task WhatsAppERPOperations state: $($prodTask.State) (will NOT be touched)." -ForegroundColor Gray
    }

    # 2. Generate secure temporary password & create standard local account GeminiPoCTest
    Write-Host ''
    Write-Host "[STEP] Creating/updating standard local user '$PoCUser' with cryptographically random password..." -ForegroundColor Cyan
    $secPassword = New-CryptoRandomSecurePassword -Length 24

    $existingUser = Get-LocalUser -Name $PoCUser -ErrorAction SilentlyContinue
    if ($null -eq $existingUser) {
        New-LocalUser -Name $PoCUser `
            -Password $secPassword `
            -Description 'Temporary Gemini PoC user' `
            -PasswordNeverExpires `
            -UserMayNotChangePassword | Out-Null
        Write-Host "[OK] Created local user '$PoCUser'." -ForegroundColor Green
    } else {
        Set-LocalUser -Name $PoCUser -Password $secPassword -PasswordNeverExpires $true -UserMayNotChangePassword $true
        Enable-LocalUser -Name $PoCUser
        Write-Host "[OK] Reset password and enabled existing local user '$PoCUser'." -ForegroundColor Green
    }

    $usersGroupName = ([System.Security.Principal.SecurityIdentifier]'S-1-5-32-545').Translate([System.Security.Principal.NTAccount]).Value.Split('\')[-1]
    $adminsGroupName = ([System.Security.Principal.SecurityIdentifier]'S-1-5-32-544').Translate([System.Security.Principal.NTAccount]).Value.Split('\')[-1]

    try {
        Add-LocalGroupMember -Group $usersGroupName -Member $PoCUser -ErrorAction Stop
    } catch {
        # Ignore if already a member of Users.
    }

    try {
        Remove-LocalGroupMember -Group $adminsGroupName -Member $PoCUser -ErrorAction Stop
        Write-Host "[WARN] Removed '$PoCUser' from Administrators group (must stay standard user)." -ForegroundColor Yellow
    } catch {
        Write-Host "[OK] Verified '$PoCUser' is a standard user (not in Administrators)." -ForegroundColor Green
    }

    # 3. Create isolated PoC directories & store DPAPI-encrypted password restricted to current Admin + SYSTEM
    New-Item -ItemType Directory -Path $PoCRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $PoCProfileDir -Force | Out-Null
    New-Item -ItemType Directory -Path $AdminOnlyDir -Force | Out-Null

    $pocAccount = "$env:COMPUTERNAME\$PoCUser"
    $pocSid = (Get-LocalUser -Name $PoCUser).SID.Value
    Invoke-IcaclsChecked @($PoCRoot, '/inheritance:r', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', "*${pocSid}:(OI)(CI)M")
    Invoke-IcaclsChecked @($AdminOnlyDir, '/inheritance:r', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F')

    # Protected with Windows DPAPI bound to current operator Admin account (no plaintext, no static key).
    ConvertFrom-SecureString -SecureString $secPassword | Set-Content -Path $CredFile -Encoding ASCII -Force
    Write-Host "[OK] Saved DPAPI-protected temporary credential for Step 2: $CredFile" -ForegroundColor Green

    Copy-Item -LiteralPath $PocScriptSrc -Destination $PocScriptDst -Force
    Write-Host "[OK] Copied poc.cjs to isolated folder: $PocScriptDst" -ForegroundColor Green

    # Stop any leftover Chrome processes pointing ONLY at the PoC profile directory
    $staleProcs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$PoCProfileDir*" }
    foreach ($p in $staleProcs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }

    # 4. Launch Chromium interactively under GeminiPoCTest with -LoadUserProfile
    Write-Host ''
    Write-Host '[STEP] Launching Chromium interactively under GeminiPoCTest...' -ForegroundColor Cyan
    Write-Host '       Please sign in to Google / Gemini in the browser window that opens.' -ForegroundColor Yellow
    Write-Host '       Once Gemini chat loads cleanly, CLOSE the Chromium window to save & finish.' -ForegroundColor Yellow
    Write-Host ''

    $cred = New-Object System.Management.Automation.PSCredential($pocAccount, $secPassword)
    $proc = Start-Process -FilePath $NodeExe `
        -ArgumentList @("`"$PocScriptDst`"", 'login', "`"$LoginResultJson`"") `
        -Credential $cred `
        -LoadUserProfile `
        -WorkingDirectory $PoCRoot `
        -Wait `
        -PassThru

    Write-Host "[INFO] Interactive login process exited with code $($proc.ExitCode)." -ForegroundColor Gray

    # Verify Windows user profile was initialized
    $localUserObj = Get-LocalUser -Name $PoCUser
    $userProfileObj = Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue |
        Where-Object { $_.SID -eq $localUserObj.SID.Value } |
        Select-Object -First 1

    if ($userProfileObj -and (Test-Path -LiteralPath (Join-Path $userProfileObj.LocalPath 'NTUSER.DAT'))) {
        Write-Host "[OK] Windows profile initialized: $($userProfileObj.LocalPath)" -ForegroundColor Green
    } else {
        Write-Host '[WARN] Could not verify NTUSER.DAT in Win32_UserProfile; check C:\Users\GeminiPoCTest.' -ForegroundColor Yellow
    }

    # Verify Chrome Local State & clean profile unlock
    $localStatePath = Join-Path $PoCProfileDir 'Local State'
    if (Test-Path -LiteralPath $localStatePath) {
        $localState = Get-Content -LiteralPath $localStatePath -Raw | ConvertFrom-Json
        $hasKey = [bool]($localState.os_crypt -and $localState.os_crypt.encrypted_key)
        Write-Host "[OK] Chromium Local State present (os_crypt.encrypted_key present: $hasKey)." -ForegroundColor Green
    } else {
        Write-Host '[WARN] Chromium Local State was not created.' -ForegroundColor Yellow
    }

    if (Test-Path -LiteralPath $LoginResultJson) {
        $loginRes = Get-Content -LiteralPath $LoginResultJson -Raw | ConvertFrom-Json
        Write-Host "[RESULT] Interactive login check -> ok=$($loginRes.ok), hasGoogleSid=$($loginRes.hasGoogleSid), promptVisible=$($loginRes.promptVisible), signInVisible=$($loginRes.signInVisible)" -ForegroundColor Cyan
        if (-not $loginRes.ok) {
            Write-Host '[WARN] Login result did not confirm an authenticated Gemini session. You can re-run 01-setup-and-login.ps1 if needed.' -ForegroundColor Yellow
        }
    }

    Write-Host ''
    Write-Host 'Next step: Right-click 02-test-background.ps1 -> Run with PowerShell.' -ForegroundColor Green
} catch {
    Write-Host ''
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
} finally {
    if ($secPassword) { $secPassword.Dispose() }
    $cred = $null
    [GC]::Collect()
    if (-not $NoPause -and $env:NO_PAUSE -ne '1') {
        Write-Host ''
        [void](Read-Host 'Press Enter to close this window')
    }
}

exit $exitCode
