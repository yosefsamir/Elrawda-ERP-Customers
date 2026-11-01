param([string]$StateRoot = "$env:ProgramData\WhatsApp-ERP")
$ErrorActionPreference = 'Stop'
$flag = Join-Path $StateRoot 'maintenance.flag'
$logs = Join-Path $StateRoot 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null

# The server exits gracefully when this PID disappears, so stopping the task never orphans it
$env:EMOJI_SUPERVISOR_PID = [string]$PID

while ($true) {
    if (Test-Path $flag) {
        $isStale = $false
        $flagContent = $null
        try {
            $raw = Get-Content -LiteralPath $flag -Raw -Encoding UTF8 -ErrorAction Stop
            $flagContent = $raw | ConvertFrom-Json -ErrorAction Stop
        } catch {}

        $flagReason = 'unknown'
        $flagPid = $null
        if ($flagContent -and $flagContent.PSObject.Properties['reason']) { $flagReason = $flagContent.reason }
        if ($flagContent -and $flagContent.PSObject.Properties['pid']) { $flagPid = $flagContent.pid }

        if ($flagReason -eq 'recovery') {
            # A failed upgrade that could not roll back stays stopped until someone acts on it
        } elseif ($flagPid) {
            $owner = Get-Process -Id $flagPid -ErrorAction SilentlyContinue
            if (-not $owner) {
                $isStale = $true
            }
        } elseif (-not $flagContent) {
            # Legacy string or empty flag: check if older than 15 minutes
            $item = Get-Item -LiteralPath $flag -ErrorAction SilentlyContinue
            if ($item -and (Get-Date) - $item.LastWriteTime -gt (New-TimeSpan -Minutes 15)) {
                $isStale = $true
            }
        }

        if ($isStale) {
            Add-Content -LiteralPath (Join-Path $logs 'launcher.log') -Value "$(Get-Date -Format o) [H4] Automatically cleared stale maintenance flag."
            Remove-Item -LiteralPath $flag -Force -ErrorAction SilentlyContinue
        } else {
            Add-Content -LiteralPath (Join-Path $logs 'launcher.log') -Value "$(Get-Date -Format o) Maintenance mode active (Reason: $flagReason, PID: $flagPid). Waiting..."
            Start-Sleep -Seconds 5
            continue
        }
    }
    try {
        $configFile = Join-Path $StateRoot 'service.json'
        if (-not (Test-Path $configFile)) {
            Start-Sleep -Seconds 2
            continue
        }
        $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
        
        $commonPs1 = Join-Path $config.ReleasePath 'scripts\windows\common.ps1'
        if (Test-Path -LiteralPath $commonPs1) {
            . $commonPs1
            Set-ServiceEnvironment $config
            $nodePath = Get-NodePath $config.ReleasePath
        } else {
            $env:EMOJI_DATA_DIR = $config.DataDir
            $env:PUPPETEER_CACHE_DIR = $config.CacheDir
            $env:PORT = [string]$config.Port
            $env:NODE_ENV = 'production'
            $env:EMOJI_APP_ROOT = $config.ReleasePath
            $bundled = Join-Path $config.ReleasePath 'runtime\node.exe'
            $nodePath = if (Test-Path -LiteralPath $bundled) { $bundled } else { $config.NodePath }
        }

        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $entry = Join-Path $config.ReleasePath 'dist\runtime\apps\server\index.js'
        $child = Start-Process -FilePath $nodePath -ArgumentList ('"{0}"' -f $entry) -WorkingDirectory $config.ReleasePath -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs "$stamp.out.log") -RedirectStandardError (Join-Path $logs "$stamp.err.log")
        $child.WaitForExit()
        Get-ChildItem $logs -File | Sort-Object LastWriteTime -Descending | Select-Object -Skip 60 | Remove-Item -Force -ErrorAction SilentlyContinue
    } catch {
        Add-Content -LiteralPath (Join-Path $logs 'launcher.log') -Value "$(Get-Date -Format o) $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 5
}
