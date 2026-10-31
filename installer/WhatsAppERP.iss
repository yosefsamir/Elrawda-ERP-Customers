; WhatsApp-ERP Inno Setup Script
; Builds Windows Setup executable: WhatsAppERP-Setup-1.0.0-rc.1.exe

#ifndef MyAppName
#define MyAppName "WhatsApp-ERP"
#endif

#ifndef MyAppVersion
#define MyAppVersion "1.0.0-rc.1"
#endif

#ifndef MyAppPublisher
#define MyAppPublisher "WhatsApp-ERP Team"
#endif

#ifndef MyAppURL
#define MyAppURL "http://127.0.0.1:3211"
#endif

#ifndef MyAppId
#define MyAppId "{8B2F354D-9321-4F2A-A04E-5D345ECB901C}"
#endif

#ifndef MyReleaseDir
#define MyReleaseDir "..\release\whatsapp-erp-windows-" + MyAppVersion
#endif

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
; Extract self-contained release payload into a temporary directory automatically purged after installation
Source: "{#MyReleaseDir}\*"; DestDir: "{tmp}\WhatsAppERP-Payload"; Flags: ignoreversion recursesubdirs createallsubdirs deleteafterinstall

[Icons]
Name: "{autoprograms}\{#MyAppName}\WhatsApp-ERP Web Interface"; Filename: "{#MyAppURL}"
Name: "{autoprograms}\{#MyAppName}\Installation Logs"; Filename: "{commonappdata}\WhatsApp-ERP\logs"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{#MyAppURL}"; Tasks: desktopicon

[Run]
; Offer to open the web management interface on success
Filename: "{#MyAppURL}"; Description: "Open WhatsApp-ERP Web Interface ({#MyAppURL})"; Flags: postinstall shellexec nowait; Check: InstallSucceeded

[UninstallRun]
; Safely stop and unregister scheduled tasks upon uninstallation without deleting persistent customer state
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ""try {{ Stop-ScheduledTask -TaskName 'WhatsAppERPOperations' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName 'WhatsAppERPOperations' -Confirm:$false -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName 'WhatsAppERPOperationsBackup' -Confirm:$false -ErrorAction SilentlyContinue }} catch {{}}"""; Flags: runhidden; RunOnceId: "UnregisterScheduledTasks"

[Code]
var
  InstallSuccess: Boolean;
  IsUpgradeMode: Boolean;
  ExistingReleaseFound: Boolean;

function InstallSucceeded(): Boolean;
begin
  Result := InstallSuccess;
end;

function InitializeSetup(): Boolean;
var
  ServiceJsonPath: String;
  TargetReleaseDir: String;
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
    WizardForm.StatusLabel.Caption := 'Executing self-contained production deployment...';
    WizardForm.FilenameLabel.Caption := 'Configuring runtime, scheduled tasks, and verifying readiness...';
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
