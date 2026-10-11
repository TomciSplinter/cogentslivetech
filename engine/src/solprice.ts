// Live SOL price in USD, from free public APIs (no key needed). Returns undefined if both fail.
import { fetchT } from "./util.ts";

const SOL_MINT = "So11111111111111111111111111111111111111112";

let lastSolUsd = 0;
/** Last SOL/USD price fetched (0 until the first fetch). */
export const solUsdNow = () => lastSolUsd;

export async function fetchSolUsd(): Promise<number | undefined> {
  const sources: (() => Promise<number>)[] = [
    async () => {
      const r = await fetchT("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", {}, 8000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Number(((await r.json()) as any)?.solana?.usd);
    },
    async () => {
      const r = await fetchT(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`, {}, 8000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Number(((await r.json()) as any)?.[SOL_MINT]?.usdPrice);
    },
  ];
  for (const get of sources) {
    try {
      const v = await get();
      if (Number.isFinite(v) && v > 1 && v < 100000) {
        lastSolUsd = v;
        return v;
      }
    } catch {}
  }
  return undefined;
}

/** Prices in SOL for up to 50 tokens, from Jupiter. Missing tokens are left out. */
export async function fetchTokenPricesSol(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!mints.length) return out;
  try {
    const ids = [SOL_MINT, ...mints.slice(0, 50)].join(",");
    const r = await fetchT(`https://lite-api.jup.ag/price/v3?ids=${ids}`, {}, 8000);
    if (!r.ok) return out;
    const j: any = await r.json();
    const sol = Number(j?.[SOL_MINT]?.usdPrice);
    if (!(sol > 0)) return out;
    for (const m of mints) {
      const usd = Number(j?.[m]?.usdPrice);
      if (usd > 0) out.set(m, usd / sol);
    }
  } catch {}
  return out;
}
