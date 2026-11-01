# Fast Inno Setup Compiler validation against a lightweight stub release
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host " Fast Inno Setup Compiler Validation (Stub Payload)" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

# Locate ISCC.exe
$isccCandidates = @(
    (Get-Command iscc.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
    (Get-Command iscc -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
)

$iscc = $null
foreach ($cand in $isccCandidates) {
    if ($cand -and (Test-Path -LiteralPath $cand)) {
        $iscc = (Resolve-Path -LiteralPath $cand).Path
        break
    }
}

if (-not $iscc) {
    throw "ISCC.exe not found! Please ensure Inno Setup 6 is installed."
}

Write-Host "Found Inno Setup Compiler: $iscc" -ForegroundColor Green

$stubDir = Join-Path $RepoRoot 'release\whatsapp-erp-windows-0.0.0-stub'
$outDir = Join-Path $RepoRoot 'release\stub-output'
New-Item -ItemType Directory -Path $stubDir -Force | Out-Null
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stubDir 'scripts\windows') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stubDir 'runtime') -Force | Out-Null

try {
    # Provide minimal stub files so Inno Setup can resolve Source: "{#MyReleaseDir}\*"
    Set-Content -LiteralPath (Join-Path $stubDir 'package.json') -Value '{"version":"0.0.0-stub"}' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $stubDir 'scripts\windows\install.ps1') -Value '# stub' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $stubDir 'runtime\node.exe') -Value 'stub' -Encoding UTF8

    $issFile = Join-Path $RepoRoot 'installer\WhatsAppERP.iss'
    Write-Host "Compiling $issFile against stub payload..." -ForegroundColor Cyan

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $iscc "/DMyAppVersion=0.0.0-stub" "/DMyReleaseDir=$stubDir" "/O$outDir" /Q $issFile
    $sw.Stop()

    if ($LASTEXITCODE -ne 0) {
        throw "ISCC stub compilation failed with exit code $LASTEXITCODE"
    }

    Write-Host "ISCC stub compilation PASSED in $($sw.ElapsedMilliseconds) ms!" -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $stubDir) {
        Remove-Item -LiteralPath $stubDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $outDir) {
        Remove-Item -LiteralPath $outDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
