// Market data: keeps a live picture of fresh pump.fun coins.
//
// PumpPortalMarket streams real data. MockMarket simulates coins (pumps, dumps,
// rugs) so you can test everything for free.
import { config } from "./config.ts";
import { fetchT, log, round, clamp } from "./util.ts";

const TOTAL_SUPPLY = 1_000_000_000; // pump.fun coins have a fixed 1B supply

export interface TradeEvent {
  t: number;
  side: "buy" | "sell";
  sol: number;
  trader: string;
}

/** A trade by one of the followed smart-money wallets. */
export interface SmartTrade {
  t: number;
  wallet: string;
  side: "buy" | "sell";
  sol: number;
}

export interface Coin {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  createdAt: number;
  mcapSol: number;
  priceSol: number; // SOL per token
  progress: number; // bonding curve progress, approx 0-100
  lastTradeAt: number;
  trades: TradeEvent[]; // recent trades (last 15 min)
  history: [number, number][]; // [timeMs, priceSol] samples for charts
  candles: Candle[]; // 1-second OHLC candles in market cap (SOL), built from every trade
  devSold: boolean;
  migrated: boolean;
  smart: SmartTrade[]; // trades by followed wallets (last 60 min)
  ageUnknown?: boolean; // first seen through a smart wallet's trade, not at launch
  metaPending?: boolean;
}

/** [bucket start ms, open, high, low, close, volume SOL]; prices are market cap in SOL. */
export type Candle = [number, number, number, number, number, number];
export const CANDLE_MS = 1_000;
const MAX_CANDLES = 1800; // 30 minutes of 1-second candles

/** Merge candles into coarser buckets (e.g. 5s bars for the database snapshot). */
export function aggregateCandles(candles: Candle[], ms: number): Candle[] {
  const out: Candle[] = [];
  for (const k of candles) {
    const b = k[0] - (k[0] % ms);
    const last = out[out.length - 1];
    if (last && last[0] === b) {
      last[2] = Math.max(last[2], k[2]);
      last[3] = Math.min(last[3], k[3]);
      last[4] = k[4];
      last[5] += k[5];
    } else out.push([b, k[1], k[2], k[3], k[4], k[5]]);
  }
  return out;
}

function addToCandles(c: Coin, t: number, mcap: number, volSol: number) {
  const bucket = t - (t % CANDLE_MS);
  const last = c.candles[c.candles.length - 1];
  if (last && last[0] === bucket) {
    last[2] = Math.max(last[2], mcap);
    last[3] = Math.min(last[3], mcap);
    last[4] = mcap;
    last[5] += volSol;
  } else {
    const open = last ? last[4] : mcap;
    c.candles.push([bucket, open, Math.max(open, mcap), Math.min(open, mcap), mcap, volSol]);
    if (c.candles.length > MAX_CANDLES) c.candles.splice(0, c.candles.length - MAX_CANDLES);
  }
}

/** Numbers the AI sees about each coin. */
export interface CoinStats {
  mint: string;
  symbol: string;
  name: string;
  ageMin: number;
  mcapSol: number;
  change5mPct: number;
  vol5mSol: number;
  buys5m: number;
  sells5m: number;
  uniqueBuyers5m: number;
  lastTradeAgoSec: number;
  curvePct: number;
  devSold: boolean;
  ageUnknown?: boolean;
  /** Smart money in the last 10 minutes: distinct wallets buying/selling, net SOL, who */
  smartBuyers10m: number;
  smartSellers10m: number;
  smartNetSol10m: number;
  smartLastBuyAgoSec?: number;
  smartWallets?: string[];
  smartSignalWallet?: string; // the followed wallet whose buy is the freshest signal
}

export type TickListener = (coin: Coin, now: number) => void;
export type SmartListener = (coin: Coin, trade: SmartTrade) => void;

export abstract class Market {
  coins = new Map<string, Coin>();
  protected held = new Set<string>();
  private tickListeners = new Set<TickListener>();
  private smartListeners = new Set<SmartListener>();
  protected smartWallets = new Set<string>(config.smartWallets);
  private seenSigs: string[] = [];
  private seenSigSet = new Set<string>();

  /** Wallets whose trades count as smart money. */
  setSmartWallets(wallets: string[]) {
    this.smartWallets = new Set(wallets);
    this.syncSubscriptions(true);
  }
  get smartWalletCount() {
    return this.smartWallets.size;
  }
  /** Called when a followed wallet trades (copy-traders react to this immediately). */
  onSmart(fn: SmartListener): () => void {
    this.smartListeners.add(fn);
    return () => this.smartListeners.delete(fn);
  }
  /** A trade may arrive twice (coin stream + wallet stream): remember recent signatures. */
  protected seenBefore(sig: unknown): boolean {
    if (typeof sig !== "string" || !sig) return false;
    if (this.seenSigSet.has(sig)) return true;
    this.seenSigSet.add(sig);
    this.seenSigs.push(sig);
    if (this.seenSigs.length > 5000) this.seenSigSet.delete(this.seenSigs.shift()!);
    return false;
  }
  /** A followed wallet's swap seen on-chain (any DEX): feed it in like a trade event. */
  ingestWalletSwap(s: { signature: string; wallet: string; mint: string; side: "buy" | "sell"; sol: number; tokens: number; priceSol: number; t: number }) {
    const mcap = s.priceSol > 0 ? s.priceSol * TOTAL_SUPPLY : undefined;
    this.onTrade({ signature: s.signature, mint: s.mint, txType: s.side, solAmount: s.sol, tokenAmount: s.tokens, traderPublicKey: s.wallet, marketCapSol: mcap }, Date.now());
  }

  /** A price from an outside source (Jupiter) for a coin we don't get a trade stream for. */
  applyPrice(mint: string, priceSol: number, now: number) {
    const c = this.coins.get(mint);
    if (!c || !(priceSol > 0)) return;
    const mcap = priceSol * TOTAL_SUPPLY;
    if (Math.abs(mcap - c.mcapSol) / (c.mcapSol || 1) < 1e-6) return;
    c.priceSol = priceSol;
    c.mcapSol = mcap;
    addToCandles(c, now, mcap, 0);
    if (this.tickListeners.size) for (const fn of this.tickListeners) fn(c, now);
  }
  /** Coins that need an outside price: met through smart money and not streaming trades. */
  coinsNeedingPrice(now: number): string[] {
    const out: string[] = [];
    for (const c of this.coins.values()) {
      if (!c.ageUnknown) continue;
      const streaming = c.trades.some((t) => now - t.t < 60_000 && !this.smartWallets.has(t.trader));
      const wanted = this.held.has(c.mint) || (c.smart.length && now - c.smart[c.smart.length - 1].t < 15 * 60_000);
      if (wanted && !streaming) out.push(c.mint);
    }
    return out.slice(0, 50);
  }

  /** Smart-money view of a coin over the last `windowMs`. */
  smartStats(c: Coin, now: number, windowMs = 10 * 60_000) {
    const recent = c.smart.filter((t) => now - t.t <= windowMs);
    const buyers = new Set(recent.filter((t) => t.side === "buy").map((t) => t.wallet));
    const sellers = new Set(recent.filter((t) => t.side === "sell").map((t) => t.wallet));
    const net = recent.reduce((s, t) => s + (t.side === "buy" ? t.sol : -t.sol), 0);
    const lastBuy = [...recent].reverse().find((t) => t.side === "buy");
    return { buyers, sellers, net, lastBuy };
  }
  /**
   * Coins smart money is buying right now, freshest first: the copy-trader's menu.
   * Coins where more followed wallets sold than bought lately are left out.
   */
  smartCandidates(now: number, limit = 8, windowMs = 10 * 60_000): CoinStats[] {
    const out: CoinStats[] = [];
    for (const c of this.coins.values()) {
      if (c.migrated || !c.smart.length) continue;
      const st = this.smartStats(c, now, windowMs);
      if (!st.buyers.size || st.sellers.size >= st.buyers.size && st.net <= 0) continue;
      if (!st.lastBuy) continue;
      // flippers: a wallet that already sold this coin in the last 5 minutes is scalping it, not holding it
      const recentSellers = new Set(c.smart.filter((t) => t.side === "sell" && now - t.t < 5 * 60_000).map((t) => t.wallet));
      const holders = [...st.buyers].filter((w) => !recentSellers.has(w));
      if (!holders.length) continue;
      out.push(this.stats(c, now));
    }
    out.sort((a, b) => b.smartBuyers10m - a.smartBuyers10m || (a.smartLastBuyAgoSec ?? 1e9) - (b.smartLastBuyAgoSec ?? 1e9));
    return out.slice(0, limit);
  }
  /** True when the followed wallets that were in this coin have been leaving since `sinceMs`. */
  smartExiting(mint: string, sinceMs: number, now: number): boolean {
    const c = this.coins.get(mint);
    if (!c) return false;
    const since = c.smart.filter((t) => t.t >= sinceMs - 10 * 60_000);
    const buyers = new Set(since.filter((t) => t.side === "buy").map((t) => t.wallet));
    const sellers = new Set(since.filter((t) => t.side === "sell" && t.t >= sinceMs).map((t) => t.wallet));
    if (!buyers.size) return false;
    const soldSol = since.filter((t) => t.side === "sell" && t.t >= sinceMs).reduce((s, t) => s + t.sol, 0);
    const boughtSol = since.filter((t) => t.side === "buy").reduce((s, t) => s + t.sol, 0);
    return sellers.size * 2 >= buyers.size || (boughtSol > 0 && soldSol >= boughtSol * 0.5);
  }

  /** Called after every trade on any coin (the live chart feed hangs off this). */
  onTick(fn: TickListener): () => void {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }

  abstract start(): void;
  abstract stop(): void;

  /** Coins the bots currently hold: always keep these updated. */
  setHeld(mints: string[]) {
    this.held = new Set(mints);
    this.syncSubscriptions();
  }
  protected syncSubscriptions() {}

  getCoin(mint: string) {
    return this.coins.get(mint);
  }

  priceOf(mint: string): number | undefined {
    return this.coins.get(mint)?.priceSol;
  }

  stats(c: Coin, now: number): CoinStats {
    const cutoff = now - 5 * 60_000;
    const recent = c.trades.filter((t) => t.t >= cutoff);
    const buys = recent.filter((t) => t.side === "buy");
    const old = c.history.find(([t]) => t >= cutoff);
    const ref = old ? old[1] : c.history[0]?.[1] ?? c.priceSol;
    return {
      mint: c.mint,
      symbol: c.symbol,
      name: c.name,
      ageMin: round((now - c.createdAt) / 60_000, 1),
      mcapSol: round(c.mcapSol, 1),
      change5mPct: ref > 0 ? round(((c.priceSol - ref) / ref) * 100, 1) : 0,
      vol5mSol: round(recent.reduce((s, t) => s + t.sol, 0), 2),
      buys5m: buys.length,
      sells5m: recent.length - buys.length,
      uniqueBuyers5m: new Set(buys.map((t) => t.trader)).size,
      lastTradeAgoSec: Math.round((now - c.lastTradeAt) / 1000),
      curvePct: round(c.progress, 1),
      devSold: c.devSold,
      ageUnknown: c.ageUnknown,
      ...this.smartSummary(c, now),
    };
  }

  private smartSummary(c: Coin, now: number) {
    if (!c.smart.length) return { smartBuyers10m: 0, smartSellers10m: 0, smartNetSol10m: 0 };
    const st = this.smartStats(c, now);
    return {
      smartBuyers10m: st.buyers.size,
      smartSellers10m: st.sellers.size,
      smartNetSol10m: round(st.net, 3),
      smartLastBuyAgoSec: st.lastBuy ? Math.round((now - st.lastBuy.t) / 1000) : undefined,
      smartWallets: [...st.buyers].slice(0, 3).map((w) => `${w.slice(0, 4)}…${w.slice(-4)}`),
      smartSignalWallet: st.lastBuy?.wallet,
    };
  }

  /** A coin we first hear about through a followed wallet's trade: create it from the trade. */
  protected coinFromTrade(e: any, now: number): Coin {
    const mcap = Number(e.marketCapSol) || 30;
    const coin: Coin = {
      mint: e.mint,
      symbol: String(e.symbol ?? "").slice(0, 16) || `${String(e.mint).slice(0, 4)}…`,
      name: String(e.name ?? "").slice(0, 40),
      creator: "",
      createdAt: now,
      ageUnknown: true,
      metaPending: !e.symbol,
      mcapSol: mcap,
      priceSol: mcap / TOTAL_SUPPLY,
      progress: curveProgress(e),
      lastTradeAt: now,
      trades: [],
      history: [[now, mcap / TOTAL_SUPPLY]],
      candles: [],
      devSold: false,
      migrated: !!(e.pool && e.pool !== "pump"),
      smart: [],
    };
    this.coins.set(coin.mint, coin);
    return coin;
  }
  /** Fill in symbol/name for coins created from a trade (overridden by the live market). */
  protected resolveMeta(_c: Coin) {}

  /** The "menu" a bot may pick from: young, active coins, most active first. */
  candidates(now: number, maxAgeMin: number, limit = 8): CoinStats[] {
    const out: CoinStats[] = [];
    for (const c of this.coins.values()) {
      if (c.migrated) continue;
      const ageMin = (now - c.createdAt) / 60_000;
      if (ageMin > maxAgeMin) continue;
      if (now - c.lastTradeAt > 5 * 60_000) continue;
      out.push(this.stats(c, now));
    }
    // real interest first: distinct buyers beat raw volume (one whale or the dev can fake volume);
    // coins whose creator already sold go to the bottom
    out.sort((a, b) => Number(a.devSold) - Number(b.devSold) || b.uniqueBuyers5m - a.uniqueBuyers5m || b.vol5mSol - a.vol5mSol);
    return out.slice(0, limit);
  }

  // ---- event handling shared by real and mock feeds ----

  protected onCreate(e: any, now: number) {
    if (!e.mint || this.coins.has(e.mint)) return;
    const mcap = Number(e.marketCapSol) || 28;
    const coin: Coin = {
      mint: e.mint,
      symbol: String(e.symbol ?? "???").slice(0, 16),
      name: String(e.name ?? "").slice(0, 40),
      creator: e.traderPublicKey ?? "",
      createdAt: now,
      mcapSol: mcap,
      priceSol: mcap / TOTAL_SUPPLY,
      progress: curveProgress(e),
      lastTradeAt: now,
      trades: [],
      history: [[now, mcap / TOTAL_SUPPLY]],
      candles: [],
      devSold: false,
      migrated: false,
      smart: [],
    };
    addToCandles(coin, now, mcap, Number(e.solAmount) || 0);
    if (Number(e.solAmount) > 0) {
      coin.trades.push({ t: now, side: "buy", sol: Number(e.solAmount), trader: coin.creator });
    }
    this.coins.set(coin.mint, coin);
    this.syncSubscriptions();
  }

  protected onTrade(e: any, now: number) {
    if (!e.mint || this.seenBefore(e.signature)) return;
    const trader: string = e.traderPublicKey ?? "";
    const smart = !!trader && this.smartWallets.has(trader);
    let c = this.coins.get(e.mint);
    if (!c) {
      if (!smart) return;
      c = this.coinFromTrade(e, now);
      this.resolveMeta(c);
    }
    const mcap = Number(e.marketCapSol);
    if (mcap > 0) {
      c.mcapSol = mcap;
      c.priceSol = mcap / TOTAL_SUPPLY;
      addToCandles(c, now, mcap, Number(e.solAmount) || 0);
    }
    const p = curveProgress(e);
    if (p > 0) c.progress = p;
    if (e.pool && e.pool !== "pump") c.migrated = true;
    c.lastTradeAt = now;
    const side = e.txType === "sell" ? "sell" : "buy";
    c.trades.push({ t: now, side, sol: Number(e.solAmount) || 0, trader: e.traderPublicKey ?? "" });
    if (side === "sell" && e.traderPublicKey && e.traderPublicKey === c.creator) c.devSold = true;
    if (smart) {
      const st: SmartTrade = { t: now, wallet: trader, side, sol: Number(e.solAmount) || 0 };
      c.smart.push(st);
      if (c.smart.length > 200) c.smart.splice(0, c.smart.length - 200);
      this.syncSubscriptions();
      for (const fn of this.smartListeners) fn(c, st);
    }
    if (this.tickListeners.size) for (const fn of this.tickListeners) fn(c, now);
  }

  protected onMigration(e: any) {
    const c = this.coins.get(e.mint);
    if (c) c.migrated = true;
  }

  /** Sample prices for charts and drop old data. Call every few seconds. */
  housekeeping(now: number) {
    for (const [mint, c] of this.coins) {
      const last = c.history[c.history.length - 1];
      if (!last || now - last[0] >= 10_000) c.history.push([now, c.priceSol]);
      if (c.history.length > 360) c.history.splice(0, c.history.length - 360);
      c.trades = c.trades.filter((t) => now - t.t < 15 * 60_000);
      if (c.smart.length) c.smart = c.smart.filter((t) => now - t.t < 60 * 60_000);
      const smartActive = c.smart.length > 0;
      const stale = now - c.lastTradeAt > 30 * 60_000 || (now - c.createdAt > 6 * 3600_000 && !smartActive);
      if (stale && !this.held.has(mint) && !smartActive) this.coins.delete(mint);
    }
    // keep memory bounded
    if (this.coins.size > 600) {
      const sorted = [...this.coins.values()].sort((a, b) => a.lastTradeAt - b.lastTradeAt);
      for (const c of sorted.slice(0, this.coins.size - 600)) {
        if (!this.held.has(c.mint)) this.coins.delete(c.mint);
      }
    }
    this.syncSubscriptions();
  }
}

/** Approximate bonding curve progress from virtual SOL reserves (30 at launch, ~115 at graduation). */
function curveProgress(e: any): number {
  const vSol = Number(e.vSolInBondingCurve);
  if (!(vSol > 0)) return 0;
  return clamp(((vSol - 30) / 85) * 100, 0, 100);
}

// ---------------------------------------------------------------------------

export class PumpPortalMarket extends Market {
  private ws?: WebSocket;
  private subscribed = new Set<string>();
  private accountSubs = new Set<string>();
  private metaInFlight = new Set<string>();
  private stopped = false;
  private lastSync = 0;
  private reconnectDelay = 2000;

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  private connect() {
    const key = config.pumpPortalApiKey;
    const url = `wss://pumpportal.fun/api/data${key ? `?api-key=${encodeURIComponent(key)}` : ""}`;
    log("market", "connecting to PumpPortal…");
    const ws = new WebSocket(url);
    this.ws = ws;
    this.subscribed.clear();

    ws.onopen = () => {
      log("market", "connected");
      this.reconnectDelay = 2000;
      this.send({ method: "subscribeNewToken" });
      this.send({ method: "subscribeMigration" });
      this.accountSubs.clear();
      this.syncSubscriptions(true);
    };
    ws.onmessage = (msg) => {
      let e: any;
      try {
        e = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (!e || typeof e !== "object") return;
      const now = Date.now();
      if (e.txType === "create") this.onCreate(e, now);
      else if (e.txType === "buy" || e.txType === "sell") this.onTrade(e, now);
      else if (e.txType === "migrate" || e.method === "migration") this.onMigration(e);
      else if (e.message || e.errors) log("market", "PumpPortal says:", e.message ?? e.errors);
    };
    ws.onclose = () => {
      if (this.stopped) return;
      log("market", `disconnected, retrying in ${this.reconnectDelay / 1000}s`);
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
    };
    ws.onerror = () => {}; // onclose handles reconnects
  }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /** Symbol and name for a coin we met through a wallet's trade, from the token metadata (Helius DAS). */
  protected resolveMeta(c: Coin) {
    if (!c.metaPending || !config.solanaRpcUrl || this.metaInFlight.has(c.mint)) return;
    this.metaInFlight.add(c.mint);
    fetchT(config.solanaRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: c.mint } }),
    })
      .then((r) => r.json())
      .then((j: any) => {
        const m = j?.result?.content?.metadata ?? {};
        if (m.symbol) c.symbol = String(m.symbol).slice(0, 16);
        if (m.name) c.name = String(m.name).slice(0, 40);
        const auth = j?.result?.authorities?.[0]?.address;
        if (auth && !c.creator) c.creator = String(auth);
        c.metaPending = false;
      })
      .catch(() => {})
      .finally(() => this.metaInFlight.delete(c.mint));
  }

  /**
   * Stream trades for: every held coin + the newest coins (up to WATCHLIST_SIZE).
   * Uses ONE connection, as PumpPortal requires.
   */
  protected syncSubscriptions(force = false) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (!force && now - this.lastSync < 3000) return;
    this.lastSync = now;

    if (!config.pumpPortalApiKey) return; // trade streams need a key

    // followed wallets: one subscription per wallet, kept in sync with the list
    const wantAcc = [...this.smartWallets].filter((w) => !this.accountSubs.has(w));
    const dropAcc = [...this.accountSubs].filter((w) => !this.smartWallets.has(w));
    if (dropAcc.length) {
      this.send({ method: "unsubscribeAccountTrade", keys: dropAcc });
      dropAcc.forEach((w) => this.accountSubs.delete(w));
    }
    if (wantAcc.length) {
      this.send({ method: "subscribeAccountTrade", keys: wantAcc });
      wantAcc.forEach((w) => this.accountSubs.add(w));
    }

    const want = new Set<string>(this.held);
    // coins smart money touched in the last 10 minutes: stream them so the chart and exits are live
    for (const c of this.coins.values()) if (c.smart.length && now - c.smart[c.smart.length - 1].t < 10 * 60_000 && !c.migrated) want.add(c.mint);
    const newest = [...this.coins.values()]
      .filter((c) => !c.migrated)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, config.watchlistSize);
    for (const c of newest) want.add(c.mint);

    const add = [...want].filter((m) => !this.subscribed.has(m));
    const drop = [...this.subscribed].filter((m) => !want.has(m));
    if (drop.length) {
      this.send({ method: "unsubscribeTokenTrade", keys: drop });
      drop.forEach((m) => this.subscribed.delete(m));
    }
    if (add.length) {
      this.send({ method: "subscribeTokenTrade", keys: add });
      add.forEach((m) => this.subscribed.add(m));
    }
  }
}

// ---------------------------------------------------------------------------

const MOCK_WORDS = [
  "CAT", "FROG", "BOB", "MOON", "PEPE", "WIF", "CHAD", "GOAT", "TOAD", "DUCK", "BONK", "MEOW",
  "APE", "ZOOM", "GLOB", "NOOT", "FISH", "BEAR", "PIGGY", "CHUD", "SNEK", "BUG", "KEK", "LOAF",
];

function rand(seed: { s: number }) {
  // small deterministic PRNG so tests are repeatable
  seed.s = (seed.s * 1664525 + 1013904223) % 4294967296;
  return seed.s / 4294967296;
}

interface MockCoinState {
  drift: number;
  vol: number;
  rugAt?: number;
}

/** A fake market: new coins appear, some pump, most fade, a few rug. */
export class MockMarket extends Market {
  private mockSig = 0;
  private timer?: ReturnType<typeof setInterval>;
  private seed = { s: 42 };
  private sim = new Map<string, MockCoinState>();
  private n = 0;

  constructor(seed = 42) {
    super();
    this.seed.s = seed;
  }

  start() {
    log("market", "using SIMULATED market (MARKET=mock)");
    let now = Date.now();
    // seed a few coins of different ages
    for (let i = 0; i < 8; i++) this.spawn(now - (8 - i) * 60_000);
    this.timer = setInterval(() => this.step(Date.now()), 2000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private spawn(now: number) {
    const r = () => rand(this.seed);
    const sym = MOCK_WORDS[Math.floor(r() * MOCK_WORDS.length)] + (r() < 0.4 ? String(Math.floor(r() * 99)) : "");
    const mint = `Mock${(++this.n).toString().padStart(4, "0")}${Math.floor(r() * 1e9).toString(36)}pump`;
    const creator = `dev${this.n}`;
    this.onCreate(
      { mint, symbol: sym, name: `${sym} coin`, traderPublicKey: creator, marketCapSol: 28 + r() * 4, solAmount: r() * 2, vSolInBondingCurve: 30 + r() * 3 },
      now,
    );
    const roll = r();
    this.sim.set(mint, {
      drift: roll < 0.2 ? 0.03 : roll < 0.5 ? 0.006 : -0.01, // runner, steady, fader
      vol: 0.03 + r() * 0.06,
      rugAt: r() < 0.15 ? now + (2 + r() * 10) * 60_000 : undefined,
    });
  }

  /** Advance the simulation. Public so tests can drive time manually. */
  step(now: number) {
    const r = () => rand(this.seed);
    if (r() < 0.12) this.spawn(now);
    this.mockSig++;
    for (const c of this.coins.values()) {
      const s = this.sim.get(c.mint);
      if (!s || c.migrated) continue;
      const ageMin = (now - c.createdAt) / 60_000;
      const activity = Math.max(0.05, 1 - ageMin / 40);
      if (r() > activity) continue;
      let ret = s.drift * (1 - ageMin / 60) + (r() - 0.5) * 2 * s.vol;
      let trader = `w${Math.floor(r() * 400)}`;
      if (s.rugAt && now >= s.rugAt) {
        ret = -0.85; // rug pull
        trader = c.creator;
        s.rugAt = undefined;
        s.drift = -0.02;
      }
      const mcap = Math.max(4, c.mcapSol * (1 + ret));
      const sol = Math.abs(mcap - c.mcapSol) * 0.08 + r() * 0.5;
      this.onTrade(
        { signature: `mock${this.mockSig}-${c.mint}`, mint: c.mint, txType: ret >= 0 ? "buy" : "sell", solAmount: sol, traderPublicKey: trader, marketCapSol: mcap, vSolInBondingCurve: 30 + mcap / 4 },
        now,
      );
      if (mcap > 420) this.onMigration({ mint: c.mint });
    }
    this.housekeeping(now);
  }
}

export function createMarket(): Market {
  return config.market === "mock" ? new MockMarket(Date.now() % 100000) : new PumpPortalMarket();
}
