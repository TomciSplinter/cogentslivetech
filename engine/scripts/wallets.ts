// Smart-money scorecard: how each followed wallet has worked out for the bots that copied it.
//   npm run wallets            (last 7 days)
//   npm run wallets -- 30      (last 30 days)
// Reads the trades table: buys tagged "smart:<wallet>" and the sell that closed each bag.
import { config } from "../src/config.ts";
import { fetchT } from "../src/util.ts";

const days = Number(process.argv[2] ?? 7) || 7;
if (!config.supabaseUrl || !config.supabaseSecretKey) {
  console.log("Needs SUPABASE_URL and SUPABASE_SECRET_KEY in .env");
  process.exit(1);
}
const h: Record<string, string> = { apikey: config.supabaseSecretKey };
if (!config.supabaseSecretKey.startsWith("sb_")) h.Authorization = `Bearer ${config.supabaseSecretKey}`;
const since = new Date(Date.now() - days * 86400_000).toISOString();
const r = await fetchT(`${config.supabaseUrl}/rest/v1/trades?select=bot_id,mint,symbol,side,sol,pnl_sol,reason,created_at&created_at=gte.${since}&order=created_at.asc&limit=20000`, { headers: h });
if (!r.ok) {
  console.log("Could not read trades:", r.status, await r.text());
  process.exit(1);
}
const trades: any[] = await r.json();

// pair each tagged buy with the next sell of the same bot+mint
type Row = { wallet: string; signals: number; wins: number; losses: number; pnl: number; holdMin: number[]; open: number; bots: Set<string> };
const rows = new Map<string, Row>();
const pending = new Map<string, { wallet: string; t: number }>(); // bot:mint -> waiting for its sell
for (const t of trades) {
  const key = `${t.bot_id}:${t.mint}`;
  if (t.side === "buy" && typeof t.reason === "string" && t.reason.startsWith("smart:")) {
    const wallet = t.reason.slice(6);
    const row = rows.get(wallet) ?? { wallet, signals: 0, wins: 0, losses: 0, pnl: 0, holdMin: [], open: 0, bots: new Set() };
    row.signals++;
    row.open++;
    row.bots.add(t.bot_id);
    rows.set(wallet, row);
    pending.set(key, { wallet, t: Date.parse(t.created_at) });
  } else if (t.side === "sell" && pending.has(key)) {
    const { wallet, t: t0 } = pending.get(key)!;
    pending.delete(key);
    const row = rows.get(wallet)!;
    const pnl = Number(t.pnl_sol ?? 0);
    row.pnl += pnl;
    row.open--;
    if (pnl > 0) row.wins++;
    else row.losses++;
    row.holdMin.push((Date.parse(t.created_at) - t0) / 60_000);
  }
}

const list = [...rows.values()].sort((a, b) => b.pnl - a.pnl);
const known = new Set(config.smartWallets);
console.log(`\nSmart-money scorecard, last ${days} day${days === 1 ? "" : "s"} (${list.length} wallets produced signals the bots acted on)\n`);
if (!list.length) console.log("No copied trades yet. Buys the bots make on a followed wallet's signal are tagged, give it a day.");
else {
  const pad = (s: string | number, n: number, right = false) => (right ? String(s).padStart(n) : String(s).padEnd(n));
  console.log(`${pad("wallet", 14)} ${pad("copied", 7, true)} ${pad("closed", 7, true)} ${pad("win%", 6, true)} ${pad("pnl SOL", 9, true)} ${pad("avg hold", 9, true)}  bots`);
  for (const w of list) {
    const closed = w.wins + w.losses;
    const win = closed ? Math.round((100 * w.wins) / closed) : 0;
    const hold = w.holdMin.length ? `${(w.holdMin.reduce((a, b) => a + b, 0) / w.holdMin.length).toFixed(1)}m` : "–";
    const tag = known.has(w.wallet) ? "" : "  (no longer followed)";
    console.log(`${pad(`${w.wallet.slice(0, 5)}…${w.wallet.slice(-4)}`, 14)} ${pad(w.signals, 7, true)} ${pad(closed, 7, true)} ${pad(closed ? `${win}%` : "–", 6, true)} ${pad((w.pnl >= 0 ? "+" : "") + w.pnl.toFixed(3), 9, true)} ${pad(hold, 9, true)}  ${[...w.bots].join(",")}${tag}`);
  }
  console.log(`\nFull addresses of the worst three (consider removing from smart-wallets.txt):`);
  for (const w of list.slice(-3).reverse()) if (w.pnl < 0) console.log(`  ${w.wallet}  ${w.pnl.toFixed(3)} SOL`);
  const quiet = config.smartWallets.filter((w) => !rows.has(w));
  if (quiet.length) console.log(`\n${quiet.length} followed wallet${quiet.length === 1 ? "" : "s"} produced no copied trade in this window.`);
}
