import type { AppDatabase } from "../../packages/storage/database.js";
import type { CompanyRepository } from "../../packages/storage/company-repository.js";
import { Operations } from "../../packages/storage/operations.js";
import type { WhatsAppBridge } from "./whatsapp-bridge.js";
import { cairoDay, isWithinCairoWorkHours } from "../../packages/domain/phone.js";
import type { CompanySettings } from "../../packages/domain/contracts.js";

export class ExecutionEngine {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopping = false;
  private operations: Operations;

  constructor(private db: AppDatabase, private repo: CompanyRepository, private wa: WhatsAppBridge) {
    this.operations = new Operations(db);
    this.operations.recover();
  }
  start(intervalMs = 4000) {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => { void this.tick().catch(error => console.error("Queue processing failed", error.message)); }, intervalMs);
    this.timer.unref();
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.process().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private runnable(id: string) {
    if (this.stopping) return false;
    return Boolean(this.db.prepare("SELECT 1 FROM companies WHERE id=? AND paused=0 AND run_mode='live'").get(id));
  }
  private destinationCurrent(id: string, customer: any, groupId: string) {
    const settings=this.repo.settings(id);
    const branch=this.db.prepare("SELECT enabled,group_id,source_active FROM branches WHERE company_id=? AND program_id=? AND branch_id=?")
      .get(id,customer.program_id,customer.branch_id) as {enabled:number;group_id:string|null;source_active:number}|undefined;
    const current = this.db.prepare("SELECT 1 FROM customers WHERE company_id=? AND program_id=? AND branch_id=? AND person_id=? AND phone=? AND source_active=1")
      .get(id,customer.program_id,customer.branch_id,customer.person_id,customer.phone);
    return Boolean(current && branch?.enabled && branch.source_active && (settings.distributionMode === "global" ? settings.globalGroupId : branch.group_id) === groupId);
  }
  private update(id: string, customer: any, state: string, whatsapp?: string) {
    this.repo.updateCustomerMembership(id, customer.program_id, customer.branch_id, customer.person_id,
      { membership_state: state, whatsapp_state: whatsapp, expected_phone:customer.phone });
  }
  private async process() {
    const companies = this.db.prepare("SELECT id,name,settings,paused,pause_until FROM companies WHERE run_mode='live'").all() as any[];
    for (const comp of companies) {
      if (this.stopping) break;
      if (comp.paused && comp.pause_until && comp.pause_until <= new Date().toISOString()) {
        this.db.prepare("UPDATE companies SET paused=0,pause_until=NULL WHERE id=?").run(comp.id);
        this.repo.audit(comp.id, "processing.resume_scheduled");
      }
      if (!this.runnable(comp.id) || this.wa.state.companyId !== comp.id || this.wa.state.status !== "ready") continue;
      const settings: CompanySettings = JSON.parse(comp.settings);
      const day = cairoDay();
      let allowHistorical = isWithinCairoWorkHours(settings.workStart,settings.workEnd) && settings.historicalDailyLimit > 0;
      let eligibleBranchIds: number[] | undefined;
      if (allowHistorical && settings.historicalLimitScope === "total") {
        allowHistorical = this.repo.getDailyUsage(comp.id,day) < settings.historicalDailyLimit;
      } else if (allowHistorical) {
        const destination = settings.distributionMode === "global" ? "1=1" : "group_id IS NOT NULL";
        eligibleBranchIds = (this.db.prepare(`SELECT DISTINCT branch_id FROM branches WHERE company_id=? AND enabled=1 AND ${destination}`).all(comp.id) as any[])
          .map(b => b.branch_id).filter(id => this.repo.getDailyUsage(comp.id,day,id) < settings.historicalDailyLimit);
        allowHistorical = eligibleBranchIds.length > 0;
      }
      const candidate = this.repo.getNextQueueCandidate(comp.id,{allowHistorical,eligibleBranchIds});
      if (!candidate) continue;
      const {customer,isNew} = candidate;
      let groupId: string = settings.distributionMode === "global" ? settings.globalGroupId! : customer.group_id;
      try {
        const info = await this.wa.call(comp.id,"get_group_info",{groupId});
        if (!Number.isFinite(info?.participantCount)) throw new Error("تعذر التحقق من سعة الجروب");
        if (!this.runnable(comp.id) || !this.destinationCurrent(comp.id,customer,groupId)) continue;
        if (info.participantCount >= settings.rolloverThreshold) {
          const global = settings.distributionMode === "global";
          const base = global ? settings.globalBaseName || settings.globalGroupTitle || `${comp.name} — عام`
            : customer.base_name || `${comp.name} — ${customer.branch_name}`;
          const counter = global ? settings.globalNextCounter || 2 : customer.next_counter || 2;
          const title = `${base} ${counter}`;
          const oldGroup = groupId;
          const created = await this.operations.run(comp.id,"rollover",oldGroup,{title},async () => {
            const result = await this.wa.call(comp.id,"create_group",{title});
            if (typeof result?.groupId !== "string" || !/^[\w-]+@g\.us$/.test(result.groupId)) throw new Error("نتيجة إنشاء الجروب غير مؤكدة");
            return result;
          });
          groupId = created.value.groupId;
          this.db.transaction(() => {
            if (!this.destinationCurrent(comp.id,customer,oldGroup)) {
              this.operations.complete(comp.id,"rollover",oldGroup,created.value);
              this.repo.audit(comp.id,"group.created_after_configuration_change",{groupId,title});
              return;
            }
            if (global) {
              const latest = this.repo.settings(comp.id);
              // Preserve policy edits made while the remote creation was in flight.
              this.db.prepare("UPDATE companies SET settings=? WHERE id=?").run(JSON.stringify({ ...latest,
                globalGroupId:groupId,globalGroupTitle:title,globalBaseName:base,globalNextCounter:counter+1 }),comp.id);
            } else this.repo.updateBranchGroup(comp.id,customer.program_id,customer.branch_id,groupId,counter+1,title);
            this.operations.complete(comp.id,"rollover",oldGroup,created.value);
            this.repo.audit(comp.id,"group.rollover",{oldGroupId:oldGroup,newGroupId:groupId,title});
          })();
        }
      } catch (error) {
        // Capacity or creation uncertainty must not cause a write into the old/full group.
        const retry = new Date(Date.now()+60000).toISOString();
        if (settings.distributionMode === "global") this.db.prepare("UPDATE customers SET retry_after=? WHERE company_id=? AND membership_state='not_attempted'").run(retry,comp.id);
        else this.db.prepare("UPDATE customers SET retry_after=? WHERE company_id=? AND program_id=? AND branch_id=? AND membership_state='not_attempted'").run(retry,comp.id,customer.program_id,customer.branch_id);
        this.repo.audit(comp.id,"processing.blocked",{stage:"group",reason:(error as Error).message});
        continue;
      }
      if (!this.runnable(comp.id) || !this.destinationCurrent(comp.id,customer,groupId)) continue;
      const key = `${groupId}:${customer.phone}`;
      try {
        const addition = await this.operations.run(comp.id,"add",key,{groupId,phone:customer.phone},
          async () => {
            // Reserve the historical quota before attempting a remote write, including uncertain outcomes.
            if (!isNew) this.repo.recordDailyUsage(comp.id,day,customer.branch_id);
            return this.wa.call(comp.id,"add_participant",{groupId,phone:customer.phone});
          });
        const result = addition.value;
        let state = result.status === "addition_accepted" ? "pending"
          : result.status === "joined" ? "joined" : result.status === "already_member" ? "already_member" : "review";
        const whatsapp = result.status === "not_on_whatsapp" ? "not_registered"
          : ["joined","already_member","invite_required","addition_accepted"].includes(result.status) ? "registered" : undefined;
        this.db.transaction(() => {
          this.operations.complete(comp.id,"add",key,result);
          this.update(comp.id,customer,state,whatsapp);

        })();
        if (result.status === "invite_required" && settings.inviteOnPrivacy && this.runnable(comp.id)) {
          const invite = await this.operations.run(comp.id,"invite",key,{groupId,phone:customer.phone},async () => {
            const data = await this.wa.call(comp.id,"get_invite_link",{groupId});
            if (!/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+$/.test(data?.link || "")) throw new Error("رابط الدعوة غير صالح");
            if (!this.runnable(comp.id) || !this.destinationCurrent(comp.id,customer,groupId)) throw new Error("تغيرت الوجهة أو توقفت المعالجة قبل إرسال الدعوة");
            const text = settings.inviteTemplate.replaceAll("{customerName}",customer.name || "")
              .replaceAll("{companyName}",comp.name).replaceAll("{destinationName}",settings.distributionMode === "global" ? settings.globalGroupTitle || "العملاء" : customer.branch_name || "")
              .replaceAll("{inviteLink}",data.link).trim();
            const sent = await this.wa.call(comp.id,"send_message",{phone:customer.phone,text});
            if (sent?.status !== "sent" || !sent.messageId) throw new Error("لم تتأكد نتيجة إرسال الدعوة");
            return sent;
          });
          this.db.transaction(() => {
            this.operations.complete(comp.id,"invite",key,invite.value);
            this.update(comp.id,customer,"invitation_sent","registered");

          })();
        }
      } catch (error) {
        this.update(comp.id,customer,"review");
        this.repo.audit(comp.id,"processing.review",{reason:(error as Error).message});
      }
    }
  }
}
