import type { AppDatabase } from "../../packages/storage/database.js";
import type { CompanyRepository } from "../../packages/storage/company-repository.js";
import { readLocalSnapshot, readSqlSnapshot, type SqlConfig } from "../../packages/erp/source.js";
import { Workflows } from "../../packages/storage/workflows.js";
import { InvoiceReadState } from "../../packages/storage/invoice-read-state.js";
import { cairoSqlTimestamp, type InvoiceBatch } from "../../packages/domain/invoices.js";
import { readSqlInvoices, readSqlInvoiceCustomers, sqlIdentity, type PersonRef } from "../../packages/erp/invoices.js";
import type { localSecretStore } from "./security.js";

export class SyncService {
  private active = new Map<string, Promise<any>>();
  private closing = false;
  constructor(private db: AppDatabase, private repo: CompanyRepository,
    private secrets: ReturnType<typeof localSecretStore>, private root: string,
    private readSql = readSqlSnapshot,
    private invoiceReader = readSqlInvoices, private customerReader = readSqlInvoiceCustomers,private clock=()=>new Date()) {}

  run(id: string, options: {full?:boolean;config?:SqlConfig;local?:boolean;invoices?:boolean} = {}): Promise<any> {
    if (this.closing) return Promise.reject(Object.assign(new Error("جارٍ إيقاف المزامنة"),{statusCode:503}));
    const prior = this.active.get(id);
    if (prior) return Promise.reject(Object.assign(new Error("مزامنة هذه الشركة جارية بالفعل"),{statusCode:409}));
    const task = this.perform(id,options).finally(() => this.active.delete(id));
    this.active.set(id,task);
    return task;
  }
  async stop() { this.closing = true; await Promise.allSettled(this.active.values()); }

  private async perform(id: string, options: {full?:boolean;config?:SqlConfig;local?:boolean;invoices?:boolean}) {
    const source = this.db.prepare("SELECT * FROM sources WHERE company_id=?").get(id) as any;
    if (!source && !options.config && !options.local) throw Object.assign(new Error("حدد مصدر البيانات أولًا"),{statusCode:400});
    const kind = options.local ? "snapshot" : options.config ? "sql" : source.kind;
    const full = Boolean(options.config || options.full || !source?.baseline_complete || !source?.last_full_sync ||
      Date.now()-Date.parse(source.last_full_sync) >= 60*60000);
    try {
      const workflows=new Workflows(this.db,this.repo,this.clock);
      const invoiceMode=workflows.settings(id).mode==='invoices';
      const config=kind==='sql'?(options.config ?? this.secrets.decrypt(source.config)):null;
      if(config && options.invoices) workflows.beginSource(id,sqlIdentity(config));
      let result:any;
      if(!invoiceMode || full && options.full) {
        const snapshot = kind === "snapshot" ? await readLocalSnapshot(this.root) : await this.readSql(
          config!, full ? undefined : {watermarks:this.repo.getBranchWatermarks(id),recheckIds:this.repo.getPendingRecheckPersonIds(id)});
        result=this.repo.ingest(id,snapshot,kind,options.config?this.secrets.encrypt(options.config):null,full || kind==='snapshot');
      }
      const prepared=this.db.prepare('SELECT 1 FROM workflow_sources WHERE company_id=?').get(id);
      if(kind==='sql' && (invoiceMode || options.invoices || prepared)) {
        try {
          workflows.beginSource(id,sqlIdentity(config!));
          const reads=new InvoiceReadState(this.db,this.clock),cursor=reads.cursor(id),through=cairoSqlTimestamp(this.clock().toISOString());
          // Reserve at least 10 headers for recent sales even while draining an old backlog.
          const page=await this.invoiceReader(config!,{kind:'after',cursor,limit:40,through});
          if(page.identity!==sqlIdentity(config!)||page.invoices.length>40)throw new Error('Invalid invoice page');
          const remaining=50-page.invoices.length;
          const recent=remaining?await this.invoiceReader(config!,{kind:'recent',limit:remaining,through}):null;
          if(recent&&(recent.identity!==page.identity||recent.invoices.length>remaining))throw new Error('Invalid recent invoice page');
          const unique=new Map([...page.invoices,...(recent?.invoices??[])].map(i=>[`${i.idprogramitems}:${i.idbranch}:${i.idno_s}`,i]));
          const batch:InvoiceBatch={identity:page.identity,invoices:[...unique.values()]};
          const refs:PersonRef[]=[];
          for(const i of batch.invoices) {
            if(i.deleted) continue;
            const prior=this.db.prepare('SELECT person_id,printed FROM workflow_invoices WHERE company_id=? AND source_identity=? AND program_id=? AND branch_id=? AND invoice_id=?')
              .get(id,batch.identity,i.idprogramitems,i.idbranch,i.idno_s) as any;
            const customer=this.db.prepare('SELECT phone_state,name,source_active FROM customers WHERE company_id=? AND program_id=? AND branch_id=? AND person_id=?')
              .get(id,i.idprogramitems,i.idbranch,i.idperson) as any;
            if(!prior || prior.person_id!==i.idperson || !customer || customer.phone_state!=='valid' || !customer.name?.trim() || !customer.source_active) refs.push({program:i.idprogramitems,branch:i.idbranch,person:i.idperson});
          }
          const pending=reads.pendingCustomers(id);
          refs.push(...pending.refs);
          const requested=[...new Map(refs.map(r=>[`${r.program}:${r.branch}:${r.person}`,r])).values()];
          const snapshot=await this.customerReader(config!,requested);
          if(snapshot.identity!==batch.identity)throw new Error('Invoice customer source does not match');
          result=this.db.transaction(()=>{
            // Targeted absent rows mean hidden/non-customer/deleted records, not a full customer purge.
            for(const r of requested) this.db.prepare('UPDATE customers SET source_active=0 WHERE company_id=? AND program_id=? AND branch_id=? AND person_id=?').run(id,r.program,r.branch,r.person);
            const customers=this.repo.ingest(id,snapshot,kind,null,false);
            const invoices=workflows.ingest(id,batch);
            reads.save(id,page.cursor??cursor,pending.cursor);
            return {...customers,invoices};
          })();
        } catch(error) {
          if(invoiceMode || options.invoices) throw error;
          // An optional shadow read must never interrupt the installed legacy customer flow.
          this.repo.audit(id,'invoices.shadow_failed',{code:String((error as any).code||'INVOICE_READ_FAILED')});
        }
      } else if(options.invoices) throw Object.assign(new Error('تجهيز الفواتير يتطلب مصدر SQL فعليًا'),{statusCode:400});
      this.db.prepare("UPDATE sources SET last_error=NULL,last_attempt=?,last_full_sync=CASE WHEN ? THEN ? ELSE last_full_sync END WHERE company_id=?")
        .run(new Date().toISOString(),full ? 1 : 0,new Date().toISOString(),id);
      return result;
    } catch (error) {
      const code = String((error as any).code || "SYNC_FAILED").replace(/[^A-Z_0-9]/g, "").slice(0,30);
      this.db.prepare("UPDATE sources SET last_error=?,last_attempt=? WHERE company_id=?")
        .run(`تعذر تحديث المصدر (${code}). راجع الاتصال والصلاحيات.`,new Date().toISOString(),id);
      this.repo.audit(id,"source.sync_failed",{code});
      throw error;
    }
  }
}
