import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {openDatabase} from '../packages/storage/database.js';
import {migrateWorkflows} from '../packages/storage/workflow-schema.js';
import {CompanyRepository} from '../packages/storage/company-repository.js';
import {Workflows} from '../packages/storage/workflows.js';
import {assertRollbackCompatible} from '../packages/storage/compatibility.js';
import {InvoiceWorkers} from '../apps/server/invoice-workers.js';
import {ExecutionEngine} from '../apps/server/execution-engine.js';
import {SyncService} from '../apps/server/sync-service.js';
import {localSecretStore} from '../apps/server/security.js';
import {createBackup,verifyBackup,restoreBackup} from '../packages/storage/backup.js';
import {cairoTimestamp,workWindow,type ErpInvoice,type WorkflowJob} from '../packages/domain/invoices.js';
import {createApp} from '../apps/server/app.js';
const branches=[39,40].map(idbranch=>({idprogramitems:9,idbranch,fbranch:'Branch '+idbranch,fvis:true}));
const row=(idperson:number,idbranch=39,ftel1='01012345678')=>({idprogramitems:9,idbranch,idperson,fperson:'Customer '+idperson,ftel1});
const bill=(idno_s:string,idperson=1,entered='2026-11-03T07:00:00.000Z',fprinted=0,idbranch=39):ErpInvoice=>({idprogramitems:9,idbranch,idno_s,idperson,dateentry:entered,fdate:entered,fprinted,deleted:false});
function setup(t:any,customers=[row(1)]) {
  const dir=mkdtempSync(join(tmpdir(),'elrawda-workflows-')),db=openDatabase(join(dir,'app.sqlite'));
  t.after(()=>{if(db.open)db.close();rmSync(dir,{recursive:true,force:true});});
  db.prepare('INSERT INTO operators VALUES(?,?,?)').run('op','operator','hash');
  const repo=new CompanyRepository(db),id=repo.create('op','QA');
  repo.ingest(id,{identity:'qa',label:'QA',branches,customers},'sql');
  db.prepare("UPDATE branches SET group_id='120363000000000001@g.us' WHERE company_id=?").run(id);
  db.prepare('UPDATE companies SET settings=? WHERE id=?').run(JSON.stringify({...repo.settings(id),workStart:'09:00',workEnd:'17:00'}),id);
  let now=new Date('2026-11-03T07:00:00.000Z');
  const clock=()=>new Date(now),store=new Workflows(db,repo,clock);
  store.beginSource(id,'qa');store.ingest(id,{identity:'qa',invoices:[]});
  function activate(historical=false,limit=2) {
    store.save(id,{...store.settings(id),mode:'invoices',fresh_enabled:true,historical_enabled:historical},
      branches.map(b=>({program_id:9,branch_id:b.idbranch,fresh_enabled:true,historical_enabled:historical,historical_limit:limit})));
    db.prepare("UPDATE companies SET paused=0,run_mode='live' WHERE id=?").run(id);
  }
  const calls:any[]=[];
  const wa:any={state:{companyId:id,status:'ready'},call:async(_id:string,action:string,payload:any)=>{
    calls.push({action,payload});return action==='get_group_info'?{participantCount:2}:action==='get_membership'?{status:'already_member'}:action==='send_message'?{status:'sent',messageId:'m1'}:{status:'joined'};
  }};
  const ingest=(invoices:ErpInvoice[])=>store.ingest(id,{identity:'qa',invoices});
  const worker=(verify:(j:WorkflowJob)=>Promise<void>=async()=>{},messages=false)=>new InvoiceWorkers(db,repo,wa,verify,clock,messages);
  return {dir,db,repo,id,store,wa,calls,clock,activate,ingest,worker,advance:(ms:number)=>{now=new Date(now.getTime()+ms);}};
}

test('v2 upgrade is additive, repeatable and preserves installed operational evidence',t=>{
  const dir=mkdtempSync(join(tmpdir(),'erp-v2-upgrade-')),path=join(dir,'app.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const legacy=new Database(path);legacy.exec(readFileSync('tests/fixtures/schema-v2.sql','utf8'));
  const repo=new CompanyRepository(legacy as any);legacy.prepare('INSERT INTO operators VALUES(?,?,?)').run('op','owner','hash');const id=repo.create('op','Installed');
  repo.ingest(id,{identity:'qa',label:'qa',branches,customers:[row(1),row(2,39,'01112345678'),row(3,39,'01212345678')]},'sql','encrypted-secret');
  legacy.prepare("UPDATE companies SET paused=0,run_mode='live',whatsapp_phone='201099999999' WHERE id=?").run(id);
  legacy.prepare("UPDATE branches SET group_id='120363000000000001@g.us'").run();
  legacy.prepare("UPDATE customers SET membership_state=CASE person_id WHEN 1 THEN 'joined' WHEN 2 THEN 'pending' ELSE 'review' END").run();
  legacy.prepare("INSERT INTO operations VALUES(?,'add','group:phone','unknown','{}',NULL,'before','before')").run(id);
  legacy.prepare("INSERT INTO daily_usage VALUES(?,'2026-11-03',39,7)").run(id);
  const tables=['operators','companies','sources','branches','customers','operations','daily_usage'];
  const before=Object.fromEntries(tables.map(n=>[n,legacy.prepare(`SELECT * FROM ${n}`).all()]));legacy.close();
  for(let i=0;i<2;i++) {
    const upgraded=openDatabase(path);
    for(const name of tables)assert.deepEqual(upgraded.prepare(`SELECT * FROM ${name}`).all(),before[name],name);
    const states=upgraded.prepare('SELECT person_id,state FROM workflow_enrollments ORDER BY person_id').all();
    assert.deepEqual(states,[{person_id:1,state:'confirmed'},{person_id:2,state:'unknown'},{person_id:3,state:'unknown'}]);
    assert.equal(new Workflows(upgraded,new CompanyRepository(upgraded)).settings(id).mode,'legacy');
    assert.equal((upgraded.prepare('SELECT MAX(version) n FROM schema_migrations').get() as any).n,2);
    assert.equal(upgraded.pragma('integrity_check',{simple:true}),'ok');upgraded.close();
  }
});
test('a failed extension migration rolls back its changes',()=>{
  const db=new Database(':memory:');db.exec(readFileSync('tests/fixtures/schema-v2.sql','utf8'));db.exec('CREATE TABLE workflow_jobs(conflict TEXT)');
  assert.throws(()=>db.transaction(()=>migrateWorkflows(db))());
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_settings'").get(),undefined);db.close();
});
test('Cairo source dates and overnight work windows are independent of host timezone',()=>{
  assert.equal(cairoTimestamp('2026-11-03T09:00:00.123'),'2026-11-03T07:00:00.123Z');
  assert.equal(cairoTimestamp('2026-08-03T09:00:00.123'),'2026-08-03T06:00:00.123Z');
  assert.equal(cairoTimestamp('bad'),null);
  const w=workWindow('21:00','03:00',new Date('2026-11-03T23:00:00Z'));
  assert.equal(w.day,'2026-11-03');assert.equal(w.active,true);assert.equal(w.endAt,'2026-11-04T01:00:00.000Z');
});
test('invoice baseline suppresses old invoices and catches invoices entered during initial inventory',t=>{
  const f=setup(t);f.db.prepare('DELETE FROM workflow_sources').run();f.store.beginSource(f.id,'qa');f.advance(1000);
  f.ingest([bill('1',1,'2026-11-02T07:00:00.000Z',1),bill('2',1,'2026-11-03T07:00:00.500Z')]);
  assert.deepEqual(f.db.prepare('SELECT invoice_id,is_baseline FROM workflow_invoices ORDER BY id').all(),[{invoice_id:'1',is_baseline:1},{invoice_id:'2',is_baseline:0}]);
  assert.equal((f.db.prepare("SELECT count(*) n FROM workflow_jobs WHERE kind='fresh'").get() as any).n,1);
});
test('same invoice key in different branches stays distinct; replays are idempotent',t=>{
  const f=setup(t,[row(1),row(1,40)]);f.ingest([bill('7'),bill('7',1,undefined,0,40)]);f.ingest([bill('7'),bill('7',1,undefined,2,40)]);
  assert.equal((f.db.prepare('SELECT count(*) n FROM workflow_invoices').get() as any).n,2);
  assert.equal((f.db.prepare("SELECT count(*) n FROM workflow_jobs WHERE kind='fresh'").get() as any).n,2);
});
test('duplicate or changed source rolls back the entire invoice batch',t=>{
  const f=setup(t);assert.throws(()=>f.ingest([bill('1'),bill('1')]));assert.equal((f.db.prepare('SELECT count(*) n FROM workflow_invoices').get() as any).n,0);
  assert.throws(()=>f.store.ingest(f.id,{identity:'other',invoices:[bill('2')]}));
});
test('TTL is from ERP entry; edited entry times and late phone completion cannot renew it',t=>{
  const f=setup(t);f.db.prepare("UPDATE workflow_sources SET baseline_started_at='2026-10-30T07:00:00.000Z'").run();f.ingest([bill('old',1,'2026-10-31T07:00:00.000Z')]); // Identifier validation belongs to the ERP adapter.
  assert.equal((f.db.prepare("SELECT status FROM workflow_jobs WHERE kind='fresh'").get() as any).status,'expired');
  f.ingest([bill('old')]);assert.equal((f.db.prepare("SELECT status FROM workflow_jobs WHERE kind='fresh'").get() as any).status,'expired');
  assert.equal((f.db.prepare('SELECT entered_at FROM workflow_invoices').get() as any).entered_at,'2026-10-31T07:00:00.000Z');
});
test('fresh purchase adds an existing customer without printing and without historical quota',async t=>{
  const f=setup(t);f.activate();f.ingest([bill('1')]);await f.worker().tick();
  assert.equal(f.calls.filter(c=>c.action==='add_participant').length,1);
  assert.equal(f.calls.some(c=>c.action==='send_message'),false);
  assert.equal((f.db.prepare("SELECT state FROM workflow_enrollments").get() as any).state,'confirmed');
  assert.equal(f.repo.getDailyUsage(f.id,'2026-11-03'),0);
});
test('incomplete customer and unlinked branch wait without blocking other ready jobs',async t=>{
  const f=setup(t,[row(1,39,''),row(2,40,'01112345678')]);f.activate();f.ingest([bill('1'),bill('2',2,undefined,0,40)]);
  const worker=f.worker();await worker.tick();await worker.tick();
  assert.equal(f.calls.find(c=>c.action==='add_participant').payload.phone,'201112345678');
  assert.equal((f.db.prepare("SELECT status FROM workflow_jobs WHERE kind='fresh' AND person_id=1").get() as any).status,'waiting');
  f.repo.ingest(f.id,{identity:'qa',label:'QA',branches,customers:[row(1)]},'sql');f.advance(31000);await worker.tick();
  assert.equal(f.calls.filter(c=>c.action==='add_participant').length,2);
});
test('confirmed enrollment prevents all later additions including another branch and group',async t=>{
  const f=setup(t,[row(1),row(2,40)]);f.activate();f.ingest([bill('1')]);const worker=f.worker();await worker.tick();
  f.db.prepare("UPDATE branches SET group_id='120363000000000002@g.us'").run();f.ingest([bill('1'),bill('2',2,undefined,0,40)]);await worker.tick();
  assert.equal(f.calls.filter(c=>c.action==='add_participant').length,1);
});
test('deletion and changed owner cancel or quarantine pending work, without rewriting completed history',async t=>{
  const f=setup(t,[row(1),row(2,39,'01112345678')]);f.activate();f.ingest([bill('1')]);f.ingest([{...bill('1'),deleted:true}]);await f.worker().tick();assert.equal(f.calls.length,0);
  f.ingest([bill('2')]);f.ingest([bill('2',2)]);assert.equal((f.db.prepare("SELECT status FROM workflow_jobs WHERE kind='fresh' AND invoice_row_id=(SELECT id FROM workflow_invoices WHERE invoice_id='2')").get() as any).status,'review');
});
test('pause or destination change during verification prevents a remote addition',async t=>{
  const f=setup(t);f.activate();f.ingest([bill('1')]);const worker=f.worker(async()=>{f.db.prepare('UPDATE companies SET paused=1').run();});await worker.tick();assert.equal(f.calls.length,0);
});
test('privacy rejection is terminal and never sends an invite, even with legacy invites enabled',async t=>{
  const f=setup(t);f.activate();f.ingest([bill('1')]);f.wa.call=async(_id:string,action:string)=>{f.calls.push({action});return action==='get_group_info'?{participantCount:2}:{status:'invite_required'};};
  const worker=f.worker();await worker.tick();f.advance(5000);f.ingest([bill('1'),bill('2')]);await worker.tick();
  assert.equal(f.calls.filter(c=>c.action==='add_participant').length,1);assert.equal(f.calls.some(c=>['send_message','get_invite_link'].includes(c.action)),false);
  assert.equal((f.db.prepare('SELECT state FROM workflow_enrollments').get() as any).state,'rejected');
});
test('historical plan reserves distinct slots newest first and spreads them through work hours',async t=>{
  const f=setup(t,[row(1),row(5,39,'01112345678'),row(3,39,'01212345678')]);f.activate(true,2);
  const worker=f.worker();await worker.tick();const jobs=f.db.prepare("SELECT person_id,status,due_at FROM workflow_jobs WHERE kind='historical' ORDER BY id").all() as any[];
  assert.deepEqual(jobs.map(j=>j.person_id),[5,3]);assert.equal(jobs[0].status,'completed');assert.ok(jobs[1].due_at>f.clock().toISOString());
  await worker.tick();assert.equal(f.calls.filter(c=>c.action==='add_participant').length,1);
  f.advance(5*3600000);await worker.tick();assert.equal(f.calls.filter(c=>c.action==='add_participant').length,2);
});
test('failed historical customer is replaced; confirmed target is never exceeded',async t=>{
  const f=setup(t,[row(1),row(2,39,'01112345678')]);f.activate(true,1);let adds=0;
  f.wa.call=async(_id:string,action:string)=>{f.calls.push({action});return action==='get_group_info'?{participantCount:2}:{status:++adds===1?'not_on_whatsapp':'joined'};};
  const worker=f.worker();await worker.tick();await worker.tick();await worker.tick();assert.equal(adds,2);
  assert.equal((f.db.prepare("SELECT count(*) n FROM workflow_jobs WHERE kind='historical' AND status='completed' AND reason='joined'").get() as any).n,1);
});
test('accepted membership reserves the quota until read-only confirmation',async t=>{
  const f=setup(t,[row(1),row(2,39,'01112345678')]);f.activate(true,1);
  f.wa.call=async(_id:string,action:string)=>{f.calls.push({action});return action==='get_group_info'?{participantCount:2}:action==='get_membership'?{status:'already_member'}:{status:'addition_accepted'};};
  const worker=f.worker();await worker.tick();await worker.tick();assert.equal(f.calls.filter(c=>c.action==='add_participant').length,1);
  f.advance(31000);await worker.tick();assert.equal((f.db.prepare("SELECT status FROM workflow_jobs WHERE kind='historical'").get() as any).status,'completed');
  assert.equal(f.calls.filter(c=>c.action==='add_participant').length,1);
});
test('same-day legacy quota is reserved conservatively and restart does not replenish it',async t=>{
  const f=setup(t);f.db.prepare("INSERT INTO daily_usage VALUES(?,'2026-11-03',39,1)").run(f.id);f.activate(true,1);
  await f.worker().tick();await f.worker().tick();assert.equal(f.calls.length,0);
  assert.equal((f.db.prepare('SELECT count(*) n FROM workflow_day_plans').get() as any).n,2);
});
test('fresh purchase promotes a planned historical customer without charging the historical target',async t=>{
  const f=setup(t,[row(1),row(2,39,'01112345678')]);f.activate(true,2);f.store.planHistorical(f.id);f.ingest([bill('1',2)]);
  const worker=f.worker();await worker.tick();assert.equal((f.db.prepare("SELECT reason FROM workflow_jobs WHERE kind='historical' AND person_id=2").get() as any).reason,'promoted_to_fresh');
});
test('timeouts and crashes preserve unknown evidence across group changes and restart',async t=>{
  const f=setup(t);f.activate();f.ingest([bill('1')]);f.wa.call=async(_id:string,action:string)=>{f.calls.push({action});if(action==='get_group_info')return {participantCount:2};throw new Error('after remote send');};
  await f.worker().tick();f.db.prepare("UPDATE branches SET group_id='120363000000000002@g.us'").run();f.ingest([bill('1'),bill('2')]);await f.worker().tick();assert.equal(f.calls.filter(c=>c.action==='add_participant').length,1);
});
test('shutdown drains a dispatched addition and preserves its confirmed result',async t=>{
  const f=setup(t);f.activate();f.ingest([bill('1')]);let finish!:(r:any)=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
  f.wa.call=async(_id:string,action:string)=>{if(action==='get_group_info')return {participantCount:2};entered();return new Promise(r=>finish=r);};
  const worker=f.worker(),tick=worker.tick();await started;let stopped=false;const stop=worker.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);finish({status:'joined'});await stop;await tick;
  assert.equal((f.db.prepare("SELECT state FROM workflow_enrollments").get() as any).state,'confirmed');
});
test('legacy engine cannot compete after explicit invoice cutover',async t=>{
  const f=setup(t);f.activate();f.repo.ingest(f.id,{identity:'qa',label:'qa',branches,customers:[row(2)]},'sql');await new ExecutionEngine(f.db,f.repo,f.wa).tick();assert.equal(f.calls.length,0);
});
test('cutover requires a completed baseline, a pause, and no in-flight operation',t=>{
  const f=setup(t);f.db.prepare('UPDATE companies SET paused=0').run();assert.throws(()=>f.store.save(f.id,{...f.store.settings(f.id),mode:'invoices'},[]),/أوقف/);
  f.db.prepare('UPDATE companies SET paused=1').run();f.db.prepare('UPDATE workflow_sources SET baseline_complete=0').run();assert.throws(()=>f.store.save(f.id,{...f.store.settings(f.id),mode:'invoices'},[]),/جهّز/);
  assert.equal(f.store.settings(f.id).messages_enabled,false);
});
test('messages wait for print without blocking other messages, and expired messages never send',async t=>{
  const f=setup(t,[row(1),row(2,39,'01112345678')]);f.activate();f.db.prepare("UPDATE workflow_settings SET messages_enabled=1,messages_enabled_at='2026-11-03T06:59:00.000Z',fresh_enabled=0").run();
  f.ingest([bill('1'),bill('2',2,undefined,1)]);const worker=f.worker(async()=>{},true);await worker.tick();await worker.tick();
  assert.equal(f.calls.filter(c=>c.action==='send_message').length,1);
  f.advance(3601000);await worker.tick();assert.equal(f.calls.filter(c=>c.action==='send_message').length,1);
  assert.equal((f.db.prepare("SELECT status FROM workflow_jobs WHERE kind='message' AND person_id=1").get() as any).status,'expired');
});
test('message refresh checks ERP printing, revalidates expiry and sends once despite reprints',async t=>{
  const f=setup(t);f.activate();f.db.prepare("UPDATE workflow_settings SET messages_enabled=1,messages_enabled_at='2026-11-03T06:59:00.000Z',fresh_enabled=0").run();f.ingest([bill('1')]);
  const worker=f.worker(async()=>{f.ingest([bill('1',1,undefined,1)]);},true);await worker.tick();f.ingest([bill('1',1,undefined,3)]);await worker.tick();assert.equal(f.calls.filter(c=>c.action==='send_message').length,1);
});
test('message dispatch stays disabled until the service is explicitly activated',async t=>{
  const f=setup(t);f.activate();f.db.prepare('UPDATE workflow_settings SET fresh_enabled=0').run();f.ingest([bill('1',1,undefined,1)]);
  await new InvoiceWorkers(f.db,f.repo,f.wa,async()=>{},f.clock).tick();assert.equal(f.calls.length,0);assert.equal(f.store.settings(f.id).messages_enabled,false);
});

test('safe rollback is allowed before cutover and rejected for an incapable release after cutover',t=>{
  const f=setup(t);const release=join(f.dir,'old-release');mkdirSync(release);assert.doesNotThrow(()=>assertRollbackCompatible(f.db,release));f.activate();assert.throws(()=>assertRollbackCompatible(f.db,release),/cannot resume/);
  writeFileSync(join(release,'release-manifest.json'),JSON.stringify({workflowVersion:2}));assert.doesNotThrow(()=>assertRollbackCompatible(f.db,release));
});
test('receipt service in legacy mode also requires a compatible rollback release',t=>{
  const f=setup(t),release=join(f.dir,'old-release');mkdirSync(release);f.store.settings(f.id);
  f.db.prepare("UPDATE workflow_settings SET mode='legacy',messages_enabled=1").run();
  assert.throws(()=>assertRollbackCompatible(f.db,release),/cannot resume/);
  writeFileSync(join(release,'release-manifest.json'),JSON.stringify({workflowVersion:2}));assert.doesNotThrow(()=>assertRollbackCompatible(f.db,release));
});
test('a release aware of the older workflow schema is rejected even before invoice services are active',t=>{
  const f=setup(t),release=join(f.dir,'old-aware-release');mkdirSync(release);
  writeFileSync(join(release,'release-manifest.json'),JSON.stringify({workflowVersion:1}));
  assert.throws(()=>assertRollbackCompatible(f.db,release),/cannot resume/);
});
test('backup and restore preserve queue progress, encryption key and confirmation history',async t=>{
  const f=setup(t);localSecretStore(f.dir);f.activate();f.ingest([bill('1')]);await f.worker().tick();const backup=join(f.dir,'backup');await createBackup(f.dir,backup);assert.equal(verifyBackup(backup),2);
  f.db.close();const restored=join(f.dir,'restored');await restoreBackup(restored,backup);const db=openDatabase(join(restored,'app.sqlite'));
  assert.equal((db.prepare('SELECT count(*) n FROM workflow_enrollments').get() as any).n,1);assert.equal((db.prepare('SELECT paused FROM companies').get() as any).paused,1);db.close();
});
test('invoice mode sync reads only invoice-referenced customers after initial import',async t=>{
  const f=setup(t);const config={server:'test',instance:'SQLMOHSEN',database:'erp',user:'reader',password:'test-only',encrypt:true,trustServerCertificate:true,programId:9};
  const identity='sql:test:sqlmohsen:erp:9';f.db.prepare('UPDATE sources SET identity=?,config=?').run(identity,localSecretStore(f.dir).encrypt(config));f.db.prepare('UPDATE workflow_sources SET identity=?').run(identity);f.activate();
  let fullReads=0;let refs:any[]=[];
  const sync=new SyncService(f.db,f.repo,localSecretStore(f.dir),process.cwd(),async()=>{fullReads++;throw new Error('unexpected full customer read');},
    async()=>({identity,invoices:[bill('1')],cursor:{enteredAt:'2026-11-03T09:00:00.000',branchId:39,invoiceId:'1'}}),async(_c,r)=>{refs=r;return {identity,label:'QA',branches,customers:[row(1)]};});
  await sync.run(f.id);assert.equal(fullReads,0);assert.equal(refs.length,1);assert.equal((f.db.prepare('SELECT count(*) n FROM workflow_invoices').get() as any).n,1);
  await sync.run(f.id);assert.equal(refs.length,0);await sync.stop();
});
test('workflow HTTP API is company-scoped and rejects enabling invoice messages',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'erp-workflow-http-')),x=await createApp({dataDir:dir,root:process.cwd()});t.after(async()=>{await x.app.close();rmSync(dir,{recursive:true,force:true});});
  assert.equal((await x.app.inject('/api/workflows')).statusCode,401);
  const headers:any={host:'localhost','x-emoji-request':'1'};const auth=await x.app.inject({method:'POST',url:'/api/auth/bootstrap',headers,payload:{username:'operator',password:'TestingOnly12345!'}});headers.cookie=auth.cookies.map(c=>`${c.name}=${c.value}`).join(';');
  await x.app.inject({method:'POST',url:'/api/companies',headers,payload:{name:'QA company'}});
  const report=(await x.app.inject({url:'/api/workflows',headers})).json();assert.equal(report.messagesAvailable,true);
  const result=await x.app.inject({method:'PUT',url:'/api/workflows',headers,payload:{...report.settings,messages_enabled:true,branches:[]}});assert.equal(result.statusCode,409);
});

test('membership evidence arriving during metadata read prevents a second write',async t=>{
  const f=setup(t);f.activate();f.ingest([bill('1')]);
  f.wa.call=async(_id:string,action:string)=>{
    f.calls.push({action});if(action==='get_group_info')f.store.recordEnrollment(f.id,{program_id:9,branch_id:39,person_id:1,phone:'201012345678'},'confirmed','120363000000000001@g.us','manual_confirmation');
    return {participantCount:2};
  };
  await f.worker().tick();assert.equal(f.calls.filter(c=>c.action==='add_participant').length,0);
});
test('a crash before operation intent still reserves the phone against another invoice',async t=>{
  const f=setup(t);f.activate();f.ingest([bill('1')]);f.db.prepare("UPDATE workflow_jobs SET status='running',phone='201012345678',group_id='120363000000000001@g.us' WHERE kind='fresh'").run();
  const worker=f.worker();f.ingest([bill('1'),bill('2')]);await worker.tick();assert.equal(f.calls.length,0);
  assert.equal((f.db.prepare('SELECT state FROM workflow_enrollments').get() as any).state,'unknown');
});
test('missing customer names are refreshed by invoice synchronization until complete',async t=>{
  const f=setup(t);const config={server:'test',instance:'SQLMOHSEN',database:'erp',user:'reader',password:'test-only',encrypt:true,trustServerCertificate:true,programId:9};
  const identity='sql:test:sqlmohsen:erp:9',secrets=localSecretStore(f.dir);f.db.prepare('UPDATE sources SET identity=?,config=?').run(identity,secrets.encrypt(config));f.db.prepare('UPDATE workflow_sources SET identity=?').run(identity);f.activate();
  let cycle=0;const sync=new SyncService(f.db,f.repo,secrets,process.cwd(),async()=>{throw new Error('full read');},async()=>({identity,invoices:[bill('1')],cursor:{enteredAt:'2026-11-03T09:00:00.000',branchId:39,invoiceId:'1'}}),async(_c,refs)=>{
    cycle++;assert.equal(refs.length,1);return {identity,label:'qa',branches,customers:[{...row(1),fperson:cycle===1?'':'Completed'}]};
  });
  await sync.run(f.id);await sync.run(f.id);assert.equal((f.db.prepare('SELECT name FROM customers').get() as any).name,'Completed');await sync.stop();
});
test('unchanged inventory does not rewrite all invoices or revive a cancelled historical slot',t=>{
  const f=setup(t);f.ingest([bill('1')]);const old=(f.db.prepare('SELECT last_seen FROM workflow_invoices').get() as any).last_seen;
  f.advance(30000);f.ingest([bill('1')]);assert.equal((f.db.prepare('SELECT last_seen FROM workflow_invoices').get() as any).last_seen,old);
});
test('message can expire during the print lookup and must not be sent',async t=>{
  const f=setup(t);f.activate();f.db.prepare("UPDATE workflow_settings SET messages_enabled=1,messages_enabled_at='2026-11-03T06:59:00.000Z',fresh_enabled=0").run();f.ingest([bill('1')]);
  await f.worker(async()=>{f.advance(3601000);f.ingest([bill('1',1,undefined,1)]);},true).tick();assert.equal(f.calls.length,0);
});

test('late restart spreads untouched historical slots across the remaining shift instead of bursting',async t=>{
  const f=setup(t,[row(1),row(2,39,'01112345678'),row(3,39,'01212345678')]);f.activate(true,3);f.store.planHistorical(f.id);f.advance(6*3600000);
  const worker=f.worker();await worker.tick();await worker.tick();assert.equal(f.calls.filter(c=>c.action==='add_participant').length,1);
  const waiting=f.db.prepare("SELECT due_at FROM workflow_jobs WHERE kind='historical' AND status='waiting' ORDER BY due_at").all() as any[];
  assert.equal(waiting.length,2);assert.ok(waiting.every(j=>j.due_at>f.clock().toISOString()));
});

test('legacy operation intent blocks re-addition even if the old customer row never recorded the attempt',async t=>{
  const f=setup(t);f.db.prepare("INSERT INTO operations VALUES(?,'add','old-group:phone','unknown',?,NULL,'before','before')").run(f.id,JSON.stringify({phone:'201012345678',groupId:'120363000000000009@g.us'}));
  f.activate();f.ingest([bill('1')]);await f.worker().tick();assert.equal(f.calls.length,0);
  assert.equal((f.db.prepare('SELECT state FROM workflow_enrollments').get() as any).state,'unknown');
});

test('a disabled branch at the front of the queue cannot starve an enabled branch',async t=>{
  const f=setup(t,[row(1),row(2,40,'01112345678')]);f.activate();f.db.prepare('UPDATE workflow_branches SET fresh_enabled=0 WHERE branch_id=39').run();f.ingest([bill('1'),bill('2',2,undefined,0,40)]);
  await f.worker().tick();assert.equal(f.calls.find(c=>c.action==='add_participant').payload.phone,'201112345678');
  assert.equal((f.db.prepare("SELECT status FROM workflow_jobs WHERE kind='fresh' AND branch_id=39").get() as any).status,'waiting');
});

async function httpFixture(t:any) {
  const dir=mkdtempSync(join(tmpdir(),'erp-service-controls-')),x=await createApp({dataDir:dir,root:process.cwd()});
  t.after(async()=>{await x.app.close();rmSync(dir,{recursive:true,force:true});});
  const headers:any={host:'localhost','x-emoji-request':'1'};
  const auth=await x.app.inject({method:'POST',url:'/api/auth/bootstrap',headers,payload:{username:'operator',password:'TestingOnly12345!'}});headers.cookie=auth.cookies.map(c=>`${c.name}=${c.value}`).join(';');
  const id=(await x.app.inject({method:'POST',url:'/api/companies',headers,payload:{name:'QA company'}})).json().id;
  const toggle=(kind:string,enabled:boolean)=>x.app.inject({method:'POST',url:'/api/workflows/services/'+kind,headers,payload:{enabled}});
  const ready=()=>{
    x.repo.ingest(id,{identity:'test',label:'Test',branches,customers:[row(1)]},'sql','test-encrypted-placeholder');
    x.db.prepare("UPDATE branches SET group_id='120363000000000001@g.us'").run();
    Object.assign(x.wa.state,{companyId:id,status:'ready'});
    x.sync.run=async()=>{const w=new Workflows(x.db,x.repo);w.beginSource(id,'test');return w.ingest(id,{identity:'test',invoices:[]});};
  };
  return {...x,id,headers,toggle,ready};
}
test('service start requires SQL and WhatsApp, while stop is always available',async t=>{
  const f=await httpFixture(t);let r=await f.toggle('message',true);assert.equal(r.statusCode,409);assert.match(r.json().error,/قاعدة بيانات/);
  assert.equal((await f.toggle('message',false)).statusCode,200);
  f.repo.ingest(f.id,{identity:'test',label:'test',branches,customers:[row(1)]},'sql','placeholder');r=await f.toggle('message',true);assert.equal(r.statusCode,409);assert.match(r.json().error,/واتساب/);
});
test('individual controls start only the requested service and preserve the other running services',async t=>{
  const f=await httpFixture(t);f.ready();let r=await f.toggle('fresh',true);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().active.fresh,true);assert.equal(r.json().active.message,false);
  r=await f.toggle('message',true);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().active.message,true);assert.equal(r.json().active.fresh,true);
  r=await f.toggle('fresh',false);assert.equal(r.statusCode,200);assert.equal(r.json().active.fresh,false);assert.equal(r.json().active.message,true);
});
test('historical service requires its own branch quotas and groups before activation',async t=>{
  const f=await httpFixture(t);f.ready();const r=await f.toggle('historical',true);assert.equal(r.statusCode,409);assert.match(r.json().error,/حدد عدد/);
  const w=new Workflows(f.db,f.repo);w.branches(f.id);f.db.prepare('UPDATE workflow_branches SET historical_enabled=1,historical_limit=3').run();
  assert.equal((await f.toggle('historical',true)).statusCode,200);
});
test('an in-flight service start cannot override a later stop request',async t=>{
  const f=await httpFixture(t);f.ready();const w=new Workflows(f.db,f.repo);w.beginSource(f.id,'test');w.ingest(f.id,{identity:'test',invoices:[]});
  let resolve!:()=>void,entered!:()=>void;const starting=new Promise<void>(r=>entered=r);f.sync.run=async()=>{entered();await new Promise<void>(r=>resolve=r);return {};};
  const start=f.toggle('message',true);void start.then(()=>{});await starting;
  assert.equal((await f.toggle('message',false)).statusCode,200);resolve();assert.equal((await start).statusCode,409);assert.equal(w.settings(f.id).messages_enabled,false);
});
test('legacy historical writes stop independently while fresh customers remain enabled',async t=>{
  const f=setup(t);f.db.prepare("UPDATE companies SET paused=0,run_mode='live'").run();
  f.db.prepare("UPDATE companies SET settings=?").run(JSON.stringify({...f.repo.settings(f.id),historicalDailyLimit:10,workStart:'00:00',workEnd:'23:59'}));
  f.store.settings(f.id);f.db.prepare('UPDATE workflow_settings SET fresh_enabled=1,historical_enabled=0').run();
  f.repo.ingest(f.id,{identity:'qa',label:'qa',branches,customers:[row(2,39,'01112345678')]},'sql');await new ExecutionEngine(f.db,f.repo,f.wa).tick();
  assert.equal(f.calls.find(c=>c.action==='add_participant').payload.phone,'201112345678');
});

test('service configuration cannot overwrite another service settings and returns persisted working hours',async t=>{
  const f=await httpFixture(t);f.ready();const w=new Workflows(f.db,f.repo);w.branches(f.id);
  const r=await f.app.inject({method:'PUT',url:'/api/workflows/services/historical/config',headers:f.headers,payload:{workStart:'10:00',workEnd:'18:00',branches:[{program_id:9,branch_id:39,enabled:true,daily_limit:5}]}});
  assert.equal(r.statusCode,200,r.body);assert.equal(r.json().workStart,'10:00');assert.equal(r.json().workEnd,'18:00');
  assert.equal(w.branches(f.id).find(b=>b.branch_id===39)?.fresh_enabled,1);
  const rejected=await f.app.inject({method:'PUT',url:'/api/workflows/services/fresh/config',headers:f.headers,payload:{fresh_ttl:7200,message_template:'Unrelated field',branches:[]}});assert.equal(rejected.statusCode,400);
  assert.equal(f.repo.settings(f.id).workStart,'10:00');
});
