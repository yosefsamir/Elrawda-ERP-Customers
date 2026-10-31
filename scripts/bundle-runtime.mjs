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
  console.log(`[Runtime] Preparing clean production node_modules...`);

  if (process.platform === 'win32') {
    // On Windows, run a clean npm ci --omit=dev in an isolated temporary staging folder
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
  } else {
    // If running on non-Windows (e.g. Linux development build)
    const rootModules = resolve('node_modules');
    if (existsSync(rootModules)) {
      console.log(`[Runtime] Copying production dependencies from root node_modules...`);
      // Read production package dependencies
      const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
      const prodDeps = Object.keys(pkg.dependencies || {});
      mkdirSync(targetModulesDir, { recursive: true });
      for (const dep of prodDeps) {
        const src = join(rootModules, dep);
        if (existsSync(src)) {
          cpSync(src, join(targetModulesDir, dep), { recursive: true });
        }
      }
      // Also copy transitive dependencies if present
      for (const entry of readdirSync(rootModules)) {
        if (entry.startsWith('@')) {
          const scopeDir = join(rootModules, entry);
          for (const sub of readdirSync(scopeDir)) {
            const dest = join(targetModulesDir, entry, sub);
            if (!existsSync(dest)) {
              mkdirSync(join(targetModulesDir, entry), { recursive: true });
              cpSync(join(scopeDir, sub), dest, { recursive: true });
            }
          }
        }
      }
    }
  }

  // Prune unnecessary files from packaged node_modules to optimize installer size
  pruneNodeModules(targetModulesDir);

  // If on Windows, ensure better-sqlite3 native addon was compiled
  if (process.platform === 'win32') {
    const nativeAddon = join(targetModulesDir, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    if (!existsSync(nativeAddon)) {
      throw new Error(`better-sqlite3 native addon missing at: ${nativeAddon}`);
    }
    console.log(`[Runtime] better-sqlite3 native Windows x64 addon verified.`);
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
        if (e.name === '.bin' || e.name === 'test' || e.name === 'tests' || e.name === 'example' || e.name === 'examples') {
          rmSync(full, { recursive: true, force: true });
        } else {
          prune(full);
        }
      } else if (e.isFile()) {
        // Never delete better_sqlite3.node or required runtime files
        if (e.name === 'better_sqlite3.node') continue;
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

