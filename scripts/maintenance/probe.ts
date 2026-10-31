import {resolve} from 'node:path';
import Database from 'better-sqlite3';
import {openDatabase} from '../../packages/storage/database.js';
import {acquireLock} from '../../packages/runtime/lock.js';
const dir=resolve(process.argv[2] ?? 'data/application');
const release=acquireLock(resolve(dir,'runtime.lock'));
try {
  const db=process.argv.includes('--readonly') ? new Database(resolve(dir,'app.sqlite'),{readonly:true,fileMustExist:true}) : openDatabase(resolve(dir,'app.sqlite'));
  try {
    const version=(db.prepare('SELECT MAX(version) version FROM schema_migrations').get() as {version:number}).version;
    if(version>2) throw new Error('Schema newer than this release');
    if(db.pragma('integrity_check',{simple:true})!=='ok') throw new Error('Integrity check failed');
    console.log(JSON.stringify({ok:true,schemaVersion:version}));
  } finally {db.close();}
} finally {release();}
