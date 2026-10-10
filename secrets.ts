// Encrypts user bot wallet keys before they go into the database (AES-256-GCM).
// The MASTER_KEY lives only in the server's .env. Without it the stored keys are useless.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.ts";

function key(): Buffer {
  const k = config.masterKey;
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error("MASTER_KEY must be 64 hex characters (generate with: openssl rand -hex 32)");
  return Buffer.from(k, "hex");
}

export function hasMasterKey(): boolean {
  return /^[0-9a-fA-F]{64}$/.test(config.masterKey);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith("v1:")) throw new Error("unknown secret format");
  const raw = Buffer.from(stored.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}
