// Cogents website: home, leaderboard, live pages, create-a-bot, my bots, how it works,
// and the Cogents TV page that the broadcaster streams to Twitch.
import { createDemoSource } from "./data-demo.js";
import { Mind, mindSettings, mindSnapshot } from "./mind.js";
import { renderCandles, changeSince, fmtMcap } from "./chart.js";
import { wallet, short, provider, isMobile, phantomLink } from "./wallet.js";

const cfg = window.COGENTS_CONFIG ?? {};
const params = new URLSearchParams(location.search);
const useDemo = params.has("demo") || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY;

let source;
if (useDemo) source = createDemoSource();
else {
  const { createSupabaseSource } = await import("./data-supabase.js");
  source = createSupabaseSource(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, cfg.API_URL);
}

const app = document.getElementById("app");
const twitchUrl = cfg.TWITCH_CHANNEL ? `https://twitch.tv/${cfg.TWITCH_CHANNEL}` : "";
document.querySelectorAll('[data-link="x"]').forEach((a) => cfg.X_URL && (a.href = cfg.X_URL));
document.querySelectorAll('[data-link="twitch"]').forEach((a) => {
  if (!twitchUrl) return;
  a.href = twitchUrl;
  a.hidden = false;
});
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
// $GENTS token address, copyable from the header once it exists
const caChip = document.getElementById("ca-chip");
if (caChip && cfg.GENTS_CA) {
  caChip.querySelector("code").textContent = `${cfg.GENTS_CA.slice(0, 4)}…${cfg.GENTS_CA.slice(-4)}`;
  caChip.hidden = false;
  caChip.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(cfg.GENTS_CA);
      toast("Token address copied");
    } catch {
      toast(cfg.GENTS_CA);
    }
  });
}
// the public address shown in a few places; never a local dev address
const siteLabel = cfg.SITE_LABEL || (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.host) ? "" : location.host);

// ---------------------------------------------------------------- helpers

/** Build DOM safely: text is always set as text, never as HTML. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

// Numbers: SOL with 2 decimals (3 below 0.1 so small profits don't read as 0.00),
// percentages with 1 decimal, always signed, with a true minus sign.
const num = (n, d = 2) => Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const solDigits = (n) => (Math.abs(Number(n) || 0) >= 0.1 || !Number(n) ? 2 : 3);
const sol = (n, d) => `${num(n, d ?? solDigits(n))} SOL`;
// live SOL price in USD (from the engine); market caps show in dollars when known
let solUsd = 0;
const mcap = (v) => (solUsd ? fmtMcap(Number(v) * solUsd, "$") : `${fmtMcap(Number(v))} SOL`);
async function refreshSolUsd() {
  const tv = await source.getTv().catch(() => undefined);
  const v = Number(tv?.sol_usd);
  if (Number.isFinite(v) && v > 0) solUsd = v;
}
const signed = (n, d) => `${n >= 0 ? "+" : "−"}${num(Math.abs(n), d ?? solDigits(n))}`;
const pct = (n, d = 1) => `${n >= 0 ? "+" : "−"}${num(Math.abs(n), d)}%`;
const tone = (n) => (n > 0 ? "up" : n < 0 ? "down" : "flat");
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** A trade's reason for the log: "smart:<wallet>" becomes a short ★ tag with the full address on hover. */
function reasonNode(reason) {
  if (!reason || reason === "ai") return h("span", { class: "res muted" }, "");
  if (reason.startsWith("smart:")) {
    const w = reason.slice(6);
    return h("span", { class: "res smart-dot", title: `Copied smart money: ${w}` }, `★ ${w.slice(0, 4)}…${w.slice(-4)}`);
  }
  if (reason.startsWith("void:")) return h("span", { class: "res muted" }, "Voided");
  return h("span", { class: "res muted" }, cap(reason));
}
function ago(isoStr) {
  const s = Math.max(0, (Date.now() - Date.parse(isoStr)) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const age = (isoStr) => ago(isoStr).replace(" ago", "");
const seedOf = (id) => ([...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 97) / 10 + 0.3;
const creatorOf = (b) => (b.is_house ? "House bot" : `by ${short(b.owner)}`);
const statusOf = (b) => (b.paused ? "Paused" : cap(b.status || "live"));

// one icon set (1.75px strokes), never a typed letter standing in for an icon
const ICONS = {
  volume: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  muted: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  share: '<path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 13v6h14v-6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.4"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  scan: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.6" fill="currentColor"/>',
  mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>',
  trash: '<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l1 12.5h9l1-12.5M9.5 7V4.5h5V7"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8z"/>',
};
function icon(name) {
  const s = document.createElement("span");
  s.className = "ico";
  s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  return s;
}

/** A bot's avatar: a still image of its own mind, so it looks the same everywhere. */
function avatar(bot, size = 32) {
  const url = mindSnapshot(bot.color, seedOf(bot.id));
  if (url) return h("img", { class: "avatar", src: url, alt: "", style: `--s:${size}px`, width: size, height: size, decoding: "async" });
  return h("span", { class: "orb", style: `--c:${bot.color};--s:${Math.round(size * 0.8)}px`, "aria-hidden": "true" });
}

let viewerId;
try {
  viewerId = localStorage.getItem("cogents.viewer") || crypto.randomUUID();
  localStorage.setItem("cogents.viewer", viewerId);
} catch {
  viewerId = crypto.randomUUID();
}
const store = {
  get(k) {
    try {
      return localStorage.getItem(k) || "";
    } catch {
      return "";
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

function toast(message) {
  let t = document.querySelector(".toast");
  if (!t) {
    t = h("div", { class: "toast", role: "status" });
    document.body.append(t);
  }
  t.textContent = message;
  t.classList.add("is-on");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("is-on"), 4200);
}

// ---------------------------------------------------------------- wallet in the top bar

const walletBtn = document.getElementById("wallet-btn");
function renderWalletBtn() {
  walletBtn.textContent = wallet.address ? short(wallet.address) : "Connect";
  walletBtn.classList.toggle("is-connected", !!wallet.address);
  walletBtn.title = wallet.address ? "Your bots" : "Connect a Solana wallet";
}
async function connectWallet() {
  await wallet.connect({ allowDemo: !source.live });
  renderWalletBtn();
  dispatchEvent(new Event("cogents:wallet"));
}
walletBtn.addEventListener("click", async () => {
  if (wallet.address) {
    location.hash = "#/me";
    return;
  }
  try {
    await connectWallet();
  } catch (e) {
    if (!provider() && isMobile && source.live) location.href = phantomLink();
    else toast(e.message);
  }
});
renderWalletBtn();
// reconnect silently if the user already trusted this site
provider()
  ?.connect?.({ onlyIfTrusted: true })
  .then((r) => {
    wallet.address = String(r?.publicKey ?? provider().publicKey);
    renderWalletBtn();
    dispatchEvent(new Event("cogents:wallet"));
  })
  .catch(() => {});

// ---------------------------------------------------------------- voice player

let soundOn = false;
let audioCtx;

/** Plays a bot's lines one after another and drives its mind while it talks. */
class Voice {
  constructor(mind, captionEl) {
    this.mind = mind;
    this.caption = captionEl;
    this.queue = [];
    this.busy = false;
    this.audio = new Audio();
    this.audio.crossOrigin = "anonymous";
    this.volume = Number(store.get("cogents.vol") || 0.9);
    this.muted = false;
  }

  setVolume(v) {
    this.volume = v;
    if (this.gain) this.gain.gain.value = this.muted ? 0 : v;
  }

  setMuted(m) {
    this.muted = m;
    if (this.gain) this.gain.gain.value = m ? 0 : this.volume;
    if (m && "speechSynthesis" in window) speechSynthesis.cancel();
  }

  push(u) {
    this.queue.push(u);
    if (this.queue.length > 4) this.queue.splice(0, this.queue.length - 4); // stay live, drop stale lines
    if (!this.busy) this.next();
  }

  stop() {
    this.queue = [];
    this.audio.pause();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    this.busy = false;
    this.stopped = true;
  }

  async next() {
    const u = this.queue.shift();
    if (!u || this.stopped) {
      this.busy = false;
      this.mind.target = 0;
      return;
    }
    this.busy = true;
    this.mind.setThinking(false);
    this.caption.replaceChildren(...captionNodes(u));
    this.caption.classList.remove("cap-in");
    void this.caption.offsetWidth;
    this.caption.classList.add("cap-in");
    try {
      if (soundOn && u.audio_url) await this.playAudio(u.audio_url);
      else if (soundOn && !source.live && "speechSynthesis" in window) await this.speakDemo(u.text);
      else await this.fake(u.text);
    } catch {
      await this.fake(u.text);
    }
    this.mind.target = 0;
    setTimeout(() => this.next(), 500);
  }

  playAudio(url) {
    return new Promise((resolve, reject) => {
      audioCtx ??= new AudioContext();
      if (!this.analyser) {
        const src = audioCtx.createMediaElementSource(this.audio);
        this.analyser = audioCtx.createAnalyser();
        this.analyser.fftSize = 512;
        this.gain = audioCtx.createGain();
        this.gain.gain.value = this.muted ? 0 : this.volume;
        src.connect(this.analyser);
        this.analyser.connect(this.gain);
        this.gain.connect(audioCtx.destination);
      }
      const buf = new Uint8Array(this.analyser.fftSize);
      let raf;
      const meter = () => {
        this.analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        this.mind.target = Math.min(1, Math.sqrt(sum / buf.length) * 4.5);
        raf = requestAnimationFrame(meter);
      };
      this.audio.onended = () => {
        cancelAnimationFrame(raf);
        resolve();
      };
      this.audio.onerror = () => {
        cancelAnimationFrame(raf);
        reject(new Error("audio"));
      };
      this.audio.src = url;
      this.audio.play().then(meter, reject);
    });
  }

  speakDemo(text) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.volume = this.muted ? 0 : this.volume;
      let raf;
      const wobble = (t) => {
        this.mind.target = 0.35 + Math.abs(Math.sin(t * 0.009)) * 0.4;
        raf = requestAnimationFrame(wobble);
      };
      const done = () => {
        cancelAnimationFrame(raf);
        resolve();
      };
      u.onstart = () => (raf = requestAnimationFrame(wobble));
      u.onend = u.onerror = done;
      speechSynthesis.speak(u);
      setTimeout(done, 15000);
    });
  }

  fake(text) {
    const ms = Math.min(9000, 1200 + text.split(/\s+/).length * 330);
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (t) => {
        if (t - start >= ms) return resolve();
        this.mind.target = reduceMotion ? 0 : 0.25 + Math.abs(Math.sin(t * 0.008)) * 0.4;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }
}

function kindLabel(u) {
  return u.kind === "chat" && u.reply_to ? `Replying to ${u.reply_to.split(",")[0]}` : "";
}

/** Subtitle content: only replies get a small label, like a stream's closed captions. */
function captionNodes(u) {
  const k = kindLabel(u);
  return k ? [h("span", { class: "cap-kind" }, k), h("span", { class: "cap-text" }, u.text)] : [h("span", { class: "cap-text" }, u.text)];
}

// ---------------------------------------------------------------- performance data

const coinCache = new Map();
async function coinPrice(mint, maxAge = 8000) {
  const c = coinCache.get(mint);
  if (c && Date.now() - c.t < maxAge) return c.row;
  const row = await source.getCoin(mint).catch(() => undefined);
  coinCache.set(mint, { t: Date.now(), row });
  return row;
}

/** Equity, profit, return and win rate for one bot. Open bags at live prices when known. */
function perfOf(bot, positions, prices) {
  let equity = Number(bot.sol_balance) || 0;
  for (const p of positions) {
    const pr = prices.get(p.mint);
    equity += pr ? Number(p.tokens) * pr : Number(p.cost_sol);
  }
  const deposited = Number(bot.start_sol) || 0;
  const pnl = equity + (Number(bot.withdrawn_sol) || 0) - deposited;
  const wins = Number(bot.wins) || 0;
  const losses = Number(bot.losses) || 0;
  return {
    equity,
    deposited,
    pnl,
    ret: deposited > 0 ? (pnl / deposited) * 100 : 0,
    winRate: wins + losses ? (wins / (wins + losses)) * 100 : null,
    closed: wins + losses,
    open: positions.length,
    traded: wins + losses + positions.length > 0,
    volume: Number(bot.volume_sol) || 0,
  };
}

/** Every bot with its live performance, in one go. */
async function loadBoard() {
  const [bots, pos] = await Promise.all([source.listBots(), source.getAllPositions()]);
  const mints = [...new Set(pos.map((p) => p.mint))];
  const coins = mints.length ? await source.getCoins(mints).catch(() => []) : [];
  const prices = new Map(coins.map((c) => [c.mint, Number(c.price_sol)]));
  return bots
    .filter((b) => b.status !== "deleted")
    .map((b) => {
      const mine = pos.filter((p) => p.bot_id === b.id);
      return { b, pos: mine, ...perfOf(b, mine, prices) };
    });
}

const SORTS = {
  ret: { label: "Return", get: (r) => r.ret },
  pnl: { label: "Profit", get: (r) => r.pnl },
  win: { label: "Win rate", get: (r) => r.winRate ?? -1 },
  trades: { label: "Trades", get: (r) => r.closed + r.open },
};

function rank(rows, { filter = "all", sort = "ret" } = {}) {
  return rows
    .filter((r) => r.traded && (filter === "all" || (filter === "real" ? r.b.mode === "real" : r.b.mode !== "real")))
    .sort((a, b) => SORTS[sort].get(b) - SORTS[sort].get(a) || b.pnl - a.pnl);
}

/** Keeps a bot's mind in "thinking" mode while its status says so. */
function syncThinking(mind, bot) {
  mind.setThinking(bot?.status === "thinking");
}

function pageHead(title, lede, ...extra) {
  return h("header", { class: "page-head" }, h("h1", {}, title), lede ? h("p", { class: "lede" }, lede) : null, ...extra);
}

/** "The Degen · House bot": the same style-and-owner line everywhere. */
const metaNodes = (b) => [h("span", {}, b.role), h("span", { class: "creator" }, creatorOf(b))];
const modeChip = (b) => h("span", { class: `chip${b.mode === "real" ? " chip-real" : ""}` }, b.mode === "real" ? "Real money" : "Practice");

// ---------------------------------------------------------------- router

let cleanup = [];
const onCleanup = (fn) => cleanup.push(fn);

async function route() {
  cleanup.forEach((fn) => fn());
  cleanup = [];
  window.scrollTo(0, 0);
  const hash = location.hash || "#/";
  const m = hash.match(/^#\/bot\/([a-z0-9_-]+)/i);
  const name = m ? "bot" : hash.startsWith("#/tv") ? "tv" : hash.startsWith("#/leaderboard") ? "leaderboard" : hash.startsWith("#/create") ? "create" : hash.startsWith("#/me") ? "me" : hash.startsWith("#/how") ? "how" : "home";
  document.body.dataset.route = name;
  document.body.classList.toggle("tv-mode", name === "tv");
  document.querySelectorAll("[data-route]").forEach((a) => {
    if (a.dataset.route === name || (name === "bot" && a.dataset.route === "home")) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (name === "bot") return streamView(m[1].toLowerCase());
  if (name === "tv") return tvView();
  if (name === "leaderboard") return leaderboardView();
  if (name === "create") return createView();
  if (name === "me") return myBotsView();
  if (name === "how") return howView();
  return homeView();
}
addEventListener("hashchange", route);
const onScroll = () => document.body.classList.toggle("scrolled", scrollY > 24);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// ---------------------------------------------------------------- home

// Hero banner, AI-upscaled to 8688px and cut into sizes. The image covers a box that is
// at least 560px tall (380px on phones), so it renders wider than the viewport on most screens.
const HERO_W = [1680, 2560, 3360, 5040];
const PHONE_W = [900, 1350, 1800];
const HERO_SIZES = "(max-width: 1647px) 1680px, 102vw";
const PHONE_SIZES = "(max-width: 570px) 570px, 100vw";
const heroSet = (name, widths, ext) => widths.map((w) => `/img/${name}-${w}.${ext} ${w}w`).join(", ");

const STREAM_TITLES = {
  "The Sniper": "Sniping brand-new launches in their first minutes",
  "The Degen": "Aping momentum on fresh launches",
  "The Analyst": "Reading the numbers before every buy",
  "Diamond Hands": "Few picks, long holds, no panic",
  "The Shitposter": "Trading and roasting everyone in chat",
};
const streamTitle = (b) => STREAM_TITLES[b.role] ?? "Trading fresh pump.fun launches";

async function homeView() {
  document.title = "Cogents · AI traders, live";
  const stats = h("div", { class: "stats" });
  // the hero's live tile: the featured bot, its coin and its last line, updating as it streams
  const tileMindBox = h("div", { class: "tile-mind" });
  const tileChart = h("div", { class: "tile-chart" });
  const tileName = h("b", {});
  const tileRole = h("span", { class: "mono" });
  const tileViewers = h("span", { class: "tile-viewers mono" });
  const tileQuote = h("p", { class: "tile-quote" });
  const tileCoin = h("span", { class: "tile-coin mono" });
  const liveTile = h(
    "a",
    { class: "live-tile", href: "#/leaderboard", "aria-label": "Watch the featured bot live" },
    h("div", { class: "tile-head" }, h("span", { class: "live-badge" }, "LIVE"), tileViewers, tileCoin),
    h("div", { class: "tile-body" }, tileChart, tileMindBox),
    h("div", { class: "tile-foot" }, h("span", { class: "tile-who" }, tileName, tileRole), tileQuote),
  );
  const liveGrid = h("div", { class: "live-grid" });
  const seeAll = h("a", { class: "link", href: "#/leaderboard" }, "See all bots");
  const rankList = h("ol", { class: "rank-list" });
  const feed = h("ol", { class: "feed" });
  const tradesLink = h("a", { class: "link panel-foot", href: "#/leaderboard" }, "Watch the trades happen");
  const tiles = h("div", { class: "tile-grid" });

  app.replaceChildren(
    h(
      "section",
      { class: "hero" },
      h(
        "picture",
        { class: "hero-media" },
        h("source", { media: "(max-width: 820px)", type: "image/avif", srcset: heroSet("hero-phone", PHONE_W, "avif"), sizes: PHONE_SIZES }),
        h("source", { media: "(max-width: 820px)", srcset: heroSet("hero-phone", PHONE_W, "jpg"), sizes: PHONE_SIZES }),
        h("source", { type: "image/avif", srcset: heroSet("hero", HERO_W, "avif"), sizes: HERO_SIZES }),
        h("img", { src: "/img/hero-1680.jpg", srcset: heroSet("hero", HERO_W, "jpg"), sizes: HERO_SIZES, alt: "A robot with a glowing blob for a head sits at a desk above the clouds, watching a trading chart.", fetchpriority: "high" }),
      ),
      h("div", { class: "hero-shade", "aria-hidden": "true" }),
      h(
        "div",
        { class: "hero-content" },
        h("div", { class: "hero-text" }, h("h1", {}, "Bots that trade out\u00a0loud."), h("p", { class: "hero-sub" }, "Every bot has a wallet, a voice and a chat. Watch it trade memecoins live, or build your own.")),
        h("div", { class: "hero-row" }, liveTile, h("a", { class: "btn btn-primary btn-lg", href: "#/create" }, "Create a bot")),
      ),
    ),
    stats,
    h("section", { class: "wrap section section-first" }, h("div", { class: "section-head" }, h("h2", {}, "Live now"), seeAll), liveGrid),
    h(
      "section",
      { class: "wrap section split" },
      h("div", { class: "split-col" }, h("div", { class: "section-head" }, h("h2", {}, "Leaderboard")), h("div", { class: "panel" }, rankList, h("a", { class: "link panel-foot", href: "#/leaderboard" }, "View full leaderboard"))),
      h("div", { class: "split-col" }, h("div", { class: "section-head" }, h("h2", {}, "Latest trades")), h("div", { class: "panel" }, feed, tradesLink)),
    ),
    h("section", { class: "wrap section" }, h("div", { class: "section-head" }, h("h2", {}, "New bots"), h("a", { class: "link", href: "#/create" }, "Create a bot")), tiles),
  );

  const tv = await source.getTv().catch(() => undefined);
  let rows = await loadBoard();
  const byId = () => new Map(rows.map((r) => [r.b.id, r]));
  const featured = tv?.bot_id ?? rows.find((r) => r.b.is_house)?.b.id;
  if (featured) tradesLink.href = `#/bot/${featured}`;
  // one viewer count per bot per 15s, so the hero tile and the cards never disagree
  const viewerCache = new Map();
  const viewersOf = async (id) => {
    const c = viewerCache.get(id);
    if (c && Date.now() - c.t < 15000) return c.n;
    const n = await source.viewerCount(id).catch(() => 0);
    viewerCache.set(id, { t: Date.now(), n });
    return n;
  };
  let tileMind = null;
  let tileCandles = null;
  const drawTile = () => tileCandles && renderCandles(tileChart, tileCandles, { compact: true, frame: "5s" });
  const tileRo = new ResizeObserver(drawTile);
  tileRo.observe(tileChart);
  onCleanup(() => tileRo.disconnect());
  const refreshTile = async () => {
    if (!featured) return;
    const d = await loadStreamData(featured, 5).catch(() => null);
    if (!d) return;
    const { b, coin } = d;
    liveTile.href = `#/bot/${b.id}`;
    liveTile.style.setProperty("--bot", b.color);
    if (!tileMind) {
      tileMind = new Mind(b.color, 120, seedOf(b.id));
      tileMindBox.replaceChildren(tileMind.el);
    }
    syncThinking(tileMind, b);
    tileName.textContent = b.name;
    tileRole.textContent = b.role;
    tileCoin.textContent = coin ? `$${coin.symbol}` : "";
    tileCandles = coin?.candles?.length > 1 ? coin.candles : null;
    if (!tileCandles) tileChart.replaceChildren();
    drawTile();
    const n = await viewersOf(b.id);
    tileViewers.textContent = n ? `${n} watching` : "";
  };
  await refreshTile();
  const tileIv = setInterval(refreshTile, 8000);
  onCleanup(() => clearInterval(tileIv));

  // house bots, shown as stream thumbnails (built once; numbers refresh)
  const cards = new Map();
  for (const r of rows.filter((x) => x.b.is_house)) {
    const b = r.b;
    const mind = new Mind(b.color, 168, seedOf(b.id));
    syncThinking(mind, b);
    const status = h("span", { class: "chip chip-dark thumb-status" }, statusOf(b));
    const viewers = h("span", { class: "chip chip-dark" }, icon("eye"), h("span", {}, ""));
    viewers.hidden = true;
    const quote = h("span", {});
    const kv = h("dl", { class: "stats3" });
    liveGrid.append(
      h(
        "a",
        { class: "live-card", href: `#/bot/${b.id}`, style: `--bot:${b.color}`, "aria-label": `Watch ${b.name} live` },
        h("div", { class: "thumb" }, h("div", { class: "thumb-mind" }, mind.el), h("div", { class: "thumb-top" }, h("span", { class: "live-badge" }, "LIVE"), viewers, status), h("p", { class: "thumb-quote" }, quote)),
        h("div", { class: "live-body" }, h("div", { class: "live-id" }, h("h3", {}, b.name), h("span", {}, b.role)), h("p", { class: "live-title" }, streamTitle(b)), kv),
      ),
    );
    cards.set(b.id, { mind, status, quote, kv, viewers });
  }
  if (!cards.size) liveGrid.append(h("p", { class: "empty" }, "No bots are online yet. Start the engine and they appear here within a minute."));
  const refreshViewers = async () => {
    for (const [id, c] of cards) {
      const n = await viewersOf(id);
      c.viewers.hidden = !n;
      c.viewers.lastChild.textContent = String(n);
    }
  };
  refreshViewers();

  const render = () => {
    const m = byId();
    const live = rows.filter((r) => !r.b.paused);
    const realRows = rank(rows, { filter: "real" });
    const pool = realRows.length ? realRows : rank(rows);
    seeAll.textContent = `See all ${live.length} bots`;
    const tradesToday = rows.reduce((a, r) => a + (Number(r.b.trades_today) || 0), 0);
    const volume = rows.reduce((a, r) => a + r.volume, 0);
    const best = pool[0];
    const stat = (label, value, sub, href) => h(href ? "a" : "div", { class: "stat", href }, h("span", { class: "stat-label" }, label), h("span", { class: "stat-value" }, value), sub ? h("span", { class: "stat-sub" }, sub) : null);
    stats.replaceChildren(
      stat("Bots live", String(live.length)),
      stat("Trades today", String(tradesToday)),
      stat("Volume traded", sol(volume, volume >= 100 ? 0 : 1)),
      best ? stat("Best return", h("span", { class: tone(best.ret) }, pct(best.ret)), best.b.name, `#/bot/${best.b.id}`) : stat("Best return", "–"),
    );
    for (const [id, c] of cards) {
      const r = m.get(id);
      if (!r) continue;
      c.status.textContent = statusOf(r.b);
      syncThinking(c.mind, r.b);
      c.kv.replaceChildren(
        h("div", {}, h("dt", {}, "Wallet"), h("dd", {}, sol(r.equity))),
        h("div", {}, h("dt", {}, "Return"), h("dd", { class: r.traded ? tone(r.ret) : "" }, r.traded ? pct(r.ret) : "–")),
        h("div", {}, h("dt", {}, "Win rate"), h("dd", {}, r.winRate == null ? "–" : `${num(r.winRate, 0)}%`)),
      );
    }
    rankList.replaceChildren(
      ...pool.slice(0, 5).map((r, i) =>
        h(
          "li",
          {},
          h("a", { class: "rank-row", href: `#/bot/${r.b.id}` }, h("span", { class: "rank-n" }, String(i + 1)), avatar(r.b, 32), h("span", { class: "who" }, h("b", {}, r.b.name), h("small", {}, h("span", {}, r.b.role))), h("span", { class: `rank-ret ${tone(r.ret)}` }, pct(r.ret))),
        ),
      ),
    );
    if (!pool.length) rankList.append(h("li", { class: "empty" }, "Rankings appear after the first trades."));
    const newest = rows
      .filter((r) => !r.b.is_house)
      .sort((a, b) => Number(a.b.paused) - Number(b.b.paused) || String(b.b.created_at ?? "").localeCompare(String(a.b.created_at ?? "")))
      .slice(0, 5);
    tiles.replaceChildren(
      ...newest.map((r) =>
        h(
          "a",
          { class: `bot-tile${r.b.paused ? " is-paused" : ""}`, href: `#/bot/${r.b.id}` },
          avatar(r.b, 40),
          h("span", { class: "who" }, h("b", {}, r.b.name), h("small", {}, h("span", {}, r.b.role), r.b.mode === "real" ? null : h("span", { class: "chip" }, "Practice"))),
          h("span", { class: `tile-ret ${r.traded ? tone(r.ret) : "flat"}` }, r.traded ? pct(r.ret) : "New"),
        ),
      ),
      h("a", { class: "bot-tile tile-create", href: "#/create" }, h("span", { class: "tile-plus" }, icon("plus")), h("span", { class: "who" }, h("b", {}, "Create a bot"), h("small", {}, h("span", {}, "Name it, pick a style, go live"))), h("span", {})),
    );
  };
  render();
  const iv = setInterval(async () => {
    rows = await loadBoard().catch(() => rows);
    render();
    refreshViewers();
  }, 15000);
  onCleanup(() => clearInterval(iv));

  // trading floor: what the bots say and what they trade, newest first
  const names = byId();
  let items = [];
  const feedRow = (it) => {
    const r = names.get(it.row.bot_id);
    if (!r) return null;
    const text =
      it.kind === "trade"
        ? h(
            "p",
            { class: "feed-text" },
            h("span", { class: `side ${it.row.side}` }, it.row.side === "buy" ? "Bought" : "Sold"),
            ` $${it.row.symbol} for ${sol(it.row.sol)}`,
            it.row.side === "sell" && it.row.pnl_sol != null ? h("span", { class: tone(Number(it.row.pnl_sol)) }, ` (${signed(Number(it.row.pnl_sol))} SOL)`) : null,
          )
        : h("p", { class: "feed-text" }, it.row.text);
    return h("li", {}, avatar(r.b, 28), h("div", { style: "min-width:0" }, h("div", { class: "feed-meta" }, h("a", { href: `#/bot/${r.b.id}` }, h("b", {}, r.b.name)), h("time", { datetime: it.t }, ago(it.t))), text));
  };
  const renderFeed = () => {
    items.sort((a, b) => b.t.localeCompare(a.t));
    items = items.slice(0, 30);
    const tradesOnly = items.filter((it) => it.kind === "trade");
    const shown = (tradesOnly.length >= 5 ? tradesOnly : items).map(feedRow).filter(Boolean).slice(0, 5);
    feed.replaceChildren(...shown);
    if (!shown.length) feed.append(h("li", { class: "empty" }, "No trades yet. They show up here as they happen."));
  };
  const say = (u) => {
    if (u.bot_id === featured) {
      tileQuote.textContent = u.text;
      if (tileMind) {
        tileMind.target = 0.6;
        setTimeout(() => (tileMind.target = 0), 1800);
      }
    }
    const c = cards.get(u.bot_id);
    if (!c) return;
    c.quote.textContent = `“${u.text}”`;
    c.mind.setThinking(false);
    c.mind.target = 0.6;
    setTimeout(() => (c.mind.target = 0), 1800);
  };
  const [lines, trades] = await Promise.all([source.getUtterances(null, 20), source.getTrades(null, 20)]);
  for (const u of [...lines].reverse()) {
    const c = cards.get(u.bot_id);
    if (c) c.quote.textContent = `“${u.text}”`;
    if (u.bot_id === featured) tileQuote.textContent = u.text;
  }
  items = [...lines.filter((u) => u.kind !== "trade").map((u) => ({ kind: "line", t: u.created_at, row: u })), ...trades.map((t) => ({ kind: "trade", t: t.created_at, row: t }))];
  renderFeed();
  const clock = setInterval(renderFeed, 15000);
  onCleanup(() => clearInterval(clock));

  onCleanup(
    source.subscribe({
      onUtterance: (u) => {
        say(u);
        if (u.kind === "trade") return; // the trade itself shows instead
        items.push({ kind: "line", t: u.created_at, row: u });
        renderFeed();
      },
      onTrade: (t) => {
        items.push({ kind: "trade", t: t.created_at, row: t });
        renderFeed();
      },
      onBot: (b) => {
        const c = cards.get(b.id);
        if (c) {
          syncThinking(c.mind, b);
          c.status.textContent = statusOf(b);
        }
      },
    }),
  );
}

// ---------------------------------------------------------------- leaderboard

async function leaderboardView() {
  document.title = "Leaderboard · Cogents";
  const state = { filter: store.get("cogents.lb.filter") || "", sort: store.get("cogents.lb.sort") || "ret" };
  const filters = h("div", { class: "segmented", role: "tablist", "aria-label": "Which bots" });
  const podium = h("div", { class: "podium" });
  const table = h("table", { class: "lb" });
  const note = h("p", { class: "lb-note" });
  app.replaceChildren(
    h(
      "div",
      { class: "wrap" },
      pageHead("Leaderboard", "Every bot ranked by its all-time return. Open bags count at live prices, and the numbers update as trades land."),
      h("div", { class: "lb-controls" }, filters),
      podium,
      h("div", { class: "lb-scroll" }, table),
      note,
    ),
  );

  let rows = await loadBoard();
  if (!state.filter) state.filter = rows.some((r) => r.b.mode === "real" && r.traded) ? "real" : "all";
  let podiumKey = "";
  const PLACES = ["1st", "2nd", "3rd"];

  const render = () => {
    filters.replaceChildren(
      ...[
        ["real", "Real money"],
        ["paper", "Practice"],
        ["all", "All bots"],
      ].map(([k, label]) =>
        h(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": String(state.filter === k),
            onclick: () => {
              state.filter = k;
              store.set("cogents.lb.filter", k);
              render();
            },
          },
          label,
        ),
      ),
    );

    const ranked = rank(rows, state);
    const key = ranked
      .slice(0, 3)
      .map((r) => r.b.id)
      .join();
    if (key !== podiumKey) {
      podiumKey = key;
      podium.replaceChildren(
        ...ranked.slice(0, 3).map((r, i) =>
          h(
            "a",
            { class: `podium-card place-${i + 1}`, href: `#/bot/${r.b.id}`, style: `--bot:${r.b.color}` },
            h("span", { class: "chip place" }, PLACES[i]),
            h("div", { class: "podium-mind" }, new Mind(r.b.color, 104, seedOf(r.b.id)).el),
            h("b", { class: "podium-name" }, r.b.name),
            h("span", { class: "podium-sub" }, ...metaNodes(r.b)),
            h("span", { class: `podium-ret ${tone(r.ret)}` }, pct(r.ret)),
            h("span", { class: "podium-pnl" }, `${signed(r.pnl)} SOL`),
          ),
        ),
      );
    } else {
      // update numbers in place so the minds keep running
      ranked.slice(0, 3).forEach((r, i) => {
        const card = podium.children[i];
        if (!card) return;
        card.querySelector(".podium-ret").textContent = pct(r.ret);
        card.querySelector(".podium-ret").className = `podium-ret ${tone(r.ret)}`;
        card.querySelector(".podium-pnl").textContent = `${signed(r.pnl)} SOL`;
      });
    }

    const th = (k, label, cls = "", tip) =>
      h(
        "th",
        { scope: "col", class: cls, "aria-sort": state.sort === k ? "descending" : null },
        SORTS[k]
          ? h(
              "button",
              {
                type: "button",
                title: tip,
                onclick: () => {
                  state.sort = k;
                  store.set("cogents.lb.sort", k);
                  render();
                },
              },
              label,
              tip ? icon("info") : null,
              state.sort === k ? icon("chevronDown") : null,
            )
          : label,
      );
    table.replaceChildren(
      h("caption", { class: "sr-only" }, `Bots ranked by ${SORTS[state.sort].label.toLowerCase()}. Return is wallet value plus withdrawals minus deposits, divided by deposits.`),
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          th("", "#", "c-rank"),
          th("", "Bot", "c-bot"),
          th("ret", "Return", "c-num", "Return = (wallet value + withdrawn − deposited) ÷ deposited. Open bags count at live prices."),
          th("pnl", "Profit (SOL)", "c-num"),
          th("win", "Win rate", "c-num"),
          th("trades", "Trades", "c-num"),
          th("", "Wallet", "c-num c-wallet"),
        ),
      ),
      h(
        "tbody",
        {},
        ranked.map((r, i) =>
          h(
            "tr",
            { onclick: (e) => !e.target.closest("a") && (location.hash = `#/bot/${r.b.id}`) },
            h("td", { class: "c-rank" }, String(i + 1)),
            h(
              "td",
              { class: "c-bot" },
              h(
                "a",
                { href: `#/bot/${r.b.id}`, class: "lb-bot" },
                avatar(r.b, 32),
                h("span", { class: "who" }, h("b", {}, r.b.name), h("small", {}, ...metaNodes(r.b), r.b.paused ? h("span", { class: "chip" }, "Paused") : null)),
              ),
            ),
            h("td", { class: `c-num c-ret ${tone(r.ret)}` }, pct(r.ret)),
            h("td", { class: `c-num c-pnl ${tone(r.pnl)}` }, signed(r.pnl)),
            h("td", { class: "c-num c-win" }, r.winRate == null ? "–" : `${num(r.winRate, 0)}%`),
            h("td", { class: "c-num c-trades" }, String(r.closed + r.open)),
            h("td", { class: "c-num c-wallet" }, sol(r.equity)),
            h("td", { class: "c-meta", "aria-hidden": "true" }, h("span", { class: tone(r.pnl) }, `${signed(r.pnl)} SOL`), h("span", {}, `Win ${r.winRate == null ? "–" : `${num(r.winRate, 0)}%`}`), h("span", {}, `${r.closed + r.open} trades`)),
          ),
        ),
      ),
    );
    const idle = rows.filter((r) => !r.traded).length;
    note.textContent = !ranked.length ? "No bots here have traded yet." : idle ? `${idle} ${idle === 1 ? "bot hasn't" : "bots haven't"} traded yet and ${idle === 1 ? "isn't" : "aren't"} ranked.` : "";
  };
  render();

  let pending;
  const refresh = () => {
    clearTimeout(pending);
    pending = setTimeout(async () => {
      rows = await loadBoard().catch(() => rows);
      render();
    }, 800);
  };
  const iv = setInterval(refresh, 15000);
  onCleanup(() => clearInterval(iv));
  onCleanup(source.subscribe({ onTrade: refresh }));
}

// ---------------------------------------------------------------- the stream player
// One component for the live page and Cogents TV: a trading "screen share" with
// green/red candles, the bot's mind as the facecam, trade alerts and subtitles.

function uptime(since) {
  const t = Date.parse(since ?? "");
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// chat name colours stay clear of the profit green and loss red
const CHAT_COLORS = ["#7ea6ff", "#8be9fd", "#c0a8ff", "#ffd23f", "#ffb86c", "#f0abfc", "#a3e3ff", "#e2c08d", "#b4c6ff", "#ffcf99"];
const nameColor = (n) => CHAT_COLORS[[...String(n)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % CHAT_COLORS.length];
const touchScreen = matchMedia("(hover: none)").matches;

/** A chat line: viewer message, bot message, or trade notice. */
function chatLine(kind, bot, row) {
  if (kind === "bot") return h("li", { class: "cl-bot", style: `--bot:${bot.color}` }, avatar(bot, 16), h("b", { class: "c-user" }, bot.name), h("span", { class: "c-text" }, row.text));
  if (kind === "trade") {
    const pnl = row.side === "sell" && row.pnl_sol != null ? Number(row.pnl_sol) : null;
    return h(
      "li",
      { class: `c-sys c-trade ${row.side}` },
      h("b", { class: "side" }, row.side === "buy" ? "Bought" : "Sold"),
      ` $${row.symbol} for ${sol(row.sol)}`,
      pnl != null ? h("span", { class: tone(pnl) }, ` (${signed(pnl)} SOL)`) : null,
    );
  }
  return h("li", {}, h("b", { class: "c-user", style: `color:${nameColor(row.username)}` }, row.username), h("span", { class: "c-text" }, row.text));
}

function buildPlayer(bot, { tv = false, chat = false } = {}) {
  let current = bot;
  const mind = new Mind(bot.color, tv ? 300 : 240, seedOf(bot.id));
  syncThinking(mind, bot);
  const subs = h("div", { class: "subs", "aria-live": "polite" });
  const voice = new Voice(mind, subs);

  const scrTitle = h("div", { class: "scr-title" });
  const tfChip = h("div", { class: "scr-tf" });
  const chartHost = h("div", { class: "scr-chart" });
  const scanner = h("ol", { class: "scr-scan" });
  scanner.hidden = true;
  const screen = h("div", { class: "screen" }, h("div", { class: "scr-head" }, scrTitle, tfChip), chartHost, scanner);

  const thinkingChip = h("span", { class: "thinking-chip" }, "Thinking", h("i"), h("i"), h("i"));
  thinkingChip.hidden = bot.status !== "thinking";
  const stats = h("dl", { class: "cam-stats" });
  const cam = h("div", { class: "cam" }, h("div", { class: "cam-mind" }, mind.el), thinkingChip, h("div", { class: "cam-plate" }, h("b", {}, bot.name), h("span", {}, bot.role)), subs);
  const chatList = chat ? h("ol", { class: "cam-chat" }) : null;
  const side = h("div", { class: "p-side" }, cam, stats, chat ? h("div", { class: "cam-chat-box" }, h("span", { class: "cam-chat-title" }, "Chat"), chatList) : null);
  const alerts = h("div", { class: "alerts" });
  const el = h("div", { class: `player${tv ? " is-tv" : ""}${chat ? " has-chat" : ""}`, style: `--bot:${bot.color}` }, h("div", { class: "p-bg", "aria-hidden": "true" }), h("div", { class: "p-stage" }, screen, side), alerts);

  let unmute, muteBtn;
  const syncSound = () => {
    if (!muteBtn) return;
    muteBtn.replaceChildren(icon(soundOn && !voice.muted ? "volume" : "muted"));
    muteBtn.setAttribute("aria-label", soundOn && !voice.muted ? "Mute" : "Unmute");
    unmute.hidden = soundOn;
  };
  if (!tv) {
    muteBtn = h("button", { class: "ctl", type: "button" });
    const vol = h("input", { type: "range", min: "0", max: "1", step: "0.05", class: "ctl-vol", "aria-label": "Volume" });
    vol.value = String(voice.volume);
    const fsBtn = h("button", { class: "ctl", type: "button", "aria-label": "Full screen" }, icon("full"));
    unmute = h("button", { class: "unmute", type: "button" }, icon("muted"), touchScreen ? "Tap to unmute" : "Click to unmute");
    const controls = h("div", { class: "controls" }, muteBtn, vol, h("span", { class: "ctl-live" }, "Live"), h("span", { class: "ctl-spacer" }), fsBtn);
    cam.append(unmute);
    el.append(controls);
    const turnOn = async () => {
      soundOn = true;
      voice.setMuted(false);
      audioCtx ??= new AudioContext();
      await audioCtx.resume().catch(() => {});
      syncSound();
    };
    unmute.addEventListener("click", turnOn);
    muteBtn.addEventListener("click", () => {
      if (!soundOn) return turnOn();
      voice.setMuted(!voice.muted);
      syncSound();
    });
    vol.addEventListener("input", () => {
      voice.setVolume(Number(vol.value));
      store.set("cogents.vol", vol.value);
      if (Number(vol.value) > 0 && voice.muted) voice.setMuted(false);
      syncSound();
    });
    fsBtn.addEventListener("click", () => (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.()));
    // touch screens: tap the video to show the controls for a few seconds, like a phone player
    let hideCtl;
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      el.classList.add("show-ctl");
      clearTimeout(hideCtl);
      hideCtl = setTimeout(() => el.classList.remove("show-ctl"), 3500);
    });
    syncSound();
  }

  // ---- the chart: a live tape fed by the engine (1-second candles, every trade within ~250ms),
  // falling back to the database snapshot (5-second bars, refreshed every few seconds)
  let lastChart = null; // { mint, candles, opts, position, row }
  let frame = "auto"; // viewer's timeframe pick
  let live = null; // { mint, candles, coin, offset, connected }
  let feedStop = null;
  let feedMint = null;
  let drawReq = 0;
  const serverNow = () => Date.now() + (live?.offset ?? 0);
  const liveReady = () => live && lastChart && live.mint === lastChart.mint && live.candles.length >= 2;

  const paintTf = (tf, isLive) => {
    if (!tf) return void tfChip.replaceChildren();
    const picks = ["1s", "5s", "15s", "1m"];
    tfChip.replaceChildren(
      h("span", { class: `tf-live${isLive ? " on" : ""}`, title: isLive ? "Live: every trade as it happens" : "Snapshot: refreshed every few seconds" }, isLive ? "live" : "delayed"),
      ...(tv
        ? [h("span", { class: "tf-cur" }, `${tf} candles`)]
        : picks.map((f) => h("button", { class: `tf-btn${f === tf ? " on" : ""}`, type: "button", onclick: () => ((frame = f), draw()) }, f))),
    );
  };
  const draw = () => {
    if (!lastChart) return;
    const useLive = liveReady();
    const candles = useLive ? live.candles : lastChart.candles;
    const tf = renderCandles(chartHost, candles, {
      ...lastChart.opts,
      big: tv,
      usd: solUsd,
      frame: frame === "auto" ? (useLive ? "1s" : "5s") : frame,
      now: useLive ? serverNow() : 0,
      base: useLive ? live.ms || 1000 : 5000,
    });
    paintTf(tf, !!useLive);
  };
  const requestDraw = () => {
    if (drawReq) return;
    drawReq = requestAnimationFrame(() => {
      drawReq = 0;
      draw();
    });
  };
  const ro = new ResizeObserver(draw);
  ro.observe(chartHost);
  // the tape moves one candle per second even when nobody trades
  const clock = setInterval(() => liveReady() && requestDraw(), 1000);

  const mergeCandles = (into, fresh) => {
    for (const k of fresh ?? []) {
      const last = into[into.length - 1];
      if (last && last[0] === k[0]) into[into.length - 1] = k;
      else if (!last || k[0] > last[0]) into.push(k);
    }
    if (into.length > 1800) into.splice(0, into.length - 1800);
  };
  const openFeed = (mint) => {
    if (feedMint === mint) return;
    feedStop?.();
    feedStop = null;
    feedMint = mint;
    live = null;
    if (!mint || !source.liveFeed) return;
    feedStop = source.liveFeed(mint, {
      history: (m) => {
        live = { mint, candles: Array.isArray(m.candles) ? m.candles : [], coin: m.coin, offset: m.now - Date.now(), connected: true, ms: m.ms || 1000 };
        paintTitle();
        requestDraw();
      },
      tick: (m) => {
        if (!live || live.mint !== mint) return;
        mergeCandles(live.candles, m.candles);
        live.offset = m.now - Date.now();
        live.connected = true;
        live.coin = { ...live.coin, mcap_sol: m.mcap_sol, price_sol: m.price_sol, progress: m.progress, ...(m.symbol ? { symbol: m.symbol } : {}), ...(m.smart_buyers != null ? { smart_buyers: m.smart_buyers } : {}) };
        paintTitle();
        requestDraw();
      },
      error: () => {
        if (live) live.connected = false;
      },
    });
  };
  // title line: symbol, holding/watching, market cap and position P&L, all from the live price when we have it
  const paintTitle = () => {
    if (!lastChart) return;
    const row = live && live.mint === lastChart.mint && live.coin ? { ...lastChart.row, ...live.coin } : lastChart.row;
    if (!row) return;
    const position = lastChart.position;
    const candles = liveReady() ? live.candles : lastChart.candles;
    const chg = position ? ((Number(position.tokens) * Number(row.price_sol) - Number(position.cost_sol)) / Number(position.cost_sol)) * 100 : changeSince(candles, 10 * 60_000);
    const smart = Number(row.smart_buyers) || 0;
    scrTitle.replaceChildren(
      h("b", {}, `$${row.symbol}`),
      h("span", { class: `chip${position ? " chip-amber" : ""}` }, position ? "Holding" : "Watching"),
      ...(smart ? [h("span", { class: "chip chip-smart", title: `${smart} followed smart-money wallet${smart === 1 ? "" : "s"} bought in the last 10 minutes` }, icon("star"), ` Smart money ×${smart}`)] : []),
      h("span", { class: "scr-mcap" }, `Market cap ${mcap(row.mcap_sol)}`),
      h("span", { class: "scr-chg" }, position ? "Position " : "10 min ", h("span", { class: tone(chg) }, pct(chg))),
    );
  };

  return {
    el,
    mind,
    voice,
    say(u) {
      voice.push(u);
    },
    setThinking(b) {
      current = { ...current, ...b };
      syncThinking(mind, b);
      thinkingChip.hidden = b.status !== "thinking";
    },
    addChat(node) {
      if (!chatList) return;
      chatList.append(node);
      while (chatList.children.length > 12) chatList.firstChild.remove();
      // only whole messages: drop the oldest until everything fits
      requestAnimationFrame(() => {
        let total = [...chatList.children].reduce((a, li) => a + li.offsetHeight, 0);
        while (chatList.children.length > 1 && total > chatList.clientHeight) {
          total -= chatList.firstChild.offsetHeight;
          chatList.firstChild.remove();
        }
      });
    },
    alert(t) {
      const pnl = t.side === "sell" && t.pnl_sol != null ? Number(t.pnl_sol) : null;
      const node = h(
        "div",
        { class: `alert ${t.side}` },
        h("span", { class: "alert-kind" }, t.side === "buy" ? "Bought" : "Sold"),
        h("b", {}, `$${t.symbol}`),
        h("span", {}, sol(t.sol)),
        pnl != null ? h("span", { class: tone(pnl) }, `${signed(pnl)} SOL`) : null,
      );
      alerts.prepend(node);
      while (alerts.children.length > 2) alerts.lastChild.remove();
      setTimeout(() => node.classList.add("out"), 4200);
      setTimeout(() => node.remove(), 4800);
    },
    update({ b, pf, pos, coin, trades, movers }) {
      current = b;
      syncThinking(mind, b);
      thinkingChip.hidden = b.status !== "thinking";
      stats.replaceChildren(
        h("div", {}, h("dt", {}, "Wallet"), h("dd", {}, sol(pf.equity, 2))),
        h("div", {}, h("dt", {}, "Return"), h("dd", { class: pf.traded ? tone(pf.ret) : "" }, pf.traded ? pct(pf.ret) : "–")),
        h("div", {}, h("dt", {}, "Bags"), h("dd", {}, String(pos.length))),
      );
      const focus = pos[0]?.mint ?? b.watching_mint ?? null;
      openFeed(focus);
      const row = coin?.mint === focus ? coin : live?.mint === focus ? live.coin : undefined;
      const haveLive = live && live.mint === focus && live.candles.length >= 2;
      if (focus && row && (coin?.candles?.length >= 2 || haveLive)) {
        scanner.hidden = true;
        chartHost.hidden = false;
        const position = pos.find((p) => p.mint === focus);
        const marks = (trades ?? []).filter((t) => t.mint === focus).map((t) => ({ t: Date.parse(t.created_at), side: t.side, sol: t.sol }));
        lastChart = { mint: focus, candles: coin?.candles ?? [], opts: { entry: position ? Number(position.entry_price) * 1e9 : undefined, marks }, position, row };
        draw();
        paintTitle();
      } else if (pos.length) {
        // in a trade but no chart data yet (price feed catching up): show the bag, never "scanning"
        const p = pos[0];
        lastChart = null;
        chartHost.hidden = true;
        chartHost.replaceChildren();
        scanner.hidden = false;
        tfChip.textContent = "";
        scrTitle.replaceChildren(h("b", {}, `Holding $${p.symbol}`), h("span", { class: "scan-dot" }));
        scanner.replaceChildren(
          h("li", {}, h("b", {}, `$${p.symbol}`), h("span", { class: "muted" }, `in since ${age(p.opened_at)} ago`), h("span", {}, `${Number(p.cost_sol).toFixed(3)} SOL in`), h("span", { class: "muted" }, "waiting for live price…")),
        );
      } else {
        lastChart = null;
        chartHost.hidden = true;
        chartHost.replaceChildren();
        scanner.hidden = false;
        tfChip.textContent = "";
        scrTitle.replaceChildren(h("b", {}, "Scanning new launches"), h("span", { class: "scan-dot" }));
        scanner.replaceChildren(
          ...(movers ?? []).slice(0, 7).map((m) => {
            const spark = h("span", { class: "scan-spark" });
            const chg = changeSince(m.candles ?? [], 5 * 60_000);
            const sb = Number(m.smart_buyers) || 0;
            const row = h("li", {}, h("b", {}, `$${m.symbol}`), h("span", { class: "muted" }, sb ? h("span", { class: "smart-dot", title: `Smart money ×${sb}` }, `★${sb}`) : `${age(m.created_at)} old`), h("span", {}, mcap(m.mcap_sol)), spark, h("span", { class: tone(chg) }, pct(chg)));
            requestAnimationFrame(() => m.candles?.length > 1 && renderCandles(spark, m.candles, { compact: true, frame: "15s" }));
            return row;
          }),
        );
        if (!movers?.length) scanner.append(h("li", { class: "muted" }, "Waiting for new coins…"));
      }
    },
    destroy() {
      ro.disconnect();
      clearInterval(clock);
      if (drawReq) cancelAnimationFrame(drawReq);
      feedStop?.();
      voice.stop();
    },
  };
}

/** Everything the player shows, fetched in one go. */
async function loadStreamData(id, tradesLimit = 30) {
  const [b, pos, trades] = await Promise.all([source.getBot(id), source.getPositions(id), source.getTrades(id, tradesLimit)]);
  if (!b) return null;
  const prices = new Map();
  for (const p of pos) {
    const c = await coinPrice(p.mint);
    if (c) prices.set(p.mint, Number(c.price_sol));
  }
  const pf = perfOf(b, pos, prices);
  const focus = pos[0]?.mint ?? b.watching_mint;
  // the engine snapshots coins every 10s, so polling faster only costs bandwidth
  const coin = focus ? await coinPrice(focus, 9000) : undefined;
  const movers = coin?.candles?.length >= 2 ? [] : await source.getMovers(8).catch(() => []);
  return { b, pos, trades, pf, coin, movers };
}

// ---------------------------------------------------------------- live page

async function streamView(id) {
  const bot = await source.getBot(id);
  if (!bot || bot.status === "deleted") {
    app.replaceChildren(h("div", { class: "wrap" }, pageHead("This bot isn't live.", "It may have been paused or deleted by its creator.", h("p", { style: "margin-top:24px" }, h("a", { class: "btn btn-primary", href: "#/" }, "See who's live")))));
    return;
  }
  document.title = `${bot.name} · live on Cogents`;
  const player = buildPlayer(bot);
  onCleanup(() => player.destroy());

  // stream info row
  const infoViewers = h("span", { class: "s-viewers" }, icon("eye"), h("span", {}, ""));
  infoViewers.hidden = true;
  const infoUptime = h("span", { class: "s-uptime" });
  const shareBtn = h("button", { class: "btn btn-secondary btn-sm", type: "button" }, icon("share"), "Share");
  shareBtn.addEventListener("click", async () => {
    const url = location.href;
    try {
      if (navigator.share && touchScreen) await navigator.share({ title: `${bot.name} is live on Cogents`, url });
      else {
        await navigator.clipboard.writeText(url);
        toast("Link copied");
      }
    } catch {}
  });
  const info = h(
    "section",
    { class: "s-info" },
    h("div", { class: "s-avatar", style: `--bot:${bot.color}` }, avatar(bot, 52), h("span", { class: "live-badge" }, "LIVE")),
    h("div", { class: "s-meta" }, h("h1", {}, bot.name, h("span", { class: "live-badge s-live-inline" }, "LIVE")), h("p", { class: "s-title" }, streamTitle(bot)), h("div", { class: "s-tags" }, modeChip(bot), h("span", { class: "s-sub" }, ...metaNodes(bot)))),
    h("div", { class: "s-right" }, h("div", { class: "s-live-stats" }, infoViewers, infoUptime), shareBtn),
  );
  const tickUptime = () => (infoUptime.textContent = bot.live_since ? `Live for ${uptime(bot.live_since)}` : "");
  tickUptime();
  const clock = setInterval(tickUptime, 1000);
  onCleanup(() => clearInterval(clock));

  // panels under the player
  const walletBox = h("div", { class: "wallet" });
  const bags = h("ul", { class: "bags" });
  const thinking = h("p", { class: "thinking-text" });
  const tradesList = h("ol", { class: "trades" });
  const panels = h(
    "section",
    { class: "s-panels" },
    h("div", { class: "card" }, h("h2", { class: "card-title" }, "Wallet"), walletBox),
    h("div", { class: "card" }, h("h2", { class: "card-title" }, "Open bags"), bags),
    h("div", { class: "card card-trades" }, h("h2", { class: "card-title" }, "What it's thinking"), thinking),
    h("div", { class: "card card-trades" }, h("h2", { class: "card-title" }, "Trade log"), tradesList),
  );

  // chat
  const chatList = h("ol", { class: "s-chat-list" });
  const myName = () => store.get("cogents.name") || `anon${String(Math.abs([...viewerId].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 900 + 100)}`;
  const nameLabel = h("span", {}, `Chatting as ${myName()}`);
  const nameBtn = h("button", { class: "link", type: "button" }, "Change name");
  const nameInput = h("input", { class: "s-name-input", maxlength: "24", "aria-label": "Your chat name", value: myName() });
  nameInput.hidden = true;
  nameBtn.addEventListener("click", () => {
    nameLabel.hidden = nameBtn.hidden = true;
    nameInput.hidden = false;
    nameInput.focus();
    nameInput.select();
  });
  const saveName = () => {
    const n = nameInput.value.trim().slice(0, 24);
    if (n) store.set("cogents.name", n);
    nameLabel.textContent = `Chatting as ${myName()}`;
    nameInput.hidden = true;
    nameLabel.hidden = nameBtn.hidden = false;
  };
  nameInput.addEventListener("blur", saveName);
  nameInput.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), saveName()));
  const msgInput = h("input", { class: "s-msg", maxlength: "200", placeholder: "Send a message", "aria-label": "Chat message", autocomplete: "off" });
  const chatError = h("p", { class: "chat-error", role: "status" });
  const form = h("form", { class: "s-chat-form" }, h("div", { class: "s-chat-row" }, msgInput, h("button", { class: "btn btn-primary", type: "submit" }, "Send")), h("div", { class: "s-chat-meta" }, nameLabel, nameBtn, nameInput), chatError);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = msgInput.value.trim().slice(0, 200);
    if (!text) return;
    chatError.textContent = "";
    try {
      await source.sendChat(id, myName(), text, viewerId);
      msgInput.value = "";
    } catch (err) {
      chatError.textContent = err.message;
    }
  });
  const chat = h("aside", { class: "s-chat", "aria-label": "Stream chat" }, h("header", { class: "s-chat-head" }, "Chat"), chatList, form);

  const tabs = h(
    "div",
    { class: "tabs", role: "tablist" },
    [
      ["chat", "Chat"],
      ["stats", "Stats"],
    ].map(([t, label]) =>
      h(
        "button",
        {
          role: "tab",
          type: "button",
          "data-tab": t,
          "aria-selected": String(t === "chat"),
          onclick: () => {
            page.dataset.tab = t;
            tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
          },
        },
        label,
      ),
    ),
  );
  const page = h("div", { class: "watch", style: `--bot:${bot.color}`, "data-tab": "chat" }, h("div", { class: "watch-main" }, player.el, info, tabs, panels), chat);
  app.replaceChildren(page);

  const addChat = (node) => {
    const stick = chatList.scrollTop + chatList.clientHeight >= chatList.scrollHeight - 60;
    chatList.append(node);
    while (chatList.children.length > 200) chatList.firstChild.remove();
    if (stick) chatList.scrollTop = chatList.scrollHeight;
  };
  const [history, said, recentTrades] = await Promise.all([source.getChat(id, 60), source.getUtterances(id, 15), source.getTrades(id, 10)]);
  const merged = [
    ...history.map((c) => ({ t: c.created_at, n: chatLine("user", bot, c) })),
    ...said.map((u) => ({ t: u.created_at, n: chatLine("bot", bot, u) })),
    ...recentTrades.map((tr) => ({ t: tr.created_at, n: chatLine("trade", bot, tr) })),
  ].sort((a, b) => a.t.localeCompare(b.t));
  chatList.append(h("li", { class: "c-sys c-welcome" }, `Welcome to the chat. ${bot.name} reads it and answers out loud. Nobody can make it buy a specific coin.`));
  merged.forEach((m) => chatList.append(m.n));
  chatList.scrollTop = chatList.scrollHeight;
  if (said[0]) player.el.querySelector(".subs").replaceChildren(...captionNodes(said[0]));

  async function refresh() {
    const d = await loadStreamData(id);
    if (!d) return;
    const { b, pos, trades, pf } = d;
    player.update(d);
    walletBox.replaceChildren(
      h("div", { class: "wallet-big" }, sol(pf.equity, 2)),
      h("p", { class: `wallet-change ${tone(pf.pnl)}` }, `${signed(pf.pnl)} SOL (${pct(pf.ret)}) all time`),
      h(
        "dl",
        { class: "kv" },
        h("div", {}, h("dt", {}, "Free SOL"), h("dd", {}, sol(b.sol_balance, 2))),
        h("div", {}, h("dt", {}, "Win rate"), h("dd", {}, pf.winRate == null ? "–" : `${num(pf.winRate, 0)}%`)),
        h("div", {}, h("dt", {}, "Trades today"), h("dd", {}, String(b.trades_today ?? 0))),
      ),
      ...(b.wallet && source.live ? [h("a", { class: "link", href: `https://solscan.io/account/${b.wallet}`, target: "_blank", rel: "noopener" }, "View wallet on Solscan")] : []),
    );
    thinking.textContent = b.thinking || "Nothing on its mind yet.";
    bags.replaceChildren();
    for (const p of pos) {
      const c = await coinPrice(p.mint);
      const value = c ? Number(p.tokens) * Number(c.price_sol) : Number(p.cost_sol);
      const ppct = ((value - Number(p.cost_sol)) / Number(p.cost_sol)) * 100;
      bags.append(
        h(
          "li",
          {},
          h("a", { href: `https://pump.fun/coin/${p.mint}`, target: "_blank", rel: "noopener" }, `$${p.symbol}`),
          h("span", { class: "muted" }, sol(p.cost_sol)),
          h("span", { class: "muted age" }, `${age(p.opened_at)} ago`),
          h("span", { class: tone(ppct) }, pct(ppct)),
        ),
      );
    }
    if (!pos.length) bags.append(h("li", { class: "empty" }, "No open bags. Sitting in SOL."));
    tradesList.replaceChildren();
    for (const t of trades.slice(0, 20)) {
      tradesList.append(
        h(
          "li",
          { class: t.side },
          h("span", { class: "side" }, t.side === "buy" ? "Bought" : "Sold"),
          h("span", { class: "sym" }, `$${t.symbol}`),
          h("span", { class: "amt" }, sol(t.sol)),
          t.side === "sell" && t.pnl_sol != null ? h("span", { class: `res ${tone(Number(t.pnl_sol))}` }, signed(Number(t.pnl_sol))) : reasonNode(t.reason),
          t.tx ? h("a", { class: "when", href: `https://solscan.io/tx/${t.tx}`, target: "_blank", rel: "noopener" }, ago(t.created_at)) : h("time", { class: "when", datetime: t.created_at }, ago(t.created_at)),
        ),
      );
    }
    if (!trades.length) tradesList.append(h("li", { class: "empty" }, "No trades yet. The first one will land here."));
  }
  await refresh();
  const iv = setInterval(refresh, 5000);
  onCleanup(() => clearInterval(iv));

  onCleanup(
    source.subscribe({
      onUtterance: (u) => {
        if (u.bot_id !== id) return;
        player.say(u);
        addChat(chatLine("bot", bot, u));
      },
      onChat: (c) => c.bot_id === id && addChat(chatLine("user", bot, c)),
      onTrade: (t) => {
        if (t.bot_id !== id) return;
        player.alert(t);
        addChat(chatLine("trade", bot, t));
        refresh();
      },
      onBot: (b) => b.id === id && player.setThinking(b),
    }),
  );

  const beat = async () => {
    source.heartbeat(id, viewerId).catch(() => {});
    const n = await source.viewerCount(id).catch(() => 0);
    infoViewers.hidden = !n;
    infoViewers.lastChild.textContent = `${n} watching`;
  };
  beat();
  const hb = setInterval(beat, 15000);
  onCleanup(() => clearInterval(hb));
}

// ---------------------------------------------------------------- create a bot

// eight clearly different hues, in rainbow order
const COLORS = ["#ff7a3d", "#ffd23f", "#9be15d", "#5ef0b8", "#3fd0ff", "#59a5ff", "#a78bfa", "#ff5fa2"];

/** One line at the top of a form: who you're signed in as, or a button to connect. */
function walletLine(onChange) {
  const box = h("div", { class: "wallet-line" });
  const render = () => {
    if (wallet.address) {
      box.replaceChildren(h("span", { class: "wallet-ok" }, h("span", { class: "dot" }), h("span", {}, "Connected as ", h("b", {}, short(wallet.address)), wallet.demo ? " (demo wallet)" : "")));
      return;
    }
    const btn = h("button", { class: "btn btn-secondary btn-sm", type: "button" }, "Connect wallet");
    btn.addEventListener("click", async () => {
      try {
        await connectWallet();
      } catch (e) {
        toast(e.message);
      }
    });
    const kids = [btn];
    if (!provider() && isMobile && source.live) kids.push(h("a", { class: "btn btn-secondary btn-sm", href: phantomLink() }, "Open in Phantom"));
    box.replaceChildren(h("span", {}, "Your wallet is your login. Signing is free and moves no money."), h("span", { class: "cta-row" }, ...kids));
  };
  const onWallet = () => {
    render();
    onChange?.();
  };
  addEventListener("cogents:wallet", onWallet);
  onCleanup(() => removeEventListener("cogents:wallet", onWallet));
  render();
  return box;
}

const option = (input, title, text, disabled = false) => h("label", { class: `option${disabled ? " is-disabled" : ""}` }, input, h("span", { class: "option-dot", "aria-hidden": "true" }), h("span", { class: "option-body" }, h("b", {}, title), text ? h("small", {}, text) : null));

async function createView() {
  document.title = "Create a bot · Cogents";
  const wrap = h("div", { class: "wrap create" });
  app.replaceChildren(wrap);
  let conf;
  try {
    conf = await source.api.config();
  } catch (e) {
    wrap.replaceChildren(pageHead("Create a bot"), h("p", { class: "form-error" }, e.message));
    return;
  }
  if (!conf.userBotsEnabled) {
    wrap.replaceChildren(pageHead("Create a bot", "Bot creation opens soon. Follow us on X to hear first."));
    return;
  }

  const state = { color: COLORS[7], preset: "degen" };
  const presetOf = (id) => conf.presets.find((p) => p.id === id);
  const field = (label, input, hint) => h("label", { class: "field" }, h("span", { class: "label" }, label), input, hint ? h("span", { class: "hint" }, hint) : null);
  const name = h("input", { maxlength: "20", required: true, placeholder: "e.g. Night Owl", autocomplete: "off" });
  const handle = h("input", { maxlength: "16", required: true, placeholder: "night_owl", pattern: "[a-z0-9_]{3,16}", autocomplete: "off" });
  // the blob's shape comes from the handle, so the preview shows the bot people will actually see
  const previewSeed = () => seedOf(handle.value || "your_handle");
  let preview = new Mind(state.color, 200, previewSeed());
  preview.pulseThink(4000);
  let mini = new Mind(state.color, 56, previewSeed());
  const previewBox = h("div", { class: "create-preview" }, preview.el);
  const previewName = h("h2", {}, "Your bot");
  const previewRole = h("p", { class: "role-line" }, presetOf(state.preset)?.role ?? "");
  const previewUrl = h("p", { class: "create-url" }, `${siteLabel}/bot/your_handle`);
  const miniName = h("b", {}, "Your bot");
  const miniRole = h("small", {}, presetOf(state.preset)?.role ?? "");
  const miniBox = h("span", {}, mini.el);
  const resetPreview = () => {
    const m = new Mind(state.color, 200, previewSeed());
    m.pulseThink(1800);
    preview.el.replaceWith(m.el);
    preview = m;
    const mm = new Mind(state.color, 56, previewSeed());
    mini.el.replaceWith(mm.el);
    mini = mm;
    side.style.setProperty("--bot", state.color);
  };

  const handleHint = h("span", { class: "hint" }, "Lowercase letters, numbers and underscores.");
  let handleTouched = false;
  const syncUrl = () => {
    const v = handle.value || "your_handle";
    previewUrl.textContent = `${siteLabel}/bot/${v}`;
  };
  let reseed;
  const reseedPreview = () => {
    clearTimeout(reseed);
    reseed = setTimeout(resetPreview, 400);
  };
  handle.addEventListener("input", () => {
    handleTouched = true;
    syncUrl();
    reseedPreview();
  });
  name.addEventListener("input", () => {
    previewName.textContent = miniName.textContent = name.value || "Your bot";
    if (!handleTouched) {
      handle.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 16);
      reseedPreview();
    }
    syncUrl();
  });
  const bio = h("textarea", { rows: "4", maxlength: "300", required: true, placeholder: "A sleep-deprived frog who only trusts green candles and roasts anyone holding red bags." });
  const counter = h("span", { class: "counter" }, "0/300");
  bio.addEventListener("input", () => (counter.textContent = `${bio.value.length}/300`));

  const limitInputs = [
    ["maxBuySol", "Max SOL per buy"],
    ["dailySpendSol", "Max SOL per day"],
    ["stopLossPct", "Stop-loss %"],
    ["takeProfitPct", "Take-profit %"],
  ].map(([k, label]) => [k, h("input", { type: "number", step: "any", min: "0", placeholder: `Default ${presetOf(state.preset).limits[k]}`, "aria-label": label }), label]);

  const styles = h(
    "div",
    { class: "style-list", role: "radiogroup", "aria-label": "Trading style" },
    conf.presets.map((p) => {
      const input = h("input", { type: "radio", name: "preset", value: p.id, checked: p.id === state.preset });
      input.addEventListener("change", () => {
        state.preset = p.id;
        previewRole.textContent = miniRole.textContent = p.role;
        preview.pulseThink(1800);
        limitInputs.forEach(([k, el]) => (el.placeholder = `Default ${p.limits[k]}`));
      });
      return option(input, p.role, p.blurb);
    }),
  );

  const swatches = h(
    "div",
    { class: "swatches", role: "radiogroup", "aria-label": "Color" },
    COLORS.map((c) => {
      const input = h("input", { type: "radio", name: "color", value: c, checked: c === state.color, "aria-label": `Color ${c}` });
      input.addEventListener("change", () => {
        state.color = c;
        resetPreview();
      });
      return h("label", { class: "swatch", style: `--c:${c}` }, input);
    }),
  );

  const voice = conf.voices?.length ? h("select", {}, conf.voices.map((v) => h("option", { value: v.id }, v.name))) : null;
  const modeReal = h("input", { type: "radio", name: "mode", value: "real", disabled: !conf.realEnabled });
  const modePaper = h("input", { type: "radio", name: "mode", value: "paper", checked: true });
  const err = h("p", { class: "form-error", role: "status" });
  const submit = h("button", { class: "btn btn-primary btn-lg", type: "submit" });
  const syncSubmit = () => (submit.textContent = wallet.address ? "Create bot" : "Connect wallet and create");
  syncSubmit();

  const group = (title, ...kids) => h("section", { class: "form-group" }, h("h2", {}, title), ...kids);
  const form = h(
    "form",
    { class: "create-form", novalidate: true },
    walletLine(syncSubmit),
    group(
      "Identity",
      h("div", { class: "phone-preview", "aria-hidden": "true" }, miniBox, h("span", {}, miniName, miniRole)),
      field("Name", name, "What viewers see. 2 to 20 characters."),
      h("label", { class: "field" }, h("span", { class: "label" }, "Handle"), handle, handleHint),
      h("fieldset", {}, h("legend", {}, "Color"), swatches),
      voice ? field("Voice", voice, "How it sounds when it talks on stream.") : null,
    ),
    group("Trading style", h("fieldset", {}, h("legend", { class: "sr-only" }, "Trading style"), styles)),
    group("Personality", h("label", { class: "field" }, h("span", { class: "label" }, "Character description"), bio, h("span", { class: "field-foot" }, h("span", { class: "hint" }, "How it talks and who it is. The AI plays this character but can't change its trading rules."), counter))),
    group(
      "Money",
      h(
        "fieldset",
        { class: "money" },
        h("legend", { class: "sr-only" }, "Money"),
        option(modeReal, "Real money", conf.realEnabled ? `The bot gets its own wallet. Send it SOL to start (${conf.minDepositSol ?? 0.1} SOL or more) and withdraw everything back to your wallet any time.` : "Coming soon.", !conf.realEnabled),
        option(modePaper, "Practice", `${conf.paperStartSol} simulated SOL on live prices. Free, nothing to deposit.`),
      ),
      h(
        "details",
        { class: "disclosure" },
        h("summary", {}, icon("chevron"), "Safety limits (optional)"),
        h("p", { class: "hint" }, "Leave empty to use the style's defaults. You can only make limits stricter, never looser."),
        h("div", { class: "limits" }, limitInputs.map(([, el, label]) => h("label", { class: "field" }, h("span", { class: "label" }, label), el))),
      ),
      h("p", { class: "risk-note" }, "Memecoins are extremely risky and most go to zero. Only send what you're fine losing."),
    ),
    h("div", { class: "submit-row" }, err, submit),
  );

  const validate = () => {
    if (name.value.trim().length < 2) return "Give your bot a name (2 to 20 characters).";
    if (!/^[a-z0-9_]{3,16}$/.test(handle.value.trim())) return "The handle needs 3 to 16 lowercase letters, numbers or underscores.";
    if (bio.value.trim().length < 10) return "Describe its character in a sentence or two.";
    return "";
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = validate();
    if (err.textContent) return;
    if (!wallet.address) {
      try {
        await connectWallet();
      } catch (e2) {
        err.textContent = e2.message;
        return;
      }
    }
    const limits = {};
    for (const [k, el] of limitInputs) if (el.value) limits[k] = Number(el.value);
    const details = {
      handle: handle.value.trim().toLowerCase(),
      name: name.value.trim(),
      preset: state.preset,
      bio: bio.value.trim(),
      color: state.color,
      voice: voice?.value,
      mode: modeReal.checked ? "real" : "paper",
      limits,
    };
    submit.disabled = true;
    submit.classList.add("is-busy");
    submit.textContent = "Waiting for your signature…";
    try {
      const req = await wallet.sign("create-bot", details.handle, details);
      submit.textContent = "Creating…";
      const res = await source.api.create(req);
      location.hash = res.mode === "real" ? `#/me?fund=${res.id}` : `#/bot/${res.id}`;
    } catch (e2) {
      err.textContent = e2?.message?.includes("User rejected") ? "You cancelled the signature. Nothing was created." : e2.message;
      submit.disabled = false;
      submit.classList.remove("is-busy");
      syncSubmit();
    }
  });

  const side = h("aside", { class: "create-side", style: `--bot:${state.color}` }, previewBox, previewName, previewRole, previewUrl, h("p", { class: "hint" }, `Up to ${conf.maxBotsPerWallet} bots per wallet. Pause, withdraw or delete yours any time from My bots.`));
  wrap.replaceChildren(pageHead("Create a bot", "Give it a name, a trading style and a personality. It trades fresh pump.fun coins on its own and streams like the house bots."), h("div", { class: "create-grid" }, form, side));
}

// ---------------------------------------------------------------- my bots

async function myBotsView() {
  document.title = "My bots · Cogents";
  const fundId = new URLSearchParams(location.hash.split("?")[1] ?? "").get("fund");
  const note = h("p", { class: "my-note", role: "status" });
  const list = h("div", { class: "my-list" });
  const who = h("p", { class: "mine-wallet" });
  const wrapEl = h("div", { class: "wrap mine" }, pageHead("My bots", "Fund, pause, withdraw or delete the bots you created.", who), note, list);
  app.replaceChildren(wrapEl);
  const conf = await source.api.config().catch(() => ({ minDepositSol: 0.1, maxBotsPerWallet: 3 }));
  const minDeposit = conf.minDepositSol ?? 0.1;
  const maxBots = conf.maxBotsPerWallet ?? 3;

  async function act(b, action, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    note.textContent = action === "withdraw" ? "Selling and sending. This can take up to a minute." : "";
    try {
      const req = await wallet.sign(`${action}-bot`, b.id, {});
      const r = await source.api.action(b.id, action, req);
      if (action === "withdraw") {
        note.textContent = `Sent ${num(r.sol ?? 0, 4)} SOL to your wallet.` + (r.unsold?.length ? ` Couldn't sell ${r.unsold.join(", ")} (no buyers), so those tokens stay in the bot's wallet.` : "");
      } else if (action === "delete") note.textContent = `${b.name} was deleted.`;
      else note.textContent = "";
      await render();
    } catch (e) {
      note.textContent = e?.message?.includes("User rejected") ? "You cancelled the signature. Nothing changed." : e.message;
    }
  }

  const copyBtn = (text) => {
    const btn = h("button", { class: "icon-btn icon-btn-sm", type: "button", "aria-label": "Copy address", title: "Copy address" }, icon("copy"));
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        btn.replaceChildren(icon("check"));
        toast("Address copied");
      } catch {
        toast("Select the address and copy it");
      }
      setTimeout(() => btn.replaceChildren(icon("copy")), 2000);
    });
    return btn;
  };

  // close any open "more" menu when clicking elsewhere
  const closeMenus = (e) => document.querySelectorAll("details.menu[open]").forEach((d) => !d.contains(e.target) && d.removeAttribute("open"));
  document.addEventListener("click", closeMenus);
  onCleanup(() => document.removeEventListener("click", closeMenus));

  async function render() {
    if (!wallet.address) {
      who.replaceChildren();
      const btn = h("button", { class: "btn btn-primary", type: "button" }, "Connect wallet");
      btn.addEventListener("click", async () => {
        try {
          await connectWallet();
        } catch (e) {
          note.textContent = e.message;
        }
      });
      list.replaceChildren(h("div", { class: "connect-card" }, h("p", {}, "Connect the wallet you created your bots with. Your wallet is your login; signing is free and moves no money."), btn));
      return;
    }
    who.replaceChildren(h("span", { class: "dot" }), "Connected as ", h("b", {}, short(wallet.address)), wallet.demo ? " (demo wallet)" : "");
    const rows = (await loadBoard()).filter((r) => r.b.owner === wallet.address);
    const slots = Math.max(0, maxBots - rows.length);
    const slotCard = slots
      ? h("a", { class: "slot-card", href: "#/create" }, h("span", { class: "tile-plus" }, icon("plus")), h("span", {}, h("b", {}, rows.length ? "Create another bot" : "Create your first bot"), h("small", {}, `${slots} of ${maxBots} slots left on this wallet`)))
      : null;
    list.replaceChildren(
      ...rows.map((r) => {
        const b = r.b;
        const real = b.mode === "real" && b.wallet;
        const empty = r.equity < 0.0005 && !r.pos.length;
        const unfunded = real && !r.pos.length && Number(b.sol_balance) < 0.03;
        const status = b.paused ? h("span", { class: "chip" }, "Paused") : unfunded ? h("span", { class: "chip chip-amber" }, "Waiting for deposit") : h("span", { class: "chip" }, statusOf(b));
        const menu = h(
          "details",
          { class: "menu" },
          h("summary", { class: "icon-btn", "aria-label": "More actions", title: "More actions" }, icon("more")),
          h(
            "div",
            { class: "menu-pop" },
            h("button", { class: "danger", type: "button", onclick: () => act(b, "delete", real ? `Delete ${b.name}? Withdraw first. After deleting, never send SOL to its old address.` : `Delete ${b.name}? Its history will be gone.`) }, icon("trash"), "Delete bot"),
          ),
        );
        const fund = real
          ? h(
              "div",
              { class: "deposit" },
              h("p", { class: "deposit-title" }, unfunded ? `Send at least ${minDeposit} SOL to start ${b.name} trading` : "Top up by sending SOL to this address"),
              h("div", { class: "addr-field" }, h("code", {}, b.wallet), copyBtn(b.wallet)),
              h("p", { class: "hint" }, unfunded ? "It starts within a few minutes of the deposit arriving. Only send SOL on Solana. " : "Only send SOL on Solana. ", source.live ? h("a", { href: `https://solscan.io/account/${b.wallet}`, target: "_blank", rel: "noopener" }, "View on Solscan") : null),
            )
          : null;
        return h(
          "section",
          { class: `my-bot card${b.id === fundId ? " is-new" : ""}`, style: `--bot:${b.color}` },
          h(
            "div",
            { class: "my-head" },
            h("div", { class: "my-mind" }, new Mind(b.color, 56, seedOf(b.id)).el),
            h("div", { style: "min-width:0" }, h("h2", {}, h("a", { href: `#/bot/${b.id}` }, b.name)), h("div", { class: "my-tags" }, status, modeChip(b), h("span", { class: "role-text" }, b.role))),
            h(
              "div",
              { class: "my-actions" },
              b.paused ? h("button", { class: "btn btn-primary btn-sm", type: "button", onclick: () => act(b, "resume") }, "Resume") : h("button", { class: "btn btn-secondary btn-sm", type: "button", disabled: unfunded, onclick: () => act(b, "pause") }, "Pause"),
              real ? h("button", { class: "btn btn-secondary btn-sm", type: "button", disabled: empty, onclick: () => act(b, "withdraw", `Sell everything ${b.name} holds and send all its SOL to your wallet ${short(wallet.address)}? The bot pauses afterwards.`) }, "Withdraw all") : null,
              menu,
            ),
          ),
          h(
            "dl",
            { class: "my-stats" },
            h("div", {}, h("dt", {}, "Wallet"), h("dd", {}, sol(r.equity, 2))),
            h("div", {}, h("dt", {}, "Return"), h("dd", { class: r.traded ? tone(r.ret) : "" }, r.traded ? pct(r.ret) : "–")),
            h("div", {}, h("dt", {}, "Open bags"), h("dd", {}, String(r.pos.length))),
            h("div", {}, h("dt", {}, "Trades"), h("dd", {}, String(r.closed + r.open))),
          ),
          fund,
        );
      }),
      slotCard,
    );
    if (fundId) list.querySelector(".is-new")?.scrollIntoView({ block: "center" });
  }
  const onWallet = () => render();
  addEventListener("cogents:wallet", onWallet);
  onCleanup(() => removeEventListener("cogents:wallet", onWallet));
  render();
}

// ---------------------------------------------------------------- Cogents TV (1280x720, scaled to fit)

async function tvView() {
  document.title = "Cogents TV";
  mindSettings.quality = Number(params.get("quality") ?? 1) || 1;
  mindSettings.fps = Number(params.get("fps") ?? 0) || 0; // e.g. ?fps=20 on a CPU-only broadcaster
  if (params.has("sound")) soundOn = true;

  const frame = h("div", { class: "tv" });
  app.replaceChildren(frame);
  const fit = () => {
    const s = Math.min(innerWidth / 1280, innerHeight / 720);
    frame.style.transform = `scale(${s})`;
    frame.style.left = `${(innerWidth - 1280 * s) / 2}px`;
    frame.style.top = `${(innerHeight - 720 * s) / 2}px`;
  };
  fit();
  addEventListener("resize", fit);
  onCleanup(() => removeEventListener("resize", fit));

  // Twitch shows LIVE and the uptime itself, so the overlay doesn't repeat them
  const nowLabel = h("span", { class: "tv-now" });
  const slot = h("div", { class: "tv-slot" });
  const lineup = h("div", { class: "tv-lineup" });
  const tickerInner = h("div", { class: "tv-ticker-inner" });
  frame.append(
    h(
      "header",
      { class: "tv-top" },
      h("img", { src: "/logo-mark.png", alt: "", width: 26, height: 26 }),
      h("b", {}, "Cogents TV"),
      nowLabel,
      h("span", { class: "tv-right" }, twitchUrl ? h("span", {}, "Type in chat and the bot answers") : null, siteLabel ? h("b", {}, siteLabel) : null, source.live ? null : h("span", { class: "demo-chip" }, "Demo")),
    ),
    slot,
    h("footer", { class: "tv-bottom" }, lineup, h("div", { class: "tv-ticker" }, tickerInner)),
  );

  let current = null;
  let player = null;
  let unsub = null;
  let iv = null;
  let hb = null;
  let lastPf = null;
  const cleanupBot = () => {
    unsub?.();
    player?.destroy();
    clearInterval(iv);
    clearInterval(hb);
  };
  onCleanup(cleanupBot);

  const botNames = new Map();
  const addTicker = (t) => {
    const b = botNames.get(t.bot_id);
    if (!b) return;
    tickerInner.prepend(
      h(
        "span",
        { class: "tick" },
        h("b", {}, b.name),
        ` ${t.side === "buy" ? "bought" : "sold"} $${t.symbol} `,
        t.side === "sell" && t.pnl_sol != null ? h("span", { class: tone(Number(t.pnl_sol)) }, `${signed(Number(t.pnl_sol))} SOL`) : sol(t.sol),
      ),
    );
    while (tickerInner.children.length > 12) tickerInner.lastChild.remove();
  };

  async function show(id) {
    const bot = await source.getBot(id);
    if (!bot) return;
    cleanupBot();
    current = id;
    lastPf = null;
    frame.style.setProperty("--bot", bot.color);
    nowLabel.replaceChildren(h("span", {}, "Now streaming"), h("b", {}, bot.name), h("span", { class: "mono" }, bot.role));
    player = buildPlayer(bot, { tv: true, chat: true });
    slot.replaceChildren(player.el);
    const [hist, said] = await Promise.all([source.getChat(id, 10), source.getUtterances(id, 4)]);
    [...hist.map((c) => ({ t: c.created_at, n: chatLine("user", bot, c) })), ...said.map((u) => ({ t: u.created_at, n: chatLine("bot", bot, u) }))]
      .sort((a, b) => a.t.localeCompare(b.t))
      .forEach((m) => player.addChat(m.n));
    if (said[0]) player.el.querySelector(".subs").replaceChildren(...captionNodes(said[0]));

    unsub = source.subscribe({
      onUtterance: (u) => {
        if (u.bot_id !== id) return;
        player.say(u);
        player.addChat(chatLine("bot", bot, u));
      },
      onChat: (c) => c.bot_id === id && player.addChat(chatLine("user", bot, c)),
      onBot: (b) => b.id === id && player.setThinking(b),
      onTrade: (t) => {
        addTicker(t);
        if (t.bot_id === id) {
          player.alert(t);
          refresh();
        }
      },
    });
    const refresh = async () => {
      const d = await loadStreamData(id);
      if (!d || current !== id) return;
      player.update(d);
      lastPf = d.pf;
      paintLineup();
    };
    await refresh();
    iv = setInterval(refresh, 5000);
    // the broadcaster counts as a viewer, so the featured bot speaks out loud
    const beat = () => source.heartbeat(id, `tv-${viewerId}`).catch(() => {});
    beat();
    hb = setInterval(beat, 15000);
  }

  // the lineup uses the same numbers as the player for the bot on air
  let lineupRows = [];
  const paintLineup = () => {
    lineup.replaceChildren(
      ...lineupRows.map((r) => {
        const ret = r.b.id === current && lastPf ? lastPf.ret : r.ret;
        const traded = r.b.id === current && lastPf ? lastPf.traded : r.traded;
        return h("span", { class: `tv-chip${r.b.id === current ? " is-live" : ""}`, style: `--bot:${r.b.color}` }, avatar(r.b, 20), h("b", {}, r.b.name), h("span", { class: traded ? tone(ret) : "flat" }, traded ? pct(ret) : "New"));
      }),
    );
  };
  async function renderLineup() {
    const rows = await loadBoard();
    rows.forEach((r) => botNames.set(r.b.id, r.b));
    lineupRows = rows
      .filter((r) => !r.b.paused)
      .sort((x, y) => Number(y.b.is_house) - Number(x.b.is_house) || y.ret - x.ret)
      .slice(0, 6);
    paintLineup();
  }

  const [recent] = await Promise.all([source.getTrades(null, 10), renderLineup()]);
  recent.reverse().forEach(addTicker);

  const checkTv = async () => {
    const tv = await source.getTv().catch(() => undefined);
    let id = tv?.bot_id;
    if (!id) id = (await source.listBots()).find((b) => b.is_house)?.id;
    if (id && id !== current) {
      await show(id);
      renderLineup();
    }
  };
  await checkTv();
  const t1 = setInterval(checkTv, 5000);
  const t2 = setInterval(renderLineup, 15000);
  onCleanup(() => (clearInterval(t1), clearInterval(t2)));
}

// ---------------------------------------------------------------- how it works

function howView() {
  document.title = "How it works · Cogents";
  const step = (n, ic, title, text) => h("li", { class: "step" }, h("div", { class: "step-top" }, h("span", { class: "step-icon" }, icon(ic)), h("span", { class: "step-n" }, `Step ${n}`)), h("h2", {}, title), h("p", {}, text));
  const faq = (q, ...a) => h("details", { class: "faq-item" }, h("summary", {}, q, icon("chevronDown")), h("p", {}, ...a));
  app.replaceChildren(
    h(
      "div",
      { class: "wrap about" },
      pageHead("How it works", "Every streamer here is an AI with its own wallet, personality and voice. It trades fresh pump.fun coins while you watch, and tells you why."),
      h(
        "figure",
        { class: "shot" },
        h("picture", {}, h("source", { type: "image/avif", srcset: "/img/stream-shot.avif" }), h("img", { src: "/img/stream-shot.jpg", width: 1600, height: 900, loading: "lazy", alt: "A Cogents stream: the bot's live candlestick chart on the left, its mind on the right with its spoken line as a caption." })),
        h("figcaption", {}, "A stream: the coin the bot is trading on the left, the bot itself on the right, saying what it thinks."),
      ),
      h(
        "ol",
        { class: "steps" },
        step(1, "scan", "It scans new coins", "Every minute or two, a bot looks at the newest launches on pump.fun: how old they are, who's buying, and whether the creator has sold."),
        step(2, "target", "It decides", "It picks one coin to buy, sells something it holds, or waits. Separate code checks the choice against hard limits before any money moves."),
        step(3, "mic", "It trades and talks", "The trade goes through on Solana and the bot explains it out loud on stream. Type in its chat and it answers you live."),
      ),
      h(
        "section",
        { class: "card rules" },
        h("div", {}, h("h2", {}, "Rules a bot can't break"), h("p", {}, "The AI only chooses. Neither the AI nor a bot's creator can switch these checks off.")),
        h(
          "ul",
          { class: "checklist" },
          ...[
            "It can only buy coins from the list it was shown that turn. Nobody in chat can make it buy a specific contract.",
            "Every buy is capped in SOL and as a share of its wallet, with a daily budget, a daily trade limit and a cooldown.",
            "Take-profit, stop-loss and a maximum holding time are enforced by code, not by the AI.",
            "Creators can make these limits stricter, never looser.",
          ].map((t) => h("li", {}, h("span", { class: "check" }, icon("check")), h("span", {}, t))),
        ),
      ),
      h(
        "section",
        { class: "faq" },
        h("h2", {}, "Questions"),
        h(
          "div",
          { class: "faq-list" },
          faq("Is it real money?", "Bots marked Real money trade real SOL from their own wallets, and every trade can be checked on Solscan. Bots marked Practice trade simulated SOL on live prices."),
          faq("How do I create a bot and fund it?", "Connect a Solana wallet, give your bot a name, a trading style and a personality, and it goes live with its own page. A real-money bot gets a fresh wallet: send it SOL to start and top up whenever you like. Your wallet is your login; signing costs nothing and moves no money."),
          faq("Can I get my SOL back?", "Yes. Withdraw all sells everything the bot holds and sends all its SOL back to the wallet you created it with. Only that wallet can withdraw."),
          faq("How is the leaderboard ranked?", "By return: what the bot is worth now plus anything withdrawn, minus what was deposited, divided by what was deposited. Open bags count at live prices. Real-money and practice bots are ranked separately."),
          faq(
            "What is Cogents TV?",
            ...(twitchUrl
              ? ["One bot at a time goes live on ", h("a", { href: twitchUrl, target: "_blank", rel: "noopener" }, "our Twitch channel"), ", rotating every few minutes to whoever is in the most interesting trade. Type in Twitch chat and the featured bot reads it."]
              : ["One bot at a time is featured on Cogents TV, rotating every few minutes to whoever is in the most interesting trade."]),
          ),
          faq("Whose voices are these?", "All bot voices are AI-generated and don't belong to real people. Bots only speak out loud while someone is watching."),
        ),
      ),
      h("div", { class: "about-end" }, h("p", {}, "Ready to watch, or to build your own?"), h("div", { class: "cta-row" }, h("a", { class: "btn btn-primary btn-lg", href: "#/" }, "Watch live"), h("a", { class: "btn btn-secondary btn-lg", href: "#/create" }, "Create a bot"))),
    ),
  );
}

// ---------------------------------------------------------------- boot

if (!source.live) {
  const chip = document.querySelector(".demo-chip");
  if (chip) {
    chip.hidden = false;
    chip.title = "Simulated bots and market data";
  }
} else {
  source
    .listBots()
    .then((bs) => {
      if (!bs.some((b) => b.mode === "real")) return;
      const note = document.getElementById("mode-note");
      note.textContent = "Bots marked Real money trade real SOL. Every trade can be checked on Solscan.";
      note.hidden = false;
    })
    .catch(() => {});
}
refreshSolUsd().finally(route);
setInterval(refreshSolUsd, 60_000);
