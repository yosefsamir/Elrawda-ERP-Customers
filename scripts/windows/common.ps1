Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ConfigProperty($Object, [string]$PropertyName, $Default = $null) {
    if (-not $Object) { return $Default }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($PropertyName) -and $null -ne $Object[$PropertyName]) {
            return $Object[$PropertyName]
        }
        return $Default
    }
    if ($Object.PSObject -and $Object.PSObject.Properties[$PropertyName]) {
        $val = $Object.PSObject.Properties[$PropertyName].Value
        if ($null -ne $val) { return $val }
        return $Default
    }
    return $Default
}

# Setup reads these lines while the script runs and moves its progress bar
function Write-InstallStage([string]$Stage) {
    Write-Host "##stage $Stage"
}

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Open PowerShell as Administrator, then run this command again.'
    }
}

function Write-JsonFile($Path, $Value) {
    $temp = "$Path.tmp"
    [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Read-ServiceConfig($StateRoot) {
    return Get-Content -LiteralPath (Join-Path $StateRoot 'service.json') -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-NodePath($ReleasePath) {
    $bundled = Join-Path $ReleasePath 'runtime\node.exe'
    if (Test-Path -LiteralPath $bundled) {
        return (Resolve-Path -LiteralPath $bundled).Path
    }
    throw "Bundled Node.js runtime not found in release: $bundled"
}

function Get-ChromiumPath($ReleasePath) {
    # 1. Direct path in runtime\chromium
    $direct = Join-Path $ReleasePath 'runtime\chromium\chrome.exe'
    if (Test-Path -LiteralPath $direct) { return (Resolve-Path -LiteralPath $direct).Path }

    # 2. Puppeteer nested folder structure inside runtime\chromium
    $chromiumDir = Join-Path $ReleasePath 'runtime\chromium'
    if (Test-Path -LiteralPath $chromiumDir) {
        $found = Get-ChildItem -Path $chromiumDir -Filter 'chrome.exe' -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { return $found.FullName }
    }
    return $null
}

function Set-ServiceEnvironment($Config) {
    $dataDir = Get-ConfigProperty $Config 'DataDir'
    $cacheDir = Get-ConfigProperty $Config 'CacheDir'
    $port = Get-ConfigProperty $Config 'Port' 3211
    $releasePath = Get-ConfigProperty $Config 'ReleasePath'
    $stateRoot = if ($dataDir) { Split-Path -Parent $dataDir } else { "$env:ProgramData\WhatsApp-ERP" }

    if ($dataDir) { $env:EMOJI_DATA_DIR = $dataDir }
    if ($cacheDir) { $env:PUPPETEER_CACHE_DIR = $cacheDir }
    $env:PORT = [string]$port
    $env:EMOJI_PORTAL_PORT = [string](Get-ConfigProperty $Config 'PortalPort' 3212)
    $env:NODE_ENV = 'production'

    # Server always delegates Gemini browser automation to the dedicated WhatsAppERPGemini worker
    $env:EMOJI_GEMINI_WORKER_MODE = 'external'
    $env:EMOJI_GEMINI_BRIDGE_URL = "http://127.0.0.1:$port"
    $env:EMOJI_GEMINI_BRIDGE_TOKEN_FILE = Join-Path $stateRoot 'gemini-bridge.json'

    if ($releasePath) {
        $env:EMOJI_APP_ROOT = $releasePath
        $nodeModules = Join-Path $releasePath 'node_modules'
        if (Test-Path -LiteralPath $nodeModules) {
            $env:NODE_PATH = $nodeModules
        }
        $chrome = Get-ChromiumPath $releasePath
        if ($chrome) {
            $env:WHATSAPP_CHROME_PATH = $chrome
        }
    }

    # Keep profile and temp paths inside the state folder when running as a service account
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.User -and $identity.User.Value -in @('S-1-5-18', 'S-1-5-19')) {
        $cDir = if ($cacheDir) { $cacheDir } else { Join-Path $stateRoot 'cache' }
        $tDir = Join-Path $stateRoot 'temp'
        New-Item -ItemType Directory -Path $cDir -Force -ErrorAction SilentlyContinue | Out-Null
        New-Item -ItemType Directory -Path $tDir -Force -ErrorAction SilentlyContinue | Out-Null
        $env:USERPROFILE = $cDir
        $env:LOCALAPPDATA = $cDir
        $env:APPDATA = $cDir
        $env:TEMP = $tDir
        $env:TMP = $tDir
    }
}

function Invoke-Admin($Config, [string[]]$CommandArgs) {
    Set-ServiceEnvironment $Config
    $releasePath = Get-ConfigProperty $Config 'ReleasePath'
    if (-not $releasePath) { throw "Cannot invoke admin command without ReleasePath in config" }
    $node = Get-NodePath $releasePath
    & $node (Join-Path $releasePath 'dist\runtime\scripts\maintenance\admin.js') @CommandArgs
    if ($LASTEXITCODE -ne 0) { throw "Maintenance command failed: $($CommandArgs[0])" }
}

function Move-ItemWithRetry($Source, $Destination, [int]$MaxAttempts = 5) {
    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue
    }
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            Move-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
            return
        } catch {
            if ($attempt -eq $MaxAttempts) { throw }
            Write-Warning "Move-Item failed (attempt $attempt/$MaxAttempts): $($_.Exception.Message). Retrying in 1s..."
            Start-Sleep -Seconds 1
        }
    }
}

# Windows derives a task's SID from the upper-cased name, so ACLs can be set before the task runs
function Get-TaskSid([string]$TaskName) {
    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    try {
        $hash = $sha1.ComputeHash([Text.Encoding]::Unicode.GetBytes($TaskName.ToUpperInvariant()))
    } finally {
        $sha1.Dispose()
    }
    $parts = 0..4 | ForEach-Object { [BitConverter]::ToUInt32($hash, $_ * 4) }
    return 'S-1-5-87-' + ($parts -join '-')
}

function Invoke-Icacls([string[]]$IcaclsArgs) {
    & icacls.exe @IcaclsArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed on $($IcaclsArgs[0]) with exit code $LASTEXITCODE" }
}

# Grants by SID object. icacls resolves the SID to a name first, and a task SID has no name
# until its task exists, so it fails with error 1332 on a fresh machine.
function Grant-SidAccess([string]$Path, [string]$Sid, [Security.AccessControl.FileSystemRights]$Rights, [bool]$Inherited = $true) {
    $item = Get-Item -LiteralPath $Path
    $acl = $item.GetAccessControl('Access')
    $identity = [Security.Principal.SecurityIdentifier]::new($Sid)
    if ($Inherited -and -not $item.PSIsContainer) {
        $Inherited = $false
    }
    $inherit = if ($Inherited) {
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, $Rights, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.SetAccessRule($rule)
    $item.SetAccessControl($acl)
}

function Get-GeminiWorkerUserName($Config = $null) {
    return [string](Get-ConfigProperty $Config 'GeminiWorkerUser' 'WhatsAppERPGemini')
}

function Get-GeminiWorkerTaskName($Config = $null) {
    return [string](Get-ConfigProperty $Config 'GeminiWorkerTaskName' 'WhatsAppERPGeminiWorker')
}

function Get-GeminiWorkerRoot([string]$StateRoot) {
    return Join-Path $StateRoot 'gemini-worker'
}

function Get-GeminiWorkerCredentialPath([string]$StateRoot) {
    return Join-Path (Get-GeminiWorkerRoot $StateRoot) 'admin-only\worker-cred.dpapi'
}

function Get-GeminiBridgeTokenPath([string]$StateRoot) {
    return Join-Path $StateRoot 'gemini-bridge.json'
}

function New-RandomGeminiWorkerPassword {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*_-+'
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $bytes = New-Object byte[] 24
        $rng.GetBytes($bytes)
        $sb = New-Object System.Text.StringBuilder
        foreach ($b in $bytes) {
            [void]$sb.Append($chars[$b % $chars.Length])
        }
        # Guarantee character diversity to satisfy local complexity policy if enabled
        $plain = 'Wa!' + $sb.ToString()
        return (ConvertTo-SecureString -String $plain -AsPlainText -Force)
    } finally {
        $rng.Dispose()
    }
}

function Convert-SecureStringToPlainText([System.Security.SecureString]$Secret) {
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringUni($bstr)
    } finally {
        if ($bstr -ne [IntPtr]::Zero) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }
}

function Save-GeminiWorkerCredential([string]$StateRoot, [pscredential]$Credential) {
    Add-Type -AssemblyName System.Security
    $credPath = Get-GeminiWorkerCredentialPath $StateRoot
    $adminDir = Split-Path -Parent $credPath
    New-Item -ItemType Directory -Path $adminDir -Force | Out-Null
    Invoke-Icacls @($adminDir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')

    $plain = $Credential.GetNetworkCredential().Password
    $payload = (@{ username = $Credential.UserName; password = $plain } | ConvertTo-Json -Compress)
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $protected = [System.Security.Cryptography.ProtectedData]::Protect(
        $bytes,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    $temp = "$credPath.tmp"
    [IO.File]::WriteAllBytes($temp, $protected)
    Move-Item -LiteralPath $temp -Destination $credPath -Force
    Invoke-Icacls @($credPath, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F')
}

function Read-GeminiWorkerCredential([string]$StateRoot) {
    Add-Type -AssemblyName System.Security
    $credPath = Get-GeminiWorkerCredentialPath $StateRoot
    if (-not (Test-Path -LiteralPath $credPath)) { return $null }
    try {
        $protected = [IO.File]::ReadAllBytes($credPath)
        $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $protected,
            $null,
            [System.Security.Cryptography.DataProtectionScope]::LocalMachine
        )
        $obj = ([Text.Encoding]::UTF8.GetString($bytes)) | ConvertFrom-Json
        if (-not $obj -or -not $obj.username -or -not $obj.password) { return $null }
        $sec = ConvertTo-SecureString -String ([string]$obj.password) -AsPlainText -Force
        return [pscredential]::new([string]$obj.username, $sec)
    } catch {
        return $null
    }
}

function Test-LocalMachineCredential([string]$UserName, [pscredential]$Credential) {
    try {
        Add-Type -AssemblyName System.DirectoryServices.AccountManagement -ErrorAction Stop
        $ctx = [System.DirectoryServices.AccountManagement.PrincipalContext]::new(
            [System.DirectoryServices.AccountManagement.ContextType]::Machine
        )
        try {
            return [bool]$ctx.ValidateCredentials($UserName, $Credential.GetNetworkCredential().Password)
        } finally {
            $ctx.Dispose()
        }
    } catch {
        # Fallback if AccountManagement assembly is unavailable: assume DPAPI stored credential is valid
        return $true
    }
}

function Ensure-GeminiWorkerBridgeToken([string]$StateRoot) {
    $tokenPath = Get-GeminiBridgeTokenPath $StateRoot
    if (Test-Path -LiteralPath $tokenPath) {
        try {
            $existing = Get-Content -LiteralPath $tokenPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($existing -and $existing.token -and ([string]$existing.token).Trim().Length -ge 32) {
                return
            }
        } catch {}
    }
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $buf = New-Object byte[] 32
        $rng.GetBytes($buf)
        $hex = [BitConverter]::ToString($buf).Replace('-', '').ToLowerInvariant()
        Write-JsonFile $tokenPath ([pscustomobject]@{
            token = $hex
            createdAt = (Get-Date).ToUniversalTime().ToString('o')
        })
    } finally {
        $rng.Dispose()
    }
}

# Creates or reuses the dedicated standard Windows user for Gemini.
# Upgrades NEVER reset the password if the user + DPAPI credential already validate cleanly,
# preserving the Windows DPAPI master key and Chromium cookies.
function Ensure-GeminiWorkerAccount([string]$StateRoot, [string]$UserName = 'WhatsAppERPGemini') {
    $accountName = "$env:COMPUTERNAME\$UserName"
    $existingUser = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
    $cred = $null
    $reused = $false

    if ($existingUser) {
        $storedCred = Read-GeminiWorkerCredential $StateRoot
        if ($storedCred -and (Test-LocalMachineCredential $UserName $storedCred)) {
            $cred = $storedCred
            $reused = $true
            Set-LocalUser -Name $UserName -PasswordNeverExpires $true -UserMayChangePassword $false
            if (-not $existingUser.Enabled) {
                Enable-LocalUser -Name $UserName
            }
        }
    }

    if (-not $reused) {
        $sec = New-RandomGeminiWorkerPassword
        if (-not $existingUser) {
            New-LocalUser -Name $UserName `
                -Password $sec `
                -FullName 'WhatsApp-ERP Gemini Worker' `
                -Description 'Dedicated standard Windows account for isolated Gemini image processing' `
                -PasswordNeverExpires `
                -UserMayChangePassword:$false `
                -AccountNeverExpires | Out-Null
        } else {
            Set-LocalUser -Name $UserName -Password $sec -PasswordNeverExpires $true -UserMayChangePassword $false
            Enable-LocalUser -Name $UserName
        }
        $cred = [pscredential]::new($accountName, $sec)
        Save-GeminiWorkerCredential $StateRoot $cred
    }

    $usersGroup = ([System.Security.Principal.SecurityIdentifier]'S-1-5-32-545').Translate([System.Security.Principal.NTAccount]).Value.Split('\')[-1]
    $adminsGroup = ([System.Security.Principal.SecurityIdentifier]'S-1-5-32-544').Translate([System.Security.Principal.NTAccount]).Value.Split('\')[-1]
    try { Add-LocalGroupMember -Group $usersGroup -Member $UserName -ErrorAction Stop } catch {}
    try { Remove-LocalGroupMember -Group $adminsGroup -Member $UserName -ErrorAction Stop } catch {}

    $sid = (Get-LocalUser -Name $UserName).SID.Value
    return [pscustomobject]@{
        UserName = $UserName
        AccountName = $accountName
        Sid = $sid
        Credential = $cred
        Reused = $reused
    }
}

function Initialize-GeminiWorkerUserProfile([string]$StateRoot, [pscredential]$Credential, [string]$WorkerSid) {
    $workerRoot = Get-GeminiWorkerRoot $StateRoot
    $locksDir = Join-Path $workerRoot '.locks'
    $profileDir = Join-Path $workerRoot 'profile'
    $sidMarker = Join-Path $locksDir 'worker-sid.txt'

    New-Item -ItemType Directory -Path $locksDir -Force | Out-Null
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null

    if (Test-Path -LiteralPath $sidMarker) {
        $prevSid = ([IO.File]::ReadAllText($sidMarker)).Trim()
        if ($prevSid -and $prevSid -ne $WorkerSid) {
            # Account SID changed (e.g., reinstalled after full user removal): old DPAPI Chrome profile cannot decrypt.
            if (Test-Path -LiteralPath $profileDir) {
                Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction SilentlyContinue
                New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
            }
            foreach ($stateFile in @('auth-state.json', 'reauth.json')) {
                $p = Join-Path $locksDir $stateFile
                if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
            }
        }
    }
    [IO.File]::WriteAllText($sidMarker, $WorkerSid, [Text.UTF8Encoding]::new($false))

    $profileObj = Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue |
        Where-Object { $_.SID -eq $WorkerSid } |
        Select-Object -First 1
    $ntUserReady = ($profileObj -and (Test-Path -LiteralPath (Join-Path $profileObj.LocalPath 'NTUSER.DAT')))

    if (-not $ntUserReady) {
        $proc = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" `
            -ArgumentList '/c', 'exit 0' `
            -Credential $Credential `
            -LoadUserProfile `
            -WindowStyle Hidden `
            -Wait `
            -PassThru
        if ($proc.ExitCode -ne 0) {
            throw "Failed to initialize Windows user profile for $($Credential.UserName) (exit $($proc.ExitCode))."
        }
    }
}

function Set-GeminiWorkerAcl([string]$StateRoot, [string]$MainTaskName, [string]$WorkerSid) {
    $workerRoot = Get-GeminiWorkerRoot $StateRoot
    $adminOnlyDir = Join-Path $workerRoot 'admin-only'
    foreach ($dir in @($workerRoot, (Join-Path $workerRoot 'profile'), (Join-Path $workerRoot '.locks'), (Join-Path $workerRoot 'temp'), $adminOnlyDir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Ensure-GeminiWorkerBridgeToken $StateRoot

    $mainSid = Get-TaskSid $MainTaskName

    # Allow traversal through StateRoot only (non-inherited) so data\, backups\, cache\, temp\ stay blocked
    Grant-SidAccess $StateRoot $WorkerSid 'ReadAndExecute, Synchronize' $false

    # Allow worker read access to shared runtime config and bridge token file only
    $bridgeFile = Get-GeminiBridgeTokenPath $StateRoot
    Invoke-Icacls @($bridgeFile, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F')
    Grant-SidAccess $bridgeFile $mainSid 'ReadAndExecute, Synchronize' $false
    Grant-SidAccess $bridgeFile $WorkerSid 'ReadAndExecute, Synchronize' $false

    foreach ($cfgFile in @((Join-Path $StateRoot 'service.json'), (Join-Path $StateRoot 'gemini-worker-launcher.ps1'))) {
        if (Test-Path -LiteralPath $cfgFile) {
            Grant-SidAccess $cfgFile $WorkerSid 'ReadAndExecute, Synchronize' $false
        }
    }

    # Isolate gemini-worker\ under SYSTEM + Administrators + WorkerSid only (no LOCAL SERVICE cookie access)
    Invoke-Icacls @($workerRoot, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', "*${WorkerSid}:(OI)(CI)M")
    Invoke-Icacls @($adminOnlyDir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')

    # Logs directory: worker writes its own logs only
    Grant-SidAccess (Join-Path $StateRoot 'logs') $WorkerSid 'Modify, Synchronize' $true
}

# New folders under C:\ give Authenticated Users Modify. Code here runs as a service and as
# SYSTEM during backups, so only SYSTEM and Administrators may change it.
function Set-InstallRootAcl([string]$InstallRoot) {
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    Invoke-Icacls @($InstallRoot, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-32-545:(OI)(CI)RX')
}

# The service reads its configuration and writes only data, cache, temp and logs. Other
# LOCAL SERVICE processes get nothing because access is granted to the task SID alone.
function Set-StateAcl([string]$StateRoot, [string]$TaskName) {
    foreach ($name in @('data', 'cache', 'temp', 'backups', 'logs')) {
        New-Item -ItemType Directory -Path (Join-Path $StateRoot $name) -Force | Out-Null
    }
    $sid = Get-TaskSid $TaskName
    Invoke-Icacls @($StateRoot, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
    Grant-SidAccess $StateRoot $sid 'ReadAndExecute, Synchronize'
    foreach ($name in @('data', 'cache', 'temp', 'logs')) {
        Grant-SidAccess (Join-Path $StateRoot $name) $sid 'Modify, Synchronize'
    }
    # Logs hold no secrets, and customers must be able to open them without changing folder permissions
    Invoke-Icacls @((Join-Path $StateRoot 'logs'), '/grant:r', '*S-1-5-32-545:(OI)(CI)RX')
}

# LOCAL SERVICE, plus a task SID that scopes file access to this task, without the
# SeImpersonate privilege that lets a compromised service climb to SYSTEM
function New-ServicePrincipal {
    return New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount -ProcessTokenSidType Unrestricted -RequiredPrivilege @('SeChangeNotifyPrivilege', 'SeIncreaseWorkingSetPrivilege')
}

function Get-InstallRoot($Config) {
    $explicit = Get-ConfigProperty $Config 'InstallRoot'
    if ($explicit) { return $explicit }
    $releasePath = Get-ConfigProperty $Config 'ReleasePath'
    if ($releasePath) { return Split-Path -Parent (Split-Path -Parent $releasePath) }
    return $null
}

# Service processes running from our releases folder. Executable path is the proof of ownership:
# PIDs from state files can be reused and port 3211 can belong to another program. The install
# root itself also holds unins000.exe, which must survive to finish the uninstall.
function Get-OwnedProcess($InstallRoot) {
    if (-not $InstallRoot) { return }
    $prefix = (Join-Path $InstallRoot 'releases') + '\'
    Get-CimInstance -ClassName Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    }
}

function Get-LauncherProcess($StateRoot) {
    if (-not $StateRoot) { return }
    $mainLauncher = Join-Path $StateRoot 'launcher.ps1'
    $workerLauncher = Join-Path $StateRoot 'gemini-worker-launcher.ps1'
    Get-CimInstance -ClassName Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object {
        $_.CommandLine -and (
            $_.CommandLine.IndexOf($mainLauncher, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $_.CommandLine.IndexOf($workerLauncher, [StringComparison]::OrdinalIgnoreCase) -ge 0
        )
    }
}

function Stop-GeminiWorkerProcess($Config, [string]$StateRoot) {
    $workerTask = Get-GeminiWorkerTaskName $Config
    if ($workerTask) {
        Stop-ScheduledTask -TaskName $workerTask -ErrorAction SilentlyContinue
    }
    $workerLauncher = Join-Path $StateRoot 'gemini-worker-launcher.ps1'
    $workerRoot = Get-GeminiWorkerRoot $StateRoot
    $workerProfile = Join-Path $workerRoot 'profile'

    $launcherProcs = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($workerLauncher, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }
    foreach ($p in $launcherProcs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }

    $workerNodeAndChrome = Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and (
            $_.CommandLine.IndexOf('worker-runner.js', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $_.CommandLine.IndexOf($workerProfile, [StringComparison]::OrdinalIgnoreCase) -ge 0
        )
    }
    foreach ($p in $workerNodeAndChrome) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
}

function Wait-OwnedProcessExit($InstallRoot, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        if (@(Get-OwnedProcess $InstallRoot).Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return (@(Get-OwnedProcess $InstallRoot).Count -eq 0)
}

# Stops the whole service: supervisors first so nothing respawns, then a graceful server
# shutdown, then a forced stop limited to our own binaries. Throws if anything survives.
function Stop-ServiceProcessTree($Config) {
    $taskName = Get-ConfigProperty $Config 'TaskName'
    $workerTaskName = Get-GeminiWorkerTaskName $Config
    $releasePath = Get-ConfigProperty $Config 'ReleasePath'
    $dataDir = Get-ConfigProperty $Config 'DataDir'
    $port = [int](Get-ConfigProperty $Config 'Port' 3211)
    $installRoot = Get-InstallRoot $Config
    $stateRoot = if ($dataDir) { Split-Path -Parent $dataDir } else { $null }

    if ($taskName) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    }
    if ($workerTaskName) {
        Stop-ScheduledTask -TaskName $workerTaskName -ErrorAction SilentlyContinue
    }
    foreach ($launcher in (Get-LauncherProcess $stateRoot)) {
        Stop-Process -Id $launcher.ProcessId -Force -ErrorAction SilentlyContinue
    }

    if ($releasePath -and $dataDir -and (Test-Path -LiteralPath $releasePath) -and (Test-Path -LiteralPath (Join-Path $dataDir 'shutdown.json'))) {
        try {
            Invoke-Admin $Config @('stop')
        } catch {
            Write-Warning "Graceful server stop did not complete: $($_.Exception.Message)"
        }
    }

    if ($stateRoot) {
        Stop-GeminiWorkerProcess $Config $stateRoot
    }

    if (-not (Wait-OwnedProcessExit $installRoot 45)) {
        foreach ($proc in (Get-OwnedProcess $installRoot)) {
            Write-Warning "Forcing stop of $($proc.Name) (PID $($proc.ProcessId)): $($proc.ExecutablePath)"
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
        if (-not (Wait-OwnedProcessExit $installRoot 15)) {
            $remaining = (Get-OwnedProcess $installRoot | ForEach-Object { "$($_.Name)#$($_.ProcessId)" }) -join ', '
            throw "Could not stop WhatsApp-ERP processes: $remaining"
        }
    }

    # The port frees shortly after the process exits. Never kill a foreign listener.
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 500
    }
    Write-Warning "Port $port is still in use by a process outside the WhatsApp-ERP install root."
}

function Register-ApplicationTasks($Config, $StateRoot) {
    $launcherScript = Join-Path $StateRoot 'launcher.ps1'
    $backupScript = Join-Path $StateRoot 'scheduled-backup.ps1'

    # Register automatic startup Scheduled Task under the low-privilege service identity
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcherScript`" -StateRoot `"$StateRoot`"" -WorkingDirectory $StateRoot
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Priority 4
    Register-ScheduledTask -TaskName $Config.TaskName -Action $action -Trigger $trigger -Settings $settings -Principal (New-ServicePrincipal) -Force | Out-Null

    # Register daily backup task (03:00) with StartWhenAvailable to ensure missed backups run after boot.
    # It stays SYSTEM because it writes backups the service must not be able to change.
    $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount
    $backupAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$backupScript`" -StateRoot `"$StateRoot`""
    $backupTrigger = New-ScheduledTaskTrigger -Daily -At '03:00'
    $backupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    Register-ScheduledTask -TaskName ($Config.TaskName + 'Backup') -Action $backupAction -Trigger $backupTrigger -Principal $principal -Settings $backupSettings -Force | Out-Null
}

function Register-GeminiWorkerTask($Config, [string]$StateRoot, [pscredential]$Credential) {
    $workerTask = Get-GeminiWorkerTaskName $Config
    $workerLauncher = Join-Path $StateRoot 'gemini-worker-launcher.ps1'
    $workerRoot = Get-GeminiWorkerRoot $StateRoot

    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$workerLauncher`" -StateRoot `"$StateRoot`"" -WorkingDirectory $workerRoot
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Priority 4
    $plain = $Credential.GetNetworkCredential().Password

    Register-ScheduledTask `
        -TaskName $workerTask `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -User $Credential.UserName `
        -Password $plain `
        -RunLevel Limited `
        -Description 'Dedicated WhatsApp-ERP Gemini Worker (Password logon, AtStartup)' `
        -Force | Out-Null

    $registered = Get-ScheduledTask -TaskName $workerTask
    if ([string]$registered.Principal.LogonType -ne 'Password') {
        Unregister-ScheduledTask -TaskName $workerTask -Confirm:$false -ErrorAction SilentlyContinue
        throw "Task '$workerTask' registered with unexpected LogonType '$($registered.Principal.LogonType)' instead of 'Password'."
    }
}

function Wait-Ready($Config, [int]$TimeoutSec = 90) {
    $releasePath = Get-ConfigProperty $Config 'ReleasePath'
    $port = Get-ConfigProperty $Config 'Port' 3211
    $dataDir = Get-ConfigProperty $Config 'DataDir'
    $expected = (Get-Content -Raw -Encoding UTF8 (Join-Path $releasePath 'package.json') | ConvertFrom-Json).version
    $maxAttempts = [math]::Max(5, [int]($TimeoutSec / 2))
    for ($i = 0; $i -lt $maxAttempts; $i++) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
            if ($health.ok -and $health.version -eq $expected -and (Test-Path (Join-Path $dataDir 'shutdown.json'))) {
                return
            }
        } catch {}
        Start-Sleep -Seconds 2
    }
    throw "Server did not become ready within ${TimeoutSec}s. Inspect logs in the state directory."
}

function Verify-Release($ReleasePath) {
    $manifestPath = Join-Path $ReleasePath 'release-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Missing release-manifest.json in $ReleasePath" }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        foreach ($entry in $manifest.files) {
            $relative = [string]$entry.path
            if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\/])\.\.([\/]|$)') { throw "Invalid manifest path: $relative" }
            $file = Join-Path $ReleasePath $relative
            if (-not (Test-Path -LiteralPath $file)) { throw "Missing release file: $relative" }
            $stream = [System.IO.File]::OpenRead($file)
            try {
                $hashBytes = $sha256.ComputeHash($stream)
                $hashHex = [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
                if ($hashHex -ne $entry.sha256) { throw "Release checksum mismatch: $relative" }
            } finally {
                $stream.Dispose()
            }
        }
    } finally {
        $sha256.Dispose()
    }
}

function Assert-ReleaseReady($ReleasePath) {
    $node = Get-NodePath $ReleasePath
    if (-not (Test-Path -LiteralPath $node)) { throw "Bundled Node.js runtime not found: $node" }

    $preflight = Join-Path $ReleasePath 'dist\runtime\scripts\maintenance\preflight.js'
    if (-not (Test-Path -LiteralPath $preflight)) { throw "Preflight script not found: $preflight" }

    $chrome = Get-ChromiumPath $ReleasePath
    if (-not $chrome) { throw "Packaged Chromium browser not found in release: $ReleasePath" }

    $oldEnvChrome = $env:WHATSAPP_CHROME_PATH
    $oldEnvNodePath = $env:NODE_PATH
    try {
        $env:WHATSAPP_CHROME_PATH = $chrome
        $env:NODE_PATH = Join-Path $ReleasePath 'node_modules'
        $output = & $node $preflight
        if ($LASTEXITCODE -ne 0) {
            throw "Readiness preflight checks failed (better-sqlite3 or Chromium validation failure): $output"
        }
    } finally {
        $env:WHATSAPP_CHROME_PATH = $oldEnvChrome
        $env:NODE_PATH = $oldEnvNodePath
    }
}

# Launches the packaged browser under the real service identity, so a Chromium that only works
# for the installing administrator fails the install instead of the customer's first QR scan.
function Assert-ServiceBrowser($ReleasePath, $StateRoot) {
    $taskName = 'WhatsAppERPPreflight'
    $workDir = Join-Path $StateRoot 'temp\preflight'
    if (Test-Path -LiteralPath $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
    New-Item -ItemType Directory -Path $workDir -Force | Out-Null
    Grant-SidAccess $workDir (Get-TaskSid $taskName) 'Modify, Synchronize'

    $resultFile = Join-Path $workDir 'result.json'
    $errorFile = Join-Path $workDir 'error.txt'
    $runner = Join-Path $workDir 'run.cmd'
    $node = Get-NodePath $ReleasePath
    $preflight = Join-Path $ReleasePath 'dist\runtime\scripts\maintenance\preflight.js'
    Set-Content -LiteralPath $runner -Encoding ASCII -Value @(
        '@echo off'
        "set TEMP=$workDir"
        "set TMP=$workDir"
        "set WHATSAPP_CHROME_PATH=$(Get-ChromiumPath $ReleasePath)"
        "set EMOJI_APP_ROOT=$ReleasePath"
        "`"$node`" `"$preflight`" > `"$resultFile`" 2> `"$errorFile`""
    )

    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument "/c `"$runner`"" -WorkingDirectory $workDir
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal (New-ServicePrincipal) -Force | Out-Null
    try {
        Start-ScheduledTask -TaskName $taskName
        $deadline = (Get-Date).AddSeconds(120)
        $output = ''
        do {
            Start-Sleep -Seconds 2
            $finished = (Get-ScheduledTask -TaskName $taskName).State -ne 'Running'
            if (Test-Path -LiteralPath $resultFile) { $output = [string](Get-Content -LiteralPath $resultFile -Raw) }
        } while (-not $finished -and (Get-Date) -lt $deadline)

        if ($output -notmatch '"ok":true') {
            $details = if (Test-Path -LiteralPath $errorFile) { [string](Get-Content -LiteralPath $errorFile -Raw) } else { '' }
            throw "Chromium could not start under the service identity. $details"
        }
        Write-Host "Service identity browser check passed: $($output.Trim())" -ForegroundColor Green
    } finally {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Compatibility alias for existing scripts calling Install-Dependencies
function Install-Dependencies($ReleasePath, $NodePath, $CacheDir) {
    Assert-ReleaseReady $ReleasePath
}

function Copy-Release($Source, $Destination) {
    $manifestPath = Join-Path $Source 'release-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Missing release-manifest.json in $Source" }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null

    $robocopy = Get-Command robocopy.exe -ErrorAction SilentlyContinue
    if ($robocopy) {
        & robocopy.exe $Source $Destination /E /R:1 /W:1 /NP /NFL /NDL /NJH /NJS | Out-Null
        if ($LASTEXITCODE -ge 8) {
            throw "robocopy failed with exit code $LASTEXITCODE"
        }
    } else {
        foreach ($entry in $manifest.files) {
            $relative = [string]$entry.path
            if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\/])\.\.([\/]|$)') { throw 'Invalid manifest path' }
            $target = Join-Path $Destination $relative
            $parent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            Copy-Item -LiteralPath (Join-Path $Source $relative) -Destination $target -Force
        }
    }
    Copy-Item -LiteralPath $manifestPath -Destination $Destination -Force
    Verify-Release $Destination
}
