// Follows the smart-money wallets on-chain, through the Solana RPC (Helius): every transaction a
// followed wallet signs is fetched and read as a swap (SOL out + token in = buy, the reverse = sell),
// whichever DEX it went through. PumpPortal only sees pump.fun's own curve, which these wallets
// often trade past.
import { config } from "./config.ts";
import { Rpc } from "./solana.ts";
import { log } from "./util.ts";

const WSOL = "So11111111111111111111111111111111111111112";

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
  let best: [string, number] | undefined;
  for (const [mint, d] of tok) if (Math.abs(d) > 0 && (!best || Math.abs(d) > Math.abs(best[1]))) best = [mint, d];
  if (!best) return null;
  const [mint, d] = best;
  if (d > 0 && solDelta < -0.0005) return { signature, wallet, mint, side: "buy", sol: -solDelta, tokens: d, priceSol: -solDelta / d, t };
  if (d < 0 && solDelta > 0.0005) return { signature, wallet, mint, side: "sell", sol: solDelta, tokens: -d, priceSol: solDelta / -d, t };
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
      this.handle(v.signature, w).catch((err) => log("wallets", "tx read failed:", (err as Error).message));
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

  private async handle(signature: string, wallet: string) {
    let tx: any = null;
    for (let i = 0; i < 4 && !tx; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1500 * i));
      tx = await this.rpc.call("getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    }
    if (!tx) return;
    const t = tx.blockTime ? tx.blockTime * 1000 : Date.now();
    const swap = parseSwap(tx, wallet, signature, Math.max(t, Date.now() - 120_000));
    if (swap) this.onSwap(swap);
  }
}

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
