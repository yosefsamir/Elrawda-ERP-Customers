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

try {
    if (Test-Path -LiteralPath $serviceJsonPath) {
        $rawCfg = Read-ServiceConfig $StateRoot
        $resolvedRelease = Get-ConfigProperty $rawCfg 'ReleasePath' (Get-ConfigProperty $rawCfg 'releasePath')
        $resolvedDataDir = Get-ConfigProperty $rawCfg 'DataDir' (Get-ConfigProperty $rawCfg 'dataDir')
        $resolvedCacheDir = Get-ConfigProperty $rawCfg 'CacheDir' (Get-ConfigProperty $rawCfg 'cacheDir')
        $normalizedCfg = @{
            ReleasePath = $resolvedRelease
            DataDir     = if ($resolvedDataDir) { $resolvedDataDir } else { Join-Path $StateRoot 'data' }
            CacheDir    = if ($resolvedCacheDir) { $resolvedCacheDir } else { Join-Path $StateRoot 'cache' }
            Port        = Get-ConfigProperty $rawCfg 'Port' 3211
            PortalPort  = Get-ConfigProperty $rawCfg 'PortalPort' 3212
        }
        Set-ServiceEnvironment $normalizedCfg
        if ($resolvedRelease -and (Test-Path -LiteralPath $resolvedRelease)) {
            $releasePath = $resolvedRelease
        }
    } else {
        if (-not $env:EMOJI_DATA_DIR) {
            $env:EMOJI_DATA_DIR = Join-Path $appCandidate 'data\application'
        }
        if (-not $env:EMOJI_APP_ROOT) {
            $env:EMOJI_APP_ROOT = $appCandidate
        }
    }

    $cliJs = Join-Path $releasePath 'dist\runtime\apps\server\image-processing\cli.js'
    if (-not (Test-Path -LiteralPath $cliJs)) {
        $altCliJs = Join-Path $appCandidate 'dist\runtime\apps\server\image-processing\cli.js'
        if (Test-Path -LiteralPath $altCliJs) {
            $releasePath = $appCandidate
            $cliJs = $altCliJs
            $env:EMOJI_APP_ROOT = $releasePath
            $chrome = Get-ChromiumPath $releasePath
            if ($chrome -and -not $env:WHATSAPP_CHROME_PATH) { $env:WHATSAPP_CHROME_PATH = $chrome }
        }
    }

    if (Test-Path -LiteralPath $cliJs) {
        $env:EMOJI_APP_ROOT = $releasePath
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

    if ($exitCode -eq 0) {
        Write-Host ''
        Write-Host 'Gemini Web login succeeded. Encrypted session has been saved for the background service.' -ForegroundColor Green
    } else {
        Write-Host ''
        Write-Host "Failed to complete Gemini Web login (exit code $exitCode)." -ForegroundColor Red
    }
} catch {
    Write-Host ''
    Write-Host "Gemini Web login error: $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
}

if (-not $NoPause -and $env:NO_PAUSE -ne '1') {
    Write-Host ''
    [void](Read-Host 'Press Enter to close this window')
}
exit $exitCode
