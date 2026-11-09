import Database from "better-sqlite3";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { acquireLock } from "../runtime/lock.js";
import { localSecretStore } from "../../apps/server/security.js";

export async function createBackup(dataDir: string, target: string, offline = false) {
  dataDir=resolve(dataDir); target=resolve(target);
  if (target === dataDir || target.startsWith(dataDir+"/app.sqlite")) throw new Error("Invalid backup path");
  const release = offline ? acquireLock(resolve(dataDir,"runtime.lock")) : () => {};
  try {
    mkdirSync(target,{recursive:true});
    if (existsSync(resolve(target,"manifest.json")) || existsSync(resolve(target,"app.sqlite"))) throw new Error("Backup destination must be empty");
    const source = new Database(resolve(dataDir,"app.sqlite"),{readonly:true,fileMustExist:true});
    try {
      await source.backup(resolve(target,"app.sqlite"));
      if (existsSync(resolve(dataDir,"secret.key"))) cpSync(resolve(dataDir,"secret.key"),resolve(target,"secret.key"));
    } finally { source.close(); }
    // Images are immutable, including deleted blobs: copying after the DB snapshot
    // guarantees every image referenced by that snapshot remains available.
    if (existsSync(resolve(dataDir,"product-images"))) cpSync(resolve(dataDir,"product-images"),resolve(target,"product-images"),{recursive:true});
    verifyBackup(target);
    if (offline && existsSync(resolve(dataDir,"whatsapp-auth"))) cpSync(resolve(dataDir,"whatsapp-auth"),resolve(target,"whatsapp-auth"),{
      recursive:true, filter:path => !["SingletonLock","SingletonCookie","SingletonSocket","DevToolsActivePort"].includes(basename(path)),
    });
    const manifest = {format:1,createdAt:new Date().toISOString(),includesWhatsApp:offline && existsSync(resolve(target,"whatsapp-auth"))};
    writeFileSync(resolve(target,"manifest.json"),JSON.stringify(manifest,null,2));
    return manifest;
  } finally { release(); }
}

export function verifyBackup(folder: string) {
  const db = new Database(resolve(folder,"app.sqlite"),{readonly:true,fileMustExist:true});
  try {
    if (db.pragma("integrity_check",{simple:true}) !== "ok") throw new Error("Backup integrity check failed");
    if ((db.pragma("foreign_key_check") as unknown[]).length) throw new Error("Backup foreign key check failed");
    if (existsSync(resolve(folder,"secret.key")) && readFileSync(resolve(folder,"secret.key")).length !== 32) throw new Error("Invalid SQL encryption key length");
    const configs = db.prepare("SELECT config FROM sources WHERE config IS NOT NULL").all() as {config:string}[];
    if (configs.length) {
      if (!existsSync(resolve(folder,"secret.key"))) throw new Error("Backup is missing its SQL encryption key");
      const secrets=localSecretStore(folder);
      for (const row of configs) secrets.decrypt(row.config);
    }
    const row = db.prepare("SELECT MAX(version) version FROM schema_migrations").get() as {version:number};
    if (row.version > 3) throw new Error("Backup schema is newer than this release");
    if (row.version >= 3) {
      const images = db.prepare("SELECT id FROM product_images WHERE deleted_at IS NULL").all() as {id:string}[];
      for (const image of images) {
        if (!/^[0-9a-f-]{36}$/.test(image.id) || !existsSync(resolve(folder,"product-images",`${image.id}.webp`))) throw new Error("Backup is missing a product image");
      }
    }
    return row.version;
  } finally { db.close(); }
}

export async function restoreBackup(dataDir: string, backup: string) {
  dataDir=resolve(dataDir); backup=resolve(backup);
  if (dataDir === backup) throw new Error("Restore source and destination must differ");
  verifyBackup(backup);
  const manifest=JSON.parse(readFileSync(resolve(backup,"manifest.json"),"utf8"));
  const release=acquireLock(resolve(dataDir,"runtime.lock"));
  const marker=resolve(dataDir,"restore-in-progress.json");
  try {
    if (existsSync(marker)) throw new Error("A prior restore is incomplete; inspect restore-in-progress.json before starting");
    const previous=resolve(dataDir,`restore-safety-${Date.now()}`);
    mkdirSync(previous);
    writeFileSync(marker,JSON.stringify({previous,backup}));
    const files=["app.sqlite","app.sqlite-wal","app.sqlite-shm","secret.key","product-images",...(manifest.includesWhatsApp ? ["whatsapp-auth"] : [])];
    const moved: string[] = [], installed: string[] = [];
    try {
      for (const name of files) if (existsSync(resolve(dataDir,name))) {
        renameSync(resolve(dataDir,name),resolve(previous,name)); moved.push(name);
      }
      for (const name of ["app.sqlite","secret.key","product-images",...(manifest.includesWhatsApp ? ["whatsapp-auth"] : [])])
        if (existsSync(resolve(backup,name))) {
          installed.push(name); cpSync(resolve(backup,name),resolve(dataDir,name),{recursive:true});
        }
      verifyBackup(dataDir);
      const restored = new Database(resolve(dataDir,"app.sqlite"));
      try { restored.prepare("UPDATE companies SET paused=1,pause_until=NULL,run_mode='preview'").run(); }
      finally {restored.close();}
      rmSync(marker);
    } catch (error) {
      for (const name of installed) rmSync(resolve(dataDir,name),{recursive:true,force:true});
      for (const name of moved) renameSync(resolve(previous,name),resolve(dataDir,name));
      rmSync(marker,{force:true});
      throw error;
    }
    return {previous,includesWhatsApp:Boolean(manifest.includesWhatsApp)};
  } finally {release();}
}
