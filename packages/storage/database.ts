import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(filename: string) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const hasMigrations = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  const version = hasMigrations ? (db.prepare("SELECT COALESCE(MAX(version),0) version FROM schema_migrations").get() as {version:number}).version : 0;
  if (version > 2) { db.close(); throw new Error("قاعدة البيانات أحدث من هذا الإصدار؛ استخدم إصدارًا متوافقًا."); }
  if (version === 1 && filename !== ":memory:") {
    db.prepare("VACUUM INTO ?").run(`${filename}.pre-v2-${Date.now()}.sqlite`);
  }
  db.transaction(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operators(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, operator_id TEXT NOT NULL REFERENCES operators(id), expires_at TEXT NOT NULL, company_id TEXT);
    CREATE TABLE IF NOT EXISTS companies(id TEXT PRIMARY KEY, name TEXT NOT NULL, logo_type TEXT, logo BLOB, settings TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 1, pause_until TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS company_access(operator_id TEXT NOT NULL REFERENCES operators(id),company_id TEXT NOT NULL REFERENCES companies(id),PRIMARY KEY(operator_id,company_id));
    CREATE TABLE IF NOT EXISTS sources(company_id TEXT PRIMARY KEY REFERENCES companies(id),kind TEXT NOT NULL,identity TEXT NOT NULL,label TEXT NOT NULL,config TEXT,baseline_complete INTEGER NOT NULL DEFAULT 0,last_sync TEXT);
    CREATE TABLE IF NOT EXISTS branches(company_id TEXT NOT NULL REFERENCES companies(id),program_id INTEGER NOT NULL,branch_id INTEGER NOT NULL,name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,group_id TEXT,base_name TEXT,next_counter INTEGER NOT NULL DEFAULT 2,PRIMARY KEY(company_id,program_id,branch_id));
    CREATE TABLE IF NOT EXISTS customers(company_id TEXT NOT NULL REFERENCES companies(id),program_id INTEGER NOT NULL,branch_id INTEGER NOT NULL,person_id INTEGER NOT NULL,name TEXT NOT NULL,raw_phone TEXT NOT NULL,phone TEXT,phone_state TEXT NOT NULL,phone_reason TEXT NOT NULL,phone_field INTEGER NOT NULL,first_seen TEXT NOT NULL,first_day TEXT NOT NULL,is_baseline INTEGER NOT NULL,source_day TEXT,source_day_kind TEXT NOT NULL DEFAULT 'unavailable',fingerprint TEXT NOT NULL,whatsapp_state TEXT NOT NULL DEFAULT 'unchecked',whatsapp_checked_at TEXT,membership_state TEXT NOT NULL DEFAULT 'not_attempted',membership_checked_at TEXT,PRIMARY KEY(company_id,program_id,branch_id,person_id));
    CREATE INDEX IF NOT EXISTS customers_company_day ON customers(company_id,first_day,is_baseline);
    CREATE INDEX IF NOT EXISTS customers_company_phone ON customers(company_id,phone);
    CREATE INDEX IF NOT EXISTS customers_queue ON customers(company_id, phone_state, membership_state, is_baseline);
    CREATE TABLE IF NOT EXISTS daily_usage(company_id TEXT NOT NULL REFERENCES companies(id),day TEXT NOT NULL,branch_id INTEGER NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(company_id,day,branch_id));
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),dedup_key TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(company_id,dedup_key));
    CREATE TABLE IF NOT EXISTS audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,company_id TEXT,event TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
    INSERT OR IGNORE INTO schema_migrations VALUES(1,datetime('now'));
  `);

  const companyColumns = db.pragma("table_info(companies)") as Array<{ name: string }>;
  if (!companyColumns.some((col) => col.name === "run_mode")) {
    db.exec("ALTER TABLE companies ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'preview'");
  }
  if (!companyColumns.some((col) => col.name === "whatsapp_phone")) {
    db.exec("ALTER TABLE companies ADD COLUMN whatsapp_phone TEXT");
  }
  if (!companyColumns.some((col) => col.name === "whatsapp_name")) {
    db.exec("ALTER TABLE companies ADD COLUMN whatsapp_name TEXT");
  }

  const branchColumns = db.pragma("table_info(branches)") as Array<{ name: string }>;
  if (!branchColumns.some((col) => col.name === "group_title")) {
    db.exec("ALTER TABLE branches ADD COLUMN group_title TEXT");
  }

  const customerColumns = db.pragma("table_info(customers)") as Array<{name:string}>;
  if (!customerColumns.some(col => col.name === "retry_after")) db.exec("ALTER TABLE customers ADD COLUMN retry_after TEXT");
  if (!customerColumns.some(col => col.name === "source_active")) db.exec("ALTER TABLE customers ADD COLUMN source_active INTEGER NOT NULL DEFAULT 1");
  if (!branchColumns.some(col => col.name === "source_active")) db.exec("ALTER TABLE branches ADD COLUMN source_active INTEGER NOT NULL DEFAULT 1");
  const sourceColumns = db.pragma("table_info(sources)") as Array<{ name: string }>;
  for (const column of ["last_full_sync", "last_error", "last_attempt"]) {
    if (!sourceColumns.some((col) => col.name === column)) db.exec(`ALTER TABLE sources ADD COLUMN ${column} TEXT`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS operations(
      company_id TEXT NOT NULL REFERENCES companies(id),
      kind TEXT NOT NULL, dedup_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('started','completed','unknown')),
      payload TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(company_id,kind,dedup_key)
    );
    INSERT OR IGNORE INTO schema_migrations VALUES(2,datetime('now'));
    CREATE INDEX IF NOT EXISTS operations_addition_budget ON operations(company_id,kind,created_at);
  `);
  })();
  return db;
}
export type AppDatabase = ReturnType<typeof openDatabase>;
