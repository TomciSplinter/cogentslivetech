// The rules a bot cannot break. Every AI decision passes through here
// before any money moves. Selling is always allowed, buying is tightly capped.
import type { Limits } from "./bots.ts";
import type { Market } from "./market.ts";
import { config } from "./config.ts";
import { dayStart, round } from "./util.ts";

export interface Position {
  mint: string;
  symbol: string;
  tokens: number;
  costSol: number; // SOL spent incl. fees
  entryPrice: number; // SOL per token at entry
  openedAt: number;
}

export interface BotState {
  solBalance: number;
  positions: Map<string, Position>;
  day: number; // UTC day start these counters belong to
  spentToday: number;
  tradesToday: number;
  lastBuyAt: number;
}

export function newState(solBalance: number): BotState {
  return { solBalance, positions: new Map(), day: 0, spentToday: 0, tradesToday: 0, lastBuyAt: 0 };
}

export function rollDay(s: BotState, now: number) {
  const d = dayStart(now);
  if (s.day !== d) {
    s.day = d;
    s.spentToday = 0;
    s.tradesToday = 0;
  }
}

export function positionPnlPct(p: Position, price: number | undefined): number {
  if (!price || p.costSol <= 0) return 0;
  return ((p.tokens * price - p.costSol) / p.costSol) * 100;
}

export interface ForcedExit {
  mint: string;
  reason: "take-profit" | "stop-loss" | "max-hold";
}

/** Exits enforced by code BEFORE the AI is asked anything. */
export function forcedExits(s: BotState, limits: Limits, market: Market, now: number): ForcedExit[] {
  const out: ForcedExit[] = [];
  for (const p of s.positions.values()) {
    const pnl = positionPnlPct(p, market.priceOf(p.mint));
    if (pnl >= limits.takeProfitPct) out.push({ mint: p.mint, reason: "take-profit" });
    else if (pnl <= -limits.stopLossPct) out.push({ mint: p.mint, reason: "stop-loss" });
    else if (now - p.openedAt >= limits.maxHoldMin * 60_000) out.push({ mint: p.mint, reason: "max-hold" });
  }
  return out;
}

export type BuyCheck = { ok: true; sol: number } | { ok: false; reason: string };

/**
 * Validate and size a buy. The AI's requested amount is only a wish:
 * it is shrunk to fit every cap, and refused if anything is off.
 */
export function checkBuy(
  s: BotState,
  limits: Limits,
  mint: string | undefined,
  requestedSol: number | undefined,
  menuMints: Set<string>,
  now: number,
): BuyCheck {
  rollDay(s, now);
  if (config.pauseBuys) return { ok: false, reason: "buys are paused by admin" };
  if (!mint || !menuMints.has(mint)) return { ok: false, reason: "coin was not on this turn's menu" };
  if (s.positions.has(mint)) return { ok: false, reason: "already holding this coin" };
  if (s.positions.size >= limits.maxPositions) return { ok: false, reason: "max positions reached" };
  if (s.tradesToday >= limits.dailyTrades) return { ok: false, reason: "daily trade limit reached" };
  const cooldownLeft = limits.buyCooldownSec * 1000 - (now - s.lastBuyAt);
  if (cooldownLeft > 0) return { ok: false, reason: `cooldown, ${Math.ceil(cooldownLeft / 1000)}s left` };

  const wish = Number.isFinite(requestedSol) && requestedSol! > 0 ? requestedSol! : limits.maxBuySol / 2;
  const sol = Math.min(
    wish,
    limits.maxBuySol,
    (s.solBalance * limits.maxBuyPct) / 100,
    s.solBalance - limits.reserveSol,
    limits.dailySpendSol - s.spentToday,
  );
  if (!(sol >= limits.minBuySol)) return { ok: false, reason: "not enough SOL left within limits" };
  return { ok: true, sol: round(sol, 4) };
}

export function checkSell(s: BotState, mint: string | undefined): { ok: boolean; reason?: string } {
  if (!mint || !s.positions.has(mint)) return { ok: false, reason: "not holding this coin" };
  return { ok: true };
}

export function recordBuy(s: BotState, p: Position, solSpent: number, now: number) {
  rollDay(s, now);
  s.positions.set(p.mint, p);
  s.solBalance = round(s.solBalance - solSpent, 9);
  s.spentToday += solSpent;
  s.tradesToday += 1;
  s.lastBuyAt = now;
}

export function recordSell(s: BotState, mint: string, solReceived: number, now: number) {
  rollDay(s, now);
  s.positions.delete(mint);
  s.solBalance = round(s.solBalance + solReceived, 9);
  s.tradesToday += 1;
}
