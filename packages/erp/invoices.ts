import sql from 'mssql';
import type {SqlConfig} from './source.js';
import type {SourceSnapshot} from '../domain/contracts.js';
import {cairoTimestamp,type ErpInvoice,type InvoicePage,type InvoiceReadOptions} from '../domain/invoices.js';
export type PersonRef={program:number;branch:number;person:number};
export const sqlIdentity=(c:SqlConfig)=>`sql:${c.server.toLowerCase()}:${c.instance.toLowerCase()}:${c.database.toLowerCase()}:${c.programId}`;
function pool(config:SqlConfig) {
  return new sql.ConnectionPool({server:config.server,database:config.database,user:config.user,password:config.password,
    connectionTimeout:8000,requestTimeout:15000,pool:{max:1,min:0,idleTimeoutMillis:1000},options:{instanceName:config.instance||undefined,
      encrypt:config.encrypt,trustServerCertificate:config.trustServerCertificate,appName:'Customer Operations Read Only'}});
}
const columns=`i.idprogramitems,i.idbranch,CONVERT(varchar(30),i.idno_s) idno_s,i.idperson,
  CONVERT(varchar(30),i.fno_i) fno_i,CONVERT(varchar(23),i.dateentry,126) dateentry,
  CONVERT(varchar(23),i.fdate,126) fdate,COALESCE(i.fprinted,0) fprinted,COALESCE(i.deleted,0) deleted`;
function invoice(r:any):ErpInvoice {
  for(const k of ['idprogramitems','idbranch','idperson']) if(!Number.isSafeInteger(Number(r[k]))) throw new Error('معرف ERP خارج النطاق الرقمي الآمن');
  if(!/^\d+$/.test(String(r.idno_s))) throw new Error('معرف فاتورة غير صالح');
  return {...r,idprogramitems:Number(r.idprogramitems),idbranch:Number(r.idbranch),idperson:Number(r.idperson),idno_s:String(r.idno_s),
    dateentry:cairoTimestamp(r.dateentry),fdate:cairoTimestamp(r.fdate),fprinted:Math.max(0,Number(r.fprinted)||0),deleted:!!r.deleted};
}
/** Bounded keyset pages for discovery; a recent-page overlap refreshes changed headers. */
export async function readSqlInvoices(config:SqlConfig,options:InvoiceReadOptions):Promise<InvoicePage> {
  if(!Number.isInteger(options.limit)||options.limit<1||options.limit>50)throw new Error('Invoice page limit must be between 1 and 50');
  const db=pool(config);
  try {
    await db.connect();
    const request=db.request().input('program',sql.BigInt,config.programId).input('limit',sql.Int,options.limit)
      .input('through',sql.VarChar(23),options.through);
    if(options.kind==='after') request.input('afterDate',sql.VarChar(23),options.cursor.enteredAt)
      .input('afterBranch',sql.BigInt,options.cursor.branchId).input('afterId',sql.VarChar(30),options.cursor.invoiceId);
    const after=options.kind==='after'?`AND (i.dateentry>CONVERT(datetime,@afterDate,126)
      OR (i.dateentry=CONVERT(datetime,@afterDate,126) AND i.idbranch>@afterBranch)
      OR (i.dateentry=CONVERT(datetime,@afterDate,126) AND i.idbranch=@afterBranch AND i.idno_s>CONVERT(bigint,@afterId)))`:'';
    const order=options.kind==='after'?'ASC':'DESC';
    const rows=await request.query(`SELECT TOP (@limit) ${columns} FROM dbo.invo_s i
      WHERE i.idprogramitems=@program AND (i.dateentry IS NULL OR i.dateentry<=CONVERT(datetime,@through,126)) ${after}
      ORDER BY i.dateentry ${order},i.idbranch ${order},i.idno_s ${order}`);
    const invoices=rows.recordset.map(invoice);
    const last=options.kind==='after'?rows.recordset.at(-1):rows.recordset[0];
    return {identity:sqlIdentity(config),invoices,cursor:last?.dateentry?{enteredAt:last.dateentry,branchId:Number(last.idbranch),invoiceId:String(last.idno_s)}:null};
  } finally {await db.close();}
}
export async function readSqlInvoice(config:SqlConfig,branch:number,id:string):Promise<ErpInvoice|null> {
  const db=pool(config);
  try {
    await db.connect();
    const rows=await db.request().input('program',sql.BigInt,config.programId).input('branch',sql.BigInt,branch).input('id',sql.VarChar(30),id)
      .query(`SELECT ${columns} FROM dbo.invo_s i WHERE i.idprogramitems=@program AND i.idbranch=@branch AND i.idno_s=CONVERT(bigint,@id)`);
    return rows.recordset[0]?invoice(rows.recordset[0]):null;
  } finally {await db.close();}
}
export async function readSqlInvoiceCustomers(config:SqlConfig,refs:PersonRef[]):Promise<SourceSnapshot> {
  const db=pool(config);
  try {
    await db.connect();
    const branches=await db.request().input('program',sql.BigInt,config.programId).query(`SELECT b.idprogramitems,b.idbranch,bm.fbranch,
      CASE WHEN b.fvis=1 AND bm.fvis=1 THEN 1 ELSE 0 END fvis,
      CASE WHEN COALESCE(b.deleted,0)=1 OR COALESCE(bm.deleted,0)=1 THEN 1 ELSE 0 END deleted
      FROM dbo.branch b JOIN dbo.branchmain bm ON bm.idbranch=b.idbranch WHERE b.idprogramitems=@program`);
    const unique=[...new Map(refs.filter(r=>r.program===config.programId).map(r=>[`${r.branch}:${r.person}`,r])).values()];
    const customers:any[]=[];
    for(let offset=0;offset<unique.length;offset+=250) {
      const request=db.request().input('program',sql.BigInt,config.programId);
      const terms=unique.slice(offset,offset+250).map((r,i)=>{
        request.input('b'+i,sql.BigInt,r.branch).input('p'+i,sql.BigInt,r.person);
        return `(p.idbranch=@b${i} AND p.idperson=@p${i})`;
      });
      const rows=await request.query(`SELECT p.idprogramitems,p.idbranch,p.idperson,p.fperson,p.ftel1,p.ftel2,p.ftel3,p.ftel4
        FROM dbo.person p JOIN dbo.kindperson k ON k.idprogramitems=p.idprogramitems AND k.idbranch=p.idbranch AND k.idkindperson=p.idkindperson
        WHERE p.idprogramitems=@program AND COALESCE(p.fhid,0)=0 AND LTRIM(RTRIM(k.fkindperson))=N'عميل' AND (${terms.join(' OR ')})`);
      customers.push(...rows.recordset);
    }
    return {identity:sqlIdentity(config),label:`${config.server} / ${config.database}`,branches:branches.recordset,customers};
  } finally {await db.close();}
}
