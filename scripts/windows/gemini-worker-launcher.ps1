param([string]$StateRoot = "$env:ProgramData\WhatsApp-ERP")
$ErrorActionPreference = 'Stop'

$workerRoot = Join-Path $StateRoot 'gemini-worker'
$workerTemp = Join-Path $workerRoot 'temp'
$logs = Join-Path $StateRoot 'logs'
New-Item -ItemType Directory -Path $workerTemp -Force -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Path $logs -Force -ErrorAction SilentlyContinue | Out-Null

# The external worker exits cleanly if this supervisor PID disappears.
$env:EMOJI_SUPERVISOR_PID = [string]$PID

while ($true) {
    try {
        $configFile = Join-Path $StateRoot 'service.json'
        $bridgeFile = Join-Path $StateRoot 'gemini-bridge.json'
        if (-not (Test-Path -LiteralPath $configFile) -or -not (Test-Path -LiteralPath $bridgeFile)) {
            Start-Sleep -Seconds 3
            continue
        }

        $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $releasePath = [string]$config.ReleasePath
        if (-not $releasePath -or -not (Test-Path -LiteralPath $releasePath)) {
            Start-Sleep -Seconds 5
            continue
        }

        $commonPs1 = Join-Path $releasePath 'scripts\windows\common.ps1'
        if (Test-Path -LiteralPath $commonPs1) {
            . $commonPs1
            $nodePath = Get-NodePath $releasePath
            $chrome = Get-ChromiumPath $releasePath
        } else {
            $bundled = Join-Path $releasePath 'runtime\node.exe'
            $nodePath = if (Test-Path -LiteralPath $bundled) { $bundled } else { [string]$config.NodePath }
            $chrome = $null
        }

        $port = if ($config.PSObject.Properties['Port'] -and $config.Port) { [int]$config.Port } else { 3211 }
        $env:NODE_ENV = 'production'
        $env:EMOJI_APP_ROOT = $releasePath
        $env:NODE_PATH = Join-Path $releasePath 'node_modules'
        $env:GEMINI_PROFILE_DIR = $workerRoot
        $env:GEMINI_DIRECT_PROFILE = '1'
        # Keep any worker-local path strictly inside gemini-worker\; worker never accesses data\.
        $env:EMOJI_DATA_DIR = $workerRoot
        $env:EMOJI_GEMINI_BRIDGE_URL = "http://127.0.0.1:$port"
        $env:EMOJI_GEMINI_BRIDGE_TOKEN_FILE = $bridgeFile
        $env:EMOJI_WORKER_WINDOWS_USER = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $env:EMOJI_WORKER_SESSION_ID = [string]([System.Diagnostics.Process]::GetCurrentProcess().SessionId)
        $env:TEMP = $workerTemp
        $env:TMP = $workerTemp
        if ($chrome) {
            $env:WHATSAPP_CHROME_PATH = $chrome
            $env:GEMINI_CHROME_PATH = $chrome
        }

        $entry = Join-Path $releasePath 'dist\runtime\apps\server\image-processing\worker-runner.js'
        if (-not (Test-Path -LiteralPath $entry)) {
            Add-Content -LiteralPath (Join-Path $logs 'gemini-worker-launcher.log') -Value "$(Get-Date -Format o) Missing worker-runner.js at $entry"
            Start-Sleep -Seconds 10
            continue
        }

        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $outLog = Join-Path $logs "gemini-worker-$stamp.out.log"
        $errLog = Join-Path $logs "gemini-worker-$stamp.err.log"
        $child = Start-Process -FilePath $nodePath `
            -ArgumentList ('"{0}"' -f $entry) `
            -WorkingDirectory $releasePath `
            -PassThru `
            -WindowStyle Hidden `
            -RedirectStandardOutput $outLog `
            -RedirectStandardError $errLog
        $child.WaitForExit()

        Get-ChildItem $logs -File -Include 'gemini-worker-*.out.log', 'gemini-worker-*.err.log' -Path (Join-Path $logs '*') |
            Sort-Object LastWriteTime -Descending |
            Select-Object -Skip 40 |
            Remove-Item -Force -ErrorAction SilentlyContinue
    } catch {
        Add-Content -LiteralPath (Join-Path $logs 'gemini-worker-launcher.log') -Value "$(Get-Date -Format o) $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 5
}
