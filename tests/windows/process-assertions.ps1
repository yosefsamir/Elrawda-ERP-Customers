# A backend-only restart intentionally leaves the independently scheduled Gemini
# worker alive. A full shutdown/uninstall must still account for every process.
function Get-InstallProcessesForShutdownCheck([string]$InstallRoot, [switch]$BackendOnly) {
    $owned = @(Get-OwnedProcess $InstallRoot)
    if (-not $BackendOnly) { return $owned }

    $independent = [System.Collections.Generic.HashSet[uint32]]::new()
    foreach ($proc in $owned) {
        if ($proc.CommandLine -and $proc.CommandLine -match '[\\/]image-processing[\\/]worker-runner\.js(?:["\s]|$)') {
            [void]$independent.Add([uint32]$proc.ProcessId)
        }
    }
    do {
        $changed = $false
        foreach ($proc in $owned) {
            if ($independent.Contains([uint32]$proc.ParentProcessId)) {
                if ($independent.Add([uint32]$proc.ProcessId)) { $changed = $true }
            }
        }
    } while ($changed)
    return $owned | Where-Object { -not $independent.Contains([uint32]$_.ProcessId) }
}
