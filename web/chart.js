// Candlestick chart (green/red candles, volume, price line, entry line, buy/sell bubbles).
// Input candles: [bucketStartMs, open, high, low, close, volumeSol] at any fixed resolution
// (1-second from the live feed, 5-second from the database snapshot); prices are market cap in
// SOL (shown in USD when a SOL price is given). Rendered as crisp SVG at the host's exact size.

export const UP = "#3ddc97";
export const DOWN = "#ff5c7a";
const AMBER = "#7fdcff";
export const FRAMES = [
  ["1s", 1_000],
  ["5s", 5_000],
  ["15s", 15_000],
  ["30s", 30_000],
  ["1m", 60_000],
  ["5m", 300_000],
];

/**
 * The data's own resolution when the source didn't say: candles that all sit on 5-second (or
 * coarser) boundaries came from the database snapshot; anything else is the 1-second live feed.
 */
export function nativeMs(candles) {
  const sample = candles.slice(0, 300);
  if (!sample.length) return 5_000;
  for (const ms of [60_000, 15_000, 5_000]) if (sample.every((k) => k[0] % ms === 0)) return ms;
  return 1_000;
}

/**
 * Bucket candles into `frame` (never finer than the data), fill quiet buckets with flat candles
 * so the tape scrolls evenly like a terminal, and keep the last `maxBars`. With `now`, the right
 * edge is the current bucket even if nothing traded in it yet (the forming candle).
 */
export function aggregate(candles, maxBars, frame = "auto", now = 0, base = 0) {
  const native = base || nativeMs(candles);
  let pick = FRAMES.find((f) => f[0] === frame);
  if (!pick || pick[1] < native) pick = FRAMES.find((f) => f[1] >= native) ?? FRAMES[FRAMES.length - 1];
  const ms = pick[1];
  const byBucket = new Map();
  for (const k of candles) {
    const b = k[0] - (k[0] % ms);
    const last = byBucket.get(b);
    if (last) {
      last[2] = Math.max(last[2], k[2]);
      last[3] = Math.min(last[3], k[3]);
      last[4] = k[4];
      last[5] += k[5];
    } else byBucket.set(b, [b, k[1], k[2], k[3], k[4], k[5]]);
  }
  if (!byBucket.size) return { bars: [], tf: pick[0], ms };
  const keys = [...byBucket.keys()].sort((a, b) => a - b);
  const first = keys[0];
  let end = keys[keys.length - 1];
  if (now) end = Math.max(end, now - (now % ms));
  const start = Math.max(first, end - (maxBars - 1) * ms);
  // the close just before the window, so a quiet first bucket still has a price
  let prevClose = byBucket.get(first)[1];
  for (const k of keys) {
    if (k >= start) break;
    prevClose = byBucket.get(k)[4];
  }
  const bars = [];
  for (let b = start; b <= end; b += ms) {
    const bar = byBucket.get(b);
    if (bar) {
      bars.push(bar);
      prevClose = bar[4];
    } else bars.push([b, prevClose, prevClose, prevClose, prevClose, 0]);
  }
  return { bars, tf: pick[0], ms };
}

export function fmtMcap(v, prefix = "") {
  if (!Number.isFinite(v)) return "–";
  if (v >= 1e6) return `${prefix}${(v / 1e6).toFixed(2)}M`;
  if (prefix) return prefix + fmtMcap(v);
  if (v >= 100000) return `${(v / 1000).toFixed(0)}K`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/** Percent change across the given candles. */
export function changePct(candles) {
  if (!candles?.length) return 0;
  const o = candles[0][1];
  const c = candles[candles.length - 1][4];
  return o ? ((c - o) / o) * 100 : 0;
}

/** Percent change over the last `windowMs` (or since the first candle if the history is shorter). */
export function changeSince(candles, windowMs) {
  if (!candles?.length) return 0;
  const last = candles[candles.length - 1];
  const cutoff = last[0] - windowMs;
  let o = candles[0][1];
  for (const k of candles) {
    if (k[0] >= cutoff) {
      o = k[1];
      break;
    }
  }
  return o ? ((last[4] - o) / o) * 100 : 0;
}

/** Round axis steps (1, 2, 2.5 or 5 × 10^n) covering lo..hi with about `count` lines. */
function niceTicks(lo, hi, count) {
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  out.step = step;
  return out;
}
/** Axis label for a tick: as many decimals as the step needs, no more. */
function tickLabel(v, step, prefix = "") {
  if (v >= 1e6) {
    const d = step >= 1e6 ? 0 : step >= 1e5 ? 1 : 2;
    return `${prefix}${(v / 1e6).toFixed(d)}M`;
  }
  if (v >= 1000) {
    const d = step >= 1000 ? 0 : step >= 100 ? 1 : 2;
    return `${prefix}${(v / 1000).toFixed(d)}K`;
  }
  const d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return prefix + v.toFixed(d);
}

/**
 * Draw into `host` (a sized element). Options:
 *   entry  – market cap where the bot bought (dashed line)
 *   marks  – [{ t: ms, side: "buy" | "sell" }] trade markers
 *   compact – smaller labels for thumbnails
 *   usd    – SOL price in USD; when given, the axis shows dollar market caps
 *   frame  – timeframe ("1s", "5s", "15s", "30s", "1m", "5m"); "auto" = the data's own resolution
 *   now    – current time (ms); when given, the tape runs up to now and the last candle is the forming one
 *   base   – the candles' own resolution in ms (1000 for the live feed, 5000 for the snapshot); guessed if omitted
 * Returns the timeframe label (e.g. "1m").
 */
export function renderCandles(host, candles, { entry, marks = [], compact = false, big = false, usd = 0, frame = "auto", now = 0, base = 0 } = {}) {
  const prefix = usd ? "$" : "";
  const r2 = (v) => Math.round(v * 2) / 2;
  if (usd) {
    candles = candles.map((k) => [k[0], k[1] * usd, k[2] * usd, k[3] * usd, k[4] * usd, k[5]]);
    if (entry) entry *= usd;
  }
  const W = Math.round(host.clientWidth);
  const H = Math.round(host.clientHeight);
  if (!W || !H || !candles?.length) {
    host.innerHTML = "";
    return "";
  }
  const axisW = compact ? 0 : big ? 72 : 60;
  const tagH = big ? 24 : 18;
  const fs = big ? 14 : 11;
  const timeH = compact ? 0 : big ? 28 : 22;
  const plotW = W - axisW;
  const volH = Math.round((H - timeH) * 0.14);
  const plotTop = compact ? 6 : 10;
  const plotH = H - timeH - volH - plotTop - 4;
  // empty slots kept on the right, like a real chart, and a minimum slot count so a
  // young coin's few candles stretch across the chart instead of hugging one edge
  const rightPad = compact ? 0 : 3;
  // 1-second candles are drawn thinner so a few minutes fit, like a terminal tape
  const fine = (FRAMES.find((f) => f[0] === frame)?.[1] ?? base ?? nativeMs(candles)) <= 1_000;
  const barPx = compact ? 6 : fine ? (plotW < 400 ? 5 : 6) : plotW < 400 ? 8 : 11;
  const maxBars = Math.max(10, Math.floor(plotW / barPx) - rightPad);
  const { bars, tf, ms } = aggregate(candles, maxBars, frame, now, base);
  if (!bars.length) {
    host.innerHTML = "";
    return "";
  }
  const slots = Math.max(bars.length + rightPad, Math.ceil(plotW / (compact ? 12 : 22)));

  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bars) {
    lo = Math.min(lo, b[3]);
    hi = Math.max(hi, b[2]);
  }
  // the entry line is part of the picture while it's near the action; when the price has run far
  // from it, it is pinned to the top or bottom edge instead of squashing the candles
  let entryPinned = 0;
  if (entry) {
    const range = hi - lo || hi * 0.02 || 1;
    if (entry > hi + range * 0.6) entryPinned = 1;
    else if (entry < lo - range * 0.6) entryPinned = -1;
    else {
      lo = Math.min(lo, entry);
      hi = Math.max(hi, entry);
    }
  }
  const pad = (hi - lo || hi * 0.02 || 1) * 0.08;
  lo -= pad;
  hi += pad;
  const Y = (v) => plotTop + (1 - (v - lo) / (hi - lo)) * plotH;
  const slot = plotW / slots;
  const bodyW = Math.max(1, Math.min(14, slot * 0.64));
  const offset = slots - rightPad - bars.length;
  const X = (i) => (i + offset) * slot + slot / 2;
  const vMax = Math.max(...bars.map((b) => b[5]), 1e-9);
  const volTop = H - timeH - volH;
  const r = (n) => Math.round(n) + 0.5;

  const parts = [];
  const last = bars[bars.length - 1];
  const lastCol = last[4] >= last[1] ? UP : DOWN;
  const ly = r(Y(last[4]));
  const entryY = entry ? (entryPinned ? r(entryPinned > 0 ? plotTop + tagH / 2 + 1 : plotTop + plotH - tagH / 2 - 1) : r(Y(entry))) : null;
  // grid + price axis on round numbers (labels under the price or entry tag are skipped)
  const ticks = niceTicks(lo, hi, compact || plotH < 170 ? 3 : 6);
  for (const v of ticks) {
    const y = r(Y(v));
    if (y < plotTop - 1 || y > plotTop + plotH + 1) continue;
    parts.push(`<line x1="0" x2="${plotW}" y1="${y}" y2="${y}" class="cg-grid"/>`);
    if (!compact && Math.abs(y - ly) > tagH * 0.8 && (entryY == null || Math.abs(y - entryY) > tagH * 0.8)) parts.push(`<text x="${W - 12}" y="${y + fs / 3}" class="cg-axis" style="font-size:${fs}px" text-anchor="end">${tickLabel(v, ticks.step, prefix)}</text>`);
  }
  // time labels on round times (HH:MM:SS on fast tapes, HH:MM otherwise), spaced so they never overlap
  if (!compact) {
    const pxPerSec = slot * (1_000 / ms);
    const needSec = Math.ceil(72 / pxPerSec); // fewest seconds between labels that still fit
    const stepSec = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600].filter((s) => (s * 1_000) % ms === 0).find((s) => s >= needSec) ?? 3600;
    const pad2 = (n) => String(n).padStart(2, "0");
    bars.forEach((b, i) => {
      if (b[0] % (stepSec * 1_000) || X(i) < 30 || X(i) > plotW - 30) return;
      const d = new Date(b[0]);
      const label = stepSec < 60 ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      parts.push(`<text x="${X(i)}" y="${H - (big ? 8 : 6)}" class="cg-axis" style="font-size:${fs}px" text-anchor="middle">${label}</text>`);
    });
  }
  // volume + candles
  bars.forEach((b, i) => {
    const up = b[4] >= b[1];
    const quiet = b[5] === 0 && b[1] === b[4] && b[2] === b[3]; // nothing traded: a neutral tick
    const col = quiet ? "#5d6682" : up ? UP : DOWN;
    const x = X(i);
    const vh = Math.max(1, (b[5] / vMax) * (volH - 2));
    parts.push(`<rect x="${(x - bodyW / 2).toFixed(1)}" y="${(H - timeH - vh).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${vh.toFixed(1)}" fill="${col}" opacity=".22"/>`);
    parts.push(`<line x1="${r(x)}" x2="${r(x)}" y1="${Y(b[2]).toFixed(1)}" y2="${Y(b[3]).toFixed(1)}" stroke="${col}" stroke-width="1"/>`);
    const yTop = Y(Math.max(b[1], b[4]));
    const yBot = Y(Math.min(b[1], b[4]));
    parts.push(`<rect x="${(x - bodyW / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(1, yBot - yTop).toFixed(1)}" fill="${col}"/>`);
  });
  // entry line, with its price as an amber tag on the axis (an arrow when it's pinned off-screen)
  if (entry) {
    if (!entryPinned) parts.push(`<line x1="0" x2="${plotW}" y1="${entryY}" y2="${entryY}" class="cg-entry"/>`);
    if (!compact && Math.abs(entryY - ly) >= tagH) {
      // a pinned tag grows into the plot a little to make room for its arrow
      const grow = entryPinned ? 16 : 0;
      parts.push(`<rect x="${plotW + 4 - grow}" y="${entryY - tagH / 2}" width="${axisW - 12 + grow}" height="${tagH}" rx="4" fill="${AMBER}" opacity="${entryPinned ? 0.8 : 1}"/>`);
      if (entryPinned) {
        const ax = plotW + 4 - grow + 6;
        parts.push(entryPinned > 0 ? `<path d="M${ax} ${entryY + 3} l3.5 -6 l3.5 6 z" fill="#07090f"/>` : `<path d="M${ax} ${entryY - 3} l3.5 6 l3.5 -6 z" fill="#07090f"/>`);
      }
      parts.push(`<text x="${W - 14}" y="${entryY + fs / 3}" class="cg-tag cg-tag-dark" style="font-size:${fs}px" text-anchor="end">${fmtMcap(entry, prefix)}</text>`);
    }
  }
  // buy / sell bubbles, like a trading terminal: green B under the candle, red S above it.
  // Several trades in one candle stack outward so they stay readable.
  if (!compact) {
    const r = big ? 12 : 10;
    const mfs = big ? 13 : 11;
    const stacked = new Map();
    for (const m of [...marks].sort((a, b) => a.t - b.t)) {
      const i = bars.findIndex((b) => m.t >= b[0] && m.t < b[0] + ms);
      if (i < 0) continue;
      const key = `${i}:${m.side}`;
      const n = stacked.get(key) ?? 0;
      stacked.set(key, n + 1);
      const x = r2(X(i));
      const buy = m.side === "buy";
      const edge = buy ? Y(bars[i][3]) : Y(bars[i][2]);
      const cy = r2(buy ? edge + 6 + r + n * (2 * r + 3) : edge - 6 - r - n * (2 * r + 3));
      const col = buy ? UP : DOWN;
      const tip = m.sol != null ? `${buy ? "Bought" : "Sold"} ${Number(m.sol).toFixed(3)} SOL` : buy ? "Bought" : "Sold";
      parts.push(
        `<g class="cg-mark"><title>${tip}</title>` +
          `<line x1="${x}" x2="${x}" y1="${r2(edge)}" y2="${r2(buy ? cy - r : cy + r)}" stroke="${col}" stroke-width="1" opacity=".7"/>` +
          `<circle cx="${x}" cy="${cy}" r="${r}" fill="${col}" stroke="#07090f" stroke-width="1.5"/>` +
          `<text x="${x}" y="${cy + mfs * 0.36}" text-anchor="middle" class="cg-tag cg-tag-dark" style="font-size:${mfs}px;font-weight:700">${buy ? "B" : "S"}</text></g>`,
      );
    }
  }
  // last price line + tag
  parts.push(`<line x1="0" x2="${plotW}" y1="${ly}" y2="${ly}" stroke="${lastCol}" stroke-width="1" stroke-dasharray="2 3" opacity=".8"/>`);
  if (!compact) {
    parts.push(`<rect x="${plotW + 4}" y="${ly - tagH / 2}" width="${axisW - 12}" height="${tagH}" rx="4" fill="${lastCol}"/>`);
    parts.push(`<text x="${W - 14}" y="${ly + fs / 3}" class="cg-tag cg-tag-dark" style="font-size:${fs}px" text-anchor="end">${fmtMcap(last[4], prefix)}</text>`);
  }
  // separator above volume
  parts.push(`<line x1="0" x2="${plotW}" y1="${r(volTop)}" y2="${r(volTop)}" class="cg-grid"/>`);

  host.innerHTML = `<svg class="cg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Candlestick chart, ${tf} candles">${parts.join("")}</svg>`;
  return tf;
}
