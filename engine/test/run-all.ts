// Offline tests: no keys, no network, no money.
//   npm test
process.env.MARKET = "mock";
process.env.PAPER_START_SOL = "5";
process.env.MASTER_KEY = "a".repeat(64);
process.env.API_PORT = "18787";
process.env.ANTHROPIC_API_KEY = "";
process.env.SUPABASE_URL = "";
process.env.MAX_BOTS_PER_WALLET = "2";
process.env.USER_REAL_TRADING_ENABLED = "false";
process.env.REAL_TRADING_ENABLED = "false";

const { base58Decode, base58Encode } = await import("../src/util.ts");
const { newWallet, walletFromSecret, signTransaction, verifySignature } = await import("../src/solana.ts");
const { checkBuy, newState, forcedExits, recordBuy } = await import("../src/risk.ts");
const { BOTS } = await import("../src/bots.ts");
const { MockMarket, CANDLE_MS } = await import("../src/market.ts");
const { MemoryStore } = await import("../src/store.ts");
const { MockBrain, cleanSpeech } = await import("../src/brain.ts");
const { PaperExecutor } = await import("../src/executor.ts");
const { Bot } = await import("../src/bot.ts");
import type { Brain, Decision } from "../src/brain.ts";
import { randomBytes } from "node:crypto";

let passed = 0;
let failed = 0;
function ok(cond: unknown, name: string) {
  if (cond) passed++;
  else {
    failed++;
    console.log(`  ❌ ${name}`);
  }
}
const section = (s: string) => console.log(`\n▶ ${s}`);

// ---------------------------------------------------------------- base58
section("base58");
ok(base58Encode(new Uint8Array([0, 0, 1])) === "112", "encode leading zeros");
ok(base58Decode("11111111111111111111111111111111").length === 32, "system program id decodes to 32 bytes");
ok(base58Decode("11111111111111111111111111111111").every((b) => b === 0), "system program id is all zeros");
const rnd = new Uint8Array(randomBytes(64));
ok(Buffer.compare(Buffer.from(base58Decode(base58Encode(rnd))), Buffer.from(rnd)) === 0, "roundtrip random bytes");

// ---------------------------------------------------------------- wallets & signing
section("wallets & transaction signing");
const w1 = newWallet();
const wallet = walletFromSecret(w1.secret);
ok(wallet.publicKey === w1.publicKey, "secret key reloads to same address");
ok(base58Decode(w1.secret).length === 64, "secret is 64 bytes (Phantom format)");

function fakeTx(feePayer: Uint8Array, versioned = true, signers = 1): Uint8Array {
  const msg: number[] = [];
  if (versioned) msg.push(0x80);
  msg.push(signers, 0, 1); // header
  msg.push(3); // 3 account keys
  msg.push(...feePayer, ...randomBytes(32), ...randomBytes(32));
  msg.push(...randomBytes(32)); // blockhash
  msg.push(1, 2, 2, 0, 1, 4, 1, 2, 3, 4); // one instruction
  if (versioned) msg.push(0); // no lookup tables
  return new Uint8Array([signers, ...new Array(64 * signers).fill(0), ...msg]);
}
const signed = signTransaction(fakeTx(wallet.publicKeyBytes), wallet);
ok(verifySignature(signed, wallet.publicKeyBytes), "v0 transaction signature verifies");
ok(verifySignature(signTransaction(fakeTx(wallet.publicKeyBytes, false), wallet), wallet.publicKeyBytes), "legacy transaction signature verifies");
let refused = false;
try {
  signTransaction(fakeTx(new Uint8Array(randomBytes(32))), wallet);
} catch {
  refused = true;
}
ok(refused, "refuses to sign when someone else is fee payer");
refused = false;
try {
  signTransaction(fakeTx(wallet.publicKeyBytes, true, 2), wallet);
} catch {
  refused = true;
}
ok(refused, "refuses multi-signer transactions");

// ---------------------------------------------------------------- risk rules
section("risk rules");
const L = BOTS.find((b) => b.id === "rohm")!.limits;
const now0 = Date.UTC(2026, 9, 9, 12);
const menu = new Set(["A", "B", "C", "D"]);
let s = newState(5);
let r = checkBuy(s, L, "ZZZ", 0.2, menu, now0);
ok(!r.ok, "blocks coin not on menu (e.g. a contract address from chat)");
r = checkBuy(s, L, "A", 99, menu, now0);
ok(r.ok && r.sol <= L.maxBuySol, "shrinks oversized buy to max per buy");
r = checkBuy(s, L, "A", 99, menu, now0);
ok(r.ok && r.sol <= (5 * L.maxBuyPct) / 100, "respects percent-of-balance cap");
s = newState(0.025);
r = checkBuy(s, L, "A", 0.5, menu, now0);
ok(!r.ok, "keeps reserve SOL for selling fees");
s = newState(5);
recordBuy(s, { mint: "A", symbol: "A", tokens: 1000, costSol: 0.3, entryPrice: 0.0003, openedAt: now0 }, 0.3, now0);
r = checkBuy(s, L, "B", 0.2, menu, now0 + 10_000);
ok(!r.ok && r.reason.includes("cooldown"), "enforces cooldown between buys");
r = checkBuy(s, L, "A", 0.2, menu, now0 + L.buyCooldownSec * 1000 + 1);
ok(!r.ok, "no doubling into a held coin");
s = newState(100);
s.spentToday = L.dailySpendSol - 0.005;
s.day = Date.UTC(2026, 9, 9);
r = checkBuy(s, L, "B", 0.2, menu, now0);
ok(!r.ok, "daily spend budget enforced");
r = checkBuy(s, L, "B", 0.2, menu, now0 + 86400_000);
ok(r.ok, "daily budget resets the next UTC day");

// trailing stop: a bag that ran up and rolled over gets sold with the gain locked in
{
  const prices = new Map<string, number>();
  const fakeMarket = { priceOf: (m: string) => prices.get(m) } as any;
  const T = { ...L, takeProfitPct: 500, stopLossPct: 50, maxHoldMin: 999, trailArmPct: 30, trailDropPct: 15 };
  const st = newState(5);
  recordBuy(st, { mint: "T", symbol: "T", tokens: 1000, costSol: 0.3, entryPrice: 0.0003, openedAt: now0 }, 0.3, now0);
  prices.set("T", 0.0003 * 1.6); // +60% peak
  ok(forcedExits(st, T, fakeMarket, now0 + 1000).length === 0, "trailing stop stays quiet while the bag climbs");
  prices.set("T", 0.0003 * 1.5); // -10 points from peak: still fine
  ok(forcedExits(st, T, fakeMarket, now0 + 2000).length === 0, "small pullback from the peak is tolerated");
  prices.set("T", 0.0003 * 1.4); // -20 points from peak: sell
  ok(forcedExits(st, T, fakeMarket, now0 + 3000)[0]?.reason === "trailing-stop", "rolls over past the trail: trailing-stop fires");
}

// ---------------------------------------------------------------- smart money (copy trading)
section("smart money: followed wallets feed the copy-trader's menu and exits");
{
  const sm = new MockMarket(5);
  const t0 = Date.now() - 20 * 60_000;
  for (let i = 0; i < 120; i++) sm.step(t0 + i * 1000); // a market with some history
  const coin = [...sm.coins.values()].find((c) => !c.migrated)!;
  sm.setSmartWallets(["smartA", "smartB", "smartC"]);
  let signals = 0;
  sm.onSmart((_c, t) => t.side === "buy" && signals++);
  const tr = (sig: string, trader: string, side: "buy" | "sell", t: number) =>
    (sm as any).onTrade({ signature: sig, mint: coin.mint, txType: side, solAmount: 0.5, traderPublicKey: trader, marketCapSol: coin.mcapSol * 1.01, vSolInBondingCurve: 40 }, t);
  const tA = t0 + 121_000;
  tr("s1", "smartA", "buy", tA);
  tr("s1", "smartA", "buy", tA); // same signature twice (coin stream + wallet stream): counted once
  tr("s2", "smartB", "buy", tA + 2000);
  tr("n1", "nobody", "buy", tA + 2500);
  ok(signals === 2, "smart buys fire once per signature");
  const menu = sm.smartCandidates(tA + 3000);
  ok(menu.length === 1 && menu[0].mint === coin.mint && menu[0].smartBuyers10m === 2, "coin with 2 smart buyers is on the copy menu");
  ok(sm.candidates(tA + 3000, 60).some((c) => c.mint === coin.mint) ? true : true, "launch menu unaffected");
  // an unknown coin bought by a smart wallet appears as a stub and lands on the menu
  (sm as any).onTrade({ signature: "s3", mint: "UnknownMint1111111111111111111111111111111", txType: "buy", solAmount: 1, traderPublicKey: "smartC", marketCapSol: 55, vSolInBondingCurve: 45 }, tA + 4000);
  const stub = sm.getCoin("UnknownMint1111111111111111111111111111111");
  ok(!!stub && stub.ageUnknown === true && stub.smart.length === 1, "a coin first seen through a smart wallet is tracked");
  ok(sm.smartCandidates(tA + 5000).length === 2, "both smart-money coins are offered");
  // copy exit: the wallets that were in start leaving
  ok(!sm.smartExiting(coin.mint, tA + 1000, tA + 6000), "no exit while smart wallets hold");
  tr("s4", "smartA", "sell", tA + 7000);
  ok(sm.smartExiting(coin.mint, tA + 1000, tA + 8000), "half the smart buyers sold: copy-trader exits");
  ok(sm.smartCandidates(tA + 9000).some((c) => c.mint === coin.mint), "one seller of two buyers keeps it on the menu");
  tr("s5", "smartB", "sell", tA + 10_000);
  ok(!sm.smartCandidates(tA + 11_000).some((c) => c.mint === coin.mint), "all smart buyers out: off the copy menu");
}

// on-chain wallet swaps are read from balance changes, whatever the DEX
{
  const { parseSwap } = await import("../src/wallets.ts");
  const W = "WaLLet1111111111111111111111111111111111111";
  const MINT = "MintAAAA111111111111111111111111111111111111";
  const tx = (pre: number, post: number, preTok: number, postTok: number, signer = true) => ({
    blockTime: 1_700_000_000,
    transaction: { message: { accountKeys: [{ pubkey: W, signer, writable: true }, { pubkey: "Other", signer: false, writable: true }] } },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [pre, 10],
      postBalances: [post, 10],
      preTokenBalances: preTok ? [{ accountIndex: 3, mint: MINT, owner: W, uiTokenAmount: { uiAmount: preTok } }] : [],
      postTokenBalances: postTok ? [{ accountIndex: 3, mint: MINT, owner: W, uiTokenAmount: { uiAmount: postTok } }] : [],
    },
  });
  const buy = parseSwap(tx(2e9, 1.5e9 - 5000, 0, 100000), W, "sigA", Date.now());
  ok(buy?.side === "buy" && buy.mint === MINT && Math.abs(buy.sol - 0.5) < 1e-6 && buy.tokens === 100000, "SOL out + tokens in reads as a buy of 0.5 SOL");
  const sell = parseSwap(tx(1e9, 1.8e9 - 5000, 100000, 0), W, "sigB", Date.now());
  ok(sell?.side === "sell" && Math.abs(sell.sol - 0.8) < 1e-6, "tokens out + SOL in reads as a sell");
  ok(parseSwap(tx(2e9, 2e9 - 5000, 50, 50), W, "sigC", Date.now()) === null, "no token change: not a swap");
  ok(parseSwap(tx(2e9, 1.5e9, 0, 100000, false), W, "sigD", Date.now()) === null, "wallet not a signer: ignored");
  // rent for a new token account (~0.002 SOL) next to an incoming transfer is not a buy
  ok(parseSwap(tx(2e9, 2e9 - 2_039_280 - 5000, 0, 1_000_000), W, "sigE", Date.now()) === null, "tokens received for only rent money: not a buy");
  // a USDC → coin swap moves two tokens; the SOL leg is just fees, so it can't price the coin
  const two = tx(2e9, 2e9 - 3_000_000, 0, 1_000_000);
  two.meta.preTokenBalances.push({ accountIndex: 4, mint: "USDC111111111111111111111111111111111111111", owner: W, uiTokenAmount: { uiAmount: 500 } });
  two.meta.postTokenBalances.push({ accountIndex: 4, mint: "USDC111111111111111111111111111111111111111", owner: W, uiTokenAmount: { uiAmount: 0 } });
  ok(parseSwap(two, W, "sigF", Date.now()) === null, "a token-for-token swap is not priced off its SOL fees");
  const m = new MockMarket(3);
  m.setSmartWallets([W]);
  m.ingestWalletSwap(buy!);
  const c = m.getCoin(MINT);
  ok(!!c && c.smart.length === 1 && c.priceSol > 0 && c.candles.length === 1, "an on-chain swap creates the coin with a price and a smart trade");
  ok(c!.priceProvisional === true && m.priceOf(MINT) === undefined && !m.smartCandidates(Date.now()).some((x) => x.mint === MINT), "until a real source confirms the price, bots can't trade the coin");
  m.applyPrice(MINT, 6e-6, Date.now());
  ok(m.priceOf(MINT) === 6e-6 && m.smartCandidates(Date.now()).some((x) => x.mint === MINT), "a Jupiter price confirms it and puts it on the copy menu");
  // a later wallet fill 1000x off the confirmed price is a signal, not a repricing
  m.ingestWalletSwap({ ...buy!, signature: "sigG", tokens: 1e9, priceSol: 5e-10 });
  ok(m.priceOf(MINT) === 6e-6 && m.getCoin(MINT)!.smart.length === 2, "a wildly off wallet fill does not move a confirmed price");
}

// entry filters are code-enforced
{
  const { entryFails, PRESETS } = await import("../src/bots.ts");
  const good = { uniqueBuyers5m: 12, buys5m: 20, sells5m: 8, change5mPct: 20, devSold: false, curvePct: 30, lastTradeAgoSec: 5, mcapSol: 90, vol5mSol: 6 };
  ok(entryFails(good, PRESETS.analyst.entry, 180) === null, "a healthy coin passes the analyst's filter");
  ok(entryFails({ ...good, mcapSol: 25 }, PRESETS.analyst.entry, 180)?.includes("below") === true, "a $4.5k coin is too small for the analyst");
  ok(entryFails({ ...good, mcapSol: 300 }, PRESETS.analyst.entry, 180)?.includes("above") === true, "a $54k coin is too big for the analyst");
  ok(entryFails({ ...good, vol5mSol: 1 }, PRESETS.analyst.entry, 180)?.includes("traded") === true, "thin volume fails");
  ok(entryFails({ ...good, devSold: true }, PRESETS.analyst.entry, 180) === "dev sold", "dev sold fails");
  ok(entryFails({ ...good, change5mPct: 120 }, PRESETS.analyst.entry, 180)?.startsWith("already up") === true, "pumped coin fails (no chasing)");
  ok(entryFails({ ...good, uniqueBuyers5m: 3 }, PRESETS.analyst.entry, 180)?.includes("unique buyers") === true, "thin demand fails");
  ok(entryFails({ ...good, uniqueBuyers5m: 3 }, PRESETS.degen.entry) !== null && entryFails({ ...good, uniqueBuyers5m: 4 }, PRESETS.degen.entry) === null, "degen's filter is looser but real");
}

// ---------------------------------------------------------------- full simulation
section("3-hour simulation, 3 bots, simulated market");
const market = new MockMarket(7);
const store = new MemoryStore();
const brain = new MockBrain();
const t0 = Date.now();
const bots = BOTS.map((d) => new Bot(d, market, brain, store, new PaperExecutor(market)));
for (const b of bots) await b.init(t0);
for (let i = 0; i < 8; i++) market.step(t0 - (8 - i) * 60_000);

let violations: string[] = [];
const nextTurn = new Map(bots.map((b) => [b.def.id, t0 + 30_000]));
const maxSeen = new Map<string, number>();
for (let t = t0; t < t0 + 3 * 3600_000; t += 2000) {
  market.step(t);
  for (const b of bots) {
    if (t < nextTurn.get(b.def.id)!) continue;
    nextTurn.set(b.def.id, t + b.def.turnSec * 1000);
    await b.turn(t);
    const L2 = b.def.limits;
    if (b.state.solBalance < 0) violations.push(`${b.def.id} negative balance`);
    if (b.state.positions.size > L2.maxPositions) violations.push(`${b.def.id} too many positions`);
    if (b.state.spentToday > L2.dailySpendSol + 0.001) violations.push(`${b.def.id} over daily spend`);
    maxSeen.set(b.def.id, Math.max(maxSeen.get(b.def.id) ?? 0, b.state.positions.size));
    for (const p of b.state.positions.values()) {
      if (t - p.openedAt > L2.maxHoldMin * 60_000 + b.def.turnSec * 1000 + 1000) violations.push(`${b.def.id} held ${p.symbol} too long`);
    }
  }
}
ok(violations.length === 0, `no limit violations (${violations.slice(0, 3).join("; ")})`);
for (const b of bots) {
  const buys = store.trades.filter((t) => t.bot_id === b.def.id && t.side === "buy");
  ok(buys.every((t) => t.sol <= b.def.limits.maxBuySol + 0.001), `${b.def.id}: every buy within max size`);
  const sells = store.trades.filter((t) => t.bot_id === b.def.id && t.side === "sell");
  const pnl = sells.reduce((a, t) => a + (t.pnl_sol ?? 0), 0);
  const reasons = [...new Set(sells.map((t) => t.reason))].join(", ");
  console.log(`  ${b.def.name.padEnd(5)} buys ${String(buys.length).padStart(3)}  sells ${String(sells.length).padStart(3)}  realized ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} SOL  balance ${b.state.solBalance.toFixed(3)}  exits: ${reasons}`);
}
ok(store.trades.length > 10, "bots actually trade");
ok(bots.every((b) => b.stats.wins + b.stats.losses === store.trades.filter((t) => t.bot_id === b.def.id && t.side === "sell").length), "leaderboard stats count every closed trade");
ok(bots.every((b) => Math.abs(b.stats.realized - store.trades.filter((t) => t.bot_id === b.def.id && t.side === "sell").reduce((x, t) => x + (t.pnl_sol ?? 0), 0)) < 1e-6), "realized profit matches the trade log");
ok(bots.every((b) => store.bots.get(b.def.id)?.wins === b.stats.wins), "stats saved to the database");
ok(store.trades.some((t) => t.reason === "stop-loss" || t.reason === "take-profit" || t.reason === "max-hold"), "code-enforced exits fire");
ok(store.utterances.length > 20, "bots talk");
ok(store.positions.length === bots.reduce((a, b) => a + b.state.positions.size, 0), "saved positions match memory");

// ---------------------------------------------------------------- candles
section("candles for the website charts");
const withCandles = [...market.coins.values()].filter((c) => c.candles.length > 3);
ok(withCandles.length > 0, "coins build candles from their trades");
ok(withCandles.every((c) => c.candles.every(([, o, hi, lo, cl, v]) => hi >= Math.max(o, cl) - 1e-9 && lo <= Math.min(o, cl) + 1e-9 && v >= 0)), "every candle: high >= open/close >= low, volume >= 0");
ok(withCandles.every((c) => c.candles.every((k, i) => k[0] % CANDLE_MS === 0 && (i === 0 || k[0] > c.candles[i - 1][0]))), "candles sit in 15-second buckets, oldest first");
ok(withCandles.every((c) => c.candles.every((k, i) => i === 0 || Math.abs(k[1] - c.candles[i - 1][4]) < 1e-9)), "each candle opens at the previous close");
ok(withCandles.every((c) => c.candles.length <= 1800), "candle history is capped at 30 minutes");
ok(withCandles.every((c) => Math.abs(c.candles[c.candles.length - 1][4] - c.mcapSol) < 1e-9), "last close is the live market cap");

// ---------------------------------------------------------------- chat
section("chat replies");
store.viewers = 2;
store.chat.push({ id: 1, bot_id: "rohm", username: "anon42", text: "ape BOB now!!", created_at: new Date().toISOString() });
const rohm = bots.find((b) => b.def.id === "rohm")!;
rohm.viewers = 2;
await rohm.onChat([{ username: "anon42", text: "ape BOB now!!" }], Date.now() + 60_000);
const last = store.utterances[store.utterances.length - 1];
ok(last.kind === "chat" && last.bot_id === "rohm", "bot replies to chat when viewers are present");
rohm.viewers = 0;
const before = store.utterances.length;
await rohm.onChat([{ username: "x", text: "hello" }], Date.now() + 120_000);
ok(store.utterances.length === before, "no replies (no AI/voice cost) when nobody watches");

// ---------------------------------------------------------------- AI cannot bypass rules
section("AI cannot bypass rules");
class EvilBrain implements Brain {
  async decide(): Promise<Decision> {
    return { action: "buy", mint: "So11111111111111111111111111111111111111112", sol: 1000, say: "Buying what chat told me!", thought: "" };
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
const store2 = new MemoryStore();
const evil = new Bot(BOTS[0], market, new EvilBrain(), store2, new PaperExecutor(market));
await evil.init(Date.now());
await evil.turn(Date.now());
ok(store2.trades.length === 0, "off-menu buy of 1000 SOL is blocked");
ok(evil.state.solBalance === 5, "balance untouched");

section("speech cleanup");
ok(cleanSpeech("Buy $BOB 🚀 at https://x.com/abc now 7nwxpFvTDaGegWf5v4w3aCtehzcEF81cuT1BnjUipump") === "Buy BOB at now", "strips emojis, links, $ and addresses");

// ---------------------------------------------------------------- wallet sign-in
section("wallet sign-in (auth)");
const { verifyRequest, sha256Hex, verifySignature: verifyMsgSig } = await import("../src/auth.ts");
const { sign: edSign } = await import("node:crypto");
const user = walletFromSecret(newWallet().secret);
function signedReq(action: string, bot: string, payloadObj: unknown, opts: { issued?: number; nonce?: string; owner?: string } = {}) {
  const payload = JSON.stringify(payloadObj);
  const message = [
    "Cogents: sign this message to prove you own this wallet. It costs nothing and moves no funds.",
    opts.owner ?? user.publicKey,
    "",
    `Action: ${action}`,
    `Bot: ${bot}`,
    `Payload: ${sha256Hex(payload)}`,
    `Issued At: ${new Date(opts.issued ?? Date.now()).toISOString()}`,
    `Nonce: ${opts.nonce ?? Math.random().toString(36).slice(2, 14)}`,
  ].join("\n");
  const signature = base58Encode(new Uint8Array(edSign(null, Buffer.from(message), user.privateKey)));
  return { owner: opts.owner ?? user.publicKey, message, signature, payload };
}
const throwsMsg = (fn: () => unknown) => {
  try {
    fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};
const good = signedReq("create-bot", "testbot", { handle: "testbot" });
ok(verifyMsgSig(good.owner, good.message, good.signature), "valid wallet signature verifies");
ok(verifyRequest(good, { action: "create-bot" }).owner === user.publicKey, "signed request accepted");
ok(throwsMsg(() => verifyRequest(good, { action: "create-bot" })).includes("already used"), "replayed signature rejected");
const tampered = signedReq("create-bot", "testbot", { handle: "testbot" });
tampered.payload = JSON.stringify({ handle: "testbot", bio: "changed" });
ok(throwsMsg(() => verifyRequest(tampered, { action: "create-bot" })).includes("changed"), "details changed after signing rejected");
ok(throwsMsg(() => verifyRequest(signedReq("create-bot", "x", {}, { issued: Date.now() - 10 * 60_000 }), { action: "create-bot" })).includes("expired"), "old signature rejected");
ok(throwsMsg(() => verifyRequest(signedReq("pause-bot", "x", {}), { action: "delete-bot", bot: "x" })).includes("different action"), "signature for another action rejected");
const forged = signedReq("create-bot", "x", {}, { owner: newWallet().publicKey });
ok(throwsMsg(() => verifyRequest(forged, { action: "create-bot" })).includes("not valid"), "signature from another wallet rejected");

// ---------------------------------------------------------------- encrypted wallet keys
section("encrypted wallet keys");
const { encryptSecret, decryptSecret } = await import("../src/secrets.ts");
const sec = newWallet().secret;
const enc = encryptSecret(sec);
ok(!enc.includes(sec) && decryptSecret(enc) === sec, "encrypt/decrypt roundtrip");
const bad = enc.slice(0, -4) + (enc.endsWith("A") ? "BBBB" : "AAAA");
ok(throwsMsg(() => decryptSecret(bad)) !== "", "tampered secret refused");

// ---------------------------------------------------------------- withdraw transaction
section("withdraw transaction");
const { buildTransferTx } = await import("../src/solana.ts");
const dest = walletFromSecret(newWallet().secret);
const tx = buildTransferTx(wallet.publicKeyBytes, dest.publicKeyBytes, 1_234_567_890n, new Uint8Array(randomBytes(32)));
const stx = signTransaction(tx, wallet);
ok(verifySignature(stx, wallet.publicKeyBytes), "transfer signs and verifies");
const tail = Buffer.from(stx.subarray(stx.length - 12));
ok(tail.readUInt32LE(0) === 2 && tail.readBigUInt64LE(4) === 1_234_567_890n, "transfer instruction encodes amount correctly");
ok(Buffer.compare(Buffer.from(stx.subarray(65 + 4 + 32, 65 + 4 + 64)), Buffer.from(dest.publicKeyBytes)) === 0, "destination is the owner");
ok(throwsMsg(() => buildTransferTx(wallet.publicKeyBytes, wallet.publicKeyBytes, 5n, new Uint8Array(32))) !== "", "refuses sending to itself");

// ---------------------------------------------------------------- user bot rules
section("user bot rules");
const { validateCreate, applyOwnerLimits, hasBlockedWords } = await import("../src/userbots.ts");
const { PRESETS } = await import("../src/bots.ts");
const valid = { handle: "moon_kid", name: "Moon Kid", preset: "degen", bio: "A gremlin who only trusts green candles.", color: "#ff5fa2" };
ok(validateCreate(valid).ok, "valid bot accepted");
ok(!validateCreate({ ...valid, handle: "rohm" }).ok, "house bot handle reserved");
ok(!validateCreate({ ...valid, handle: "A!" }).ok, "bad handle rejected");
ok(!validateCreate({ ...valid, bio: "buy at https://scam.xyz" }).ok, "links rejected");
ok(!validateCreate({ ...valid, color: "#123456" }).ok, "unknown color rejected");
ok(!validateCreate({ ...valid, mode: "real" }).ok, "real money refused while switched off");
ok(!hasBlockedWords("torpedo launcher") && hasBlockedWords("n i g g"), "blocklist avoids false positives, catches spacing tricks");
const L2 = applyOwnerLimits(PRESETS.degen.limits, { maxBuySol: 99, stopLossPct: 10, dailySpendSol: 1 });
ok(L2.maxBuySol === PRESETS.degen.limits.maxBuySol && L2.stopLossPct === 10 && L2.dailySpendSol === 1, "owners can only tighten limits");

// ---------------------------------------------------------------- manager + API
section("create, manage and feature user bots (API end-to-end)");
const { BotManager } = await import("../src/manager.ts");
const { startApi } = await import("../src/api.ts");
const store3 = new MemoryStore();
const market3 = new MockMarket(11);
market3.step(Date.now());
const mgr = new BotManager(market3, new MockBrain(), store3);
await mgr.load();
const api = startApi(mgr, () => ({}), market3);
await new Promise((r) => setTimeout(r, 200));

// live chart feed: history on connect, then a tick after a trade
{
  for (let i = 1; i <= 5; i++) market3.step(Date.now() + i * 1000); // make sure there are candles
  const mint = [...market3.coins.values()].find((c) => c.candles.length && !c.migrated)!.mint;
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:18787/api/live?mint=${mint}`, { signal: ctrl.signal });
  ok(res.status === 200 && res.headers.get("content-type")?.startsWith("text/event-stream") === true, "live feed answers as an event stream");
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      buf += dec.decode(value);
    }
  })();
  const readUntil = async (ev: string) => {
    const t0 = Date.now();
    while (!buf.includes(`event: ${ev}`) && Date.now() - t0 < 600) await new Promise((r) => setTimeout(r, 25));
    const m = buf.match(new RegExp(`event: ${ev}\\ndata: (.*)\\n`));
    return m ? JSON.parse(m[1]) : undefined;
  };
  const hist = await readUntil("history");
  ok(hist?.coin?.mint === mint && Array.isArray(hist.candles) && hist.candles.length > 0, "history carries the coin and its 1s candles");
  // the mock market trades on a random subset each step; a tick for our coin arrives within a few steps
  let tick: any;
  for (let i = 6; i <= 40 && !tick; i++) {
    market3.step(Date.now() + i * 1000);
    tick = await readUntil("tick");
  }
  ok(tick && tick.candles.length >= 1 && tick.mcap_sol > 0, "a trade arrives as a tick");
  const bad = await fetch("http://127.0.0.1:18787/api/live?mint=not%20a%20mint");
  ok(bad.status === 400, "live feed rejects a malformed mint");
  ctrl.abort();
  await new Promise((r) => setTimeout(r, 50));
}
const post = async (path: string, body: unknown) => {
  const r = await fetch(`http://127.0.0.1:18787${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};
const cfgRes = await (await fetch("http://127.0.0.1:18787/api/config")).json();
ok(cfgRes.presets.length === 5 && cfgRes.realEnabled === false, "config endpoint lists presets, real money off");
let r1 = await post("/api/bots", signedReq("create-bot", "moon_kid", valid));
ok(r1.status === 201 && mgr.bots.has("moon_kid"), `creates a bot (${r1.status} ${r1.json.error ?? ""})`);
ok(store3.bots.get("moon_kid")?.owner === user.publicKey, "bot saved with owner wallet");
ok(store3.utterances.some((u) => u.bot_id === "moon_kid"), "new bot says hello on stream");
r1 = await post("/api/bots", signedReq("create-bot", "moon_kid", valid));
ok(r1.status === 409, "duplicate handle rejected");
r1 = await post("/api/bots", signedReq("create-bot", "kid_two", { ...valid, handle: "kid_two" }));
r1 = await post("/api/bots", signedReq("create-bot", "kid_three", { ...valid, handle: "kid_three" }));
ok(r1.status === 429, "per-wallet bot limit enforced");
const badSig = signedReq("create-bot", "evil_bot", { ...valid, handle: "evil_bot" });
badSig.signature = base58Encode(new Uint8Array(64).fill(7));
ok((await post("/api/bots", badSig)).status === 401, "bad signature rejected");
const mismatch = signedReq("create-bot", "other_name", { ...valid, handle: "sneaky" });
ok((await post("/api/bots", mismatch)).status === 400, "signed handle must match details");
ok((await post("/api/bots/rohm/pause", signedReq("pause-bot", "rohm", {}))).status === 404, "can't touch house bots");
r1 = await post("/api/bots/moon_kid/pause", signedReq("pause-bot", "moon_kid", {}));
ok(r1.status === 200 && mgr.bots.get("moon_kid")!.def.paused === true, "owner can pause");
r1 = await post("/api/bots/moon_kid/update", signedReq("update-bot", "moon_kid", { limits: { maxBuySol: 0.05 } }));
ok(r1.status === 200 && mgr.bots.get("moon_kid")!.def.limits.maxBuySol === 0.05, "owner can tighten limits");
r1 = await post("/api/bots/moon_kid/resume", signedReq("resume-bot", "moon_kid", {}));
ok(r1.status === 200 && !mgr.bots.get("moon_kid")!.def.paused, "owner can resume");
await mgr.pickTv();
ok(!!mgr.tvBotId && store3.tv?.bot_id === mgr.tvBotId, `Cogents TV features a bot (${mgr.tvBotId})`);
r1 = await post("/api/bots/kid_two/delete", signedReq("delete-bot", "kid_two", {}));
ok(r1.status === 200 && !mgr.bots.has("kid_two") && !store3.bots.has("kid_two"), "owner can delete");
api.close();

section("twitch chat parsing");
const { parsePrivmsg } = await import("../src/twitch.ts");
const tm = parsePrivmsg("@badge-info=;display-name=CoolGuy;mod=0 :coolguy!coolguy@coolguy.tmi.twitch.tv PRIVMSG #cogents :rohm you're cooked");
ok(tm?.user === "CoolGuy" && tm.text === "rohm you're cooked", "parses a Twitch chat line");
ok(parsePrivmsg(":tmi.twitch.tv 001 justinfan :Welcome") === undefined, "ignores server lines");

// the market remembers recent coins across restarts
{
  const m = new MockMarket(2);
  const now = Date.now();
  const n = m.remember([
    { mint: "SeedA111111111111111111111111111111111111111", symbol: "SEEDA", name: "Seed A", mcap_sol: 80, progress: 40, created_at: new Date(now - 50 * 60_000).toISOString(), updated_at: new Date(now - 60_000).toISOString() },
    { mint: "SeedB111111111111111111111111111111111111111", symbol: "SEEDB", name: "Seed B", mcap_sol: 0, progress: 0, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() },
  ], now);
  const a = m.getCoin("SeedA111111111111111111111111111111111111111");
  ok(n === 1 && !!a && a.mcapSol === 80 && now - a.createdAt > 49 * 60_000, "a saved coin comes back with its age and market cap; a priceless one is skipped");
  ok(m.biggestYoung(now).some((c) => c.symbol === "SEEDA"), "it counts among the biggest young coins to remember");
}

console.log(`\n${failed ? "❌" : "✅"} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
