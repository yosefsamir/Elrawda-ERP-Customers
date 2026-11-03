import { WhatsAppProfile } from "../../packages/runtime/whatsapp-profile.js";
const profile = new WhatsAppProfile(process.argv[2], "company");
process.send?.({ ready: true });
process.on("message", () => { profile.release(); process.exit(0); });
setInterval(() => {}, 1000);
