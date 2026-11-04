import type { AppDatabase } from "./database.js";

export class UnknownOperation extends Error {}

/** Persist intent before a remote write. Unknown writes are never retried automatically. */
export class Operations {
  constructor(private db: AppDatabase, private now: () => number = Date.now) {}

  recover() {
    this.db.prepare("UPDATE operations SET status='unknown' WHERE status='started'").run();
  }

  async run(companyId: string, kind: string, key: string, payload: unknown, execute: () => Promise<any>) {
    const prior = this.db.prepare("SELECT status,result FROM operations WHERE company_id=? AND kind=? AND dedup_key=?")
      .get(companyId, kind, key) as {status:string;result:string|null}|undefined;
    if (prior?.status === "completed") return {value:JSON.parse(prior.result!), fresh:false};
    if (prior) throw new UnknownOperation("نتيجة عملية سابقة غير مؤكدة؛ لم نكرر الإرسال.");
    const now = new Date(this.now()).toISOString();
    this.db.prepare("INSERT INTO operations VALUES(?,?,?,'started',?,NULL,?,?)")
      .run(companyId, kind, key, JSON.stringify(payload), now, now);
    try {
      const value = await execute();
      // The caller commits the result with its corresponding local state changes.
      return {value, fresh:true};
    } catch (error) {
      this.unknown(companyId,kind,key);
      throw error;
    }
  }

  complete(companyId: string, kind: string, key: string, value: unknown) {
    this.db.prepare("UPDATE operations SET status='completed',result=?,updated_at=? WHERE company_id=? AND kind=? AND dedup_key=?")
      .run(JSON.stringify(value),new Date().toISOString(),companyId,kind,key);
  }

  unknown(companyId: string, kind: string, key: string) {
    this.db.prepare("UPDATE operations SET status='unknown',updated_at=? WHERE company_id=? AND kind=? AND dedup_key=?")
      .run(new Date().toISOString(),companyId,kind,key);
  }
}
