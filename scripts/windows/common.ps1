Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
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
function Set-ServiceEnvironment($Config) {
    $env:EMOJI_DATA_DIR = $Config.DataDir
    $env:PUPPETEER_CACHE_DIR = $Config.CacheDir
    $env:PORT = [string]$Config.Port
    $env:NODE_ENV = 'production'
    $env:EMOJI_APP_ROOT = $Config.ReleasePath
}
function Invoke-Admin($Config, [string[]]$CommandArgs) {
    Set-ServiceEnvironment $Config
    & $Config.NodePath (Join-Path $Config.ReleasePath 'dist\runtime\scripts\maintenance\admin.js') @CommandArgs
    if ($LASTEXITCODE -ne 0) { throw "Maintenance command failed: $($CommandArgs[0])" }
}
function Wait-Ready($Config) {
    $expected = (Get-Content -Raw -Encoding UTF8 (Join-Path $Config.ReleasePath 'package.json') | ConvertFrom-Json).version
    for ($i = 0; $i -lt 45; $i++) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($Config.Port)/healthz" -TimeoutSec 2
            if ($health.ok -and $health.version -eq $expected -and (Test-Path (Join-Path $Config.DataDir 'shutdown.json'))) { return }
        } catch {}
        Start-Sleep -Seconds 2
    }
    throw "Server did not become ready. Inspect logs in the state directory."
}
function Verify-Release($ReleasePath) {
    $manifest = Get-Content -LiteralPath (Join-Path $ReleasePath 'release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($entry in $manifest.files) {
        $file = Join-Path $ReleasePath $entry.path
        if (-not (Test-Path -LiteralPath $file)) { throw "Missing release file: $($entry.path)" }
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw "Release checksum mismatch: $($entry.path)" }
    }
}
function Install-Dependencies($ReleasePath, $NodePath, $CacheDir) {
    $version = & $NodePath -p 'process.versions.node'
    if ($version -notmatch '^22\.' -or [version]$version -lt [version]'22.22.0') { throw 'Install Node.js 22.22 or newer in the 22.x line (Windows x64).' }
    $npm = Join-Path (Split-Path -Parent $NodePath) 'npm.cmd'
    if (-not (Test-Path $npm)) { throw 'npm.cmd must be installed beside node.exe.' }
    $env:PUPPETEER_CACHE_DIR = $CacheDir
    $env:PUPPETEER_SKIP_DOWNLOAD = 'false'
    Push-Location $ReleasePath
    try {
        & $npm ci --omit=dev --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed; the running release has not been changed.' }
        & $NodePath (Join-Path $ReleasePath 'dist\runtime\scripts\maintenance\preflight.js')
        if ($LASTEXITCODE -ne 0) { throw 'SQLite native module or Chromium preflight failed.' }
    } finally { Pop-Location }
}

function Copy-Release($Source, $Destination) {
    $manifest=Get-Content -LiteralPath (Join-Path $Source 'release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach($entry in $manifest.files) {
        $relative=[string]$entry.path
        if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\/])\.\.([\/]|$)') { throw 'Invalid manifest path' }
        $target=Join-Path $Destination $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $Source $relative) -Destination $target
    }
    Copy-Item -LiteralPath (Join-Path $Source 'release-manifest.json') -Destination $Destination
}
