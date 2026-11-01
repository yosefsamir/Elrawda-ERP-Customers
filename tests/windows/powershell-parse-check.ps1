# Fails if any PowerShell script in the repository has a syntax error. A script that does not
# parse exits before its first line runs, so nothing else in the pipeline can detect it.
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host "Parser: PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
$scripts = @(Get-ChildItem -Path $RepoRoot -Filter '*.ps1' -Recurse -File | Where-Object {
    $_.FullName -notmatch '[\\/](node_modules|release|dist|ci-artifacts)[\\/]'
})
if ($scripts.Count -eq 0) { throw "No PowerShell scripts found under $RepoRoot" }

$failed = 0
foreach ($script in $scripts) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
        $failed++
        foreach ($parseError in $errors) {
            Write-Host "FAIL $($script.FullName):$($parseError.Extent.StartLineNumber):$($parseError.Extent.StartColumnNumber) $($parseError.Message)" -ForegroundColor Red
        }
    } else {
        Write-Host "OK   $($script.Name)"
    }
}

if ($failed -gt 0) { throw "$failed PowerShell script(s) failed to parse." }
Write-Host "All $($scripts.Count) PowerShell scripts parse." -ForegroundColor Green
