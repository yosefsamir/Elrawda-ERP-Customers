import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,cpSync,symlinkSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
const root=process.cwd(),temp=mkdtempSync(join(tmpdir(),'Elrawda release smoke ')),appRoot=join(temp,'release 1'),data=join(temp,'customer data'),ready=join(temp,'ready.json');
cpSync(resolve('dist'),join(appRoot,'dist'),{recursive:true});cpSync('package.json',join(appRoot,'package.json'));
symlinkSync(resolve(process.env.ELRAWDA_SMOKE_MODULES || 'node_modules'),join(appRoot,'node_modules'),'dir');
const env={...process.env,EMOJI_APP_ROOT:appRoot,EMOJI_DATA_DIR:data,EMOJI_READY_FILE:ready,PORT:'0'};
let child,logs='';
async function run(args){return new Promise((yes,no)=>{const c=spawn(process.execPath,args,{cwd:appRoot,env});let text='';c.stdout.on('data',b=>text+=b);c.stderr.on('data',b=>text+=b);c.on('exit',code=>code===0?yes(text):no(new Error(text)));c.on('error',no);});}
async function start(){if(existsSync(ready))rmSync(ready);child=spawn(process.execPath,['dist/runtime/apps/server/index.js'],{cwd:appRoot,env});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);const deadline=Date.now()+20000;while(!existsSync(ready)){if(child.exitCode!==null||Date.now()>deadline)throw new Error(logs);await new Promise(r=>setTimeout(r,100));}return JSON.parse(readFileSync(ready,'utf8')).port;}
async function stop(){const exited=new Promise(r=>child.once('exit',r));await run(['dist/runtime/scripts/maintenance/admin.js','stop']);assert.equal(await exited,0);}
try{
 let port=await start();let base=`http://127.0.0.1:${port}`;
 const health=await (await fetch(base+'/healthz')).json();assert.equal(health.ok,true);assert.equal(health.schemaVersion,2);
 const auth=await fetch(base+'/api/auth/bootstrap',{method:'POST',headers:{'content-type':'application/json','x-emoji-request':'1'},body:JSON.stringify({username:'releaseqa',password:'OnlyForIsolatedTests!'})});assert.equal(auth.status,200);const cookie=auth.headers.get('set-cookie').split(';')[0];
 const created=await fetch(base+'/api/companies',{method:'POST',headers:{'content-type':'application/json','x-emoji-request':'1',cookie},body:JSON.stringify({name:'Persistent customer company'})});assert.equal(created.status,200);
 const web=await fetch(base+'/');assert.equal(web.status,200);assert.match(await web.text(),/assets\/index/);
 const backup=join(temp,'online backup');await run(['dist/runtime/scripts/maintenance/admin.js','backup','--output',backup]);await run(['dist/runtime/scripts/maintenance/admin.js','verify-backup','--input',backup]);
 await stop();
 await run(['dist/runtime/scripts/maintenance/admin.js','restore','--input',backup]);
 await run(['dist/runtime/scripts/maintenance/probe.js',data,'--readonly']);
 port=await start();base=`http://127.0.0.1:${port}`;
 const restored=await (await fetch(base+'/api/company',{headers:{cookie}})).json();assert.equal(restored.name,'Persistent customer company');assert.equal(restored.runMode,'preview');assert.equal(restored.paused,1);await stop();
 console.log('PASS: built JavaScript runs without TS source/tsx; HTTP/UI, online WAL backup, verification, offline restore, schema probe, restart, persistent credentials and company data, graceful shutdown.');
}finally{if(child?.exitCode===null)child.kill('SIGKILL');rmSync(temp,{recursive:true,force:true});}
