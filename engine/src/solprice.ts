// Live SOL price in USD, from free public APIs (no key needed). Returns undefined if both fail.
import { fetchT } from "./util.ts";

const SOL_MINT = "So11111111111111111111111111111111111111112";

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
      if (Number.isFinite(v) && v > 1 && v < 100000) return v;
    } catch {}
  }
  return undefined;
}
