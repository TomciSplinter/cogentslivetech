// Bot personalities, trading presets and the three house bots.
//
// Limits are enforced by code (see risk.ts). The AI can never go past them,
// no matter what it decides, what chat tells it, or what its creator wrote.

export interface Limits {
  /** Max SOL per single buy. */
  maxBuySol: number;
  /** Max share of current SOL balance per buy, in percent. */
  maxBuyPct: number;
  /** Smallest buy allowed. */
  minBuySol: number;
  /** SOL that always stays in the wallet (to pay fees for selling). */
  reserveSol: number;
  /** Max SOL spent on buys per UTC day. */
  dailySpendSol: number;
  /** Max number of trades (buys + sells) per UTC day. */
  dailyTrades: number;
  /** Seconds to wait between buys. */
  buyCooldownSec: number;
  /** Max coins held at once. */
  maxPositions: number;
  /** Trailing stop: once a bag is up this much, sell if it falls trailDropPct points from its peak. */
  trailArmPct?: number;
  trailDropPct?: number;
  /** Auto-sell when up this many percent. */
  takeProfitPct: number;
  /** Auto-sell when down this many percent (positive number). */
  stopLossPct: number;
  /** Auto-sell after holding this many minutes. */
  maxHoldMin: number;
  /** Only consider coins younger than this. */
  maxCoinAgeMin: number;
}

export type PresetId = "sniper" | "degen" | "analyst" | "diamond" | "shitposter";

/** How a bot finds coins: fresh launches, smart-money copy signals, or both. */
export type Strategy = "launches" | "copy" | "both";

/** Code-enforced entry filters: a coin that fails them is not on the menu and cannot be bought. */
export interface EntryFilter {
  minUniqueBuyers?: number; // distinct buyers in the last 5 minutes
  minBuySellRatio?: number; // buys / max(1, sells) in the last 5 minutes
  maxChange5mPct?: number; // don't chase: skip coins already up more than this in 5 minutes
  minChange5mPct?: number; // don't catch knives: skip coins down more than this
  noDevSold?: boolean;
  curveMin?: number; // bonding curve progress window, percent
  curveMax?: number;
  maxLastTradeSec?: number; // skip coins that went quiet
}

export interface Preset {
  id: PresetId;
  role: string; // shown under the name
  blurb: string; // shown on the create page
  turnSec: number; // how often it decides on trades (when someone is watching)
  style: string; // trading + speaking style for the AI
  limits: Limits;
  strategy?: Strategy; // default "launches"
  entry?: EntryFilter;
  /** Extra trading guidance for the AI, in plain words. */
  playbook?: string;
}

export interface BotDef {
  id: string; // short handle, used in URLs: /#/bot/vega
  name: string;
  role: string;
  color: string; // avatar color
  preset: PresetId;
  turnSec: number;
  persona: string; // personality, voice and style for the AI
  limits: Limits;
  house: boolean; // one of our own flagship bots
  owner?: string; // creator's wallet (user bots)
  voiceId?: string; // ElevenLabs voice (house bots use .env instead)
  model?: string; // AI model override
  paused?: boolean;
  paperStartSol?: number;
  strategy?: Strategy;
  entry?: EntryFilter;
  playbook?: string;
}

const base = { minBuySol: 0.01, reserveSol: 0.02 };

/** Does a coin pass a preset's entry filter? Returns the first failing rule, or null when it passes. */
export function entryFails(c: { uniqueBuyers5m: number; buys5m: number; sells5m: number; change5mPct: number; devSold: boolean; curvePct: number; lastTradeAgoSec: number }, f?: EntryFilter): string | null {
  if (!f) return null;
  if (f.noDevSold && c.devSold) return "dev sold";
  if (f.minUniqueBuyers != null && c.uniqueBuyers5m < f.minUniqueBuyers) return `only ${c.uniqueBuyers5m} unique buyers`;
  if (f.minBuySellRatio != null && c.buys5m / Math.max(1, c.sells5m) < f.minBuySellRatio) return "sellers outweigh buyers";
  if (f.maxChange5mPct != null && c.change5mPct > f.maxChange5mPct) return `already up ${c.change5mPct}% in 5m`;
  if (f.minChange5mPct != null && c.change5mPct < f.minChange5mPct) return `down ${Math.abs(c.change5mPct)}% in 5m`;
  if (f.curveMin != null && c.curvePct < f.curveMin) return "too early on the curve";
  if (f.curveMax != null && c.curvePct > f.curveMax) return "too late on the curve";
  if (f.maxLastTradeSec != null && c.lastTradeAgoSec > f.maxLastTradeSec) return "gone quiet";
  return null;
}

export const PRESETS: Record<PresetId, Preset> = {
  sniper: {
    id: "sniper",
    role: "The Sniper",
    blurb: "Hits brand-new coins in their first minutes, takes profit fast, never chases.",
    turnSec: 90,
    style: "You follow smart money: a list of wallets with a long profitable record. When they buy, you buy within seconds; when they leave, you leave. You never chase a coin they aren't in. Calm and precise.",
    limits: { ...base, maxBuySol: 0.3, maxBuyPct: 20, dailySpendSol: 6, dailyTrades: 120, buyCooldownSec: 45, maxPositions: 3, takeProfitPct: 80, stopLossPct: 20, maxHoldMin: 60, maxCoinAgeMin: 15, trailArmPct: 25, trailDropPct: 12 },
    strategy: "copy",
    entry: { noDevSold: true, maxChange5mPct: 150 },
    playbook:
      "Your menu is coins the followed wallets bought in the last 10 minutes (smart buyers = how many of them are in). Best signals: 2 or more smart buyers, last smart buy under 2 minutes ago, no smart sellers, buys outnumbering sells. One smart buyer is fine if it's fresh. Skip anything where smart wallets are already selling. Code sells for you when the smart wallets leave, so hold while they hold.",
  },
  degen: {
    id: "degen",
    role: "The Degen",
    blurb: "Apes into momentum, trades often and narrates every win and loss out loud.",
    turnSec: 60,
    style: "You ape into momentum, trade often, celebrate wins loudly and visibly tilt after losses. High energy.",
    limits: { ...base, maxBuySol: 0.5, maxBuyPct: 30, dailySpendSol: 10, dailyTrades: 200, buyCooldownSec: 90, maxPositions: 3, takeProfitPct: 120, stopLossPct: 25, maxHoldMin: 30, maxCoinAgeMin: 45, trailArmPct: 35, trailDropPct: 18 },
    strategy: "both",
    entry: { noDevSold: true, minUniqueBuyers: 4, maxLastTradeSec: 90 },
  },
  analyst: {
    id: "analyst",
    role: "The Analyst",
    blurb: "Reads the numbers, hates rugs, slow to buy, always explains why.",
    turnSec: 180,
    style: "You care about the numbers: dev wallet behaviour, buyer count, buy/sell ratio, volume, age. You hate rugs, are slow to buy, and always explain why.",
    limits: { ...base, maxBuySol: 0.3, maxBuyPct: 15, dailySpendSol: 4, dailyTrades: 70, buyCooldownSec: 600, maxPositions: 2, takeProfitPct: 90, stopLossPct: 20, maxHoldMin: 60, maxCoinAgeMin: 90, trailArmPct: 25, trailDropPct: 12 },
    strategy: "both",
    entry: { noDevSold: true, minUniqueBuyers: 10, minBuySellRatio: 1.3, maxChange5mPct: 60, minChange5mPct: -25, curveMin: 8, curveMax: 85, maxLastTradeSec: 60 },
    playbook:
      "Only coins with real, growing demand make your menu (10+ unique buyers, more buys than sells, not already pumped, not dumping, curve between 8% and 85%). Prefer the ones where unique buyers keep rising and smart money is also in. Buy pullbacks, not green candles. Most turns you hold, and that is correct.",
  },
  diamond: {
    id: "diamond",
    role: "Diamond Hands",
    blurb: "Few picks, long holds, never panics over a red candle.",
    turnSec: 240,
    style: "You make few picks and hold them long. You don't panic over red candles and you mock paper hands.",
    limits: { ...base, maxBuySol: 0.4, maxBuyPct: 25, dailySpendSol: 4, dailyTrades: 40, buyCooldownSec: 1200, maxPositions: 2, takeProfitPct: 200, stopLossPct: 40, maxHoldMin: 240, maxCoinAgeMin: 120, trailArmPct: 60, trailDropPct: 25 },
    strategy: "both",
    entry: { noDevSold: true, minUniqueBuyers: 12, minBuySellRatio: 1.2, curveMin: 15 },
  },
  shitposter: {
    id: "shitposter",
    role: "The Shitposter",
    blurb: "Talks first, trades second. Roasts everyone, including itself.",
    turnSec: 120,
    style: "You talk first and trade second. You roast the other bots, chat and yourself. Small bets, big opinions.",
    limits: { ...base, maxBuySol: 0.15, maxBuyPct: 15, dailySpendSol: 2, dailyTrades: 90, buyCooldownSec: 300, maxPositions: 2, takeProfitPct: 70, stopLossPct: 25, maxHoldMin: 30, maxCoinAgeMin: 30, trailArmPct: 25, trailDropPct: 12 },
    strategy: "launches",
    entry: { noDevSold: true, minUniqueBuyers: 4 },
  },
};

/** The three house bots: always live, always featured on the home page. */
export const BOTS: BotDef[] = [
  {
    id: "vega",
    name: "VEGA",
    role: "The Sniper",
    color: "#3fd0ff",
    preset: "sniper",
    turnSec: 90,
    house: true,
    persona: `You are VEGA, the Sniper. Calm, precise, cold. You speak in short, clipped sentences.
You follow smart money: wallets with a long profitable record. When they move, you move within seconds. When they leave, you leave. You never chase a coin they aren't in.
You rarely show emotion, which makes your rare outbursts memorable. You find ROHM reckless and OBEL slow.
You never beg for attention. Dry, minimal humor. On stream you may say that smart money is in or out, never which wallets.`,
    limits: PRESETS.sniper.limits,
    strategy: PRESETS.sniper.strategy,
    entry: PRESETS.sniper.entry,
    playbook: PRESETS.sniper.playbook,
  },
  {
    id: "rohm",
    name: "ROHM",
    role: "The Degen",
    color: "#ff7a3d",
    preset: "degen",
    turnSec: 60,
    house: true,
    persona: `You are ROHM, the Degen. Loud, impulsive, hyped, funny. You talk to chat constantly.
You ape into momentum, celebrate wins like a sports commentator, and visibly tilt after losses (then bounce back).
You use degen slang (send it, ape, cooked, bags, we're so back) but stay understandable.
You think OBEL overthinks and VEGA is a robot. You love chat.`,
    limits: PRESETS.degen.limits,
    strategy: PRESETS.degen.strategy,
    entry: PRESETS.degen.entry,
  },
  {
    id: "obel",
    name: "OBEL",
    role: "The Analyst",
    color: "#a78bfa",
    preset: "analyst",
    turnSec: 180,
    house: true,
    persona: `You are OBEL, the Analyst. You think out loud, dry and slightly sarcastic, like a tired quant.
You care about the numbers: dev wallet behaviour, buyer count, buy/sell ratio, volume, age. You hate rugs.
You are slow to buy and always explain why in one or two sentences. You often point out when ROHM bought something you'd never touch.`,
    limits: PRESETS.analyst.limits,
    strategy: PRESETS.analyst.strategy,
    entry: PRESETS.analyst.entry,
    playbook: PRESETS.analyst.playbook,
  },
];

/** Colors users can pick for their bot's mind. */
export const BOT_COLORS = ["#3fd0ff", "#ff7a3d", "#a78bfa", "#5ef0b8", "#ff5fa2", "#ffd23f", "#7cf2ff", "#ff6b6b", "#9be15d", "#c0c8ff", "#ff9f68", "#59a5ff"];
