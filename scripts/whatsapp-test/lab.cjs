const fs = require('node:fs/promises');
const path = require('node:path');
const { MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { runManualAddition, normalizePhone } = require('./operations.cjs');

const GROUP_TITLE = 'الروضة | اختبار الإنشاء والسجل 30-10-2026';
const MARKER = 'ELRAWDA-HISTORY-20261030';
const serialized = id => typeof id === 'string' ? id : id?._serialized || id?.$1 ||
  (id?.user && id?.server ? `${id.user}@${id.server}` : '');

async function readLabMessagesInPage({ groupId, marker }) {
  const serialized = id => typeof id === 'string' ? id : id?._serialized || id?.$1 || '';
  const collections = window.require('WAWebCollections');
  return collections.Msg.getModelsArray().filter(msg => serialized(msg.id?.remote) === groupId && msg.id?.fromMe === true)
    .map(msg => ({ id: serialized(msg.id), body: msg.body || msg.caption || '', type: msg.type, timestamp: msg.t, ack: msg.ack }))
    .filter(msg => msg.body.startsWith(`[${marker}/`))
    .map(msg => ({ ...msg, fixtureKey: ({ '1': 'text-1', '2': 'text-2', '3': 'image-3' })[msg.body.slice(`[${marker}/`.length, `[${marker}/`.length + 1)] }));
}

async function probeInPage(moduleName) {
  let debug;
  try { debug = window.require('__debug'); } catch { return { available: false }; }
  const names = Object.keys(debug.modulesMap || {}).filter(name =>
    /(?:group.*history|history.*group|history.*share|share.*history|recent.*history|history.*recent)/i.test(name));
  const modules = [];
  for (const name of moduleName ? names.filter(name => name === moduleName) : names) {
    try {
      const exports = window.require(name);
      const record = debug.modulesMap[name];
      modules.push({ name, ...(moduleName ? { recordKeys: Object.keys(record || {}),
        factories: Object.entries(record || {}).filter(([, value]) => typeof value === 'function').map(([key, value]) => ({ key, source: value.toString().slice(0, 26000) })) } : {}),
        exports: Object.entries(exports || {}).map(([key, value]) => ({
        key, type: typeof value, ...(typeof value === 'function' && moduleName ? { source: value.toString().slice(0, 14000) } : {}),
      })) });
    } catch (error) { modules.push({ name, error: error.message }); }
  }
  return { available: true, candidateCount: names.length, modules };
}

function createLab({ getClient, getPilot, dataDir }) {
  const file = path.join(dataDir, 'lab-state.json');
  let state;
  const load = async () => {
    if (!state) {
      try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; state = { title: GROUP_TITLE, marker: MARKER, creation: 'not_started', seed: [], history: 'not_tested' }; }
    }
    return state;
  };
  const save = async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
  };
  return {
    async run(action, input = {}) {
      await load();
      const client = getClient();
      const pilot = getPilot();
      if (action === 'status') return state;
      if (action === 'probe') {
        const probe = await client.pupPage.evaluate(probeInPage, input.moduleName || null);
        state.lastProbeAt = new Date().toISOString();
        state.historyCandidates = probe.modules.map(module => module.name);
        await save();
        return probe;
      }
      if (action === 'gating') {
        const result = await client.pupPage.evaluate(id => {
          const gating = window.require('WAWebGroupHistoryGating');
          const wid = id ? window.require('WAWebWidFactory').createWid(id) : null;
          return {
            senderEnabled: gating.isGroupHistorySenderEnabled(wid),
            postJoinSenderEnabled: gating.isGroupHistoryPostJoinSenderEnabled(wid),
            timeLimitSecs: gating.getGroupHistoryMessagesTimeLimitSecs(),
          };
        }, state.groupId || null);
        state.gating = result; await save(); return result;
      }
      if (action === 'source') {
        if (!/^WAWeb(?:GroupHistory|SendHistoryBundle|GetGroupHistoryBundle)[A-Za-z]+$/.test(input.moduleName || '')) throw new Error('Group history module name required.');
        const session = await client.pupPage.createCDPSession();
        const scripts = [];
        session.on('Debugger.scriptParsed', script => {
          if (/^https:\/\/(?:static\.whatsapp\.net|web\.whatsapp\.com)\//.test(script.url)) scripts.push(script);
        });
        try {
          await session.send('Debugger.enable');
          await new Promise(resolve => setTimeout(resolve, 150));
          for (const script of scripts) {
            const { scriptSource } = await session.send('Debugger.getScriptSource', { scriptId: script.scriptId });
            const index = scriptSource.indexOf(`__d("${input.moduleName}"`);
            if (index < 0) continue;
            const end = scriptSource.indexOf('__d("', index + 5);
            return { moduleName: input.moduleName, source: scriptSource.slice(index, end < 0 ? index + 30000 : Math.min(end, index + 30000)) };
          }
          return { moduleName: input.moduleName, found: false, inspectedScriptCount: scripts.length };
        } finally { await session.detach(); }
      }
      if (action === 'create') {
        if (state.groupId) {
          const group = await pilot.getChatById(state.groupId);
          state.creationVerified = group.isGroup && group.name === GROUP_TITLE;
          state.initialParticipantCount ??= group.participants.length;
          await save(); return state;
        }
        const matches = (await pilot.getGroups()).filter(group => group.name === GROUP_TITLE);
        if (matches.length) {
          if (matches.length !== 1) throw new Error('أكثر من جروب بنفس اسم الاختبار؛ يلزم مراجعة المعرف.');
          state.groupId = matches[0].id;
          state.creation = 'reconciled_existing';
          await save();
          return state;
        }
        if (state.creation !== 'not_started') throw new Error('محاولة الإنشاء السابقة غير محسومة؛ لا نكرر إنشاء جروب تلقائيًا.');
        state.creation = 'outcome_unknown'; state.createStartedAt = new Date().toISOString(); await save();
        const result = await client.createGroup(GROUP_TITLE, [], { autoSendInviteV4: false, memberAddMode: true, isRestrict: true });
        if (typeof result === 'string') { state.creation = 'refused'; state.creationError = result; await save(); return state; }
        const id = serialized(result.gid);
        if (!/^\d+(?:-\d+)?@g\.us$/.test(id)) throw new Error('تم إرسال طلب الإنشاء لكن المعرف غير مؤكد؛ لا تعاد المحاولة.');
        state.groupId = id; state.creation = 'created'; state.createdAt = new Date().toISOString(); await save();
        const group = await pilot.getChatById(id);
        state.creationVerified = group.isGroup && group.name === GROUP_TITLE;
        state.initialParticipantCount = group.participants.length;
        await save(); return state;
      }
      if (!state.groupId) throw new Error('أنشئ جروب الاختبار أولًا.');
      if (action === 'inspect-seed') {
        const messages = await client.pupPage.evaluate(readLabMessagesInPage, { groupId: state.groupId, marker: MARKER });
        for (const attempt of state.seed) {
          const matches = messages.filter(msg => msg.fixtureKey === attempt.key);
          if (matches.length === 1 && matches[0].id && matches[0].ack >= 1) Object.assign(attempt, {
            status: 'sent', messageId: matches[0].id, ack: matches[0].ack, reconciledAt: new Date().toISOString(),
          });
        }
        await save(); return { seed: state.seed, messages };
      }
      if (action === 'seed') {
        if (state.memberAddedAt) throw new Error('رسائل الاختبار يجب أن تسبق دخول العضو؛ لا نرسلها بعد الإضافة.');
        if (state.seed.some(item => item.status !== 'sent')) throw new Error('هناك رسالة اختبار نتيجتها غير مؤكدة؛ يلزم فحصها قبل الاستكمال.');
        const group = await pilot.getChatById(state.groupId);
        if (group.participants.length !== 1) throw new Error('تجهيز الرسائل مسموح قبل إضافة أي عضو آخر إلى جروب الاختبار.');
        const fixtures = [
          { key: 'text-1', content: `[${MARKER}/1] رسالة اختبار رقم 1 — أُرسلت قبل إضافة عضو الاختبار.` },
          { key: 'text-2', content: `[${MARKER}/2] رسالة اختبار رقم 2 — المطلوب ظهورها داخل سجل نفس الجروب بعد الانضمام.` },
          { key: 'image-3', image: true, caption: `[${MARKER}/3] صورة اختبار سجل الرسائل — قبل دخول العضو. هذا ليس كود ربط واتساب.` },
        ];
        for (const fixture of fixtures) {
          if (state.seed.some(item => item.key === fixture.key)) continue;
          const attempt = { key: fixture.key, status: 'outcome_unknown', startedAt: new Date().toISOString() };
          state.seed.push(attempt); await save();
          try {
            const media = fixture.image ? new MessageMedia('image/png', (await QRCode.toBuffer(MARKER, { width: 240 })).toString('base64'), 'history-test.png') : fixture.content;
            const result = await client.sendMessage(state.groupId, media, { sendSeen: false, waitUntilMsgSent: true, ...(fixture.image ? { caption: fixture.caption } : {}) });
            attempt.messageId = serialized(result?.id);
            attempt.status = attempt.messageId ? 'sent' : 'outcome_unknown';
            if (!attempt.messageId) {
              const messages = await client.pupPage.evaluate(readLabMessagesInPage, { groupId: state.groupId, marker: MARKER });
              const matches = messages.filter(msg => msg.fixtureKey === fixture.key);
              if (matches.length === 1 && matches[0].id && matches[0].ack >= 1) Object.assign(attempt, { status: 'sent', messageId: matches[0].id, ack: matches[0].ack });
            }
            attempt.finishedAt = new Date().toISOString();
            await save();
            if (attempt.status !== 'sent') return state;
          } catch (error) { attempt.error = error.message; await save(); return state; }
        }
        return state;
      }
      if (action === 'text-only') {
        if (state.memberAddedAt) throw new Error('Test already joined');
        if (!['text-1','text-2'].every(key => state.seed.some(item => item.key === key && item.status === 'sent'))) throw new Error('Both texts must be confirmed');
        state.testScope = 'text_only'; state.mediaResult = 'sdk_error_not_confirmed'; await save(); return state;
      }
      if (action === 'add') {
        const required = state.testScope === 'text_only' ? ['text-1','text-2'] : ['text-1','text-2','image-3'];
        if (!required.every(key => state.seed.some(item => item.key === key && item.status === 'sent'))) throw new Error('رسائل ما قبل الانضمام لم تتأكد بالكامل بعد.');
        normalizePhone(input.phone);
        const attempts = new Map(state.lastAddition ? [[`${state.groupId}:${state.targetPhone}`, state.lastAddition]] : []);
        // The target is supplied explicitly from the user's previously approved test input.
        state.joinStartedAt ??= new Date().toISOString(); await save();
        const result = await runManualAddition(pilot, input.phone, state.groupId, input.confirmed === true, attempts);
        state.targetPhone = normalizePhone(input.phone);
        state.lastAddition = result;
        if (['joined', 'already_member'].includes(result.status)) state.memberAddedAt = new Date().toISOString();
        await save(); return state;
      }
      if (['eligibility', 'share'].includes(action)) {
        if (!state.memberAddedAt || !state.targetPhone) throw new Error('Confirmed test membership required');
        if (action === 'share' && state.history !== 'not_tested') throw new Error('History attempt already recorded; do not repeat');
        const target = await pilot.getNumberId(state.targetPhone);
        const mappings = await pilot.getContactLidAndPhone([serialized(target)]);
        const ids = [serialized(target), ...mappings.flatMap(item => [serialized(item.pn), serialized(item.lid)])].filter(Boolean);
        if (action === 'share') { state.history = 'outcome_unknown'; await save(); }
        let result;
        try { result = await client.pupPage.evaluate(async ({groupId, ids, fallback, send}) => {
          const ser = id => typeof id === 'string' ? id : id?._serialized || id?.$1 || '';
          const wid = window.require('WAWebWidFactory').createWid(groupId);
          await window.require('WAWebGroupQueryJob').queryAndUpdateGroupMetadataById({id:groupId});
          const chat = window.require('WAWebCollections').Chat.get(wid);
          const metadata = chat.groupMetadata;
          const participant = metadata.participants.getModelsArray().find(p => ids.includes(ser(p.id)));
          if (!participant) return {eligible:false, reason:'participant_not_found'};
          const gating = window.require('WAWebGroupHistoryGating');
          const prerequisites = gating.isGroupHistoryPostJoinSenderPrerequisitesEnabled();
          const experiment = gating.isGroupHistoryPostJoinSenderEnabled(wid);
          if (!prerequisites || !experiment) return {eligible:false,reason:'account_gate_disabled',prerequisites,experiment};
          const eligibility = await window.require('WAWebGroupHistoryPostJoinEligibilityFull').isEligibleForPostJoinHistoryFull({groupMetadata:metadata,groupWid:wid,joinTimeFallback:fallback,participant});
          if (!eligibility.eligible || !send) return {...eligibility, prerequisites,experiment};
          const {historyReceivers,nonHistoryReceivers} = window.require('WAWebGroupHistoryRestrictionHelper').filterParticipants([participant.id]);
          if (historyReceivers.length !== 1) return {eligible:false,reason:'receiver_restricted'};
          const ack = await window.require('WAWebSendHistoryBundleAction').sendHistoryBundleAction(window.require('WAWebWidToJid').widToGroupJid(wid),historyReceivers,nonHistoryReceivers,eligibility.messageCount,participant.joinTime ?? fallback);
          return {...eligibility,...ack};
        }, {groupId:state.groupId,ids,fallback:Math.floor(Date.parse(state.joinStartedAt)/1000),send:action==='share'});
        } catch (error) {
          if (action === 'share') {
            state.history = /Group history sender is not enabled/.test(error.message) ? 'unavailable_sender_gate' : 'outcome_unknown';
            state.historyError = error.message; state.historyAttemptAt = new Date().toISOString(); await save();
          }
          throw error;
        }
        state.historyEligibility = result;
        if (action === 'share') {state.history = !result.eligible ? 'unavailable' : result.bundleAcked ? 'bundle_acked_receiver_pending' : 'not_acked'; state.historyAttemptAt=new Date().toISOString();}
        await save(); return result;
      }
      throw new Error('Unknown lab action');
    },
  };
}

module.exports = { createLab, probeInPage, readLabMessagesInPage, serialized, GROUP_TITLE, MARKER };
