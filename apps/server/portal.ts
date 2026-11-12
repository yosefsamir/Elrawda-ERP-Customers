import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp, { type OutputInfo, type Sharp } from "sharp";
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
import { auditPortal } from "./portal-admin.js";
import {
  buildImagePromptForProduct,
  getConfiguredImagePrompt,
  getImageProcessingConfig,
  isImageProcessingEnabled,
} from "./image-processing/config.js";
import { saveProductImageBlob, validateAndNormalizeImage } from "./image-processing/storage.js";
import { enqueueImageProcessingJob, getImageProcessingStatusSummary, recordUnprocessedImageState } from "./image-processing/worker.js";
const productParams=z.object({id:z.string().regex(/^\d{1,18}$/),unit:z.string().regex(/^\d{1,18}$/)});
const lookupQuery=z.object({code:z.string().trim().min(1).max(100).transform(v=>v.replace(/\s+/g," ")).refine(v=>/^[A-Za-z0-9 _-]+$/.test(v)&&/[A-Za-z0-9]/.test(v))});
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
export async function createPortal(options:{db:AppDatabase;dataDir:string;root:string;reader?:ProductReader;logger?:boolean;onJobQueued?:()=>void}) {
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
  function images(config:ReturnType<typeof settings>,id:string,unitId:string,includeDetails=false) {
    const rows = db.prepare(`
      SELECT pi.id, s.original_image_id, s.processed_image_id, s.active_job_id,
             j.status AS job_status, j.error_code, j.error_message, j.updated_at AS job_updated_at
      FROM product_images pi
      LEFT JOIN product_image_state s ON s.product_image_id = pi.id
      LEFT JOIN image_processing_jobs j ON j.id = s.active_job_id
      WHERE pi.company_id=? AND pi.source_identity=? AND pi.product_id=? AND pi.unit_id=? AND pi.deleted_at IS NULL
      ORDER BY pi.created_at, pi.id
    `).all(config.company_id, config.identity, id, unitId) as Array<{
      id: string;
      original_image_id: string | null;
      processed_image_id: string | null;
      active_job_id: string | null;
      job_status: "pending" | "processing" | "completed" | "failed" | null;
      error_code: string | null;
      error_message: string | null;
      job_updated_at: string | null;
    }>;
    return rows.map(r => {
      const status = r.job_status ?? (r.processed_image_id || !r.active_job_id ? "completed" : "pending");
      const version = r.processed_image_id ?? (r.original_image_id && r.original_image_id !== r.id ? r.original_image_id : null);
      const url = version ? `/api/images/${r.id}?v=${version}` : `/api/images/${r.id}`;
      if (!includeDetails) return { id: r.id, url, status };
      return {
        id: r.id,
        url,
        status,
        jobId: r.active_job_id,
        errorCode: status === "failed" ? r.error_code : null,
        error: status === "failed" ? r.error_message : null,
        updatedAt: r.job_updated_at,
      };
    });
  }
  async function parseUploadedImage(request: any) {
    const file = await request.file();
    if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      throw fail("اختر صورة JPEG أو PNG أو WebP");
    }
    const buffer = await file.toBuffer();
    try {
      return await validateAndNormalizeImage(buffer);
    } catch {
      throw fail("الملف ليس صورة صالحة أو أبعاده أكبر من المسموح");
    }
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
      BarcodeFormat.CODE_93,
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

    let base: { data: Buffer; info: OutputInfo };
    try {
      // Normalize EXIF orientation once upfront so crop coordinates and explicit
      // manual rotations always run against upright sensor pixels.
      base = await sharp(buffer).rotate().raw().toBuffer({ resolveWithObject: true });
    } catch {
      return null;
    }

    const { width: w, height: h, channels } = base.info;
    if (!w || !h) return null;
    const rawInput = { raw: { width: w, height: h, channels } } as const;

    const toLuminances = (data: Buffer, info: OutputInfo): Uint8ClampedArray => {
      const len = info.width * info.height;
      if (info.channels === 1 && data.length === len) {
        return new Uint8ClampedArray(data.buffer, data.byteOffset, len);
      }
      const luminances = new Uint8ClampedArray(len);
      const stride = Math.max(1, info.channels);
      for (let i = 0; i < len; i++) {
        const offset = i * stride;
        luminances[i] = stride >= 3
          ? (data[offset] * 77 + data[offset + 1] * 150 + data[offset + 2] * 29) >> 8
          : data[offset];
      }
      return luminances;
    };

    const decodePipeline = async (pipeline: Sharp): Promise<string | null> => {
      const { data, info } = await pipeline.grayscale().raw().toBuffer({ resolveWithObject: true });
      const source = new RGBLuminanceSource(toLuminances(data, info), info.width, info.height);
      for (const Binarizer of [HybridBinarizer, GlobalHistogramBinarizer]) {
        try {
          const res = reader.decode(new BinaryBitmap(new Binarizer(source)));
          if (res?.getText()) return res.getText();
        } catch {}
      }
      return null;
    };

    const centerRegion = (rw: number, rh: number) => {
      const width = Math.max(1, Math.min(w, Math.round(w * rw)));
      const height = Math.max(1, Math.min(h, Math.round(h * rh)));
      return {
        left: Math.max(0, Math.floor((w - width) / 2)),
        top: Math.max(0, Math.floor((h - height) / 2)),
        width,
        height,
      };
    };

    type DecodeAttempt = {
      region: { left: number; top: number; width: number; height: number } | null;
      maxDim: number;
      upscaleMin?: number;
      enhance?: boolean;
      rotations: number[];
    };

    const canCrop = w >= 360 && h >= 360;
    const tight = canCrop ? centerRegion(0.55, 0.45) : null;
    const strip = canCrop ? centerRegion(0.75, 0.34) : null;
    const wide = canCrop ? centerRegion(0.8, 0.65) : null;

    const attempts: DecodeAttempt[] = [
      ...(tight
        ? [
            { region: tight, maxDim: 1500, upscaleMin: 1000, rotations: [0, 90] },
            { region: tight, maxDim: 1500, upscaleMin: 1000, enhance: true, rotations: [0, 90] },
          ]
        : []),
      ...(strip
        ? [
            { region: strip, maxDim: 1500, upscaleMin: 1000, rotations: [0, 90] },
            { region: strip, maxDim: 1500, upscaleMin: 1000, enhance: true, rotations: [0, 90] },
          ]
        : []),
      ...(wide ? [{ region: wide, maxDim: 1600, rotations: [0, 90] }] : []),
      { region: null, maxDim: 1400, rotations: [0, 90] },
      { region: null, maxDim: 2000, enhance: true, rotations: [0, 90] },
      ...(tight ? [{ region: tight, maxDim: 1500, enhance: true, rotations: [270, 180] }] : []),
      { region: null, maxDim: 1800, rotations: [270, 180] },
      { region: null, maxDim: 2200, enhance: true, rotations: [270, 180] },
    ];

    for (const attempt of attempts) {
      for (const rotate of attempt.rotations) {
        try {
          const pipeline = sharp(base.data, rawInput);
          if (attempt.region) pipeline.extract(attempt.region);
          if (rotate !== 0) pipeline.rotate(rotate);
          const rw = attempt.region ? attempt.region.width : w;
          const rh = attempt.region ? attempt.region.height : h;
          const longest = Math.max(rw, rh);
          if (attempt.upscaleMin && longest < attempt.upscaleMin) {
            const target = Math.min(attempt.maxDim, Math.max(attempt.upscaleMin, longest * 2));
            pipeline.resize(target, target, { fit: "inside", withoutEnlargement: false, kernel: sharp.kernel.cubic });
          } else {
            pipeline.resize(attempt.maxDim, attempt.maxDim, { fit: "inside", withoutEnlargement: true });
          }
          if (attempt.enhance) {
            pipeline.normalise().sharpen({ sigma: 1 });
          }
          const found = await decodePipeline(pipeline);
          if (found) return found;
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
    const authenticated=Boolean(user(request,config));
    let rows;
    try { rows=await reader.search(config.company_id,code); }
    catch { throw fail("تعذر الاتصال بقاعدة الأصناف؛ حاول مجددًا أو تواصل مع المسؤول",503); }
    return {products:rows.slice(0,30).map(p=>({...p,images:images(config,p.id,p.unitId,authenticated)})),truncated:rows.length>30};
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
    const authenticated=Boolean(user(request,config));
    const found=await product(config,params.id,params.unit);
    if(!found) throw fail("الصنف غير موجود",404);
    return {products:[{...found,images:images(config,found.id,found.unitId,authenticated)}],truncated:false};
  });
  app.get("/api/images/:imageId",async(request,reply)=>{
    const config=settings(),{imageId}=z.object({imageId:z.uuid()}).parse(request.params);
    const row=db.prepare(
      `SELECT pi.id, s.original_image_id, s.processed_image_id
       FROM product_images pi
       LEFT JOIN product_image_state s ON s.product_image_id = pi.id
       WHERE pi.id=? AND pi.company_id=? AND pi.source_identity=? AND pi.deleted_at IS NULL`
    ).get(imageId,config.company_id,config.identity) as {id:string;original_image_id:string|null;processed_image_id:string|null}|undefined;
    if(!row) throw fail("الصورة غير موجودة",404);
    const blobId=row.processed_image_id || row.original_image_id || row.id;
    try { return reply.type("image/webp").send(await readFile(resolve(directory,`${blobId}.webp`))); }
    catch { throw fail("الصورة غير متاحة",404); }
  });
  app.post("/api/products/:id/:unit/images",async request=>{
    const config=settings(),current=requireUser(request,config),params=productParams.parse(request.params);
    const item=await product(config,params.id,params.unit);
    if(!item) throw fail("الصنف غير موجود",404);
    const normalized=await parseUploadedImage(request);
    const saved=await saveProductImageBlob(options.dataDir,normalized.buffer);
    const imageCfg=getImageProcessingConfig({db,dataDir:options.dataDir,root:options.root});
    const prompt=buildImagePromptForProduct(getConfiguredImagePrompt(db,options.dataDir,options.root),item);
    let jobId="";
    try {
      db.transaction(()=>{
        // Recheck inside the commit after all asynchronous decoding/file writes.
        const active=settings();
        if(active.company_id!==config.company_id || active.identity!==config.identity || user(request,active)?.id!==current.id)
          throw fail("انتهت صلاحية العملية؛ سجّل الدخول مجددًا",401);
        if(images(config,params.id,params.unit).length>=10) throw fail("الحد الأقصى 10 صور لكل صنف ووحدة",409);
        const now=new Date().toISOString();
        const processingEnabled=isImageProcessingEnabled(db);
        db.prepare("INSERT INTO product_images VALUES(?,?,?,?,?,?,?,NULL)").run(saved.id,config.company_id,config.identity,params.id,params.unit,current.id,now);
        if(processingEnabled){
          jobId=enqueueImageProcessingJob(db,{
            companyId:config.company_id,
            sourceIdentity:config.identity,
            productId:params.id,
            unitId:params.unit,
            productImageId:saved.id,
            userId:current.id,
            originalImageId:saved.id,
            productCode:item.code,
            prompt,
            maxRetries:imageCfg.maxRetries,
            now,
          });
        }else{
          recordUnprocessedImageState(db,saved.id,saved.id);
        }
        auditPortal(db,config.company_id,"product.image.uploaded",{imageId:saved.id,jobId:jobId||null,processingEnabled,productId:params.id,unitId:params.unit,userId:current.id});
      })();
    } catch(error) { await saved.cleanup();throw error; }
    if(jobId) options.onJobQueued?.();
    return {ok:true,jobId:jobId||null,processingEnabled:Boolean(jobId),images:images(config,params.id,params.unit,true)};
  });
  app.put("/api/images/:imageId",async request=>{
    const config=settings(),current=requireUser(request,config),{imageId}=z.object({imageId:z.uuid()}).parse(request.params);
    const normalized=await parseUploadedImage(request);
    const existingMeta=db.prepare("SELECT product_id,unit_id FROM product_images WHERE id=? AND company_id=? AND source_identity=? AND deleted_at IS NULL")
      .get(imageId,config.company_id,config.identity) as {product_id:string;unit_id:string}|undefined;
    if(!existingMeta) throw fail("الصورة غير موجودة",404);
    const item=await product(config,existingMeta.product_id,existingMeta.unit_id).catch(()=>undefined);
    const saved=await saveProductImageBlob(options.dataDir,normalized.buffer);
    const imageCfg=getImageProcessingConfig({db,dataDir:options.dataDir,root:options.root});
    const prompt=buildImagePromptForProduct(getConfiguredImagePrompt(db,options.dataDir,options.root),item);
    let productId="",unitId="",jobId="";
    try {
      db.transaction(()=>{
        const active=settings();
        if(active.company_id!==config.company_id || active.identity!==config.identity || user(request,active)?.id!==current.id)
          throw fail("انتهت صلاحية العملية؛ سجّل الدخول مجددًا",401);
        const existing=db.prepare("SELECT product_id,unit_id FROM product_images WHERE id=? AND company_id=? AND source_identity=? AND deleted_at IS NULL")
          .get(imageId,config.company_id,config.identity) as {product_id:string;unit_id:string}|undefined;
        if(!existing) throw fail("الصورة غير موجودة",404);
        productId=existing.product_id;unitId=existing.unit_id;
        const now=new Date().toISOString();
        const processingEnabled=isImageProcessingEnabled(db);
        db.prepare(`UPDATE image_processing_jobs SET status='failed',error_code='STALE_JOB_REPLACED',error_message='تم استبدال الصورة قبل إتمام المعالجة',locked_by=NULL,locked_at=NULL,updated_at=? WHERE product_image_id=? AND status IN ('pending','processing')`)
          .run(now,imageId);
        if(processingEnabled){
          jobId=enqueueImageProcessingJob(db,{
            companyId:config.company_id,
            sourceIdentity:config.identity,
            productId,
            unitId,
            productImageId:imageId,
            userId:current.id,
            originalImageId:saved.id,
            productCode:item?.code,
            prompt,
            maxRetries:imageCfg.maxRetries,
            now,
          });
        }else{
          recordUnprocessedImageState(db,imageId,saved.id);
        }
        auditPortal(db,config.company_id,"product.image.replaced",{imageId,originalImageId:saved.id,jobId:jobId||null,processingEnabled,userId:current.id});
      })();
    } catch(error) { await saved.cleanup();throw error; }
    if(jobId) options.onJobQueued?.();
    return {ok:true,jobId:jobId||null,processingEnabled:Boolean(jobId),images:images(config,productId,unitId,true)};
  });
  app.post("/api/images/:imageId/retry",async request=>{
    const config=settings(),current=requireUser(request,config),{imageId}=z.object({imageId:z.uuid()}).parse(request.params);
    if(!isImageProcessingEnabled(db)) throw fail("معالجة الصور التلقائية متوقفة حاليًا من إعدادات الإدارة",409);
    const meta=db.prepare(
      `SELECT product_id, unit_id FROM product_images WHERE id=? AND company_id=? AND source_identity=? AND deleted_at IS NULL`,
    ).get(imageId,config.company_id,config.identity) as {product_id:string;unit_id:string}|undefined;
    if(!meta) throw fail("الصورة غير موجودة",404);
    const item=await product(config,meta.product_id,meta.unit_id).catch(()=>undefined);
    const imageCfg=getImageProcessingConfig({db,dataDir:options.dataDir,root:options.root});
    const prompt=buildImagePromptForProduct(getConfiguredImagePrompt(db,options.dataDir,options.root),item);
    let productId="",unitId="",jobId="";
    db.transaction(()=>{
      const row=db.prepare(
        `SELECT pi.id, pi.product_id, pi.unit_id, s.original_image_id, j.status AS job_status
         FROM product_images pi
         LEFT JOIN product_image_state s ON s.product_image_id = pi.id
         LEFT JOIN image_processing_jobs j ON j.id = s.active_job_id
         WHERE pi.id=? AND pi.company_id=? AND pi.source_identity=? AND pi.deleted_at IS NULL`
      ).get(imageId,config.company_id,config.identity) as {id:string;product_id:string;unit_id:string;original_image_id:string|null;job_status:string|null}|undefined;
      if(!row) throw fail("الصورة غير موجودة",404);
      if(row.job_status==="pending" || row.job_status==="processing") throw fail("الصورة قيد المعالجة حاليًا",409);
      productId=row.product_id;unitId=row.unit_id;
      jobId=enqueueImageProcessingJob(db,{
        companyId:config.company_id,
        sourceIdentity:config.identity,
        productId,
        unitId,
        productImageId:row.id,
        userId:current.id,
        originalImageId:row.original_image_id || row.id,
        productCode:item?.code,
        prompt,
        maxRetries:imageCfg.maxRetries,
      });
      auditPortal(db,config.company_id,"product.image.retry",{imageId:row.id,jobId,userId:current.id});
    })();
    options.onJobQueued?.();
    return {ok:true,jobId,images:images(config,productId,unitId,true)};
  });
  app.get("/api/image-jobs/status",async request=>{
    const config=settings();
    requireUser(request,config);
    const imageCfg=getImageProcessingConfig({db,dataDir:options.dataDir,root:options.root});
    const summary=getImageProcessingStatusSummary(db,imageCfg.profileRoot,config.company_id);
    return {enabled:summary.enabled,paused:summary.paused,requiresReauth:summary.requiresReauth,pauseReason:summary.pauseReason,counts:summary.counts};
  });
  app.get("/api/image-jobs/:jobId",async request=>{
    const config=settings();
    requireUser(request,config);
    const {jobId}=z.object({jobId:z.uuid()}).parse(request.params);
    const row=db.prepare(
      `SELECT id, product_id, unit_id, product_image_id, status, retry_count, max_retries,
              error_code, error_message, result_image_id, created_at, updated_at, started_at, completed_at
       FROM image_processing_jobs
       WHERE id=? AND company_id=? AND source_identity=?`
    ).get(jobId,config.company_id,config.identity) as any;
    if(!row) throw fail("المهمة غير موجودة",404);
    return {
      id:row.id,
      productId:row.product_id,
      unitId:row.unit_id,
      productImageId:row.product_image_id,
      status:row.status,
      retryCount:row.retry_count,
      maxRetries:row.max_retries,
      errorCode:row.error_code,
      errorMessage:row.error_message,
      resultImageUrl:row.result_image_id?`/api/images/${row.product_image_id}?v=${row.result_image_id}`:null,
      createdAt:row.created_at,
      updatedAt:row.updated_at,
      startedAt:row.started_at,
      completedAt:row.completed_at,
    };
  });
  app.delete("/api/images/:imageId",async request=>{
    const config=settings(),current=requireUser(request,config),{imageId}=z.object({imageId:z.uuid()}).parse(request.params);
    db.transaction(()=>{
      const now=new Date().toISOString();
      const result=db.prepare("UPDATE product_images SET deleted_at=? WHERE id=? AND company_id=? AND source_identity=? AND deleted_at IS NULL")
        .run(now,imageId,config.company_id,config.identity);
      if(!result.changes) throw fail("الصورة غير موجودة",404);
      db.prepare("UPDATE product_image_state SET active_job_id=NULL WHERE product_image_id=?").run(imageId);
      db.prepare(`UPDATE image_processing_jobs SET status='failed',error_code='STALE_IMAGE_DELETED',error_message='تم حذف الصورة قبل إتمام المعالجة',locked_by=NULL,locked_at=NULL,updated_at=? WHERE product_image_id=? AND status IN ('pending','processing')`)
        .run(now,imageId);
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
