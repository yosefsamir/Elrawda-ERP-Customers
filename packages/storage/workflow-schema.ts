import type Database from "better-sqlite3";

/** Additive extension: v2 tables/settings are not rewritten. Legacy mode stays the default. */
export function migrateWorkflows(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
  `);
  const version = (db.prepare("SELECT COALESCE(MAX(version),0) v FROM workflow_migrations").get() as {v:number}).v;
  if (version > 2) throw new Error("مخطط الطوابير أحدث من هذا الإصدار");
  if (version < 1) db.exec(`
    CREATE TABLE workflow_settings(
      company_id TEXT PRIMARY KEY REFERENCES companies(id),mode TEXT NOT NULL DEFAULT 'legacy' CHECK(mode IN('legacy','invoices')),
      fresh_enabled INTEGER NOT NULL DEFAULT 1,historical_enabled INTEGER NOT NULL DEFAULT 0,
      messages_enabled INTEGER NOT NULL DEFAULT 0,messages_enabled_at TEXT,
      fresh_ttl INTEGER NOT NULL DEFAULT 86400,message_ttl INTEGER NOT NULL DEFAULT 3600,
      activated_at TEXT,message_template TEXT NOT NULL DEFAULT 'أهلًا {customerName}، شكرًا لزيارتك {companyName}. رقم فاتورتك {invoiceNumber}.',
      transition_day TEXT,control_generation INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE workflow_branches(
      company_id TEXT NOT NULL,program_id INTEGER NOT NULL,branch_id INTEGER NOT NULL,
      fresh_enabled INTEGER NOT NULL DEFAULT 1,historical_enabled INTEGER NOT NULL DEFAULT 0,messages_enabled INTEGER NOT NULL DEFAULT 1,
      historical_limit INTEGER NOT NULL DEFAULT 0 CHECK(historical_limit>=0),
      PRIMARY KEY(company_id,program_id,branch_id),
      FOREIGN KEY(company_id,program_id,branch_id) REFERENCES branches(company_id,program_id,branch_id)
    );
    CREATE TABLE workflow_sources(
      company_id TEXT PRIMARY KEY REFERENCES companies(id),identity TEXT NOT NULL,
      baseline_complete INTEGER NOT NULL DEFAULT 0,baseline_started_at TEXT NOT NULL,last_sync TEXT
    );
    CREATE TABLE workflow_invoices(
      id INTEGER PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),source_identity TEXT NOT NULL,
      program_id INTEGER NOT NULL,branch_id INTEGER NOT NULL,invoice_id TEXT NOT NULL,person_id INTEGER NOT NULL,
      invoice_number TEXT,entered_at TEXT,document_at TEXT,printed INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,is_baseline INTEGER NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,
      UNIQUE(company_id,source_identity,program_id,branch_id,invoice_id)
    );
    CREATE TABLE workflow_jobs(
      id INTEGER PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),kind TEXT NOT NULL CHECK(kind IN('fresh','message','historical')),
      dedup_key TEXT NOT NULL,program_id INTEGER NOT NULL,branch_id INTEGER NOT NULL,person_id INTEGER NOT NULL,
      invoice_row_id INTEGER REFERENCES workflow_invoices(id),day TEXT,
      status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN('waiting','running','completed','expired','skipped','review','cancelled')),
      due_at TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,reason TEXT,phone TEXT,group_id TEXT,
      UNIQUE(company_id,kind,dedup_key)
    );
    CREATE INDEX workflow_jobs_due ON workflow_jobs(company_id,kind,status,due_at);
    CREATE INDEX workflow_invoices_person ON workflow_invoices(company_id,program_id,branch_id,person_id);
    CREATE TABLE workflow_enrollments(
      company_id TEXT NOT NULL REFERENCES companies(id),program_id INTEGER NOT NULL,branch_id INTEGER NOT NULL,person_id INTEGER NOT NULL,
      phone TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('confirmed','rejected','unknown')),
      group_id TEXT,reason TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(company_id,program_id,branch_id,person_id,phone)
    );
    CREATE INDEX workflow_enrollments_phone ON workflow_enrollments(company_id,phone,state);
    CREATE TABLE workflow_day_plans(
      company_id TEXT NOT NULL,program_id INTEGER NOT NULL,branch_id INTEGER NOT NULL,day TEXT NOT NULL,
      target INTEGER NOT NULL,legacy_reserved INTEGER NOT NULL DEFAULT 0,start_at TEXT NOT NULL,end_at TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(company_id,program_id,branch_id,day),
      FOREIGN KEY(company_id,program_id,branch_id) REFERENCES branches(company_id,program_id,branch_id)
    );
    INSERT INTO workflow_enrollments(company_id,program_id,branch_id,person_id,phone,state,reason,updated_at)
      SELECT company_id,program_id,branch_id,person_id,phone,
        CASE WHEN membership_state IN('joined','already_member') THEN 'confirmed' ELSE 'unknown' END,
        'legacy:'||membership_state,COALESCE(membership_checked_at,first_seen)
      FROM customers WHERE phone IS NOT NULL AND membership_state!='not_attempted';
    INSERT INTO workflow_migrations VALUES(1,datetime('now'));
  `);
  if (version < 2) db.exec(`
    CREATE TABLE workflow_invoice_reads(
      company_id TEXT PRIMARY KEY REFERENCES workflow_sources(company_id) ON DELETE CASCADE,
      cursor TEXT NOT NULL,customer_cursor INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL
    );
    INSERT INTO workflow_migrations VALUES(2,datetime('now'));
  `);
}
