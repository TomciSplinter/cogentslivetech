// Candlestick chart (green/red candles, volume, price line, entry line, buy/sell marks).
// Input candles: [bucketStartMs, open, high, low, close, volumeSol] at 5-second resolution,
// prices are market cap in SOL (shown in USD when a SOL price is given). Rendered as crisp SVG
// at the host's exact pixel size.

export const UP = "#3ddc97";
export const DOWN = "#ff5c7a";
const AMBER = "#7fdcff";
const BASE_MS = 5_000;
const FRAMES = [
  [1, "5s"],
  [3, "15s"],
  [6, "30s"],
  [12, "1m"],
  [24, "2m"],
  [60, "5m"],
];

/**
 * Pick a timeframe and merge the 5s candles into it. The chart is a live tape, so it stays on
 * 5s candles and shows the most recent `maxBars` of them; pass `frame` ("15s", "1m", ...) to zoom out.
 */
export function aggregate(candles, maxBars, frame = "5s") {
  const pick = FRAMES.find((f) => f[1] === frame) ?? FRAMES[0];
  const ms = BASE_MS * pick[0];
  const out = [];
  for (const k of candles) {
    const b = k[0] - (k[0] % ms);
    const last = out[out.length - 1];
    if (last && last[0] === b) {
      last[2] = Math.max(last[2], k[2]);
      last[3] = Math.min(last[3], k[3]);
      last[4] = k[4];
      last[5] += k[5];
    } else out.push([b, k[1], k[2], k[3], k[4], k[5]]);
  }
  return { bars: out.slice(-maxBars), tf: pick[1], ms };
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

/** Percent change across the visible candles. */
export function changePct(candles) {
  if (!candles?.length) return 0;
  const o = candles[0][1];
  const c = candles[candles.length - 1][4];
  return o ? ((c - o) / o) * 100 : 0;
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
 *   frame  – timeframe label to zoom out to ("15s", "1m", ...), default 5s
 * Returns the timeframe label (e.g. "1m").
 */
export function renderCandles(host, candles, { entry, marks = [], compact = false, big = false, usd = 0, frame = "5s" } = {}) {
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
  const barPx = compact ? 6 : plotW < 400 ? 8 : 11;
  const maxBars = Math.max(10, Math.floor(plotW / barPx) - rightPad);
  const { bars, tf, ms } = aggregate(candles, maxBars, frame);
  const slots = Math.max(bars.length + rightPad, Math.ceil(plotW / (compact ? 12 : 22)));

  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bars) {
    lo = Math.min(lo, b[3]);
    hi = Math.max(hi, b[2]);
  }
  if (entry) {
    lo = Math.min(lo, entry);
    hi = Math.max(hi, entry);
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
  const entryY = entry ? r(Y(entry)) : null;
  // grid + price axis on round numbers (labels under the price or entry tag are skipped)
  const ticks = niceTicks(lo, hi, compact || plotH < 170 ? 3 : 6);
  for (const v of ticks) {
    const y = r(Y(v));
    if (y < plotTop - 1 || y > plotTop + plotH + 1) continue;
    parts.push(`<line x1="0" x2="${plotW}" y1="${y}" y2="${y}" class="cg-grid"/>`);
    if (!compact && Math.abs(y - ly) > tagH * 0.8 && (entryY == null || Math.abs(y - entryY) > tagH * 0.8)) parts.push(`<text x="${W - 12}" y="${y + fs / 3}" class="cg-axis" style="font-size:${fs}px" text-anchor="end">${tickLabel(v, ticks.step, prefix)}</text>`);
  }
  // time labels on whole minutes only (HH:MM), spaced so they never overlap
  if (!compact) {
    const pxPerMinute = slot * (60_000 / ms);
    const needMin = Math.ceil(64 / pxPerMinute); // fewest minutes between labels that still fit
    const stepMin = [1, 2, 5, 10, 15, 20, 30, 60].filter((m) => (m * 60_000) % ms === 0).find((m) => m >= needMin) ?? 60;
    bars.forEach((b, i) => {
      if (b[0] % (stepMin * 60_000) || X(i) < 26 || X(i) > plotW - 26) return;
      const d = new Date(b[0]);
      parts.push(`<text x="${X(i)}" y="${H - (big ? 8 : 6)}" class="cg-axis" style="font-size:${fs}px" text-anchor="middle">${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}</text>`);
    });
  }
  // volume + candles
  bars.forEach((b, i) => {
    const up = b[4] >= b[1];
    const col = up ? UP : DOWN;
    const x = X(i);
    const vh = Math.max(1, (b[5] / vMax) * (volH - 2));
    parts.push(`<rect x="${(x - bodyW / 2).toFixed(1)}" y="${(H - timeH - vh).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${vh.toFixed(1)}" fill="${col}" opacity=".22"/>`);
    parts.push(`<line x1="${r(x)}" x2="${r(x)}" y1="${Y(b[2]).toFixed(1)}" y2="${Y(b[3]).toFixed(1)}" stroke="${col}" stroke-width="1"/>`);
    const yTop = Y(Math.max(b[1], b[4]));
    const yBot = Y(Math.min(b[1], b[4]));
    parts.push(`<rect x="${(x - bodyW / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(1, yBot - yTop).toFixed(1)}" fill="${col}"/>`);
  });
  // entry line, with its price as an amber tag on the axis
  if (entry) {
    parts.push(`<line x1="0" x2="${plotW}" y1="${entryY}" y2="${entryY}" class="cg-entry"/>`);
    if (!compact && Math.abs(entryY - ly) >= tagH) {
      parts.push(`<rect x="${plotW + 4}" y="${entryY - tagH / 2}" width="${axisW - 12}" height="${tagH}" rx="4" fill="${AMBER}"/>`);
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
