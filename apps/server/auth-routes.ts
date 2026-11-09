import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { hashPassword, tokenHash, verifyPassword } from "./security.js";
import type { Context } from "./context.js";
const credentials = z.object({
  username: z.string().trim().min(3).max(80),
  password: z.string().min(10).max(200),
});
export function registerAuth(app: FastifyInstance, context: Context) {
  const { db } = context;
  const attempts = new Map<string, { count: number; until: number }>();
  app.get("/api/session", async (request) => {
    const singleCompany = db
      .prepare(
        "SELECT id, name, logo_type IS NOT NULL has_logo FROM companies LIMIT 1",
      )
      .get() as any;
    const companies =
      singleCompany && request.operatorId ? [singleCompany] : [];
    return {
      authenticated: Boolean(request.operatorId),
      setupRequired: !db.prepare("SELECT id FROM operators LIMIT 1").get(),
      companyId: singleCompany?.id ?? null,
      companies,
    };
  });
  app.post("/api/auth/:action", async (request, reply) => {
    const { action } = request.params as { action: string };
    if (!["bootstrap", "login"].includes(action))
      return reply.code(404).send({ error: "إجراء غير موجود" });
    const input = credentials.parse(request.body),
      ip = request.ip;
    const attempt = attempts.get(ip);
    if (attempt && attempt.until > Date.now() && attempt.count >= 5)
      return reply.code(429).send({ error: "محاولات كثيرة؛ انتظر عشر دقائق." });
    let user: any;
    if (action === "bootstrap") {
      const create = db.transaction(() => {
        if (db.prepare("SELECT id FROM operators LIMIT 1").get()) return null;
        const id = randomUUID();
        db.prepare("INSERT INTO operators VALUES(?,?,?)").run(
          id,
          input.username,
          hashPassword(input.password),
        );
        return { id };
      });
      user = create();
      if (!user)
        return reply
          .code(409)
          .send({ error: "تم إعداد المسؤول بالفعل؛ استخدم تسجيل الدخول." });
    } else {
      user = db
        .prepare("SELECT * FROM operators WHERE username=?")
        .get(input.username) as any;
      if (!user || !verifyPassword(input.password, user.password_hash)) {
        const current =
          attempt?.until && attempt.until > Date.now()
            ? attempt
            : { count: 0, until: Date.now() + 600000 };
        current.count++;
        attempts.set(ip, current);
        if (attempts.size > 1000)
          for (const [key, value] of attempts)
            if (value.until < Date.now()) attempts.delete(key);
        return reply
          .code(401)
          .send({ error: "اسم المستخدم أو كلمة المرور غير صحيح." });
      }
    }
    attempts.delete(ip);
    const token = randomBytes(32).toString("hex");
    const singleCompany: any = db
      .prepare("SELECT id FROM companies LIMIT 1")
      .get();
    if (singleCompany) {
      db.prepare("INSERT OR IGNORE INTO company_access VALUES(?,?)").run(
        user.id,
        singleCompany.id,
      );
    }
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(
      tokenHash(token),
      user.id,
      new Date(Date.now() + 12 * 3600000).toISOString(),
      singleCompany?.id ?? null,
    );
    reply.setCookie("emoji_session", token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: request.protocol === "https",
      maxAge: 12 * 3600,
    });
    return { ok: true };
  });
  app.post("/api/logout", async (request, reply) => {
    db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
      request.sessionHash,
    );
    reply.clearCookie("emoji_session", { path: "/" });
    return { ok: true };
  });
}
