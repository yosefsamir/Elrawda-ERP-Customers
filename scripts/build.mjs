import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
rmSync('dist/runtime',{recursive:true,force:true});
for (const args of [['node_modules/typescript/bin/tsc','-p','tsconfig.server.json'],['node_modules/vite/bin/vite.js','build'],['node_modules/vite/bin/vite.js','build','--config','vite.portal.config.ts']]) {
  const result=spawnSync(process.execPath,args,{stdio:'inherit'});
  if(result.status!==0) process.exit(result.status||1);
}
mkdirSync('dist/runtime/scripts/whatsapp-test',{recursive:true});
for(const name of ['groups.cjs','operations.cjs','browser.cjs']) cpSync(`scripts/whatsapp-test/${name}`,`dist/runtime/scripts/whatsapp-test/${name}`);
