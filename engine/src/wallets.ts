// Follows the smart-money wallets on-chain, through the Solana RPC (Helius): every transaction a
// followed wallet signs is fetched and read as a swap (SOL out + token in = buy, the reverse = sell),
// whichever DEX it went through. PumpPortal only sees pump.fun's own curve, which these wallets
// often trade past.
import { config } from "./config.ts";
import { Rpc } from "./solana.ts";
import { log } from "./util.ts";

const WSOL = "So11111111111111111111111111111111111111112";
/** Smallest SOL leg that counts as a trade (token-account rent alone is ~0.002 SOL). */
const MIN_SWAP_SOL = 0.01;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** Gap between transaction reads (~6/s), how long a signature may wait, and the queue cap. */
const READ_GAP_MS = 160;
const STALE_MS = 90_000;
const MAX_QUEUE = 150;
const RATE_LIMIT_PAUSE_MS = 2000;

export interface WalletSwap {
  signature: string;
  wallet: string;
  mint: string;
  side: "buy" | "sell";
  sol: number; // SOL spent (buy) or received (sell)
  tokens: number; // tokens bought or sold (ui amount)
  priceSol: number; // SOL per token for this fill
  t: number;
}

/** Read a confirmed transaction as a swap by `wallet`. Returns null for anything else (transfers, approvals...). */
export function parseSwap(tx: any, wallet: string, signature: string, t: number): WalletSwap | null {
  const keys: any[] = tx?.transaction?.message?.accountKeys ?? [];
  const idx = keys.findIndex((k) => (typeof k === "string" ? k : k?.pubkey) === wallet);
  if (idx < 0) return null;
  const k = keys[idx];
  if (typeof k === "object" && k && k.signer === false) return null; // not the wallet's own action
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  let solDelta = (Number(meta.postBalances?.[idx] ?? 0) - Number(meta.preBalances?.[idx] ?? 0)) / 1e9;
  if (idx === 0) solDelta += Number(meta.fee ?? 0) / 1e9; // fee payer: ignore the network fee
  const tok = new Map<string, number>();
  const add = (list: any[], sign: number) => {
    for (const b of list ?? []) {
      if (b.owner !== wallet) continue;
      const amt = Number(b.uiTokenAmount?.uiAmount ?? 0);
      if (b.mint === WSOL) solDelta += sign * amt;
      else tok.set(b.mint, (tok.get(b.mint) ?? 0) + sign * amt);
    }
  };
  add(meta.preTokenBalances, -1);
  add(meta.postTokenBalances, 1);
  const changed = [...tok].filter(([, d]) => Math.abs(d) > 0);
  // Exactly one token must change hands against SOL. Two tokens moving = a token-for-token swap
  // (USDC → coin, say): the SOL leg is just fees, and pricing the coin off it would be wildly wrong.
  if (changed.length !== 1) return null;
  const [mint, d] = changed[0];
  // Below MIN_SWAP_SOL the SOL leg is rent or fees, not a trade: a token someone sent the wallet
  // (plus 0.002 SOL account rent) must not be read as a buy at a near-zero price.
  if (d > 0 && solDelta < -MIN_SWAP_SOL) return { signature, wallet, mint, side: "buy", sol: -solDelta, tokens: d, priceSol: -solDelta / d, t };
  if (d < 0 && solDelta > MIN_SWAP_SOL) return { signature, wallet, mint, side: "sell", sol: solDelta, tokens: -d, priceSol: solDelta / -d, t };
  return null;
}

export class WalletWatcher {
  private ws?: WebSocket;
  private stopped = false;
  private delay = 2000;
  private subs = new Map<number, string>(); // subscription id -> wallet
  private pendingReq = new Map<number, string>(); // request id -> wallet
  private reqId = 1;
  private rpc: Rpc;
  private seen = new Set<string>();
  private ping?: ReturnType<typeof setInterval>;

  private rpcUrl: string;
  private wallets: string[];
  private onSwap: (s: WalletSwap) => void;

  constructor(rpcUrl: string, wallets: string[], onSwap: (s: WalletSwap) => void) {
    this.rpcUrl = rpcUrl;
    this.wallets = wallets;
    this.onSwap = onSwap;
    this.rpc = new Rpc(rpcUrl);
  }

  start() {
    if (!this.wallets.length) return;
    this.stopped = false;
    this.connect();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.ping);
    this.ws?.close();
  }

  private wsUrl() {
    return this.rpcUrl.replace(/^http/, "ws");
  }

  private connect() {
    const ws = new WebSocket(this.wsUrl());
    this.ws = ws;
    this.subs.clear();
    this.pendingReq.clear();
    ws.onopen = () => {
      log("wallets", `watching ${this.wallets.length} wallets on-chain`);
      this.delay = 2000;
      for (const w of this.wallets) {
        const id = this.reqId++;
        this.pendingReq.set(id, w);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "logsSubscribe", params: [{ mentions: [w] }, { commitment: "confirmed" }] }));
      }
      clearInterval(this.ping);
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ jsonrpc: "2.0", id: this.reqId++, method: "getHealth" })), 25_000);
    };
    ws.onmessage = (m) => {
      let e: any;
      try {
        e = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (e.id != null && this.pendingReq.has(e.id)) {
        const w = this.pendingReq.get(e.id)!;
        this.pendingReq.delete(e.id);
        if (typeof e.result === "number") this.subs.set(e.result, w);
        else if (e.error) log("wallets", `subscribe failed for ${w.slice(0, 6)}…: ${e.error.message ?? JSON.stringify(e.error)}`);
        return;
      }
      if (e.method !== "logsNotification") return;
      const w = this.subs.get(e.params?.subscription);
      const v = e.params?.result?.value;
      if (!w || !v?.signature || v.err) return;
      if (this.seen.has(v.signature)) return;
      this.seen.add(v.signature);
      if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);
      // a swap always moves SPL tokens; anything without the token program in its logs is a plain SOL
      // transfer, a vote or a program call, not worth an RPC read
      const logs: string[] = Array.isArray(v.logs) ? v.logs : [];
      if (logs.length && !logs.some((l) => l.includes(TOKEN_PROGRAM) || l.includes(TOKEN_2022))) return;
      this.enqueue(v.signature, w);
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      if (this.stopped) return;
      log("wallets", `disconnected, retrying in ${this.delay / 1000}s`);
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 60_000);
    };
    ws.onerror = () => {};
  }

  // Transaction reads go through one queue, spaced out, so a burst from 20+ wallets can't trip the
  // RPC's rate limit (HTTP 429), which would also throttle the bots' own real trades on the same key.
  private queue: { signature: string; wallet: string; t: number }[] = [];
  private draining = false;
  private lastLimitLog = 0;

  private enqueue(signature: string, wallet: string) {
    this.queue.push({ signature, wallet, t: Date.now() });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE); // keep the newest
    if (!this.draining) this.drain().catch(() => {});
  }

  private async drain() {
    this.draining = true;
    try {
      while (this.queue.length && !this.stopped) {
        const job = this.queue.shift()!;
        if (Date.now() - job.t > STALE_MS) continue; // too old to copy anyway
        await this.handle(job.signature, job.wallet).catch((err) => this.logFailure((err as Error).message));
        await sleep(READ_GAP_MS);
      }
    } finally {
      this.draining = false;
    }
  }

  private logFailure(msg: string) {
    if (/429/.test(msg)) {
      if (Date.now() - this.lastLimitLog < 60_000) return;
      this.lastLimitLog = Date.now();
      log("wallets", `RPC rate limit hit (HTTP 429); reads are being spaced out, ${this.queue.length} waiting`);
    } else log("wallets", "tx read failed:", msg);
  }

  private async handle(signature: string, wallet: string) {
    let tx: any = null;
    for (let i = 0; i < 4 && !tx; i++) {
      if (i) await sleep(1500 * i);
      try {
        tx = await this.rpc.call("getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 1 }]);
      } catch (err) {
        if (!/429/.test((err as Error).message) || i === 3) throw err;
        await sleep(RATE_LIMIT_PAUSE_MS * (i + 1)); // back off, then try again
      }
    }
    if (!tx) return;
    const t = tx.blockTime ? tx.blockTime * 1000 : Date.now();
    const swap = parseSwap(tx, wallet, signature, Math.max(t, Date.now() - 120_000));
    if (swap) this.onSwap(swap);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One-off check used by check-keys: can we open the RPC websocket and subscribe? */
export async function probeWalletStream(rpcUrl: string, wallet: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(rpcUrl.replace(/^http/, "ws"));
    const t = setTimeout(() => (ws.close(), reject(new Error("websocket timed out"))), 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [wallet] }, { commitment: "confirmed" }] }));
    ws.onmessage = (m) => {
      const e = JSON.parse(String(m.data));
      clearTimeout(t);
      ws.close();
      if (typeof e.result === "number") resolve("RPC websocket works");
      else reject(new Error(e.error?.message ?? "unexpected reply"));
    };
    ws.onerror = () => (clearTimeout(t), reject(new Error("could not connect to the RPC websocket")));
  });
}
