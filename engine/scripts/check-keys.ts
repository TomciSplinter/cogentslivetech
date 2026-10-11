// Tests every API key in .env without spending real money.
//   npm run check-keys
import { config } from "../src/config.ts";
import { BOTS } from "../src/bots.ts";
import { botEnv } from "../src/config.ts";
import { walletFromSecret, Rpc } from "../src/solana.ts";
import { fetchT } from "../src/util.ts";

const results: [string, boolean, string][] = [];
const check = async (name: string, fn: () => Promise<string>) => {
  try {
    results.push([name, true, await fn()]);
  } catch (e) {
    results.push([name, false, (e as Error).message]);
  }
};

await check("Anthropic (AI brain)", async () => {
  if (!config.anthropicKey) throw new Error("ANTHROPIC_API_KEY missing");
  for (const model of [config.brainModel, config.chatModel]) {
    const r = await fetchT("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": config.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content: "Say ok" }] }),
    });
    if (!r.ok) throw new Error(`${model}: HTTP ${r.status} ${(await r.text()).slice(0, 150)}`);
  }
  return `models ${config.brainModel} and ${config.chatModel} work`;
});

await check("ElevenLabs (voices)", async () => {
  if (!config.elevenLabsKey) throw new Error("ELEVENLABS_API_KEY missing");
  const r = await fetchT("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": config.elevenLabsKey } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j: any = await r.json();
  const ids = new Set((j.voices ?? []).map((v: any) => v.voice_id));
  const missing = BOTS.filter((b) => !ids.has(botEnv(b.id, "VOICE_ID"))).map((b) => b.id);
  return missing.length ? `key works, but no voice set/found for: ${missing.join(", ")}` : "key works, all 3 voices found";
});

await check("Supabase (database)", async () => {
  if (!config.supabaseUrl || !config.supabaseSecretKey) throw new Error("SUPABASE_URL or SUPABASE_SECRET_KEY missing");
  const h: Record<string, string> = { apikey: config.supabaseSecretKey };
  if (!config.supabaseSecretKey.startsWith("sb_")) h.Authorization = `Bearer ${config.supabaseSecretKey}`;
  const r = await fetchT(`${config.supabaseUrl}/rest/v1/bots?select=id`, { headers: h });
  if (r.status === 404) throw new Error("tables not found, run supabase/schema.sql first");
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 150)}`);
  const b = await fetchT(`${config.supabaseUrl}/storage/v1/bucket/voice`, { headers: h });
  return b.ok ? "tables and voice bucket found" : "tables found, but the 'voice' storage bucket is missing";
});

await check("Solana RPC (Helius)", async () => {
  if (!config.solanaRpcUrl) throw new Error("SOLANA_RPC_URL missing");
  const slot = await new Rpc(config.solanaRpcUrl).call<number>("getSlot", []);
  return `connected, slot ${slot}`;
});

await check("PumpPortal (market data)", async () => {
  const url = `wss://pumpportal.fun/api/data${config.pumpPortalApiKey ? `?api-key=${config.pumpPortalApiKey}` : ""}`;
  const n = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url);
    let count = 0;
    const done = setTimeout(() => {
      ws.close();
      resolve(count);
    }, 15_000);
    ws.onopen = () => ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    ws.onmessage = (m) => {
      try {
        if (JSON.parse(String(m.data)).txType === "create") count++;
      } catch {}
    };
    ws.onerror = () => {
      clearTimeout(done);
      reject(new Error("could not connect"));
    };
  });
  const keyNote = config.pumpPortalApiKey ? "" : " (no PUMPPORTAL_API_KEY: bots will only see launches, not live trades)";
  return `${n} new coins seen in 15s${keyNote}`;
});

await check("Create-a-bot settings", async () => {
  const notes: string[] = [];
  if (!config.userBotsEnabled) return "user bots switched off";
  if (config.allowedOrigins.includes("*")) notes.push("ALLOWED_ORIGINS is * (set it to your website address)");
  if (!config.userVoices.length) notes.push("no USER_VOICES, user bots will use text only");
  if (config.userRealTradingEnabled && !/^[0-9a-fA-F]{64}$/.test(config.masterKey)) throw new Error("USER_REAL_TRADING_ENABLED needs MASTER_KEY (openssl rand -hex 32)");
  return notes.length ? `on, but: ${notes.join("; ")}` : `on (max ${config.maxUserBots} bots, ${config.maxBotsPerWallet} per wallet)`;
});

await check("Smart money (VEGA copies)", async () => {
  const n = config.smartWallets.length;
  if (!n) throw new Error("no wallets: add addresses to smart-wallets.txt (one per line)");
  if (!config.solanaRpcUrl) throw new Error(`${n} wallets listed, but following them on-chain needs SOLANA_RPC_URL`);
  const { probeWalletStream } = await import("../src/wallets.ts");
  await probeWalletStream(config.solanaRpcUrl, config.smartWallets[0]);
  return `${n} wallets followed on-chain`;
});

await check("Twitch chat", async () => {
  if (!config.twitchChannel) return "off (TWITCH_CHANNEL empty)";
  const ok = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    const t = setTimeout(() => (ws.close(), resolve(false)), 10_000);
    ws.onopen = () => {
      if (config.twitchBotUsername && config.twitchOauthToken) {
        ws.send(`PASS ${config.twitchOauthToken.startsWith("oauth:") ? config.twitchOauthToken : `oauth:${config.twitchOauthToken}`}`);
        ws.send(`NICK ${config.twitchBotUsername}`);
      } else ws.send("NICK justinfan54321");
    };
    ws.onmessage = (m) => {
      const s = String(m.data);
      if (s.includes(" 001 ")) (clearTimeout(t), ws.close(), resolve(true));
      if (s.includes("authentication failed")) (clearTimeout(t), ws.close(), resolve(false));
    };
    ws.onerror = () => (clearTimeout(t), resolve(false));
  });
  if (!ok) throw new Error(config.twitchOauthToken ? "login failed, check TWITCH_BOT_USERNAME / TWITCH_OAUTH_TOKEN" : "couldn't reach Twitch chat");
  return `#${config.twitchChannel}, ${config.twitchOauthToken ? "bots can read and reply" : "bots read chat (replies only on stream)"}`;
});

for (const b of BOTS) {
  const secret = botEnv(b.id, "SECRET_KEY");
  if (!secret) continue;
  await check(`Wallet ${b.name}`, async () => {
    const w = walletFromSecret(secret);
    const bal = config.solanaRpcUrl ? await new Rpc(config.solanaRpcUrl).getSolBalance(w.publicKey) : NaN;
    return `${w.publicKey}, balance ${Number.isNaN(bal) ? "?" : bal.toFixed(4)} SOL, mode ${botEnv(b.id, "MODE") || "paper"}`;
  });
}

console.log("\nCogents key check\n-----------------");
for (const [name, ok, msg] of results) console.log(`${ok ? "✅" : "❌"} ${name}: ${msg}`);
console.log(`\nReal trading: ${config.realTradingEnabled ? "ENABLED" : "off (paper mode)"}\n`);
process.exit(results.every((r) => r[1]) ? 0 : 1);
