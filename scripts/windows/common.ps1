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

    # 3. Environment variable fallback if set
    if ($env:WHATSAPP_CHROME_PATH -and (Test-Path -LiteralPath $env:WHATSAPP_CHROME_PATH)) {
        return (Resolve-Path -LiteralPath $env:WHATSAPP_CHROME_PATH).Path
    }
    return $null
}

function Set-ServiceEnvironment($Config) {
    $dataDir = Get-ConfigProperty $Config 'DataDir'
    $cacheDir = Get-ConfigProperty $Config 'CacheDir'
    $port = Get-ConfigProperty $Config 'Port' 3211
    $releasePath = Get-ConfigProperty $Config 'ReleasePath'

    if ($dataDir) { $env:EMOJI_DATA_DIR = $dataDir }
    if ($cacheDir) { $env:PUPPETEER_CACHE_DIR = $cacheDir }
    $env:PORT = [string]$port
    $env:NODE_ENV = 'production'

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

    # Redirect user profile and temp paths away from systemprofile when running under SYSTEM
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.User -and $identity.User.Value -eq 'S-1-5-18') {
        $stateRoot = if ($dataDir) { Split-Path -Parent $dataDir } else { "$env:ProgramData\WhatsApp-ERP" }
        $cDir = if ($cacheDir) { $cacheDir } else { Join-Path $stateRoot 'cache' }
        $tDir = Join-Path $stateRoot 'temp'
        New-Item -ItemType Directory -Path $cDir -Force -ErrorAction SilentlyContinue | Out-Null
        New-Item -ItemType Directory -Path $tDir -Force -ErrorAction SilentlyContinue | Out-Null
        $env:USERPROFILE = $stateRoot
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
    $launcher = Join-Path $StateRoot 'launcher.ps1'
    Get-CimInstance -ClassName Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($launcher, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }
}

function Wait-OwnedProcessExit($InstallRoot, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        if (@(Get-OwnedProcess $InstallRoot).Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return (@(Get-OwnedProcess $InstallRoot).Count -eq 0)
}

# Stops the whole service: supervisor first so nothing respawns, then a graceful server
# shutdown, then a forced stop limited to our own binaries. Throws if anything survives.
function Stop-ServiceProcessTree($Config) {
    $taskName = Get-ConfigProperty $Config 'TaskName'
    $releasePath = Get-ConfigProperty $Config 'ReleasePath'
    $dataDir = Get-ConfigProperty $Config 'DataDir'
    $port = [int](Get-ConfigProperty $Config 'Port' 3211)
    $installRoot = Get-InstallRoot $Config
    $stateRoot = if ($dataDir) { Split-Path -Parent $dataDir } else { $null }

    if ($taskName) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
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

    # Register automatic startup Scheduled Task running under LocalSystem SID (S-1-5-18)
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcherScript`" -StateRoot `"$StateRoot`"" -WorkingDirectory $StateRoot
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount
    Register-ScheduledTask -TaskName $Config.TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

    # Register daily backup task (03:00) with StartWhenAvailable to ensure missed backups run after boot
    $backupAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$backupScript`" -StateRoot `"$StateRoot`""
    $backupTrigger = New-ScheduledTaskTrigger -Daily -At '03:00'
    $backupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    Register-ScheduledTask -TaskName ($Config.TaskName + 'Backup') -Action $backupAction -Trigger $backupTrigger -Principal $principal -Settings $backupSettings -Force | Out-Null
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
            if ($health.ok -and $health.version -eq $expected -and (Test-Path (Join-Path $dataDir 'shutdown.json'))) { return }
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
