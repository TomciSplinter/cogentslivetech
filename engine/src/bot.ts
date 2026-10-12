// One live bot: runs its trading turns, talks to chat, and reports everything
// to the database so the stream page can show it.
import { entryFails, type BotDef } from "./bots.ts";
import type { Brain, TurnContext } from "./brain.ts";
import type { Executor } from "./executor.ts";
import type { Market } from "./market.ts";
import type { Store, UtteranceRow } from "./store.ts";
import { config, botEnv } from "./config.ts";
import { checkBuy, checkSell, forcedExits, newState, positionPnlPct, recordBuy, recordSell, rollDay, type BotState, type Position } from "./risk.ts";
import { speak } from "./voice.ts";
import { dayStart, log, round } from "./util.ts";

/** A paper bag marked above this many times its cost is a feed glitch, never a real fill. */
const MAX_PAPER_GAIN = 30;

/** Shared, short log of what every bot did, so they can react to each other. */
export const floorLog: { t: number; botId: string; text: string }[] = [];
function pushFloor(botId: string, text: string, now: number) {
  floorLog.push({ t: now, botId, text });
  if (floorLog.length > 40) floorLog.shift();
}

const FORCED_LINES: Record<string, string[]> = {
  "take-profit": ["Profit taken on {sym}. Up {pnl} percent.", "Ringing the register on {sym}, plus {pnl} percent."],
  "stop-loss": ["Stop hit on {sym}. Down {pnl} percent. Moving on.", "{sym} stopped out at minus {pnl}. It happens."],
  "max-hold": ["Held {sym} long enough. Closing it at {pnl} percent.", "Time's up on {sym}, out at {pnl} percent."],
  "trailing-stop": ["{sym} rolled over from the top. Locking in plus {pnl} percent.", "Trailing stop on {sym}, banking {pnl} percent before it fades."],
  "smart-exit": ["Smart money is leaving {sym}. So am I. {pnl} percent.", "The wallets I follow just sold {sym}. Out, {pnl} percent."],
};

export class Bot {
  state: BotState;
  startSol = 0;
  private busy = false;
  private lastSpokeAt = 0;
  private lastReplyAt = 0;
  private said: string[] = [];
  private recentChat: { user: string; text: string }[] = [];
  watching?: string;
  viewers = 0;
  lastTurnAt = 0;
  lastTradeAt = 0;
  /** Lifetime performance, shown on the leaderboard. */
  stats = { realized: 0, wins: 0, losses: 0, volume: 0, withdrawn: 0 };
  private turnsSinceReconcile = 99;
  /** Called after the bot says something (used to mirror lines into Twitch chat). */
  onSay?: (bot: Bot, text: string, kind: UtteranceRow["kind"]) => void;

  readonly def: BotDef;
  readonly exec: Executor;
  private market: Market;
  private brain: Brain;
  private store: Store;

  constructor(def: BotDef, market: Market, brain: Brain, store: Store, exec: Executor) {
    this.def = def;
    this.market = market;
    this.brain = brain;
    this.store = store;
    this.exec = exec;
    this.state = newState(0);
  }

  get voiceId() {
    return this.def.voiceId || botEnv(this.def.id, "VOICE_ID");
  }

  /** Load saved balance and positions so a restart continues where it left off. */
  async init(now = Date.now()) {
    const row = await this.store.getBot(this.def.id);
    const paperStart = this.def.paperStartSol ?? config.paperStartSol;
    const sameMode = row?.mode === this.exec.mode && row?.status !== "new";
    let balance = sameMode ? Number(row!.sol_balance) : paperStart;
    this.startSol = sameMode ? Number(row!.start_sol) : paperStart;

    if (this.exec.mode === "real") {
      const chain = await this.exec.syncBalance();
      balance = chain ?? 0;
      if (!sameMode) this.startSol = balance;
    }
    this.state = newState(balance);

    this.stats = sameMode
      ? {
          realized: Number(row!.realized_pnl ?? 0),
          wins: Number(row!.wins ?? 0),
          losses: Number(row!.losses ?? 0),
          volume: Number(row!.volume_sol ?? 0),
          withdrawn: Number(row!.withdrawn_sol ?? 0),
        }
      : { realized: 0, wins: 0, losses: 0, volume: 0, withdrawn: 0 };

    if (sameMode) {
      for (const p of await this.store.getPositions(this.def.id)) {
        this.state.positions.set(p.mint, {
          mint: p.mint,
          symbol: p.symbol,
          tokens: Number(p.tokens),
          costSol: Number(p.cost_sol),
          entryPrice: Number(p.entry_price),
          openedAt: Date.parse(p.opened_at),
        });
      }
      // rebuild today's counters from the trade history
      rollDay(this.state, now);
      for (const t of await this.store.tradesSince(this.def.id, new Date(dayStart(now)).toISOString())) {
        this.state.tradesToday++;
        if (t.side === "buy") {
          this.state.spentToday += Number(t.sol);
          this.state.lastBuyAt = Math.max(this.state.lastBuyAt, Date.parse(t.created_at ?? "") || 0);
        }
      }
    } else {
      // mode changed (or first run): start clean
      for (const p of await this.store.getPositions(this.def.id)) await this.store.deletePosition(this.def.id, p.mint);
    }

    await this.store.upsertBots([
      {
        id: this.def.id,
        name: this.def.name,
        role: this.def.role,
        color: this.def.color,
        mode: this.exec.mode,
        wallet: this.exec.address ?? null,
        sol_balance: round(this.state.solBalance, 6),
        start_sol: this.startSol,
        status: this.def.paused ? "paused" : "warming up",
        thinking: "",
        watching_mint: null,
        trades_today: this.state.tradesToday,
        is_house: this.def.house,
        live_since: new Date(now).toISOString(),
        ...this.statsRow(),
      },
    ]);
    log(this.def.id, `ready: ${this.exec.mode} mode, ${this.state.solBalance.toFixed(3)} SOL, ${this.state.positions.size} open bags`);
  }

  statsRow() {
    return {
      realized_pnl: round(this.stats.realized, 6),
      wins: this.stats.wins,
      losses: this.stats.losses,
      volume_sol: round(this.stats.volume, 4),
      withdrawn_sol: round(this.stats.withdrawn, 6),
    };
  }

  heldMints() {
    return [...this.state.positions.keys()];
  }

  /** The coins this bot may buy this turn: by strategy, then through the code-enforced entry filter. */
  menu(now: number) {
    const strat = this.def.strategy ?? "launches";
    let list = [];
    // take a wide slice of the market and let the entry filter choose: ranking first and filtering after
    // would hand a picky bot ten brand-new launches and nothing that fits its playbook
    const wide = this.def.entry ? 40 : 10;
    if (strat === "copy") list = this.market.smartCandidates(now, 8);
    else if (strat === "both") {
      const smart = this.market.smartCandidates(now, 4);
      const seen = new Set(smart.map((c) => c.mint));
      list = [...smart, ...this.market.candidates(now, this.def.limits.maxCoinAgeMin, wide).filter((c) => !seen.has(c.mint))];
    } else list = this.market.candidates(now, this.def.limits.maxCoinAgeMin, wide);
    // a smart-money coin passes with the light filter: the followed wallet is the demand signal, and a coin
    // first seen through its trade has no crowd stats yet
    const f = this.def.entry;
    const light = f && { noDevSold: f.noDevSold, maxChange5mPct: f.maxChange5mPct, curveMax: f.curveMax };
    const why: string[] = [];
    const menu = list
      .filter((c) => {
        const fail = entryFails(c, c.smartBuyers10m > c.smartSellers10m ? light : f);
        if (fail && why.length < 5) why.push(`${c.symbol}: ${fail}`);
        return !fail;
      })
      .slice(0, 8);
    // real money and nothing to pick from: say what the market looked like, so an idle bot can be tuned
    if (!menu.length && this.exec.mode === "real" && now - this.lastMenuLog > 5 * 60_000) {
      this.lastMenuLog = now;
      log(this.def.id, list.length ? `empty menu; nearest misses: ${why.join(" | ")}` : "empty menu: no live coins to look at");
    }
    return menu;
  }
  private lastMenuLog = 0;
  private lastBadMarkLog = 0;
  /** Tokens that landed in the real wallet without being bought (airdrops): never traded, never counted. */
  private ignoredMints = new Set<string>();

  private context(now: number, menu = this.menu(now)): TurnContext {
    const s = this.state;
    const cooldownLeft = Math.max(0, this.def.limits.buyCooldownSec * 1000 - (now - s.lastBuyAt));
    return {
      solBalance: s.solBalance,
      startSol: this.startSol,
      holdings: [...s.positions.values()].map((p) => ({
        mint: p.mint,
        symbol: p.symbol,
        pnlPct: round(positionPnlPct(p, this.market.priceOf(p.mint)), 1),
        heldMin: (now - p.openedAt) / 60_000,
        costSol: p.costSol,
      })),
      menu,
      recentSaid: this.said.slice(-5),
      rivals: floorLog
        .filter((f) => f.botId !== this.def.id && now - f.t < 20 * 60_000)
        .slice(-6)
        .map((f) => `${f.text} (${Math.round((now - f.t) / 60_000)} min ago)`),
      chat: this.recentChat.slice(-6),
      cooldownSec: Math.ceil(cooldownLeft / 1000),
      canBuy: cooldownLeft === 0 && s.positions.size < this.def.limits.maxPositions && !config.pauseBuys,
    };
  }

  /** One trading turn. Safe to call on a timer; overlapping calls are skipped. */
  /** Stop-loss, take-profit, trailing stop and max-hold, checked by code (no AI). */
  private async enforceExits(now: number) {
    const exits = forcedExits(this.state, this.def.limits, this.market, now);
    // bots that follow smart money leave a coin when the wallets they followed into it leave
    if ((this.def.strategy ?? "launches") !== "launches") {
      for (const p of this.state.positions.values()) {
        if (exits.some((x) => x.mint === p.mint)) continue;
        if (this.market.smartExiting(p.mint, p.openedAt, now)) exits.push({ mint: p.mint, reason: "smart-exit" });
      }
    }
    for (const fx of exits) {
      const p = this.state.positions.get(fx.mint)!;
      const pnl = positionPnlPct(p, this.market.priceOf(p.mint));
      const ok = await this.sell(p, fx.reason, now);
      if (ok) {
        const lines = FORCED_LINES[fx.reason === "trailing-stop" && pnl < 0 ? "stop-loss" : fx.reason] ?? FORCED_LINES["max-hold"];
        const pnlWord = fx.reason === "smart-exit" ? `${pnl >= 0 ? "plus" : "minus"} ${Math.abs(pnl).toFixed(0)}` : Math.abs(pnl).toFixed(0);
        await this.say(lines[Math.floor(Math.random() * lines.length)].replace("{sym}", p.symbol).replace("{pnl}", pnlWord), "trade");
        await this.store.updateBot(this.def.id, { sol_balance: round(this.state.solBalance, 6), trades_today: this.state.tradesToday, ...this.statsRow() }).catch(() => {});
      }
    }
  }

  /** A followed wallet just bought: a copy-trader doesn't wait for its clock. */
  onSmartBuy(now = Date.now()) {
    if ((this.def.strategy ?? "launches") === "launches" || this.def.paused || this.busy) return;
    if (now - this.lastTurnAt < 8_000) return; // already looked a moment ago
    if (this.state.positions.size >= this.def.limits.maxPositions) return;
    this.turn(now);
  }

  /** Runs every few seconds between AI turns, so a dump doesn't wait for the next turn. */
  async guard(now = Date.now()) {
    if (this.busy || this.def.paused || !this.state.positions.size) return;
    this.busy = true;
    try {
      await this.enforceExits(now);
    } catch (e) {
      log(this.def.id, "guard error:", (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  async turn(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    this.lastTurnAt = now;
    try {
      rollDay(this.state, now);
      if (this.def.paused) {
        await this.store.updateBot(this.def.id, { status: "paused" });
        return;
      }

      // real wallets: pick up deposits (owner sent more SOL)
      if (this.exec.mode === "real") {
        const chain = await this.exec.syncBalance();
        if (chain !== undefined) {
          const diff = chain - this.state.solBalance;
          if (diff > 0.001) this.startSol = round(this.startSol + diff, 6);
          this.state.solBalance = chain;
          if (diff > 0.001) await this.store.updateBot(this.def.id, { sol_balance: round(chain, 6), start_sol: this.startSol });
        }
        if (++this.turnsSinceReconcile >= 5) {
          this.turnsSinceReconcile = 0;
          await this.reconcile(now).catch((e) => log(this.def.id, "wallet check failed:", (e as Error).message));
        }
      }

      // 1) exits enforced by code, before the AI is asked anything
      await this.enforceExits(now);

      // nothing to trade with: don't spend an AI call
      if (!this.state.positions.size && this.state.solBalance < this.def.limits.minBuySol + this.def.limits.reserveSol) {
        await this.store.updateBot(this.def.id, { status: this.exec.mode === "real" ? "waiting for deposit" : "out of SOL", sol_balance: round(this.state.solBalance, 6) });
        return;
      }

      // 2) ask the AI
      await this.store.updateBot(this.def.id, { status: "thinking" });
      const menu = this.menu(now);
      const ctx = this.context(now, menu);
      const d = await this.brain.decide(this.def, ctx);
      this.watching = d.mint && this.market.getCoin(d.mint) ? d.mint : menu[0]?.mint;

      // 3) code checks the decision, then executes
      let note = "";
      if (d.action === "buy") {
        const check = checkBuy(this.state, this.def.limits, d.mint, d.sol, new Set(menu.map((c) => c.mint)), now);
        if (check.ok) {
          const picked = menu.find((c) => c.mint === d.mint);
          const ok = await this.buy(d.mint!, check.sol, now, picked?.smartBuyers10m ? picked.smartSignalWallet : undefined);
          if (!ok) note = "buy failed";
        } else {
          note = `buy blocked: ${check.reason}`;
          d.say = d.say && !/\b(in|bought|aped|aping|buying)\b/i.test(d.say) ? d.say : "";
        }
      } else if (d.action === "sell") {
        const check = checkSell(this.state, d.mint);
        if (check.ok) await this.sell(this.state.positions.get(d.mint!)!, "ai", now);
        else note = `sell skipped: ${check.reason}`;
      }

      if (note) log(this.def.id, note);
      else if (this.exec.mode === "real" && d.action !== "buy" && d.action !== "sell") {
        // real money: say why nothing happened, so a quiet bot can be understood from the log
        log(this.def.id, `${d.action}: ${menu.length} coin${menu.length === 1 ? "" : "s"} on the menu${d.thought ? ` — ${String(d.thought).slice(0, 140)}` : ""}`);
      }
      if (d.say) await this.say(d.say, d.action === "hold" ? "think" : "trade");
      await this.store.updateBot(this.def.id, {
        sol_balance: round(this.state.solBalance, 6),
        thinking: [d.thought, note && `(${note})`].filter(Boolean).join(" ").slice(0, 400),
        status: this.state.positions.size ? "in a trade" : ctx.canBuy ? "scanning" : "cooling down",
        watching_mint: this.state.positions.keys().next().value ?? this.watching ?? null,
        trades_today: this.state.tradesToday,
        ...this.statsRow(),
      });
    } catch (e) {
      log(this.def.id, "turn error:", (e as Error).message);
      await this.store.updateBot(this.def.id, { status: "glitching" }).catch(() => {});
    } finally {
      this.busy = false;
    }
  }

  private async buy(mint: string, sol: number, now: number, signalWallet?: string): Promise<boolean> {
    const coin = this.market.getCoin(mint);
    try {
      const r = await this.exec.buy(mint, sol);
      const p: Position = { mint, symbol: coin?.symbol ?? "???", tokens: r.tokens, costSol: r.solSpent, entryPrice: r.price, openedAt: now };
      recordBuy(this.state, p, r.solSpent, now);
      this.lastTradeAt = now;
      this.stats.volume += r.solSpent;
      if (this.exec.mode === "real") this.state.solBalance = (await this.exec.syncBalance()) ?? this.state.solBalance;
      await this.store.upsertPosition({ bot_id: this.def.id, mint, symbol: p.symbol, tokens: p.tokens, cost_sol: p.costSol, entry_price: p.entryPrice, opened_at: new Date(now).toISOString() });
      await this.store.insertTrade({ bot_id: this.def.id, mint, symbol: p.symbol, side: "buy", sol: r.solSpent, tokens: r.tokens, price: r.price, tx: r.tx ?? null, mode: this.exec.mode, reason: signalWallet ? `smart:${signalWallet}` : "ai" });
      pushFloor(this.def.id, `${this.def.name} bought ${p.symbol} for ${r.solSpent.toFixed(3)} SOL`, now);
      this.market.setHeld(this.heldMints());
      log(this.def.id, `BUY ${p.symbol} ${r.solSpent.toFixed(4)} SOL`);
      return true;
    } catch (e) {
      log(this.def.id, `buy ${mint} failed:`, (e as Error).message);
      return false;
    }
  }

  private async sell(p: Position, reason: string, now: number): Promise<boolean> {
    // paper money: a fill worth more than MAX_PAPER_GAIN× what was paid is a bad price, not a win.
    // (Real sells are priced by the chain, so they can't be fooled this way.)
    if (this.exec.mode !== "real" && p.costSol > 0) {
      const mark = (this.market.priceOf(p.mint) ?? 0) * p.tokens;
      if (mark > MAX_PAPER_GAIN * p.costSol) {
        if (now - this.lastBadMarkLog > 60_000) {
          this.lastBadMarkLog = now;
          log(this.def.id, `not selling ${p.symbol}: marked at ${(mark / p.costSol).toFixed(0)}x cost, which is a bad price, not a win`);
        }
        return false;
      }
    }
    try {
      const r = await this.exec.sell(p);
      const pnl = r.solReceived - p.costSol;
      recordSell(this.state, p.mint, r.solReceived, now);
      this.lastTradeAt = now;
      this.stats.volume += r.solReceived;
      this.stats.realized += pnl;
      if (pnl > 0) this.stats.wins++;
      else this.stats.losses++;
      await this.store.updateBot(this.def.id, { ...this.statsRow(), sol_balance: round(this.state.solBalance, 6) });
      if (this.exec.mode === "real") this.state.solBalance = (await this.exec.syncBalance()) ?? this.state.solBalance;
      await this.store.deletePosition(this.def.id, p.mint);
      await this.store.insertTrade({ bot_id: this.def.id, mint: p.mint, symbol: p.symbol, side: "sell", sol: r.solReceived, tokens: p.tokens, price: r.price, pnl_sol: pnl, reason, tx: r.tx ?? null, mode: this.exec.mode });
      pushFloor(this.def.id, `${this.def.name} sold ${p.symbol} (${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} SOL, ${reason})`, now);
      this.market.setHeld(this.heldMints());
      log(this.def.id, `SELL ${p.symbol} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL (${reason})`);
      return true;
    } catch (e) {
      log(this.def.id, `sell ${p.symbol} failed:`, (e as Error).message);
      return false;
    }
  }

  /** Say something on stream: text always, voice only when someone is watching. */
  async say(text: string, kind: UtteranceRow["kind"], replyTo?: string) {
    if (!text) return;
    this.said.push(text);
    if (this.said.length > 12) this.said.shift();
    this.lastSpokeAt = Date.now();
    let audio_url: string | undefined;
    if (this.viewers > 0) {
      const mp3 = await speak(this.voiceId, text);
      if (mp3) audio_url = await this.store.uploadAudio(`${this.def.id}/${Date.now()}.mp3`, mp3);
    }
    await this.store.insertUtterance({ bot_id: this.def.id, kind, text, audio_url: audio_url ?? null, reply_to: replyTo ?? null });
    try {
      this.onSay?.(this, text, kind);
    } catch {}
  }

  /** New chat for this bot arrived (the manager fetches chat for all bots at once). */
  async onChat(msgs: { username: string; text: string }[], now = Date.now()) {
    if (!msgs.length) return;
    for (const m of msgs) this.recentChat.push({ user: m.username, text: m.text.slice(0, 200) });
    if (this.recentChat.length > 20) this.recentChat.splice(0, this.recentChat.length - 20);
    if (this.busy || this.viewers === 0 || now - this.lastReplyAt < 10_000) return;
    this.busy = true;
    try {
      this.lastReplyAt = now;
      const recent = msgs.slice(-4).map((m) => ({ user: m.username, text: m.text.slice(0, 200) }));
      const reply = await this.brain.chatReply(this.def, this.context(now), recent);
      await this.say(reply, "chat", recent.map((m) => m.user).join(","));
    } catch (e) {
      log(this.def.id, "chat error:", (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Make our records match the real wallet. Catches trades whose confirmation
   * timed out but landed anyway, and bags that were sold or moved elsewhere.
   */
  async reconcile(now = Date.now()) {
    if (!this.exec.holdings) return;
    const chain = await this.exec.holdings();
    for (const p of [...this.state.positions.values()]) {
      // a bag with no cost and no market data is an airdropped scam token adopted by an earlier check: drop it
      if (p.costSol === 0 && !this.market.getCoin(p.mint)) {
        this.state.positions.delete(p.mint);
        await this.store.deletePosition(this.def.id, p.mint);
        this.ignoredMints.add(p.mint);
        log(this.def.id, `wallet check: ${p.symbol} (${p.mint.slice(0, 6)}…) was airdropped, not bought; ignoring it`);
        continue;
      }
      if (!(chain.get(p.mint)! > 0)) {
        this.state.positions.delete(p.mint);
        await this.store.deletePosition(this.def.id, p.mint);
        log(this.def.id, `wallet check: ${p.symbol} is no longer in the wallet, removed from records`);
      } else if (Math.abs(chain.get(p.mint)! - p.tokens) / p.tokens > 0.01) {
        p.tokens = chain.get(p.mint)!;
        await this.store.upsertPosition({ bot_id: this.def.id, mint: p.mint, symbol: p.symbol, tokens: p.tokens, cost_sol: p.costSol, entry_price: p.entryPrice, opened_at: new Date(p.openedAt).toISOString() });
      }
    }
    for (const [mint, tokens] of chain) {
      if (this.state.positions.has(mint) || !(tokens > 0) || this.ignoredMints.has(mint)) continue;
      const coin = this.market.getCoin(mint);
      // Fresh wallets get spam-airdropped scam tokens all day. A token the market has never seen and the
      // bot never bought is one of those: not a bag, and it must not take up a position slot.
      if (!coin) {
        this.ignoredMints.add(mint);
        log(this.def.id, `wallet check: unknown token ${mint.slice(0, 6)}… appeared in the wallet (airdrop); ignoring it`);
        continue;
      }
      const price = coin.priceSol ?? 0;
      const p: Position = { mint, symbol: coin.symbol, tokens, costSol: tokens * price, entryPrice: price, openedAt: now };
      this.state.positions.set(mint, p);
      await this.store.upsertPosition({ bot_id: this.def.id, mint, symbol: p.symbol, tokens, cost_sol: p.costSol, entry_price: price, opened_at: new Date(now).toISOString() });
      log(this.def.id, `wallet check: found ${p.symbol} in the wallet, now tracking it`);
    }
    this.market.setHeld(this.heldMints());
  }

  /** Owner withdraws: sell everything, send all SOL back to the owner, pause. */
  async withdraw(to: string, now = Date.now()): Promise<{ sol: number; tx?: string; unsold?: string[] }> {
    while (this.busy) await new Promise((r) => setTimeout(r, 200));
    this.busy = true;
    try {
      this.def.paused = true;
      const unsold: string[] = [];
      for (const p of [...this.state.positions.values()]) {
        let ok = await this.sell(p, "withdraw", now);
        if (!ok) ok = await this.sell(p, "withdraw", now); // one retry
        if (!ok) unsold.push(p.symbol); // e.g. a rugged coin nobody will buy: don't block the withdrawal
      }
      let result: { sol: number; tx?: string; unsold?: string[] };
      if (this.exec.mode === "real" && this.exec.withdrawAll) {
        result = await this.exec.withdrawAll(to);
        this.state.solBalance = 0;
        this.stats.withdrawn += result.sol;
      } else {
        result = { sol: this.state.solBalance };
      }
      if (unsold.length) result.unsold = unsold;
      await this.store.updateBot(this.def.id, { status: "withdrawn", paused: true, sol_balance: round(this.state.solBalance, 6), ...this.statsRow() });
      return result;
    } finally {
      this.busy = false;
    }
  }

  /** Fill silence while viewers are watching. */
  async idleTick(now = Date.now()) {
    if (this.busy || this.viewers === 0 || now - this.lastSpokeAt < config.idleTalkSec * 1000) return;
    this.busy = true;
    try {
      const line = await this.brain.idle(this.def, this.context(now));
      await this.say(line, "idle");
    } catch (e) {
      log(this.def.id, "idle error:", (e as Error).message);
    } finally {
      this.busy = false;
    }
  }
}
