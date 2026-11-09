import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  GlobalHistogramBinarizer,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from "@zxing/library";
import { z, ZodError } from "zod";
import type { AppDatabase } from "../../packages/storage/database.js";
import { createProductReader, type ProductReader } from "../../packages/erp/products.js";
import { isLocalOrLanHost, localSecretStore, tokenHash, verifyPassword } from "./security.js";
import { auditPortal, photoCredentials } from "./portal-admin.js";
const productParams=z.object({id:z.string().regex(/^\d{1,18}$/),unit:z.string().regex(/^\d{1,18}$/)});
const lookupQuery=z.object({code:z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9]+$/)});
const loginCredentials=z.object({username:z.unknown().transform(v=>typeof v==="string"?v.trim():""),password:z.unknown().transform(v=>typeof v==="string"?v:"")});
const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const cookieName="emoji_photo_session";
export function createLimiter() {
  const buckets=new Map<string,{count:number;until:number}>();
  return (key:string,max:number,window=60000)=>{
    const now=Date.now();
    if(buckets.size>=10000) for(const [k,v] of buckets) if(v.until<=now) buckets.delete(k);
    let value=buckets.get(key);
    if(!value || value.until<=now) {
      if(buckets.size>=10000) throw fail("الخدمة مشغولة؛ حاول بعد قليل",429);
      buckets.set(key,value={count:0,until:now+window});
    }
    if(++value.count>max) throw fail("طلبات كثيرة؛ انتظر قليلًا ثم حاول مجددًا",429);
  };
}
export async function createPortal(options:{db:AppDatabase;dataDir:string;root:string;reader?:ProductReader;logger?:boolean}) {
  const {db}=options;
  const reader=options.reader??createProductReader(db,localSecretStore(options.dataDir));
  const app=Fastify({logger:options.logger??false,bodyLimit:6*1024*1024,disableRequestLogging:true});
  await app.register(cookie);
  await app.register(multipart,{limits:{fileSize:5*1024*1024,files:1,fields:0,parts:1}});
  const directory=resolve(options.dataDir,"product-images");mkdirSync(directory,{recursive:true});
  const limit=createLimiter();
  function settings() {
    const row=db.prepare(`SELECT p.enabled,p.origin,p.company_id FROM portal_settings p WHERE p.id=1`).get() as any;
    if(!row?.enabled) throw fail("الاستعلام غير مفعّل حاليًا؛ تواصل مع المسؤول",503);
    const company = ((row.company_id ? db.prepare("SELECT id FROM companies WHERE id=?").get(row.company_id) : null)
      || db.prepare("SELECT id FROM companies LIMIT 1").get()) as { id: string } | undefined;
    if (!company) throw fail("لا توجد شركة معرفة في النظام", 503);
    const source = db.prepare("SELECT identity, config FROM sources WHERE company_id=? AND kind='sql' AND config IS NOT NULL").get(company.id) as any;
    if (!source) throw fail("قاعدة بيانات الشركة غير مربوطة بعد؛ تواصل مع المسؤول", 503);
    if (row.company_id !== company.id) {
      db.prepare("UPDATE portal_settings SET company_id=? WHERE id=1").run(company.id);
    }
    return {company_id:company.id,enabled:row.enabled,origin:row.origin,identity:source.identity};
  }
  function user(request:any,config:ReturnType<typeof settings>) {
    const token=request.cookies[cookieName];
    if(!token) return undefined;
    return db.prepare(`SELECT u.id,u.username FROM photo_sessions s JOIN photo_users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND u.enabled=1 AND u.company_id=?`)
      .get(tokenHash(token),new Date().toISOString(),config.company_id) as {id:string;username:string}|undefined;
  }
  function requireUser(request:any,config:ReturnType<typeof settings>) {
    const found=user(request,config);if(!found) throw fail("سجّل الدخول لإدارة الصور",401);return found;
  }
  function images(config:ReturnType<typeof settings>,id:string,unitId:string) {
    return (db.prepare(`SELECT id FROM product_images WHERE company_id=? AND source_identity=? AND product_id=? AND unit_id=? AND deleted_at IS NULL ORDER BY created_at,id`)
      .all(config.company_id,config.identity,id,unitId) as {id:string}[]).map(r=>({id:r.id,url:`/api/images/${r.id}`}));
  }
  async function product(config:ReturnType<typeof settings>,id:string,unitId:string) {
    try { return await reader.get(config.company_id,id,unitId); }
    catch { throw fail("تعذر قراءة بيانات الصنف؛ حاول مجددًا أو تواصل مع المسؤول",503); }
  }
  app.addHook("onRequest",async(request,reply)=>{
    reply.header("X-Content-Type-Options","nosniff").header("X-Frame-Options","DENY")
      .header("Referrer-Policy","same-origin")
      .header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const configured=db.prepare("SELECT origin FROM portal_settings WHERE id=1").get() as {origin:string};
    const local=isLocalOrLanHost(request.hostname);
    if(!local && (!configured.origin || request.hostname!==new URL(configured.origin).hostname))
      throw fail("عنوان غير مسموح",403);
    if(request.url.startsWith("/api/")) {
      reply.header("Cache-Control","no-store");
      // The listener is loopback-only. Cloudflare overwrites this header at its edge.
      const cf=request.headers["cf-connecting-ip"];
      const ip=!local && typeof cf==="string"?cf:request.ip;
      limit(`all:${ip}`, local ? 3000 : 600);
      if(!["GET","HEAD"].includes(request.method)) {
        if(request.headers["x-emoji-request"]!=="1") throw fail("طلب غير صالح",403);
        const expected=local?`http://${request.headers.host}`:configured.origin;
        if(request.headers.origin!==expected) throw fail("مصدر الطلب غير مسموح",403);
        limit(`write:${ip}`, local ? 120 : 60);
      }
      if(request.url.split('?')[0]==="/api/login") limit(`login:${ip}`, local ? 60 : 30, local ? 60000 : 120000);
      if(request.url.startsWith("/api/products") || request.url.startsWith("/api/suggestions")) limit(`search:${ip}`, local ? 1200 : 300);
    }
  });
  app.setErrorHandler((error:any,request,reply)=>{
    if(error instanceof ZodError) {
      if(request.url?.startsWith("/api/login")) return reply.code(400).send({error:"يرجى إدخال اسم المستخدم وكلمة المرور"});
      return reply.code(400).send({error:"يرجى مراجعة البيانات المدخلة وكود الموديل"});
    }
    if(error.code==="FST_REQ_FILE_TOO_LARGE" || error.statusCode===413) return reply.code(413).send({error:"الحد الأقصى للصورة 5 ميجابايت"});
    const status=error.statusCode??500;
    if(status===429) reply.header("Retry-After","60");
    return reply.code(status).send({error:status<500 || status===503?error.message:"تعذر إتمام العملية؛ حاول مجددًا"});
  });
  app.get("/api/session",async request=>{
    const config=settings(),current=user(request,config);
    return {authenticated:Boolean(current),username:current?.username??null};
  });
  app.post("/api/login",async(request,reply)=>{
    const config=settings(),input=loginCredentials.parse(request.body);
    const account=input.username?db.prepare("SELECT id,password_hash FROM photo_users WHERE company_id=? AND username=? AND enabled=1").get(config.company_id,input.username) as any:null;
    // Run the password derivation even when the username does not exist.
    const dummy="00000000000000000000000000000000:"+"00".repeat(64);
    if(!account || !input.password || !verifyPassword(input.password,account.password_hash??dummy)) throw fail("اسم المستخدم أو كلمة المرور غير صحيحة",401);
    const token=randomBytes(32).toString("hex");
    db.prepare("DELETE FROM photo_sessions WHERE expires_at<=?").run(new Date().toISOString());
    db.prepare("INSERT INTO photo_sessions VALUES(?,?,?)").run(tokenHash(token),account.id,new Date(Date.now()+8*3600000).toISOString());
    reply.setCookie(cookieName,token,{path:"/",httpOnly:true,sameSite:"strict",secure:!isLocalOrLanHost(request.hostname),maxAge:8*3600});
    return {ok:true};
  });
  app.post("/api/logout",async(request,reply)=>{
    if(request.cookies[cookieName]) db.prepare("DELETE FROM photo_sessions WHERE token_hash=?").run(tokenHash(request.cookies[cookieName]!));
    reply.clearCookie(cookieName,{path:"/"});return {ok:true};
  });
  async function decodeBarcodeFromBuffer(buffer: Buffer): Promise<string | null> {
    const hints = new Map();
    hints.set(DecodeHintType.TRY_HARDER, true);
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.QR_CODE,
      BarcodeFormat.ITF,
    ]);

    const reader = new MultiFormatReader();
    reader.setHints(hints);

    for (const rotate of [0, 90, 270, 180]) {
      for (const maxDim of [1200, 1800]) {
        try {
          const pipeline = sharp(buffer).rotate();
          if (rotate !== 0) pipeline.rotate(rotate);
          pipeline.resize(maxDim, maxDim, { fit: "inside", withoutEnlargement: true });

          const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          const len = info.width * info.height;
          const luminances = new Uint8ClampedArray(len);
          for (let i = 0; i < len; i++) {
            luminances[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
          }
          const source = new RGBLuminanceSource(luminances, info.width, info.height);

          try {
            const res = reader.decode(new BinaryBitmap(new HybridBinarizer(source)));
            if (res?.getText()) return res.getText();
          } catch {}

          try {
            const res = reader.decode(new BinaryBitmap(new GlobalHistogramBinarizer(source)));
            if (res?.getText()) return res.getText();
          } catch {}
        } catch {}
      }
    }
    return null;
  }

  app.post("/api/decode-barcode", async (request) => {
    const file = await request.file();
    if (!file) throw fail("اختر صورة للباركود أولًا", 400);
    const buffer = await file.toBuffer();
    const raw = await decodeBarcodeFromBuffer(buffer);
    if (!raw) throw fail("لم يتم التعرف على باركود واضح في الصورة؛ تأكد من وضوح الخطوط الرأسية للباركود وقرّب الكاميرا.", 422);
    const clean = raw.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    return { ok: true, raw, code: clean };
  });

  app.get("/api/products",async request=>{
    const config=settings(),{code}=lookupQuery.parse(request.query);
    let rows;
    try { rows=await reader.search(config.company_id,code); }
    catch { throw fail("تعذر الاتصال بقاعدة الأصناف؛ حاول مجددًا أو تواصل مع المسؤول",503); }
    return {products:rows.slice(0,30).map(p=>({...p,images:images(config,p.id,p.unitId)})),truncated:rows.length>30};
  });
  app.get("/api/suggestions",async request=>{
    const config=settings(),{code}=lookupQuery.parse(request.query);
    try {
      const rows=await reader.suggest(config.company_id,code);
      return {suggestions:rows.slice(0,10),truncated:rows.length>10};
    } catch { throw fail("تعذر تحميل اقتراحات الموديلات؛ حاول مجددًا",503); }
  });
  app.get("/api/products/:id/:unit",async request=>{
    const config=settings(),params=productParams.parse(request.params);
    const found=await product(config,params.id,params.unit);
    if(!found) throw fail("الصنف غير موجود",404);
    return {products:[{...found,images:images(config,found.id,found.unitId)}],truncated:false};
  });
  app.get("/api/images/:imageId",async(request,reply)=>{
    const config=settings(),{imageId}=z.object({imageId:z.uuid()}).parse(request.params);
    if(!db.prepare("SELECT 1 FROM product_images WHERE id=? AND company_id=? AND source_identity=? AND deleted_at IS NULL").get(imageId,config.company_id,config.identity)) throw fail("الصورة غير موجودة",404);
    try { return reply.type("image/webp").send(await readFile(resolve(directory,`${imageId}.webp`))); }
    catch { throw fail("الصورة غير متاحة",404); }
  });
  app.post("/api/products/:id/:unit/images",async request=>{
    const config=settings(),current=requireUser(request,config),params=productParams.parse(request.params);
    if(!await product(config,params.id,params.unit)) throw fail("الصنف غير موجود",404);
    const file=await request.file();
    if(!file || !['image/jpeg','image/png','image/webp'].includes(file.mimetype)) throw fail("اختر صورة JPEG أو PNG أو WebP");
    const buffer=await file.toBuffer();
    let normalized:Buffer;
    try {
      const image=sharp(buffer,{limitInputPixels:24000000,animated:false});
      const meta=await image.metadata();
      if(!meta.format || !['jpeg','png','webp'].includes(meta.format) || (meta.pages??1)>1) throw new Error("Invalid image");
      normalized=await image.rotate().resize({width:1600,height:1600,fit:"inside",withoutEnlargement:true}).webp({quality:85}).toBuffer();
    } catch { throw fail("الملف ليس صورة صالحة أو أبعاده أكبر من المسموح"); }
    const id=randomUUID(),path=resolve(directory,`${id}.webp`);
    await writeFile(path,normalized,{flag:"wx",mode:0o600});
    try {
      db.transaction(()=>{
        // Recheck inside the commit after all asynchronous decoding/file writes.
        const active=settings();
        if(active.company_id!==config.company_id || active.identity!==config.identity || user(request,active)?.id!==current.id)
          throw fail("انتهت صلاحية العملية؛ سجّل الدخول مجددًا",401);
        if(images(config,params.id,params.unit).length>=10) throw fail("الحد الأقصى 10 صور لكل صنف ووحدة",409);
        db.prepare("INSERT INTO product_images VALUES(?,?,?,?,?,?,?,NULL)").run(id,config.company_id,config.identity,params.id,params.unit,current.id,new Date().toISOString());
        auditPortal(db,config.company_id,"product.image.uploaded",{imageId:id,productId:params.id,unitId:params.unit,userId:current.id});
      })();
    } catch(error) { await unlink(path).catch(()=>{});throw error; }
    return {ok:true,images:images(config,params.id,params.unit)};
  });
  app.delete("/api/images/:imageId",async request=>{
    const config=settings(),current=requireUser(request,config),{imageId}=z.object({imageId:z.uuid()}).parse(request.params);
    db.transaction(()=>{
      const result=db.prepare("UPDATE product_images SET deleted_at=? WHERE id=? AND company_id=? AND source_identity=? AND deleted_at IS NULL")
        .run(new Date().toISOString(),imageId,config.company_id,config.identity);
      if(!result.changes) throw fail("الصورة غير موجودة",404);
      auditPortal(db,config.company_id,"product.image.deleted",{imageId,userId:current.id});
    })();
    // Retain immutable blobs for consistent concurrent online backups. Deleted images are not served.
    return {ok:true};
  });
  const dist=resolve(options.root,"dist/portal");
  if(existsSync(dist)) await app.register(staticFiles,{root:dist,index:false});
  app.get("/",async(_request,reply)=>existsSync(dist)?reply.sendFile("index.html"):reply.code(503).send({error:"ابنِ واجهة الاستعلام أولًا"}));
  app.get("/manage",async(_request,reply)=>existsSync(dist)?reply.sendFile("index.html"):reply.code(503).send({error:"ابنِ واجهة الاستعلام أولًا"}));
  app.setNotFoundHandler((_request,reply)=>reply.code(404).send({error:"مسار غير موجود"}));
  app.addHook("onClose",async()=>reader.close());
  return app;
}
