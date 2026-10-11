// Runs every bot (house + user-created): scheduling, chat, Cogents TV, and
// the create / pause / resume / withdraw / delete actions from the website.
import { BOTS, PRESETS, type BotDef } from "./bots.ts";
import { Bot } from "./bot.ts";
import type { Brain } from "./brain.ts";
import { config, botEnv } from "./config.ts";
import { PaperExecutor, RealExecutor, type Executor } from "./executor.ts";
import type { Market } from "./market.ts";
import { encryptSecret, decryptSecret, hasMasterKey } from "./secrets.ts";
import { newWallet } from "./solana.ts";
import type { Store } from "./store.ts";
import { TwitchChat } from "./twitch.ts";
import { defFromRow, userPersona, applyOwnerLimits, validateCreate } from "./userbots.ts";
import { log } from "./util.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class BotManager {
  bots = new Map<string, Bot>();
  private market: Market;
  private brain: Brain;
  private store: Store;
  private timers: ReturnType<typeof setInterval>[] = [];
  private unsubSmart?: () => void;
  private lastChatId = 0;
  private startedAt = Date.now();
  tvBotId: string | null = null;
  private tvSince = 0;
  twitch = new TwitchChat();
  private creating = new Set<string>();

  constructor(market: Market, brain: Brain, store: Store) {
    this.market = market;
    this.brain = brain;
    this.store = store;
  }

  // ------------------------------------------------------------ startup

  async load() {
    for (const def of BOTS) await this.startBot(def, this.houseExecutor(def));
    if (config.userBotsEnabled) {
      for (const row of await this.store.listUserBots()) {
        if (row.status === "deleted") continue;
        try {
          const def = defFromRow(row);
          await this.startBot(def, await this.userExecutor(row.id, row.mode));
        } catch (e) {
          log("manager", `couldn't start user bot ${row.id}:`, (e as Error).message);
        }
      }
    }
    this.lastChatId = await this.store.latestChatIdAll();
    const tv = await this.store.getTv().catch(() => undefined);
    if (tv?.bot_id && this.bots.has(tv.bot_id)) {
      this.tvBotId = tv.bot_id;
      this.tvSince = Date.parse(tv.since) || Date.now();
    }
    this.market.setHeld(this.allHeld());
  }

  private houseExecutor(def: BotDef): Executor {
    if (botEnv(def.id, "MODE").toLowerCase() === "real") {
      const secret = botEnv(def.id, "SECRET_KEY");
      if (!config.realTradingEnabled) log(def.id, "mode is real but REAL_TRADING_ENABLED is false → paper mode");
      else if (!secret) log(def.id, "mode is real but no SECRET_KEY → paper mode");
      else return new RealExecutor(secret, this.market);
    }
    return new PaperExecutor(this.market);
  }

  private async userExecutor(botId: string, mode: string): Promise<Executor> {
    if (mode !== "real") return new PaperExecutor(this.market);
    if (!config.realTradingEnabled || !config.userRealTradingEnabled) throw new Error("real-money user bots are switched off");
    const enc = await this.store.getBotSecret(botId);
    if (!enc) throw new Error("wallet key missing");
    return new RealExecutor(decryptSecret(enc), this.market);
  }

  private async startBot(def: BotDef, exec: Executor) {
    const bot = new Bot(def, this.market, this.brain, this.store, exec);
    bot.onSay = (b, text, kind) => {
      if (b.def.id === this.tvBotId && (kind === "chat" || kind === "trade")) this.twitch.say(`[${b.def.name}] ${text}`);
    };
    await bot.init();
    // stagger first turns so bots don't all think at once
    bot.lastTurnAt = Date.now() - bot.def.turnSec * 1000 + 20_000 + Math.random() * 40_000;
    this.bots.set(def.id, bot);
    return bot;
  }

  allHeld() {
    return [...this.bots.values()].flatMap((b) => b.heldMints());
  }

  // ------------------------------------------------------------ loops

  start() {
    this.twitch.onMessage = (m) => {
      if (!this.tvBotId) return;
      this.store.insertChat({ bot_id: this.tvBotId, viewer_id: `twitch:${m.user.toLowerCase()}`, username: m.user, text: m.text }).catch(() => {});
    };
    this.twitch.start();
    this.timers.push(setInterval(() => this.schedule(), 5_000));
    this.timers.push(setInterval(() => this.bots.forEach((b) => b.guard()), 4_000));
    // a followed wallet buys: copy-traders look right away
    this.unsubSmart = this.market.onSmart((c, t) => {
      log("smart", `${t.wallet.slice(0, 4)}…${t.wallet.slice(-4)} ${t.side === "buy" ? "bought" : "sold"} ${c.symbol} ${t.sol.toFixed(3)} SOL`);
      if (t.side !== "buy") return;
      for (const b of this.bots.values()) b.onSmartBuy();
    });
    this.timers.push(setInterval(() => this.chatAndViewers(), 6_000));
    this.timers.push(setInterval(() => this.idle(), 10_000));
    this.timers.push(setInterval(() => this.pickTv().catch((e) => log("tv", e.message)), 30_000));
    setTimeout(() => this.pickTv().catch(() => {}), 25_000);
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.unsubSmart?.();
    this.twitch.stop();
  }

  /** Decide which bots take a trading turn now. Unwatched user bots think less often (saves AI cost). */
  private schedule(now = Date.now()) {
    for (const b of this.bots.values()) {
      if (b.def.paused) continue;
      const watched = b.def.house || b.viewers > 0 || b.def.id === this.tvBotId;
      const every = (watched ? b.def.turnSec : Math.max(b.def.turnSec, config.userBotIdleTurnSec)) * 1000;
      if (now - b.lastTurnAt >= every) b.turn(now);
    }
  }

  private async chatAndViewers(now = Date.now()) {
    try {
      const [counts, fresh] = await Promise.all([this.store.viewerCounts(), this.store.newChatAll(this.lastChatId)]);
      for (const b of this.bots.values()) b.viewers = counts.get(b.def.id) ?? 0;
      if (!fresh.length) return;
      this.lastChatId = fresh[fresh.length - 1].id;
      const byBot = new Map<string, { username: string; text: string }[]>();
      for (const m of fresh) {
        if (!byBot.has(m.bot_id)) byBot.set(m.bot_id, []);
        byBot.get(m.bot_id)!.push(m);
      }
      for (const [id, msgs] of byBot) this.bots.get(id)?.onChat(msgs, now);
    } catch (e) {
      log("manager", "chat poll failed:", (e as Error).message);
    }
  }

  private idle(now = Date.now()) {
    for (const b of this.bots.values()) if (!b.def.paused) b.idleTick(now);
  }

  // ------------------------------------------------------------ Cogents TV

  /** Score how interesting a bot is to watch right now. */
  private tvScore(b: Bot, now: number): number {
    if (b.def.paused) return -1;
    if (!b.state.positions.size && b.state.solBalance < b.def.limits.minBuySol + b.def.limits.reserveSol) return -1;
    let s = Math.random() * 2;
    if (b.def.house) s += 2;
    s += b.state.positions.size * 3;
    if (now - b.lastTradeAt < 10 * 60_000) s += 3;
    s += Math.min(b.viewers, 10) * 0.3;
    return s;
  }

  /** Rotate the featured bot on Cogents TV every few minutes, but never mid-trade. */
  async pickTv(now = Date.now()) {
    const current = this.tvBotId ? this.bots.get(this.tvBotId) : undefined;
    const due = !current || current.def.paused || now - this.tvSince > config.tvRotateMin * 60_000;
    if (!due) return;
    if (current && !current.def.paused && current.state.positions.size && now - this.tvSince < config.tvRotateMin * 3 * 60_000) return;
    let best: Bot | undefined;
    let bestScore = -1;
    for (const b of this.bots.values()) {
      if (b === current && this.bots.size > 1) continue;
      const sc = this.tvScore(b, now);
      if (sc > bestScore) {
        bestScore = sc;
        best = b;
      }
    }
    if (!best || best === current) return;
    this.tvBotId = best.def.id;
    this.tvSince = now;
    await this.store.setTv(best.def.id);
    log("tv", `now featuring ${best.def.name}`);
  }

  // ------------------------------------------------------------ user actions

  publicConfig() {
    return {
      userBotsEnabled: config.userBotsEnabled,
      realEnabled: config.userBotsEnabled && config.userRealTradingEnabled && config.realTradingEnabled && hasMasterKey() && !!config.solanaRpcUrl,
      paperStartSol: config.userPaperStartSol,
      minDepositSol: config.minDepositSol,
      maxBotsPerWallet: config.maxBotsPerWallet,
      voices: config.userVoices.map((v) => ({ id: v.id, name: v.name })),
      presets: Object.values(PRESETS).map((p) => ({ id: p.id, role: p.role, blurb: p.blurb, limits: { maxBuySol: p.limits.maxBuySol, dailySpendSol: p.limits.dailySpendSol, stopLossPct: p.limits.stopLossPct, takeProfitPct: p.limits.takeProfitPct } })),
    };
  }

  async createBot(owner: string, input: unknown) {
    if (!config.userBotsEnabled) throw new ApiError(403, "Creating bots isn't open yet.");
    const v = validateCreate(input);
    if (!v.ok) throw new ApiError(400, v.errors.join(" "));
    const b = v.value;
    if (b.mode === "real" && !this.publicConfig().realEnabled) throw new ApiError(400, "Real-money bots aren't open yet. Create a paper bot for now.");
    if (this.bots.has(b.handle) || this.creating.has(b.handle) || (await this.store.getBot(b.handle))) throw new ApiError(409, "That handle is taken. Pick another.");

    const userBots = [...this.bots.values()].filter((x) => !x.def.house);
    if (b.mode === "real" && !hasMasterKey()) throw new ApiError(503, "Real-money bots are being set up. Try again soon.");
    if (userBots.length >= config.maxUserBots) throw new ApiError(429, "All bot slots are full right now. Try again later.");
    if (userBots.filter((x) => x.def.owner === owner).length >= config.maxBotsPerWallet) {
      throw new ApiError(429, `You can run up to ${config.maxBotsPerWallet} bots per wallet. Delete one to make another.`);
    }

    this.creating.add(b.handle);
    try {
      const verdict = await this.brain.moderate(`Name: ${b.name}\nHandle: ${b.handle}\nDescription: ${b.bio}`).catch(() => ({ ok: true }) as { ok: boolean; reason?: string });
      if (!verdict.ok) throw new ApiError(400, verdict.reason ?? "This character isn't allowed. Change the name or description.");

      let wallet: string | null = null;
      let secret: string | undefined;
      if (b.mode === "real") {
        const w = newWallet();
        wallet = w.publicKey;
        secret = w.secret;
      }
      const preset = PRESETS[b.preset];
      await this.store.insertBot({
        id: b.handle,
        name: b.name,
        role: preset.role,
        color: b.color,
        mode: b.mode ?? "paper",
        wallet,
        sol_balance: 0,
        start_sol: 0,
        status: "new",
        thinking: "",
        trades_today: 0,
        owner,
        preset: b.preset,
        persona_bio: b.bio,
        voice_id: b.voice ?? null,
        limits: (b.limits ?? {}) as Record<string, number>,
        is_house: false,
        paused: false,
      });
      if (secret) await this.store.setBotSecret(b.handle, encryptSecret(secret));

      const row = await this.store.getBot(b.handle);
      const def = defFromRow(row!);
      const exec = secret ? new RealExecutor(secret, this.market) : new PaperExecutor(this.market);
      const bot = await this.startBot(def, exec);
      bot.lastTurnAt = Date.now() - def.turnSec * 1000 + 5_000; // first turn in ~5s
      await bot.say(`${def.name} online. ${def.role}. Let's see what this market has.`, "system");
      log("manager", `user bot created: ${def.id} by ${owner}`);
      return { id: def.id, wallet, mode: b.mode ?? "paper" };
    } finally {
      this.creating.delete(b.handle);
    }
  }

  private ownedBot(owner: string, id: string): Bot {
    const bot = this.bots.get(id);
    if (!bot || bot.def.house) throw new ApiError(404, "Bot not found.");
    if (bot.def.owner !== owner) throw new ApiError(403, "Only the wallet that created this bot can do that.");
    return bot;
  }

  async action(owner: string, id: string, action: string, payload: any) {
    const bot = this.ownedBot(owner, id);
    switch (action) {
      case "pause":
        bot.def.paused = true;
        await this.store.updateBot(id, { paused: true, status: "paused" });
        return { ok: true };
      case "resume":
        bot.def.paused = false;
        bot.lastTurnAt = 0;
        await this.store.updateBot(id, { paused: false, status: "warming up" });
        return { ok: true };
      case "update": {
        const bio = typeof payload?.bio === "string" ? payload.bio : undefined;
        const limits = payload?.limits;
        const patch: Record<string, unknown> = {};
        if (bio !== undefined) {
          const v = validateCreate({ handle: "check_only", name: bot.def.name, preset: bot.def.preset, bio, color: bot.def.color });
          if (!v.ok) throw new ApiError(400, v.errors.join(" "));
          const verdict = await this.brain.moderate(`Name: ${bot.def.name}\nDescription: ${bio}`).catch(() => ({ ok: true }) as { ok: boolean; reason?: string });
          if (!verdict.ok) throw new ApiError(400, verdict.reason ?? "This description isn't allowed.");
          patch.persona_bio = v.value.bio;
          bot.def.persona = userPersona(bot.def.name, bot.def.preset, v.value.bio);
        }
        if (limits && typeof limits === "object") {
          const clean: Record<string, number> = {};
          for (const k of ["maxBuySol", "dailySpendSol", "stopLossPct", "takeProfitPct"]) if (Number(limits[k]) > 0) clean[k] = Number(limits[k]);
          patch.limits = clean;
          bot.def.limits = applyOwnerLimits(PRESETS[bot.def.preset].limits, clean);
        }
        if (Object.keys(patch).length) await this.store.updateBot(id, patch as any);
        return { ok: true };
      }
      case "withdraw": {
        const r = await bot.withdraw(owner);
        return { ok: true, ...r };
      }
      case "delete": {
        if (bot.exec.mode === "real" && bot.state.solBalance > 0.002) throw new ApiError(400, "Withdraw the bot's SOL first, then delete it.");
        bot.def.paused = true;
        this.bots.delete(id);
        if (this.tvBotId === id) this.tvBotId = null;
        if (bot.exec.mode === "real") {
          // Real bots are archived, never erased: the encrypted wallet key stays in the
          // database so SOL sent to the old address later can still be recovered by you.
          await this.store.updateBot(id, { status: "deleted", paused: true });
        } else {
          await this.store.deleteBot(id);
        }
        return { ok: true };
      }
      default:
        throw new ApiError(400, "Unknown action.");
    }
  }
}
