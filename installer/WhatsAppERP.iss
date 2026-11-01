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

[Dirs]
; install.ps1 creates {app} in PrepareToInstall, so Inno would otherwise treat it as pre-existing and keep it
Name: "{app}"; Flags: uninsalwaysuninstall

[Files]
; Shipped uninstallation script and common helpers installed to application directory for reliable task and process cleanup
Source: "{#MyReleaseDir}\scripts\windows\uninstall.ps1"; DestDir: "{app}\scripts\windows"; Flags: ignoreversion
Source: "{#MyReleaseDir}\scripts\windows\common.ps1"; DestDir: "{app}\scripts\windows"; Flags: ignoreversion
; Release payload marked dontcopy: extracted during PrepareToInstall for atomic validation before committing installation
Source: "{#MyReleaseDir}\*"; DestDir: "{tmp}\WhatsAppERP-Payload"; Flags: dontcopy recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}\WhatsApp-ERP Web Interface"; Filename: "{#MyAppURL}"
Name: "{autoprograms}\{#MyAppName}\Installation Logs"; Filename: "{commonappdata}\WhatsApp-ERP\logs"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{#MyAppURL}"; Tasks: desktopicon

[Run]
; Offer to open the web management interface on success (skipped during silent installs)
Filename: "{#MyAppURL}"; Description: "Open WhatsApp-ERP Web Interface ({#MyAppURL})"; Flags: postinstall shellexec nowait skipifsilent; Check: InstallSucceeded

[Code]
var
  InstallSuccess: Boolean;
  IsUpgradeMode: Boolean;
  IsRepairMode: Boolean;
  ExistingReleaseFound: Boolean;
  CustomExitCode: Integer;

// [UninstallRun] ignores exit codes, so the helper runs here: Abort at usUninstall stops the
// uninstall with a non-zero exit code and leaves it registered for a retry.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Params: String;
  ResultCode: Integer;
  HelperLog: String;
begin
  if CurUninstallStep <> usUninstall then
    Exit;

  HelperLog := ExpandConstant('{commonappdata}\WhatsApp-ERP\logs\uninstall.log');
  Params := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\scripts\windows\uninstall.ps1') +
            '" -InstallRoot "' + ExpandConstant('{app}') + '" -StateRoot "' + ExpandConstant('{commonappdata}\WhatsApp-ERP') + '"';
  Log('Executing uninstall helper: ' + Params);

  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, ExpandConstant('{sys}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    Log('Uninstall helper could not start: ' + SysErrorMessage(ResultCode));
    SuppressibleMsgBox('WhatsApp-ERP could not start its uninstall helper.' + #13#10#13#10 + SysErrorMessage(ResultCode), mbCriticalError, MB_OK, IDOK);
    Abort;
  end;

  Log('Uninstall helper exit code: ' + IntToStr(ResultCode));
  if ResultCode <> 0 then
  begin
    SuppressibleMsgBox(
      'WhatsApp-ERP could not be fully stopped and removed (error ' + IntToStr(ResultCode) + ').' + #13#10#13#10 +
      'Customer data has not been deleted. Close any program using the WhatsApp-ERP folder and run the uninstaller again.' + #13#10#13#10 +
      'Details: ' + HelperLog,
      mbCriticalError, MB_OK, IDOK);
    Abort;
  end;
end;

function InstallSucceeded(): Boolean;
begin
  Result := InstallSuccess;
end;

function GetCustomSetupExitCode(): Integer;
begin
  Result := CustomExitCode;
end;

function InitializeSetup(): Boolean;
var
  ServiceJsonPath: String;
  TargetReleaseDir: String;
begin
  Result := True;
  InstallSuccess := False;
  IsUpgradeMode := False;
  IsRepairMode := False;
  ExistingReleaseFound := False;

  // Architecture check: 64-bit Windows required
  if not IsWin64 then
  begin
    SuppressibleMsgBox(
      'WhatsApp-ERP requires a 64-bit edition of Windows (x64).' + #13#10 +
      'Installation cannot continue on a 32-bit operating system.',
      mbCriticalError, MB_OK, IDOK
    );
    Result := False;
    Exit;
  end;

  // Check for existing installation and exact version conflict
  ServiceJsonPath := ExpandConstant('{commonappdata}\WhatsApp-ERP\service.json');
  TargetReleaseDir := 'C:\WhatsApp-ERP\releases\' + '{#MyAppVersion}';

  if FileExists(ServiceJsonPath) then
  begin
    if DirExists(TargetReleaseDir) then
    begin
      ExistingReleaseFound := True;
      IsRepairMode := True;
      if SuppressibleMsgBox(
        'WhatsApp-ERP version {#MyAppVersion} is already installed on this machine.' + #13#10#13#10 +
        'Location: ' + TargetReleaseDir + #13#10 +
        'State: ' + ExpandConstant('{commonappdata}\WhatsApp-ERP') + #13#10#13#10 +
        'The background service (WhatsAppERPOperations) is configured.' + #13#10 +
        'To open the web management interface, go to {#MyAppURL}.' + #13#10#13#10 +
        'Do you want to repair or reinstall this version?',
        mbConfirmation, MB_YESNO, IDYES
      ) = IDNO then
      begin
        Result := False;
        Exit;
      end;
    end
    else
    begin
      IsUpgradeMode := True;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  PowerShellExe: String;
  ScriptPath: String;
  WorkingDir: String;
  Params: String;
  ResultCode: Integer;
  LogPath: String;
  ShowMode: Integer;
  ShowConsole: Boolean;
  ExtractedCount: Integer;
begin
  Result := '';
  NeedsRestart := False;

  Log('Extracting self-contained release payload for deployment verification...');
  ExtractedCount := ExtractTemporaryFiles('*');
  Log('Extracted ' + IntToStr(ExtractedCount) + ' files to temporary payload.');

  PowerShellExe := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  ScriptPath := ExpandConstant('{tmp}\WhatsAppERP-Payload\scripts\windows\install.ps1');
  WorkingDir := ExpandConstant('{tmp}\WhatsAppERP-Payload\scripts\windows');
  LogPath := ExpandConstant('{commonappdata}\WhatsApp-ERP\logs\install.log');

  // Check if user requested console visibility via /SHOWCONSOLE or /DEBUG
  ShowConsole := ExpandConstant('{param:SHOWCONSOLE|0}') = '1';
  if ShowConsole then
    ShowMode := SW_SHOWNORMAL
  else
    ShowMode := SW_HIDE;

  // Build process-scoped execution policy command
  Params := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ScriptPath + '" -InstallRoot "' + ExpandConstant('{app}') + '"';
  if IsUpgradeMode then
    Params := Params + ' -Upgrade'
  else if IsRepairMode then
    Params := Params + ' -Repair';

  Log('Executing deployment: ' + PowerShellExe + ' ' + Params);

  // Run powershell.exe and wait until terminated
  if not Exec(PowerShellExe, Params, WorkingDir, ShowMode, ewWaitUntilTerminated, ResultCode) then
  begin
    InstallSuccess := False;
    CustomExitCode := 7;
    Result := 'Failed to launch PowerShell deployment process.' + #13#10#13#10 +
              'Executable: ' + PowerShellExe + #13#10 +
              'System Error: ' + SysErrorMessage(ResultCode) + #13#10#13#10 +
              'Please ensure Windows PowerShell 5.1 or newer is available.';
    Exit;
  end;

  if ResultCode <> 0 then
  begin
    InstallSuccess := False;
    CustomExitCode := 7;
    Result := 'Installation deployment failed with error code ' + IntToStr(ResultCode) + '.' + #13#10#13#10 +
              'The deployment script encountered an error and could not complete.' + #13#10#13#10 +
              'Log file location:' + #13#10 +
              LogPath + #13#10#13#10 +
              'No customer data or SQLite databases were deleted or modified.' + #13#10 +
              'Please inspect the log file, resolve the issue, and re-run setup.';
    Exit;
  end;

  // Mark deployment as successful
  InstallSuccess := True;
  CustomExitCode := 0;
  Log('Deployment finished successfully with exit code 0.');
end;
