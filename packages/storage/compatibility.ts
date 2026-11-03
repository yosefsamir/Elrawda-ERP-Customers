import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type Database from 'better-sqlite3';
export function workflowVersion(db:Database.Database) {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_migrations'").get())return 0;
  return (db.prepare('SELECT COALESCE(MAX(version),0) v FROM workflow_migrations').get() as {v:number}).v;
}
export function assertRollbackCompatible(db:Database.Database,target:string) {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_settings'").get())return;
  let supported=0;
  try {supported=JSON.parse(readFileSync(resolve(target,'release-manifest.json'),'utf8')).workflowVersion||0;}catch{}
  const active=db.prepare("SELECT 1 FROM workflow_settings WHERE mode='invoices' OR messages_enabled=1").get();
  // Releases predating this extension ignore its tables while legacy mode is active.
  // A release that knows an older workflow schema explicitly rejects newer versions.
  if(supported<workflowVersion(db)&&(active||supported>0))throw new Error('Target release cannot resume active invoice workflows. Customer state was not restored or reset.');
}
