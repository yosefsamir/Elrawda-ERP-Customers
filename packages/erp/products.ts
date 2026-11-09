import sql from "mssql";
import { createHash } from "node:crypto";
import { sqlConfigSchema } from "./source.js";
import type { AppDatabase } from "../storage/database.js";
import type { localSecretStore } from "../../apps/server/security.js";

export type Product = {
  id: string; unitId: string; code: string; name: string;
  category: string; description: string; unit: string; price: number | null;
};
export type ProductReader = {
  search(companyId: string, code: string): Promise<Product[]>;
  suggest(companyId: string, code: string): Promise<Product[]>;
  get(companyId: string, id: string, unitId: string): Promise<Product | undefined>;
  close(): Promise<void>;
};
// Treat SQL LIKE metacharacters as literal characters from the entered code.
export const productCodePattern = (code: string) => `%${code.replace(/[\\%_\[]/g, c => `\\${c}`)}%`;
export const productSelect = `SELECT TOP (31)
  CONVERT(varchar(30),d.iddet) id, CONVERT(varchar(30),u.idunit) unitId,
  LTRIM(RTRIM(f.ffarz)) code, n.fname name, c.fcolor category,
  s.fsize description, u.funit unit, u.fpr_r1 price
 FROM dbo.maindet d
 JOIN dbo.mainfarz f ON f.idfarz=d.idfarz
 JOIN dbo.mainsize s ON s.idsize=f.idsize
 JOIN dbo.maincolor c ON c.idcolor=s.idcolor
 JOIN dbo.main n ON n.idname=c.idname
 JOIN dbo.mainunits u ON u.iddet=d.iddet
 WHERE 1=1`;
// Do not infer publication rules from fvis: the confirmed, sold product Z3330
// has maindet.fvis=0 in the supplied ERP copy.

export function createProductReader(db: AppDatabase, secrets: ReturnType<typeof localSecretStore>): ProductReader {
  // One pool per configured source, shared by simultaneous requests; no credentials reach clients.
  const pools = new Map<string, { fingerprint: string; ready: Promise<sql.ConnectionPool> }>();
  async function pool(companyId?: string) {
    let targetId = companyId;
    let source = targetId ? db.prepare("SELECT kind,config FROM sources WHERE company_id=?").get(targetId) as any : null;
    if (!source?.config) {
      const single = db.prepare("SELECT id FROM companies LIMIT 1").get() as any;
      if (single?.id) {
        targetId = single.id;
        source = db.prepare("SELECT kind,config FROM sources WHERE company_id=?").get(targetId) as any;
      }
    }
    if (source?.kind !== "sql" || !source.config) throw new Error("ERP_UNAVAILABLE");
    const fingerprint = createHash("sha256").update(source.config).digest("hex");
    const prior = pools.get(targetId!);
    if (prior?.fingerprint === fingerprint) return prior.ready;
    if (prior) void prior.ready.then(p => p.close()).catch(() => {});
    const config = sqlConfigSchema.parse(secrets.decrypt(source.config));
    const connection = new sql.ConnectionPool({
      server: config.server, database: config.database, user: config.user, password: config.password,
      connectionTimeout: 8000, requestTimeout: 10000,
      pool: { min: 0, max: 2, idleTimeoutMillis: 30000 },
      options: { instanceName: config.instance || undefined, encrypt: config.encrypt,
        trustServerCertificate: config.trustServerCertificate, appName: "EMOJI Product Lookup Read Only" },
    });
    connection.on("error", () => { if (pools.get(targetId!)?.fingerprint === fingerprint) pools.delete(targetId!); void connection.close().catch(() => {}); });
    const ready = connection.connect();
    pools.set(targetId!, { fingerprint, ready });
    try { return await ready; }
    catch (error) { if (pools.get(targetId!)?.ready === ready) pools.delete(targetId!); await connection.close().catch(() => {}); throw error; }
  }
  const map = (r: any): Product => ({
    id: String(r.id), unitId: String(r.unitId), code: r.code?.trim() || "",
    name: r.name?.trim() || "صنف", category: r.category?.trim() || "",
    description: r.description?.trim() || "", unit: r.unit?.trim() || "",
    price: Number.isFinite(Number(r.price)) && Number(r.price) > 0 ? Number(r.price) : null,
  });
  return {
    async search(companyId, code) {
      const connection = await pool(companyId);
      const cleanCode = code.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
      const numeric = /^[0-9]{1,18}$/.test(cleanCode) ? cleanCode.replace(/^0+(?=\d)/, "") : (/^[0-9]{1,18}$/.test(code) ? code.replace(/^0+(?=\d)/, "") : null);
      const effectiveCode = cleanCode || code;
      const result = await connection.request().input("code", sql.VarChar(100), effectiveCode)
        .input("pattern", sql.VarChar(202), productCodePattern(effectiveCode))
        .input("numeric", sql.VarChar(30), numeric)
        .query(`${productSelect} AND (f.ffarz LIKE @pattern ESCAPE '\\' OR d.iddet=TRY_CONVERT(bigint,@numeric))
          ORDER BY CASE WHEN d.iddet=TRY_CONVERT(bigint,@numeric) THEN 0 WHEN f.ffarz=@code THEN 1 ELSE 2 END,f.ffarz,d.iddet,u.idunit`);
      return result.recordset.map(map);
    },
    async suggest(companyId, code) {
      const connection = await pool(companyId);
      const cleanCode = code.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
      const effectiveCode = cleanCode || code;
      const result = await connection.request().input("code", sql.VarChar(100), effectiveCode)
        .input("pattern", sql.VarChar(202), productCodePattern(effectiveCode))
        .query(`${productSelect.replace('TOP (31)', 'TOP (11)')} AND f.ffarz LIKE @pattern ESCAPE '\\'
          ORDER BY CASE WHEN f.ffarz=@code THEN 0 ELSE 1 END,f.ffarz,d.iddet,u.idunit`);
      return result.recordset.map(map);
    },
    async get(companyId, id, unitId) {
      const connection = await pool(companyId);
      const result = await connection.request().input("id", sql.VarChar(30), id).input("unit", sql.VarChar(30), unitId)
        .query(`${productSelect} AND d.iddet=TRY_CONVERT(bigint,@id) AND u.idunit=TRY_CONVERT(bigint,@unit) ORDER BY d.iddet,u.idunit`);
      return result.recordset[0] ? map(result.recordset[0]) : undefined;
    },
    async close() { await Promise.allSettled([...pools.values()].map(async p => (await p.ready).close())); pools.clear(); },
  };
}
