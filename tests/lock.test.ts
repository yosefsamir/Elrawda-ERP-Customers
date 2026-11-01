import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import os from 'node:os';
import { acquireLock } from '../packages/runtime/lock.js';

test('runtime lock: normal acquisition and release', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-test-'));
  const file = join(dir, 'runtime.lock');
  try {
    const release = acquireLock(file);
    assert.ok(existsSync(file), 'Lock file should exist');
    release();
    assert.ok(!existsSync(file), 'Lock file should be removed on release');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime lock: recovers from stale lock created before OS reboot (H3)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-test-'));
  const file = join(dir, 'runtime.lock');
  try {
    // Simulate a lock file written 2 days ago before reboot
    const fakeStaleBootLock = {
      pid: process.pid,
      owner: 'old-owner-before-reboot',
      createdAt: Date.now() - (os.uptime() * 1000) - 60000, // 60s before current boot
      systemBootTime: Date.now() - (os.uptime() * 1000) - 60000,
    };
    writeFileSync(file, JSON.stringify(fakeStaleBootLock), 'utf8');

    // Should clear stale lock automatically and succeed
    const release = acquireLock(file);
    assert.ok(existsSync(file), 'Should acquire lock after clearing pre-reboot stale lock');
    release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime lock: recovers from reused PID belonging to an unrelated process (H3)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-test-'));
  const file = join(dir, 'runtime.lock');
  try {
    // PID 1 is systemd/init on Linux, or system process on other platforms
    const fakeReusedPidLock = {
      pid: 1,
      owner: 'dead-owner',
      createdAt: Date.now(),
      systemBootTime: Math.floor(Date.now() - os.uptime() * 1000),
    };
    writeFileSync(file, JSON.stringify(fakeReusedPidLock), 'utf8');

    // System PID 1 is not a node process running our server, so it should be safely cleared
    const release = acquireLock(file);
    assert.ok(existsSync(file), 'Should acquire lock without error or affecting PID 1');
    release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
