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

function Stop-ServiceProcessTree($Config) {
    $taskName = Get-ConfigProperty $Config 'TaskName'
    $releasePath = Get-ConfigProperty $Config 'ReleasePath'
    $dataDir = Get-ConfigProperty $Config 'DataDir'
    $port = [int](Get-ConfigProperty $Config 'Port' 3211)

    if ($taskName) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    }

    # 1. Attempt graceful stop via Admin CLI if release exists
    if ($releasePath -and (Test-Path -LiteralPath $releasePath)) {
        try {
            Invoke-Admin $Config @('stop')
            Start-Sleep -Seconds 1
        } catch {}
    }

    # 2. Check shutdown.json or runtime.lock to identify server process ID
    $pidToKill = $null
    if ($dataDir) {
        $shutdownFile = Join-Path $dataDir 'shutdown.json'
        if (Test-Path -LiteralPath $shutdownFile) {
            try {
                $sd = Get-Content -LiteralPath $shutdownFile -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($sd.pid) { $pidToKill = [int]$sd.pid }
            } catch {}
        }
        if (-not $pidToKill) {
            $lockFile = Join-Path $dataDir 'runtime.lock'
            if (Test-Path -LiteralPath $lockFile) {
                try {
                    $lk = Get-Content -LiteralPath $lockFile -Raw -Encoding UTF8 | ConvertFrom-Json
                    if ($lk.pid) { $pidToKill = [int]$lk.pid }
                } catch {}
            }
        }
    }

    if ($pidToKill) {
        $proc = Get-Process -Id $pidToKill -ErrorAction SilentlyContinue
        if ($proc) {
            try {
                & taskkill.exe /PID $pidToKill /T /F | Out-Null
            } catch {
                try { Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue } catch {}
            }
        }
    }

    # Also kill any process listening on the configured Port
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        foreach ($c in $conn) {
            if ($c.OwningProcess) {
                try { & taskkill.exe /PID $c.OwningProcess /T /F | Out-Null } catch {}
            }
        }
    }

    # 3. Wait up to 10 seconds for the port to be free
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        $active = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if (-not $active) { break }
        Start-Sleep -Seconds 1
    }
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
