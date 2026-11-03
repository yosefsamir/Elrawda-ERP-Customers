import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../packages/storage/database.js';
import {migrateWorkflows} from '../packages/storage/workflow-schema.js';
import {CompanyRepository} from '../packages/storage/company-repository.js';
import {Workflows} from '../packages/storage/workflows.js';
import {InvoiceReadState} from '../packages/storage/invoice-read-state.js';
import {SyncService} from '../apps/server/sync-service.js';
import {localSecretStore} from '../apps/server/security.js';
import {cairoSqlTimestamp,type ErpInvoice,type InvoiceCursor,type InvoiceReadOptions} from '../packages/domain/invoices.js';
const config={server:'qa',instance:'',database:'erp',user:'reader',password:'test-only',encrypt:true,trustServerCertificate:true,programId:9};
const identity='sql:qa::erp:9',branches=[39,40].map(idbranch=>({idprogramitems:9,idbranch,fbranch:'Branch '+idbranch,fvis:true}));
const invoice=(n:number,branch=39,id=String(n)):ErpInvoice=>({idprogramitems:9,idbranch:branch,idno_s:id,idperson:n,dateentry:new Date(Date.parse('2026-11-03T07:00:00Z')+n*1000).toISOString(),fdate:null,fprinted:0,deleted:false});
const key=(i:ErpInvoice):InvoiceCursor=>({enteredAt:cairoSqlTimestamp(i.dateentry!),branchId:i.idbranch,invoiceId:i.idno_s});
const compare=(a:InvoiceCursor,b:InvoiceCursor)=>a.enteredAt.localeCompare(b.enteredAt)||a.branchId-b.branchId||(BigInt(a.invoiceId)<BigInt(b.invoiceId)?-1:BigInt(a.invoiceId)>BigInt(b.invoiceId)?1:0);
function fixture(t:any) {
 const dir=mkdtempSync(join(tmpdir(),'erp-paged-sync-')),db=openDatabase(join(dir,'app.sqlite')),repo=new CompanyRepository(db),secrets=localSecretStore(dir);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 db.prepare('INSERT INTO operators VALUES(?,?,?)').run('op','operator','hash');const id=repo.create('op','Paged QA');
 repo.ingest(id,{identity,label:'QA',branches,customers:[]},'sql',secrets.encrypt(config));
 let now=new Date('2026-11-03T07:00:00Z');const clock=()=>new Date(now),store=new Workflows(db,repo,clock);store.beginSource(id,identity);
 now=new Date('2026-11-03T08:00:00Z');
 const rows:ErpInvoice[]=[],calls:{options:InvoiceReadOptions;returned:number}[]=[],customerRefs:any[]=[];
 let failCustomers=false;
 const makeSync=()=>new SyncService(db,repo,secrets,process.cwd(),async()=>({identity,label:'QA',branches,customers:[]}),async(_config,options)=>{
   assert.ok(options.limit<=50);let eligible=rows.filter(i=>key(i).enteredAt<=options.through);
   if(options.kind==='after')eligible=eligible.filter(i=>compare(key(i),options.cursor)>0);
   eligible.sort((a,b)=>(options.kind==='after'?1:-1)*compare(key(a),key(b)));
   const invoices=eligible.slice(0,options.limit);calls.push({options,returned:invoices.length});
   return {identity,invoices,cursor:invoices.length?key(options.kind==='after'?invoices.at(-1)!:invoices[0]):null};
 },async(_config,refs)=>{
   if(failCustomers)throw new Error('customer read failed');customerRefs.push(refs);
   return {identity,label:'QA',branches,customers:refs.map(r=>({idprogramitems:9,idbranch:r.branch,idperson:r.person,fperson:'Customer '+r.person,ftel1:'01012345678'}))};
 },clock);
 return {db,id,store,rows,calls,customerRefs,makeSync,clock,fail:(v:boolean)=>{failCustomers=v;},setNow:(value:string)=>{now=new Date(value);}};
}
test('normal poll returns at most 50 headers shared between new discovery and recent overlap',async t=>{
 const f=fixture(t);f.rows.push(...Array.from({length:1000},(_,i)=>invoice(-i-1)),...Array.from({length:5},(_,i)=>invoice(i+1)));
 await f.makeSync().run(f.id,{invoices:true});assert.deepEqual(f.calls.map(c=>[c.options.kind,c.options.limit,c.returned]),[['after',40,5],['recent',45,45]]);
 assert.equal((f.db.prepare("SELECT count(*) n FROM workflow_jobs WHERE kind='fresh'").get() as any).n,5);
 assert.equal((f.db.prepare('SELECT count(*) n FROM workflow_invoices').get() as any).n,45);
});
test('125 accumulated invoices drain across restart while reserving part of the 50-row budget for recent sales',async t=>{
 const f=fixture(t);f.rows.push(...Array.from({length:125},(_,i)=>invoice(i+1)));
 for(let i=0;i<4;i++){const sync=f.makeSync();await sync.run(f.id,{invoices:true});await sync.stop();}
 assert.deepEqual(f.calls.filter(c=>c.options.kind==='after').map(c=>c.returned),[40,40,40,5]);
 assert.equal((f.db.prepare('SELECT count(*) n FROM workflow_invoices').get() as any).n,125);
 assert.equal((f.db.prepare("SELECT count(*) n FROM workflow_jobs WHERE kind='fresh'").get() as any).n,125);
 assert.equal(new InvoiceReadState(f.db,f.clock).cursor(f.id).invoiceId,'125');
});
test('equal timestamps paginate by branch and numeric invoice key including values beyond JS safe integers',async t=>{
 const f=fixture(t);f.rows.push(...Array.from({length:120},(_,i)=>({...invoice(i+1,i<60?39:40,String(9007199254740993n+BigInt(i))),dateentry:'2026-11-03T07:00:01.000Z'})));
 for(let i=0;i<3;i++)await f.makeSync().run(f.id,{invoices:true});
 assert.equal((f.db.prepare('SELECT count(*) n FROM workflow_invoices').get() as any).n,120);
});
test('a lower invoice code with a later entry time is still discovered',async t=>{
 const f=fixture(t);f.rows.push(invoice(1,39,'999'));const sync=f.makeSync();await sync.run(f.id,{invoices:true});
 f.rows.push(invoice(2,39,'1'));await sync.run(f.id);assert.equal((f.db.prepare('SELECT count(*) n FROM workflow_invoices').get() as any).n,2);
});
test('recent overlap catches late arrival behind the cursor and refreshes print and deletion states',async t=>{
 const f=fixture(t);f.rows.push(invoice(2),invoice(3));const sync=f.makeSync();await sync.run(f.id,{invoices:true});
 f.rows[0]={...f.rows[0],fprinted:2};f.rows[1]={...f.rows[1],deleted:true};f.rows.push(invoice(1));await sync.run(f.id);
 assert.equal((f.db.prepare("SELECT printed FROM workflow_invoices WHERE invoice_id='2'").get() as any).printed,2);
 assert.equal((f.db.prepare("SELECT status FROM workflow_jobs WHERE kind='fresh' AND person_id=3").get() as any).status,'cancelled');
 assert.ok(f.db.prepare("SELECT 1 FROM workflow_invoices WHERE invoice_id='1'").get());
});
test('customer read failure does not advance the invoice checkpoint or partially ingest its page',async t=>{
 const f=fixture(t);f.rows.push(...Array.from({length:60},(_,i)=>invoice(i+1)));f.fail(true);const sync=f.makeSync();
 await assert.rejects(sync.run(f.id,{invoices:true}),/customer read failed/);assert.equal((f.db.prepare('SELECT count(*) n FROM workflow_invoices').get() as any).n,0);
 assert.equal(f.db.prepare('SELECT 1 FROM workflow_invoice_reads').get(),undefined);
 f.fail(false);await sync.run(f.id,{invoices:true});assert.equal(new InvoiceReadState(f.db,f.clock).cursor(f.id).invoiceId,'40');
});
test('a checkpoint write failure rolls back customer, invoice and job writes together',async t=>{
 const f=fixture(t);f.rows.push(invoice(1));f.db.exec("CREATE TRIGGER stop_checkpoint BEFORE INSERT ON workflow_invoice_reads BEGIN SELECT RAISE(ABORT,'checkpoint blocked'); END;");
 const sync=f.makeSync();await assert.rejects(sync.run(f.id,{invoices:true}),/checkpoint blocked/);
 for(const table of ['workflow_invoices','workflow_jobs','customers'])assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as any).n,0);
 f.db.exec('DROP TRIGGER stop_checkpoint');await sync.run(f.id,{invoices:true});assert.equal((f.db.prepare('SELECT count(*) n FROM workflow_invoices').get() as any).n,1);
});
test('initialization never creates actionable tasks for the historical recent-page overlap',async t=>{
 const f=fixture(t);f.rows.push(invoice(-1));await f.makeSync().run(f.id,{invoices:true});
 assert.equal((f.db.prepare('SELECT count(*) n FROM workflow_jobs').get() as any).n,0);
 // A previously unseen old row is also historical on a later overlap.
 f.rows.push(invoice(-2));await f.makeSync().run(f.id,{invoices:true});assert.equal((f.db.prepare('SELECT count(*) n FROM workflow_jobs').get() as any).n,0);
});
test('an empty initial source retains a boundary that catches more than 50 later invoices',async t=>{
 const f=fixture(t),sync=f.makeSync();await sync.run(f.id,{invoices:true});f.rows.push(...Array.from({length:80},(_,i)=>invoice(i+1)));
 await sync.run(f.id);await sync.run(f.id);assert.equal((f.db.prepare('SELECT count(*) n FROM workflow_invoices').get() as any).n,80);
});
test('incomplete customer refresh rotates beyond 50 pending invoices after they leave the recent window',t=>{
 const f=fixture(t);f.store.ingest(f.id,{identity,invoices:Array.from({length:120},(_,i)=>invoice(i+1))});
 const reads=new InvoiceReadState(f.db,f.clock),cursor=reads.cursor(f.id),seen=new Set<number>();
 for(let i=0;i<3;i++){const page=reads.pendingCustomers(f.id);assert.ok(page.refs.length<=50);page.refs.forEach(r=>seen.add(r.person));reads.save(f.id,cursor,page.cursor);}
 assert.equal(seen.size,120);assert.equal(reads.pendingCustomers(f.id).refs[0].person,1);
});
test('upgrading the earlier inventory reader preserves jobs and seeds its checkpoint from saved invoice progress',t=>{
 const f=fixture(t);f.store.ingest(f.id,{identity,invoices:[invoice(1),invoice(2)]});
 const before=f.db.prepare('SELECT * FROM workflow_jobs').all();
 f.db.exec('DROP TABLE workflow_invoice_reads; DELETE FROM workflow_migrations WHERE version=2;');
 f.db.transaction(()=>migrateWorkflows(f.db))();
 assert.deepEqual(f.db.prepare('SELECT * FROM workflow_jobs').all(),before);
 assert.equal(new InvoiceReadState(f.db,f.clock).cursor(f.id).invoiceId,'2');
 assert.equal((f.db.prepare('SELECT MAX(version) v FROM workflow_migrations').get() as any).v,2);
});
test('future-dated invoices do not move the checkpoint beyond invoices entered later',async t=>{
 const f=fixture(t);f.rows.push({...invoice(1),dateentry:'2026-11-04T07:00:00.000Z'});
 const sync=f.makeSync();await sync.run(f.id,{invoices:true});assert.equal((f.db.prepare('SELECT count(*) n FROM workflow_invoices').get() as any).n,0);
 f.rows.push(invoice(2));await sync.run(f.id);assert.equal(new InvoiceReadState(f.db,f.clock).cursor(f.id).invoiceId,'2');
});
test('current sales get fresh and message jobs during an old backlog without waiting for it to drain',async t=>{
 const f=fixture(t);f.db.prepare("UPDATE workflow_sources SET baseline_started_at='2026-11-01T07:00:00.000Z'").run();
 f.store.settings(f.id);f.db.prepare("UPDATE workflow_settings SET messages_enabled=1,messages_enabled_at='2026-11-03T07:50:00.000Z'").run();
 f.rows.push(...Array.from({length:125},(_,i)=>({...invoice(i+1),dateentry:new Date(Date.parse('2026-11-02T07:00:00Z')+i*1000).toISOString()})));
 f.rows.push({...invoice(126),dateentry:'2026-11-03T07:59:00.000Z'});await f.makeSync().run(f.id,{invoices:true});
 assert.equal(f.calls.reduce((sum,c)=>sum+c.returned,0),50);
 assert.equal(new InvoiceReadState(f.db,f.clock).cursor(f.id).invoiceId,'40');
 const jobs=f.db.prepare('SELECT kind,status FROM workflow_jobs WHERE person_id=126 ORDER BY kind').all();
 assert.deepEqual(jobs,[{kind:'fresh',status:'waiting'},{kind:'message',status:'waiting'}]);
});
