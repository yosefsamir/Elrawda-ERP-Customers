import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { getImageProcessingConfig } from "./config.js";
import { GeminiBrowserClient, runInteractiveGeminiLogin } from "./gemini-client.js";
import { getGeminiProfileStatus } from "./profile.js";

const [command, ...rest] = process.argv.slice(2);
const root = resolve(process.env.EMOJI_APP_ROOT ?? process.cwd());
const dataDir = resolve(process.env.EMOJI_DATA_DIR ?? resolve(root, "data/application"));

function flagValue(name: string): string | undefined {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
}

async function main() {
  const dbPath = resolve(dataDir, "app.sqlite");
  const db = existsSync(dbPath) ? new Database(dbPath) : undefined;
  db?.pragma("busy_timeout = 5000");

  try {
    const config = getImageProcessingConfig({ db: db as any, dataDir, root });

    if (command === "login") {
      let lastStage = "";
      await runInteractiveGeminiLogin({
        config,
        root,
        onStage(stage: string) {
          if (stage === lastStage) return;
          lastStage = stage;
          if (stage === "waiting_for_login") {
            console.log("Browser opened at Gemini Web. Sign in to Google and wait for the Gemini prompt box to load...");
          } else if (stage === "confirming") {
            console.log("Detected signed-in Gemini session (/app) — encrypting & saving session (do not close Chrome yet)...");
          }
        },
      });
      if (db) {
        try {
          db.prepare(
            "UPDATE portal_settings SET gemini_paused=0, gemini_requires_reauth=0, gemini_pause_reason=NULL WHERE id=1",
          ).run();
        } catch {}
      }
      console.log(JSON.stringify({ ok: true, profileDir: config.profileDir }));
      return;
    }

    if (command === "verify") {
      const samplePath = rest.find((arg) => !arg.startsWith("--"));
      if (!samplePath) {
        throw new Error("Usage: gemini verify <sample-image-path> [--out <output.webp>] [--prompt <text>]");
      }
      const absSample = resolve(samplePath);
      const outPath = resolve(flagValue("--out") ?? resolve(dataDir, "gemini-verify-output.webp"));
      const prompt = flagValue("--prompt") ?? config.prompt;

      const client = new GeminiBrowserClient(config, root, (event, fields) => {
        console.log(JSON.stringify({ event, ...fields }));
      });

      try {
        const result = await client.process({
          jobId: `verify-${Date.now()}`,
          sourceImagePath: absSample,
          prompt,
        });
        mkdirSync(resolve(outPath, ".."), { recursive: true });
        writeFileSync(outPath, result.buffer);
        console.log(
          JSON.stringify({
            ok: true,
            outputPath: outPath,
            bytes: result.buffer.length,
            width: result.width,
            height: result.height,
            format: result.format,
          }),
        );
      } finally {
        await client.close();
      }
      return;
    }

    if (command === "status") {
      const profile = getGeminiProfileStatus(config.profileRoot);
      let queue: unknown = null;
      if (db) {
        try {
          queue = db
            .prepare("SELECT status, COUNT(*) count FROM image_processing_jobs GROUP BY status")
            .all();
        } catch {}
      }
      console.log(JSON.stringify({ ok: true, profile, queue }));
      return;
    }

    throw new Error("Commands: login | verify <image-path> [--out <path>] [--prompt <text>] | status");
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
});
