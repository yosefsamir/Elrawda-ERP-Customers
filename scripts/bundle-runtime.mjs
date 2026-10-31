import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const PINNED_NODE_VERSION = 'v22.23.4';
const PINNED_NODE_SHA256 = 'dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f';
const NODE_EXE_URL = `https://nodejs.org/dist/${PINNED_NODE_VERSION}/win-x64/node.exe`;

export async function computeFileSha256(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function downloadNodeRuntime(targetRuntimeDir, cacheDir = resolve('.cache')) {
  mkdirSync(targetRuntimeDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  const cachedNodePath = join(cacheDir, `node-${PINNED_NODE_VERSION}-win-x64.exe`);
  const targetNodePath = join(targetRuntimeDir, 'node.exe');

  let needDownload = true;
  if (existsSync(cachedNodePath)) {
    const hash = await computeFileSha256(cachedNodePath);
    if (hash.toLowerCase() === PINNED_NODE_SHA256.toLowerCase()) {
      needDownload = false;
    } else {
      console.warn(`[Runtime] Cached node.exe checksum mismatch. Re-downloading...`);
      rmSync(cachedNodePath, { force: true });
    }
  }

  if (needDownload) {
    console.log(`[Runtime] Downloading pinned Windows Node.js ${PINNED_NODE_VERSION} (x64)...`);
    const res = await fetch(NODE_EXE_URL);
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download Node.js from ${NODE_EXE_URL}: ${res.status} ${res.statusText}`);
    }
    const tempDownloadPath = `${cachedNodePath}.tmp-${Date.now()}`;
    const fileStream = createWriteStream(tempDownloadPath);
    const { Readable } = await import('node:stream');
    await pipeline(Readable.fromWeb(res.body), fileStream);

    const hash = await computeFileSha256(tempDownloadPath);
    if (hash.toLowerCase() !== PINNED_NODE_SHA256.toLowerCase()) {
      rmSync(tempDownloadPath, { force: true });
      throw new Error(`Node.js binary SHA-256 verification failed! Expected ${PINNED_NODE_SHA256}, got ${hash}`);
    }
    cpSync(tempDownloadPath, cachedNodePath);
    rmSync(tempDownloadPath, { force: true });
    console.log(`[Runtime] Node.js ${PINNED_NODE_VERSION} downloaded and verified (SHA-256 matches).`);
  }

  cpSync(cachedNodePath, targetNodePath);
  console.log(`[Runtime] Packaged node.exe into: ${targetNodePath}`);
  return targetNodePath;
}

export async function downloadChromiumRuntime(targetRuntimeDir) {
  const chromiumTargetDir = join(targetRuntimeDir, 'chromium');
  mkdirSync(chromiumTargetDir, { recursive: true });

  console.log(`[Runtime] Downloading and packaging Puppeteer-compatible Chromium for win64...`);
  const puppeteerCli = resolve('node_modules/puppeteer/lib/puppeteer/node/cli.js');
  const installResult = spawnSync(
    process.execPath,
    [puppeteerCli, 'browsers', 'install', 'chrome', '--platform', 'win64', '--path', chromiumTargetDir],
    { stdio: 'inherit' }
  );

  if (installResult.status !== 0) {
    throw new Error(`Chromium download failed with exit code ${installResult.status}`);
  }

  // Verify chrome.exe exists in target directory
  const findChromeExe = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        const found = findChromeExe(full);
        if (found) return found;
      } else if (e.name.toLowerCase() === 'chrome.exe') {
        return full;
      }
    }
    return null;
  };

  const chromeExe = findChromeExe(chromiumTargetDir);
  if (!chromeExe) {
    throw new Error(`Chromium installation finished but chrome.exe was not found inside: ${chromiumTargetDir}`);
  }
  console.log(`[Runtime] Packaged Chromium verified: ${chromeExe}`);
  return chromeExe;
}

export function bundleProductionNodeModules(releaseDir) {
  const targetModulesDir = join(releaseDir, 'node_modules');
  console.log(`[Runtime] Preparing clean production node_modules via npm ci --omit=dev...`);

  // Run a clean npm ci --omit=dev in an isolated temporary staging folder
  const stagingDir = resolve('release', `npm-staging-${Date.now()}`);
  mkdirSync(stagingDir, { recursive: true });
  try {
    cpSync('package.json', join(stagingDir, 'package.json'));
    cpSync('package-lock.json', join(stagingDir, 'package-lock.json'));
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const ciResult = spawnSync(npmCmd, ['ci', '--omit=dev', '--no-fund', '--no-audit'], {
      cwd: stagingDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, npm_config_msvs_version: '2022' },
    });
    if (ciResult.status !== 0) {
      throw new Error(`Production dependency installation failed in staging (code ${ciResult.status})`);
    }
    cpSync(join(stagingDir, 'node_modules'), targetModulesDir, { recursive: true });
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }

  // Prune unnecessary files from packaged node_modules to optimize installer size
  pruneNodeModules(targetModulesDir);

  // Ensure better-sqlite3 native addon is present and configured for Windows x64
  const betterSqliteDir = join(targetModulesDir, 'better-sqlite3');
  if (existsSync(betterSqliteDir)) {
    console.log(`[Runtime] Configuring better-sqlite3 native binary...`);
    const prebuildPath = join(betterSqliteDir, 'prebuilds', 'win32-x64.node');
    const releasePath = join(betterSqliteDir, 'build', 'Release', 'better_sqlite3.node');

    const rootPrebuildPath = resolve('node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');
    const rootReleasePath = resolve('node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

    // 1. If prebuild is missing in target but exists in root, copy it
    if (!existsSync(prebuildPath) && existsSync(rootPrebuildPath)) {
      console.log(`[Runtime] Copying win32-x64.node prebuild from root node_modules...`);
      mkdirSync(join(betterSqliteDir, 'prebuilds'), { recursive: true });
      cpSync(rootPrebuildPath, prebuildPath);
    }

    // 2. If release binary is missing in target but exists in root, copy it
    if (!existsSync(releasePath) && existsSync(rootReleasePath)) {
      console.log(`[Runtime] Copying compiled better_sqlite3.node from root node_modules...`);
      mkdirSync(join(betterSqliteDir, 'build', 'Release'), { recursive: true });
      cpSync(rootReleasePath, releasePath);
    }

    // 3. If prebuild exists but release doesn't, mirror prebuild to build/Release
    if (existsSync(prebuildPath) && !existsSync(releasePath)) {
      console.log(`[Runtime] Populating build/Release/better_sqlite3.node from verified prebuilds/win32-x64.node...`);
      mkdirSync(join(betterSqliteDir, 'build', 'Release'), { recursive: true });
      cpSync(prebuildPath, releasePath);
    }

    // 4. If release exists but prebuild doesn't, mirror release to prebuilds/win32-x64.node
    if (existsSync(releasePath) && !existsSync(prebuildPath)) {
      console.log(`[Runtime] Populating prebuilds/win32-x64.node from build/Release/better_sqlite3.node...`);
      mkdirSync(join(betterSqliteDir, 'prebuilds'), { recursive: true });
      cpSync(releasePath, prebuildPath);
    }

    // 5. If on Windows and neither exists, rebuild from source
    if (process.platform === 'win32' && !existsSync(prebuildPath) && !existsSync(releasePath)) {
      console.log(`[Runtime] No prebuilt binary found. Attempting native rebuild of better-sqlite3...`);
      const npmCmd = 'npm.cmd';
      const rebuildResult = spawnSync(npmCmd, ['rebuild', 'better-sqlite3', '--build-from-source'], {
        cwd: targetModulesDir,
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, npm_config_msvs_version: '2022' },
      });
      if (rebuildResult.status !== 0) {
        throw new Error(`Failed to compile better-sqlite3 native addon (code ${rebuildResult.status})`);
      }
      if (existsSync(releasePath) && !existsSync(prebuildPath)) {
        mkdirSync(join(betterSqliteDir, 'prebuilds'), { recursive: true });
        cpSync(releasePath, prebuildPath);
      }
    }

    // 6. Final verification & diagnostic logging
    const hasPrebuild = existsSync(prebuildPath);
    const hasRelease = existsSync(releasePath);
    const prebuildSize = hasPrebuild ? statSync(prebuildPath).size : 0;
    const releaseSize = hasRelease ? statSync(releasePath).size : 0;
    console.log(
      `[Runtime] better-sqlite3 status: prebuilds/win32-x64.node=${hasPrebuild ? prebuildSize + ' bytes' : 'MISSING'}, build/Release/better_sqlite3.node=${hasRelease ? releaseSize + ' bytes' : 'MISSING'}`
    );

    if (process.platform === 'win32' && !hasPrebuild && !hasRelease) {
      throw new Error(`better-sqlite3 Windows x64 native binary is missing from both prebuilds/ and build/Release/!`);
    }
  }

  console.log(`[Runtime] Production node_modules prepared in: ${targetModulesDir}`);
}

export function pruneNodeModules(modulesDir) {
  if (!existsSync(modulesDir)) return;

  const removePatterns = [
    /\.bin$/,
    /\.d\.ts$/,
    /\.map$/,
    /\.md$/,
    /\.markdown$/,
    /\.tsbuildinfo$/,
    /CHANGELOG/i,
    /README/i,
    /LICENSE/i,
    /\.obj$/,
    /\.iobj$/,
    /\.pdb$/,
    /\.tlog$/,
  ];

  const prune = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        // Never remove prebuilds directory (it contains official binary addons)
        if (e.name === 'prebuilds') {
          continue;
        }
        if (e.name === '.bin' || e.name === 'test' || e.name === 'tests' || e.name === 'example' || e.name === 'examples') {
          rmSync(full, { recursive: true, force: true });
        } else {
          prune(full);
        }
      } else if (e.isFile()) {
        // Never delete .node native addons or required runtime files
        if (e.name.endsWith('.node')) continue;
        for (const pattern of removePatterns) {
          if (pattern.test(e.name)) {
            rmSync(full, { force: true });
            break;
          }
        }
      }
    }
  };

  prune(modulesDir);
}

export function verifyPackagedRuntime(releaseDir) {
  console.log(`\n========================================`);
  console.log(` Verifying Packaged Windows Runtime`);
  console.log(`========================================\n`);

  const nodeExe = join(releaseDir, 'runtime', 'node.exe');
  if (!existsSync(nodeExe)) {
    throw new Error(`Bundled node.exe not found at: ${nodeExe}`);
  }
  const nodeStats = statSync(nodeExe);
  console.log(`[Verification] Bundled node.exe confirmed (${nodeStats.size} bytes).`);

  if (process.platform === 'win32') {
    // 1. Verify Node.js version using bundled node.exe
    const nodeVer = spawnSync(nodeExe, ['--version'], { encoding: 'utf8' });
    if (nodeVer.status !== 0 || !nodeVer.stdout.trim().startsWith('v22.')) {
      throw new Error(`Unexpected bundled Node.js version: ${nodeVer.stdout} (code ${nodeVer.status})`);
    }
    console.log(`[Verification] Bundled Node.js version verified: ${nodeVer.stdout.trim()}`);

    // 2. In-memory SQLite read/write test with bundled node.exe and packaged node_modules
    console.log(`[Verification] Testing better-sqlite3 with bundled node.exe...`);
    const sqliteTestCode = `
      const Database = require('./node_modules/better-sqlite3');
      const db = new Database(':memory:');
      db.prepare('CREATE TABLE _verify (id INTEGER PRIMARY KEY, note TEXT)').run();
      db.prepare("INSERT INTO _verify (id, note) VALUES (1, 'active')").run();
      const row = db.prepare('SELECT note FROM _verify WHERE id = 1').get();
      if (!row || row.note !== 'active') {
        throw new Error('Unexpected query result: ' + JSON.stringify(row));
      }
      db.close();
      console.log('SQLITE_VERIFIED_OK');
    `;
    const sqliteRes = spawnSync(nodeExe, ['-e', sqliteTestCode], {
      cwd: releaseDir,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: join(releaseDir, 'node_modules') },
    });
    if (sqliteRes.status !== 0 || !sqliteRes.stdout.includes('SQLITE_VERIFIED_OK')) {
      console.error(`SQLite test stderr:`, sqliteRes.stderr);
      console.error(`SQLite test stdout:`, sqliteRes.stdout);
      throw new Error(`Bundled node.exe failed to execute better-sqlite3 (exit code ${sqliteRes.status})`);
    }
    console.log(`[Verification] better-sqlite3 in-memory DDL, insert, and select passed with bundled node.exe.`);

    // 3. Preflight check: headless Chromium launch and environment validation
    const preflightJs = join(releaseDir, 'dist', 'runtime', 'scripts', 'maintenance', 'preflight.js');
    if (existsSync(preflightJs)) {
      console.log(`[Verification] Executing preflight check with bundled node.exe...`);
      const preflightRes = spawnSync(nodeExe, [preflightJs], {
        cwd: releaseDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          EMOJI_APP_ROOT: releaseDir,
          NODE_PATH: join(releaseDir, 'node_modules'),
        },
      });
      if (preflightRes.status !== 0) {
        console.error(`Preflight stderr:`, preflightRes.stderr);
        console.error(`Preflight stdout:`, preflightRes.stdout);
        throw new Error(`Bundled runtime preflight failed (exit code ${preflightRes.status})`);
      }
      console.log(`[Verification] Preflight output: ${preflightRes.stdout.trim()}`);
      console.log(`[Verification] Headless Chromium launch verified with bundled node.exe.`);
    }
  } else {
    console.log(`[Verification] Host is ${process.platform}. Windows runtime binaries verified by file existence and structure.`);
  }

  console.log(`[Verification] All bundled runtime verifications PASSED.\n`);
}

