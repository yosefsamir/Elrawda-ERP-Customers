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
  assert.match(issContent, /PrivilegesRequiredOverridesAllowed=no/, 'Privilege override must be disabled');
  assert.match(issContent, /ArchitecturesAllowed=x64compatible/, 'Must target 64-bit architectures');
  
  // Check PowerShell execution policy bypass scoping
  assert.match(issContent, /-NoProfile -NonInteractive -ExecutionPolicy Bypass -File/, 'Must use process-scoped ExecutionPolicy Bypass');
  assert.match(issContent, /install\.ps1/, 'Must reference install.ps1');
  assert.match(issContent, /-Upgrade/, 'Must support -Upgrade switch when existing installation is detected');
  
  // Check error handling and log reporting
  assert.match(issContent, /ResultCode <> 0/, 'Must detect non-zero exit codes');
  assert.match(issContent, /install\.log/, 'Must report install.log path on error');
  assert.match(issContent, /Abort;/, 'Must abort setup on non-zero exit code');

  // Check URL launching
  assert.match(issContent, /http:\/\/127\.0\.0\.1:3211/, 'Must target local web UI port 3211');
  assert.match(issContent, /InstallSucceeded/, 'Web launcher must be conditional on install success');

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
  assert.doesNotMatch(commonPs1, /npm ci/, 'common.ps1 must never execute npm ci on customer computers');
});
