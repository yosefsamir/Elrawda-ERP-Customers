import sql from "mssql";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { mapReportCatalog, reportCatalogSql } from "../../../packages/erp/report-catalog.js";
import type { InventorySnapshot } from "../../../packages/erp/inventory-performance.js";

export const reportSqlConfigSchema = z.object({
  server: z.string().min(1).max(200),
  port: z.number().int().positive().optional(),
  instance: z.string().max(100).default(""),
  database: z.string().min(1).max(150),
  user: z.string().min(1).max(150),
  password: z.string().min(1).max(500),
  encrypt: z.boolean().default(true),
  trustServerCertificate: z.boolean().default(true),
  programId: z.number().int().positive().default(9),
});

export type ReportSqlConfig = z.infer<typeof reportSqlConfigSchema>;

export async function readReportSqlConfig(configPath: string): Promise<ReportSqlConfig> {
  const raw = await readFile(configPath, "utf8");
  return reportSqlConfigSchema.parse(JSON.parse(raw));
}

function createPool(config: ReportSqlConfig, appName: string) {
  return new sql.ConnectionPool({
    server: config.server,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeout: 8000,
    requestTimeout: 60000,
    pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
    options: {
      instanceName: config.instance || undefined,
      encrypt: config.encrypt,
      trustServerCertificate: config.trustServerCertificate ?? true,
      appName,
    },
  });
}

export async function loadReportCatalogFromSql(config: ReportSqlConfig) {
  const pool = createPool(config, "Reports Catalog Read Only");
  try {
    await pool.connect();
    const result = await pool.request().input("program", sql.Int, config.programId).query(reportCatalogSql);
    const sets = result.recordsets as sql.IRecordSet<Record<string, unknown>>[];
    const catalog = mapReportCatalog(sets[0], sets[1]);
    return {
      ...catalog,
      source: {
        label: `ERP SQL (${config.database})`,
        readAt: new Date().toISOString(),
      },
    };
  } finally {
    await pool.close();
  }
}

export async function loadInventoryFromSql(
  config: ReportSqlConfig,
  root: string,
  untilDateExclusive: string,
): Promise<InventorySnapshot> {
  const yyyymmdd = untilDateExclusive.replace(/-/g, "");
  if (!/^\d{8}$/.test(yyyymmdd)) throw new Error("Invalid until date");

  const sqlPath = resolve(root, "scripts/inspect_inventory_reports.sql");
  const inspectSqlText = await readFile(sqlPath, "utf8");
  const batch = inspectSqlText.replace(
    /DECLARE\s+@program\s+bigint=\d+,\s*@until\s+datetime='\d{8}';/i,
    `DECLARE @program bigint=${config.programId}, @until datetime='${yyyymmdd}';`,
  );

  const pool = createPool(config, "Reports Inventory Read Only");
  try {
    await pool.connect();
    const result = await pool.request().query(batch);
    const recordsets = result.recordsets as unknown as InventorySnapshot["recordsets"];
    if (!Array.isArray(recordsets) || recordsets.length < 6) {
      throw new Error("Unexpected SQL recordsets returned for inventory report");
    }
    return {
      source: `ERP SQL (${config.database})`,
      checkedAt: new Date().toISOString(),
      recordsets,
    };
  } finally {
    await pool.close();
  }
}
