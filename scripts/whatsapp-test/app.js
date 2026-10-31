const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="local-test-token"]').content;
let ready = false;
let localBusy = false;
let serverBusy = false;
let lastStatus;
let requestGeneration = 0;
const labels = { starting: 'جاري التشغيل', loading: 'تحميل واتساب', qr: 'امسح QR', authenticated: 'تم الربط · جاري المزامنة', ready: 'متصل', error: 'تعذر الاتصال', auth_failure: 'فشل الربط', disconnected: 'الاتصال مفصول' };
const outcomes = { ready_to_add: 'الرقم مسجل على واتساب وليس عضوًا حسب الفحص.', already_member: 'الرقم عضو بالفعل؛ لم ننفذ إضافة جديدة.', not_on_whatsapp: 'الرقم غير مسجل على واتساب حسب الاستجابة.', joined: 'تمت الإضافة وتأكدت العضوية.', addition_accepted: 'واتساب قبل طلب الإضافة؛ راجع أعضاء الجروب لتأكيد الانضمام.', invite_required: 'خصوصية الشخص تمنع الإضافة المباشرة. لم نرسل دعوة خاصة.', recently_left: 'واتساب رفض الإضافة لأن الشخص غادر الجروب مؤخرًا.', group_full: 'الجروب ممتلئ.', refused: 'واتساب رفض العملية.', not_admin: 'الحساب المتصل ليس أدمن؛ لم ننفذ إضافة.', membership_unknown: 'تعذر التأكد من العضوية؛ لم ننفذ إضافة.', outcome_unknown: 'النتيجة غير مؤكدة. راجع أعضاء الجروب قبل أي محاولة أخرى.' };

async function api(route, body) {
  const response = await fetch(route, { method: body === undefined ? 'GET' : 'POST', headers: {
    'X-Local-Test-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'تعذر تنفيذ الطلب.');
  return result;
}

function controls() {
  const disabled = !ready || localBusy || serverBusy;
  for (const id of ['refresh', 'phone', 'consent']) $(id).disabled = disabled;
  $('group').disabled = disabled || $('group').options.length < 2;
  $('check').disabled = disabled || !$('group').value || !$('phone').value.trim();
  $('add').disabled = $('check').disabled || !$('consent').checked;
}

function result(text, error = false) {
  $('result').hidden = false;
  $('result').textContent = text;
  $('result').classList.toggle('error', error);
}

async function refreshGroups() {
  if (localBusy) return;
  localBusy = true; controls();
  $('group-status').textContent = 'جاري تحميل الجروبات…';
  $('group-status').classList.remove('error');
  $('consent').checked = false;
  $('result').hidden = true;
  try {
    const selected = $('group').value;
    const response = await api('/api/groups');
    $('group').replaceChildren(new Option(response.groups.length ? 'اختار جروب الاختبار' : 'لا توجد جروبات في الحساب', ''));
    for (const group of response.groups) $('group').add(new Option(`${group.name}${group.participants === null ? '' : ` (${group.participants} عضو)`}`, group.id));
    if (response.groups.some(group => group.id === selected)) $('group').value = selected;
    $('group-status').textContent = response.groups.length ? `تم تحميل ${response.groups.length} جروب. اختار جروب الاختبار من القائمة.` : 'لا توجد جروبات متزامنة حتى الآن؛ لو أنشأت الجروب للتو جرّب تحميل القائمة مرة أخرى.';
  } catch (error) {
    $('group-status').textContent = `تعذر تحميل الجروبات: ${error.message === 'r' ? 'خطأ توافق مع واتساب ويب.' : error.message}`;
    $('group-status').classList.add('error');
    if ($('group').options.length === 1) $('group').options[0].textContent = 'تعذر تحميل الجروبات';
  }
  finally { localBusy = false; controls(); }
}

async function poll() {
  try {
    const state = await api('/api/status');
    ready = state.status === 'ready'; serverBusy = state.busy;
    $('status').textContent = labels[state.status] || state.status;
    $('connection-help').textContent = state.status === 'qr' ? 'من واتساب على الموبايل: الأجهزة المرتبطة ← ربط جهاز، وامسح الكود ده.' : ready ? 'الحساب متصل. اختار جروبًا أنت أدمن فيه لتجربة الإضافة.' : 'انتظر تجهيز الجلسة؛ أول ربط ممكن يحتاج وقت للمزامنة.';
    $('qr').hidden = !state.qr;
    if (state.qr && $('qr').src !== state.qr) $('qr').src = state.qr;
    if (!state.qr) $('qr').removeAttribute('src');
    $('account').hidden = !state.account;
    if (state.account) $('account').textContent = `الحساب: ${state.account.name} · ${state.account.phone}`;
    $('connection-error').hidden = !state.error;
    $('connection-error').textContent = state.error || '';
    $('restart').hidden = !['error', 'auth_failure', 'disconnected'].includes(state.status);
    if (lastStatus !== state.status && ready) { $('consent').checked = false; void refreshGroups(); }
    lastStatus = state.status;
    controls();
  } catch { $('status').textContent = 'برنامج الاختبار غير متاح'; ready = false; controls(); }
  finally { setTimeout(poll, 2000); }
}

async function run(add) {
  const generation = ++requestGeneration;
  localBusy = true; controls();
  result(add ? 'جاري محاولة الإضافة مرة واحدة…' : 'جاري فحص الرقم والعضوية…');
  try {
    const response = await api(add ? '/api/add' : '/api/check', { phone: $('phone').value, groupId: $('group').value, confirmed: $('consent').checked });
    const lines = [outcomes[response.status] || response.status];
    if (response.isAdmin !== undefined) lines.push(`الحساب أدمن في الجروب: ${response.isAdmin ? 'نعم' : 'لا'}`);
    if (response.membershipUnknown) lines.push('معرفات الخصوصية تمنع تأكيد العضوية؛ راجع الجروب يدويًا.');
    if (response.detail) lines.push(response.detail);
    if (response.repeatedRequest) lines.push('المحاولة السابقة غير مؤكدة؛ لم نكرر طلب الإضافة.');
    if (generation === requestGeneration) result(lines.join('\n'));
  } catch (error) { result(`${error.message}${add ? '\nلو الاتصال انقطع أثناء الإضافة، راجع الجروب قبل تكرارها.' : ''}`, true); }
  finally { $('consent').checked = false; localBusy = false; controls(); }
}

$('refresh').addEventListener('click', refreshGroups);
$('check').addEventListener('click', () => run(false));
$('add').addEventListener('click', () => run(true));
$('restart').addEventListener('click', async () => {
  $('restart').disabled = true;
  try { await api('/api/restart', {}); } catch (error) { result(error.message, true); }
  finally { $('restart').disabled = false; }
});
for (const id of ['phone', 'group']) $(id).addEventListener('input', () => { $('consent').checked = false; controls(); });
$('consent').addEventListener('change', controls);
void poll();
