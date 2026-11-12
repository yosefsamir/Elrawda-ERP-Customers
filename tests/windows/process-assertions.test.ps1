$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'process-assertions.ps1')
function Get-OwnedProcess($InstallRoot) { return $script:processes }
function Process-Row($Id, $Parent, $Command) {
    [pscustomobject]@{ ProcessId=$Id; ParentProcessId=$Parent; CommandLine=$Command }
}
$worker = Process-Row 10 1 'node.exe "C:\WhatsApp-ERP\releases\1.0.7\dist\runtime\apps\server\image-processing\worker-runner.js"'
$browser = Process-Row 11 10 'chrome.exe --user-data-dir=worker-profile'
$renderer = Process-Row 12 11 $null
$server = Process-Row 20 2 'node.exe "C:\WhatsApp-ERP\releases\1.0.7\dist\runtime\apps\server\index.js"'
$wa = Process-Row 21 20 'node.exe whatsapp-worker/index.js'

$script:processes = @($renderer, $browser, $worker)
if (@(Get-InstallProcessesForShutdownCheck 'unused' -BackendOnly).Count -ne 0) { throw 'Independent Gemini tree falsely blocks backend shutdown.' }
if (@(Get-InstallProcessesForShutdownCheck 'unused').Count -ne 3) { throw 'Full shutdown must still detect the Gemini tree.' }

$script:processes = @($worker, $browser, $server, $wa)
$backend = @(Get-InstallProcessesForShutdownCheck 'unused' -BackendOnly)
if ($backend.Count -ne 2 -or $backend[0].ProcessId -ne 20 -or $backend[1].ProcessId -ne 21) { throw 'Orphaned backend or WhatsApp child was hidden.' }

# If the worker is gone but its browser remains, it is an orphan, not an exemption.
$script:processes = @($browser, $renderer)
if (@(Get-InstallProcessesForShutdownCheck 'unused' -BackendOnly).Count -ne 2) { throw 'Orphaned browser was incorrectly ignored.' }

$script:processes = @()
if (@(Get-InstallProcessesForShutdownCheck 'unused').Count -ne 0) { throw 'Empty process list should pass shutdown checks.' }
Write-Host 'PASS: backend restarts allow the independent Gemini tree; full shutdown and orphan checks remain strict.'
