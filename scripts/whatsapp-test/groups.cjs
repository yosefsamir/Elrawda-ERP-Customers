const { GroupChat } = require('whatsapp-web.js');

// The 1.34.7 chat serializer reads obsolete ID fields and can throw `r`.
// This pilot needs group metadata, not chat histories. Read that narrow shape
// without chat.serialize(), getChatModel(), or any private-message serialization.
// Compatibility reference: https://github.com/wwebjs/whatsapp-web.js/issues/201862
async function readGroupsInPage(groupId) {
  const collections = window.require('WAWebCollections');
  const serialized = id => {
    if (typeof id === 'string') return id;
    if (typeof id?._serialized === 'string') return id._serialized;
    if (typeof id?.$1 === 'string') return id.$1;
    if (id?.user && id?.server) return `${id.user}@${id.server}`;
    return '';
  };
  const wid = id => {
    const value = serialized(id);
    if (!value) throw new Error('تعذر قراءة معرف واتساب.');
    const at = value.lastIndexOf('@');
    return { _serialized: value, user: value.slice(0, at), server: value.slice(at + 1) };
  };
  const groups = collections.Chat.getModelsArray().filter(chat => serialized(chat.id).endsWith('@g.us'));
  if (!groupId) return groups.map(chat => ({
    id: serialized(chat.id), name: chat.name || chat.formattedTitle || chat.groupMetadata?.subject || 'جروب بدون اسم',
    participants: chat.groupMetadata?.participants?.getModelsArray()?.length ?? null,
  }));
  const group = groups.find(chat => serialized(chat.id) === groupId);
  if (!group) throw new Error('الجروب غير موجود في الجلسة الحالية؛ أعد تحميل قائمة الجروبات.');
  // Refresh only the selected group's membership before duplicate/admin checks.
  await window.require('WAWebGroupQueryJob').queryAndUpdateGroupMetadataById({ id: groupId });
  const metadata = group.groupMetadata;
  const participants = metadata?.participants?.getModelsArray();
  if (!metadata || !Array.isArray(participants)) throw new Error('تعذر تحميل أعضاء الجروب؛ لم ننفذ إضافة.');
  return {
    id: wid(group.id), formattedTitle: group.name || group.formattedTitle || metadata.subject || 'جروب بدون اسم',
    isGroup: true, isReadOnly: Boolean(metadata.announce), lastMessage: null,
    groupMetadata: {
      participants: participants.map(p => ({ id: wid(p.id), isAdmin: Boolean(p.isAdmin), isSuperAdmin: Boolean(p.isSuperAdmin) })),
      owner: metadata.owner ? wid(metadata.owner) : undefined,
      creation: metadata.creation, desc: metadata.desc || '', announce: Boolean(metadata.announce),
    },
  };
}

async function readContactIdsInPage(ids) {
  const serialized = id => typeof id === 'string' ? id :
    id?._serialized || id?.$1 || (id?.user && id?.server ? `${id.user}@${id.server}` : undefined);
  return Promise.all(ids.map(async id => {
    const { lid, phone } = await window.WWebJS.enforceLidAndPnRetrieval(id);
    return { lid: serialized(lid), pn: serialized(phone) };
  }));
}

function createPilotClient(client) {
  return {
    get info() { return client.info; },
    getNumberId: phone => client.getNumberId(phone),
    getContactLidAndPhone: ids => client.pupPage.evaluate(readContactIdsInPage, ids),
    getGroups: async () => (await client.pupPage.evaluate(readGroupsInPage, null)).sort((a, b) => a.name.localeCompare(b.name, 'ar')),
    getChatById: async id => new GroupChat(client, await client.pupPage.evaluate(readGroupsInPage, id)),
  };
}

module.exports = { createPilotClient, readGroupsInPage, readContactIdsInPage };
