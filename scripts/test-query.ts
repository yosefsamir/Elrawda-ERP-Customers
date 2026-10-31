import { openDatabase } from "../packages/storage/database.js";
import { CompanyRepository } from "../packages/storage/company-repository.js";
import { listSqlDatabases, readSqlSnapshot } from "../packages/erp/source.js";

async function main() {
  const dbs = await listSqlDatabases({
    server: "127.0.0.1",
    user: "sa",
    password: "Rawda@Pass2026",
    encrypt: true,
    trustServerCertificate: true,
  });
  console.log("Databases in SQL Server:", dbs);

  const snapshot = await readSqlSnapshot({
    server: "127.0.0.1",
    database: "ElRawda",
    user: "sa",
    password: "Rawda@Pass2026",
    encrypt: true,
    trustServerCertificate: true,
    programId: 9,
  });
  console.log("Snapshot branches count:", snapshot.branches.length);
  console.log("Snapshot customers count:", snapshot.customers.length);
  console.log("Sample customer from SQL:", snapshot.customers[0]?.fperson, snapshot.customers[0]?.ftel1);

  // Ingest into a test SQLite DB
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO operators(id,username,password_hash) VALUES(?,?,?)").run("admin", "admin", "hash");
  const repo = new CompanyRepository(db);
  const companyId = repo.create("admin", "شركة الروضة للتجارة");
  
  const result = repo.ingest(companyId, snapshot, "sql", "encrypted_secret_placeholder");
  console.log("Ingest result:", result);
  console.log("Total stored customers in SQLite:", db.prepare("SELECT COUNT(*) as cnt FROM customers WHERE company_id = ?").get(companyId));

  // Test incremental watermark seek
  const watermarks = repo.getBranchWatermarks(companyId);
  console.log("Branch watermarks:", watermarks);

  const incrementalSnapshot = await readSqlSnapshot({
    server: "127.0.0.1",
    database: "ElRawda",
    user: "sa",
    password: "Rawda@Pass2026",
    encrypt: true,
    trustServerCertificate: true,
    programId: 9,
  }, { watermarks });

  console.log("Incremental query returned customers count (should be 0 when no new):", incrementalSnapshot.customers.length);
}

main().catch(console.error);
