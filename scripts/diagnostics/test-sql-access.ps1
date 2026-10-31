# Read-only connectivity test. No ERP executables are loaded or run.
# Paste the entire & { ... } block into Windows PowerShell 5.1.
& {
    Add-Type -AssemblyName System.Data
    $sqlProbeBuilder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
    $sqlProbeBuilder.DataSource = 'lpc:localhost\SQLMOHSEN'
    $sqlProbeBuilder.InitialCatalog = 'master'
    $sqlProbeBuilder.IntegratedSecurity = $false
    $sqlProbeBuilder.UserID = 'sa'
    $sqlProbeBuilder.ConnectTimeout = 5
    $sqlProbeBuilder.Pooling = $false
    $sqlProbeBuilder.ApplicationName = 'ElrawdaReadOnlyProbe'
    $sqlProbeSecret = Read-Host 'SQL password' -AsSecureString
    $sqlProbeCredential = New-Object System.Management.Automation.PSCredential ('sa', $sqlProbeSecret)
    $sqlProbeBuilder.Password = $sqlProbeCredential.GetNetworkCredential().Password
    $sqlProbeConnection = New-Object System.Data.SqlClient.SqlConnection $sqlProbeBuilder.ConnectionString
    $sqlProbeBuilder.Password = ''
    try {
        $sqlProbeConnection.Open()
        Write-Host 'CONNECTION: OK'
        $sqlProbeCommand = $sqlProbeConnection.CreateCommand()
        $sqlProbeCommand.CommandTimeout = 5
        $sqlProbeCommand.CommandText = 'SELECT name, state_desc FROM sys.databases WHERE database_id > 4 ORDER BY name'
        $sqlProbeReader = $sqlProbeCommand.ExecuteReader()
        try {
            while ($sqlProbeReader.Read()) {
                Write-Host ($sqlProbeReader.GetString(0) + ' | ' + $sqlProbeReader.GetString(1))
            }
        } finally { $sqlProbeReader.Dispose() }
    } catch {
        Write-Host 'TEST ERROR:'
        Write-Host $_.Exception.GetBaseException().Message
    } finally {
        $sqlProbeConnection.Dispose()
        $sqlProbeCredential = $null
        $sqlProbeSecret.Dispose()
    }
}
