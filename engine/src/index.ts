// Cogents engine: market feed, all bots (house + user-created), Cogents TV,
// Twitch chat, and the public API for the website.
//   npm start        → live pump.fun data
//   npm run demo     → simulated market (free, for testing)
import { startApi } from "./api.ts";
import { fetchDexStats, fetchSolUsd, fetchTokenPricesSol, solUsdNow } from "./solprice.ts";
import { createBrain } from "./brain.ts";
import { config, describeConfig } from "./config.ts";
import { BotManager } from "./manager.ts";
import { aggregateCandles, createMarket } from "./market.ts";
import { WalletWatcher } from "./wallets.ts";
import { hasMasterKey } from "./secrets.ts";
import { createStore, type CoinRow } from "./store.ts";
import { log } from "./util.ts";

async function main() {
  log("cogents", `starting engine\n  ${describeConfig()}`);
  if (config.userRealTradingEnabled && !hasMasterKey()) {
    log("cogents", "USER_REAL_TRADING_ENABLED needs a MASTER_KEY (openssl rand -hex 32). Real-money user bots stay off.");
  }
  const market = createMarket();
  const brain = createBrain();
  const store = createStore();
  const manager = new BotManager(market, brain, store);

  await manager.load();
  // remember the market from before the restart: without it, bots that want coins older than a few
  // minutes stare at an empty menu until the market grows back
  if (config.market === "pumpportal") {
    try {
      const n = market.remember(await store.recentCoins(180));
      if (n) log("market", `remembered ${n} recent coins from before the restart`);
    } catch (e) {
      log("market", "could not reload recent coins:", (e as Error).message);
    }
  }
  market.start();
  manager.start();

  // smart money: follow the wallets on-chain through the RPC websocket (any DEX, not just pump.fun)
  let wallets: WalletWatcher | undefined;
  if (config.smartWallets.length && config.solanaRpcUrl) {
    wallets = new WalletWatcher(config.solanaRpcUrl, config.smartWallets, (s) => market.ingestWalletSwap(s));
    wallets.start();
  }

  const timers: ReturnType<typeof setInterval>[] = [];

  // live coin snapshots for the website's charts (held + watched + top movers)
  timers.push(
    setInterval(async () => {
      try {
        if (config.market === "pumpportal") market.housekeeping(Date.now());
        market.setHeld(manager.allHeld());
        const mints = new Set<string>(manager.allHeld());
        for (const b of manager.bots.values()) if (b.watching) mints.add(b.watching);
        market.candidates(Date.now(), 60, 10).forEach((c) => mints.add(c.mint));
        market.smartCandidates(Date.now(), 6).forEach((c) => mints.add(c.mint));
        market.biggestYoung(Date.now()).forEach((c) => mints.add(c.mint)); // the market's memory across restarts
        const rows: CoinRow[] = [];
        const nowIso = new Date().toISOString();
        for (const m of mints) {
          const c = market.getCoin(m);
          if (!c) continue;
          rows.push({
            mint: c.mint,
            symbol: c.symbol,
            name: c.name,
            mcap_sol: c.mcapSol,
            price_sol: c.priceSol,
            progress: c.progress,
            created_at: new Date(c.createdAt).toISOString(),
            smart_buyers: c.smart.length ? market.smartStats(c, Date.now()).buyers.size : 0,
            history: c.history.slice(-180),
            // 5-second bars for tiles and sparklines; the live chart streams 1-second candles from the API
            candles: aggregateCandles(c.candles, 5_000)
              .slice(-72)
              .map((k) => [k[0], +k[1].toFixed(3), +k[2].toFixed(3), +k[3].toFixed(3), +k[4].toFixed(3), +k[5].toFixed(3)] as [number, number, number, number, number, number]),
            updated_at: nowIso,
          });
        }
        await store.upsertCoins(rows);
      } catch (e) {
        log("coins", "snapshot failed:", (e as Error).message);
      }
    }, 10_000),
  );

  // coins met through smart money that PumpPortal doesn't stream (e.g. on Raydium): price them via Jupiter
  if (config.smartWallets.length) {
    timers.push(
      setInterval(async () => {
        const mints = market.coinsNeedingPrice(Date.now());
        if (!mints.length) return;
        const prices = await fetchTokenPricesSol(mints);
        const now = Date.now();
        for (const [m, p] of prices) market.applyPrice(m, p, now);
      }, 5_000),
    );
  }

  // young coins that fell off the trade stream: refresh their stats from DexScreener so the
  // analyst-style bots can still find the ones that grew (market cap, volume, buys/sells)
  timers.push(
    setInterval(async () => {
      const solUsd = solUsdNow();
      const mints = market.coinsNeedingStats(Date.now());
      if (!mints.length || !solUsd) return;
      const stats = await fetchDexStats(mints, solUsd);
      const now = Date.now();
      for (const [m, e] of stats) market.applyExt(m, e, now);
    }, 20_000),
  );

  // SOL price in USD, so the website can show market caps in dollars
  const pushSolUsd = async () => {
    const usd = await fetchSolUsd();
    if (usd) await store.setSolUsd(usd).catch((e) => log("solusd", "save failed:", (e as Error).message));
  };
  pushSolUsd();
  timers.push(setInterval(pushSolUsd, 60_000));

  timers.push(setInterval(() => store.cleanup().catch((e) => log("store", "cleanup failed:", e.message)), 3600_000));

  const api = startApi(
    manager,
    () => ({
      market: config.market,
      coinsTracked: market.coins.size,
      tv: manager.tvBotId,
      bots: [...manager.bots.values()].map((b) => ({ id: b.def.id, house: b.def.house, mode: b.exec.mode, paused: !!b.def.paused, sol: b.state.solBalance, bags: b.state.positions.size, viewers: b.viewers })),
    }),
    market,
  );

  const shutdown = () => {
    log("cogents", "shutting down");
    wallets?.stop();
    timers.forEach(clearInterval);
    manager.stop();
    market.stop();
    api.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

process.on("unhandledRejection", (e) => log("cogents", "unhandled:", (e as Error)?.message ?? e));

main().catch((e) => {
  console.error(e);
  if (/column|schema cache|relation .* does not exist/i.test(String((e as Error)?.message ?? e))) {
    console.error("\nThe database is missing something this version needs. Run supabase/schema.sql again in the Supabase SQL Editor (safe to re-run), then restart.");
  }
  process.exit(1);
});
