import type { AppDatabase } from "../../packages/storage/database.js";
import type { CompanyRepository } from "../../packages/storage/company-repository.js";
import { readLocalSnapshot, readSqlSnapshot, type SqlConfig } from "../../packages/erp/source.js";
import type { localSecretStore } from "./security.js";

export class SyncService {
  private active = new Map<string, Promise<any>>();
  private closing = false;
  constructor(private db: AppDatabase, private repo: CompanyRepository,
    private secrets: ReturnType<typeof localSecretStore>, private root: string,
    private readSql = readSqlSnapshot) {}

  run(id: string, options: {full?:boolean;config?:SqlConfig;local?:boolean} = {}): Promise<any> {
    if (this.closing) return Promise.reject(Object.assign(new Error("جارٍ إيقاف المزامنة"),{statusCode:503}));
    const prior = this.active.get(id);
    if (prior) return Promise.reject(Object.assign(new Error("مزامنة هذه الشركة جارية بالفعل"),{statusCode:409}));
    const task = this.perform(id,options).finally(() => this.active.delete(id));
    this.active.set(id,task);
    return task;
  }
  async stop() { this.closing = true; await Promise.allSettled(this.active.values()); }

  private async perform(id: string, options: {full?:boolean;config?:SqlConfig;local?:boolean}) {
    const source = this.db.prepare("SELECT * FROM sources WHERE company_id=?").get(id) as any;
    if (!source && !options.config && !options.local) throw Object.assign(new Error("حدد مصدر البيانات أولًا"),{statusCode:400});
    const kind = options.local ? "snapshot" : options.config ? "sql" : source.kind;
    const full = Boolean(options.config || options.full || !source?.baseline_complete || !source?.last_full_sync ||
      Date.now()-Date.parse(source.last_full_sync) >= 60*60000);
    try {
      const snapshot = kind === "snapshot" ? await readLocalSnapshot(this.root) : await this.readSql(
        options.config ?? this.secrets.decrypt(source.config), full ? undefined : {
          watermarks:this.repo.getBranchWatermarks(id), recheckIds:this.repo.getPendingRecheckPersonIds(id),
        });
      const result = this.repo.ingest(id,snapshot,kind,options.config ? this.secrets.encrypt(options.config) : null,full || kind === "snapshot");
      this.db.prepare("UPDATE sources SET last_error=NULL,last_attempt=?,last_full_sync=CASE WHEN ? THEN ? ELSE last_full_sync END WHERE company_id=?")
        .run(new Date().toISOString(),full ? 1 : 0,new Date().toISOString(),id);
      return result;
    } catch (error) {
      const code = String((error as any).code || "SYNC_FAILED").replace(/[^A-Z_0-9]/g, "").slice(0,30);
      this.db.prepare("UPDATE sources SET last_error=?,last_attempt=? WHERE company_id=?")
        .run(`تعذر تحديث المصدر (${code}). راجع الاتصال والصلاحيات.`,new Date().toISOString(),id);
      this.repo.audit(id,"source.sync_failed",{code});
      throw error;
    }
  }
}
