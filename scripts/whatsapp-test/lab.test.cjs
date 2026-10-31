const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLab, GROUP_TITLE } = require('./lab.cjs');

async function fixture(t, { unknownCreation = false, failedSeed = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elrawda-lab-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  const groupId = '120363000000000000@g.us';
  const client = {
    async createGroup(title, members, options) {
      calls.push({ action: 'create', title, members, options });
      return { gid: unknownCreation ? {} : { $1: groupId } };
    },
    async sendMessage(id, content, options) {
      calls.push({ action: 'send', id, options });
      if (failedSeed) throw new Error('Connection lost after possible send');
      return { id: { $1: `true_${id}_fixture${calls.length}` } };
    },
  };
  const pilot = { getGroups: async () => [], getChatById: async () => ({ isGroup: true, name: GROUP_TITLE, participants: [{ id: { _serialized: '111@lid' } }] }) };
  return { lab: createLab({ getClient: () => client, getPilot: () => pilot, dataDir }), calls, groupId, dataDir, client, pilot };
}

test('creates only one owner-only test group with automatic invitations disabled', async t => {
  const { lab, calls } = await fixture(t);
  const first = await lab.run('create');
  assert.equal(first.creationVerified, true);
  assert.equal(first.initialParticipantCount, 1);
  await lab.run('create');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].members, []);
  assert.equal(calls[0].options.autoSendInviteV4, false);
});

test('does not repeat group creation after an uncertain result', async t => {
  const { lab, calls } = await fixture(t, { unknownCreation: true });
  await assert.rejects(lab.run('create'));
  await assert.rejects(lab.run('create'));
  assert.equal(calls.length, 1);
});

test('seeds exactly two text messages and one image before a member joins, without resending', async t => {
  const { lab, calls, groupId } = await fixture(t);
  await lab.run('create');
  const result = await lab.run('seed');
  assert.equal(result.seed.length, 3);
  assert(result.seed.every(item => item.status === 'sent'));
  await lab.run('seed');
  const sends = calls.filter(call => call.action === 'send');
  assert.equal(sends.length, 3);
  assert(sends.every(call => call.id === groupId && call.options.sendSeen === false));
});

test('stops after an uncertain send and prevents adding the test member prematurely', async t => {
  const { lab, calls } = await fixture(t, { failedSeed: true });
  await lab.run('create');
  const result = await lab.run('seed');
  assert.equal(result.seed[0].status, 'outcome_unknown');
  await assert.rejects(lab.run('seed'));
  await assert.rejects(lab.run('add', { phone: '01012345678', confirmed: true }));
  assert.equal(calls.filter(call => call.action === 'send').length, 1);
});


test('records a native history sender gate refusal and does not retry the send', async t => {
  const {lab, dataDir, client, pilot, groupId} = await fixture(t);
  await fs.writeFile(path.join(dataDir, 'lab-state.json'), JSON.stringify({
    groupId, history:'not_tested', targetPhone:'201012345678', memberAddedAt:new Date().toISOString(), joinStartedAt:new Date().toISOString(),
  }));
  pilot.getNumberId = async () => ({_serialized:'201012345678@c.us'});
  pilot.getContactLidAndPhone = async () => [];
  let sends=0;
  client.pupPage = {evaluate:async () => {sends++;throw new Error('[group-history] Group history sender is not enabled');}};
  await assert.rejects(lab.run('share'), /sender is not enabled/);
  assert.equal((await lab.run('status')).history,'unavailable_sender_gate');
  await assert.rejects(lab.run('share'), /already recorded/);
  assert.equal(sends,1);
});

test('text-only scope cannot skip an unconfirmed text fixture', async t => {
  const {lab} = await fixture(t, {failedSeed:true});
  await lab.run('create');await lab.run('seed');
  await assert.rejects(lab.run('text-only'), /Both texts must be confirmed/);
});
