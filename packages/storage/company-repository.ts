import { createHash, randomUUID } from "node:crypto";
import type { AppDatabase } from "./database.js";
import {
  defaultSettings,
  type CompanySettings,
  type SourceSnapshot,
} from "../domain/contracts.js";
import { cairoDay, selectPhone } from "../domain/phone.js";

export function calculateAdditionInterval(baseSeconds: number, seed: string | null): number {
  if (baseSeconds <= 0 || !seed) return baseSeconds;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Up to +50% variable jitter (e.g. 0-30s extra for 60s base) so intervals vary naturally like human actions
  const maxJitter = Math.max(1, Math.floor(baseSeconds * 0.5));
  const jitter = Math.abs(hash) % (maxJitter + 1);
  return baseSeconds + jitter;
}

export class CompanyRepository {
  constructor(readonly db: AppDatabase) {}
  audit(companyId: string | null, event: string, details: unknown = {}) {
    this.db
      .prepare(
        "INSERT INTO audit_events(company_id,event,details,created_at) VALUES(?,?,?,?)",
      )
      .run(companyId, event, JSON.stringify(details), new Date().toISOString());
  }
  create(operatorId: string, name: string) {
    const id = randomUUID();
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO companies(id,name,settings,created_at) VALUES(?,?,?,?)",
        )
        .run(
          id,
          name,
          JSON.stringify(defaultSettings),
          new Date().toISOString(),
        );
      this.db
        .prepare("INSERT INTO company_access VALUES(?,?)")
        .run(operatorId, id);
      this.audit(id, "company.created");
    })();
    return id;
  }
  settings(id: string): CompanySettings {
    return { ...defaultSettings, ...JSON.parse(
      (
        this.db
          .prepare("SELECT settings FROM companies WHERE id=?")
          .get(id) as { settings: string }
      ).settings,
    ) };
  }

  additionBudget(id: string, now = Date.now()) {
    const settings = this.settings(id);
    const { used, latest } = this.db.prepare(`SELECT COUNT(*) used, MAX(created_at) latest
      FROM operations WHERE company_id=? AND kind='add' AND created_at>?`)
      .get(id, new Date(now - 86400000).toISOString()) as { used: number; latest: string | null };
    const intervalSeconds = calculateAdditionInterval(
      settings.additionMinIntervalSeconds,
      latest ? `${id}:${latest}` : null,
    );
    const nextAt = latest && settings.additionMinIntervalSeconds > 0
      ? Date.parse(latest) + intervalSeconds * 1000
      : 0;
    return { used, limit: settings.additionDailyLimit, nextAt,
      allowed: used < settings.additionDailyLimit && now >= nextAt };
  }

  pauseForWhatsApp(id: string, reason: string) {
    this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE companies SET paused=1,pause_until=NULL WHERE id=? AND (paused=0 OR pause_until IS NOT NULL)").run(id);
      if (changed.changes) this.audit(id, "processing.paused", { reason, until: null });
    })();
  }

  /**
   * Returns the highest person_id recorded per branch (watermark).
   * Used for incremental queries to fetch only newly registered ERP customers.
   */
  getBranchWatermarks(companyId: string): Record<number, number> {
    const rows = this.db
      .prepare(
        `SELECT branch_id, COALESCE(MAX(person_id), 0) AS max_id 
         FROM customers 
         WHERE company_id = ? 
         GROUP BY branch_id`,
      )
      .all(companyId) as Array<{ branch_id: number; max_id: number }>;

    const watermarks: Record<number, number> = {};
    for (const row of rows) {
      watermarks[row.branch_id] = row.max_id;
    }
    return watermarks;
  }

  /**
   * Returns person_ids of recently registered customers that currently lack a valid phone.
   * Enables re-checking in incremental sync in case the cashier added the phone shortly after registration.
   */
  getPendingRecheckPersonIds(companyId: string): Record<number, number[]> {
    const rows = this.db
      .prepare(
        `SELECT branch_id, person_id 
         FROM customers 
         WHERE company_id = ? 
           AND phone_state != 'valid' 
           AND is_baseline = 0
         ORDER BY person_id DESC 
         LIMIT 100`,
      )
      .all(companyId) as Array<{ branch_id: number; person_id: number }>;

    const result: Record<number, number[]> = {};
    for (const row of rows) {
      if (!result[row.branch_id]) result[row.branch_id] = [];
      result[row.branch_id].push(row.person_id);
    }
    return result;
  }

  ingest(
    companyId: string,
    snapshot: SourceSnapshot,
    kind: string,
    config: string | null = null,
    authoritative = false,
  ) {
    const source = this.db
      .prepare("SELECT * FROM sources WHERE company_id=?")
      .get(companyId) as
      { identity: string; baseline_complete: number } | undefined;
    if (source && source.identity !== snapshot.identity)
      throw new Error(
        "لا يمكن تغيير مصدر شركة لها بيانات. أنشئ شركة مستقلة أو راجع ترحيل المصدر.",
      );
    const baseline = !source?.baseline_complete;
    const now = new Date().toISOString(),
      day = cairoDay();
    const rows = new Set<string>();
    for (const row of snapshot.customers) {
      const key = `${row.idprogramitems}:${row.idbranch}:${row.idperson}`;
      if (rows.has(key))
        throw new Error("المصدر أعاد هوية عميل مكررة؛ لم تُحفظ المزامنة.");
      rows.add(key);
    }
    let added = 0,
      changed = 0;
    this.db.transaction(() => {
      if (authoritative) {
        this.db.prepare("UPDATE customers SET source_active=0 WHERE company_id=?").run(companyId);
        this.db.prepare("UPDATE branches SET source_active=0 WHERE company_id=?").run(companyId);
      }
      for (const branch of snapshot.branches) {
        this.db
          .prepare(
            `INSERT INTO branches(company_id,program_id,branch_id,name,enabled) VALUES(?,?,?,?,?)
          ON CONFLICT(company_id,program_id,branch_id) DO UPDATE SET name=excluded.name`,
          )
          .run(
            companyId,
            branch.idprogramitems,
            branch.idbranch,
            branch.fbranch,
            branch.fvis && !branch.deleted ? 1 : 0,
          );
        this.db.prepare("UPDATE branches SET source_active=? WHERE company_id=? AND program_id=? AND branch_id=?")
          .run(branch.fvis && !branch.deleted ? 1 : 0,companyId,branch.idprogramitems,branch.idbranch);
      }
      for (const row of snapshot.customers) {
        const phone = selectPhone([row.ftel1, row.ftel2, row.ftel3, row.ftel4]);
        const key = [companyId, row.idprogramitems, row.idbranch, row.idperson];
        const previous = this.db
          .prepare(
            "SELECT fingerprint,phone,phone_state FROM customers WHERE company_id=? AND program_id=? AND branch_id=? AND person_id=?",
          )
          .get(...key) as
          { fingerprint: string; phone: string | null; phone_state: string } | undefined;
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify([
              row.fperson,
              row.ftel1 ?? "",
              row.ftel2 ?? "",
              row.ftel3 ?? "",
              row.ftel4 ?? "",
            ]),
          )
          .digest("hex");
        if (previous) this.db.prepare("UPDATE customers SET source_active=1 WHERE company_id=? AND program_id=? AND branch_id=? AND person_id=?").run(...key);
        if (!previous) {
          this.db
            .prepare(
              `INSERT INTO customers(company_id,program_id,branch_id,person_id,name,raw_phone,phone,phone_state,phone_reason,phone_field,first_seen,first_day,is_baseline,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              ...key,
              row.fperson ?? "",
              phone.raw,
              phone.normalized,
              phone.state,
              phone.reason,
              phone.field,
              now,
              day,
              baseline ? 1 : 0,
              fingerprint,
            );
          added++;
        } else if (previous.fingerprint !== fingerprint) {
          const isFirstTimeValid =
            (!previous.phone || previous.phone_state !== "valid") &&
            phone.state === "valid";

          this.db
            .prepare(
              `UPDATE customers 
               SET name=?,
                   raw_phone=?,
                   phone=?,
                   phone_state=?,
                   phone_reason=?,
                   phone_field=?,
                   fingerprint=?,
                   whatsapp_state = CASE 
                     WHEN ? = 1 THEN 'unchecked'
                     WHEN phone IS NOT ? THEN 'unchecked' 
                     ELSE whatsapp_state 
                   END,
                   whatsapp_checked_at = CASE 
                     WHEN ? = 1 THEN NULL
                     WHEN phone IS NOT ? THEN NULL 
                     ELSE whatsapp_checked_at 
                   END,
                   membership_state = CASE 
                     WHEN ? = 1 THEN 'not_attempted'
                     WHEN phone IS NOT ? THEN 'review' 
                     ELSE membership_state 
                   END 
               WHERE company_id=? AND program_id=? AND branch_id=? AND person_id=?`,
            )
            .run(
              row.fperson ?? "",
              phone.raw,
              phone.normalized,
              phone.state,
              phone.reason,
              phone.field,
              fingerprint,
              isFirstTimeValid ? 1 : 0,
              phone.normalized,
              isFirstTimeValid ? 1 : 0,
              phone.normalized,
              isFirstTimeValid ? 1 : 0,
              phone.normalized,
              ...key,
            );
          changed++;
        }
      }
      this.db
        .prepare(
          `INSERT INTO sources(company_id,kind,identity,label,config,baseline_complete,last_sync) VALUES(?,?,?,?,?,1,?) ON CONFLICT(company_id) DO UPDATE SET last_sync=excluded.last_sync,baseline_complete=1,config=COALESCE(excluded.config,sources.config)`,
        )
        .run(companyId, kind, snapshot.identity, snapshot.label, config, now);
      if (baseline || added > 0 || changed > 0) {
        this.audit(companyId, "source.synced", {
          baseline,
          added,
          changed,
          count: snapshot.customers.length,
        });
      }
    })();
    return { baseline, added, changed, total: snapshot.customers.length };
  }
  report(
    companyId: string,
    options: {
      day?: string;
      baseline?: boolean;
      branch?: number;
      search?: string;
      state?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const clauses = ["c.company_id=?"];
    const params: unknown[] = [companyId];
    if (options.baseline === false) {
      clauses.push("c.is_baseline=0");
      if (options.day) {
        clauses.push("c.first_day=?");
        params.push(options.day);
      }
    }
    if (options.branch) {
      clauses.push("c.branch_id=?");
      params.push(options.branch);
    }
    if (options.search) {
      clauses.push("(c.name LIKE ? OR c.raw_phone LIKE ? OR c.phone LIKE ?)");
      params.push(...Array(3).fill(`%${options.search}%`));
    }
    if (options.state === "not_registered") {
      clauses.push("c.whatsapp_state='not_registered'");
    } else if (options.state === "joined") {
      clauses.push("c.membership_state IN ('joined','already_member')");
    } else if (options.state === "valid") {
      clauses.push("c.phone_state='valid'");
    } else if (options.state === "invalid") {
      clauses.push("c.phone_state!='valid'");
    } else if (options.state === "unchecked") {
      clauses.push("c.phone_state='valid' AND c.whatsapp_state='unchecked'");
    }
    const where = clauses.join(" AND ");
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) total,SUM(phone_state='valid') valid,SUM(phone_state!='valid') invalid,SUM(whatsapp_state='not_registered') not_registered,SUM(membership_state IN ('joined','already_member')) joined,SUM(phone_state='valid' AND whatsapp_state='unchecked') unchecked FROM customers c WHERE ${where}`,
      )
      .get(...params) as Record<string, number>;
    const rows = this.db
      .prepare(
        `SELECT c.*,b.name branch_name,b.source_active branch_source_active FROM customers c LEFT JOIN branches b ON b.company_id=c.company_id AND b.program_id=c.program_id AND b.branch_id=c.branch_id WHERE ${where} ORDER BY c.first_seen DESC,c.branch_id,c.person_id LIMIT ? OFFSET ?`,
      )
      .all(...params, options.limit ?? 50, options.offset ?? 0);
    return {
      totals: Object.fromEntries(
        Object.entries(totals).map(([k, v]) => [k, v ?? 0]),
      ),
      rows,
    };
  }

  getDailyUsage(companyId: string, day: string, branchId?: number): number {
    if (branchId !== undefined) {
      const row = this.db
        .prepare(
          "SELECT count FROM daily_usage WHERE company_id=? AND day=? AND branch_id=?",
        )
        .get(companyId, day, branchId) as { count: number } | undefined;
      return row?.count ?? 0;
    }
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(count), 0) AS total FROM daily_usage WHERE company_id=? AND day=?",
      )
      .get(companyId, day) as { total: number } | undefined;
    return row?.total ?? 0;
  }

  recordDailyUsage(companyId: string, day: string, branchId: number): void {
    this.db
      .prepare(`
        INSERT INTO daily_usage(company_id, day, branch_id, count)
        VALUES(?, ?, ?, 1)
        ON CONFLICT(company_id, day, branch_id) DO UPDATE SET count = count + 1
      `)
      .run(companyId, day, branchId);
  }

  getNextQueueCandidate(
    companyId: string,
    options: {
      allowHistorical: boolean;
      eligibleBranchIds?: number[];
    },
  ) {
    const settings = this.settings(companyId);
    const global = settings.distributionMode === "global";
    if (global && !settings.globalGroupId) return null;
    const destination = global ? "1=1" : "b.group_id IS NOT NULL AND b.group_id != ''";
    const select = `SELECT c.*, b.name AS branch_name, b.group_id, b.enabled AS branch_enabled, b.base_name, b.next_counter
      FROM customers c JOIN branches b ON b.company_id=c.company_id AND b.program_id=c.program_id AND b.branch_id=c.branch_id
      WHERE c.company_id=? AND c.source_active=1 AND b.source_active=1 AND c.phone_state='valid' AND c.membership_state='not_attempted'
      AND b.enabled=1 AND (c.retry_after IS NULL OR c.retry_after <= '${new Date().toISOString()}') AND ${destination}`;
    const fresh = this.db.prepare(`${select} AND c.is_baseline=0 ORDER BY c.first_seen,c.branch_id,c.person_id LIMIT 1`).get(companyId) as any;
    if (fresh) return {customer:fresh,isNew:true};
    if (!options.allowHistorical) return null;
    const branchList = options.eligibleBranchIds ?? (this.db.prepare(
      `SELECT DISTINCT branch_id FROM branches b WHERE company_id=? AND enabled=1 AND ${destination}`
    ).all(companyId) as Array<{branch_id:number}>).map(b => b.branch_id);
    const day = cairoDay();
    const sorted = [...branchList].sort((a,b) => this.getDailyUsage(companyId,day,a)-this.getDailyUsage(companyId,day,b));
    for (const branchId of sorted) {
      const customer = this.db.prepare(`${select} AND c.branch_id=? AND c.is_baseline=1 ORDER BY c.person_id DESC LIMIT 1`).get(companyId,branchId) as any;
      if (customer) return {customer,isNew:false};
    }
    return null;
  }

  updateCustomerMembership(
    companyId: string,
    programId: number,
    branchId: number,
    personId: number,
    data: {
      membership_state: string;
      whatsapp_state?: string;
      expected_phone?: string;
    },
  ) {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE customers 
        SET membership_state = ?,
            retry_after = NULL,
            membership_checked_at = ?,
            whatsapp_state = COALESCE(?, whatsapp_state),
            whatsapp_checked_at = CASE WHEN ? IS NOT NULL THEN ? ELSE whatsapp_checked_at END
        WHERE company_id = ? AND program_id = ? AND branch_id = ? AND person_id = ? AND (? IS NULL OR phone=?)
      `)
      .run(
        data.membership_state,
        now,
        data.whatsapp_state ?? null,
        data.whatsapp_state ?? null,
        now,
        companyId,
        programId,
        branchId,
        personId,
        data.expected_phone ?? null,
        data.expected_phone ?? null,
      );
  }

  updateBranchGroup(
    companyId: string,
    programId: number,
    branchId: number,
    groupId: string,
    nextCounter: number,
    title?: string,
  ) {
    this.db
      .prepare(
        "UPDATE branches SET group_id=?, next_counter=?, group_title=COALESCE(?,group_title) WHERE company_id=? AND program_id=? AND branch_id=?",
      )
      .run(groupId, nextCounter, title ?? null, companyId, programId, branchId);
  }
}
