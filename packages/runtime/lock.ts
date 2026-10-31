import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function acquireLock(file: string) {
  mkdirSync(dirname(file),{recursive:true});
  const owner = randomUUID();
  for (let attempt=0;attempt<2;attempt++) {
    try {
      writeFileSync(file,JSON.stringify({pid:process.pid,owner}),{flag:"wx",mode:0o600});
      return () => {
        try { if (JSON.parse(readFileSync(file,"utf8")).owner === owner) unlinkSync(file); } catch {}
      };
    } catch (error) {
      if ((error as any).code !== "EEXIST") throw error;
      let prior: {pid:number};
      try { prior=JSON.parse(readFileSync(file,"utf8")); }
      catch { throw new Error(`Invalid runtime lock: ${file}. Check that the old process has stopped.`); }
      try { process.kill(prior.pid,0); }
      catch (probe) {
        if ((probe as any).code === "ESRCH") { unlinkSync(file); continue; }
        throw probe;
      }
      throw new Error("Another server or maintenance process is using this data directory.");
    }
  }
  throw new Error("Could not acquire the data directory lock.");
}
