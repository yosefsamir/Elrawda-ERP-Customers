/** Explicit read-only export for local UI evaluation. Config stays outside source control. */
import sql from "mssql";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { mapReportCatalog, reportCatalogSql } from "../packages/erp/report-catalog.js";
const configSchema = z.object({
  server: z.string().min(1), database: z.string().min(1), user: z.string().min(1), password: z.string().min(1),
  port: z.number().int().positive().optional(), instance: z.string().optional(),
  encrypt: z.boolean(), trustServerCertificate: z.boolean(), programId: z.number().int().positive(),
});
const [configPath, outputPath, label] = process.argv.slice(2);
if (!configPath || !outputPath || !label) throw new Error("Usage: tsx scripts/export-report-filter.ts <private-config.json> <output.json> <source-label>");
const config = configSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
const pool = new sql.ConnectionPool({
  server: config.server, database: config.database, user: config.user, password: config.password, port: config.port,
  options: { instanceName: config.instance || undefined, encrypt: config.encrypt, trustServerCertificate: config.trustServerCertificate, appName: "Report filter definitions export" },
  pool: { min: 0, max: 1 }, connectionTimeout: 5000, requestTimeout: 30000,
});
try {
  await pool.connect();
  const result = await pool.request().input("program", sql.Int, config.programId).query(reportCatalogSql);
  const sets = result.recordsets as sql.IRecordSet<Record<string, unknown>>[];
  const catalog = mapReportCatalog(sets[0], sets[1]);
  await writeFile(outputPath, JSON.stringify({ ...catalog, source: { label, readAt: new Date().toISOString() } }), { mode: 0o600 });
  console.log(`Exported ${catalog.nodes.length} nodes and ${catalog.locations.length} branches`);
} finally { await pool.close(); }
