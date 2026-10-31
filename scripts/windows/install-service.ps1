param([string]$InstallRoot='C:\WhatsApp-ERP',[string]$StateRoot="$env:ProgramData\WhatsApp-ERP",[int]$Port=3211)
& (Join-Path $PSScriptRoot 'install.ps1') -InstallRoot $InstallRoot -StateRoot $StateRoot -Port $Port
