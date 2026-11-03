import type { AppDatabase } from '../../packages/storage/database.js';
import type { CompanyRepository } from '../../packages/storage/company-repository.js';
import { Workflows } from '../../packages/storage/workflows.js';
import { Operations } from '../../packages/storage/operations.js';
import type { WorkflowJob } from '../../packages/domain/invoices.js';
import { workWindow } from '../../packages/domain/invoices.js';
import type { WhatsAppBridge } from './whatsapp-bridge.js';

/** Three logical queues, one serialized WhatsApp dispatcher. Reader never performs remote writes. */
export class InvoiceWorkers {
  private timer?:NodeJS.Timeout;
  private inFlight?:Promise<void>;
  private stopping=false;
  private ops:Operations;
  readonly store:Workflows;
  constructor(private db:AppDatabase,private repo:CompanyRepository,private wa:WhatsAppBridge,
    private verify:(job:WorkflowJob)=>Promise<void>=async()=>{},private clock=()=>new Date(),
    private messagesAvailable=true) {
    this.store=new Workflows(db,repo,clock); this.ops=new Operations(db);
    this.ops.recover();
    db.prepare(`INSERT OR IGNORE INTO workflow_enrollments(company_id,program_id,branch_id,person_id,phone,state,group_id,reason,updated_at)
      SELECT company_id,program_id,branch_id,person_id,phone,'unknown',group_id,'interrupted_remote_operation',updated_at
      FROM workflow_jobs WHERE status='running' AND phone IS NOT NULL`).run();
    db.prepare("UPDATE workflow_jobs SET status='review',reason='interrupted_remote_operation' WHERE status='running'").run();
  }
  start(interval=4000) {
    if(this.timer) return;
    this.stopping=false;
    this.timer=setInterval(()=>{void this.tick().catch(()=>console.error('Invoice worker cycle failed; persisted tasks retained.'));},interval);
    this.timer.unref();
  }
  async stop() {this.stopping=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.inFlight;}
  tick():Promise<void> {
    if(this.stopping)return Promise.resolve();
    return this.inFlight??(this.inFlight=this.process().finally(()=>{this.inFlight=undefined;}));
  }
  private live(id:string) {
    return !this.stopping && this.wa.state.companyId===id && this.wa.state.status==='ready' && !!this.db.prepare(`SELECT 1 FROM companies c JOIN workflow_settings w ON w.company_id=c.id
      WHERE c.id=? AND c.paused=0 AND c.run_mode='live' AND (w.mode='invoices' OR w.messages_enabled=1)`).get(id);
  }
  private allowed(job:WorkflowJob) {
    if(!this.live(job.company_id)||job.expires_at<=this.clock().toISOString())return false;
    const s=this.store.settings(job.company_id);
    if(job.kind!=='message'&&s.mode!=='invoices')return false;
    const b=this.store.branches(job.company_id).find(x=>x.program_id===job.program_id&&x.branch_id===job.branch_id);
    if(!b?.enabled||!b.source_active) return false;
    if(job.kind==='fresh' && (!s.fresh_enabled||!b.fresh_enabled))return false;
    if(job.kind==='message' && (!this.messagesAvailable||!s.messages_enabled||!b.messages_enabled))return false;
    if(job.kind==='historical' && (!s.historical_enabled||!b.historical_enabled||!workWindow(this.repo.settings(job.company_id).workStart,this.repo.settings(job.company_id).workEnd,this.clock()).active))return false;
    if(job.invoice_row_id) {
      const inv=this.db.prepare('SELECT deleted,person_id FROM workflow_invoices WHERE id=?').get(job.invoice_row_id) as any;
      if(!inv||inv.deleted||inv.person_id!==job.person_id)return false;
    }
    const row=this.db.prepare('SELECT status FROM workflow_jobs WHERE id=?').get(job.id) as any;
    return ['waiting','running'].includes(row?.status);
  }
  private async process() {
    const companies=this.db.prepare("SELECT company_id FROM workflow_settings WHERE mode='invoices' OR messages_enabled=1").all() as {company_id:string}[];
    for(const {company_id:id} of companies) {
      this.db.prepare("UPDATE companies SET paused=0,pause_until=NULL WHERE id=? AND paused=1 AND pause_until<=?").run(id,this.clock().toISOString());
      this.store.expire(id);
      if(!this.live(id))continue;
      this.store.captureLegacyEvidence(id);
      this.db.prepare(`UPDATE workflow_jobs SET status='completed',reason='joined',updated_at=? WHERE company_id=? AND kind!='message' AND status='review' AND phone IS NOT NULL
        AND EXISTS(SELECT 1 FROM workflow_enrollments e WHERE e.company_id=workflow_jobs.company_id AND e.phone=workflow_jobs.phone AND e.state='confirmed')`).run(this.clock().toISOString(),id);
      await this.confirmPending(id);
      if(this.store.settings(id).mode==='invoices')this.store.planHistorical(id);
      for(const kind of ['message','fresh','historical'] as const) {
        if(!this.live(id))break;
        const job=this.store.next(id,kind);
        if(!job||!this.allowed(job))continue;
        try { if(kind==='message')await this.message(job);else await this.add(job); }
        catch {
          const state=this.db.prepare('SELECT status FROM workflow_jobs WHERE id=?').get(job.id) as any;
          if(state?.status==='running')this.store.finish(job,'review','remote_outcome_unknown');
          else if(state?.status==='waiting')this.store.defer(job,'source_or_connection_unavailable');
        }
      }
    }
  }
  private async destination(job:WorkflowJob,c:any) {
    const id=job.company_id,s=this.repo.settings(id);
    let group:string|null=s.distributionMode==='global'?s.globalGroupId??null:c.group_id;
    if(!group)return null;
    const current=(expected:string)=>{
      const now=this.store.customer(job),cfg=this.repo.settings(id);
      return this.allowed(job)&&now?.phone===c.phone&&now.source_active&&now.branch_active&&
        (cfg.distributionMode==='global'?cfg.globalGroupId:now.group_id)===expected;
    };
    const info=await this.wa.call(id,'get_group_info',{groupId:group});
    if(!current(group))return null;
    if(!Number.isFinite(info?.participantCount))throw new Error('group_metadata_unavailable');
    if(info.participantCount>=s.rolloverThreshold) {
      const global=s.distributionMode==='global';
      const base=global?s.globalBaseName||s.globalGroupTitle||'العملاء':c.base_name||c.branch_name;
      const counter=global?s.globalNextCounter||2:c.next_counter||2;
      const old=group,title=`${base} ${counter}`;
      const created=await this.ops.run(id,'rollover',old,{title},async()=>{
        const result=await this.wa.call(id,'create_group',{title});
        if(typeof result?.groupId!=='string'||!/^\d+(?:-\d+)?@g\.us$/.test(result.groupId))throw new Error('unknown_group_result');
        return result;
      });
      this.db.transaction(()=>{
        this.ops.complete(id,'rollover',old,created.value);
        if(!current(old))return;
        group=created.value.groupId;
        if(global)this.db.prepare('UPDATE companies SET settings=? WHERE id=?').run(JSON.stringify({...this.repo.settings(id),globalGroupId:group,globalGroupTitle:title,globalBaseName:base,globalNextCounter:counter+1}),id);
        else this.repo.updateBranchGroup(id,c.program_id,c.branch_id,group!,counter+1,title);
        this.repo.audit(id,'group.rollover',{oldGroupId:old,newGroupId:group,title});
      })();
    }
    return current(group!)?group:null;
  }
  private async add(job:WorkflowJob) {
    let c=this.store.customer(job);
    if(!c?.source_active||!c.branch_active||c.phone_state!=='valid'||!c.name?.trim())return this.store.defer(job,'customer_incomplete');
    const prior=this.store.enrollment(job.company_id,c);
    if(prior)return this.store.finish(job,prior.state==='confirmed'?'skipped':prior.state==='rejected'?'skipped':'review',`enrollment_${prior.state}`);
    if(c.membership_state!=='not_attempted')return this.store.finish(job,'review','legacy_membership_requires_review');
    await this.verify(job);
    if(!this.allowed(job))return;
    const refreshed=this.store.customer(job);
    if(!refreshed?.source_active||refreshed.phone!==c.phone)return this.store.defer(job,'customer_changed');
    if(job.kind==='historical') {
      const plan=this.db.prepare('SELECT * FROM workflow_day_plans WHERE company_id=? AND program_id=? AND branch_id=? AND day=?').get(job.company_id,job.program_id,job.branch_id,job.day) as any;
      const branch=this.store.branches(job.company_id).find(b=>b.program_id===job.program_id&&b.branch_id===job.branch_id)!;
      const used=(this.db.prepare(`SELECT count(*) n FROM workflow_jobs WHERE company_id=? AND kind='historical' AND program_id=? AND branch_id=? AND day=? AND
        ((status='completed' AND reason='joined') OR status IN('running','review'))`).get(job.company_id,job.program_id,job.branch_id,job.day) as any).n;
      if(!plan||used+plan.legacy_reserved>=Math.min(plan.target,branch.historical_limit))return this.store.defer(job,'daily_quota_reserved');
    }
    const group=await this.destination(job,c);
    if(!group) {if(this.allowed(job))this.store.defer(job,'group_unavailable');return;}
    if(!this.allowed(job))return;
    const finalCustomer=this.store.customer(job),finalEnrollment=this.store.enrollment(job.company_id,c);
    if(finalEnrollment)return this.store.finish(job,finalEnrollment.state==='unknown'?'review':'skipped',`enrollment_${finalEnrollment.state}`);
    if(!finalCustomer?.source_active||finalCustomer.phone!==c.phone||finalCustomer.membership_state!=='not_attempted')return this.store.defer(job,'customer_changed');
    const key=`${group}:${c.phone}`;
    this.db.prepare("UPDATE workflow_jobs SET status='running',phone=?,group_id=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='waiting'")
      .run(c.phone,group,this.clock().toISOString(),job.id);
    try {
      const result=await this.ops.run(job.company_id,'add',key,{groupId:group,phone:c.phone},()=>this.wa.call(job.company_id,'add_participant',{groupId:group,phone:c.phone}));
      const status=result.value.status;
      this.db.transaction(()=>{
        this.ops.complete(job.company_id,'add',key,result.value);
        if(['joined','already_member'].includes(status)) {
          this.store.recordEnrollment(job.company_id,c,'confirmed',group,status);
          this.repo.updateCustomerMembership(job.company_id,c.program_id,c.branch_id,c.person_id,{membership_state:status,whatsapp_state:'registered',expected_phone:c.phone});
          this.store.finish(job,'completed',status);
          // A historical reservation for this person must not consume a second slot after promotion.
          this.db.prepare("UPDATE workflow_jobs SET status='skipped',reason='joined_by_other_queue' WHERE company_id=? AND program_id=? AND branch_id=? AND person_id=? AND id!=? AND kind IN('fresh','historical') AND status='waiting'")
            .run(job.company_id,c.program_id,c.branch_id,c.person_id,job.id);
        } else if(['invite_required','not_on_whatsapp','recently_left'].includes(status)) {
          this.store.recordEnrollment(job.company_id,c,'rejected',group,status);
          this.repo.updateCustomerMembership(job.company_id,c.program_id,c.branch_id,c.person_id,{membership_state:'review',whatsapp_state:status==='not_on_whatsapp'?'not_registered':undefined,expected_phone:c.phone});
          this.store.finish(job,'skipped',status); // No invitation and no automatic retry.
        } else if(['not_admin','group_full'].includes(status)) {
          // These explicit responses establish no member write happened. A later metadata check may retry.
          this.db.prepare("DELETE FROM operations WHERE company_id=? AND kind='add' AND dedup_key=? AND status='completed'").run(job.company_id,key);
          this.store.defer(job,status,60000);
        } else {
          this.store.recordEnrollment(job.company_id,c,'unknown',group,status);
          this.repo.updateCustomerMembership(job.company_id,c.program_id,c.branch_id,c.person_id,{membership_state:status==='addition_accepted'?'pending':'review',expected_phone:c.phone});
          this.store.finish(job,'review',status==='addition_accepted'?'pending_confirmation':'remote_outcome_unknown');
          this.db.prepare('UPDATE workflow_jobs SET due_at=? WHERE id=?').run(new Date(this.clock().getTime()+30000).toISOString(),job.id);
        }
      })();
    } catch(error) {
      this.store.recordEnrollment(job.company_id,c,'unknown',group,'remote_outcome_unknown');
      this.store.finish(job,'review','remote_outcome_unknown');
      throw error;
    }
  }
  private async confirmPending(id:string) {
    const job=this.db.prepare("SELECT * FROM workflow_jobs WHERE company_id=? AND status='review' AND reason='pending_confirmation' AND due_at<=? ORDER BY due_at LIMIT 1").get(id,this.clock().toISOString()) as WorkflowJob|undefined;
    if(!job?.phone||!job.group_id)return;
    this.db.prepare('UPDATE workflow_jobs SET due_at=? WHERE id=?').run(new Date(this.clock().getTime()+60000).toISOString(),job.id);
    try {
      const result=await this.wa.call(id,'get_membership',{groupId:job.group_id,phone:job.phone});
      if(!['joined','already_member'].includes(result?.status))return;
      const c={program_id:job.program_id,branch_id:job.branch_id,person_id:job.person_id,phone:job.phone};
      this.db.transaction(()=>{
        this.store.recordEnrollment(id,c,'confirmed',job.group_id,'joined');
        this.repo.updateCustomerMembership(id,c.program_id,c.branch_id,c.person_id,{membership_state:'joined',whatsapp_state:'registered',expected_phone:c.phone});
        this.ops.complete(id,'add',`${job.group_id}:${job.phone}`,{status:'joined'});
        this.store.finish(job,'completed','joined');
      })();
    }catch{/* Read-only reconciliation may be retried; additions never are. */}
  }
  private async message(job:WorkflowJob) {
    if(!this.messagesAvailable)return;
    const c=this.store.customer(job);
    if(!c?.source_active||c.phone_state!=='valid'||!c.name?.trim())return this.store.defer(job,'customer_incomplete');
    await this.verify(job);
    if(!this.allowed(job))return;
    const inv=this.db.prepare('SELECT * FROM workflow_invoices WHERE id=?').get(job.invoice_row_id) as any;
    if(!inv?.printed)return this.store.defer(job,'awaiting_print');
    const current=this.store.customer(job);
    if(current.phone!==c.phone)return this.store.defer(job,'customer_changed');
    const company=this.db.prepare('SELECT name FROM companies WHERE id=?').get(job.company_id) as any;
    const template=this.store.settings(job.company_id).message_template;
    const text=template.replaceAll('{customerName}',c.name).replaceAll('{companyName}',company.name).replaceAll('{invoiceNumber}',inv.invoice_number||inv.invoice_id);
    const key=`${inv.source_identity}:${inv.program_id}:${inv.branch_id}:${inv.invoice_id}`;
    this.db.prepare("UPDATE workflow_jobs SET status='running',phone=?,attempts=attempts+1 WHERE id=?").run(c.phone,job.id);
    try {
      const sent=await this.ops.run(job.company_id,'invoice_message',key,{phone:c.phone,text},async()=>{
        if(!this.allowed(job))throw new Error('message_no_longer_eligible');
        const r=await this.wa.call(job.company_id,'send_message',{phone:c.phone,text});
        if(r?.status!=='sent'||!r.messageId)throw new Error('message_outcome_unknown');
        return r;
      });
      this.db.transaction(()=>{this.ops.complete(job.company_id,'invoice_message',key,sent.value);this.store.finish(job,'completed','sent');})();
    }catch(error){this.store.finish(job,'review','remote_outcome_unknown');throw error;}
  }
}
