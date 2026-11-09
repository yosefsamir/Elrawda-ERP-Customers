import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const value = scryptSync(password, salt, 64);
  return timingSafeEqual(value, Buffer.from(hash, "hex"));
}
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function isLocalOrLanHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").split(":")[0].toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "127.0.0.1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith(".local")
  );
}
/** Local encryption at rest. Windows deployment must protect this directory with service-account ACLs. */
export function localSecretStore(directory: string) {
  const file = join(directory, "secret.key");
  if (!existsSync(file))
    writeFileSync(file, randomBytes(32), { mode: 0o600, flag: "wx" });
  const key = readFileSync(file);
  return {
    encrypt(value: unknown) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
      ]);
      return JSON.stringify({
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      });
    },
    decrypt(value: string) {
      const payload = JSON.parse(value),
        decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(payload.iv, "base64"),
        );
      decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(payload.data, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      );
    },
  };
}
