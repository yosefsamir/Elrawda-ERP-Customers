import type {AppDatabase} from '../../packages/storage/database.js';
import type {CompanyRepository} from '../../packages/storage/company-repository.js';
import type {localSecretStore} from './security.js';
import type {WorkflowJob} from '../../packages/domain/invoices.js';
import {readSqlInvoice,readSqlInvoiceCustomers,sqlIdentity} from '../../packages/erp/invoices.js';
import {Workflows} from '../../packages/storage/workflows.js';
/** On-demand reads only; this service cannot send WhatsApp operations. */
export function invoiceVerifier(db:AppDatabase,repo:CompanyRepository,secrets:ReturnType<typeof localSecretStore>) {
  return async(job:WorkflowJob)=>{
    const source=db.prepare('SELECT * FROM sources WHERE company_id=?').get(job.company_id) as any;
    if(source?.kind!=='sql')throw new Error('مصدر SQL مطلوب للتحقق');
    const config=secrets.decrypt(source.config);
    if(sqlIdentity(config)!==source.identity)throw new Error('هوية المصدر مختلفة');
    const refs=[{program:job.program_id,branch:job.branch_id,person:job.person_id}];
    const snapshot=await readSqlInvoiceCustomers(config,refs);
    const original=job.invoice_row_id?db.prepare('SELECT * FROM workflow_invoices WHERE id=? AND company_id=?').get(job.invoice_row_id,job.company_id) as any:null;
    const invoice=original?await readSqlInvoice(config,job.branch_id,original.invoice_id):null;
    db.transaction(()=>{
      db.prepare('UPDATE customers SET source_active=0 WHERE company_id=? AND program_id=? AND branch_id=? AND person_id=?')
        .run(job.company_id,job.program_id,job.branch_id,job.person_id);
      repo.ingest(job.company_id,snapshot,'sql',null,false);
      if(original) {
        if(!invoice)db.prepare("UPDATE workflow_jobs SET status='cancelled',reason='invoice_missing' WHERE invoice_row_id=? AND status='waiting'").run(original.id);
        else new Workflows(db,repo).ingest(job.company_id,{identity:source.identity,invoices:[invoice]});
      }
    })();
  };
}
