import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {Workflows} from '../../packages/storage/workflows.js';
import type {Context} from './context.js';
const branch=z.object({program_id:z.number().int().positive(),branch_id:z.number().int().positive(),fresh_enabled:z.boolean(),historical_enabled:z.boolean(),messages_enabled:z.boolean().default(true),historical_limit:z.number().int().min(0).max(10000)});
const config=z.object({mode:z.enum(['legacy','invoices']),fresh_enabled:z.boolean(),historical_enabled:z.boolean(),messages_enabled:z.boolean(),fresh_ttl:z.number().int().min(60).max(2592000),message_ttl:z.number().int().min(60).max(86400),message_template:z.string().trim().min(5).max(2000),branches:z.array(branch).max(1000),workStart:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),workEnd:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional()});
function company(r:FastifyRequest) {if(!r.companyId)throw Object.assign(new Error('أضف شركة أولًا'),{statusCode:400});return r.companyId;}
export function registerWorkflowRoutes(app:FastifyInstance,{db,repo,sync,wa}:Context) {
  const store=new Workflows(db,repo);
  const report=(id:string)=>{
    const source=db.prepare('SELECT kind,last_error FROM sources WHERE company_id=?').get(id) as any;
    const comp=db.prepare('SELECT run_mode,paused FROM companies WHERE id=?').get(id) as any;
    const r=store.report(id),live=comp.run_mode==='live'&&!comp.paused;
    return {...r,workStart:repo.settings(id).workStart,workEnd:repo.settings(id).workEnd,active:{fresh:live&&r.settings.fresh_enabled,historical:live&&r.settings.historical_enabled,message:live&&r.settings.messages_enabled},
      connections:{database:source?.kind==='sql'&&!source?.last_error,whatsapp:wa.state.companyId===id&&wa.state.status==='ready'}};
  };
  app.get('/api/workflows',async r=>report(company(r)));
  app.put('/api/workflows',async r=>{
    const input=config.parse(r.body),id=company(r),{branches,workStart,workEnd,...settings}=input,current=store.settings(id);
    if(new Set(branches.map(b=>`${b.program_id}:${b.branch_id}`)).size!==branches.length)throw Object.assign(new Error('فرع مكرر'),{statusCode:400});
    if(['mode','fresh_enabled','historical_enabled','messages_enabled'].some(k=>(settings as any)[k] !== (current as any)[k]))
      throw Object.assign(new Error('استخدم مفتاح تشغيل الخدمة لتغيير حالتها'),{statusCode:409});
    db.transaction(()=>{
      store.save(id,{...current,...settings},branches);
      if(workStart!==undefined||workEnd!==undefined)db.prepare('UPDATE companies SET settings=? WHERE id=?').run(JSON.stringify({...repo.settings(id),...(workStart!==undefined?{workStart}:{}),...(workEnd!==undefined?{workEnd}:{})}),id);
    })();
    return report(id);
  });
  app.put('/api/workflows/services/:kind/config',async r=>{
    const {kind}=z.object({kind:z.enum(['fresh','historical','message'])}).parse(r.params),id=company(r);
    const bs=z.array(z.object({program_id:z.number().int().positive(),branch_id:z.number().int().positive(),enabled:z.boolean(),daily_limit:z.number().int().min(0).max(10000).optional()}).strict()).max(1000);
    const time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
    const schema=kind==='fresh'?z.object({branches:bs,fresh_ttl:z.number().int().min(60).max(2592000)}).strict():kind==='message'?
      z.object({branches:bs,message_ttl:z.number().int().min(60).max(86400),message_template:z.string().trim().min(5).max(2000)}).strict():
      z.object({branches:bs,workStart:time,workEnd:time}).strict();
    const input=schema.parse(r.body) as any;
    if(new Set(input.branches.map((b:any)=>`${b.program_id}:${b.branch_id}`)).size!==input.branches.length)throw Object.assign(new Error('فرع مكرر'),{statusCode:400});
    db.transaction(()=>{
      const current=store.settings(id),branches=store.branches(id);
      const field=kind==='fresh'?'fresh_enabled':kind==='message'?'messages_enabled':'historical_enabled';
      for(const b of input.branches) {
        const target=branches.find(x=>x.program_id===b.program_id&&x.branch_id===b.branch_id);
        if(!target)throw Object.assign(new Error('فرع غير موجود في الشركة'),{statusCode:400});
        target[field]=b.enabled;
        if(kind==='historical') {if(b.daily_limit===undefined)throw Object.assign(new Error('حدد العدد اليومي لكل فرع'),{statusCode:400});target.historical_limit=b.daily_limit;}
      }
      store.save(id,{...current,...(kind==='fresh'?{fresh_ttl:input.fresh_ttl}:kind==='message'?{message_ttl:input.message_ttl,message_template:input.message_template}:{})},
        branches.map(b=>({...b,fresh_enabled:!!b.fresh_enabled,historical_enabled:!!b.historical_enabled,messages_enabled:!!b.messages_enabled})));
      if(kind==='historical')db.prepare('UPDATE companies SET settings=? WHERE id=?').run(JSON.stringify({...repo.settings(id),workStart:input.workStart,workEnd:input.workEnd}),id);
    })();
    return report(id);
  });
  app.post('/api/workflows/services/:kind',async r=>{
    const {kind}=z.object({kind:z.enum(['fresh','historical','message'])}).parse(r.params);
    const {enabled}=z.object({enabled:z.boolean()}).parse(r.body),id=company(r);
    const column={fresh:'fresh_enabled',historical:'historical_enabled',message:'messages_enabled'}[kind];
    store.settings(id);
    if(!enabled) {
      db.prepare(`UPDATE workflow_settings SET ${column}=0,control_generation=control_generation+1 WHERE company_id=?`).run(id);
      repo.audit(id,'service.stopped',{kind});return report(id);
    }
    const source=db.prepare('SELECT kind,config FROM sources WHERE company_id=?').get(id) as any;
    if(source?.kind!=='sql'||!source.config)throw Object.assign(new Error('اربط قاعدة بيانات ERP من صفحة قاعدة البيانات أولًا'),{statusCode:409});
    if(wa.state.companyId!==id||wa.state.status!=='ready')throw Object.assign(new Error('اربط واتساب وانتظر اكتمال الاتصال أولًا'),{statusCode:409});
    const generation=(db.prepare('UPDATE workflow_settings SET control_generation=control_generation+1 WHERE company_id=? RETURNING control_generation').get(id) as any).control_generation;
    await sync.run(id,{invoices:true}); // Proves the database is reachable before enabling a remote-writing service.
    db.transaction(()=>{
      if((db.prepare('SELECT control_generation FROM workflow_settings WHERE company_id=?').get(id) as any).control_generation!==generation)throw Object.assign(new Error('تغيرت حالة الخدمة أثناء الاتصال؛ راجع الحالة الحالية'),{statusCode:409});
      if(wa.state.companyId!==id||wa.state.status!=='ready')throw Object.assign(new Error('انقطع اتصال واتساب؛ أعد ربطه أولًا'),{statusCode:409});
      if(db.prepare("SELECT 1 FROM operations WHERE company_id=? AND status='started'").get(id))throw Object.assign(new Error('انتظر انتهاء العملية الجارية ثم شغّل الخدمة'),{statusCode:409});
      const comp=db.prepare('SELECT run_mode,paused FROM companies WHERE id=?').get(id) as any;
      const old=store.settings(id),live=comp.run_mode==='live'&&!comp.paused;
      const next={...old,mode:(kind==='message'&&old.mode==='legacy'?'legacy':'invoices') as 'legacy'|'invoices',fresh_enabled:live&&old.fresh_enabled,historical_enabled:live&&old.historical_enabled,messages_enabled:live&&old.messages_enabled,[column]:true};
      const bs=store.branches(id),policy=repo.settings(id);
      const linked=(b:any)=>b.enabled&&b.source_active&&(policy.distributionMode==='global'?policy.globalGroupId:b.group_id);
      if(next.mode==='invoices'&&next.fresh_enabled&&!bs.some(b=>b.fresh_enabled&&linked(b)))throw Object.assign(new Error('اربط جروبًا بفرع مفعّل من صفحة الجروبات أولًا'),{statusCode:409});
      if(next.mode==='invoices'&&next.historical_enabled&&!bs.some(b=>b.historical_enabled&&b.historical_limit>0&&linked(b)))throw Object.assign(new Error('فعّل فرعًا وحدد عدد العملاء واربط الجروب في إعدادات العملاء القدامى أولًا'),{statusCode:409});
      // Internal cutover barrier replaces the removed global UI control.
      db.prepare('UPDATE companies SET paused=1 WHERE id=?').run(id);
      store.save(id,next,bs.map(b=>({...b,fresh_enabled:!!b.fresh_enabled,historical_enabled:!!b.historical_enabled,messages_enabled:!!b.messages_enabled})));
      db.prepare("UPDATE companies SET paused=0,pause_until=NULL,run_mode='live' WHERE id=?").run(id);
      repo.audit(id,'service.started',{kind});
    })();
    return report(id);
  });
  app.post('/api/workflows/prepare',async r=>{const id=company(r);await sync.run(id,{invoices:true});return report(id);});
}
