[CmdletBinding()]
param(
    [string]$StateRoot = $(if ($env:EMOJI_STATE_ROOT) { $env:EMOJI_STATE_ROOT } else { Join-Path $env:ProgramData 'WhatsApp-ERP' }),
    [switch]$NoPause
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$appCandidate = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$isDevCheckout = (Test-Path -LiteralPath (Join-Path $appCandidate 'apps\server')) -and -not (Test-Path -LiteralPath (Join-Path $appCandidate 'dist\runtime\apps\server\image-processing\cli.js'))
$stateRootVisible = $false
try {
    $stateRootVisible = Test-Path -LiteralPath $StateRoot
} catch {
    $stateRootVisible = $true
}

if (-not $isAdmin -and (-not $isDevCheckout -or $stateRootVisible)) {
    $argList = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', "`"$PSCommandPath`"",
        '-StateRoot', "`"$StateRoot`""
    )
    if ($NoPause -or $env:NO_PAUSE -eq '1') {
        $argList += '-NoPause'
    }
    try {
        $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -Wait -PassThru
        exit $proc.ExitCode
    } catch {
        Write-Host "Administrator elevation is required to access ${StateRoot}: $($_.Exception.Message)" -ForegroundColor Red
        if (-not $NoPause -and $env:NO_PAUSE -ne '1') {
            [void](Read-Host 'Press Enter to close this window')
        }
        exit 1
    }
}

$serviceJsonPath = Join-Path $StateRoot 'service.json'
$releasePath = $appCandidate
$exitCode = 1
$workerTaskToRestart = $null

try {
    if (Test-Path -LiteralPath $serviceJsonPath) {
        $rawCfg = Read-ServiceConfig $StateRoot
        $resolvedRelease = Get-ConfigProperty $rawCfg 'ReleasePath' (Get-ConfigProperty $rawCfg 'releasePath')
        $resolvedDataDir = Get-ConfigProperty $rawCfg 'DataDir' (Get-ConfigProperty $rawCfg 'dataDir')
        $resolvedCacheDir = Get-ConfigProperty $rawCfg 'CacheDir' (Get-ConfigProperty $rawCfg 'cacheDir')
        $port = [int](Get-ConfigProperty $rawCfg 'Port' 3211)
        $mainTaskName = Get-ConfigProperty $rawCfg 'TaskName' 'WhatsAppERPOperations'
        $workerUserName = Get-GeminiWorkerUserName $rawCfg
        $workerTaskName = Get-GeminiWorkerTaskName $rawCfg
        $normalizedCfg = @{
            ReleasePath          = $resolvedRelease
            DataDir              = if ($resolvedDataDir) { $resolvedDataDir } else { Join-Path $StateRoot 'data' }
            CacheDir             = if ($resolvedCacheDir) { $resolvedCacheDir } else { Join-Path $StateRoot 'cache' }
            Port                 = $port
            PortalPort           = Get-ConfigProperty $rawCfg 'PortalPort' 3212
            TaskName             = $mainTaskName
            GeminiWorkerUser     = $workerUserName
            GeminiWorkerTaskName = $workerTaskName
        }
        if ($resolvedRelease -and (Test-Path -LiteralPath $resolvedRelease)) {
            $releasePath = $resolvedRelease
        }

        $cliJs = Join-Path $releasePath 'dist\runtime\apps\server\image-processing\cli.js'
        if (-not (Test-Path -LiteralPath $cliJs)) {
            $altCliJs = Join-Path $appCandidate 'dist\runtime\apps\server\image-processing\cli.js'
            if (Test-Path -LiteralPath $altCliJs) {
                $releasePath = $appCandidate
                $cliJs = $altCliJs
            }
        }
        if (-not (Test-Path -LiteralPath $cliJs)) {
            throw "Could not locate release CLI ($cliJs)."
        }

        $bundledNode = Join-Path $releasePath 'runtime\node.exe'
        $nodeExe = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { 'node.exe' }
        $chrome = Get-ChromiumPath $releasePath
        $workerRoot = Get-GeminiWorkerRoot $StateRoot
        $workerTemp = Join-Path $workerRoot 'temp'
        $bridgeFile = Get-GeminiBridgeTokenPath $StateRoot

        Write-Host "Stopping background Gemini worker '$workerTaskName' so browser profile is unlocked..." -ForegroundColor Cyan
        Stop-GeminiWorkerProcess $normalizedCfg $StateRoot
        $workerTaskToRestart = $workerTaskName

        $workerAccount = Ensure-GeminiWorkerAccount $StateRoot $workerUserName
        Initialize-GeminiWorkerUserProfile $StateRoot $workerAccount.Credential $workerAccount.Sid
        Set-GeminiWorkerAcl $StateRoot $mainTaskName $workerAccount.Sid

        $helperScript = Join-Path $workerTemp ('run-gemini-login-' + [guid]::NewGuid().ToString('N') + '.ps1')
        $nodeModulesDir = Join-Path $releasePath 'node_modules'
        $chromeValue = if ($chrome) { $chrome } else { '' }
        $escaped = { param([string]$v) $v.Replace("'", "''") }
        $helperLines = @(
            "`$ErrorActionPreference = 'Stop'",
            "`$env:NODE_ENV = 'production'",
            "`$env:EMOJI_APP_ROOT = '$(& $escaped $releasePath)'",
            "`$env:NODE_PATH = '$(& $escaped $nodeModulesDir)'",
            "`$env:GEMINI_PROFILE_DIR = '$(& $escaped $workerRoot)'",
            "`$env:GEMINI_DIRECT_PROFILE = '1'",
            "`$env:EMOJI_DATA_DIR = '$(& $escaped $workerRoot)'",
            "`$env:EMOJI_GEMINI_BRIDGE_URL = 'http://127.0.0.1:$port'",
            "`$env:EMOJI_GEMINI_BRIDGE_TOKEN_FILE = '$(& $escaped $bridgeFile)'",
            "`$env:EMOJI_WORKER_WINDOWS_USER = '$(& $escaped $workerAccount.AccountName)'",
            "`$env:TEMP = '$(& $escaped $workerTemp)'",
            "`$env:TMP = '$(& $escaped $workerTemp)'"
        )
        if ($chromeValue) {
            $helperLines += "`$env:WHATSAPP_CHROME_PATH = '$(& $escaped $chromeValue)'"
            $helperLines += "`$env:GEMINI_CHROME_PATH = '$(& $escaped $chromeValue)'"
        }
        $helperLines += "Set-Location -LiteralPath '$(& $escaped $releasePath)'"
        $helperLines += "& '$(& $escaped $nodeExe)' '$(& $escaped $cliJs)' login --direct-profile"
        $helperLines += 'exit [int]$LASTEXITCODE'
        [IO.File]::WriteAllText($helperScript, ($helperLines -join "`r`n"), [Text.UTF8Encoding]::new($false))

        try {
            Write-Host "Starting interactive Gemini Web login under Windows user '$($workerAccount.UserName)'..." -ForegroundColor Cyan
            Write-Host 'Sign in to Google in Chrome and wait until Gemini loads; Chrome will close automatically once saved.' -ForegroundColor Yellow
            $proc = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
                -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$helperScript`"") `
                -Credential $workerAccount.Credential `
                -LoadUserProfile `
                -WorkingDirectory $releasePath `
                -Wait `
                -PassThru
            $exitCode = [int]$proc.ExitCode
        } finally {
            Remove-Item -LiteralPath $helperScript -Force -ErrorAction SilentlyContinue
        }
    } else {
        if (-not $env:EMOJI_DATA_DIR) {
            $env:EMOJI_DATA_DIR = Join-Path $appCandidate 'data\application'
        }
        if (-not $env:EMOJI_APP_ROOT) {
            $env:EMOJI_APP_ROOT = $appCandidate
        }

        $cliJs = Join-Path $releasePath 'dist\runtime\apps\server\image-processing\cli.js'
        if (Test-Path -LiteralPath $cliJs) {
            $env:NODE_ENV = 'production'
            $bundledNode = Join-Path $releasePath 'runtime\node.exe'
            $nodeExe = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { 'node.exe' }
            Set-Location -LiteralPath $releasePath
            Write-Host "Starting Gemini Web login (DataDir: $env:EMOJI_DATA_DIR)..." -ForegroundColor Cyan
            $global:LASTEXITCODE = 0
            & $nodeExe $cliJs login
            $exitCode = [int]$global:LASTEXITCODE
        } elseif (Test-Path -LiteralPath (Join-Path $appCandidate 'package.json')) {
            Set-Location -LiteralPath $appCandidate
            Write-Host "Starting Gemini Web login via npm (DataDir: $env:EMOJI_DATA_DIR)..." -ForegroundColor Cyan
            $global:LASTEXITCODE = 0
            & npm.cmd run gemini:login
            $exitCode = [int]$global:LASTEXITCODE
        } else {
            throw "Could not locate release CLI ($cliJs) or repository package.json."
        }
    }

    if ($exitCode -eq 0) {
        Write-Host ''
        Write-Host 'Gemini Web login succeeded. Persistent Chrome profile is saved for the background Gemini worker.' -ForegroundColor Green
    } else {
        Write-Host ''
        Write-Host "Failed to complete Gemini Web login (exit code $exitCode)." -ForegroundColor Red
    }
} catch {
    Write-Host ''
    Write-Host "Gemini Web login error: $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
} finally {
    if ($workerTaskToRestart -and (Get-ScheduledTask -TaskName $workerTaskToRestart -ErrorAction SilentlyContinue)) {
        try {
            Start-ScheduledTask -TaskName $workerTaskToRestart -ErrorAction SilentlyContinue
            Write-Host "Restarted background Gemini worker task '$workerTaskToRestart'." -ForegroundColor Cyan
        } catch {}
    }
}

if (-not $NoPause -and $env:NO_PAUSE -ne '1') {
    Write-Host ''
    [void](Read-Host 'Press Enter to close this window')
}
exit $exitCode
