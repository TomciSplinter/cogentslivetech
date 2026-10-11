// Fresh start for PRACTICE bots: balance back to the starting SOL, P&L / wins / losses / volume to zero,
// open bags dropped. Trade history stays in the database (the leaderboard counts from the reset).
// Real-money bots are never touched.
//   npm run reset-paper            all paper bots
//   npm run reset-paper -- vega    one bot
// Then: pm2 restart cogents
import { config } from "../src/config.ts";
import { fetchT } from "../src/util.ts";

const only = process.argv[2];
if (!config.supabaseUrl || !config.supabaseSecretKey) {
  console.log("Needs SUPABASE_URL and SUPABASE_SECRET_KEY in .env");
  process.exit(1);
}
const h: Record<string, string> = { apikey: config.supabaseSecretKey, "Content-Type": "application/json", Prefer: "return=representation" };
if (!config.supabaseSecretKey.startsWith("sb_")) h.Authorization = `Bearer ${config.supabaseSecretKey}`;
const q = `bots?mode=eq.paper&status=neq.deleted${only ? `&id=eq.${encodeURIComponent(only)}` : ""}`;
const bots: any[] = await (await fetchT(`${config.supabaseUrl}/rest/v1/${q}&select=id,name,mode`, { headers: h })).json();
if (!Array.isArray(bots) || !bots.length) {
  console.log(only ? `No paper bot called "${only}".` : "No paper bots found.");
  process.exit(1);
}
for (const b of bots) {
  await fetchT(`${config.supabaseUrl}/rest/v1/positions?bot_id=eq.${encodeURIComponent(b.id)}`, { method: "DELETE", headers: h });
  // status "new" makes the engine start this bot from scratch on its next boot
  const r = await fetchT(`${config.supabaseUrl}/rest/v1/bots?id=eq.${encodeURIComponent(b.id)}`, {
    method: "PATCH",
    headers: h,
    body: JSON.stringify({ status: "new", realized_pnl: 0, wins: 0, losses: 0, volume_sol: 0, withdrawn_sol: 0, trades_today: 0, thinking: "", watching_mint: null }),
  });
  console.log(`${r.ok ? "reset" : "FAILED"}  ${b.name} (${b.id})`);
}
console.log("\nNow restart the engine: pm2 restart cogents");
