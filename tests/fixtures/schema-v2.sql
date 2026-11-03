-- Schema-only fixture from the unmodified v2 application. No customer data.
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE operators(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, operator_id TEXT NOT NULL REFERENCES operators(id), expires_at TEXT NOT NULL, company_id TEXT);
CREATE TABLE companies(id TEXT PRIMARY KEY, name TEXT NOT NULL, logo_type TEXT, logo BLOB, settings TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 1, pause_until TEXT, created_at TEXT NOT NULL, run_mode TEXT NOT NULL DEFAULT 'preview', whatsapp_phone TEXT, whatsapp_name TEXT);
CREATE TABLE company_access(operator_id TEXT NOT NULL REFERENCES operators(id),company_id TEXT NOT NULL REFERENCES companies(id),PRIMARY KEY(operator_id,company_id));
CREATE TABLE sources(company_id TEXT PRIMARY KEY REFERENCES companies(id),kind TEXT NOT NULL,identity TEXT NOT NULL,label TEXT NOT NULL,config TEXT,baseline_complete INTEGER NOT NULL DEFAULT 0,last_sync TEXT, last_full_sync TEXT, last_error TEXT, last_attempt TEXT);
CREATE TABLE branches(company_id TEXT NOT NULL REFERENCES companies(id),program_id INTEGER NOT NULL,branch_id INTEGER NOT NULL,name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,group_id TEXT,base_name TEXT,next_counter INTEGER NOT NULL DEFAULT 2, group_title TEXT, source_active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(company_id,program_id,branch_id));
CREATE TABLE customers(company_id TEXT NOT NULL REFERENCES companies(id),program_id INTEGER NOT NULL,branch_id INTEGER NOT NULL,person_id INTEGER NOT NULL,name TEXT NOT NULL,raw_phone TEXT NOT NULL,phone TEXT,phone_state TEXT NOT NULL,phone_reason TEXT NOT NULL,phone_field INTEGER NOT NULL,first_seen TEXT NOT NULL,first_day TEXT NOT NULL,is_baseline INTEGER NOT NULL,source_day TEXT,source_day_kind TEXT NOT NULL DEFAULT 'unavailable',fingerprint TEXT NOT NULL,whatsapp_state TEXT NOT NULL DEFAULT 'unchecked',whatsapp_checked_at TEXT,membership_state TEXT NOT NULL DEFAULT 'not_attempted',membership_checked_at TEXT, retry_after TEXT, source_active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(company_id,program_id,branch_id,person_id));
CREATE INDEX customers_company_day ON customers(company_id,first_day,is_baseline);
CREATE INDEX customers_company_phone ON customers(company_id,phone);
CREATE INDEX customers_queue ON customers(company_id, phone_state, membership_state, is_baseline);
CREATE TABLE daily_usage(company_id TEXT NOT NULL REFERENCES companies(id),day TEXT NOT NULL,branch_id INTEGER NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(company_id,day,branch_id));
CREATE TABLE jobs(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),dedup_key TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(company_id,dedup_key));
CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,company_id TEXT,event TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE operations(
      company_id TEXT NOT NULL REFERENCES companies(id),
      kind TEXT NOT NULL, dedup_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('started','completed','unknown')),
      payload TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(company_id,kind,dedup_key)
    );
INSERT INTO schema_migrations VALUES(1,'2026-10-30'),(2,'2026-10-31');
