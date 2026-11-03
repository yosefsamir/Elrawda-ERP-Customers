import type { AppDatabase } from './database.js';
import type { CompanyRepository } from './company-repository.js';
import { cairoDay } from '../domain/phone.js';
import { workWindow, type InvoiceBatch, type WorkflowSettings, type WorkflowBranch, type WorkflowJob } from '../domain/invoices.js';

const iso=(n:number)=>new Date(n).toISOString();
export class Workflows {
  constructor(readonly db:AppDatabase,readonly repo:CompanyRepository,readonly clock=()=>new Date()) {}
  settings(id:string): WorkflowSettings {
    this.db.prepare(`INSERT OR IGNORE INTO workflow_settings(company_id,fresh_enabled,historical_enabled)
      SELECT id,CASE WHEN run_mode='live' AND paused=0 THEN 1 ELSE 0 END,
        CASE WHEN run_mode='live' AND paused=0 AND COALESCE(json_extract(settings,'$.historicalDailyLimit'),0)>0 THEN 1 ELSE 0 END
      FROM companies WHERE id=?`).run(id);
    const r=this.db.prepare('SELECT * FROM workflow_settings WHERE company_id=?').get(id) as any;
    return {...r,fresh_enabled:!!r.fresh_enabled,historical_enabled:!!r.historical_enabled,messages_enabled:!!r.messages_enabled};
  }
  branches(id:string) {
    this.db.prepare(`INSERT OR IGNORE INTO workflow_branches(company_id,program_id,branch_id)
      SELECT company_id,program_id,branch_id FROM branches WHERE company_id=?`).run(id);
    return this.db.prepare(`SELECT w.*,b.name,b.group_id,b.enabled,b.source_active FROM workflow_branches w JOIN branches b
      USING(company_id,program_id,branch_id) WHERE w.company_id=? ORDER BY w.branch_id`).all(id) as any[];
  }
  save(id:string,input:WorkflowSettings,branches:WorkflowBranch[]) {
    this.db.transaction(()=>{
      const old=this.settings(id);
      const source=this.db.prepare('SELECT * FROM workflow_sources WHERE company_id=?').get(id) as any;
      if(old.mode==='invoices' && input.mode==='legacy') throw Object.assign(new Error('الرجوع للمحرك القديم يحتاج إجراء صيانة وتسوية المهام'),{statusCode:409});
      if(old.mode!==input.mode && input.mode==='invoices') {
        const company=this.db.prepare('SELECT paused FROM companies WHERE id=?').get(id) as any;
        if(!company.paused || this.db.prepare("SELECT 1 FROM operations WHERE company_id=? AND status='started'").get(id))
          throw Object.assign(new Error('أوقف المعالجة مؤقتًا وانتظر انتهاء العملية الجارية قبل التحويل'),{statusCode:409});
      }
      if(input.mode==='invoices' && !source?.baseline_complete) throw Object.assign(new Error('جهّز مصدر الفواتير أولًا قبل التحويل'),{statusCode:409});
      const now=this.clock().toISOString();
      this.db.prepare(`UPDATE workflow_settings SET mode=?,fresh_enabled=?,historical_enabled=?,fresh_ttl=?,message_ttl=?,
        message_template=?,messages_enabled=?,messages_enabled_at=?,activated_at=COALESCE(activated_at,?),transition_day=COALESCE(transition_day,?) WHERE company_id=?`)
        .run(input.mode,+input.fresh_enabled,+input.historical_enabled,input.fresh_ttl,input.message_ttl,input.message_template,+input.messages_enabled,
          input.messages_enabled?(old.messages_enabled_at && old.messages_enabled?old.messages_enabled_at:now):null,
          input.mode==='invoices'?now:null,input.mode==='invoices'?workWindow(this.repo.settings(id).workStart,this.repo.settings(id).workEnd,this.clock()).day:null,id);
      this.branches(id);
      for(const b of branches) {
        const change=this.db.prepare(`UPDATE workflow_branches SET fresh_enabled=?,historical_enabled=?,historical_limit=?,messages_enabled=?
          WHERE company_id=? AND program_id=? AND branch_id=?`).run(+b.fresh_enabled,+b.historical_enabled,b.historical_limit,+(b.messages_enabled??true),id,b.program_id,b.branch_id);
        if(!change.changes) throw Object.assign(new Error('فرع غير موجود في الشركة'),{statusCode:400});
      }
      // Capture evidence written by the legacy engine between installation and cutover.
      this.captureLegacyEvidence(id);
      this.repo.audit(id,'workflows.settings_updated',{mode:input.mode,fresh:input.fresh_enabled,historical:input.historical_enabled});
    })();
  }
  captureLegacyEvidence(id:string) {
    this.db.prepare(`INSERT OR IGNORE INTO workflow_enrollments(company_id,program_id,branch_id,person_id,phone,state,reason,updated_at)
      SELECT company_id,program_id,branch_id,person_id,phone,
      CASE WHEN membership_state IN('joined','already_member') THEN 'confirmed' ELSE 'unknown' END,
      'legacy:'||membership_state,COALESCE(membership_checked_at,first_seen) FROM customers
      WHERE company_id=? AND phone IS NOT NULL AND membership_state!='not_attempted'`).run(id);
    this.db.prepare(`UPDATE workflow_enrollments SET state='confirmed',reason='legacy:confirmed'
      WHERE company_id=? AND EXISTS(SELECT 1 FROM customers c WHERE c.company_id=workflow_enrollments.company_id
      AND c.program_id=workflow_enrollments.program_id AND c.branch_id=workflow_enrollments.branch_id
      AND c.person_id=workflow_enrollments.person_id AND c.phone=workflow_enrollments.phone AND c.membership_state IN('joined','already_member'))`).run(id);
    // A crash can leave operation intent persisted before customer membership was updated.
    this.db.prepare(`INSERT OR IGNORE INTO workflow_enrollments(company_id,program_id,branch_id,person_id,phone,state,group_id,reason,updated_at)
      SELECT c.company_id,c.program_id,c.branch_id,c.person_id,c.phone,
        CASE WHEN o.status='completed' AND json_extract(o.result,'$.status') IN('joined','already_member') THEN 'confirmed' ELSE 'unknown' END,
        json_extract(o.payload,'$.groupId'),'legacy:operation',o.updated_at
      FROM operations o JOIN customers c ON c.company_id=o.company_id AND c.phone=json_extract(o.payload,'$.phone')
      WHERE o.company_id=? AND o.kind='add' AND (o.status IN('started','unknown') OR
        (o.status='completed' AND json_extract(o.result,'$.status') IN('joined','already_member','addition_accepted','invite_required','not_on_whatsapp','recently_left')))`)
      .run(id);
    this.db.prepare(`UPDATE workflow_enrollments SET state='confirmed',reason='legacy:confirmed_operation' WHERE company_id=? AND
      EXISTS(SELECT 1 FROM operations o WHERE o.company_id=workflow_enrollments.company_id AND o.kind='add' AND o.status='completed'
      AND json_extract(o.payload,'$.phone')=workflow_enrollments.phone AND json_extract(o.result,'$.status') IN('joined','already_member'))`).run(id);

  }
  beginSource(id:string,identity:string) {
    const now=this.clock().toISOString();
    this.db.prepare('INSERT OR IGNORE INTO workflow_sources(company_id,identity,baseline_started_at) VALUES(?,?,?)').run(id,identity,now);
    const r=this.db.prepare('SELECT * FROM workflow_sources WHERE company_id=?').get(id) as any;
    if(r.identity!==identity) throw new Error('هوية مصدر الفواتير مختلفة عن المصدر المحفوظ');
    return r;
  }
  ingest(id:string,batch:InvoiceBatch) {
    return this.db.transaction(()=>{
      const source=this.beginSource(id,batch.identity),settings=this.settings(id),now=this.clock().toISOString();
      const seen=new Set<string>(); let added=0;
      for(const r of batch.invoices) {
        const key=`${r.idprogramitems}:${r.idbranch}:${r.idno_s}`;
        if(seen.has(key)) throw new Error('هوية فاتورة مكررة في المصدر');
        seen.add(key);
        const prior=this.db.prepare(`SELECT * FROM workflow_invoices WHERE company_id=? AND source_identity=? AND program_id=? AND branch_id=? AND invoice_id=?`)
          .get(id,batch.identity,r.idprogramitems,r.idbranch,r.idno_s) as any;
        const baseline=prior?.is_baseline ?? (!r.dateentry || r.dateentry<source.baseline_started_at?1:0);
        if(prior && prior.person_id===r.idperson && prior.printed===r.fprinted && prior.deleted===+r.deleted && prior.invoice_number===(r.fno_i??null)) continue;
        if(!prior) added++;
        this.db.prepare(`INSERT INTO workflow_invoices(company_id,source_identity,program_id,branch_id,invoice_id,person_id,invoice_number,entered_at,document_at,printed,deleted,is_baseline,first_seen,last_seen)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id,source_identity,program_id,branch_id,invoice_id) DO UPDATE SET
          person_id=excluded.person_id,invoice_number=excluded.invoice_number,printed=excluded.printed,deleted=excluded.deleted,last_seen=excluded.last_seen`)
          .run(id,batch.identity,r.idprogramitems,r.idbranch,r.idno_s,r.idperson,r.fno_i??null,r.dateentry,r.fdate,r.fprinted,+r.deleted,baseline,now,now);
        const inv=this.db.prepare(`SELECT * FROM workflow_invoices WHERE company_id=? AND source_identity=? AND program_id=? AND branch_id=? AND invoice_id=?`)
          .get(id,batch.identity,r.idprogramitems,r.idbranch,r.idno_s) as any;
        if(r.deleted) {
          this.db.prepare("UPDATE workflow_jobs SET status='cancelled',reason='invoice_deleted',updated_at=? WHERE invoice_row_id=? AND status='waiting'").run(now,inv.id);
          continue;
        }
        if(!baseline) {
          const valid=inv.entered_at && inv.entered_at<=now;
          const expires=valid?iso(Date.parse(inv.entered_at)+settings.fresh_ttl*1000):now;
          this.insertJob(id,'fresh',String(inv.id),r.idprogramitems,r.idbranch,r.idperson,inv.id,null,now,expires,valid?'waiting':'review',valid?null:'invalid_source_time');
          const branch=this.db.prepare('SELECT fresh_enabled FROM workflow_branches WHERE company_id=? AND program_id=? AND branch_id=?').get(id,r.idprogramitems,r.idbranch) as any;
          if(!prior && settings.fresh_enabled && branch?.fresh_enabled!==0 && expires>now) this.db.prepare("UPDATE workflow_jobs SET status='cancelled',reason='promoted_to_fresh',updated_at=? WHERE company_id=? AND program_id=? AND branch_id=? AND person_id=? AND kind='historical' AND status='waiting'")
            .run(now,id,r.idprogramitems,r.idbranch,r.idperson);
          // No executable backlog is created while messages are disabled.
          const enabled=settings.messages_enabled && settings.messages_enabled_at && inv.first_seen>=settings.messages_enabled_at;
          this.insertJob(id,'message',String(inv.id),r.idprogramitems,r.idbranch,r.idperson,inv.id,null,now,
            valid?iso(Date.parse(inv.entered_at)+settings.message_ttl*1000):now,enabled&&valid?'waiting':'skipped',enabled?null:'messages_disabled');
        }
        if(prior && prior.person_id!==r.idperson) this.db.prepare("UPDATE workflow_jobs SET status='review',reason='invoice_owner_changed',updated_at=? WHERE invoice_row_id=? AND status='waiting'").run(now,inv.id);
      }
      this.db.prepare('UPDATE workflow_sources SET baseline_complete=1,last_sync=? WHERE company_id=?').run(now,id);
      this.expire(id);
      return {added,total:batch.invoices.length,baseline:!source.baseline_complete};
    })();
  }
  insertJob(id:string,kind:string,key:string,program:number,branch:number,person:number,invoice:number|null,day:string|null,due:string,expires:string,status='waiting',reason:string|null=null) {
    const now=this.clock().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO workflow_jobs(company_id,kind,dedup_key,program_id,branch_id,person_id,invoice_row_id,day,status,due_at,expires_at,created_at,updated_at,reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,kind,key,program,branch,person,invoice,day,status,due,expires,now,now,reason);
  }
  expire(id:string) {
    const now=this.clock().toISOString();
    this.db.prepare("UPDATE workflow_jobs SET status='expired',reason='ttl_elapsed',updated_at=? WHERE company_id=? AND status='waiting' AND expires_at<=?").run(now,id,now);
  }
  customer(job:WorkflowJob) {
    return this.db.prepare(`SELECT c.*,b.group_id,b.enabled branch_enabled,b.source_active branch_active,b.name branch_name,b.base_name,b.next_counter
      FROM customers c JOIN branches b USING(company_id,program_id,branch_id)
      WHERE c.company_id=? AND c.program_id=? AND c.branch_id=? AND c.person_id=?`).get(job.company_id,job.program_id,job.branch_id,job.person_id) as any;
  }
  enrollment(id:string,c:any) {
    return this.db.prepare(`SELECT * FROM workflow_enrollments WHERE company_id=? AND
      (phone=? OR (program_id=? AND branch_id=? AND person_id=?)) ORDER BY CASE state WHEN 'confirmed' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END LIMIT 1`)
      .get(id,c.phone,c.program_id,c.branch_id,c.person_id) as any;
  }
  recordEnrollment(id:string,c:any,state:string,group:string|null,reason:string) {
    this.db.prepare(`INSERT INTO workflow_enrollments VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id,program_id,branch_id,person_id,phone)
      DO UPDATE SET state=excluded.state,group_id=excluded.group_id,reason=excluded.reason,updated_at=excluded.updated_at`)
      .run(id,c.program_id,c.branch_id,c.person_id,c.phone,state,group,reason,this.clock().toISOString());
  }
  finish(job:WorkflowJob,status:string,reason:string) {
    this.db.prepare('UPDATE workflow_jobs SET status=?,reason=?,updated_at=? WHERE id=?').run(status,reason,this.clock().toISOString(),job.id);
  }
  defer(job:WorkflowJob,reason:string,delay=30000) {
    this.db.prepare("UPDATE workflow_jobs SET status='waiting',reason=?,due_at=?,updated_at=? WHERE id=?")
      .run(reason,iso(this.clock().getTime()+delay),this.clock().toISOString(),job.id);
  }
  next(id:string,kind:WorkflowJob['kind']) {
    this.expire(id);
    return this.db.prepare(`SELECT j.* FROM workflow_jobs j JOIN branches b USING(company_id,program_id,branch_id)
      LEFT JOIN workflow_branches w USING(company_id,program_id,branch_id)
      WHERE j.company_id=? AND j.kind=? AND j.status='waiting' AND j.due_at<=? AND b.enabled=1 AND b.source_active=1
      AND ((j.kind='fresh' AND COALESCE(w.fresh_enabled,1)=1) OR (j.kind='historical' AND COALESCE(w.historical_enabled,0)=1 AND w.historical_limit>0)
      OR (j.kind='message' AND COALESCE(w.messages_enabled,1)=1)) ORDER BY j.expires_at,j.id LIMIT 1`)
      .get(id,kind,this.clock().toISOString()) as WorkflowJob|undefined;
  }
  planHistorical(id:string) {
    const settings=this.settings(id),legacy=this.repo.settings(id),now=this.clock(),stamp=now.toISOString();
    if(!settings.historical_enabled) return;
    const window=workWindow(legacy.workStart,legacy.workEnd,now);
    if(!window.active) return;
    const transition=(this.db.prepare('SELECT transition_day FROM workflow_settings WHERE company_id=?').get(id) as any).transition_day;
    for(const b of this.branches(id)) {
      if(!b.historical_enabled || !b.enabled || !b.source_active || b.historical_limit<=0) continue;
      if(!(legacy.distributionMode==='global'?legacy.globalGroupId:b.group_id)) continue;
      this.db.transaction(()=>{
        const carry=transition===window.day?(this.db.prepare('SELECT COALESCE(SUM(count),0) n FROM daily_usage WHERE company_id=? AND branch_id=? AND day>=? AND day<=?').get(id,b.branch_id,window.day,cairoDay(now)) as any).n:0;
        this.db.prepare(`INSERT OR IGNORE INTO workflow_day_plans VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(id,b.program_id,b.branch_id,window.day,b.historical_limit,carry,stamp,window.endAt,stamp);
        const plan=this.db.prepare('SELECT * FROM workflow_day_plans WHERE company_id=? AND program_id=? AND branch_id=? AND day=?').get(id,b.program_id,b.branch_id,window.day) as any;
        const target=Math.max(0,Math.min(plan.target,b.historical_limit)-plan.legacy_reserved);
        // After downtime spread untouched overdue slots over the remaining shift; preserve retry backoffs.
        const untouched=this.db.prepare("SELECT id,due_at FROM workflow_jobs WHERE company_id=? AND kind='historical' AND program_id=? AND branch_id=? AND day=? AND status='waiting' AND reason IS NULL ORDER BY person_id DESC")
          .all(id,b.program_id,b.branch_id,window.day) as {id:number;due_at:string}[];
        if(untouched.some(j=>Date.parse(j.due_at)<now.getTime()-60000)) {
          const remaining=Date.parse(plan.end_at)-now.getTime();
          untouched.forEach((j,i)=>this.db.prepare('UPDATE workflow_jobs SET due_at=? WHERE id=?').run(iso(now.getTime()+Math.floor(remaining*i/untouched.length)),j.id));
        }

        const reserved=(this.db.prepare(`SELECT COUNT(*) n FROM workflow_jobs WHERE company_id=? AND kind='historical' AND program_id=? AND branch_id=? AND day=?
          AND (status IN('waiting','running','review') OR (status='completed' AND reason='joined'))`).get(id,b.program_id,b.branch_id,window.day) as any).n;
        const slots=Math.max(0,target-reserved);
        if(!slots) return;
        const rows=this.db.prepare(`SELECT c.* FROM customers c WHERE c.company_id=? AND c.program_id=? AND c.branch_id=? AND c.source_active=1
          AND c.phone_state='valid' AND trim(c.name)!='' AND c.membership_state='not_attempted'
          AND NOT EXISTS(SELECT 1 FROM workflow_enrollments e WHERE e.company_id=c.company_id AND (e.phone=c.phone OR (e.program_id=c.program_id AND e.branch_id=c.branch_id AND e.person_id=c.person_id)))
          AND NOT EXISTS(SELECT 1 FROM workflow_jobs j WHERE j.company_id=c.company_id AND j.program_id=c.program_id AND j.branch_id=c.branch_id AND j.person_id=c.person_id
            AND ((j.kind='fresh' AND j.status IN('waiting','running','review')) OR (j.kind='historical' AND j.day=?)))
          ORDER BY c.person_id DESC LIMIT ?`).all(id,b.program_id,b.branch_id,window.day,slots) as any[];
        const span=Date.parse(plan.end_at)-now.getTime();
        rows.forEach((c,i)=>this.insertJob(id,'historical',`${window.day}:${c.program_id}:${c.branch_id}:${c.person_id}`,c.program_id,c.branch_id,c.person_id,null,window.day,
          iso(now.getTime()+Math.floor(span*i/Math.max(1,slots))),plan.end_at));
      })();
    }
  }
  report(id:string) {
    this.expire(id);
    return {settings:this.settings(id),branches:this.branches(id),messagesAvailable:true,
      source:this.db.prepare('SELECT * FROM workflow_sources WHERE company_id=?').get(id)??null,
      counts:this.db.prepare('SELECT kind,status,COUNT(*) count FROM workflow_jobs WHERE company_id=? GROUP BY kind,status').all(id),
      jobs:this.db.prepare(`SELECT j.*,c.name customer_name,b.name branch_name,i.invoice_id,i.printed FROM workflow_jobs j
        LEFT JOIN customers c ON c.company_id=j.company_id AND c.program_id=j.program_id AND c.branch_id=j.branch_id AND c.person_id=j.person_id
        LEFT JOIN branches b ON b.company_id=j.company_id AND b.program_id=j.program_id AND b.branch_id=j.branch_id
        LEFT JOIN workflow_invoices i ON i.id=j.invoice_row_id WHERE j.company_id=? ORDER BY j.id DESC LIMIT 50`).all(id)};
  }
}
