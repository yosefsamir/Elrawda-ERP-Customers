import { resolve } from "node:path";
import { existsSync, readFileSync, unlinkSync, readdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { createBackup, restoreBackup, verifyBackup } from "../../packages/storage/backup.js";
const [command,...args]=process.argv.slice(2);
const data=resolve(process.env.EMOJI_DATA_DIR ?? "data/application");
const value=(name:string) => {const i=args.indexOf(name);return i<0 ? undefined : args[i+1];};
const output=value("--output"); const input=value("--input");
try {
  if (command === "backup") {
    if (!output) throw new Error("Use backup --output <new directory> [--offline]");
    console.log(JSON.stringify(await createBackup(data,output,args.includes("--offline"))));
  } else if (command === "restore") {
    if (!input) throw new Error("Use restore --input <backup directory>. Stop the application first.");
    console.log(JSON.stringify(await restoreBackup(data,input)));
  } else if (command === "verify-backup") {
    if (!input) throw new Error("Use verify-backup --input <backup directory>");
    console.log(JSON.stringify({ok:true,schema:verifyBackup(input)}));
  } else if (command === "reset-company" || command === "reset-all") {
    const keepAdmin = command === "reset-company";
    const dbPath = resolve(data, "app.sqlite");
    if (!existsSync(dbPath)) {
      console.log(JSON.stringify({ ok: true, message: "No database found." }));
      process.exit(0);
    }
    const db = new Database(dbPath);
    try {
      db.transaction(() => {
        db.exec(`
          DELETE FROM product_images;
          DELETE FROM photo_sessions;
          DELETE FROM photo_users;
          UPDATE portal_settings SET company_id=NULL, enabled=0, origin='';
          DELETE FROM operations;
          DELETE FROM audit_events;
          DELETE FROM jobs;
          DELETE FROM daily_usage;
          DELETE FROM customers;
          DELETE FROM branches;
          DELETE FROM sources;
          DELETE FROM company_access;
          UPDATE sessions SET company_id=NULL;
          DELETE FROM companies;
        `);
        if (!keepAdmin) {
          db.exec(`
            DELETE FROM sessions;
            DELETE FROM operators;
          `);
        }
      })();
      db.pragma("vacuum");
    } finally {
      db.close();
    }
    const imgDir = resolve(data, "product-images");
    if (existsSync(imgDir)) {
      for (const f of readdirSync(imgDir)) rmSync(resolve(imgDir, f), { recursive: true, force: true });
    }
    const waDir = resolve(data, "whatsapp-auth");
    if (existsSync(waDir)) {
      for (const f of readdirSync(waDir)) rmSync(resolve(waDir, f), { recursive: true, force: true });
    }
    console.log(JSON.stringify({ ok: true, reset: keepAdmin ? "company_only" : "all" }));
  } else if (command === "stop") {
    const file=resolve(data,"shutdown.json");
    if (!existsSync(file)) throw new Error("No server shutdown metadata found; check whether the server is running");
    const {port,token,pid}=JSON.parse(readFileSync(file,"utf8"));
    let alive=true;
    try { process.kill(pid,0); } catch(error) { if ((error as any).code === "ESRCH") alive=false; else throw error; }
    if (!alive) { unlinkSync(file); console.log(JSON.stringify({stopped:true,staleMetadata:true})); }
    else {
    const response=await fetch(`http://127.0.0.1:${Number(port)}/internal/shutdown`,{method:"POST",headers:{"x-maintenance-token":token},signal:AbortSignal.timeout(5000)});
    if (!response.ok) throw new Error(`Shutdown refused (${response.status})`);
    const deadline=Date.now()+100000;
    while (existsSync(file)) {
      if (Date.now()>deadline) throw new Error("Graceful shutdown timed out. Do not replace files or force a restart; inspect the logs.");
      await new Promise(r=>setTimeout(r,200));
    }
    console.log(JSON.stringify({stopped:true,pid}));
    }
  } else if (command === "check") {
    if (existsSync(resolve(data,"restore-in-progress.json"))) throw new Error("Incomplete restore: inspect restore-in-progress.json");
    const db=new Database(resolve(data,"app.sqlite"),{readonly:true,fileMustExist:true});
    try { if (db.pragma("integrity_check",{simple:true})!=="ok") throw new Error("Database integrity failed"); }
    finally {db.close();}
    console.log(JSON.stringify({ok:true}));
  } else throw new Error("Commands: backup, restore, verify-backup, reset-company, reset-all, stop, check");
} catch(error) {console.error((error as Error).message);process.exitCode=1;}
