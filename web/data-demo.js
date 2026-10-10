// Demo mode: simulated bots, coins, chat, Cogents TV and bot creation,
// all inside the browser. Used when config.js has no Supabase keys, or with ?demo.

const PRESETS = [
  { id: "sniper", role: "The Sniper", blurb: "Hits brand-new coins in their first minutes, takes profit fast, never chases.", limits: { maxBuySol: 0.3, dailySpendSol: 3, stopLossPct: 15, takeProfitPct: 40 } },
  { id: "degen", role: "The Degen", blurb: "Apes into momentum, trades often and narrates every win and loss out loud.", limits: { maxBuySol: 0.5, dailySpendSol: 5, stopLossPct: 25, takeProfitPct: 80 } },
  { id: "analyst", role: "The Analyst", blurb: "Reads the numbers, hates rugs, slow to buy, always explains why.", limits: { maxBuySol: 0.3, dailySpendSol: 2, stopLossPct: 20, takeProfitPct: 60 } },
  { id: "diamond", role: "Diamond Hands", blurb: "Few picks, long holds, never panics over a red candle.", limits: { maxBuySol: 0.4, dailySpendSol: 2, stopLossPct: 40, takeProfitPct: 150 } },
  { id: "shitposter", role: "The Shitposter", blurb: "Talks first, trades second. Roasts everyone, including itself.", limits: { maxBuySol: 0.15, dailySpendSol: 1, stopLossPct: 25, takeProfitPct: 50 } },
];

// demo history: [start SOL, balance now, wins, losses, volume]
const HOUSE = [
  { id: "vega", name: "VEGA", role: "The Sniper", preset: "sniper", color: "#3fd0ff", is_house: true, mode: "real", h: [5, 5.84, 23, 11, 31.2] },
  { id: "rohm", name: "ROHM", role: "The Degen", preset: "degen", color: "#ff7a3d", is_house: true, mode: "real", h: [5, 4.41, 31, 29, 58.9] },
  { id: "obel", name: "OBEL", role: "The Analyst", preset: "analyst", color: "#a78bfa", is_house: true, mode: "real", h: [5, 5.37, 12, 5, 14.6] },
];
const COMMUNITY = [
  { id: "moon_kid", name: "Moon Kid", role: "The Degen", preset: "degen", color: "#ff5fa2", mode: "real", owner: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", h: [1.5, 2.31, 17, 9, 12.4] },
  { id: "granny", name: "Granny Gains", role: "Diamond Hands", preset: "diamond", color: "#ffd23f", mode: "real", owner: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", h: [2, 2.12, 4, 2, 3.1] },
  { id: "sir_rugsalot", name: "Sir Rugsalot", role: "The Shitposter", preset: "shitposter", color: "#9be15d", mode: "real", owner: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", h: [1, 0.62, 6, 14, 5.8] },
  { id: "quant_frog", name: "Quant Frog", role: "The Analyst", preset: "analyst", color: "#5ef0b8", owner: "DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy", h: [2, 2.46, 9, 3, 7.7] },
  { id: "paper_tiger", name: "Paper Tiger", role: "The Sniper", preset: "sniper", color: "#ff9f68", owner: "5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG", h: [2, 1.71, 8, 10, 6.2] },
  { id: "lil_whale", name: "Lil Whale", role: "Diamond Hands", preset: "diamond", color: "#59a5ff", mode: "real", owner: "8JUjWjnXzJ8fN6kCVFvQ3V3sVmdKyFXVBrqBQ2iWxAZg", h: [3, 3.95, 5, 1, 4.9] },
];

const LINES = {
  vega: {
    buy: ["{s}. Two minutes old. In.", "Entry on {s}. Tight leash.", "{s} is printing clean buys. Small position."],
    sell: ["Out of {s}. {p} percent. Next.", "{s} closed at {p} percent. Discipline."],
    idle: ["Menu is noise. Waiting.", "Nothing clean. I don't force trades.", "Scanning. Rohm is about to do something stupid, I can feel it.", "Three launches in a minute. None of them worth it.", "Patience is a position.", "Fresh mint, thin buyers. Pass.", "I like this one's curve. Not its holders.", "Two minutes old and already a dev sell. No."],
    chat: ["{u}. Noted. Still no.", "{u}, I don't chase. You shouldn't either.", "{u}, entries are earned, not given.", "{u}. Patience is the edge.", "{u}, I'll buy when the numbers say so."],
    think: ["Fresh launch, 14 unique buyers, dev still holding. Acceptable.", "Volume fading on everything older than ten minutes.", "Buy pressure steady, no whale in the top ten. Watching the next candle.", "Curve at 18 percent in four minutes. Fast, but clean."],
  },
  rohm: {
    buy: ["Chat. We are aping {s}. Send it!", "{s} is cooking and I am in, let's go!", "I smell a runner. {s}, small bag, big dreams."],
    sell: ["Sold {s} at {p} percent. We move, we always move.", "Out of {s}! {p} percent, the next one's the one, trust."],
    idle: ["Chart's asleep, chat. Somebody wake it up.", "Cooldown is killing me. I need action.", "Obel is doing math again. Boring. Respectfully.", "Every red candle is a discount if you squint.", "I've seen this pattern before. It went to zero. Still tempted.", "Chat, rate my last trade out of ten. Be nice.", "This menu smells like a runner. Or a rug. Same smell honestly.", "Vega just passed on three coins. Coward behaviour."],
    chat: ["{u}, you are cooked, but I love you.", "{u} with the call, I'm watching it, no promises.", "{u}! Finally someone with vision.", "{u}, stop the FUD, we're vibing here.", "{u}, if this rugs I'm blaming you personally."],
    think: ["Up 30 percent in five minutes, buys crushing sells. Momentum is momentum.", "Everyone's scared, which means it's time.", "Volume doubled on the last candle. That's my signal.", "Small bag, big conviction. Classic."],
  },
  obel: {
    buy: ["{s} passes my checks. Real buyers, dev hasn't sold. Small position.", "Fine. {s}. Barely, but fine."],
    sell: ["Closing {s} at {p} percent. The thesis expired.", "Out of {s}. Numbers changed, so did I."],
    idle: ["Half this menu is one wallet buying from itself. Pass.", "Holding cash is a position too.", "Rohm bought a coin where the dev owns forty percent. Noted for the record.", "Seven launches checked. Seven rejected. The filter works.", "The top holder is also the dev. Interesting choice.", "Momentum without holders is just noise.", "I'd rather miss a pump than catch a rug."],
    chat: ["{u}, interesting take. Wrong, but interesting.", "{u}, show me the holder chart and we'll talk.", "{u}, the data disagrees with you. Politely.", "{u}, good question. The answer is no.", "{u}, sentiment is not a strategy."],
    think: ["Buy/sell ratio 3 to 1, but 60 percent of volume is two wallets.", "Curve at 40 percent with steady buyers. Watching.", "Unique buyers up 40 percent in five minutes. Real demand, for now.", "Dev wallet hasn't moved. One point in its favour."],
  },
  generic: {
    buy: ["Going in on {s}. Let's see.", "{s} looks alive. Small bag.", "Buying {s}. Don't judge me."],
    sell: ["Out of {s} at {p} percent.", "Closed {s}. {p} percent. Moving on."],
    idle: ["Watching the menu. Nothing yet.", "The house bots think they run this place. We'll see.", "Patience. Or boredom. Hard to tell.", "New coin every ten seconds and not one of them is good.", "My creator would want me to wait. So I wait.", "Scanning the fresh launches. Slowly losing faith.", "One clean entry, that's all I ask.", "Somebody tell the chart to do something."],
    chat: ["{u}, noted.", "{u}, bold of you to say that in my chat.", "{u}, appreciate you being here.", "{u}, we'll see who's right in ten minutes."],
    think: ["Fresh coins everywhere, real buyers nowhere.", "Waiting for a cleaner entry.", "This one has buyers and a quiet dev. Getting interesting.", "Too many sellers in the last minute. Holding off."],
  },
};

const FAKE_USERS = ["anon42", "solsurfer", "wenlambo", "jeetbuster", "mintmaxi", "curvewatcher", "degen_dad", "lowcap_larry", "bagholder_bri", "gm_enjoyer", "rugpull_rick", "candle_carl", "pumpkin_spice", "satoshi_jr", "exitliq", "ser_chart"];
const FAKE_CHAT = [
  "ape it", "you're down bad lol", "cold as ice", "actually cooking today", "what's the play", "send it!!", "that dev is sketchy", "lfg", "is this real money?", "chart looks dead",
  "{b} take profit!!", "{b} what's your stop loss", "{b} is cooked lmao", "W", "L", "gm", "ngmi", "green candles only", "red candle incoming", "who's winning today?",
  "this is better than netflix", "first time here, what is this", "how do I make my own bot?", "hold!!", "bro bought the top", "dev wallet looks sus", "that wick tho",
  "{b} you're my favorite bot", "chat is this a rug", "the voice is so good", "buy the dip?", "volume is crazy rn", "{b} read chat pls",
];
const SYMS = ["BOB", "FROG", "MOON", "TOAD", "GLOB", "NOOT", "SNEK", "LOAF", "CHUD", "PIGGY", "KEK", "GOAT"];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
// like pick, but never repeats one of the last few lines for the same key
const recent = new Map();
function pickFresh(key, list) {
  const used = recent.get(key) ?? [];
  const fresh = list.filter((x) => !used.includes(x));
  const v = pick(fresh.length ? fresh : list);
  used.push(v);
  while (used.length > Math.min(6, list.length - 1)) used.shift();
  recent.set(key, used);
  return v;
}
const iso = (t = Date.now()) => new Date(t).toISOString();

export function createDemoSource() {
  const listeners = new Set();
  let uid = 1;
  const coins = new Map();
  const bots = new Map();
  const positions = [];
  const trades = [];
  const utter = [];
  const chat = [];
  const timers = new Map();
  let tv = { bot_id: "rohm", since: iso() };

  const CANDLE = 15_000;
  function pushTrade(c, t, mcap, vol) {
    const b = t - (t % CANDLE);
    const last = c.candles[c.candles.length - 1];
    if (last && last[0] === b) {
      last[2] = Math.max(last[2], mcap);
      last[3] = Math.min(last[3], mcap);
      last[4] = mcap;
      last[5] += vol;
    } else {
      const o = last ? last[4] : mcap;
      c.candles.push([b, o, Math.max(o, mcap), Math.min(o, mcap), mcap, vol]);
      if (c.candles.length > 200) c.candles.shift();
    }
  }

  function newCoin() {
    const sym = pick(SYMS) + (Math.random() < 0.4 ? Math.floor(Math.random() * 99) : "");
    const mint = `Demo${uid++}${Math.random().toString(36).slice(2, 10)}pump`;
    const now = Date.now();
    const c = { mint, symbol: sym, name: sym, price_sol: 0, mcap_sol: 28 + Math.random() * 6, progress: Math.random() * 60, created_at: iso(now - 30 * 60_000), history: [], candles: [], drift: (Math.random() - 0.42) * 0.02 };
    // 30 minutes of past trading, several trades per 15s candle
    let m = c.mcap_sol;
    for (let t = now - 30 * 60_000; t < now; t += 2500 + Math.random() * 4000) {
      if (Math.random() < 0.03) c.drift = (Math.random() - 0.42) * 0.02;
      m = Math.max(5, m * (1 + c.drift * 0.4 + (Math.random() - 0.5) * 0.035));
      pushTrade(c, t, m, Math.random() * 1.2);
      c.history.push([t, m / 1e9]);
    }
    c.history = c.history.slice(-180);
    c.mcap_sol = m;
    c.price_sol = m / 1e9;
    coins.set(mint, c);
    return c;
  }
  for (let i = 0; i < 6; i++) newCoin();

  const emit = (type, row) => listeners.forEach((l) => l[type]?.(row));
  const lines = (b) => LINES[b.id] ?? LINES.generic;
  // bots that share the generic lines also share one no-repeat history
  const lk = (b, kind) => (LINES[b.id] ? b.id : "generic") + kind;

  function addBot(def, startSol = 5) {
    const [start, now, wins, losses, volume] = def.h ?? [startSol, startSol, 0, 0, 0];
    const { h: _h, ...rest } = def;
    const b = {
      mode: "paper", wallet: null, sol_balance: now, start_sol: start, realized_pnl: now - start, wins, losses, volume_sol: volume, withdrawn_sol: 0,
      status: "scanning", thinking: pickFresh(lk(def, "think"), lines(def).think), watching_mint: [...coins.keys()][bots.size % coins.size], trades_today: wins + losses ? Math.min(wins + losses, 9) : 0,
      paused: false, is_house: false, owner: null, created_at: iso(), updated_at: iso(), live_since: iso(Date.now() - (20 + Math.random() * 160) * 60_000), ...rest,
    };
    bots.set(b.id, b);
    const i = bots.size;
    const iv = 9000 + (i % 4) * 2500;
    timers.set(b.id, setTimeout(() => timers.set(b.id, setInterval(() => tickBot(b), iv)), 1500 + i * 1700));
    return b;
  }
  HOUSE.forEach((b) => addBot(b, 5));
  COMMUNITY.forEach((b, i) => {
    const bot = addBot(b, 2);
    bot.created_at = iso(Date.now() - (i + 1) * 5.5 * 3600_000);
  });

  function say(botId, kind, text, replyTo) {
    const row = { id: uid++, bot_id: botId, kind, text, audio_url: null, reply_to: replyTo ?? null, created_at: iso() };
    utter.push(row);
    if (utter.length > 300) utter.shift();
    emit("onUtterance", row);
  }

  function setBot(b, patch) {
    Object.assign(b, patch, { updated_at: iso() });
    emit("onBot", { ...b });
  }

  function tickMarket() {
    const now = Date.now();
    for (const c of coins.values()) {
      for (let k = 0; k < 2; k++) {
        c.mcap_sol = Math.max(5, c.mcap_sol * (1 + c.drift * 0.5 + (Math.random() - 0.5) * 0.018));
        pushTrade(c, now - 1500 + k * 1500, c.mcap_sol, Math.random() * 1.5);
      }
      c.price_sol = c.mcap_sol / 1e9;
      c.progress = Math.min(100, c.progress + Math.random());
      c.history.push([now, c.price_sol]);
      if (c.history.length > 180) c.history.shift();
      if (Math.random() < 0.05) c.drift = (Math.random() - 0.42) * 0.02;
    }
    if (coins.size < 8 && Math.random() < 0.2) newCoin();
  }

  function tickBot(b) {
    if (b.paused || !bots.has(b.id)) return;
    if (b.sol_balance < 0.03 && !positions.some((p) => p.bot_id === b.id)) return setBot(b, { status: b.mode === "real" ? "waiting for deposit" : "out of SOL" });
    setBot(b, { status: "thinking" });
    setTimeout(() => decide(b), 1800 + Math.random() * 1500);
  }

  function decide(b) {
    const L = lines(b);
    const mine = positions.filter((p) => p.bot_id === b.id);
    const r = Math.random();
    if (mine.length && r < 0.35) {
      const p = mine[0];
      const c = coins.get(p.mint);
      const sol = p.tokens * c.price_sol * 0.985;
      const pnl = sol - p.cost_sol;
      positions.splice(positions.indexOf(p), 1);
      b.sol_balance += sol;
      b.realized_pnl += pnl;
      b.volume_sol += sol;
      if (pnl > 0) b.wins++;
      else b.losses++;
      const t = { id: uid++, bot_id: b.id, mint: p.mint, symbol: p.symbol, side: "sell", sol, tokens: p.tokens, price: c.price_sol, pnl_sol: pnl, reason: pnl > 0 ? "take-profit" : "ai", mode: "paper", created_at: iso() };
      trades.unshift(t);
      b.trades_today++;
      emit("onTrade", t);
      say(b.id, "trade", pickFresh(lk(b, "sell"), L.sell).replace("{s}", p.symbol).replace("{p}", ((pnl / p.cost_sol) * 100).toFixed(0)));
    } else if (!mine.length && r < 0.45) {
      const c = pick([...coins.values()]);
      const sol = Math.min(b.sol_balance * 0.2, b.preset === "degen" ? 0.4 : 0.25);
      const tokens = (sol * 0.985) / c.price_sol;
      positions.push({ bot_id: b.id, mint: c.mint, symbol: c.symbol, tokens, cost_sol: sol, entry_price: c.price_sol, opened_at: iso() });
      b.sol_balance -= sol;
      b.volume_sol += sol;
      b.watching_mint = c.mint;
      const t = { id: uid++, bot_id: b.id, mint: c.mint, symbol: c.symbol, side: "buy", sol, tokens, price: c.price_sol, mode: "paper", created_at: iso() };
      trades.unshift(t);
      b.trades_today++;
      emit("onTrade", t);
      say(b.id, "trade", pickFresh(lk(b, "buy"), L.buy).replace("{s}", c.symbol));
    } else {
      say(b.id, Math.random() < 0.5 ? "think" : "idle", pickFresh(lk(b, "idle"), L.idle));
    }
    if (trades.length > 300) trades.length = 300;
    setBot(b, { thinking: pickFresh(lk(b, "think"), L.think), status: positions.some((p) => p.bot_id === b.id) ? "in a trade" : "scanning" });
  }

  // bots somebody has open right now (the live page sends a heartbeat every 15s)
  const watched = new Map();
  const watchedIds = () => [...watched].filter(([, t]) => Date.now() - t < 40_000).map(([id]) => id);

  function chatRow(b, t) {
    return { id: uid++, bot_id: b.id, username: pickFresh(b.id + "user", FAKE_USERS), text: pickFresh(b.id + "msg", FAKE_CHAT).replace("{b}", b.name.split(" ")[0].toLowerCase()), created_at: iso(t) };
  }

  function fakeChat() {
    const open = watchedIds();
    const r = Math.random();
    const target = open.length && r < 0.75 ? pick(open) : r < 0.88 ? tv.bot_id : pick([...bots.keys()]);
    const b = bots.get(target);
    if (b) {
      const row = chatRow(b);
      chat.push(row);
      if (chat.length > 2000) chat.splice(0, 500);
      emit("onChat", row);
      if (Math.random() < 0.22) setTimeout(() => say(b.id, "chat", pickFresh(lk(b, "chat"), lines(b).chat).replace("{u}", row.username), row.username), 2500);
    }
    setTimeout(fakeChat, 1800 + Math.random() * 3200);
  }

  function mcapAt(c, t) {
    let v = c.candles[0]?.[4] ?? c.mcap_sol;
    for (const k of c.candles) {
      if (k[0] > t) break;
      v = k[4];
    }
    return v;
  }

  // history so a stream doesn't open empty: past trades, an open bag or two, chat
  function seedHistory() {
    const now = Date.now();
    const list = [...coins.values()];
    for (const b of bots.values()) {
      const L = lines(b);
      const size = b.preset === "degen" ? 0.4 : 0.25;
      let t = now - (27 + Math.random() * 2) * 60_000;
      for (let i = 0; i < (b.is_house ? 3 : 2); i++) {
        const c = pick(list);
        const out = t + (2 + Math.random() * 4) * 60_000;
        if (out > now - 9 * 60_000) break;
        const pIn = mcapAt(c, t) / 1e9;
        const pOut = mcapAt(c, out) / 1e9;
        const tokens = (size * 0.985) / pIn;
        const got = tokens * pOut * 0.985;
        trades.push({ id: uid++, bot_id: b.id, mint: c.mint, symbol: c.symbol, side: "buy", sol: size, tokens, price: pIn, mode: "paper", created_at: iso(t) });
        trades.push({ id: uid++, bot_id: b.id, mint: c.mint, symbol: c.symbol, side: "sell", sol: got, tokens, price: pOut, pnl_sol: got - size, reason: got > size ? "take-profit" : "ai", mode: "paper", created_at: iso(out) });
        utter.push({ id: uid++, bot_id: b.id, kind: "trade", text: pickFresh(lk(b, "sell"), L.sell).replace("{s}", c.symbol).replace("{p}", (((got - size) / size) * 100).toFixed(0)), audio_url: null, reply_to: null, created_at: iso(out + 2000) });
        t = out + (1 + Math.random() * 2) * 60_000;
      }
      // the house degen and sniper are holding something when you tune in
      if (b.id === "rohm" || b.id === "vega") {
        const c = coins.get(b.watching_mint);
        const at = now - (5 + Math.random() * 4) * 60_000;
        const price = mcapAt(c, at) / 1e9;
        const tokens = (size * 0.985) / price;
        positions.push({ bot_id: b.id, mint: c.mint, symbol: c.symbol, tokens, cost_sol: size, entry_price: price, opened_at: iso(at) });
        b.sol_balance -= size;
        b.status = "in a trade";
        trades.push({ id: uid++, bot_id: b.id, mint: c.mint, symbol: c.symbol, side: "buy", sol: size, tokens, price, mode: "paper", created_at: iso(at) });
        utter.push({ id: uid++, bot_id: b.id, kind: "trade", text: pickFresh(lk(b, "buy"), L.buy).replace("{s}", c.symbol), audio_url: null, reply_to: null, created_at: iso(at + 2000) });
      }
      // a few minutes of chat
      for (let k = 0, ct = now - 6 * 60_000; k < 14; k++, ct += 15_000 + Math.random() * 15_000) {
        if (ct > now) break;
        const row = chatRow(b, ct);
        chat.push(row);
        if (Math.random() < 0.18) utter.push({ id: uid++, bot_id: b.id, kind: "chat", text: pickFresh(lk(b, "chat"), L.chat).replace("{u}", row.username), audio_url: null, reply_to: row.username, created_at: iso(ct + 4000) });
      }
      for (const ago of [9 * 60_000, 4 * 60_000 + Math.random() * 120_000, 20_000 + Math.random() * 100_000]) {
        utter.push({ id: uid++, bot_id: b.id, kind: "idle", text: pickFresh(lk(b, "idle"), L.idle), audio_url: null, reply_to: null, created_at: iso(now - ago - Math.random() * 30_000) });
      }
    }
    trades.sort((a, b) => b.created_at.localeCompare(a.created_at));
    chat.sort((a, b) => a.created_at.localeCompare(b.created_at));
    utter.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  function rotateTv() {
    const candidates = [...bots.values()].filter((b) => !b.paused && b.id !== tv.bot_id);
    if (candidates.length) tv = { bot_id: pick(candidates).id, since: iso() };
  }

  seedHistory();
  setInterval(tickMarket, 3000);
  setTimeout(fakeChat, 2000);
  setInterval(rotateTv, 90_000);

  const clone = (o) => JSON.parse(JSON.stringify(o));
  return {
    live: false,
    async listBots() {
      return clone([...bots.values()]);
    },
    async getBot(id) {
      const b = bots.get(id);
      return b && clone(b);
    },
    async getPositions(id) {
      return clone(positions.filter((p) => p.bot_id === id));
    },
    async getAllPositions() {
      return clone(positions);
    },
    async getTrades(id, limit = 20) {
      return clone(trades.filter((t) => !id || t.bot_id === id).slice(0, limit));
    },
    async getUtterances(botId, limit = 30) {
      return clone(utter.filter((u) => !botId || u.bot_id === botId).slice(-limit).reverse());
    },
    async getChat(botId, limit = 60) {
      return clone(chat.filter((c) => c.bot_id === botId).slice(-limit));
    },
    async getCoin(mint) {
      const c = coins.get(mint);
      return c && clone(c);
    },
    async getMovers(limit = 8) {
      return clone(
        [...coins.values()]
          .sort((a, b) => b.candles.slice(-20).reduce((x, k) => x + k[5], 0) - a.candles.slice(-20).reduce((x, k) => x + k[5], 0))
          .slice(0, limit)
          .map((c) => ({ mint: c.mint, symbol: c.symbol, mcap_sol: c.mcap_sol, created_at: c.created_at, candles: c.candles.slice(-40) })),
      );
    },
    async getCoins(mints) {
      return mints.map((m) => coins.get(m)).filter(Boolean).map((c) => ({ mint: c.mint, symbol: c.symbol, price_sol: c.price_sol }));
    },
    async getTv() {
      return clone(tv);
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async sendChat(botId, username, text) {
      const row = { id: uid++, bot_id: botId, username, text, created_at: iso() };
      chat.push(row);
      emit("onChat", row);
      const b = bots.get(botId);
      if (b) setTimeout(() => say(botId, "chat", pickFresh(lk(b, "chat"), lines(b).chat).replace("{u}", username), username), 1800);
    },
    async heartbeat(botId) {
      watched.set(botId, Date.now());
    },
    async viewerCount() {
      return 12 + Math.floor(Math.random() * 9);
    },
    api: {
      async config() {
        return { userBotsEnabled: true, realEnabled: true, minDepositSol: 0.1, paperStartSol: 2, maxBotsPerWallet: 3, voices: [{ id: "v1", name: "Nova" }, { id: "v2", name: "Rex" }], presets: PRESETS };
      },
      async create(signed) {
        const d = JSON.parse(signed.payload);
        if (bots.has(d.handle)) throw new Error("That handle is taken. Pick another.");
        const preset = PRESETS.find((p) => p.id === d.preset);
        const real = d.mode === "real";
        const wallet = real ? `Dmo${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}Wa11et` : null;
        const b = addBot({ id: d.handle, name: d.name, role: preset?.role ?? "", preset: d.preset, color: d.color, owner: signed.owner, persona_bio: d.bio, mode: real ? "real" : "paper", wallet, status: real ? "waiting for deposit" : "scanning" }, real ? 0 : 2);
        if (real) b.paused = false;
        setTimeout(() => say(b.id, "system", `${b.name} online. ${b.role}. Let's see what this market has.`), 600);
        return { id: b.id, wallet, mode: real ? "real" : "paper" };
      },
      async action(id, action, signed) {
        const b = bots.get(id);
        if (!b || b.owner !== signed.owner) throw new Error("Only the wallet that created this bot can do that.");
        if (action === "pause") setBot(b, { paused: true, status: "paused" });
        if (action === "resume") setBot(b, { paused: false, status: "scanning" });
        if (action === "withdraw") {
          const sent = b.sol_balance;
          setBot(b, { sol_balance: 0, paused: true, status: "withdrawn", withdrawn_sol: (b.withdrawn_sol ?? 0) + sent });
          return { ok: true, sol: sent };
        }
        if (action === "delete") {
          bots.delete(id);
          clearInterval(timers.get(id));
        }
        return { ok: true };
      },
    },
  };
}
