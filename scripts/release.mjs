import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  downloadNodeRuntime,
  downloadChromiumRuntime,
  bundleProductionNodeModules,
} from './bundle-runtime.mjs';

const build = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status || 1);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const name = `whatsapp-erp-windows-${pkg.version}`;
const dir = resolve('release', name);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// Copy core application files
for (const path of ['dist', 'package.json', 'package-lock.json', 'scripts/windows']) {
  cpSync(path, resolve(dir, path), { recursive: true });
}
cpSync('docs/windows-deployment.ar.md', resolve(dir, 'WINDOWS-READ-ME.ar.md'));
writeFileSync(
  resolve(dir, 'VALIDATION.ar.md'),
  readFileSync(`docs/release-validation-${pkg.version}.ar.md`, 'utf8').replaceAll(
    'windows-deployment.ar.md',
    'WINDOWS-READ-ME.ar.md'
  )
);

// Check if bundling self-contained Windows runtime
const shouldBundleRuntime =
  process.argv.includes('--bundle-runtime') ||
  process.env.BUNDLE_RUNTIME === '1' ||
  process.platform === 'win32';

if (shouldBundleRuntime) {
  console.log(`\n========================================`);
  console.log(` Packaging Self-Contained Windows Runtime`);
  console.log(`========================================\n`);

  const runtimeDir = resolve(dir, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });

  await downloadNodeRuntime(runtimeDir);
  await downloadChromiumRuntime(runtimeDir);
  bundleProductionNodeModules(dir);
}

// Generate complete SHA-256 manifest
console.log(`\nGenerating SHA-256 release manifest...`);
const files = (folder) =>
  readdirSync(folder, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(resolve(folder, e.name)) : [resolve(folder, e.name)]
  );

const allFiles = files(dir);
const manifest = {
  version: pkg.version,
  schemaVersion: 2,
  node: shouldBundleRuntime
    ? '22.23.4 (Windows x64 bundled portable runtime)'
    : '22.22.x or newer 22.x (Windows x64)',
  bundledRuntime: shouldBundleRuntime,
  builtAt: new Date().toISOString(),
  files: allFiles.map((path) => ({
    path: relative(dir, path).replaceAll('\\', '/'),
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  })),
};
writeFileSync(resolve(dir, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Manifest successfully created with ${manifest.files.length} verified files.`);

// If not bundling full runtime, create lightweight zip for backwards compatibility
if (!shouldBundleRuntime) {
  const table = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  const crc = (data) => {
    let n = 0xffffffff;
    for (const b of data) n = table[(n ^ b) & 255] ^ (n >>> 8);
    return (n ^ 0xffffffff) >>> 0;
  };
  let offset = 0;
  const entries = [],
    central = [];
  for (const path of allFiles) {
    const filename = Buffer.from(name + '/' + relative(dir, path).replaceAll('\\', '/'));
    const data = readFileSync(path),
      compressed = deflateRawSync(data),
      checksum = crc(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(filename.length, 28);
    header.writeUInt32LE(offset, 42);
    entries.push(local, filename, compressed);
    central.push(header, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const zip = resolve('release', name + '.zip');
  writeFileSync(zip, Buffer.concat([...entries, directory, end]));
  writeFileSync(
    zip + '.sha256',
    createHash('sha256').update(readFileSync(zip)).digest('hex') + '  ' + name + '.zip\n'
  );
  console.log(zip);
}
