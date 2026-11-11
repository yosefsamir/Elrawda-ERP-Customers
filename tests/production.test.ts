import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {openDatabase} from '../packages/storage/database.js';
import {CompanyRepository} from '../packages/storage/company-repository.js';
import {ExecutionEngine} from '../apps/server/execution-engine.js';
import {createApp} from '../apps/server/app.js';
import {SyncService} from '../apps/server/sync-service.js';
import {localSecretStore} from '../apps/server/security.js';
import {createBackup,restoreBackup,verifyBackup} from '../packages/storage/backup.js';
import {acquireLock} from '../packages/runtime/lock.js';
const branches=[39,40].map(idbranch=>({idprogramitems:9,idbranch,fbranch:'Branch '+idbranch,fvis:true}));
const row=(idperson:number,idbranch=39,ftel1='01012345678')=>({idprogramitems:9,idbranch,idperson,fperson:'Customer '+idperson,ftel1});
function fixture(t:any) {
 const dir=mkdtempSync(join(tmpdir(),'elrawda-production-')); const db=openDatabase(join(dir,'app.sqlite'));
 const repo=new CompanyRepository(db);db.prepare('INSERT INTO operators VALUES(?,?,?)').run('op','op','hash');const id=repo.create('op','QA');
 t.after(()=>{if(db.open)db.close();rmSync(dir,{recursive:true,force:true});});
 db.prepare("UPDATE companies SET paused=0,run_mode='live' WHERE id=?").run(id);
 db.prepare('UPDATE companies SET settings=? WHERE id=?').run(JSON.stringify({...repo.settings(id),workStart:'00:00',workEnd:'23:59',historicalDailyLimit:50,additionMinIntervalSeconds:0}),id);
 const ingest=(customers:any[])=>repo.ingest(id,{identity:'qa',label:'qa',branches,customers},'snapshot');
 const calls:any[]=[];const wa:any={state:{companyId:id,status:'ready'},call:async(_id:string,action:string,payload:any)=>{calls.push({action,payload});if(action==='get_group_info')return {participantCount:1};if(action==='add_participant')return {status:'joined'};return {};}};
 const link=()=>db.prepare("UPDATE branches SET group_id='120363000000000001@g.us' WHERE company_id=?").run(id);
 return {dir,db,repo,id,ingest,calls,wa,link,engine:()=>new ExecutionEngine(db,repo,wa)};
}
test('queue skips unlinked/disabled branches without discarding their waiting customers',async t=>{
 const f=fixture(t);f.ingest([]);f.ingest([row(1),row(2,40,'01112345678')]);f.db.prepare("UPDATE branches SET group_id='120363000000000001@g.us' WHERE company_id=? AND branch_id=40").run(f.id);
 await f.engine().tick();assert.equal(f.calls.find(c=>c.action==='add_participant').payload.phone,'201112345678');
 assert.equal((f.db.prepare('SELECT membership_state FROM customers WHERE person_id=1').get() as any).membership_state,'not_attempted');
});
for(const scope of ['total','per_branch'])test(`historical global queue works without per-branch groups (${scope})`,async t=>{
 const f=fixture(t);f.ingest([row(1)]);f.db.prepare('UPDATE companies SET settings=? WHERE id=?').run(JSON.stringify({...f.repo.settings(f.id),distributionMode:'global',globalGroupId:'120363000000000002@g.us',historicalLimitScope:scope}),f.id);
 await f.engine().tick();assert.equal(f.calls.find(c=>c.action==='add_participant').payload.groupId,'120363000000000002@g.us');
});
test('same phone/destination marks review and consumes quota once without sending messages',async t=>{
 const f=fixture(t);f.ingest([row(1),row(2)]);f.link();
 f.wa.call=async(_id:string,action:string,payload:any)=>{f.calls.push({action,payload});return action==='get_group_info'?{participantCount:1}:action==='add_participant'?{status:'invite_required'}:{};};
 const engine=f.engine();await engine.tick();await engine.tick();
 assert.equal(f.calls.filter(c=>c.action==='add_participant').length,1);assert.equal(f.calls.filter(c=>c.action==='send_message').length,0);
 assert.equal((f.db.prepare("SELECT count(*) n FROM customers WHERE membership_state='review'").get() as any).n,2);
 assert.equal((f.db.prepare('SELECT sum(count) n FROM daily_usage').get() as any).n,1);
});
test('a timed-out addition stays unknown across restart and is never sent again',async t=>{
 const f=fixture(t);f.ingest([]);f.ingest([row(1)]);f.link();
 f.wa.call=async(_id:string,action:string)=>{f.calls.push({action});if(action==='get_group_info')return {participantCount:1};throw new Error('timeout after send');};
 await f.engine().tick();f.db.prepare("UPDATE customers SET membership_state='not_attempted'").run();await f.engine().tick();
 assert.equal(f.calls.filter(c=>c.action==='add_participant').length,1);assert.equal((f.db.prepare("SELECT status FROM operations WHERE kind='add'").get() as any).status,'unknown');
});
test('accepted addition without membership observation is pending, not joined',async t=>{
 const f=fixture(t);f.ingest([]);f.ingest([row(1)]);f.link();f.wa.call=async(_id:string,action:string)=>action==='get_group_info'?{participantCount:1}:{status:'addition_accepted'};
 await f.engine().tick();assert.equal((f.db.prepare('SELECT membership_state FROM customers').get() as any).membership_state,'pending');
});
test('privacy refusal marks customer as review without sending invite',async t=>{
 const f=fixture(t);f.ingest([]);f.ingest([row(1)]);f.link();f.wa.call=async(_id:string,action:string)=>action==='get_group_info'?{participantCount:1}:action==='add_participant'?{status:'invite_required'}:{};
 await f.engine().tick();assert.equal((f.db.prepare('SELECT membership_state FROM customers').get() as any).membership_state,'review');
 assert.equal(f.calls.filter(c=>c.action==='send_message').length,0);
});
test('stop waits for in-flight remote work, records its result, and starts no further work',async t=>{
 const f=fixture(t);f.ingest([]);f.ingest([row(1)]);f.link();let finish!:(v:any)=>void;let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
 f.wa.call=async(_id:string,action:string)=>{if(action==='get_group_info')return {participantCount:1};entered();return new Promise(r=>finish=r);};
 const engine=f.engine();const tick=engine.tick();await started;let stopped=false;const draining=engine.stop().then(()=>stopped=true);await Promise.resolve();assert.equal(stopped,false);
 finish({status:'joined'});await draining;await tick;assert.equal((f.db.prepare('SELECT membership_state FROM customers').get() as any).membership_state,'joined');
});
test('pause during metadata read prevents the subsequent addition',async t=>{
 const f=fixture(t);f.ingest([]);f.ingest([row(1)]);f.link();
 f.wa.call=async(_id:string,action:string)=>{f.calls.push({action});f.db.prepare('UPDATE companies SET paused=1').run();return {participantCount:1};};await f.engine().tick();assert.equal(f.calls.length,1);
});
test('uncertain rollover creation cannot create a second group on the next tick',async t=>{
 const f=fixture(t);f.ingest([]);f.ingest([row(1)]);f.link();f.wa.call=async(_id:string,action:string)=>{f.calls.push({action});if(action==='get_group_info')return {participantCount:999};throw new Error('creation timeout');};
 const engine=f.engine();await engine.tick();await engine.tick();assert.equal(f.calls.filter(c=>c.action==='create_group').length,1);assert.equal(f.calls.filter(c=>c.action==='add_participant').length,0);
});
test('global rollover keeps a stable base title and increments its counter',async t=>{
 const f=fixture(t);f.ingest([]);f.ingest([row(1),row(2,39,'01112345678')]);f.db.prepare('UPDATE companies SET settings=?').run(JSON.stringify({...f.repo.settings(f.id),distributionMode:'global',globalGroupId:'120363000000000001@g.us',globalGroupTitle:'Customers'}));
 let n=1;f.wa.call=async(_id:string,action:string,payload:any)=>{f.calls.push({action,payload});return action==='get_group_info'?{participantCount:999}:action==='create_group'?{groupId:`12036300000000000${++n}@g.us`}:{status:'joined'};};
 const engine=f.engine();await engine.tick();await engine.tick();assert.deepEqual(f.calls.filter(c=>c.action==='create_group').map(c=>c.payload.title),['Customers 2','Customers 3']);
});
test('online backup includes committed WAL data and the matching SQL encryption key; offline restore preserves them',async t=>{
 const f=fixture(t);f.ingest([row(1)]);const secrets=localSecretStore(f.dir);f.db.prepare('UPDATE sources SET config=?').run(secrets.encrypt({password:'qa-only'}));
 f.db.pragma('wal_autocheckpoint=0');f.db.prepare("UPDATE companies SET name='Backed up'").run();
 const out=join(f.dir,'backup');await createBackup(f.dir,out);assert.equal(verifyBackup(out),4);const backed=new Database(join(out,'app.sqlite'),{readonly:true});try{assert.equal(localSecretStore(out).decrypt((backed.prepare('SELECT config FROM sources').get() as any).config).password,'qa-only');}finally{backed.close();}
 f.db.prepare("UPDATE companies SET name='Later'").run();f.db.close();await restoreBackup(f.dir,out);const restored=new Database(join(f.dir,'app.sqlite'));try{assert.equal((restored.prepare('SELECT name FROM companies').get() as any).name,'Backed up');}finally{restored.close();}
});
test('exclusive runtime lock refuses a second server and offline backup while live',async t=>{
 const f=fixture(t);f.ingest([]);const release=acquireLock(join(f.dir,'runtime.lock'));try{assert.throws(()=>acquireLock(join(f.dir,'runtime.lock')));await assert.rejects(createBackup(f.dir,join(f.dir,'backup'),true));}finally{release();}
});
test('version 1 upgrade saves a pre-migration database and preserves customer records',t=>{
 const f=fixture(t);f.ingest([row(1)]);f.db.prepare('DELETE FROM schema_migrations WHERE version>=2').run();f.db.close();const db=openDatabase(join(f.dir,'app.sqlite'));try{assert.equal((db.prepare('SELECT count(*) n FROM customers').get() as any).n,1);assert.equal((db.prepare('SELECT max(version) n FROM schema_migrations').get() as any).n,4);assert.ok(readdirSync(f.dir).some(n=>n.includes('pre-v2')));}finally{db.close();}
});
test('periodic full reconciliation refreshes a corrected old phone; parallel sync is rejected and stop drains',async t=>{
 const f=fixture(t);const snapshot={identity:'qa',label:'qa',branches,customers:[row(1)]};f.repo.ingest(f.id,snapshot,'sql','unused');f.db.prepare("UPDATE sources SET last_full_sync='2020-01-01T00:00:00Z'").run();
 const secrets=localSecretStore(f.dir);f.db.prepare('UPDATE sources SET config=?').run(secrets.encrypt({}));let options:any='unset';let finish!:()=>void;
 const svc=new SyncService(f.db,f.repo,secrets,process.cwd(),async(_cfg,opts)=>{options=opts;await new Promise<void>(r=>finish=r);return {...snapshot,customers:[row(1,39,'01112345678')]};});
 const running=svc.run(f.id);await assert.rejects(svc.run(f.id),/جارية/);const stop=svc.stop();finish();await running;await stop;assert.equal(options,undefined);assert.equal((f.db.prepare('SELECT phone FROM customers').get() as any).phone,'201112345678');
});
test('resume preserves preview and saving branch/settings never requeues uncertain results',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'elrawda-api-'));const x=await createApp({dataDir:dir,root:process.cwd()});await x.engine.stop();t.after(async()=>{await x.app.close();rmSync(dir,{recursive:true,force:true});});
 const headers:any={host:'localhost','x-emoji-request':'1'};const auth=await x.app.inject({method:'POST',url:'/api/auth/bootstrap',headers,payload:{username:'qauser',password:'ReviewOnly2026!'}});headers.cookie=auth.cookies.map(c=>`${c.name}=${c.value}`).join(';');
 const created=await x.app.inject({method:'POST',url:'/api/companies',headers,payload:{name:'QA Company'}});const id=created.json().id;
 const resume=await x.app.inject({method:'POST',url:'/api/processing',headers,payload:{paused:false}});assert.equal(resume.json().runMode,'preview');
 x.repo.ingest(id,{identity:'qa',label:'qa',branches,customers:[row(1)]},'snapshot');x.db.prepare("UPDATE customers SET membership_state='review'").run();
 const saved=await x.app.inject({method:'PUT',url:'/api/branches',headers,payload:[{programId:9,branchId:39,enabled:true,groupId:'120363000000000001@g.us',baseName:'QA',nextCounter:2}]});assert.equal(saved.statusCode,200);
 await x.app.inject({method:'PUT',url:'/api/settings',headers,payload:{...x.repo.settings(id),distributionMode:'global',globalGroupId:'120363000000000002@g.us'}});
 assert.equal((x.db.prepare('SELECT membership_state FROM customers').get() as any).membership_state,'review');
});
for (const connectionFails of [false, true]) test(`manual WhatsApp linking keeps the queue paused until explicit resume (connection fails: ${connectionFails})`, async t => {
 const dir=mkdtempSync(join(tmpdir(),'elrawda-relink-'));
 const x=await createApp({dataDir:dir,root:process.cwd()});
 await x.engine.stop();
 t.after(async()=>{await x.app.close();rmSync(dir,{recursive:true,force:true});});
 const headers:any={host:'localhost','x-emoji-request':'1'};
 const auth=await x.app.inject({method:'POST',url:'/api/auth/bootstrap',headers,payload:{username:'qauser',password:'ReviewOnly2026!'}});
 headers.cookie=auth.cookies.map(c=>`${c.name}=${c.value}`).join(';');
 const created=await x.app.inject({method:'POST',url:'/api/companies',headers,payload:{name:'Relink QA'}});
 const id=created.json().id;
 x.repo.ingest(id,{identity:'qa',label:'qa',branches,customers:[]},'snapshot');
 x.repo.ingest(id,{identity:'qa',label:'qa',branches,customers:[row(1)]},'snapshot');
 x.db.prepare("UPDATE branches SET enabled=1,group_id='120363000000000001@g.us' WHERE company_id=?").run(id);
 x.db.prepare("UPDATE companies SET paused=0,run_mode='live',pause_until='2000-01-01T00:00:00.000Z' WHERE id=?").run(id);
 const actions:string[]=[];
 x.wa.call=async(companyId,action)=>{
   actions.push(action);
   if(action==='connect') {
     // The pause must already be committed before the connection can become ready.
     const observer=new Database(join(dir,'app.sqlite'),{readonly:true});
     try { assert.deepEqual(observer.prepare('SELECT paused,pause_until FROM companies WHERE id=?').get(id),{paused:1,pause_until:null}); }
     finally { observer.close(); }
     if(connectionFails) throw new Error('واتساب: تعذر الربط');
     x.wa.state={companyId,status:'ready'};
     return x.wa.state;
   }
   return action==='get_group_info'?{participantCount:1}:{status:'joined'};
 };
 const linked=await x.app.inject({method:'POST',url:'/api/whatsapp/connect',headers});
 assert.equal(linked.statusCode,connectionFails?500:200);
 // A later automatic recovery must also respect the saved pause.
 x.wa.state={companyId:id,status:'ready'};
 const engine=new ExecutionEngine(x.db,x.repo,x.wa);
 await engine.tick();
 assert.deepEqual(actions,['connect']);
 assert.equal((x.db.prepare('SELECT membership_state FROM customers WHERE company_id=?').get(id) as any).membership_state,'not_attempted');
 const resumed=await x.app.inject({method:'POST',url:'/api/processing',headers,payload:{paused:false}});
 assert.equal(resumed.statusCode,200);
 await engine.tick();
 assert.deepEqual(actions,['connect','get_group_info','add_participant']);
});
test('an in-flight addition result cannot attach old phone evidence to a corrected customer',async t=>{
 const f=fixture(t);f.ingest([]);f.ingest([row(1)]);f.link();f.wa.call=async(_id:string,action:string)=>{if(action==='get_group_info')return {participantCount:1};f.ingest([row(1,39,'01112345678')]);return {status:'joined'};};
 await f.engine().tick();const customer=f.db.prepare('SELECT * FROM customers').get() as any;assert.equal(customer.phone,'201112345678');assert.equal(customer.membership_state,'review');assert.equal(customer.whatsapp_state,'unchecked');
});
test('editing the group while metadata loads prevents addition to the old destination',async t=>{
 const f=fixture(t);f.ingest([]);f.ingest([row(1)]);f.link();f.wa.call=async(_id:string,action:string)=>{f.calls.push({action});f.db.prepare("UPDATE branches SET group_id='120363000000000002@g.us'").run();return {participantCount:1};};
 await f.engine().tick();assert.equal(f.calls.length,1);
});
test('a failing group metadata request does not starve another ready branch',async t=>{
 const f=fixture(t);f.ingest([]);f.ingest([row(1),row(2,40,'01112345678')]);f.link();f.db.prepare("UPDATE branches SET group_id='120363000000000002@g.us' WHERE branch_id=40").run();
 f.wa.call=async(_id:string,action:string,payload:any)=>{f.calls.push({action,payload});if(action==='get_group_info'&&payload.groupId.endsWith('1@g.us'))throw new Error('metadata timeout');return action==='get_group_info'?{participantCount:1}:{status:'joined'};};
 const engine=f.engine();await engine.tick();await engine.tick();assert.equal(f.calls.find(c=>c.action==='add_participant').payload.phone,'201112345678');
});
test('full reconciliation retains history but excludes hidden/deleted ERP customers from execution',async t=>{
 const f=fixture(t);f.ingest([]);f.ingest([row(1),row(2,39,'01112345678')]);f.link();
 f.repo.ingest(f.id,{identity:'qa',label:'qa',branches,customers:[row(2,39,'01112345678')]},'snapshot',null,true);
 await f.engine().tick();assert.equal(f.calls.find(c=>c.action==='add_participant').payload.phone,'201112345678');assert.equal((f.db.prepare('SELECT count(*) n FROM customers').get() as any).n,2);
 assert.equal((f.db.prepare('SELECT source_active FROM customers WHERE person_id=1').get() as any).source_active,0);
});
test('future schema is rejected without attempting a downgrade',t=>{
 const f=fixture(t);f.db.prepare("INSERT INTO schema_migrations VALUES(99,datetime('now'))").run();f.db.close();assert.throws(()=>openDatabase(join(f.dir,'app.sqlite')),/أحدث/);
});
test('manual state check reconciles unknown membership without repeating a remote write',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'elrawda-reconcile-'));const x=await createApp({dataDir:dir,root:process.cwd()});t.after(async()=>{await x.app.close();rmSync(dir,{recursive:true,force:true});});
 const headers:any={host:'localhost','x-emoji-request':'1'};const auth=await x.app.inject({method:'POST',url:'/api/auth/bootstrap',headers,payload:{username:'qauser',password:'ReviewOnly2026!'}});headers.cookie=auth.cookies.map(c=>`${c.name}=${c.value}`).join(';');const made=await x.app.inject({method:'POST',url:'/api/companies',headers,payload:{name:'QA company'}});const id=made.json().id;
 x.repo.ingest(id,{identity:'qa',label:'qa',branches,customers:[row(1)]},'snapshot');x.db.prepare("UPDATE customers SET membership_state='review'").run();
 const key='120363000000000001@g.us:201012345678';x.db.prepare("INSERT INTO operations VALUES(?,'add',?,'unknown',?,NULL,datetime('now'),datetime('now'))").run(id,key,JSON.stringify({groupId:'120363000000000001@g.us',phone:'201012345678'}));
 const actions:string[]=[];x.wa.call=async(_id:string,action:string)=>{actions.push(action);return action==='lookup'?{registered:true}:{status:'already_member'};};
 const res=await x.app.inject({method:'POST',url:'/api/customers/check',headers,payload:{programId:9,branchId:39,personId:1}});assert.equal(res.statusCode,200);assert.deepEqual(actions,['lookup','get_membership']);assert.equal((x.db.prepare('SELECT membership_state FROM customers').get() as any).membership_state,'joined');assert.equal((x.db.prepare('SELECT status FROM operations').get() as any).status,'completed');
});
