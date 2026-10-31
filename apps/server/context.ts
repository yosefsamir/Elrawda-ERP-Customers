import type { AppDatabase } from "../../packages/storage/database.js";
import type { CompanyRepository } from "../../packages/storage/company-repository.js";
import type { localSecretStore } from "./security.js";
import type { WhatsAppBridge } from "./whatsapp-bridge.js";
import type { SyncService } from "./sync-service.js";
export type Context = {
  sync: SyncService;
  db: AppDatabase;
  repo: CompanyRepository;
  secrets: ReturnType<typeof localSecretStore>;
  wa: WhatsAppBridge;
  root: string;
};
declare module "fastify" {
  interface FastifyRequest {
    operatorId: string;
    companyId: string | null;
    sessionHash: string;
  }
}
