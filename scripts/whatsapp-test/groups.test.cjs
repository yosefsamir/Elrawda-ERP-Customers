const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readGroupsInPage, readContactIdsInPage } = require('./groups.cjs');

function fixture() {
  const participants = [
    { id: { $1: '111@lid' }, isAdmin: true },
    { id: { user: '222', server: 'lid' }, isSuperAdmin: true },
  ];
  const metadata = { participants: { getModelsArray: () => participants }, owner: { $1: '111@lid' }, creation: 1 };
  const calls = [];
  const chats = [
    { id: { $1: '201000000000@c.us' }, serialize() { throw new Error('r'); } },
    { id: { $1: '120363000000000000@g.us' }, name: 'test', groupMetadata: metadata, serialize() { throw new Error('r'); } },
    { id: { _serialized: '120363000000000001@g.us' }, name: 'قديم', groupMetadata: metadata },
    { id: { user: '120363000000000002', server: 'g.us' }, name: 'بديل', groupMetadata: metadata },
  ];
  const context = { window: {
    require(name) {
      if (name === 'WAWebCollections') return { Chat: { getModelsArray: () => chats } };
      if (name === 'WAWebGroupQueryJob') return { queryAndUpdateGroupMetadataById: async value => calls.push(value) };
      throw new Error(`Unexpected module: ${name}`);
    },
    WWebJS: { enforceLidAndPnRetrieval: async () => ({ lid: { $1: '111@lid' }, phone: { user: '201000000000', server: 'c.us' } }) },
  } };
  const run = (fn, argument) => vm.runInNewContext(`(${fn.toString()})(${JSON.stringify(argument)})`, context);
  return { run, calls, chats };
}

test('lists groups despite broken private/group serializers and renamed IDs', async () => {
  const { run, calls } = fixture();
  const rows = await run(readGroupsInPage, null);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, 'test');
  assert.equal(rows[0].id, '120363000000000000@g.us');
  assert.equal(rows[0].participants, 2);
  assert.equal(rows[2].id, '120363000000000002@g.us');
  assert.equal(calls.length, 0, 'listing must not query every group or read chat histories');
});

test('refreshes selected group metadata and preserves LID identities and admin roles', async () => {
  const { run, calls } = fixture();
  const group = await run(readGroupsInPage, '120363000000000000@g.us');
  assert.equal(group.id._serialized, '120363000000000000@g.us');
  assert.equal(group.groupMetadata.participants[0].id._serialized, '111@lid');
  assert.equal(group.groupMetadata.participants[1].isSuperAdmin, true);
  assert.equal(calls.length, 1);
});

test('refuses unknown groups and missing participant metadata instead of returning empty membership', async () => {
  const { run, chats } = fixture();
  await assert.rejects(run(readGroupsInPage, '1@g.us'));
  chats[1].groupMetadata = null;
  await assert.rejects(run(readGroupsInPage, '120363000000000000@g.us'));
});

test('preserves phone/LID mapping when WhatsApp uses $1 or user/server instead of _serialized', async () => {
  const { run } = fixture();
  const rows = await run(readContactIdsInPage, ['111@lid']);
  assert.equal(rows[0].lid, '111@lid');
  assert.equal(rows[0].pn, '201000000000@c.us');
});
