// "Sign in with Solana": users prove they own a wallet by signing a short
// message in Phantom/Solflare. No passwords, no accounts, no sessions.
//
// Message format (the website builds it, the user sees it in their wallet):
//
//   Cogents wants you to sign in with your Solana account:
//   <wallet address>
//
//   Action: create-bot
//   Bot: <handle>
//   Payload: <sha256 of the request details>
//   Issued At: <ISO time>
//   Nonce: <random>
import { createHash, createPublicKey, verify } from "node:crypto";
import { base58Decode } from "./util.ts";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const usedNonces = new Map<string, number>();
const MAX_AGE_MS = 5 * 60_000;

export interface SignedRequest {
  owner: string; // wallet address (base58)
  message: string;
  signature: string; // base58
  payload: string; // exact JSON string whose hash is in the message
}

export interface Verified {
  owner: string;
  action: string;
  bot: string;
  payload: any;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function verifySignature(owner: string, message: string, signatureB58: string): boolean {
  try {
    const pub = base58Decode(owner);
    const sig = base58Decode(signatureB58);
    if (pub.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, pub]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}

/** Checks the signature, the time window, replay, and that the message matches the request. */
export function verifyRequest(req: SignedRequest, expect: { action: string; bot?: string }, now = Date.now()): Verified {
  if (typeof req?.owner !== "string" || typeof req.message !== "string" || typeof req.signature !== "string" || typeof req.payload !== "string") {
    throw new AuthError("missing signature fields");
  }
  if (req.message.length > 1000 || req.payload.length > 8000) throw new AuthError("request too large");
  const lines = req.message.split("\n");
  if (lines[0] !== "Cogents wants you to sign in with your Solana account:") throw new AuthError("unexpected message format");
  if (lines[1] !== req.owner) throw new AuthError("message is for a different wallet");
  const field = (name: string) => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? "";

  const action = field("Action");
  const bot = field("Bot");
  if (action !== expect.action) throw new AuthError("message is for a different action");
  if (expect.bot !== undefined && bot !== expect.bot) throw new AuthError("message is for a different bot");
  if (field("Payload") !== sha256Hex(req.payload)) throw new AuthError("details were changed after signing");

  const issued = Date.parse(field("Issued At"));
  if (!Number.isFinite(issued) || now - issued > MAX_AGE_MS || issued - now > 60_000) throw new AuthError("signature expired, please sign again");
  const nonce = field("Nonce");
  if (nonce.length < 8) throw new AuthError("missing nonce");
  for (const [n, t] of usedNonces) if (now - t > MAX_AGE_MS * 2) usedNonces.delete(n);
  if (usedNonces.has(nonce)) throw new AuthError("this signature was already used");

  if (!verifySignature(req.owner, req.message, req.signature)) throw new AuthError("signature is not valid for this wallet");
  usedNonces.set(nonce, now);

  let payload: any;
  try {
    payload = JSON.parse(req.payload);
  } catch {
    throw new AuthError("details are not valid JSON");
  }
  return { owner: req.owner, action, bot, payload };
}

export class AuthError extends Error {}
