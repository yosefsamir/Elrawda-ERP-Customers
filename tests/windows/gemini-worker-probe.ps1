# Offline check of the installed worker's real Windows token, DPAPI cookie
# persistence and ACLs. Uses a separate disposable profile, never the Google login.
param(
    [Parameter(Mandatory = $true)][string]$ReleasePath,
    [Parameter(Mandatory = $true)][string]$StateRoot
)
. (Join-Path $ReleasePath 'scripts\windows\common.ps1')
Assert-Administrator
$config = Read-ServiceConfig $StateRoot
$credential = Read-GeminiWorkerCredential $StateRoot
if (-not $credential) { throw 'Gemini worker credential is unavailable for the Windows probe.' }
$probeDir = Join-Path (Get-GeminiWorkerRoot $StateRoot) ('temp\windows-probe-' + [guid]::NewGuid().ToString('N'))
$taskName = 'WhatsAppERPGeminiProbe-' + [guid]::NewGuid().ToString('N')
$node = Get-NodePath $ReleasePath
New-Item -ItemType Directory -Path $probeDir -Force | Out-Null
$script = Join-Path $probeDir 'probe.mjs'
@'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
const [release, state, dir, mode, chrome] = process.argv.slice(2);
process.env.TEMP = dir;
process.env.TMP = dir;
const require = createRequire(join(release, 'package.json'));
const { chromium } = require('playwright');
let context;
const result = { ok: false, mode, user: userInfo().username };
try {
  context = await chromium.launchPersistentContext(join(dir, 'profile'), {
    executablePath: chrome, headless: true,
    args: ['--no-first-run', '--disable-dev-shm-usage'],
  });
  if (mode === 'seed') {
    await context.addCookies([{ name: 'windows_probe', value: 'persisted', url: 'http://127.0.0.1', expires: Math.floor(Date.now() / 1000) + 3600 }]);
  } else {
    assert.ok((await context.cookies('http://127.0.0.1')).some(c => c.name === 'windows_probe' && c.value === 'persisted'), 'scheduled worker could not decrypt the saved profile cookie');
    assert.ok(readFileSync(join(state, 'gemini-bridge.json')).length > 0, 'bridge token must be readable');
    for (const file of [join(state, 'data', 'app.sqlite'), join(state, 'gemini-worker', 'admin-only', 'worker-cred.dpapi')]) {
      assert.throws(() => readFileSync(file), e => e.code === 'EACCES' || e.code === 'EPERM', 'worker must not read protected state');
    }
    assert.throws(() => {
      const fd = openSync(join(state, 'service.json'), 'r+');
      closeSync(fd);
    }, e => e.code === 'EACCES' || e.code === 'EPERM', 'worker must not write service configuration');
  }
  result.ok = true;
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  await context?.close();
  writeFileSync(join(dir, mode + '.json'), JSON.stringify(result));
}
'@ | Set-Content -LiteralPath $script -Encoding ASCII

try {
    $chrome = Get-ChromiumPath $ReleasePath
    $baseArgs = '"{0}" "{1}" "{2}" "{3}"' -f $script, $ReleasePath, $StateRoot, $probeDir
    $seedArgs = $baseArgs + (' seed "{0}"' -f $chrome)
    # Mirrors the user/profile loading used by Gemini Web Login.
    $seed = Start-Process -FilePath $node -ArgumentList $seedArgs -Credential $credential -LoadUserProfile -WorkingDirectory $probeDir -WindowStyle Hidden -PassThru
    if (-not $seed.WaitForExit(30000)) { throw 'Windows Gemini profile seed timed out.' }
    $seedFile = Join-Path $probeDir 'seed.json'
    if (-not (Test-Path -LiteralPath $seedFile)) { throw 'Windows Gemini profile seed did not produce a result.' }
    $seedResult = Get-Content -LiteralPath $seedFile -Raw | ConvertFrom-Json
    if (-not $seedResult.ok) { throw "Windows Gemini profile seed failed: $($seedResult.error)" }

    $action = New-ScheduledTaskAction -Execute $node -Argument ($baseArgs + (' verify "{0}"' -f $chrome)) -WorkingDirectory $probeDir
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Settings $settings -User $credential.UserName -Password ($credential.GetNetworkCredential().Password) -RunLevel Limited -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $verifyFile = Join-Path $probeDir 'verify.json'
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path -LiteralPath $verifyFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-Path -LiteralPath $verifyFile)) { throw 'Scheduled Windows Gemini profile verification timed out.' }
    $verified = Get-Content -LiteralPath $verifyFile -Raw | ConvertFrom-Json
    if (-not $verified.ok) { throw "Scheduled Windows Gemini profile verification failed: $($verified.error)" }
    if ($verified.user -ine (Get-GeminiWorkerUserName $config)) { throw "Wrong Windows worker identity: $($verified.user)" }
    Write-Host 'PASS: dedicated Windows user launched Chromium, decrypted its saved cookie in a Password scheduled task, and respected state ACLs.' -ForegroundColor Green
} finally {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    # Include children on failure, constrained to this probe's unique directory.
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($probeDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue
}
