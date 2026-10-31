import sql from "mssql";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const config: sql.config = {
  server: "127.0.0.1",
  port: 1433,
  user: "sa",
  password: "Rawda@Pass2026",
  database: "master",
  options: {
    encrypt: true,
    trustServerCertificate: true,
  },
};

async function setup() {
  console.log("Connecting to local SQL Server container...");
  const pool = await sql.connect(config);

  console.log("Creating databases: ElRawda and TestERP...");
  await pool.request().batch(`
    IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = 'ElRawda')
    BEGIN
      CREATE DATABASE ElRawda;
    END;

    IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = 'TestERP')
    BEGIN
      CREATE DATABASE TestERP;
    END;
  `);

  await pool.close();

  // Connect directly to ElRawda
  const elrawdaConfig: sql.config = {
    ...config,
    database: "ElRawda",
  };
  const elrawdaPool = await sql.connect(elrawdaConfig);

  console.log("Creating tables in ElRawda...");
  await elrawdaPool.request().batch(`
    IF OBJECT_ID('dbo.person', 'U') IS NOT NULL DROP TABLE dbo.person;
    IF OBJECT_ID('dbo.kindperson', 'U') IS NOT NULL DROP TABLE dbo.kindperson;
    IF OBJECT_ID('dbo.branch', 'U') IS NOT NULL DROP TABLE dbo.branch;
    IF OBJECT_ID('dbo.branchmain', 'U') IS NOT NULL DROP TABLE dbo.branchmain;

    CREATE TABLE dbo.branchmain (
      idbranch bigint NOT NULL PRIMARY KEY,
      fbranch nvarchar(100) NOT NULL,
      fvis int NOT NULL DEFAULT 1,
      deleted int NOT NULL DEFAULT 0
    );

    CREATE TABLE dbo.branch (
      idprogramitems bigint NOT NULL,
      idbranch bigint NOT NULL,
      fvis int NOT NULL DEFAULT 1,
      deleted int NOT NULL DEFAULT 0,
      PRIMARY KEY (idprogramitems, idbranch)
    );

    CREATE TABLE dbo.kindperson (
      idprogramitems bigint NOT NULL,
      idbranch bigint NOT NULL,
      idkindperson bigint NOT NULL,
      fkindperson nvarchar(50) NOT NULL,
      PRIMARY KEY (idprogramitems, idbranch, idkindperson)
    );

    CREATE TABLE dbo.person (
      idprogramitems bigint NOT NULL,
      idbranch bigint NOT NULL,
      idperson bigint NOT NULL,
      idkindperson bigint NOT NULL,
      fperson nvarchar(150) NOT NULL,
      ftel1 nvarchar(50) NULL,
      ftel2 nvarchar(50) NULL,
      ftel3 nvarchar(50) NULL,
      ftel4 nvarchar(50) NULL,
      fhid int NOT NULL DEFAULT 0,
      fglobal int NOT NULL DEFAULT 0,
      PRIMARY KEY (idprogramitems, idbranch, idperson)
    );
  `);

  console.log("Seeding branches...");
  const branchesPath = resolve(process.cwd(), "data/database-review/latest-branches.json");
  const branches = JSON.parse(await readFile(branchesPath, "utf-8"));

  for (const b of branches) {
    const req = elrawdaPool.request();
    req.input("idbranch", sql.BigInt, b.idbranch);
    req.input("fbranch", sql.NVarChar(100), b.fbranch);
    req.input("idprogramitems", sql.BigInt, b.idprogramitems);
    await req.query(`
      INSERT INTO dbo.branchmain (idbranch, fbranch, fvis, deleted)
      VALUES (@idbranch, @fbranch, 1, 0);

      INSERT INTO dbo.branch (idprogramitems, idbranch, fvis, deleted)
      VALUES (@idprogramitems, @idbranch, 1, 0);
    `);
  }

  console.log("Seeding kindperson definitions...");
  const confirmedBranches = [39, 40, 41, 42, 45, 51, 56, 57, 60];
  for (const branchId of confirmedBranches) {
    const req = elrawdaPool.request();
    req.input("branchId", sql.BigInt, branchId);
    await req.query(`
      INSERT INTO dbo.kindperson (idprogramitems, idbranch, idkindperson, fkindperson)
      VALUES (9, @branchId, 49, N'عميل');
    `);
  }

  console.log("Seeding customers (first 500 records)...");
  const customersPath = resolve(process.cwd(), "data/database-review/latest-customers.json");
  const customers = JSON.parse(await readFile(customersPath, "utf-8")).slice(0, 500);

  // Batch insert in chunks of 50
  for (let i = 0; i < customers.length; i += 50) {
    const chunk = customers.slice(i, i + 50);
    const req = elrawdaPool.request();
    const values: string[] = [];

    chunk.forEach((c: any, idx: number) => {
      req.input(`p_${idx}`, sql.BigInt, c.idperson);
      req.input(`b_${idx}`, sql.BigInt, c.idbranch);
      req.input(`name_${idx}`, sql.NVarChar(150), c.fperson || "");
      req.input(`t1_${idx}`, sql.NVarChar(50), c.ftel1 || "");
      req.input(`t2_${idx}`, sql.NVarChar(50), c.ftel2 || "");
      req.input(`t3_${idx}`, sql.NVarChar(50), c.ftel3 || "");
      req.input(`t4_${idx}`, sql.NVarChar(50), c.ftel4 || "");

      values.push(`(9, @b_${idx}, @p_${idx}, 49, @name_${idx}, @t1_${idx}, @t2_${idx}, @t3_${idx}, @t4_${idx}, 0, 0)`);
    });

    await req.query(`
      INSERT INTO dbo.person (idprogramitems, idbranch, idperson, idkindperson, fperson, ftel1, ftel2, ftel3, ftel4, fhid, fglobal)
      VALUES ${values.join(", ")};
    `);
  }

  console.log("Test databases successfully seeded and ready!");
  await elrawdaPool.close();
}

setup().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});

