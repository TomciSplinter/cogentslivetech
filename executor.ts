// Turns a validated decision into a trade.
// PaperExecutor simulates fills at live prices. RealExecutor trades on-chain.
import type { Market } from "./market.ts";
import type { Position } from "./risk.ts";
import { config } from "./config.ts";
import { Rpc, buildCloseAccountsTx, buildTransferTx, signTransaction, walletFromSecret, type Wallet } from "./solana.ts";
import { base58Decode, fetchT, log, sleep } from "./util.ts";

export interface BuyResult {
  tokens: number;
  solSpent: number;
  price: number;
  tx?: string;
}
export interface SellResult {
  solReceived: number;
  price: number;
  tx?: string;
}

export interface Executor {
  readonly mode: "paper" | "real";
  readonly address?: string;
  buy(mint: string, sol: number): Promise<BuyResult>;
  sell(p: Position): Promise<SellResult>;
  /** Real wallets report their on-chain SOL; paper returns undefined. */
  syncBalance(): Promise<number | undefined>;
  /** Real wallets only: send all SOL to an address. */
  withdrawAll?(to: string): Promise<{ sol: number; tx: string }>;
  /** Real wallets only: what the wallet actually holds on-chain (mint → tokens). */
  holdings?(): Promise<Map<string, number>>;
}

const FEE = 0.0125; // pump.fun trading fee (approx.)
const PAPER_SLIPPAGE = 0.015;
const NETWORK_FEE_SOL = 0.00002;

export class PaperExecutor implements Executor {
  readonly mode = "paper" as const;
  private market: Market;
  constructor(market: Market) {
    this.market = market;
  }

  async buy(mint: string, sol: number): Promise<BuyResult> {
    const price = this.market.priceOf(mint);
    if (!price) throw new Error("no price for coin");
    const fill = price * (1 + PAPER_SLIPPAGE);
    const tokens = (sol * (1 - FEE)) / fill;
    return { tokens, solSpent: sol + NETWORK_FEE_SOL, price: fill };
  }

  async sell(p: Position): Promise<SellResult> {
    const price = this.market.priceOf(p.mint) ?? p.entryPrice * 0.5;
    const fill = price * (1 - PAPER_SLIPPAGE);
    const sol = Math.max(0, p.tokens * fill * (1 - FEE) - NETWORK_FEE_SOL);
    return { solReceived: sol, price: fill };
  }

  async syncBalance() {
    return undefined;
  }
}

/**
 * Real trading through PumpPortal's Local Transaction API:
 * PumpPortal builds the transaction, WE sign it here, and send it through
 * our own RPC (Helius). The private key never leaves this server.
 *
 * ⚠️ Have a developer review this file before funding a wallet.
 */
export class RealExecutor implements Executor {
  readonly mode = "real" as const;
  private wallet: Wallet;
  private rpc: Rpc;
  private market: Market;

  constructor(secretKey: string, market: Market) {
    this.market = market;
    this.wallet = walletFromSecret(secretKey);
    if (!config.solanaRpcUrl) throw new Error("SOLANA_RPC_URL missing");
    this.rpc = new Rpc(config.solanaRpcUrl);
  }

  get address() {
    return this.wallet.publicKey;
  }

  private async tradeTx(body: Record<string, unknown>): Promise<string> {
    const res = await fetchT(`${config.pumpPortalUrl}/api/trade-local`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: this.wallet.publicKey,
        slippage: config.slippagePct,
        priorityFee: config.priorityFeeSol,
        pool: "auto",
        ...body,
      }),
    });
    if (res.status !== 200) throw new Error(`PumpPortal trade-local HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const signed = signTransaction(bytes, this.wallet);
    const sig = await this.rpc.sendTransaction(signed);
    log("trade", `sent ${body.action} ${body.mint} → ${sig}`);
    await this.rpc.confirm(sig);
    return sig;
  }

  async buy(mint: string, sol: number): Promise<BuyResult> {
    const solBefore = await this.rpc.getSolBalance(this.wallet.publicKey);
    const tx = await this.tradeTx({ action: "buy", mint, amount: sol, denominatedInSol: "true" });
    // RPC nodes can lag a moment behind a confirmed transaction: retry the reads
    let tokens = 0;
    for (let i = 0; i < 6 && !(tokens > 0); i++) {
      await sleep(1500);
      tokens = await this.rpc.getTokenBalance(this.wallet.publicKey, mint);
    }
    const solAfter = await this.rpc.getSolBalance(this.wallet.publicKey);
    if (!(tokens > 0)) throw new Error("buy confirmed but no tokens found yet (the next wallet check will pick them up)");
    const solSpent = Math.max(0, solBefore - solAfter);
    return { tokens, solSpent, price: solSpent / tokens, tx };
  }

  async sell(p: Position): Promise<SellResult> {
    const solBefore = await this.rpc.getSolBalance(this.wallet.publicKey);
    // sell the whole bag: simplest and never leaves dust positions behind
    const tx = await this.tradeTx({ action: "sell", mint: p.mint, amount: "100%", denominatedInSol: "false" });
    await sleep(1500);
    await this.closeEmptyAccounts().catch((e) => log("trade", "couldn't close empty token accounts:", (e as Error).message));
    const solAfter = await this.rpc.getSolBalance(this.wallet.publicKey);
    const solReceived = Math.max(0, solAfter - solBefore);
    const price = p.tokens > 0 ? solReceived / p.tokens : this.market.priceOf(p.mint) ?? 0;
    return { solReceived, price, tx };
  }

  async syncBalance() {
    return this.rpc.getSolBalance(this.wallet.publicKey);
  }

  async holdings(): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    for (const h of await this.rpc.getTokenHoldings(this.wallet.publicKey)) if (h.amount > 0n) m.set(h.mint, (m.get(h.mint) ?? 0) + h.uiAmount);
    return m;
  }

  /** Close token accounts that hold nothing, getting their rent back as SOL. */
  async closeEmptyAccounts(): Promise<number> {
    const empty = (await this.rpc.getTokenHoldings(this.wallet.publicKey)).filter((h) => h.amount === 0n);
    let closed = 0;
    const close = async (batch: typeof empty) => {
      const blockhash = await this.rpc.getLatestBlockhash();
      const tx = buildCloseAccountsTx(
        this.wallet.publicKeyBytes,
        batch.map((h) => ({ pubkey: base58Decode(h.account), program: base58Decode(h.program) })),
        blockhash,
      );
      const sig = await this.rpc.sendTransaction(signTransaction(tx, this.wallet));
      await this.rpc.confirm(sig);
      closed += batch.length;
    };
    for (let i = 0; i < empty.length; i += 8) {
      const batch = empty.slice(i, i + 8);
      try {
        await close(batch);
      } catch {
        // one stubborn account (e.g. a token with withheld fees) shouldn't block the rest
        for (const one of batch) await close([one]).catch(() => {});
      }
    }
    if (closed) log("trade", `closed ${closed} empty token account(s), rent returned`);
    return closed;
  }

  /** Send ALL remaining SOL to `to` (the bot's owner). Sell positions first. */
  async withdrawAll(to: string): Promise<{ sol: number; tx: string }> {
    const toBytes = base58Decode(to);
    if (toBytes.length !== 32) throw new Error("bad owner address");
    await this.closeEmptyAccounts().catch((e) => log("trade", "couldn't close empty token accounts:", (e as Error).message));
    const lamports = await this.rpc.getLamports(this.wallet.publicKey);
    const fee = 5000n; // one signature
    const send = lamports - fee;
    if (send <= 0n) return { sol: 0, tx: "" }; // nothing to send
    const blockhash = await this.rpc.getLatestBlockhash();
    const tx = signTransaction(buildTransferTx(this.wallet.publicKeyBytes, toBytes, send, blockhash), this.wallet);
    const sig = await this.rpc.sendTransaction(tx);
    await this.rpc.confirm(sig);
    log("trade", `withdrew ${Number(send) / 1e9} SOL to ${to} → ${sig}`);
    return { sol: Number(send) / 1e9, tx: sig };
  }
}
