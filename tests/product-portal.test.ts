import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { Code128Reader, Code93Reader } from "@zxing/library";
import Fastify from "fastify";
import { ZodError } from "zod";
import Database from "better-sqlite3";
import { openDatabase } from "../packages/storage/database.js";
import { CompanyRepository } from "../packages/storage/company-repository.js";
import { createPortal, createLimiter } from "../apps/server/portal.js";
import { registerPortalAdmin } from "../apps/server/portal-admin.js";
import { hashPassword, localSecretStore } from "../apps/server/security.js";
import { createBackup, restoreBackup, verifyBackup } from "../packages/storage/backup.js";
import { productCodePattern, type Product, type ProductReader } from "../packages/erp/products.js";
const product:Product={id:"186759",unitId:"1",code:"Z3330",name:"بنطلون",category:"جبردين",description:"بنطلون جبردين مستورد",unit:"قطعة",price:650};
async function fixture(t:any) {
  const dir=mkdtempSync(join(tmpdir(),"emoji-portal-")),db=openDatabase(join(dir,"app.sqlite"));
  db.prepare("INSERT INTO operators VALUES('admin','admin','hash')").run();
  const repo=new CompanyRepository(db),company=repo.create('admin','EMOJI'),other=repo.create('admin','Other');
  const secrets=localSecretStore(dir);
  db.prepare("INSERT INTO sources(company_id,kind,identity,label,config) VALUES(?,'sql','fixture-source','ERP',?)").run(company,secrets.encrypt({server:"fixture",password:"fixture"}));
  db.prepare("UPDATE portal_settings SET enabled=1,company_id=?,origin='https://prices.example.com'").run(company);
  const userId=randomUUID();
  db.prepare("INSERT INTO photo_users VALUES(?,?,?,?,1,?)").run(userId,company,'photos',hashPassword('password-123'),new Date().toISOString());
  const calls:string[]=[];
  const reader:ProductReader={search:async(id,code)=>{assert.equal(id,company);calls.push(code);return product.code.includes(code.toUpperCase()) || code===product.id?[product]:[];},suggest:async(id,code)=>{assert.equal(id,company);return product.code.includes(code.toUpperCase())?[product]:[];},get:async(id,p,u)=>{assert.equal(id,company);return p===product.id && u===product.unitId?product:undefined;},close:async()=>{}};
  const portal=await createPortal({db,dataDir:dir,root:process.cwd(),reader});
  const admin=Fastify();admin.decorateRequest('operatorId','admin');admin.decorateRequest('companyId',company);
  admin.setErrorHandler((error:any,_request,reply)=>reply.code(error instanceof ZodError?400:error.statusCode??500).send({error:error.message}));
  registerPortalAdmin(admin,db);
  const headers={host:'prices.example.com',origin:'https://prices.example.com','x-emoji-request':'1'};
  const login=async()=>{const response=await portal.inject({method:'POST',url:'/api/login',headers,payload:{username:'photos',password:'password-123'}});assert.equal(response.statusCode,200);return response.cookies[0].value;};
  t.after(async()=>{await portal.close();await admin.close();if(db.open)db.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,db,company,other,userId,portal,admin,headers,login,calls,reader};
}
function multipart(buffer:Buffer,mime='image/png') {
 const boundary='emoji-test-boundary';
 return {payload:Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="test.png"\r\nContent-Type: ${mime}\r\n\r\n`),buffer,Buffer.from(`\r\n--${boundary}--\r\n`)]),contentType:`multipart/form-data; boundary=${boundary}`};
}
async function png(){return sharp({create:{width:20,height:20,channels:3,background:'#ffc400'}}).png().toBuffer();}

test('public lookup supports both codes without a session and preserves literal search text',async t=>{
 const f=await fixture(t);
 for(const code of ['Z3330','186759']) {
  const res=await f.portal.inject({url:`/api/products?code=${code}`,headers:{host:'prices.example.com'}});
  assert.equal(res.statusCode,200);assert.equal(res.json().products[0].price,650);assert.deepEqual(res.json().products[0].images,[]);
 }
 const empty=await f.portal.inject({url:'/api/products?code=0001',headers:f.headers});assert.equal(empty.statusCode,200);assert.deepEqual(empty.json().products,[]);assert.equal(f.calls.at(-1),'0001');
 assert.equal((await f.portal.inject({url:'/api/products?code=',headers:f.headers})).statusCode,400);
});
test('the public listener never registers administration, customer, SQL, shutdown or WhatsApp routes',async t=>{
 const f=await fixture(t),token=await f.login();
 for(const url of ['/api/company','/api/customers','/api/portal/users','/api/source/sql','/api/whatsapp','/internal/shutdown','/healthz']){
  assert.equal((await f.portal.inject({url,headers:f.headers,cookies:{emoji_photo_session:token}})).statusCode,404,url);
 }
 assert.equal((await f.portal.inject({url:'/api/products?code=Z3330',headers:{host:'evil.example'}})).statusCode,403);
 assert.equal((await f.portal.inject({method:'POST',url:'/api/login',headers:{...f.headers,origin:'https://evil.example'},payload:{}})).statusCode,403);
 assert.equal((await f.portal.inject({method:'POST',url:'/api/login',headers:{host:'prices.example.com'},payload:{}})).statusCode,403);
});
test('uploads require a photo session and reject malformed images and invalid products',async t=>{
 const f=await fixture(t),file=multipart(await png()),token=await f.login();
 assert.equal((await f.portal.inject({method:'POST',url:'/api/products/186759/1/images',headers:{...f.headers,'content-type':file.contentType},payload:file.payload})).statusCode,401);
 const bad=multipart(Buffer.from('<svg/>'));
 assert.equal((await f.portal.inject({method:'POST',url:'/api/products/186759/1/images',cookies:{emoji_photo_session:token},headers:{...f.headers,'content-type':bad.contentType},payload:bad.payload})).statusCode,400);
 assert.equal((await f.portal.inject({method:'POST',url:'/api/products/999/1/images',cookies:{emoji_photo_session:token},headers:{...f.headers,'content-type':file.contentType},payload:file.payload})).statusCode,404);
});
test('valid upload becomes a decoded WebP, is visible publicly, and deletion hides it with an audit event',async t=>{
 const f=await fixture(t),token=await f.login(),file=multipart(await png());
 const upload=await f.portal.inject({method:'POST',url:'/api/products/186759/1/images',cookies:{emoji_photo_session:token},headers:{...f.headers,'content-type':file.contentType},payload:file.payload});
 assert.equal(upload.statusCode,200,upload.body);const photo=upload.json().images[0];
 assert.equal((await sharp(readFileSync(join(f.dir,'product-images',`${photo.id}.webp`))).metadata()).format,'webp');
 const read=await f.portal.inject({url:photo.url,headers:f.headers});assert.equal(read.statusCode,200);assert.match(read.headers['content-type'] as string,/image\/webp/);
 assert.equal((await f.portal.inject({url:'/api/products?code=186759',headers:f.headers})).json().products[0].images.length,1);
 assert.equal((await f.portal.inject({method:'DELETE',url:photo.url,headers:f.headers})).statusCode,401);
 assert.equal((await f.portal.inject({method:'DELETE',url:photo.url,headers:f.headers,cookies:{emoji_photo_session:token}})).statusCode,200);
 assert.equal((await f.portal.inject({url:photo.url,headers:f.headers})).statusCode,404);
 assert.equal((f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event LIKE 'product.image.%'").get() as any).n,2);
});
test('images are isolated by source and company, including direct image URLs',async t=>{
 const f=await fixture(t),token=await f.login(),file=multipart(await png());
 const uploaded=await f.portal.inject({method:'POST',url:'/api/products/186759/1/images',headers:{...f.headers,'content-type':file.contentType},cookies:{emoji_photo_session:token},payload:file.payload});
 const photo=uploaded.json().images[0];
 f.db.prepare("UPDATE sources SET identity='new-source' WHERE company_id=?").run(f.company);
 assert.equal((await f.portal.inject({url:photo.url,headers:f.headers})).statusCode,404);
 assert.deepEqual((await f.portal.inject({url:'/api/products?code=Z3330',headers:f.headers})).json().products[0].images,[]);
 f.db.prepare("UPDATE portal_settings SET company_id=?").run(f.other);
 assert.equal((await f.portal.inject({url:photo.url,headers:f.headers})).statusCode,503);
});
test('admin reset and disabling revoke sessions; cross-company account editing is rejected',async t=>{
 const f=await fixture(t),token=await f.login();
 assert.equal((await f.portal.inject({url:'/api/session',headers:f.headers,cookies:{emoji_photo_session:token}})).json().authenticated,true);
 const reset=await f.admin.inject({method:'PUT',url:`/api/portal/users/${f.userId}`,payload:{enabled:true,password:'another-password'}});assert.equal(reset.statusCode,200,reset.body);
 assert.equal((await f.portal.inject({url:'/api/session',headers:f.headers,cookies:{emoji_photo_session:token}})).json().authenticated,false);
 const otherId=randomUUID();f.db.prepare("INSERT INTO photo_users VALUES(?,?,?,?,1,?)").run(otherId,f.other,'other',hashPassword('password-123'),new Date().toISOString());
 assert.equal((await f.admin.inject({method:'PUT',url:`/api/portal/users/${otherId}`,payload:{enabled:false}})).statusCode,404);
});
test('administrator settings validate HTTPS origin and do not expose password hashes',async t=>{
 const f=await fixture(t);
 assert.equal((await f.admin.inject({url:'/api/portal/settings'})).body.includes('password_hash'),false);
 assert.equal((await f.admin.inject({method:'PUT',url:'/api/portal/settings',payload:{enabled:true,origin:'https://prices.example.com/'}})).statusCode,400);
 const save=await f.admin.inject({method:'PUT',url:'/api/portal/settings',payload:{enabled:false,origin:'https://prices.example.com'}});assert.equal(save.statusCode,200);
 assert.equal((await f.portal.inject({url:'/api/products?code=Z3330',headers:f.headers})).statusCode,503);
});
test('online backup and offline restore preserve product images and their database records',async t=>{
 const f=await fixture(t),token=await f.login(),file=multipart(await png());
 const uploaded=await f.portal.inject({method:'POST',url:'/api/products/186759/1/images',headers:{...f.headers,'content-type':file.contentType},cookies:{emoji_photo_session:token},payload:file.payload});
 const photo=uploaded.json().images[0];await createBackup(f.dir,join(f.dir,'backup'));assert.equal(verifyBackup(join(f.dir,'backup')),4);
 assert.ok(existsSync(join(f.dir,'backup','product-images',`${photo.id}.webp`)));
 await f.portal.close();f.db.close();await restoreBackup(f.dir,join(f.dir,'backup'));
 const restored=new Database(join(f.dir,'app.sqlite'));try{assert.equal((restored.prepare('SELECT COUNT(*) n FROM product_images').get() as any).n,1);}finally{restored.close();}
 assert.ok(existsSync(join(f.dir,'product-images',`${photo.id}.webp`)));
});
test('rate limiter blocks excess traffic and stays bounded',()=>{
 const limit=createLimiter();limit('search',2);limit('search',2);assert.throws(()=>limit('search',2),/طلبات كثيرة/);
});

test('image limit is enforced and files exceeding 5 MB are rejected',async t=>{
 const f=await fixture(t),token=await f.login(),file=multipart(await png());
 const insert=f.db.prepare("INSERT INTO product_images VALUES(?,?,?,?,?,?,?,NULL)");
 for(let i=0;i<10;i++) insert.run(randomUUID(),f.company,'fixture-source','186759','1',f.userId,new Date().toISOString());
 const response=await f.portal.inject({method:'POST',url:'/api/products/186759/1/images',headers:{...f.headers,'content-type':file.contentType},cookies:{emoji_photo_session:token},payload:file.payload});
 assert.equal(response.statusCode,409);
 assert.equal((f.db.prepare('SELECT COUNT(*) n FROM product_images').get() as any).n,10);
 const large=multipart(Buffer.alloc(5*1024*1024+1));
 const rejected=await f.portal.inject({method:'POST',url:'/api/products/186759/1/images',headers:{...f.headers,'content-type':large.contentType},cookies:{emoji_photo_session:token},payload:large.payload});
 assert.equal(rejected.statusCode,413);
});

test('disabled accounts cannot log in and administrative cookies never authenticate photo mutations',async t=>{
 const f=await fixture(t),token=await f.login();
 const disabled=await f.admin.inject({method:'PUT',url:`/api/portal/users/${f.userId}`,payload:{enabled:false}});assert.equal(disabled.statusCode,200);
 assert.equal((await f.portal.inject({url:'/api/session',headers:f.headers,cookies:{emoji_photo_session:token}})).json().authenticated,false);
 assert.equal((await f.portal.inject({method:'POST',url:'/api/login',headers:f.headers,payload:{username:'photos',password:'password-123'}})).statusCode,401);
 const file=multipart(await png());
 assert.equal((await f.portal.inject({method:'POST',url:'/api/products/186759/1/images',headers:{...f.headers,'content-type':file.contentType},cookies:{emoji_session:token},payload:file.payload})).statusCode,401);
});

test('reader outages return an explicit error without credentials or stale prices',async t=>{
 const f=await fixture(t);
 f.reader.search=async()=>{throw new Error('SQL password=private; database unavailable');};
 const res=await f.portal.inject({url:'/api/products?code=Z3330',headers:f.headers});
 assert.equal(res.statusCode,503);assert.equal(res.body.includes('650'),false);assert.equal(res.body.includes('password'),false);
});

test('a session revoked during product verification cannot commit a photo upload',async t=>{
 const f=await fixture(t),token=await f.login(),file=multipart(await png());
 f.reader.get=async()=>{f.db.prepare('DELETE FROM photo_sessions').run();return product;};
 const response=await f.portal.inject({method:'POST',url:'/api/products/186759/1/images',headers:{...f.headers,'content-type':file.contentType},cookies:{emoji_photo_session:token},payload:file.payload});
 assert.equal(response.statusCode,401);
 assert.equal((f.db.prepare('SELECT COUNT(*) n FROM product_images').get() as any).n,0);
});


test('partial model codes produce suggestions while partial numeric product IDs do not',async t=>{
 const f=await fixture(t);
 for(const code of ['Z33','333']) {
  const res=await f.portal.inject({url:`/api/suggestions?code=${code}`,headers:f.headers});
  assert.equal(res.statusCode,200);assert.equal(res.json().suggestions[0].code,'Z3330');
 }
 const missing=await f.portal.inject({url:'/api/suggestions?code=186',headers:f.headers});
 assert.deepEqual(missing.json().suggestions,[]);
 assert.deepEqual((await f.portal.inject({url:'/api/products?code=186',headers:f.headers})).json().products,[]);
 assert.equal((await f.portal.inject({url:'/api/products?code=186759',headers:f.headers})).json().products[0].id,'186759');
 const selected=await f.portal.inject({url:'/api/products/186759/1',headers:f.headers});
 assert.equal(selected.statusCode,200);assert.equal(selected.json().products[0].code,'Z3330');
 assert.equal((await f.portal.inject({url:'/api/products/186759/99',headers:f.headers})).statusCode,404);
 assert.equal((await f.portal.inject({url:'/api/suggestions?code=',headers:f.headers})).statusCode,400);
 for(const [raw,normalized] of [['V%206302','V 6302'],['V%20%20%206302','V 6302'],['H_2025','H_2025'],['H-2025','H-2025']]) {
  const sugRes=await f.portal.inject({url:`/api/suggestions?code=${raw}`,headers:f.headers});
  assert.equal(sugRes.statusCode,200);
  const prodRes=await f.portal.inject({url:`/api/products?code=${raw}`,headers:f.headers});
  assert.equal(prodRes.statusCode,200);
  assert.equal(f.calls.at(-1),normalized);
 }
 for(const code of ['Z%25','Z%27','Z%5B1%5D','---','%20%20%20']) {
  assert.equal((await f.portal.inject({url:`/api/suggestions?code=${code}`,headers:f.headers})).statusCode,400);
  assert.equal((await f.portal.inject({url:`/api/products?code=${code}`,headers:f.headers})).statusCode,400);
 }
});

test('model code patterns escape SQL wildcards without changing literal codes',()=>{
 assert.equal(productCodePattern('Z33'),'%Z33%');
 assert.equal(productCodePattern('H%_['+String.fromCharCode(92)), '%H'+String.fromCharCode(92)+'%'+String.fromCharCode(92)+'_'+String.fromCharCode(92)+'['+String.fromCharCode(92).repeat(2)+'%');
});

function renderCode128bSvg(text:string, barW=2, height=76, fg='#000', bg='#fff'){
 const patterns=(Code128Reader as any).CODE_PATTERNS as Array<ArrayLike<number>>;
 const codes=[104];
 let checksum=104;
 for(let i=0;i<text.length;i++){
  const c=text.charCodeAt(i)-32;
  codes.push(c);
  checksum+=c*(i+1);
 }
 codes.push(checksum%103,106);
 const quiet=10*barW;
 let x=quiet,rects='';
 for(const code of codes){
  const pat=patterns[code];
  for(let j=0;j<pat.length;j++){
   const w=pat[j]*barW;
   if(j%2===0)rects+=`<rect x="${x}" y="12" width="${w}" height="${height}" fill="${fg}"/>`;
   x+=w;
  }
 }
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${x+quiet}" height="${height+24}"><rect width="100%" height="100%" fill="${bg}"/>${rects}</svg>`;
}

function renderCode93Svg(text:string, barW=2, height=80, fg='#000', bg='#fff'){
 const alpha=(Code93Reader as any).ALPHABET_STRING as string;
 const enc=(Code93Reader as any).CHARACTER_ENCODINGS as number[];
 const checkWeight=(vals:number[],maxW:number)=>{
  let sum=0;
  for(let i=0;i<vals.length;i++)sum+=vals[vals.length-1-i]*((i%maxW)+1);
  return sum%47;
 };
 const vals=[...text].map(ch=>alpha.indexOf(ch));
 vals.push(checkWeight(vals,20));
 vals.push(checkWeight(vals,15));
 let x=10*barW,rects='';
 const drawBits=(bits:number,len:number)=>{
  for(let b=len-1;b>=0;b--){
   if((bits>>b)&1)rects+=`<rect x="${x}" y="12" width="${barW}" height="${height}" fill="${fg}"/>`;
   x+=barW;
  }
 };
 for(const code of [47,...vals,47])drawBits(enc[code],9);
 rects+=`<rect x="${x}" y="12" width="${barW}" height="${height}" fill="${fg}"/>`;
 x+=barW;
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${x+10*barW}" height="${height+24}"><rect width="100%" height="100%" fill="${bg}"/>${rects}</svg>`;
}

test('POST /api/decode-barcode decodes small centered tags in high-res photos, EXIF-rotated vertical tags, and low-contrast Code-93 tags',async t=>{
 const f=await fixture(t);

 // 1. Small centered Code-128 tag inside a 2400x1800 frame (iPhone ~15-20cm shooting distance)
 const smallTag=await sharp(Buffer.from(renderCode128bSvg('Z3330',2,64))).png().toBuffer();
 const highResScene=await sharp({create:{width:2400,height:1800,channels:3,background:'#334155'}})
  .composite([{input:smallTag,gravity:'centre'}])
  .jpeg({quality:90})
  .toBuffer();
 const scenePart=multipart(highResScene,'image/jpeg');
 const res1=await f.portal.inject({method:'POST',url:'/api/decode-barcode',headers:{...f.headers,'content-type':scenePart.contentType},payload:scenePart.payload});
 assert.equal(res1.statusCode,200);
 assert.equal(res1.json().code,'Z3330');

 // 2. EXIF-rotated vertical photo (sensor sideways + EXIF orientation=6)
 const rotatedTag=await sharp(Buffer.from(renderCode128bSvg('Z3330',2,70))).rotate(90).png().toBuffer();
 const exifScene=await sharp({create:{width:1800,height:2400,channels:3,background:'#1f2937'}})
  .composite([{input:rotatedTag,gravity:'centre'}])
  .withMetadata({orientation:6})
  .jpeg({quality:90})
  .toBuffer();
 const exifPart=multipart(exifScene,'image/jpeg');
 const res2=await f.portal.inject({method:'POST',url:'/api/decode-barcode',headers:{...f.headers,'content-type':exifPart.contentType},payload:exifPart.payload});
 assert.equal(res2.statusCode,200);
 assert.equal(res2.json().code,'Z3330');

 // 3. Low-contrast Code-93 tag requiring CODE_93 support + contrast normalization
 const lowContrast93=await sharp(Buffer.from(renderCode93Svg('H2025',2,72,'#6b7280','#cbd5e1'))).png().toBuffer();
 const scene93=await sharp({create:{width:1600,height:1200,channels:3,background:'#475569'}})
  .composite([{input:lowContrast93,gravity:'centre'}])
  .jpeg({quality:90})
  .toBuffer();
 const part93=multipart(scene93,'image/jpeg');
 const res3=await f.portal.inject({method:'POST',url:'/api/decode-barcode',headers:{...f.headers,'content-type':part93.contentType},payload:part93.payload});
 assert.equal(res3.statusCode,200);
 assert.equal(res3.json().code,'H2025');
});
