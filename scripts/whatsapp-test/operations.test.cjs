const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, inspectTarget, addOne, runManualAddition } = require('./operations.cjs');

const target = '201012345678@c.us';
const self = '201112345678@c.us';
const groupId = '120363000000000000@g.us';
function fixture({ admin = true, existing = false, code = 200, verify = true, registered = true, mapped = true } = {}) {
  let added = false;
  const calls = [];
  const group = {
    isGroup: true, name: 'جروب اختبار',
    get participants() { return [
      { id: { _serialized: '111@lid' }, isAdmin: admin },
      ...(existing || (added && verify) ? [{ id: { _serialized: '222@lid' } }] : []),
    ]; },
    async addParticipants(ids, options) {
      calls.push({ ids, options });
      added = code === 200;
      return { [target]: { code, isInviteV4Sent: false } };
    },
  };
  return { calls, removeTarget: () => { added = false; }, client: {
    info: { wid: { _serialized: self } },
    getNumberId: async () => registered ? { _serialized: target } : null,
    getContactLidAndPhone: async () => [{ pn: self, lid: '111@lid' }, { pn: target, ...(mapped ? { lid: '222@lid' } : {}) }],
    getChatById: async () => group,
  } };
}

test('normalizes Egyptian and Persian/Arabic digits without accepting lists or malformed numbers', () => {
  for (const value of ['01012345678', '+20 101-234-5678', '00201012345678', '٠١٠١٢٣٤٥٦٧٨', '۰۱۰۱۲۳۴۵۶۷۸']) assert.equal(normalizePhone(value), '201012345678');
  for (const value of ['01012345678,01112345678', 'hello01012345678', '01912345678', '010123', '+2+01012345678', '']) assert.throws(() => normalizePhone(value));
});

test('does not access WhatsApp before explicit manual confirmation', async () => {
  await assert.rejects(addOne({}, '01012345678', groupId, false));
});

test('detects existing membership and admin role through LID mapping without adding', async () => {
  const { client, calls } = fixture({ existing: true });
  const check = await inspectTarget(client, '01012345678', groupId);
  assert.equal(check.status, 'already_member'); assert.equal(check.isAdmin, true);
  assert.equal((await addOne(client, '01012345678', groupId, true)).status, 'already_member');
  assert.equal(calls.length, 0);
});

test('performs one addition and explicitly disables automatic private invitations', async () => {
  const { client, calls } = fixture();
  const result = await addOne(client, '01012345678', groupId, true);
  assert.equal(result.status, 'joined');
  assert.deepEqual(calls, [{ ids: [target], options: { autoSendInviteV4: false } }]);
});

test('privacy refusal is invite_required, not a successful join', async () => {
  const { client } = fixture({ code: 403 });
  const result = await addOne(client, '01012345678', groupId, true);
  assert.equal(result.status, 'invite_required'); assert.equal(result.inviteSent, false);
});

test('accepted operation without observable membership is not reported as joined', async () => {
  const { client } = fixture({ verify: false });
  assert.equal((await addOne(client, '01012345678', groupId, true)).status, 'addition_accepted');
});

test('does not add when the account is not admin or membership cannot be resolved', async () => {
  for (const [options, status] of [[{ admin: false }, 'not_admin'], [{ mapped: false }, 'membership_unknown'], [{ registered: false }, 'not_on_whatsapp']]) {
    const { client, calls } = fixture(options);
    assert.equal((await addOne(client, '01012345678', groupId, true)).status, status);
    assert.equal(calls.length, 0);
  }
});

test('a successful addition does not block a fresh manual addition after removal', async () => {
  const { client, calls, removeTarget } = fixture();
  const attempts = new Map();
  assert.equal((await runManualAddition(client, '01012345678', groupId, true, attempts)).status, 'joined');
  removeTarget();
  const result = await runManualAddition(client, '+201012345678', groupId, true, attempts);
  assert.equal(result.status, 'joined');
  assert.equal(result.repeatedRequest, undefined);
  assert.equal(calls.length, 2);
});

test('a second manual click checks current membership and does not add an existing member', async () => {
  const { client, calls } = fixture();
  const attempts = new Map();
  await runManualAddition(client, '01012345678', groupId, true, attempts);
  const result = await runManualAddition(client, '01012345678', groupId, true, attempts);
  assert.equal(result.status, 'already_member');
  assert.equal(result.repeatedRequest, undefined);
  assert.equal(calls.length, 1);
});

test('an uncertain previous write is reconciled with current membership before any repeat', async () => {
  for (const existing of [false, true]) {
    const { client, calls } = fixture({ existing });
    const attempts = new Map([[`${groupId}:201012345678`, { status: 'outcome_unknown' }]]);
    const result = await runManualAddition(client, '01012345678', groupId, true, attempts);
    assert.equal(result.status, existing ? 'already_member' : 'outcome_unknown');
    assert.equal(calls.length, 0);
  }
});

test('human action delay waits specified duration before sending addition command', async () => {
  const { client, calls } = fixture();
  const start = Date.now();
  const result = await addOne(client, '01012345678', groupId, true, { delayMs: 60 });
  const elapsed = Date.now() - start;
  assert.equal(result.status, 'joined');
  assert.equal(calls.length, 1);
  assert.ok(elapsed >= 50, `Expected elapsed time >= 50ms, got ${elapsed}ms`);
});
