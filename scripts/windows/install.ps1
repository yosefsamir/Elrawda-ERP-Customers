param(
    [string]$InstallRoot = 'C:\WhatsApp-ERP',
    [string]$StateRoot = "$env:ProgramData\WhatsApp-ERP",
    [int]$Port = 3211,
    [switch]$Upgrade
)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator

$logDir = Join-Path $StateRoot 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'install.log'
try { Start-Transcript -Path $logFile -Append -Force | Out-Null } catch {}

try {
    $packageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    Verify-Release $packageRoot
    if (Test-Path (Join-Path $StateRoot 'service.json')) {
        if ($Upgrade) {
            Write-Host "Existing installation detected in $StateRoot. Running safe zero-data-loss upgrade..." -ForegroundColor Cyan
            & (Join-Path $PSScriptRoot 'update.ps1') -StateRoot $StateRoot -InstallRoot $InstallRoot
            exit $LASTEXITCODE
        }
        throw 'Already installed. Use update.ps1 or run install.ps1 with -Upgrade for updates; existing customer data has not been changed.'
    }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is already in use." }
    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Host "Node.js was not found on this machine. Automatically preparing Node.js 22 LTS..." -ForegroundColor Yellow
        $nodeInstalled = $false
        
        # 1. Try winget if available
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if ($winget) {
            Write-Host "Installing Node.js 22 LTS via Windows Package Manager (winget)..." -ForegroundColor Cyan
            & winget.exe install OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
            if ($nodeCmd) { $nodeInstalled = $true }
        }

        # 2. Fallback to direct MSI download from official nodejs.org
        if (-not $nodeInstalled) {
            Write-Host "Downloading official Node.js 22 LTS (x64) installer from nodejs.org..." -ForegroundColor Cyan
            $msiUrl = "https://nodejs.org/dist/v22.23.4/node-v22.23.4-x64.msi"
            $tempMsi = Join-Path $env:TEMP "node-v22-setup.msi"
            try {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                Invoke-WebRequest -Uri $msiUrl -OutFile $tempMsi -UseBasicParsing
                Write-Host "Installing Node.js silently in the background..." -ForegroundColor Cyan
                $proc = Start-Process msiexec.exe -ArgumentList "/i `"$tempMsi`" /qn /norestart" -Wait -PassThru
                Remove-Item $tempMsi -Force -ErrorAction SilentlyContinue
                if ($proc.ExitCode -eq 0 -or $proc.ExitCode -eq 3010) {
                    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
                    $defaultNodePath = "$env:ProgramFiles\nodejs\node.exe"
                    if (Test-Path $defaultNodePath) {
                        $nodeCmd = Get-Item $defaultNodePath
                        $nodeInstalled = $true
                    } else {
                        $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
                        if ($nodeCmd) { $nodeInstalled = $true }
                    }
                }
            } catch {
                Write-Warning "Automatic Node.js download failed: $($_.Exception.Message)"
            }
        }

        if (-not $nodeInstalled) {
            throw "Node.js 22 is required. Please install Node.js 22 LTS (x64) from https://nodejs.org and re-run install.ps1."
        }
        Write-Host "Node.js successfully installed and ready." -ForegroundColor Green
    }
    $node = if ($nodeCmd.Source) { $nodeCmd.Source } else { $nodeCmd.FullName }
    if (Test-Path (Join-Path $StateRoot 'data\app.sqlite')) { throw 'Existing unconfigured data detected. Configure/migrate it explicitly before installation.' }
    $version = (Get-Content (Join-Path $packageRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $target = Join-Path $InstallRoot "releases\$version"
    if (Test-Path $target) { throw "Release destination already exists: $target" }
    $stage = $target + '.staging-' + [guid]::NewGuid().ToString('N')
    Copy-Release $packageRoot $stage
    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    # Customer state contains SQL credentials and WhatsApp authentication. Allow SYSTEM and administrators only.
    & icacls.exe $StateRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect the application state directory.' }
    $config = [pscustomobject]@{ ReleasePath=$target; PreviousRelease=''; NodePath=$node; DataDir=(Join-Path $StateRoot 'data'); CacheDir=(Join-Path $StateRoot 'chromium'); Port=$Port; TaskName='WhatsAppERPOperations' }
    Install-Dependencies $stage $node $config.CacheDir
    Move-Item -LiteralPath $stage -Destination $target
    Copy-Item (Join-Path $target 'scripts\windows\launcher.ps1') (Join-Path $StateRoot 'launcher.ps1') -Force
    Write-JsonFile (Join-Path $StateRoot 'service.json') $config
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -File `"$(Join-Path $StateRoot 'launcher.ps1')`" -StateRoot `"$StateRoot`"" -WorkingDirectory $StateRoot
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount
    Register-ScheduledTask -TaskName $config.TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Copy-Item (Join-Path $target 'scripts\windows\scheduled-backup.ps1') (Join-Path $StateRoot 'scheduled-backup.ps1') -Force
    $backupAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -File `"$(Join-Path $StateRoot 'scheduled-backup.ps1')`" -StateRoot `"$StateRoot`""
    $backupTrigger = New-ScheduledTaskTrigger -Daily -At '03:00'
    Register-ScheduledTask -TaskName ($config.TaskName + 'Backup') -Action $backupAction -Trigger $backupTrigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $config.TaskName
    Wait-Ready $config
    Write-Host "Installed $version. Open http://127.0.0.1:$Port on this computer. Create your administrator account. Live processing is disabled initially."
} finally {
    try { Stop-Transcript | Out-Null } catch {}
}
