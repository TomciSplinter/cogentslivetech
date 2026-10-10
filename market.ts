// Market data: keeps a live picture of fresh pump.fun coins.
//
// PumpPortalMarket streams real data. MockMarket simulates coins (pumps, dumps,
// rugs) so you can test everything for free.
import { config } from "./config.ts";
import { log, round, clamp } from "./util.ts";

const TOTAL_SUPPLY = 1_000_000_000; // pump.fun coins have a fixed 1B supply

export interface TradeEvent {
  t: number;
  side: "buy" | "sell";
  sol: number;
  trader: string;
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
  candles: Candle[]; // 15-second OHLC candles in market cap (SOL), built from every trade
  devSold: boolean;
  migrated: boolean;
}

/** [bucket start ms, open, high, low, close, volume SOL]; prices are market cap in SOL. */
export type Candle = [number, number, number, number, number, number];
export const CANDLE_MS = 15_000;
const MAX_CANDLES = 240; // one hour

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
}

export abstract class Market {
  coins = new Map<string, Coin>();
  protected held = new Set<string>();

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
    };
  }

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
    out.sort((a, b) => b.vol5mSol - a.vol5mSol || b.buys5m - a.buys5m);
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
    };
    addToCandles(coin, now, mcap, Number(e.solAmount) || 0);
    if (Number(e.solAmount) > 0) {
      coin.trades.push({ t: now, side: "buy", sol: Number(e.solAmount), trader: coin.creator });
    }
    this.coins.set(coin.mint, coin);
    this.syncSubscriptions();
  }

  protected onTrade(e: any, now: number) {
    const c = this.coins.get(e.mint);
    if (!c) return;
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
      const stale = now - c.lastTradeAt > 30 * 60_000 || now - c.createdAt > 6 * 3600_000;
      if (stale && !this.held.has(mint)) this.coins.delete(mint);
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

    const want = new Set<string>(this.held);
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
        { mint: c.mint, txType: ret >= 0 ? "buy" : "sell", solAmount: sol, traderPublicKey: trader, marketCapSol: mcap, vSolInBondingCurve: 30 + mcap / 4 },
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
