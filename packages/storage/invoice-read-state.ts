import type {AppDatabase} from './database.js';
import {cairoSqlTimestamp,type InvoiceCursor} from '../domain/invoices.js';

/** Checkpoints advance in the same transaction as invoices, customers and jobs. */
export class InvoiceReadState {
  constructor(private db:AppDatabase,private clock=()=>new Date()) {}
  cursor(id:string):InvoiceCursor {
    const saved=this.db.prepare('SELECT cursor FROM workflow_invoice_reads WHERE company_id=?').get(id) as any;
    if(saved)return JSON.parse(saved.cursor);
    const source=this.db.prepare('SELECT identity,baseline_started_at FROM workflow_sources WHERE company_id=?').get(id) as any;
    if(!source)throw new Error('Invoice source has not been prepared');
    // Upgrade from the previous reader: resume from its saved inventory instead of resetting progress.
    const last=this.db.prepare(`SELECT entered_at,branch_id,invoice_id FROM workflow_invoices
      WHERE company_id=? AND source_identity=? AND entered_at>=? AND entered_at<=?
      ORDER BY entered_at DESC,branch_id DESC,length(invoice_id) DESC,invoice_id DESC LIMIT 1`)
      .get(id,source.identity,source.baseline_started_at,this.clock().toISOString()) as any;
    return last?{enteredAt:cairoSqlTimestamp(last.entered_at),branchId:last.branch_id,invoiceId:last.invoice_id}:
      {enteredAt:cairoSqlTimestamp(source.baseline_started_at),branchId:0,invoiceId:'0'};
  }
  pendingCustomers(id:string) {
    const saved=this.db.prepare('SELECT customer_cursor FROM workflow_invoice_reads WHERE company_id=?').get(id) as any;
    const select=this.db.prepare(`SELECT i.id,i.program_id,i.branch_id,i.person_id FROM workflow_invoices i
      LEFT JOIN customers c ON c.company_id=i.company_id AND c.program_id=i.program_id AND c.branch_id=i.branch_id AND c.person_id=i.person_id
      WHERE i.company_id=? AND i.id>? AND i.deleted=0
      AND (c.person_id IS NULL OR c.phone_state!='valid' OR trim(c.name)='' OR c.source_active=0)
      AND EXISTS(SELECT 1 FROM workflow_jobs j WHERE j.invoice_row_id=i.id AND j.status='waiting' AND j.expires_at>?)
      ORDER BY i.id LIMIT 50`);
    let rows=select.all(id,saved?.customer_cursor??0,this.clock().toISOString()) as any[];
    if(!rows.length&&saved?.customer_cursor)rows=select.all(id,0,this.clock().toISOString()) as any[];
    return {cursor:rows.at(-1)?.id??0,refs:rows.map(r=>({program:r.program_id,branch:r.branch_id,person:r.person_id}))};
  }
  save(id:string,cursor:InvoiceCursor,customerCursor:number) {
    this.db.prepare(`INSERT INTO workflow_invoice_reads(company_id,cursor,customer_cursor,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(company_id) DO UPDATE SET cursor=excluded.cursor,customer_cursor=excluded.customer_cursor,updated_at=excluded.updated_at`)
      .run(id,JSON.stringify(cursor),customerCursor,this.clock().toISOString());
  }
}
