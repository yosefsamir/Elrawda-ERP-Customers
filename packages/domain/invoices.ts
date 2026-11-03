export type ErpInvoice = {
  idprogramitems: number; idbranch: number; idno_s: string; idperson: number;
  fno_i?: string | null; dateentry: string | null; fdate: string | null;
  fprinted: number; deleted: boolean;
};
export type InvoiceBatch = { identity: string; invoices: ErpInvoice[] };
export type InvoiceCursor = { enteredAt: string; branchId: number; invoiceId: string };
export type InvoiceReadOptions = { limit: number; through: string } &
  ({ kind: 'after'; cursor: InvoiceCursor } | { kind: 'recent' });
export type InvoicePage = InvoiceBatch & { cursor: InvoiceCursor | null };

/** SQL datetime is a Cairo wall clock; preserve milliseconds when constructing a read cursor. */
export function cairoSqlTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid invoice cursor date');
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const get = (key:string) => parts.find(p=>p.type===key)!.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}.${String(date.getUTCMilliseconds()).padStart(3,'0')}`;
}
export type WorkflowSettings = {
  mode: 'legacy' | 'invoices'; fresh_enabled: boolean; historical_enabled: boolean;
  messages_enabled: boolean; fresh_ttl: number; message_ttl: number;
  message_template: string; activated_at: string | null; messages_enabled_at: string | null;
};
export type WorkflowBranch = {
  program_id: number; branch_id: number; fresh_enabled: boolean;
  historical_enabled: boolean; historical_limit: number; messages_enabled?: boolean;
};
export type WorkflowJob = {
  id: number; company_id: string; kind: 'fresh'|'message'|'historical';
  program_id: number; branch_id: number; person_id: number; invoice_row_id: number|null;
  status: string; due_at: string; expires_at: string; day: string|null;
  phone: string|null; group_id: string|null; attempts: number;
};

/** ERP datetime has no offset. Interpret its wall clock in Cairo, not in the host timezone. */
export function cairoTimestamp(value: string | null): string | null {
  if (!value) return null;
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(value)) {
    const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (!/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,3})?$/.test(value)) return null;
  const wall = Date.parse(value.replace(' ', 'T')+'Z');
  if (!Number.isFinite(wall)) return null;
  let instant = wall;
  for (let i=0;i<3;i++) {
    const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant));
    const get=(key:string)=>parts.find(p=>p.type===key)!.value;
    const represented=Date.parse(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`)+(wall%1000);
    const next=instant+wall-represented;
    if(next===instant) return new Date(instant).toISOString();
    instant=next;
  }
  return null; // A nonexistent/ambiguous local transition is held for review, never made fresh.
}
export function workWindow(start:string,end:string,now:Date) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const get=(key:string)=>parts.find(p=>p.type===key)!.value;
  let day=`${get('year')}-${get('month')}-${get('day')}`;
  const clock=`${get('hour')}:${get('minute')}`;
  const shift=(d:string,n:number)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
  if(start>end && clock<end) day=shift(day,-1);
  const endDay=start>end?shift(day,1):day;
  const startAt=cairoTimestamp(`${day}T${start}:00`)!;
  const endAt=cairoTimestamp(`${endDay}T${end}:00`)!;
  return {day,startAt,endAt,active:start!==end && now.toISOString()>=startAt && now.toISOString()<endAt};
}
