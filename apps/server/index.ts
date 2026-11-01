import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createApp } from "./app.js";
import { acquireLock } from "../../packages/runtime/lock.js";
import { watchSupervisor } from "../../packages/runtime/supervisor.js";
const root = resolve(process.env.EMOJI_APP_ROOT ?? process.cwd());
const dataDir = resolve(process.env.EMOJI_DATA_DIR ?? resolve(root,"data/application"));
if (existsSync(resolve(dataDir,"restore-in-progress.json"))) throw new Error("Incomplete restore: inspect restore-in-progress.json before startup");
const release = acquireLock(resolve(dataDir,"runtime.lock"));
let instance: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  instance = await createApp({root,dataDir,logger:true});
  const {app} = instance;
  const token = randomBytes(32).toString("hex");
  const port = Number(process.env.PORT ?? 3211);
  const tokenFile = resolve(dataDir,"shutdown.json");
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try { await app.close(); }
    finally {
      try { if (JSON.parse(readFileSync(tokenFile,"utf8")).token === token) unlinkSync(tokenFile); } catch {}
      release();
    }
  };
  app.post("/internal/shutdown", async (request,reply) => {
    const supplied = String(request.headers["x-maintenance-token"] ?? "");
    if (!["127.0.0.1","::1"].includes(request.ip) || supplied.length !== token.length ||
      !timingSafeEqual(Buffer.from(supplied),Buffer.from(token))) return reply.code(403).send({error:"Forbidden"});
    reply.send({ok:true});
    setImmediate(() => { void close().catch(error => { console.error(error); process.exitCode=1; }); });
  });
  await app.listen({port,host:"127.0.0.1"});
  const boundPort = (app.server.address() as {port:number}).port;
  writeFileSync(tokenFile,JSON.stringify({port:boundPort,token,pid:process.pid}),{mode:0o600});
  if (process.env.EMOJI_READY_FILE) writeFileSync(process.env.EMOJI_READY_FILE,JSON.stringify({port:boundPort,version:JSON.parse(readFileSync(resolve(root,"package.json"),"utf8")).version}));
  for (const signal of ["SIGINT","SIGTERM"]) process.once(signal,() => { void close().catch(error => { console.error(error); process.exitCode=1; }); });
  const supervisor = Number(process.env.EMOJI_SUPERVISOR_PID);
  if (Number.isInteger(supervisor) && supervisor > 0) watchSupervisor(supervisor,() => {
    console.error(`Supervisor ${supervisor} is gone; shutting down.`);
    setTimeout(() => process.exit(1),60000).unref();
    void close().catch(error => { console.error(error); process.exitCode=1; });
  });
} catch (error) { try { await instance?.app.close(); } finally { release(); } throw error; }
