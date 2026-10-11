// Real-money flow test against a FAKE Solana chain + fake PumpPortal running locally.
// The fake chain checks every signature and moves balances like the real one would,
// so this exercises the exact code that will sign and send real transactions.
//   node test/real-money.ts
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

process.env.MARKET = "mock";
process.env.SUPABASE_URL = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.SOLANA_RPC_URL = "http://127.0.0.1:18899/rpc";
process.env.PUMPPORTAL_URL = "http://127.0.0.1:18899";
process.env.REAL_TRADING_ENABLED = "true";
process.env.USER_REAL_TRADING_ENABLED = "true";
process.env.MASTER_KEY = "b".repeat(64);
process.env.API_PORT = "18788";

const { base58Decode, base58Encode } = await import("../src/util.ts");
const { buildTransferTx, buildCloseAccountsTx, verifySignature, newWallet, signTransaction, walletFromSecret, TOKEN_2022_PROGRAM } = await import("../src/solana.ts");
const { MockMarket } = await import("../src/market.ts");
const { MemoryStore } = await import("../src/store.ts");
const { BotManager } = await import("../src/manager.ts");
import type { Brain, Decision, TurnContext } from "../src/brain.ts";

let passed = 0;
let failed = 0;
const ok = (c: unknown, name: string) => (c ? passed++ : (failed++, console.log(`  ❌ ${name}`)));
const section = (s: string) => console.log(`\n▶ ${s}`);

// ------------------------------------------------------------------ fake chain
const SYSTEM = base58Encode(new Uint8Array(32));
const RENT = 2_039_280n;
const FEE = 5000n;
const PRICE = 3e-8; // SOL per token
const lamports = new Map<string, bigint>();
const tokenAccounts = new Map<string, { owner: string; mint: string; amount: bigint }>();
const pending = new Map<string, { action: string; owner: string; mint: string; amount: any }>();
const failSellFor = new Set<string>();
let verifiedTxs = 0;
let rejectedTxs = 0;
let evilFeePayer = false;

const bal = (a: string) => lamports.get(a) ?? 0n;
const add = (a: string, d: bigint) => lamports.set(a, bal(a) + d);
const accountsOf = (owner: string) => [...tokenAccounts.entries()].filter(([, t]) => t.owner === owner);

function parseLegacy(tx: Uint8Array) {
  const numSigs = tx[0];
  const msg = tx.subarray(1 + numSigs * 64);
  let p = 3;
  const nKeys = msg[p++];
  const keys: string[] = [];
  for (let i = 0; i < nKeys; i++, p += 32) keys.push(base58Encode(msg.subarray(p, p + 32)));
  p += 32; // blockhash
  const nIx = msg[p++];
  const ixs: { program: string; accounts: string[]; data: Uint8Array }[] = [];
  for (let i = 0; i < nIx; i++) {
    const program = keys[msg[p++]];
    const nAcc = msg[p++];
    const accounts = [...msg.subarray(p, p + nAcc)].map((k) => keys[k]);
    p += nAcc;
    const dLen = msg[p++];
    ixs.push({ program, accounts, data: msg.subarray(p, p + dLen) });
    p += dLen;
  }
  return { msgHex: Buffer.from(msg).toString("hex"), keys, ixs };
}

function applyTx(tx: Uint8Array): string {
  const { msgHex, keys, ixs } = parseLegacy(tx);
  const payer = keys[0];
  if (!verifySignature(tx, base58Decode(payer))) {
    rejectedTxs++;
    throw new Error("signature verification failed");
  }
  verifiedTxs++;
  const trade = pending.get(msgHex);
  if (trade) {
    pending.delete(msgHex);
    if (trade.action === "buy") {
      const sol = BigInt(Math.round(Number(trade.amount) * 1e9));
      let acct = [...tokenAccounts.entries()].find(([, t]) => t.owner === trade.owner && t.mint === trade.mint)?.[0];
      let cost = sol + FEE;
      if (!acct) {
        acct = base58Encode(new Uint8Array(randomBytes(32)));
        tokenAccounts.set(acct, { owner: trade.owner, mint: trade.mint, amount: 0n });
        cost += RENT;
      }
      if (bal(trade.owner) < cost) throw new Error("insufficient funds");
      add(trade.owner, -cost);
      tokenAccounts.get(acct)!.amount += BigInt(Math.floor((Number(trade.amount) / PRICE) * 0.99 * 1e6));
    } else {
      const t = [...tokenAccounts.values()].find((x) => x.owner === trade.owner && x.mint === trade.mint);
      if (!t || t.amount === 0n) throw new Error("nothing to sell");
      const sol = BigInt(Math.floor((Number(t.amount) / 1e6) * PRICE * 0.99 * 1e9));
      t.amount = 0n;
      add(trade.owner, sol - FEE);
    }
    return base58Encode(new Uint8Array(randomBytes(64)));
  }
  add(payer, -FEE);
  for (const ix of ixs) {
    if (ix.program === SYSTEM && ix.data[0] === 2) {
      const amt = Buffer.from(ix.data).readBigUInt64LE(4);
      if (bal(ix.accounts[0]) < amt) throw new Error("insufficient funds for transfer");
      add(ix.accounts[0], -amt);
      add(ix.accounts[1], amt);
    } else if (ix.data.length === 1 && ix.data[0] === 9) {
      const t = tokenAccounts.get(ix.accounts[0]);
      if (!t || t.amount !== 0n || t.owner !== ix.accounts[2]) throw new Error("cannot close account");
      tokenAccounts.delete(ix.accounts[0]);
      add(ix.accounts[1], RENT);
    } else throw new Error("unknown instruction");
  }
  return base58Encode(new Uint8Array(randomBytes(64)));
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (o: unknown) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
    if (req.url === "/api/trade-local") {
      const b = JSON.parse(body);
      if (b.action === "sell" && failSellFor.has(b.mint)) return void (res.writeHead(400), res.end("no liquidity"));
      const payer = evilFeePayer ? new Uint8Array(randomBytes(32)) : base58Decode(b.publicKey);
      const tx = buildTransferTx(payer, new Uint8Array(randomBytes(32)), 1n, new Uint8Array(randomBytes(32)));
      pending.set(parseLegacy(tx).msgHex, { action: b.action, owner: b.publicKey, mint: b.mint, amount: b.amount });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return void res.end(Buffer.from(tx));
    }
    const { method, params } = JSON.parse(body);
    try {
      if (method === "getBalance") return send({ result: { value: Number(bal(params[0])) } });
      if (method === "getLatestBlockhash") return send({ result: { value: { blockhash: base58Encode(new Uint8Array(randomBytes(32))), lastValidBlockHeight: 1 } } });
      if (method === "getSignatureStatuses") return send({ result: { value: [{ confirmationStatus: "confirmed", err: null }] } });
      if (method === "getSlot") return send({ result: 1 });
      if (method === "sendTransaction") return send({ result: applyTx(new Uint8Array(Buffer.from(params[0], "base64"))) });
      if (method === "getTokenAccountsByOwner") {
        const [owner, filter] = params;
        const list = accountsOf(owner).filter(([, t]) => (filter.mint ? t.mint === filter.mint : filter.programId === TOKEN_2022_PROGRAM));
        return send({ result: { value: list.map(([pubkey, t]) => ({ pubkey, account: { data: { parsed: { info: { mint: t.mint, tokenAmount: { amount: String(t.amount), uiAmount: Number(t.amount) / 1e6 } } } } } })) } });
      }
      send({ error: { message: `unknown method ${method}` } });
    } catch (e) {
      send({ error: { message: (e as Error).message } });
    }
  });
});
await new Promise<void>((r) => server.listen(18899, "127.0.0.1", () => r()));

// ------------------------------------------------------------------ scripted brain
class ScriptBrain implements Brain {
  plan: ((ctx: TurnContext) => Decision)[] = [];
  async decide(_b: unknown, ctx: TurnContext) {
    return (this.plan.shift() ?? (() => ({ action: "hold", say: "", thought: "" }) as Decision))(ctx);
  }
  async chatReply() {
    return "";
  }
  async idle() {
    return "";
  }
  async moderate() {
    return { ok: true };
  }
}

// ------------------------------------------------------------------ the flow
section("create a real-money user bot");
const market = new MockMarket(5);
const t0 = Date.now();
for (let i = 0; i < 10; i++) market.step(t0 - (10 - i) * 30_000);
const store = new MemoryStore();
const brain = new ScriptBrain();
const mgr = new BotManager(market, brain, store);
const owner = walletFromSecret(newWallet().secret).publicKey;
const created = await mgr.createBot(owner, { handle: "real_kid", name: "Real Kid", preset: "degen", bio: "A degen who trades real SOL and loves it.", color: "#ff5fa2", mode: "real" });
const bot = mgr.bots.get("real_kid")!;
ok(created.mode === "real" && created.wallet && bot.exec.mode === "real", "bot created with its own real wallet");
const enc = store.secrets.get("real_kid") ?? "";
ok(enc.startsWith("v1:") && !enc.includes(created.wallet!), "wallet key stored encrypted");
ok(bot.state.solBalance === 0, "starts empty, waiting for a deposit");

section("deposit and buy");
const addr = created.wallet!;
lamports.set(addr, 1_000_000_000n); // owner deposits 1 SOL
brain.plan.push((ctx) => ({ action: "buy", mint: ctx.menu[0].mint, sol: 0.2, say: "aping", thought: "" }));
const now1 = Date.now();
for (let i = 0; i < 60; i++) market.step(now1 - (60 - i) * 1000); // enough trading for coins to pass the entry filter
await bot.turn(now1);
ok(bot.startSol === 1 && bot.state.positions.size === 1, `deposit detected and buy recorded (start ${bot.startSol}, bags ${bot.state.positions.size})`);
const pos = [...bot.state.positions.values()][0];
ok(accountsOf(addr).some(([, t]) => t.mint === pos.mint && t.amount > 0n), "tokens really landed in the bot wallet");
ok(Math.abs(bot.state.solBalance - Number(bal(addr)) / 1e9) < 1e-9, "bot balance matches the chain exactly");
ok(store.trades.at(-1)?.tx && store.trades.at(-1)?.mode === "real", "trade saved with its transaction signature");
ok(verifiedTxs >= 1 && rejectedTxs === 0, "every transaction carried a valid signature");

section("sell, then token account rent comes back");
const beforeSell = bal(addr);
brain.plan.push(() => ({ action: "sell", mint: pos.mint, say: "out", thought: "" }));
bot.state.lastBuyAt = 0;
await bot.turn(now1 + 120_000);
ok(bot.state.positions.size === 0, "position closed");
ok(!accountsOf(addr).length, "empty token account closed");
const sellTrade = store.trades.at(-1)!;
ok(sellTrade.side === "sell" && Number(bal(addr) - beforeSell) / 1e9 > 0.19, "SOL back in the wallet including rent refund");
ok(Math.abs(bot.state.solBalance - Number(bal(addr)) / 1e9) < 1e-9, "balance still matches the chain");

section("wallet check fixes records");
const orphan = "Orphan1111111111111111111111111111111pump";
(market as any).onCreate({ mint: orphan, symbol: "ORPH", marketCapSol: 40 }, Date.now());
tokenAccounts.set(base58Encode(new Uint8Array(randomBytes(32))), { owner: addr, mint: orphan, amount: 5_000_000_000n });
const spam = "Spam11111111111111111111111111111111111111";
tokenAccounts.set(base58Encode(new Uint8Array(randomBytes(32))), { owner: addr, mint: spam, amount: 1_000_000_000_000n });
await bot.reconcile(Date.now());
ok(bot.state.positions.has(orphan), "tokens that arrived after a timed-out buy are picked up");
ok(!bot.state.positions.has(spam), "an airdropped token the market has never seen is not a position");
for (const [k, t] of tokenAccounts) if (t.mint === orphan) t.amount = 0n;
await bot.reconcile(Date.now());
ok(!bot.state.positions.has(orphan), "bags no longer in the wallet are dropped from records");

section("tampered transaction is never signed");
evilFeePayer = true;
const balBefore = bal(addr);
brain.plan.push((ctx) => ({ action: "buy", mint: ctx.menu[0].mint, sol: 0.1, say: "", thought: "" }));
bot.state.lastBuyAt = 0;
for (let i = 0; i < 5; i++) market.step(Date.now());
await bot.turn(Date.now());
evilFeePayer = false;
ok(bal(addr) === balBefore && bot.state.positions.size === 0, "buy refused, no money moved");

section("withdraw everything to the owner");
brain.plan.push((ctx) => ({ action: "buy", mint: ctx.menu[0].mint, sol: 0.1, say: "", thought: "" }));
bot.state.lastBuyAt = 0;
for (let i = 0; i < 5; i++) market.step(Date.now());
await bot.turn(Date.now());
const rugged = [...bot.state.positions.keys()][0];
failSellFor.add(rugged);
const ownerBefore = bal(owner);
const w = (await mgr.action(owner, "real_kid", "withdraw", {})) as any;
ok(w.ok && w.unsold?.length === 1, "a coin nobody will buy doesn't block the withdrawal");
ok(bal(owner) > ownerBefore && bal(addr) === 0n, `all SOL sent to the owner (${(Number(bal(owner) - ownerBefore) / 1e9).toFixed(4)} SOL)`);
ok(bot.def.paused === true, "bot paused after withdrawal");
ok(Math.abs(bot.stats.withdrawn - w.sol) < 1e-9 && Math.abs((store.bots.get("real_kid")?.withdrawn_sol ?? 0) - bot.stats.withdrawn) < 1e-6, "withdrawal recorded for the leaderboard");
let stranger = "";
try {
  await mgr.action(walletFromSecret(newWallet().secret).publicKey, "real_kid", "withdraw", {});
} catch (e) {
  stranger = (e as Error).message;
}
ok(stranger.includes("Only the wallet"), "nobody else can withdraw");

section("delete archives the bot, keeps its key for recovery");
failSellFor.clear();
await mgr.action(owner, "real_kid", "delete", {});
ok(!mgr.bots.has("real_kid") && store.bots.get("real_kid")?.status === "deleted", "bot archived");
ok(store.secrets.has("real_kid"), "encrypted key kept, so stray deposits can be recovered");

section("close-accounts transaction format");
const wal = walletFromSecret(newWallet().secret);
const accs = [0, 1, 2].map(() => ({ pubkey: new Uint8Array(randomBytes(32)), program: base58Decode(TOKEN_2022_PROGRAM) }));
const ctx = signTransaction(buildCloseAccountsTx(wal.publicKeyBytes, accs, new Uint8Array(randomBytes(32))), wal);
const parsed = parseLegacy(ctx);
ok(verifySignature(ctx, wal.publicKeyBytes), "signs and verifies");
ok(parsed.ixs.length === 3 && parsed.ixs.every((ix) => ix.program === TOKEN_2022_PROGRAM && ix.data[0] === 9 && ix.accounts[1] === wal.publicKey), "3 close instructions, rent to the bot itself");

server.close();
console.log(`\n${failed ? "❌" : "✅"} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
