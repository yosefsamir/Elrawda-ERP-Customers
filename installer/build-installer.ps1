# WhatsApp-ERP Inno Setup Installer Build Script
# Usage: powershell.exe -ExecutionPolicy Bypass -File "installer\build-installer.ps1"

param(
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host " Building WhatsApp-ERP Windows Setup Installer (.exe)" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot

try {
    # 1. Read package configuration
    $packageJsonPath = Join-Path $repoRoot 'package.json'
    if (-not (Test-Path $packageJsonPath)) {
        throw "package.json not found in repository root: $repoRoot"
    }
    $package = Get-Content $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $version = $package.version
    Write-Host "Target Version: $version" -ForegroundColor Green

    # 2. Check Node.js and run release packaging
    Write-Host "`n[1/4] Packaging verified production release payload..." -ForegroundColor Cyan
    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        throw "Node.js (node.exe) is required to build the release. Please install Node.js 22 LTS."
    }

    $releaseDir = Join-Path $repoRoot "release\whatsapp-erp-windows-$version"
    $manifestPath = Join-Path $releaseDir 'release-manifest.json'

    # Run release packaging script to ensure latest build, runtime bundle, manifest, and checksums
    if ($Force -or -not (Test-Path $manifestPath)) {
        Write-Host "Packaging production payload..." -ForegroundColor Cyan
        $env:BUNDLE_RUNTIME = '1'
        & $nodeCmd.Source (Join-Path $repoRoot 'scripts\release.mjs') --bundle-runtime
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $manifestPath)) {
            throw "Release packaging pipeline failed (scripts\release.mjs). Check console errors above."
        }
    } else {
        Write-Host "Verified production payload already present in: $releaseDir" -ForegroundColor Green
    }
    Write-Host "Production payload verified in: $releaseDir" -ForegroundColor Green

    # 3. Locate Inno Setup Compiler (ISCC.exe)
    Write-Host "`n[2/4] Locating Inno Setup 6 Compiler (ISCC.exe)..." -ForegroundColor Cyan
    $isccCandidates = @(
        (Get-Command iscc.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
        (Get-Command iscc -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
        "$env:ProgramFiles(x86)\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
    )

    # Registry lookup fallback
    $regPaths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1'
    )
    foreach ($regPath in $regPaths) {
        if (Test-Path $regPath) {
            $instLoc = (Get-ItemProperty -Path $regPath -Name 'InstallLocation' -ErrorAction SilentlyContinue).InstallLocation
            if ($instLoc) {
                $isccCandidates += (Join-Path $instLoc 'ISCC.exe')
            }
        }
    }

    $isccPath = $null
    foreach ($candidate in $isccCandidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            $isccPath = (Resolve-Path -LiteralPath $candidate).Path
            break
        }
    }

    if (-not $isccPath) {
        Write-Error @"
Inno Setup 6 compiler (ISCC.exe) was not found!
Please install Inno Setup 6 to compile the Windows installer:
  Option A (winget):
    winget install JRSoftware.InnoSetup
  Option B (official download):
    https://jrsoftware.org/isdl.php

After installation completes, re-run this script.
"@
        exit 1
    }

    Write-Host "Found Inno Setup Compiler: $isccPath" -ForegroundColor Green

    # 4. Compile Inno Setup Script
    Write-Host "`n[3/4] Compiling installer with Inno Setup..." -ForegroundColor Cyan
    $issFile = Join-Path $PSScriptRoot 'WhatsAppERP.iss'
    if (-not (Test-Path $issFile)) {
        throw "Inno Setup script not found: $issFile"
    }

    & $isccPath "/DMyAppVersion=$version" "/DMyReleaseDir=$releaseDir" $issFile
    if ($LASTEXITCODE -ne 0) {
        throw "Inno Setup compilation failed with exit code $LASTEXITCODE."
    }

    # 5. Verify generated installer and compute SHA-256
    Write-Host "`n[4/4] Verifying generated installer..." -ForegroundColor Cyan
    $setupExe = Join-Path $repoRoot "release\WhatsAppERP-Setup-$version.exe"
    if (-not (Test-Path $setupExe)) {
        throw "Generated installer executable not found at: $setupExe"
    }

    $fileInfo = Get-Item $setupExe
    $hash = (Get-FileHash -LiteralPath $setupExe -Algorithm SHA256).Hash.ToLowerInvariant()
    $hashFile = "$setupExe.sha256"
    [IO.File]::WriteAllText($hashFile, "$hash  $($fileInfo.Name)`r`n", [Text.UTF8Encoding]::new($false))

    Write-Host "`n====================================================" -ForegroundColor Green
    Write-Host " BUILD SUCCESSFUL!" -ForegroundColor Green
    Write-Host "====================================================" -ForegroundColor Green
    Write-Host "Installer: $setupExe" -ForegroundColor White
    Write-Host "Size:      $([math]::Round($fileInfo.Length / 1MB, 2)) MB ($($fileInfo.Length) bytes)" -ForegroundColor White
    Write-Host "SHA-256:   $hash" -ForegroundColor White
    Write-Host "Checksum:  $hashFile" -ForegroundColor White
    Write-Host "====================================================" -ForegroundColor Green
}
finally {
    Pop-Location
}
