; WhatsApp-ERP Inno Setup Script
; Builds Windows Setup executable: WhatsAppERP-Setup-1.0.5.exe

#ifndef MyAppName
#define MyAppName "WhatsApp-ERP"
#endif

#ifndef MyAppVersion
#define MyAppVersion "1.0.5"
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

#ifndef MyPayloadArchive
#define MyPayloadArchive MyReleaseDir + ".7z"
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
DefaultDirName={sd}\WhatsApp-ERP
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=no
PrivilegesRequired=admin
MinVersion=10.0.14393
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=WhatsAppERP-Setup-{#MyAppVersion}
OutputDir=..\release
Compression=lzma2/max
SolidCompression=yes
ArchiveExtraction=enhanced/nopassword
WizardStyle=modern
WizardSizePercent=100
ShowLanguageDialog=auto
; The payload is dontcopy, so Inno counts none of it. It sits in {tmp}, staging and the release during install.
ExtraDiskSpaceRequired=2500000000
SetupLogging=yes
CloseApplications=no
RestartApplications=no
Uninstallable=yes
CreateUninstallRegKey=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "arabic"; MessagesFile: "compiler:Languages\Arabic.isl"

[CustomMessages]
english.InstallTitle=Installing WhatsApp-ERP
english.InstallDescription=This takes a few minutes. Keep this window open.
english.StagePrepare=Preparing installation files...
english.StageVerify=Checking the installation files...
english.StageCopy=Copying the application...
english.StageCheck=Checking the database engine and browser...
english.StageBrowser=Testing the browser under the service account...
english.StageBackup=Backing up your data...
english.StageService=Starting the service...
english.PayloadFailed=The installation files could not be extracted.
arabic.InstallTitle=جارٍ تثبيت WhatsApp-ERP
arabic.InstallDescription=التثبيت بياخد كام دقيقة. سيب الشاشة دي مفتوحة.
arabic.StagePrepare=تجهيز ملفات التثبيت...
arabic.StageVerify=التحقق من ملفات التثبيت...
arabic.StageCopy=نسخ البرنامج...
arabic.StageCheck=فحص قاعدة البيانات والمتصفح...
arabic.StageBrowser=اختبار المتصفح بحساب الخدمة...
arabic.StageBackup=أخذ نسخة احتياطية من بياناتك...
arabic.StageService=تشغيل الخدمة...
arabic.PayloadFailed=تعذر فك ملفات التثبيت.

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut to Web Management Interface"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Dirs]
; install.ps1 creates {app} in PrepareToInstall, so Inno would otherwise treat it as pre-existing and keep it
Name: "{app}"; Flags: uninsalwaysuninstall

[Files]
; Shipped uninstallation script and common helpers installed to application directory for reliable task and process cleanup
Source: "{#MyReleaseDir}\scripts\windows\uninstall.ps1"; DestDir: "{app}\scripts\windows"; Flags: ignoreversion
Source: "{#MyReleaseDir}\scripts\windows\common.ps1"; DestDir: "{app}\scripts\windows"; Flags: ignoreversion
Source: "{#MyReleaseDir}\scripts\windows\gemini-login.bat"; DestDir: "{app}\scripts\windows"; Flags: ignoreversion
Source: "{#MyReleaseDir}\scripts\windows\gemini-login.ps1"; DestDir: "{app}\scripts\windows"; Flags: ignoreversion
; One archive instead of thousands of files: PrepareToInstall must deploy before Setup commits anything,
; and only archive extraction can show real progress at that point
Source: "{#MyPayloadArchive}"; DestName: "payload.7z"; Flags: dontcopy nocompression

[Icons]
Name: "{autoprograms}\{#MyAppName}\WhatsApp-ERP Web Interface"; Filename: "{#MyAppURL}"
Name: "{autoprograms}\{#MyAppName}\Installation Logs"; Filename: "{commonappdata}\WhatsApp-ERP\logs"
Name: "{autoprograms}\{#MyAppName}\Gemini Web Login"; Filename: "{app}\scripts\windows\gemini-login.bat"; WorkingDir: "{app}\scripts\windows"
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
  ExtractPage: TExtractionWizardPage;
  DeployPage: TOutputProgressWizardPage;

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
  TargetReleaseDir := ExpandConstant('{sd}\WhatsApp-ERP\releases\') + '{#MyAppVersion}';

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

procedure InitializeWizard;
begin
  ExtractPage := CreateExtractionPage(CustomMessage('InstallTitle'), CustomMessage('InstallDescription'), nil);
  DeployPage := CreateOutputProgressPage(CustomMessage('InstallTitle'), CustomMessage('InstallDescription'));
end;

procedure ShowStage(const MessageName: String; const Percent: Integer);
begin
  DeployPage.SetText(CustomMessage(MessageName), '');
  DeployPage.SetProgress(Percent, 100);
end;

// install.ps1 and update.ps1 print "##stage <name>" as they reach each step
procedure OnDeployOutput(const S: String; const Error, FirstLine: Boolean);
var
  Stage: String;
begin
  Log(S);
  if Pos('##stage ', S) <> 1 then
    Exit;
  Stage := Trim(Copy(S, 9, Length(S)));
  if Stage = 'verify' then ShowStage('StageVerify', 10)
  else if Stage = 'copy' then ShowStage('StageCopy', 30)
  else if Stage = 'check' then ShowStage('StageCheck', 55)
  else if Stage = 'browser' then ShowStage('StageBrowser', 70)
  else if Stage = 'backup' then ShowStage('StageBackup', 80)
  else if Stage = 'service' then ShowStage('StageService', 90);
end;

function ExtractPayload(): String;
begin
  Result := '';
  try
    DeployPage.Show;
    try
      ShowStage('StagePrepare', 0);
      ExtractTemporaryFile('payload.7z');
    finally
      DeployPage.Hide;
    end;

    ExtractPage.Clear;
    ExtractPage.Add(ExpandConstant('{tmp}\payload.7z'), ExpandConstant('{tmp}\WhatsAppERP-Payload'), True);
    ExtractPage.Show;
    try
      ExtractPage.Extract;
    finally
      ExtractPage.Hide;
    end;
  except
    Result := CustomMessage('PayloadFailed') + #13#10#13#10 + GetExceptionMessage;
    Log(Result);
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
  Started: Boolean;
begin
  NeedsRestart := False;

  Result := ExtractPayload();
  if Result <> '' then
  begin
    CustomExitCode := 7;
    Exit;
  end;

  PowerShellExe := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  ScriptPath := ExpandConstant('{tmp}\WhatsAppERP-Payload\scripts\windows\install.ps1');
  WorkingDir := ExpandConstant('{tmp}\WhatsAppERP-Payload\scripts\windows');
  LogPath := ExpandConstant('{commonappdata}\WhatsApp-ERP\logs\install.log');

  // Build process-scoped execution policy command
  Params := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ScriptPath + '" -InstallRoot "' + ExpandConstant('{app}') + '"';
  if IsUpgradeMode then
    Params := Params + ' -Upgrade'
  else if IsRepairMode then
    Params := Params + ' -Repair';

  Log('Executing deployment: ' + PowerShellExe + ' ' + Params);

  // Waits for PowerShell while keeping the window responsive and reading its progress lines
  DeployPage.Show;
  try
    ShowStage('StageVerify', 5);
    Started := ExecAndLogOutput(PowerShellExe, Params, WorkingDir, SW_HIDE, ewWaitUntilTerminated, ResultCode, @OnDeployOutput);
  finally
    DeployPage.Hide;
  end;

  if not Started then
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
