import {useEffect,useState} from 'react';
import {api,post,put,number,dateTime} from './api';
import {Button,Field,Notice} from './components';
export type ServiceKind='fresh'|'message'|'historical';
const titles:Record<ServiceKind,string>={fresh:'إضافة المشترين للجروبات',message:'رسائل واتساب',historical:'إضافة العملاء القدامى'};
const descriptions:Record<ServiceKind,string>={fresh:'إضافة أصحاب الفواتير الحديثة عند اكتمال بياناتهم، خارج حصة العملاء القدامى.',message:'رسالة للعميل بعد طباعة فاتورته، خلال الوقت المسموح للإرسال.',historical:'اختيار العملاء بأعلى كود في كل فرع وتوزيع الانضمامات على ساعات العمل.'};
const states:Record<string,string>={waiting:'في الانتظار',running:'جارٍ التنفيذ',completed:'اكتملت',expired:'انتهت الصلاحية',skipped:'تم التخطي',review:'تحتاج مراجعة',cancelled:'ملغاة'};
const reasons:Record<string,string>={ttl_elapsed:'انتهى الوقت المسموح',messages_disabled:'الخدمة متوقفة وقت تسجيل الفاتورة',customer_incomplete:'بيانات العميل ناقصة',awaiting_print:'بانتظار الطباعة',invoice_deleted:'الفاتورة ملغاة',invoice_missing:'الفاتورة غير موجودة',invoice_owner_changed:'تغير صاحب الفاتورة',invalid_source_time:'تاريخ الفاتورة يحتاج مراجعة',enrollment_confirmed:'سبق انضمامه',enrollment_rejected:'مستبعد من الإضافة',enrollment_unknown:'نتيجة سابقة غير مؤكدة',not_on_whatsapp:'بدون واتساب',invite_required:'الخصوصية تمنع الإضافة',recently_left:'سبق أن غادر الجروب',pending_confirmation:'بانتظار تأكيد العضوية',remote_outcome_unknown:'نتيجة العملية تحتاج مراجعة',interrupted_remote_operation:'توقف أثناء العملية',joined:'انضمام مؤكد',already_member:'عضو بالفعل',joined_by_other_queue:'انضم من خدمة أخرى',source_or_connection_unavailable:'تعذر التحقق من الاتصال',customer_changed:'تغيرت بيانات العميل',group_unavailable:'الجروب غير جاهز',not_admin:'الحساب ليس أدمن',group_full:'الجروب ممتلئ',legacy_membership_requires_review:'حالة عضوية تحتاج مراجعة',daily_quota_reserved:'الحصة اليومية محجوزة',sent:'أُرسلت الرسالة',promoted_to_fresh:'انتقل لأولوية الشراء الجديد'};
type Props={company:any;refresh:()=>Promise<void>;notify:(s:string,error?:boolean)=>void;service:ServiceKind;navigate:(page:string)=>void};
export function ServiceSettings({company,refresh,notify,service,navigate}:Props) {
  const [data,setData]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const load=(r:any)=>setData({...r,branches:r.branches.map((b:any)=>({...b,fresh_enabled:!!b.fresh_enabled,historical_enabled:!!b.historical_enabled,messages_enabled:!!b.messages_enabled})),workStart:r.workStart??company.settings.workStart,workEnd:r.workEnd??company.settings.workEnd});
  useEffect(()=>{let alive=true;setData(null);setError('');api('/workflows').then(r=>{if(alive)load(r);}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[company.id,service]);
  if(!data)return <Notice tone={error?'error':'info'}>{error||'تحميل إعدادات الخدمة…'}</Notice>;
  const enabled=!!data.active[service];
  const databaseReady=company.source?.kind==='sql'&&!company.source?.last_error;
  const whatsappReady=company.whatsapp?.status==='ready';
  const change=(key:string,value:any)=>setData({...data,settings:{...data.settings,[key]:value}});
  const branchField=service==='fresh'?'fresh_enabled':service==='message'?'messages_enabled':'historical_enabled';
  const edit=(i:number,key:string,value:any)=>setData({...data,branches:data.branches.map((b:any,index:number)=>index===i?{...b,[key]:value}:b)});
  const persist=()=>put(`/workflows/services/${service}/config`,{
    branches:data.branches.map((b:any)=>({program_id:b.program_id,branch_id:b.branch_id,enabled:b[branchField],...(service==='historical'?{daily_limit:b.historical_limit}:{})})),
    ...(service==='fresh'?{fresh_ttl:data.settings.fresh_ttl}:service==='message'?{message_ttl:data.settings.message_ttl,message_template:data.settings.message_template}:{workStart:data.workStart,workEnd:data.workEnd}),
  });
  async function save(e:React.FormEvent) {e.preventDefault();setBusy(true);setError('');try{const result=await persist();await refresh();load(result);notify('تم حفظ إعدادات الخدمة.');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function toggle() {
    setError('');
    if(!enabled&&(!databaseReady||!whatsappReady)){setError(!databaseReady?'اربط قاعدة بيانات ERP أولًا لتشغيل الخدمة.':'اربط واتساب وانتظر اكتمال الاتصال أولًا لتشغيل الخدمة.');return;}
    setBusy(true);
    try{if(!enabled)await persist();load(await post(`/workflows/services/${service}`,{enabled:!enabled}));await refresh();notify(enabled?'تم إيقاف الخدمة.':'تم تشغيل الخدمة.');}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const jobs=data.jobs.filter((j:any)=>j.kind===service);
  const counts=data.counts.filter((c:any)=>c.kind===service);
  return <div className="service-page">
    <section className="panel service-heading">
      <div className="service-copy"><span className={`service-status ${enabled?'on':''}`}><i/>{enabled?(whatsappReady?'الخدمة مفعلة':'بانتظار اتصال واتساب'):'الخدمة متوقفة'}</span><h2>{titles[service]}</h2><p>{descriptions[service]}</p></div>
      <div className="service-switch"><span>{enabled?'إيقاف الخدمة':'تشغيل الخدمة'}</span><button type="button" role="switch" aria-label={`تشغيل وإيقاف ${titles[service]}`} aria-checked={enabled} disabled={busy} className={`toggle-switch ${enabled?'on':''}`} onClick={()=>void toggle()}><span/></button></div>
    </section>
    <div className="service-connections"><button type="button" onClick={()=>navigate('database')}><i className={`dot ${databaseReady?'green':'amber'}`}/>{databaseReady?'قاعدة البيانات متصلة':'ربط قاعدة البيانات'}</button><button type="button" onClick={()=>navigate('whatsapp')}><i className={`dot ${whatsappReady?'green':'amber'}`}/>{whatsappReady?'واتساب متصل':'ربط واتساب'}</button>{service!=='message'&&<button type="button" onClick={()=>navigate('groups')}>إدارة جروبات الفروع ←</button>}</div>
    {error&&<Notice tone="error">{error}</Notice>}
    <form onSubmit={save}>
      <section className="panel form-panel">
        <h2 className="section-title">إعدادات {titles[service]}</h2>
        {service==='fresh'&&<Field label="صلاحية الإضافة الفورية بالساعات" hint="الفاتورة الأقدم من هذه المدة تدخل ضمن أهلية دفعات العملاء القدامى."><input type="number" min={1} max={720} value={data.settings.fresh_ttl/3600} onChange={e=>change('fresh_ttl',Number(e.target.value)*3600)}/></Field>}
        {service==='message'&&<><Field label="صلاحية الإرسال بالدقائق" hint="تحسب من تاريخ إدخال الفاتورة، مع التحقق من الطباعة قبل الإرسال."><input type="number" min={1} max={1440} value={data.settings.message_ttl/60} onChange={e=>change('message_ttl',Number(e.target.value)*60)}/></Field><Field label="نص رسالة العميل" hint="المتغيرات: {customerName} · {companyName} · {invoiceNumber}"><textarea rows={4} value={data.settings.message_template} onChange={e=>change('message_template',e.target.value)}/></Field><Notice>رسالة واحدة لكل فاتورة. الفاتورة غير المطبوعة تنتظر حتى الطباعة أو انتهاء صلاحية الإرسال.</Notice></>}
        {service==='historical'&&<><div className="form-grid"><Field label="بداية ساعات العمل"><input type="time" value={data.workStart} onChange={e=>setData({...data,workStart:e.target.value})}/></Field><Field label="نهاية ساعات العمل" hint="المواعيد بتوقيت القاهرة"><input type="time" value={data.workEnd} onChange={e=>setData({...data,workEnd:e.target.value})}/></Field></div><Notice>العدد المستهدف هو انضمامات مؤكدة. الخصوصية أو عدم وجود واتساب يستبعد العميل بلا دعوة. زيادة العدد أثناء اليوم تطبق في اليوم التالي.</Notice></>}
      </section>
      <section className="panel form-panel">
        <h2 className="section-title">الفروع المشمولة</h2>
        <div className="table-scroll"><table className="data-table service-branch-table"><thead><tr><th>الفرع</th><th>الخدمة مفعلة للفرع</th>{service==='historical'&&<th>انضمامات مؤكدة يوميًا</th>}{service!=='message'&&<th>الجروب</th>}</tr></thead><tbody>
          {data.branches.map((b:any,i:number)=><tr key={`${b.program_id}:${b.branch_id}`}><td><strong>{b.name}</strong><small>كود الفرع {b.branch_id}</small></td><td><input aria-label={`تفعيل ${titles[service]} في ${b.name}`} type="checkbox" checked={b[branchField]} onChange={e=>edit(i,branchField,e.target.checked)}/></td>{service==='historical'&&<td><input aria-label={`عدد العملاء في ${b.name}`} type="number" min={0} max={10000} value={b.historical_limit} onChange={e=>edit(i,'historical_limit',Number(e.target.value))}/></td>}{service!=='message'&&<td>{!b.enabled?'الفرع متوقف':company.settings.distributionMode==='global'?(company.settings.globalGroupId?'الجروب العام':'غير مربوط'):(b.group_id?'مربوط':'غير مربوط')}</td>}</tr>)}
          {!data.branches.length&&<tr><td colSpan={4}>اربط قاعدة البيانات لاستيراد الفروع.</td></tr>}
        </tbody></table></div>
      </section>
      <div className="settings-save"><Button busy={busy}>حفظ إعدادات {titles[service]}</Button></div>
    </form>
    <section className="panel form-panel">
      <div className="service-log-title"><h2 className="section-title">نشاط الخدمة</h2><Button type="button" kind="secondary" busy={busy} onClick={async()=>{setBusy(true);try{load(await api('/workflows'));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>تحديث النشاط</Button></div>
      <div className="service-counts">{counts.map((c:any)=><span key={c.status}>{states[c.status]||c.status}<strong>{number(c.count)}</strong></span>)}</div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>العميل</th><th>الفرع</th><th>الحالة</th><th>السبب</th><th>تنتهي في</th></tr></thead><tbody>{jobs.map((j:any)=><tr key={j.id}><td>{j.customer_name||number(j.person_id)}</td><td>{j.branch_name}</td><td>{states[j.status]}</td><td>{reasons[j.reason]||'—'}</td><td>{dateTime(j.expires_at)}</td></tr>)}{!jobs.length&&<tr><td colSpan={5}>لا توجد مهام مسجلة لهذه الخدمة.</td></tr>}</tbody></table></div>
    </section>
  </div>;
}
