; WhatsApp-ERP Inno Setup Script
; Builds Windows Setup executable: WhatsAppERP-Setup-1.0.0-rc.1.exe

#define MyAppName "WhatsApp-ERP"
#define MyAppVersion "1.0.0-rc.1"
#define MyAppPublisher "WhatsApp-ERP Team"
#define MyAppURL "http://127.0.0.1:3211"
#define MyAppId "{8B2F354D-9321-4F2A-A04E-5D345ECB901C}"
#define MyReleaseDir "..\release\whatsapp-erp-windows-1.0.0-rc.1"

[Setup]
AppId={{#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName=C:\WhatsApp-ERP
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=no
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=WhatsAppERP-Setup-{#MyAppVersion}
OutputDir=..\release
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=100
ShowLanguageDialog=no
SetupLogging=yes
CloseApplications=no
RestartApplications=no
Uninstallable=yes
CreateUninstallRegKey=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut to Web Management Interface"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
; Extract release payload into a temporary directory that is automatically purged after install
Source: "{#MyReleaseDir}\*"; DestDir: "{tmp}\WhatsAppERP-Payload"; Flags: ignoreversion recursesubdirs createallsubdirs deleteafterinstall

[Icons]
Name: "{autoprograms}\{#MyAppName}\WhatsApp-ERP Web Interface"; Filename: "{#MyAppURL}"
Name: "{autoprograms}\{#MyAppName}\Installation Logs"; Filename: "{commonappdata}\WhatsApp-ERP\logs"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{#MyAppURL}"; Tasks: desktopicon

[Run]
; Offer to open the web management interface on success
Filename: "{#MyAppURL}"; Description: "Open WhatsApp-ERP Web Interface ({#MyAppURL})"; Flags: postinstall shellexec nowait; Check: InstallSucceeded

[UninstallRun]
; Safely stop and unregister scheduled tasks upon uninstallation without deleting persistent state
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ""try { Stop-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName 'WhatsAppERPOperations' -Confirm:$false -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName 'WhatsAppERPOperationsBackup' -Confirm:$false -ErrorAction SilentlyContinue } catch {}"""; Flags: runhidden; RunOnceId: "UnregisterScheduledTasks"

[Code]
var
  InstallSuccess: Boolean;
  IsUpgradeMode: Boolean;
  ExistingReleaseFound: Boolean;

function InstallSucceeded(): Boolean;
begin
  Result := InstallSuccess;
end;

function CheckNodeVersion(var VersionStr: String): Boolean;
var
  TmpFile: String;
  ResultCode: Integer;
  Lines: TArrayOfString;
begin
  Result := False;
  VersionStr := '';
  TmpFile := ExpandConstant('{tmp}\node_check.txt');
  DeleteFile(TmpFile);

  // Check node.exe in PATH
  if Exec(ExpandConstant('{cmd}'), '/c node.exe -v > "' + TmpFile + '" 2>&1', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    if (ResultCode = 0) and FileExists(TmpFile) then
    begin
      if LoadStringsFromFile(TmpFile, Lines) and (GetArrayLength(Lines) > 0) then
      begin
        VersionStr := Trim(Lines[0]);
        if Pos('v22.', VersionStr) = 1 then
        begin
          Result := True;
          DeleteFile(TmpFile);
          Exit;
        end;
      end;
    end;
  end;

  // Check default 64-bit Program Files location
  if FileExists(ExpandConstant('{commonpf}\nodejs\node.exe')) then
  begin
    if Exec(ExpandConstant('{commonpf}\nodejs\node.exe'), '-v > "' + TmpFile + '" 2>&1', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      if (ResultCode = 0) and FileExists(TmpFile) then
      begin
        if LoadStringsFromFile(TmpFile, Lines) and (GetArrayLength(Lines) > 0) then
        begin
          VersionStr := Trim(Lines[0]);
          if Pos('v22.', VersionStr) = 1 then
            Result := True;
        end;
      end;
    end;
  end;

  DeleteFile(TmpFile);
end;

function CheckInternetConnection(): Boolean;
var
  ResultCode: Integer;
begin
  // Fast probe: ping Cloudflare (1.1.1.1) with 1 echo and 1200ms timeout
  Result := Exec(
    ExpandConstant('{sys}\ping.exe'),
    '1.1.1.1 -n 1 -w 1200',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  ) and (ResultCode = 0);

  if not Result then
  begin
    // Fallback probe: ping Google (8.8.8.8)
    Result := Exec(
      ExpandConstant('{sys}\ping.exe'),
      '8.8.8.8 -n 1 -w 1200',
      '',
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode
    ) and (ResultCode = 0);
  end;
end;

function InitializeSetup(): Boolean;
var
  NodeVer: String;
  HasNode: Boolean;
  HasInternet: Boolean;
  ServiceJsonPath: String;
  TargetReleaseDir: String;
  Msg: String;
begin
  Result := True;
  InstallSuccess := False;
  IsUpgradeMode := False;
  ExistingReleaseFound := False;

  // Architecture check: 64-bit Windows required
  if not IsWin64 then
  begin
    SuppressibleMsgBox(
      'WhatsApp-ERP requires a 64-bit edition of Windows (x64).' + #13#10 +
      'Installation cannot continue on a 32-bit operating system.',
      mbCriticalError, MB_OK
    );
    Result := False;
    Exit;
  end;

  // Check for existing installation and exact version conflict
  ServiceJsonPath := ExpandConstant('{commonappdata}\WhatsApp-ERP\service.json');
  TargetReleaseDir := 'C:\WhatsApp-ERP\releases\' + '{#MyAppVersion}';

  if FileExists(ServiceJsonPath) then
  begin
    IsUpgradeMode := True;
    if DirExists(TargetReleaseDir) then
    begin
      ExistingReleaseFound := True;
      if SuppressibleMsgBox(
        'WhatsApp-ERP version {#MyAppVersion} is already installed on this machine.' + #13#10#13#10 +
        'Location: ' + TargetReleaseDir + #13#10 +
        'State: ' + ExpandConstant('{commonappdata}\WhatsApp-ERP') + #13#10#13#10 +
        'The background service (WhatsAppERPOperations) is configured.' + #13#10 +
        'To open the web management interface, go to {#MyAppURL}.' + #13#10#13#10 +
        'Do you want to re-run the deployment verification?',
        mbConfirmation, MB_YESNO
      ) = IDNO then
      begin
        Result := False;
        Exit;
      end;
    end;
  end;

  // Check Node.js and Internet prerequisites
  HasNode := CheckNodeVersion(NodeVer);
  HasInternet := CheckInternetConnection();

  if not HasNode then
  begin
    if HasInternet then
    begin
      Log('Node.js 22 not found. Internet is available; install.ps1 will automatically download Node.js 22 LTS.');
    end
    else
    begin
      Msg := 'Prerequisite Warning:' + #13#10#13#10 +
             'Node.js 22 (x64) is required but was not detected, and an active internet connection could not be verified.' + #13#10#13#10 +
             'WhatsApp-ERP requires Node.js 22.22+ and internet access to download necessary runtime packages (Chromium).' + #13#10#13#10 +
             'If this server is offline, please pre-install Node.js 22 x64 before proceeding.' + #13#10#13#10 +
             'Do you want to continue anyway?';
      if SuppressibleMsgBox(Msg, mbConfirmation, MB_YESNO) = IDNO then
      begin
        Result := False;
        Exit;
      end;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  PowerShellExe: String;
  ScriptPath: String;
  WorkingDir: String;
  Params: String;
  ResultCode: Integer;
  LogPath: String;
  ShowMode: Integer;
  ShowConsole: Boolean;
begin
  if CurStep = ssPostInstall then
  begin
    PowerShellExe := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
    ScriptPath := ExpandConstant('{tmp}\WhatsAppERP-Payload\scripts\windows\install.ps1');
    WorkingDir := ExpandConstant('{tmp}\WhatsAppERP-Payload\scripts\windows');
    LogPath := ExpandConstant('{commonappdata}\WhatsApp-ERP\logs\install.log');

    // Update wizard UI to show deployment progress
    WizardForm.StatusLabel.Caption := 'Executing production deployment script...';
    WizardForm.FilenameLabel.Caption := 'Installing runtime dependencies, Chromium, and scheduled tasks...';
    WizardForm.ProgressGauge.Style := npbstMarquee;

    // Check if user requested console visibility via /SHOWCONSOLE or /DEBUG
    ShowConsole := ExpandConstant('{param:SHOWCONSOLE|0}') = '1';
    if ShowConsole then
      ShowMode := SW_SHOWNORMAL
    else
      ShowMode := SW_HIDE;

    // Build process-scoped execution policy command
    Params := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ScriptPath + '"';
    if IsUpgradeMode then
      Params := Params + ' -Upgrade';

    Log('Executing: ' + PowerShellExe + ' ' + Params);

    // Run powershell.exe and wait until terminated
    if not Exec(PowerShellExe, Params, WorkingDir, ShowMode, ewWaitUntilTerminated, ResultCode) then
    begin
      InstallSuccess := False;
      SuppressibleMsgBox(
        'Failed to launch PowerShell deployment process.' + #13#10#13#10 +
        'Executable: ' + PowerShellExe + #13#10 +
        'System Error: ' + SysErrorMessage(ResultCode) + #13#10#13#10 +
        'Please ensure Windows PowerShell 5.1 or newer is available.',
        mbCriticalError, MB_OK
      );
      Abort;
    end;

    if ResultCode <> 0 then
    begin
      InstallSuccess := False;
      SuppressibleMsgBox(
        'Installation failed with error code ' + IntToStr(ResultCode) + '.' + #13#10#13#10 +
        'The deployment script encountered an error and could not complete.' + #13#10#13#10 +
        'Log file location:' + #13#10 +
        LogPath + #13#10#13#10 +
        'No customer data or SQLite databases were deleted or modified.' + #13#10 +
        'Please inspect the log file, resolve the issue, and re-run setup.',
        mbError, MB_OK
      );
      Abort;
    end;

    // Mark deployment as successful
    InstallSuccess := True;
    WizardForm.ProgressGauge.Style := npbstNormal;
    WizardForm.ProgressGauge.Position := WizardForm.ProgressGauge.Max;
    WizardForm.StatusLabel.Caption := 'Installation completed successfully.';
    WizardForm.FilenameLabel.Caption := 'Services registered: WhatsAppERPOperations, WhatsAppERPOperationsBackup';
    Log('Deployment finished successfully with exit code 0.');
  end;
end;
