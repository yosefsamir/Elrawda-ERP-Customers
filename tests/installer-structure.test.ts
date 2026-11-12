import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

test('installer files and inno setup script integrity', () => {
  const issPath = resolve(root, 'installer/WhatsAppERP.iss');
  const buildScriptPath = resolve(root, 'installer/build-installer.ps1');
  const readmePath = resolve(root, 'installer/README.md');

  assert.ok(existsSync(issPath), 'installer/WhatsAppERP.iss must exist');
  assert.ok(existsSync(buildScriptPath), 'installer/build-installer.ps1 must exist');
  assert.ok(existsSync(readmePath), 'installer/README.md must exist');

  const issContent = readFileSync(issPath, 'utf8');

  // Check version matching
  assert.match(issContent, new RegExp(`#define MyAppVersion "${pkg.version}"`), 'MyAppVersion in .iss must match package.json version');
  assert.match(issContent, /PrivilegesRequired=admin/, 'Installer must require administrative privileges');
  assert.doesNotMatch(issContent, /PrivilegesRequiredOverridesAllowed\s*=\s*(commandline|dialog)/, 'Privilege override must not be allowed');
  assert.match(issContent, /ArchitecturesAllowed=x64compatible/, 'Must target 64-bit architectures');
  
  // Check PowerShell execution policy bypass scoping
  assert.match(issContent, /-NoProfile -NonInteractive -ExecutionPolicy Bypass -File/, 'Must use process-scoped ExecutionPolicy Bypass');
  assert.match(issContent, /install\.ps1/, 'Must reference install.ps1');
  assert.match(issContent, /-Upgrade/, 'Must support -Upgrade switch when existing installation is detected');
  
  // Check error handling and log reporting
  assert.match(issContent, /ResultCode <> 0/, 'Must detect non-zero exit codes');
  assert.match(issContent, /install\.log/, 'Must report install.log path on error');
  assert.match(issContent, /PrepareToInstall/, 'Must validate deployment in PrepareToInstall');
  assert.match(issContent, /GetCustomSetupExitCode/, 'Must return custom exit code on failure');

  // Check URL launching and silent install behavior
  assert.match(issContent, /http:\/\/127\.0\.0\.1:3211/, 'Must target local web UI port 3211');
  assert.match(issContent, /InstallSucceeded/, 'Web launcher must be conditional on install success');
  assert.match(issContent, /skipifsilent/, 'Web launcher must skip launching browser in silent installs');

  // Check uninstaller configuration
  assert.match(issContent, /uninstall\.ps1/, 'Uninstaller must reference uninstall.ps1');
  assert.doesNotMatch(issContent, /^\[UninstallRun\]/m, '[UninstallRun] ignores exit codes; the helper must run from CurUninstallStepChanged');
  assert.match(issContent, /CurUninstallStep <> usUninstall/, 'Uninstall helper must run at usUninstall, where Abort stops the uninstall');

  // Verify obsolete external checks are removed
  assert.doesNotMatch(issContent, /CheckNodeVersion/, 'Must not contain obsolete external Node version checks');
  assert.doesNotMatch(issContent, /CheckInternetConnection/, 'Must not require internet connection checks');
});

test('build-installer script automation', () => {
  const buildScript = readFileSync(resolve(root, 'installer/build-installer.ps1'), 'utf8');
  assert.match(buildScript, /ISCC\.exe/i, 'Must locate ISCC.exe compiler');
  assert.match(buildScript, /release\.mjs/, 'Must invoke release packaging pipeline');
  assert.match(buildScript, /WhatsAppERP-Setup-/, 'Must build WhatsAppERP-Setup executable');
  assert.match(buildScript, /Get-FileHash.*SHA256/, 'Must generate SHA-256 hash file for installer');
  assert.match(buildScript, /\/DMyAppVersion=/, 'Must pass MyAppVersion dynamically from package.json');
});

test('install.ps1 enhancements for installer support', () => {
  const installPs1 = readFileSync(resolve(root, 'scripts/windows/install.ps1'), 'utf8');
  assert.match(installPs1, /\[switch\]\$Upgrade/, 'install.ps1 must declare [switch]$Upgrade');
  assert.match(installPs1, /Start-Transcript/, 'install.ps1 must enable transcript logging');
  assert.match(installPs1, /install\.log/, 'install.ps1 must log to install.log');
  assert.match(installPs1, /update\.ps1/, 'install.ps1 with -Upgrade must invoke update.ps1');

  // Verify that npm ci, winget, and remote downloads are eliminated
  assert.doesNotMatch(installPs1, /winget\.exe/, 'install.ps1 must never call winget on customer machines');
  assert.doesNotMatch(installPs1, /Invoke-WebRequest.*nodejs\.org/, 'install.ps1 must never download Node.js installer');
  assert.match(installPs1, /Get-NodePath/, 'install.ps1 must resolve bundled Node.js path');
  assert.match(installPs1, /Assert-ReleaseReady/, 'install.ps1 must run preflight readiness checks before activating');
});

test('common.ps1 self-contained runtime helpers', () => {
  const commonPs1 = readFileSync(resolve(root, 'scripts/windows/common.ps1'), 'utf8');
  assert.match(commonPs1, /function Get-NodePath/, 'common.ps1 must define Get-NodePath');
  assert.match(commonPs1, /function Get-ChromiumPath/, 'common.ps1 must define Get-ChromiumPath');
  assert.match(commonPs1, /function Assert-ReleaseReady/, 'common.ps1 must define Assert-ReleaseReady');
  assert.match(commonPs1, /function Ensure-GeminiWorkerAccount/, 'common.ps1 must define Ensure-GeminiWorkerAccount');
  assert.match(commonPs1, /function Ensure-GeminiWorkerBatchLogonRight/, 'common.ps1 must define Ensure-GeminiWorkerBatchLogonRight');
  assert.match(commonPs1, /function Assert-NoDenyBatchLogonConflict/, 'common.ps1 must define Assert-NoDenyBatchLogonConflict');
  assert.match(commonPs1, /function Remove-GeminiWorkerBatchLogonRight/, 'common.ps1 must define Remove-GeminiWorkerBatchLogonRight');
  assert.match(commonPs1, /function Register-GeminiWorkerTask/, 'common.ps1 must define Register-GeminiWorkerTask');
  assert.match(commonPs1, /SeDenyBatchLogonRight/, 'common.ps1 must inspect SeDenyBatchLogonRight conflicts');
  assert.match(commonPs1, /NTUSER\.DAT/, 'common.ps1 must verify NTUSER.DAT after profile initialization');
  assert.match(commonPs1, /geminiWorker\.worker\.connected/, 'Wait-Ready must verify external Gemini worker bridge connection');
  assert.doesNotMatch(commonPs1, /npm ci/, 'common.ps1 must never execute npm ci on customer computers');
});

test('dedicated Gemini worker scripts and upgrade/uninstall wiring', () => {
  const workerLauncherPath = resolve(root, 'scripts/windows/gemini-worker-launcher.ps1');
  assert.ok(existsSync(workerLauncherPath), 'scripts/windows/gemini-worker-launcher.ps1 must exist');
  const workerLauncher = readFileSync(workerLauncherPath, 'utf8');
  assert.match(workerLauncher, /GEMINI_DIRECT_PROFILE/, 'worker launcher must enforce direct profile mode');
  assert.match(workerLauncher, /worker-runner\.js/, 'worker launcher must start worker-runner.js');

  const installPs1 = readFileSync(resolve(root, 'scripts/windows/install.ps1'), 'utf8');
  assert.match(installPs1, /Ensure-GeminiWorkerAccount/, 'install.ps1 must provision dedicated Gemini worker account');
  assert.match(installPs1, /Ensure-GeminiWorkerBatchLogonRight/, 'install.ps1 must grant and verify SeBatchLogonRight');
  assert.match(installPs1, /Remove-GeminiWorkerBatchLogonRight/, 'install.ps1 fresh rollback must revert newly added SeBatchLogonRight');
  assert.match(installPs1, /Register-GeminiWorkerTask/, 'install.ps1 must register Password-logon worker task');

  const updatePs1 = readFileSync(resolve(root, 'scripts/windows/update.ps1'), 'utf8');
  assert.match(updatePs1, /Ensure-GeminiWorkerAccount/, 'update.ps1 must preserve/reuse Gemini worker account');
  assert.match(updatePs1, /Ensure-GeminiWorkerBatchLogonRight/, 'update.ps1 must grant and verify SeBatchLogonRight');
  assert.match(updatePs1, /gemini-worker-launcher\.ps1/, 'update.ps1 must update worker launcher script');

  const uninstallPs1 = readFileSync(resolve(root, 'scripts/windows/uninstall.ps1'), 'utf8');
  assert.match(uninstallPs1, /WhatsAppERPGeminiWorker/, 'uninstall.ps1 must stop & unregister worker task');
  assert.match(uninstallPs1, /Remove-GeminiWorkerBatchLogonRight/, 'uninstall.ps1 must surgically clean SeBatchLogonRight before user removal');
  assert.match(uninstallPs1, /Remove-LocalUser/, 'uninstall.ps1 must remove dedicated worker local user');

  const loginPs1 = readFileSync(resolve(root, 'scripts/windows/gemini-login.ps1'), 'utf8');
  assert.match(loginPs1, /Stop-GeminiWorkerProcess/, 'gemini-login.ps1 must stop worker before opening interactive Chrome');
  assert.match(loginPs1, /--direct-profile/, 'gemini-login.ps1 must pass --direct-profile under dedicated user');
});

test('third-party notices keep license text', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // @ts-expect-error build script has no type declarations
  const { pruneNodeModules, writeThirdPartyNotices } = await import('../scripts/bundle-runtime.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'notices-'));
  try {
    const pkg = join(dir, 'node_modules', '@scope', 'demo');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@scope/demo', version: '1.2.3', license: 'MIT' }));
    writeFileSync(join(pkg, 'LICENSE.md'), 'Copyright Demo Author');
    writeFileSync(join(pkg, 'README.md'), 'removed by prune');
    pruneNodeModules(join(dir, 'node_modules'));
    assert.equal(writeThirdPartyNotices(dir), 1);
    assert.equal(existsSync(join(pkg, 'README.md')), false, 'prune still removes documentation');
    const notices = readFileSync(join(dir, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
    assert.match(notices, /@scope\/demo@1\.2\.3 \(MIT\)/);
    assert.match(notices, /Copyright Demo Author/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
