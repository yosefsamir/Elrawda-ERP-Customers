import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'elrawda-browser-smoke-'));
const worker=fork(resolve('dist/runtime/apps/whatsapp-worker/index.js'),[],{env:{...process.env,EMOJI_DATA_DIR:dir},stdio:['ignore','pipe','pipe','ipc']});
let logs='';worker.stderr.on('data',b=>logs+=b);worker.stdout.on('data',b=>logs+=b);
try {
 await new Promise((yes,no)=>{
  const timer=setTimeout(()=>no(new Error('WhatsApp QR did not become ready in 90 seconds. '+logs)),90000);
  worker.on('message',m=>{if(m.type==='state'&&m.state.status==='qr'){clearTimeout(timer);yes();}if(m.type==='state'&&m.state.status==='error'){clearTimeout(timer);no(new Error(m.state.error+' '+logs));}});
  worker.once('exit',code=>{clearTimeout(timer);no(new Error(`Worker exited ${code}: ${logs}`));});
  worker.send({id:'connect-smoke',action:'connect',companyId:'00000000-0000-4000-8000-000000000099',payload:{}});
 });
 console.log('PASS: compiled worker loaded production helpers, launched Chromium with updated Puppeteer, and reached a fresh WhatsApp QR without linking an account or sending anything.');
} finally {
 const exited=new Promise(r=>worker.once('exit',r));
 if(worker.connected)worker.send({action:'shutdown'});
 const timeout=setTimeout(()=>worker.kill('SIGKILL'),40000);
 await exited;clearTimeout(timeout);rmSync(dir,{recursive:true,force:true});
}
