// Minimal Solana tools: wallet keys, transaction signing and RPC calls.
// Built on Node's own crypto (ed25519) so no third-party code touches private keys.
import { createPrivateKey, createPublicKey, sign, verify, randomBytes, type KeyObject } from "node:crypto";
import { base58Decode, base58Encode, fetchT, sleep } from "./util.ts";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface Wallet {
  publicKey: string; // base58
  publicKeyBytes: Uint8Array;
  privateKey: KeyObject;
}

/** Load a wallet from a base58 secret key (the 64-byte format Phantom/Solflare export). */
export function walletFromSecret(secretBase58: string): Wallet {
  const secret = base58Decode(secretBase58.trim());
  if (secret.length !== 64 && secret.length !== 32) throw new Error("Secret key must be 64 (or 32) bytes");
  const seed = secret.slice(0, 32);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const pub = new Uint8Array(spki.subarray(spki.length - 32));
  if (secret.length === 64 && Buffer.compare(Buffer.from(secret.slice(32)), Buffer.from(pub)) !== 0) {
    throw new Error("Secret key is corrupted (public half does not match)");
  }
  return { publicKey: base58Encode(pub), publicKeyBytes: pub, privateKey };
}

export function newWallet(): { publicKey: string; secret: string } {
  const seed = randomBytes(32);
  const w = walletFromSecret(base58Encode(seed));
  const secret = base58Encode(new Uint8Array([...seed, ...w.publicKeyBytes]));
  return { publicKey: w.publicKey, secret };
}

function readCompactU16(buf: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let size = 0;
  for (;;) {
    const b = buf[offset + size];
    value |= (b & 0x7f) << (size * 7);
    size++;
    if ((b & 0x80) === 0) break;
    if (size > 3) throw new Error("bad compact-u16");
  }
  return [value, size];
}

/**
 * Sign a serialized transaction (legacy or v0) returned by PumpPortal.
 * Refuses to sign unless OUR wallet is the fee payer (first account),
 * so a tampered transaction can't make us sign for someone else.
 */
export function signTransaction(txBytes: Uint8Array, wallet: Wallet): Uint8Array {
  const [numSigs, sigLen] = readCompactU16(txBytes, 0);
  if (numSigs < 1) throw new Error("transaction has no signature slots");
  const msgStart = sigLen + numSigs * 64;
  const message = txBytes.subarray(msgStart);

  let p = 0;
  if (message[0] & 0x80) p = 1; // versioned message prefix
  const numRequiredSigs = message[p];
  p += 3; // header
  const [numKeys, keysLen] = readCompactU16(message, p);
  p += keysLen;
  if (numKeys < 1) throw new Error("transaction has no accounts");
  const feePayer = message.subarray(p, p + 32);
  if (Buffer.compare(Buffer.from(feePayer), Buffer.from(wallet.publicKeyBytes)) !== 0) {
    throw new Error("refusing to sign: fee payer is not this bot's wallet");
  }
  if (numRequiredSigs !== 1 || numSigs !== 1) {
    throw new Error(`refusing to sign: expected 1 signer, got ${numRequiredSigs}`);
  }

  const sig = sign(null, message, wallet.privateKey);
  const out = new Uint8Array(txBytes);
  out.set(sig, sigLen); // slot 0
  return out;
}

export function verifySignature(txBytes: Uint8Array, publicKeyBytes: Uint8Array): boolean {
  const [numSigs, sigLen] = readCompactU16(txBytes, 0);
  const message = txBytes.subarray(sigLen + numSigs * 64);
  const sig = txBytes.subarray(sigLen, sigLen + 64);
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, publicKeyBytes]), format: "der", type: "spki" });
  return verify(null, message, key, sig);
}

function compactU16(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n) b |= 0x80;
    out.push(b);
    if (!n) return out;
  }
}

/**
 * Build an unsigned legacy transaction that sends `lamports` SOL from `from` to `to`
 * (System Program transfer). Used only for withdrawals back to a bot's owner.
 */
export function buildTransferTx(from: Uint8Array, to: Uint8Array, lamports: bigint, recentBlockhash: Uint8Array): Uint8Array {
  if (from.length !== 32 || to.length !== 32 || recentBlockhash.length !== 32) throw new Error("bad key length");
  if (Buffer.compare(Buffer.from(from), Buffer.from(to)) === 0) throw new Error("cannot send to itself");
  if (lamports <= 0n) throw new Error("nothing to send");
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0); // SystemInstruction::Transfer
  data.writeBigUInt64LE(lamports, 4);
  const message = [
    1, 0, 1, // header: 1 signer, 0 readonly signed, 1 readonly unsigned (system program)
    ...compactU16(3),
    ...from,
    ...to,
    ...new Uint8Array(32), // System Program = 11111111111111111111111111111111
    ...recentBlockhash,
    ...compactU16(1), // one instruction
    2, // program id index
    ...compactU16(2), 0, 1, // accounts: from (signer, writable), to (writable)
    ...compactU16(data.length),
    ...data,
  ];
  return new Uint8Array([...compactU16(1), ...new Uint8Array(64), ...message]);
}

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/**
 * Build an unsigned transaction that closes empty token accounts and returns
 * their rent (~0.002 SOL each) to the owner. Every memecoin bought opens one of
 * these accounts; without closing them, rent slowly drains a busy bot.
 */
export function buildCloseAccountsTx(owner: Uint8Array, accounts: { pubkey: Uint8Array; program: Uint8Array }[], recentBlockhash: Uint8Array): Uint8Array {
  if (!accounts.length) throw new Error("nothing to close");
  if (accounts.length > 8) throw new Error("too many accounts for one transaction");
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const programs: Uint8Array[] = [];
  for (const a of accounts) if (!programs.some((p) => hex(p) === hex(a.program))) programs.push(a.program);
  const keys = [owner, ...accounts.map((a) => a.pubkey), ...programs];
  const message: number[] = [1, 0, programs.length, ...compactU16(keys.length)];
  for (const k of keys) message.push(...k);
  message.push(...recentBlockhash, ...compactU16(accounts.length));
  accounts.forEach((a, i) => {
    const programIndex = 1 + accounts.length + programs.findIndex((p) => hex(p) === hex(a.program));
    // CloseAccount (9): [account (writable), destination = owner (writable), owner (signer)]
    message.push(programIndex, ...compactU16(3), 1 + i, 0, 0, ...compactU16(1), 9);
  });
  return new Uint8Array([...compactU16(1), ...new Uint8Array(64), ...message]);
}

export interface TokenHolding {
  account: string;
  mint: string;
  program: string;
  amount: bigint; // raw units
  uiAmount: number;
}

// ---------------------------------------------------------------------------

export class Rpc {
  private url: string;
  constructor(url: string) {
    this.url = url;
  }

  async call<T = any>(method: string, params: unknown[]): Promise<T> {
    const res = await fetchT(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
    const j: any = await res.json();
    if (j.error) throw new Error(`RPC ${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    return j.result as T;
  }

  async getLatestBlockhash(): Promise<Uint8Array> {
    const r = await this.call<any>("getLatestBlockhash", [{ commitment: "confirmed" }]);
    return base58Decode(r.value.blockhash);
  }

  async getLamports(pubkey: string): Promise<bigint> {
    const r = await this.call<{ value: number }>("getBalance", [pubkey, { commitment: "confirmed" }]);
    return BigInt(r.value);
  }

  async getSolBalance(pubkey: string): Promise<number> {
    const r = await this.call<{ value: number }>("getBalance", [pubkey, { commitment: "confirmed" }]);
    return r.value / 1e9;
  }

  /** Token balance (UI units) the wallet holds of one mint. Works for SPL and Token-2022. */
  async getTokenBalance(owner: string, mint: string): Promise<number> {
    const r = await this.call<any>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    let total = 0;
    for (const acc of r.value ?? []) total += Number(acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0);
    return total;
  }

  /** Every token account the wallet owns (classic SPL + Token-2022). */
  async getTokenHoldings(owner: string): Promise<TokenHolding[]> {
    const out: TokenHolding[] = [];
    for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const r = await this.call<any>("getTokenAccountsByOwner", [owner, { programId: program }, { encoding: "jsonParsed", commitment: "confirmed" }]);
      for (const acc of r.value ?? []) {
        const info = acc.account?.data?.parsed?.info;
        if (!info?.mint) continue;
        out.push({
          account: acc.pubkey,
          mint: info.mint,
          program,
          amount: BigInt(info.tokenAmount?.amount ?? "0"),
          uiAmount: Number(info.tokenAmount?.uiAmount ?? 0),
        });
      }
    }
    return out;
  }

  async sendTransaction(signed: Uint8Array): Promise<string> {
    return this.call<string>("sendTransaction", [
      Buffer.from(signed).toString("base64"),
      { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 },
    ]);
  }

  /** Wait until confirmed. Throws if the transaction failed or timed out. */
  async confirm(signature: string, timeoutMs = 60_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = await this.call<any>("getSignatureStatuses", [[signature], { searchTransactionHistory: false }]);
      const st = r.value?.[0];
      if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
      await sleep(1500);
    }
    throw new Error("transaction not confirmed in time");
  }
}
