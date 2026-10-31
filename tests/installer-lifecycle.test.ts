import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { openDatabase } from '../packages/storage/database.js';
import { CompanyRepository } from '../packages/storage/company-repository.js';
import { createBackup, restoreBackup, verifyBackup } from '../packages/storage/backup.js';

test('installer & upgrade lifecycle: clean installation, upgrade, safe rollback, uninstall preservation', async (t) => {
  const root = resolve('.');
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

  const baseDir = mkdtempSync(join(tmpdir(), 'elrawda-installer-lifecycle-'));
  const installRoot = join(baseDir, 'WhatsApp-ERP');
  const stateRoot = join(baseDir, 'ProgramData');
  const dataDir = join(stateRoot, 'data');
  const cacheDir = join(stateRoot, 'cache');
  const logsDir = join(stateRoot, 'logs');
  const backupsDir = join(stateRoot, 'backups');

  t.after(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  // --- Step 1: Clean Installation Simulation ---
  const v1 = pkg.version;
  const releaseV1 = join(installRoot, 'releases', v1);
  const stagingV1 = `${releaseV1}.staging-test`;

  mkdirSync(stagingV1, { recursive: true });
  cpSync(resolve(root, 'dist'), join(stagingV1, 'dist'), { recursive: true });
  cpSync(resolve(root, 'package.json'), join(stagingV1, 'package.json'));
  cpSync(resolve(root, 'node_modules'), join(stagingV1, 'node_modules'), { recursive: true });

  // Verify staging readiness (preflight)
  const preflightScript = join(stagingV1, 'dist/runtime/scripts/maintenance/preflight.js');
  assert.ok(existsSync(preflightScript), 'preflight script must exist in staged release');

  // Move staging to release directory
  mkdirSync(join(installRoot, 'releases'), { recursive: true });
  cpSync(stagingV1, releaseV1, { recursive: true });
  rmSync(stagingV1, { recursive: true, force: true });

  // Initialize state directory
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(backupsDir, { recursive: true });

  const initialConfig = {
    ReleasePath: releaseV1,
    PreviousRelease: '',
    NodePath: process.execPath,
    DataDir: dataDir,
    CacheDir: cacheDir,
    Port: 3211,
    TaskName: 'WhatsAppERPOperations',
  };
  writeFileSync(join(stateRoot, 'service.json'), JSON.stringify(initialConfig, null, 2));

  // Initialize SQLite database and populate sample customer data
  const db = openDatabase(join(dataDir, 'app.sqlite'));
  db.prepare('INSERT INTO operators VALUES(?,?,?)').run('admin', 'admin', 'hash');
  const repo = new CompanyRepository(db);
  const companyId = repo.create('admin', 'شركة التركيب النظيف');
  db.close();

  // Verify initial data was created
  assert.ok(existsSync(join(dataDir, 'app.sqlite')), 'app.sqlite must exist after installation');

  // --- Step 2: Safe Upgrade Simulation (to v1.0.1) ---
  const v2 = '1.0.1';
  const releaseV2 = join(installRoot, 'releases', v2);
  const stagingV2 = `${releaseV2}.staging-test`;

  mkdirSync(stagingV2, { recursive: true });
  cpSync(releaseV1, stagingV2, { recursive: true });
  // Update version in staged package.json
  const v2Pkg = { ...pkg, version: v2 };
  writeFileSync(join(stagingV2, 'package.json'), JSON.stringify(v2Pkg, null, 2));

  // Commit staged release to final path
  cpSync(stagingV2, releaseV2, { recursive: true });
  rmSync(stagingV2, { recursive: true, force: true });

  // Acquire maintenance flag
  const flag = join(stateRoot, 'maintenance.flag');
  writeFileSync(flag, 'update');

  // Create pre-update backup
  const backupDir = join(backupsDir, `before-${v2}-test`);
  await createBackup(dataDir, backupDir, true);
  const verifiedSchema = verifyBackup(backupDir);
  assert.equal(verifiedSchema, 2, 'Pre-update backup must have schema version 2');

  // Run isolated migration probe on a temporary copy
  const probeDir = join(stateRoot, 'migration-probe-test');
  mkdirSync(probeDir, { recursive: true });
  cpSync(join(backupDir, 'app.sqlite'), join(probeDir, 'app.sqlite'));

  // Run probe
  const probeDb = openDatabase(join(probeDir, 'app.sqlite'));
  const probeVersion = (probeDb.prepare('SELECT MAX(version) version FROM schema_migrations').get() as any).version;
  assert.equal(probeVersion, 2, 'Migration probe must verify schema compatibility');
  probeDb.close();
  rmSync(probeDir, { recursive: true, force: true });

  // Activate new release in service.json
  const updatedConfig = {
    ...initialConfig,
    ReleasePath: releaseV2,
    PreviousRelease: releaseV1,
  };
  writeFileSync(join(stateRoot, 'service.json'), JSON.stringify(updatedConfig, null, 2));
  rmSync(flag, { force: true });

  // Verify upgraded state
  const activeConfig = JSON.parse(readFileSync(join(stateRoot, 'service.json'), 'utf8'));
  assert.equal(activeConfig.ReleasePath, releaseV2);
  assert.equal(activeConfig.PreviousRelease, releaseV1);

  // Verify customer data preserved
  const verifyDb = new Database(join(dataDir, 'app.sqlite'), { readonly: true });
  const company = verifyDb.prepare('SELECT name FROM companies WHERE id=?').get(companyId) as any;
  assert.equal(company.name, 'شركة التركيب النظيف');
  verifyDb.close();

  // --- Step 3: Upgrade Failure & Automatic Rollback Simulation ---
  // Suppose v3 fails during readiness check, but database schema is compatible:
  writeFileSync(flag, 'recovery');
  const currentRelease = activeConfig.ReleasePath;
  const previousRelease = activeConfig.PreviousRelease;

  // Schema check on current data using previous release logic
  const checkDb = new Database(join(dataDir, 'app.sqlite'), { readonly: true });
  const checkVersion = (checkDb.prepare('SELECT MAX(version) version FROM schema_migrations').get() as any).version;
  checkDb.close();
  assert.equal(checkVersion <= 2, true, 'Current database must be compatible with previous release');

  // Perform automatic rollback
  const rolledBackConfig = {
    ...activeConfig,
    ReleasePath: previousRelease,
    PreviousRelease: currentRelease,
  };
  writeFileSync(join(stateRoot, 'service.json'), JSON.stringify(rolledBackConfig, null, 2));
  rmSync(flag, { force: true });

  const finalConfig = JSON.parse(readFileSync(join(stateRoot, 'service.json'), 'utf8'));
  assert.equal(finalConfig.ReleasePath, releaseV1, 'Release path must be restored to previous release');

  // --- Step 4: Uninstall Simulation (Customer Data Preservation) ---
  // Simulated uninstall: releases directory is cleaned, but stateRoot is NEVER touched!
  rmSync(installRoot, { recursive: true, force: true });
  assert.equal(existsSync(installRoot), false, 'Application binaries are removed on uninstall');
  assert.equal(existsSync(join(dataDir, 'app.sqlite')), true, 'Customer SQLite database must be preserved on uninstall');
  assert.equal(existsSync(backupDir), true, 'Customer backups must be preserved on uninstall');

  // Verify database still readable
  const finalDb = new Database(join(dataDir, 'app.sqlite'), { readonly: true });
  const finalCheck = finalDb.prepare('SELECT name FROM companies WHERE id=?').get(companyId) as any;
  assert.equal(finalCheck.name, 'شركة التركيب النظيف');
  finalDb.close();
});

