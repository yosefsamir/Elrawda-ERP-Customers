import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppDatabase } from "../../packages/storage/database.js";
import { hashPassword } from "./security.js";
export const photoCredentials = z.object({ username: z.string().trim().min(3).max(80), password: z.string().min(10).max(200) });
export function auditPortal(db: AppDatabase, companyId: string, event: string, details: object) {
  db.prepare("INSERT INTO audit_events(company_id,event,details,created_at) VALUES(?,?,?,?)")
    .run(companyId,event,JSON.stringify(details),new Date().toISOString());
}
export function registerPortalAdmin(app: FastifyInstance, db: AppDatabase) {
  function company(request: any): string {
    if (request.companyId) return request.companyId;
    const single = db.prepare("SELECT id FROM companies LIMIT 1").get() as { id: string } | undefined;
    if (single) return single.id;
    throw Object.assign(new Error("أضف شركة أولًا"),{statusCode:400});
  }
  app.get("/api/portal/settings", async request => {
    const id=company(request);
    const settings=db.prepare("SELECT company_id,enabled,origin FROM portal_settings WHERE id=1").get() as any;
    return { enabled: Boolean(settings?.enabled), origin:settings?.origin || "",
      selected: true,
      users:db.prepare("SELECT id,username,enabled,created_at FROM photo_users WHERE company_id=? ORDER BY created_at").all(id) };
  });
  app.put("/api/portal/settings", async request => {
    const id=company(request);
    const {enabled,origin}=z.object({enabled:z.boolean(),origin:z.union([z.literal(""),z.url().refine(v=> {
      const url=new URL(v);return url.protocol==="https:" && url.origin===v && !url.username && !url.password;
    },"استخدم أصل HTTPS بدون مسار أو شرطة في النهاية")])}).parse(request.body);
    if(enabled && !(db.prepare("SELECT 1 FROM sources WHERE company_id=? AND kind='sql' AND config IS NOT NULL").get(id)))
      throw Object.assign(new Error("اربط الشركة بقاعدة SQL أولًا"),{statusCode:400});
    db.transaction(()=>{
      db.prepare("UPDATE portal_settings SET company_id=?,enabled=?,origin=? WHERE id=1").run(id,Number(enabled),origin);
      db.prepare("DELETE FROM photo_sessions").run();
      auditPortal(db,id,"portal.settings",{operatorId:request.operatorId,enabled,origin});
    })();
    return {ok:true};
  });
  app.post("/api/portal/users",async request=>{
    const id=company(request),input=photoCredentials.parse(request.body),userId=randomUUID();
    if(db.prepare("SELECT 1 FROM photo_users WHERE username=?").get(input.username))
      throw Object.assign(new Error("اسم المستخدم مستخدم بالفعل"),{statusCode:409});
    db.transaction(()=>{
      db.prepare("INSERT INTO photo_users VALUES(?,?,?,?,1,?)").run(userId,id,input.username,hashPassword(input.password),new Date().toISOString());
      auditPortal(db,id,"portal.user.created",{userId,operatorId:request.operatorId});
    })();
    return {ok:true};
  });
  app.put("/api/portal/users/:id",async request=>{
    const id=company(request),{id:userId}=z.object({id:z.uuid()}).parse(request.params);
    const input=z.object({enabled:z.boolean(),password:z.string().min(10).max(200).optional()}).parse(request.body);
    if(!db.prepare("SELECT 1 FROM photo_users WHERE id=? AND company_id=?").get(userId,id))
      throw Object.assign(new Error("الحساب غير موجود"),{statusCode:404});
    const hash=input.password?hashPassword(input.password):null;
    db.transaction(()=>{
      db.prepare("UPDATE photo_users SET enabled=?,password_hash=COALESCE(?,password_hash) WHERE id=? AND company_id=?").run(Number(input.enabled),hash,userId,id);
      db.prepare("DELETE FROM photo_sessions WHERE user_id=?").run(userId);
      auditPortal(db,id,"portal.user.updated",{userId,enabled:input.enabled,passwordChanged:Boolean(hash),operatorId:request.operatorId});
    })();
    return {ok:true};
  });
}
