import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { csvCell, cairoDay } from "../../packages/domain/phone.js";
import {
  membershipLabels,
  whatsappLabels,
} from "../../packages/domain/contracts.js";
import {
  listSqlDatabases,
  readLocalSnapshot,
  readSqlSnapshot,
  sqlConfigSchema,
  sqlServerAuthSchema,
} from "../../packages/erp/source.js";
import type { Context } from "./context.js";
const settingsSchema = z.object({
  distributionMode: z.enum(["per_branch", "global"]),
  globalGroupId: z.string().regex(/^[\w\-]+@g\.us$/).nullable().optional(),
  globalNextCounter: z.number().int().min(2).max(99999).default(2),
  globalBaseName: z.string().max(85).optional(),
  globalGroupTitle: z.string().nullable().optional(),
  historicalDailyLimit: z.number().int().min(0).max(10000),
  historicalLimitScope: z.enum(["total", "per_branch"]),
  rolloverThreshold: z.number().int().min(10).max(1024),
  workStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  workEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  inviteOnPrivacy: z.boolean(),
  inviteTemplate: z.string().min(5).max(2000),
});
function company(request: FastifyRequest) {
  if (!request.companyId)
    throw Object.assign(new Error("أضف شركة أولًا"), { statusCode: 400 });
  return request.companyId;
}
const reportQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  scope: z.enum(["daily", "all"]).default("daily"),
  branch: z.coerce.number().int().positive().optional(),
  search: z.string().max(100).optional(),
  state: z
    .enum(["all", "valid", "invalid", "not_registered", "joined", "unchecked"])
    .default("all"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});
export function registerCompanyRoutes(
  app: FastifyInstance,
  { db, repo, secrets, wa, sync, root }: Context,
) {
  app.post("/api/companies", async (request) => {
    const { name } = z
      .object({ name: z.string().trim().min(2).max(100) })
      .parse(request.body);
    const id = repo.create(request.operatorId, name);
    db.prepare("UPDATE sessions SET company_id=? WHERE token_hash=?").run(
      id,
      request.sessionHash,
    );
    return { id };
  });
  app.post("/api/company/switch", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.body);
    if (
      !db
        .prepare(
          "SELECT 1 FROM company_access WHERE operator_id=? AND company_id=?",
        )
        .get(request.operatorId, id)
    )
      return reply.code(403).send({ error: "ليست لديك صلاحية لهذه الشركة" });
    db.prepare("UPDATE sessions SET company_id=? WHERE token_hash=?").run(
      id,
      request.sessionHash,
    );
    return { ok: true };
  });
  app.get("/api/company", async (request) => {
    const id = company(request);
    let row: any = db
      .prepare(
        "SELECT id,name,settings,paused,pause_until,run_mode,whatsapp_phone,whatsapp_name,logo_type IS NOT NULL has_logo FROM companies WHERE id=?",
      )
      .get(id);
    if (
      row.paused &&
      row.pause_until &&
      row.pause_until <= new Date().toISOString()
    ) {
      db.prepare(
        "UPDATE companies SET paused=0,pause_until=NULL WHERE id=?",
      ).run(id);
      row = { ...row, paused: 0, pause_until: null };
      repo.audit(id, "processing.resume_scheduled");
    }
    const source: any = db
      .prepare(
        "SELECT kind,label,baseline_complete,last_sync,last_full_sync,last_error FROM sources WHERE company_id=?",
      )
      .get(id);
    const status: any =
      wa.state.companyId === id ? wa.state : { status: "disconnected" };

    if (status.status === "ready" && status.phone) {
      db.prepare(
        "UPDATE companies SET whatsapp_phone=?, whatsapp_name=? WHERE id=?",
      ).run(status.phone, status.pushname || null, id);
      row.whatsapp_phone = status.phone;
      row.whatsapp_name = status.pushname || null;
    }

    return {
      ...row,
      settings: JSON.parse(row.settings),
      source: source ?? null,
      whatsapp: {
        ...status,
        phone: status.phone || row.whatsapp_phone || null,
        pushname: status.pushname || row.whatsapp_name || null,
      },
      runMode: row.run_mode || "preview",
      today: cairoDay(),
    };
  });
  app.put("/api/company", async (request) => {
    const id = company(request);
    const { name } = z
      .object({ name: z.string().trim().min(2).max(100) })
      .parse(request.body);
    db.prepare("UPDATE companies SET name=? WHERE id=?").run(name, id);
    repo.audit(id, "company.renamed");
    return { ok: true };
  });
  app.post("/api/company/logo", async (request, reply) => {
    const id = company(request),
      file = await request.file();
    if (!file)
      return reply.code(400).send({ error: "اختر صورة PNG أو JPEG أو WebP" });
    const buffer = await file.toBuffer();
    let mime = "";
    if (
      buffer
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      mime = "image/png";
    else if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
      mime = "image/jpeg";
    else if (
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    )
      mime = "image/webp";
    if (!mime)
      return reply
        .code(400)
        .send({ error: "نوع الصورة غير مدعوم؛ استخدم PNG أو JPEG أو WebP." });
    db.prepare("UPDATE companies SET logo=?,logo_type=? WHERE id=?").run(
      buffer,
      mime,
      id,
    );
    repo.audit(id, "company.logo_updated");
    return { ok: true };
  });
  app.get("/api/company/logo", async (request, reply) => {
    const row: any = db
      .prepare("SELECT logo,logo_type FROM companies WHERE id=?")
      .get(company(request));
    if (!row?.logo) return reply.code(404).send();
    return reply
      .header("Cache-Control", "private, no-store")
      .type(row.logo_type)
      .send(row.logo);
  });
  app.put("/api/settings", async (request) => {
    const id = company(request),
      settings = settingsSchema.parse(request.body);
    const priorSettings = repo.settings(id);
    if (settings.globalGroupId !== priorSettings.globalGroupId) {
      settings.globalBaseName = settings.globalGroupTitle || undefined;
      settings.globalNextCounter = 2;
    }
    db.prepare("UPDATE companies SET settings=? WHERE id=?").run(
      JSON.stringify(settings),
      id,
    );
    repo.audit(id, "settings.updated", settings);
    return { ok: true };
  });
  app.post("/api/processing", async (request) => {
    const id = company(request),
      input = z
        .object({
          paused: z.boolean(),
          until: z.string().datetime().nullable().optional(),
          mode: z.enum(["preview", "live"]).optional(),
        })
        .parse(request.body);

    if (input.until && Date.parse(input.until) <= Date.now())
      throw Object.assign(new Error("اختار وقتًا في المستقبل"), {
        statusCode: 400,
      });

    const targetRunMode = input.mode;

    db.prepare(`
      UPDATE companies 
      SET paused=?,
          pause_until=?,
          run_mode = COALESCE(?, run_mode) 
      WHERE id=?
    `).run(
      input.paused ? 1 : 0,
      input.paused ? (input.until ?? null) : null,
      targetRunMode ?? null,
      id,
    );

    const updated: any = db
      .prepare("SELECT run_mode FROM companies WHERE id=?")
      .get(id);

    repo.audit(id, input.paused ? "processing.paused" : "processing.resumed", {
      until: input.until ?? null,
      mode: updated.run_mode,
    });

    return { ok: true, runMode: updated.run_mode };
  });
  app.get("/api/branches", async (request) =>
    db
      .prepare(
        `SELECT b.*,COUNT(c.person_id) customers,COALESCE(SUM(c.phone_state='valid'),0) valid FROM branches b LEFT JOIN customers c ON c.company_id=b.company_id AND c.program_id=b.program_id AND c.branch_id=b.branch_id WHERE b.company_id=? GROUP BY b.company_id,b.program_id,b.branch_id ORDER BY b.branch_id`,
      )
      .all(company(request)),
  );
  app.put("/api/branches", async (request) => {
    const id = company(request),
      input = z
        .array(
          z.object({
            programId: z.number().int(),
            branchId: z.number().int(),
            enabled: z.boolean(),
            groupId: z
              .string()
              .regex(/^[\w\-]+@g\.us$/)
              .nullable(),
            groupTitle: z.string().max(200).nullable().optional(),
            baseName: z.string().max(85),
            nextCounter: z.number().int().min(2).max(99999),
          }),
        )
        .max(1000)
        .parse(request.body);

    db.transaction(() => {
      for (const b of input) {
        db.prepare(
          "UPDATE branches SET enabled=?,group_id=?,group_title=?,base_name=?,next_counter=? WHERE company_id=? AND program_id=? AND branch_id=?",
        ).run(
          b.enabled ? 1 : 0,
          b.groupId,
          b.groupTitle ?? null,
          b.baseName,
          b.nextCounter,
          id,
          b.programId,
          b.branchId,
        );

      }
      repo.audit(id, "branches.updated", { count: input.length });
    })();
    return { ok: true };
  });
  app.post("/api/source/snapshot", async (request, reply) => {
    if (process.env.NODE_ENV === "production") return reply.code(404).send({ error: "مسار غير موجود" });
    return sync.run(company(request),{local:true});
  });
  app.post("/api/source/sql/databases", async (request) => {
    company(request);
    const config = sqlServerAuthSchema.parse(request.body);
    const databases = await listSqlDatabases(config);
    return { databases };
  });
  app.post("/api/source/sql", async (request) => {
    return sync.run(company(request),{config:sqlConfigSchema.parse(request.body)});
  });
  app.post("/api/source/sync", async (request) => {
    const {full} = z.object({full:z.boolean().optional()}).parse(request.body ?? {});
    return sync.run(company(request),{full});
  });

  app.get("/api/overview", async (request) => {
    const id = company(request);
    const all = repo.report(id, { baseline: true, limit: 0 }).totals;
    const daily = repo.report(id, {
      baseline: false,
      day: cairoDay(),
      limit: 0,
    }).totals;
    const branches = db
      .prepare(
        `SELECT b.branch_id,b.name,b.enabled,COUNT(c.person_id) total,COALESCE(SUM(c.phone_state='valid'),0) valid FROM branches b LEFT JOIN customers c ON c.company_id=b.company_id AND c.program_id=b.program_id AND c.branch_id=b.branch_id WHERE b.company_id=? GROUP BY b.company_id,b.program_id,b.branch_id ORDER BY total DESC`,
      )
      .all(id);
    const events = db
      .prepare(
        "SELECT event,created_at,details FROM audit_events WHERE company_id=? ORDER BY id DESC LIMIT 8",
      )
      .all(id);
    return {
      all,
      daily,
      branches,
      events,
      reportBasis: "first_detected",
      sourceTimestampAvailable: false,
    };
  });
  app.get("/api/customers", async (request) => {
    const q = reportQuery.parse(request.query);
    return {
      ...repo.report(company(request), {
        day: q.date ?? cairoDay(),
        baseline: q.scope === "all",
        branch: q.branch,
        search: q.search,
        state: q.state,
        limit: 50,
        offset: (q.page - 1) * 50,
      }),
      page: q.page,
      pageSize: 50,
      reportBasis: "first_detected",
    };
  });
  app.get("/api/reports.csv", async (request, reply) => {
    const q = reportQuery.parse(request.query);
    const result = repo.report(company(request), {
      day: q.date ?? cairoDay(),
      baseline: q.scope === "all",
      branch: q.branch,
      search: q.search,
      state: q.state,
      limit: 100000,
    });
    const lines = [
      [
        "الفرع",
        "العميل",
        "الرقم المسجل",
        "الرقم الدولي",
        "صلاحية الرقم",
        "سبب التصنيف",
        "حالة واتساب",
        "آخر فحص واتساب",
        "حالة الانضمام",
        "أول اكتشاف",
        "تاريخ تسجيل ERP",
        "نوع السجل",
      ],
    ];
    for (const row of result.rows as any[])
      lines.push([
        row.branch_name,
        row.name,
        row.raw_phone,
        row.phone,
        row.phone_state,
        row.phone_reason,
        whatsappLabels[row.whatsapp_state] ?? row.whatsapp_state,
        row.whatsapp_checked_at ?? "",
        membershipLabels[row.membership_state] ?? row.membership_state,
        row.first_seen,
        "غير متاح",
        row.is_baseline ? "موجود في أول مزامنة" : "مكتشف لاحقًا",
      ]);
    repo.audit(company(request), "report.exported", {
      scope: q.scope,
      date: q.date ?? cairoDay(),
      rows: result.rows.length,
    });
    return reply
      .header(
        "Content-Disposition",
        `attachment; filename="customers-${q.date ?? cairoDay()}.csv"`,
      )
      .type("text/csv; charset=utf-8")
      .send(
        "\uFEFF" + lines.map((row) => row.map(csvCell).join(",")).join("\r\n"),
      );
  });
  app.post("/api/whatsapp/connect", async (request) =>
    wa.call(company(request), "connect"),
  );
  app.post("/api/whatsapp/disconnect", async (request) =>
    wa.call(company(request), "disconnect"),
  );
  app.get("/api/whatsapp/groups", async (request) =>
    wa.call(company(request), "groups"),
  );
  app.post("/api/customers/check", async (request) => {
    const id = company(request),
      input = z
        .object({
          programId: z.number().int(),
          branchId: z.number().int(),
          personId: z.number().int(),
        })
        .parse(request.body);
    const row: any = db
      .prepare(
        "SELECT phone,phone_state,membership_state FROM customers WHERE company_id=? AND program_id=? AND branch_id=? AND person_id=?",
      )
      .get(id, input.programId, input.branchId, input.personId);
    if (!row || row.phone_state !== "valid")
      throw Object.assign(new Error("الرقم غير صالح للفحص"), {
        statusCode: 400,
      });
    const result = await wa.call(id, "lookup", { phone: row.phone });
    const state = result.registered ? "registered" : "not_registered";
    db.prepare(
      "UPDATE customers SET whatsapp_state=?,whatsapp_checked_at=? WHERE company_id=? AND phone=?",
    ).run(state, new Date().toISOString(), id, row.phone);
    // Reconcile prior uncertain/accepted writes by reading membership; this never sends or adds.
    if (["pending", "review", "invitation_sent"].includes(row.membership_state)) {
      const prior = db.prepare("SELECT dedup_key,payload FROM operations WHERE company_id=? AND kind='add' AND json_extract(payload,'$.phone')=? ORDER BY updated_at DESC LIMIT 1")
        .get(id,row.phone) as {dedup_key:string;payload:string}|undefined;
      if (prior) {
        const {groupId} = JSON.parse(prior.payload);
        const membership = await wa.call(id,"get_membership",{groupId,phone:row.phone});
        if (membership.status === "already_member") db.transaction(() => {
          db.prepare("UPDATE operations SET status='completed',result=?,updated_at=? WHERE company_id=? AND kind='add' AND dedup_key=?")
            .run(JSON.stringify({status:"already_member"}),new Date().toISOString(),id,prior.dedup_key);
          repo.updateCustomerMembership(id,input.programId,input.branchId,input.personId,
            {membership_state:"joined",whatsapp_state:"registered",expected_phone:row.phone});
        })();
      }
    }
    repo.audit(id, "phone.checked", { state });
    return { state };
  });
}
