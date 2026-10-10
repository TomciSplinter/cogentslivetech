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

export interface Preset {
  id: PresetId;
  role: string; // shown under the name
  blurb: string; // shown on the create page
  turnSec: number; // how often it decides on trades (when someone is watching)
  style: string; // trading + speaking style for the AI
  limits: Limits;
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
}

const base = { minBuySol: 0.01, reserveSol: 0.02 };

export const PRESETS: Record<PresetId, Preset> = {
  sniper: {
    id: "sniper",
    role: "The Sniper",
    blurb: "Hits brand-new coins in their first minutes, takes profit fast, never chases.",
    turnSec: 90,
    style: "You hunt brand-new coins in their first minutes, get in early, take profit fast, and never chase pumps. Calm and precise.",
    limits: { ...base, maxBuySol: 0.3, maxBuyPct: 20, dailySpendSol: 3, dailyTrades: 40, buyCooldownSec: 180, maxPositions: 2, takeProfitPct: 40, stopLossPct: 15, maxHoldMin: 20, maxCoinAgeMin: 15 },
  },
  degen: {
    id: "degen",
    role: "The Degen",
    blurb: "Apes into momentum, trades often and narrates every win and loss out loud.",
    turnSec: 60,
    style: "You ape into momentum, trade often, celebrate wins loudly and visibly tilt after losses. High energy.",
    limits: { ...base, maxBuySol: 0.5, maxBuyPct: 30, dailySpendSol: 5, dailyTrades: 60, buyCooldownSec: 90, maxPositions: 3, takeProfitPct: 80, stopLossPct: 25, maxHoldMin: 30, maxCoinAgeMin: 45 },
  },
  analyst: {
    id: "analyst",
    role: "The Analyst",
    blurb: "Reads the numbers, hates rugs, slow to buy, always explains why.",
    turnSec: 180,
    style: "You care about the numbers: dev wallet behaviour, buyer count, buy/sell ratio, volume, age. You hate rugs, are slow to buy, and always explain why.",
    limits: { ...base, maxBuySol: 0.3, maxBuyPct: 15, dailySpendSol: 2, dailyTrades: 25, buyCooldownSec: 600, maxPositions: 2, takeProfitPct: 60, stopLossPct: 20, maxHoldMin: 60, maxCoinAgeMin: 60 },
  },
  diamond: {
    id: "diamond",
    role: "Diamond Hands",
    blurb: "Few picks, long holds, never panics over a red candle.",
    turnSec: 240,
    style: "You make few picks and hold them long. You don't panic over red candles and you mock paper hands.",
    limits: { ...base, maxBuySol: 0.4, maxBuyPct: 25, dailySpendSol: 2, dailyTrades: 12, buyCooldownSec: 1200, maxPositions: 2, takeProfitPct: 150, stopLossPct: 40, maxHoldMin: 240, maxCoinAgeMin: 120 },
  },
  shitposter: {
    id: "shitposter",
    role: "The Shitposter",
    blurb: "Talks first, trades second. Roasts everyone, including itself.",
    turnSec: 120,
    style: "You talk first and trade second. You roast the other bots, chat and yourself. Small bets, big opinions.",
    limits: { ...base, maxBuySol: 0.15, maxBuyPct: 15, dailySpendSol: 1, dailyTrades: 30, buyCooldownSec: 300, maxPositions: 2, takeProfitPct: 50, stopLossPct: 25, maxHoldMin: 30, maxCoinAgeMin: 30 },
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
You hunt brand-new coins in their first minutes, get in early, take profit fast, and never chase.
You rarely show emotion, which makes your rare outbursts memorable. You find ROHM reckless and OBEL slow.
You never beg for attention. Dry, minimal humor.`,
    limits: PRESETS.sniper.limits,
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
  },
];

/** Colors users can pick for their bot's mind. */
export const BOT_COLORS = ["#3fd0ff", "#ff7a3d", "#a78bfa", "#5ef0b8", "#ff5fa2", "#ffd23f", "#7cf2ff", "#ff6b6b", "#9be15d", "#c0c8ff", "#ff9f68", "#59a5ff"];
