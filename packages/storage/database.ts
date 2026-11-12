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
  if (version > 4) { db.close(); throw new Error("قاعدة البيانات أحدث من هذا الإصدار؛ استخدم إصدارًا متوافقًا."); }
  if (version === 1 && filename !== ":memory:") {
    db.prepare("VACUUM INTO ?").run(`${filename}.pre-v2-${Date.now()}.sqlite`);
  }
  if (version === 2 && filename !== ":memory:") {
    db.prepare("VACUUM INTO ?").run(`${filename}.pre-v3-${Date.now()}.sqlite`);
  }
  if (version === 3 && filename !== ":memory:") {
    db.prepare("VACUUM INTO ?").run(`${filename}.pre-v4-${Date.now()}.sqlite`);
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS portal_settings(id INTEGER PRIMARY KEY CHECK(id=1),company_id TEXT REFERENCES companies(id),enabled INTEGER NOT NULL DEFAULT 0,origin TEXT NOT NULL DEFAULT '');
    INSERT OR IGNORE INTO portal_settings(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS photo_users(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS photo_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES photo_users(id) ON DELETE CASCADE,expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS product_images(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),source_identity TEXT NOT NULL,product_id TEXT NOT NULL,unit_id TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES photo_users(id),created_at TEXT NOT NULL,deleted_at TEXT);
    CREATE INDEX IF NOT EXISTS product_images_product ON product_images(company_id,source_identity,product_id,unit_id,deleted_at);
    INSERT OR IGNORE INTO schema_migrations VALUES(3,datetime('now'));
  `);

  const portalColumns = db.pragma("table_info(portal_settings)") as Array<{ name: string }>;
  if (!portalColumns.some((col) => col.name === "image_prompt")) {
    db.exec("ALTER TABLE portal_settings ADD COLUMN image_prompt TEXT");
  }
  if (!portalColumns.some((col) => col.name === "gemini_paused")) {
    db.exec("ALTER TABLE portal_settings ADD COLUMN gemini_paused INTEGER NOT NULL DEFAULT 0");
  }
  if (!portalColumns.some((col) => col.name === "gemini_pause_reason")) {
    db.exec("ALTER TABLE portal_settings ADD COLUMN gemini_pause_reason TEXT");
  }
  if (!portalColumns.some((col) => col.name === "gemini_requires_reauth")) {
    db.exec("ALTER TABLE portal_settings ADD COLUMN gemini_requires_reauth INTEGER NOT NULL DEFAULT 0");
  }
  if (!portalColumns.some((col) => col.name === "image_processing_enabled")) {
    db.exec("ALTER TABLE portal_settings ADD COLUMN image_processing_enabled INTEGER NOT NULL DEFAULT 1");
  }
  if (!portalColumns.some((col) => col.name === "watermark_logo")) {
    db.exec("ALTER TABLE portal_settings ADD COLUMN watermark_logo BLOB");
  }
  if (!portalColumns.some((col) => col.name === "watermark_logo_type")) {
    db.exec("ALTER TABLE portal_settings ADD COLUMN watermark_logo_type TEXT");
  }
  if (!portalColumns.some((col) => col.name === "watermark_logo_enabled")) {
    db.exec("ALTER TABLE portal_settings ADD COLUMN watermark_logo_enabled INTEGER NOT NULL DEFAULT 1");
  }
  if (!portalColumns.some((col) => col.name === "watermark_code_enabled")) {
    db.exec("ALTER TABLE portal_settings ADD COLUMN watermark_code_enabled INTEGER NOT NULL DEFAULT 1");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS product_image_state(
      product_image_id TEXT PRIMARY KEY REFERENCES product_images(id) ON DELETE CASCADE,
      original_image_id TEXT NOT NULL,
      processed_image_id TEXT,
      active_job_id TEXT
    );
    CREATE TABLE IF NOT EXISTS image_processing_jobs(
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      source_identity TEXT NOT NULL,
      product_id TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      product_image_id TEXT NOT NULL REFERENCES product_images(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES photo_users(id),
      original_image_id TEXT NOT NULL,
      result_image_id TEXT,
      product_code TEXT,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','processing','completed','failed')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      next_attempt_at TEXT,
      locked_by TEXT,
      locked_at TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS image_jobs_queue ON image_processing_jobs(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS image_jobs_image ON image_processing_jobs(product_image_id, created_at);
    CREATE INDEX IF NOT EXISTS image_jobs_product ON image_processing_jobs(company_id, source_identity, product_id, unit_id, created_at);
    INSERT OR IGNORE INTO schema_migrations VALUES(4,datetime('now'));
  `);
  const jobColumns = db.prepare("PRAGMA table_info(image_processing_jobs)").all() as Array<{ name: string }>;
  if (!jobColumns.some((col) => col.name === "product_code")) {
    db.exec("ALTER TABLE image_processing_jobs ADD COLUMN product_code TEXT");
  }
  })();
  return db;
}
export type AppDatabase = ReturnType<typeof openDatabase>;
