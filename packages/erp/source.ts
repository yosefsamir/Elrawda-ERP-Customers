import sql from "mssql";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  confirmedBranchIds,
  type SourceSnapshot,
} from "../domain/contracts.js";

/**
 * Validation schema for the SQL Server connection targeting the ERP database.
 */
export const sqlConfigSchema = z.object({
  server: z.string().min(1).max(200),
  instance: z.string().max(100).default("SQLMOHSEN"),
  database: z.string().min(1).max(150),
  user: z.string().min(1).max(150),
  password: z.string().min(1).max(500),
  encrypt: z.boolean().default(true),
  trustServerCertificate: z.boolean().default(true),
  programId: z.number().int().positive().default(9),
});
export type SqlConfig = z.infer<typeof sqlConfigSchema>;

export const sqlServerAuthSchema = z.object({
  server: z.string().min(1).max(200),
  instance: z.string().max(100).default("SQLMOHSEN"),
  user: z.string().min(1).max(150),
  password: z.string().min(1).max(500),
  encrypt: z.boolean().default(true),
  trustServerCertificate: z.boolean().default(true),
});
export type SqlServerAuthConfig = z.infer<typeof sqlServerAuthSchema>;

/**
 * Connect to SQL Server master database to discover available online user databases.
 */
export async function listSqlDatabases(
  config: SqlServerAuthConfig,
): Promise<string[]> {
  const pool = new sql.ConnectionPool({
    server: config.server,
    database: "master",
    user: config.user,
    password: config.password,
    connectionTimeout: 8000,
    requestTimeout: 15000,
    pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
    options: {
      instanceName: config.instance || undefined,
      encrypt: config.encrypt,
      trustServerCertificate: config.trustServerCertificate ?? true,
      appName: "Customer Operations Read Only",
    },
  });

  try {
    await pool.connect();
    const result = await pool.request().query(`
      SELECT name 
      FROM sys.databases 
      WHERE database_id > 4 
        AND state_desc = 'ONLINE' 
      ORDER BY name
    `);
    return result.recordset.map((row: any) => row.name);
  } finally {
    await pool.close();
  }
}

/**
 * Options for querying SQL Server:
 * - watermarks: Map of branchId to highest known person_id.
 *   Enables incremental sync (only fetch newly added customers) without scanning all rows.
 */
export type ReadSqlOptions = {
  watermarks?: Record<number, number>;
  recheckIds?: Record<number, number[]>;
};

/**
 * Read customers and branches from ERP SQL Server in strictly read-only mode.
 * Does not alter ERP tables, triggers, or schema.
 *
 * When watermarks are supplied, executes an incremental query utilizing the
 * clustered primary key index (idprogramitems, idbranch, idperson) to seek
 * only rows created after the latest known watermark for each branch.
 */
export async function readSqlSnapshot(
  config: SqlConfig,
  options?: ReadSqlOptions,
): Promise<SourceSnapshot> {
  const pool = new sql.ConnectionPool({
    server: config.server,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeout: 8000,
    requestTimeout: 15000,
    pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
    options: {
      instanceName: config.instance || undefined,
      encrypt: config.encrypt,
      trustServerCertificate: config.trustServerCertificate ?? true,
      appName: "Customer Operations Read Only",
    },
  });

  try {
    await pool.connect();

    // Helper to create parameterized request with programId
    const createRequest = () =>
      pool.request().input("program", sql.BigInt, config.programId);

    // 1. Fetch active branches
    const branchesResult = await createRequest().query(`
      SELECT 
        b.idprogramitems,
        b.idbranch,
        bm.fbranch,
        b.fvis,
        b.deleted 
      FROM dbo.branch b 
      JOIN dbo.branchmain bm ON bm.idbranch = b.idbranch 
      WHERE b.idprogramitems = @program 
        AND COALESCE(b.deleted, 0) = 0 
        AND COALESCE(bm.deleted, 0) = 0 
      ORDER BY b.idbranch
    `);

    // 2. Fetch customers (incremental if watermarks are available)
    const customerRequest = createRequest();
    let customerQuery = `
      SELECT 
        p.idprogramitems,
        p.idbranch,
        p.idperson,
        p.fperson,
        p.ftel1,
        p.ftel2,
        p.ftel3,
        p.ftel4,
        bm.fbranch 
      FROM dbo.person p 
      JOIN dbo.kindperson k 
        ON k.idprogramitems = p.idprogramitems 
       AND k.idbranch = p.idbranch 
       AND k.idkindperson = p.idkindperson 
      JOIN dbo.branch b 
        ON b.idprogramitems = p.idprogramitems 
       AND b.idbranch = p.idbranch 
      JOIN dbo.branchmain bm 
        ON bm.idbranch = p.idbranch 
      WHERE p.idprogramitems = @program 
        AND LTRIM(RTRIM(k.fkindperson)) = N'عميل' 
        AND COALESCE(p.fhid, 0) = 0 
        AND COALESCE(b.deleted, 0) = 0 
        AND COALESCE(bm.deleted, 0) = 0 
        AND b.fvis = 1 
        AND bm.fvis = 1
    `;

    const watermarkEntries = options?.watermarks
      ? Object.entries(options.watermarks)
      : [];

    if (watermarkEntries.length > 0) {
      // Build parameterized incremental conditions to prevent SQL injection
      const branchConditions: string[] = [];
      const knownBranchParams: string[] = [];

      watermarkEntries.forEach(([branchIdStr, maxPersonId], index) => {
        const branchId = Number(branchIdStr);
        const branchParam = `b_${index}`;
        const maxParam = `m_${index}`;

        // Look back by up to 5 IDs to catch records saved seconds ago while cashier was typing phone
        const safeWatermark = Math.max(0, Number(maxPersonId) - 5);

        customerRequest.input(branchParam, sql.BigInt, branchId);
        customerRequest.input(maxParam, sql.BigInt, safeWatermark);

        // Include any recently added customers for this branch that still lack a valid phone
        const pendingForBranch = options?.recheckIds?.[branchId] || [];
        if (pendingForBranch.length > 0) {
          const recheckParams: string[] = [];
          pendingForBranch.forEach((personId, pIdx) => {
            const recheckParam = `r_${index}_${pIdx}`;
            customerRequest.input(recheckParam, sql.BigInt, personId);
            recheckParams.push(`@${recheckParam}`);
          });

          branchConditions.push(
            `(p.idbranch = @${branchParam} AND (p.idperson > @${maxParam} OR p.idperson IN (${recheckParams.join(", ")})))`,
          );
        } else {
          branchConditions.push(
            `(p.idbranch = @${branchParam} AND p.idperson > @${maxParam})`,
          );
        }

        knownBranchParams.push(`@${branchParam}`);
      });

      // Also retrieve rows for any new branch that is not in the known list
      branchConditions.push(`p.idbranch NOT IN (${knownBranchParams.join(", ")})`);

      customerQuery += ` AND (${branchConditions.join(" OR ")})`;
    }

    customerQuery += ` ORDER BY p.idbranch, p.idperson`;

    const customersResult = await customerRequest.query(customerQuery);

    return {
      branches: branchesResult.recordset,
      customers: customersResult.recordset,
      label: `${config.server}${config.instance ? "\\" + config.instance : ""} / ${config.database}`,
      identity: `sql:${config.server.toLowerCase()}:${(config.instance || "").toLowerCase()}:${config.database.toLowerCase()}:${config.programId}`,
    };
  } finally {
    await pool.close();
  }
}

/**
 * Read the local test snapshot from disk (for preview/development without live SQL Server).
 */
export async function readLocalSnapshot(root: string): Promise<SourceSnapshot> {
  const folder = resolve(root, "data/database-review");
  const [customers, branches] = await Promise.all(
    ["latest-customers.json", "latest-branches.json"].map((name) =>
      readFile(resolve(folder, name), "utf8").then(JSON.parse),
    ),
  );
  return {
    customers,
    branches: branches.map((b: any) => ({
      ...b,
      fvis: Boolean(b.fvis) && confirmedBranchIds.includes(b.idbranch),
    })),
    label: "نسخة محلية — 27 أكتوبر 2026",
    identity: "local:db.rar:2026-10-27",
  };
}
