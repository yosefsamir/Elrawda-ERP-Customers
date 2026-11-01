import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { watchSupervisor } from '../packages/runtime/supervisor.js';

test('watchSupervisor fires once after the supervising process exits', async () => {
  const supervisor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  let lost = 0;
  const stop = watchSupervisor(supervisor.pid!, () => { lost++; }, 25);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(lost, 0, 'a live supervisor must not trigger shutdown');

  supervisor.kill();
  await once(supervisor, 'exit');
  await new Promise((resolve) => setTimeout(resolve, 150));
  stop();
  assert.equal(lost, 1, 'a lost supervisor must trigger shutdown exactly once');
});
