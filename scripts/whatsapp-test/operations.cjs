function normalizePhone(input) {
  if (typeof input !== 'string') throw new Error('اكتب رقم موبايل واحد.');
  let phone = input.trim().replace(/[٠-٩۰-۹]/g, digit =>
    String('٠١٢٣٤٥٦٧٨٩'.includes(digit) ? digit.charCodeAt(0) - 1632 : digit.charCodeAt(0) - 1776));
  phone = phone.replace(/[\s().-]/g, '');
  if (phone.startsWith('+')) phone = phone.slice(1);
  if (phone.startsWith('0020')) phone = phone.slice(2);
  if (/^01[0125]\d{8}$/.test(phone)) phone = `20${phone.slice(1)}`;
  if (!/^201[0125]\d{8}$/.test(phone)) throw new Error('استخدم موبايل مصري صحيح يبدأ بـ01 أو +20؛ رقم واحد فقط.');
  return phone;
}

function canonical(id) {
  return (typeof id === 'string' ? id : id?._serialized || id?.$1 ||
    (id?.user && id?.server ? `${id.user}@${id.server}` : '')).replace(/@s\.whatsapp\.net$/, '@c.us');
}

async function inspectTarget(client, input, groupId) {
  const phone = normalizePhone(input);
  if (typeof groupId !== 'string' || !/^\d+(?:-\d+)?@g\.us$/.test(groupId)) throw new Error('اختار جروب من القائمة.');
  const group = await client.getChatById(groupId);
  if (!group.isGroup) throw new Error('المحادثة المختارة ليست جروبًا.');
  const number = await client.getNumberId(phone);
  if (!number) return { status: 'not_on_whatsapp', phone, groupName: group.name };
  const target = canonical(number);
  const self = canonical(client.info?.wid);
  if (!self) throw new Error('هوية الحساب لم تجهز بعد.');
  const mappings = await client.getContactLidAndPhone([target, self]);
  const aliases = id => {
    const result = new Set([id]);
    for (const mapping of mappings) {
      if (mapping && (canonical(mapping.pn) === id || canonical(mapping.lid) === id)) {
        if (mapping.pn) result.add(canonical(mapping.pn));
        if (mapping.lid) result.add(canonical(mapping.lid));
      }
    }
    return result;
  };
  const targetIds = aliases(target);
  const selfIds = aliases(self);
  const participants = group.participants || [];
  const member = participants.some(p => targetIds.has(canonical(p.id)));
  const admin = participants.some(p => selfIds.has(canonical(p.id)) && (p.isAdmin || p.isSuperAdmin));
  // Refuse a write when privacy IDs prevent a reliable duplicate check.
  const membershipUnknown = !member && participants.some(p => canonical(p.id).endsWith('@lid')) &&
    ![...targetIds].some(id => id.endsWith('@lid'));
  return { status: member ? 'already_member' : 'ready_to_add', phone, groupName: group.name,
    participantCount: participants.length, isAdmin: admin, membershipUnknown, targetId: target };
}

async function addOne(client, input, groupId, confirmed) {
  if (confirmed !== true) throw new Error('أكد أن الرقم يخص شخصًا موافقًا على تجربة الإضافة.');
  const before = await inspectTarget(client, input, groupId);
  if (before.status !== 'ready_to_add') return before;
  if (!before.isAdmin) return { status: 'not_admin', detail: 'رقم واتساب المتصل لازم يكون أدمن في جروب الاختبار؛ لم ننفذ إضافة.' };
  if (before.membershipUnknown) return { status: 'membership_unknown', detail: 'تعذر التأكد من العضوية بسبب معرفات الخصوصية؛ لم ننفذ إضافة. راجع الأعضاء يدويًا.' };
  const group = await client.getChatById(groupId);
  const raw = await group.addParticipants([before.targetId], { autoSendInviteV4: false });
  if (typeof raw === 'string') return { status: 'refused', detail: raw };
  const entries = Object.values(raw || {});
  if (entries.length !== 1) return { status: 'outcome_unknown', detail: 'الاستجابة غير حاسمة؛ راجع أعضاء الجروب قبل أي محاولة أخرى.' };
  const item = entries[0];
  const code = Number(item.code);
  const states = { 403: 'invite_required', 404: 'not_on_whatsapp', 408: 'recently_left', 409: 'already_member', 419: 'group_full' };
  if (code !== 200) return { status: states[code] || 'refused', code, inviteSent: Boolean(item.isInviteV4Sent), detail: item.message };
  try {
    const after = await inspectTarget(client, input, groupId);
    return { status: after.status === 'already_member' ? 'joined' : 'addition_accepted', code, inviteSent: false };
  } catch {
    return { status: 'addition_accepted', code, inviteSent: false, detail: 'واتساب قبل الطلب؛ تأكيد العضوية يحتاج مراجعة الجروب.' };
  }
}

async function runManualAddition(client, input, groupId, confirmed, attempts) {
  if (confirmed !== true) throw new Error('أكد أن الرقم يخص شخصًا موافقًا على تجربة الإضافة.');
  const key = `${groupId}:${normalizePhone(input)}`;
  const previous = attempts.get(key);
  if (previous?.status === 'outcome_unknown') {
    const current = await inspectTarget(client, input, groupId);
    if (current.status === 'already_member') {
      attempts.set(key, current);
      return current;
    }
    return { ...previous, repeatedRequest: true,
      detail: 'فحصنا الحالة الحالية، لكن المحاولة السابقة غير مؤكدة؛ راجع الجروب قبل إعادة طلب الإضافة.' };
  }
  // A previous success is history, not evidence of current membership. A new
  // explicit click must recheck WhatsApp, so removal/leave permits another add.
  attempts.set(key, { status: 'outcome_unknown' });
  try {
    const result = await addOne(client, input, groupId, confirmed);
    attempts.set(key, result);
    return result;
  } catch (error) {
    const result = { status: 'outcome_unknown', detail: error.message };
    attempts.set(key, result);
    return result;
  }
}

module.exports = { normalizePhone, inspectTarget, addOne, runManualAddition };
