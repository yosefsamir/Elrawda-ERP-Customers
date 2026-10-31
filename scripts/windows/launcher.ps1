param([string]$StateRoot = "$env:ProgramData\WhatsApp-ERP")
$ErrorActionPreference = 'Stop'
$flag = Join-Path $StateRoot 'maintenance.flag'
$logs = Join-Path $StateRoot 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
while ($true) {
    if (Test-Path $flag) { Start-Sleep -Seconds 1; continue }
    try {
        $config = Get-Content (Join-Path $StateRoot 'service.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $env:EMOJI_DATA_DIR = $config.DataDir
        $env:PUPPETEER_CACHE_DIR = $config.CacheDir
        $env:PORT = [string]$config.Port
        $env:NODE_ENV = 'production'
        $env:EMOJI_APP_ROOT = $config.ReleasePath
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $entry = Join-Path $config.ReleasePath 'dist\runtime\apps\server\index.js'
        $child = Start-Process -FilePath $config.NodePath -ArgumentList ('"{0}"' -f $entry) -WorkingDirectory $config.ReleasePath -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs "$stamp.out.log") -RedirectStandardError (Join-Path $logs "$stamp.err.log")
        $child.WaitForExit()
        Get-ChildItem $logs -File | Sort-Object LastWriteTime -Descending | Select-Object -Skip 60 | Remove-Item -Force
    } catch {
        Add-Content -LiteralPath (Join-Path $logs 'launcher.log') -Value "$(Get-Date -Format o) $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 5
}
