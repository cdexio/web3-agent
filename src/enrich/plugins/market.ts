import { SOL_MINT, USDC_MINT } from "../../domain/types.js";
import type { DexPair, DexScreenerClient } from "../../infra/providers/dexscreener.js";
import { pickPrimaryPair } from "../../scanner/normalizers/dexscreener.js";
import type { MarketSection } from "../types.js";

const QUOTES = new Set([SOL_MINT, USDC_MINT]);
const W = ["m5", "h1", "h6", "h24"] as const;

function num(v: string | number | undefined | null): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function reduceMarket(
  pairs: readonly DexPair[],
  preferred: string | null,
): MarketSection | null {
  const chosen =
    (preferred && pairs.find((p) => p.pairAddress === preferred)) || pickPrimaryPair(pairs, QUOTES);
  if (!chosen) return null;
  const rec = <T>(f: (w: (typeof W)[number]) => T) =>
    Object.fromEntries(W.map((w) => [w, f(w)])) as Record<(typeof W)[number], T>;
  return {
    pairAddress: chosen.pairAddress,
    dexId: chosen.dexId,
    quoteMint: chosen.quoteToken.address,
    priceUsd: num(chosen.priceUsd),
    priceNative: num(chosen.priceNative),
    liquidityUsd: num(chosen.liquidity?.usd),
    fdvUsd: num(chosen.fdv),
    marketCapUsd: num(chosen.marketCap),
    pairCreatedAt: chosen.pairCreatedAt ? new Date(chosen.pairCreatedAt).toISOString() : null,
    volumeUsd: rec((w) => num(chosen.volume[w])),
    txns: rec((w) =>
      chosen.txns[w] ? { buys: chosen.txns[w].buys, sells: chosen.txns[w].sells } : null,
    ),
    priceChangePct: rec((w) => num(chosen.priceChange[w])),
    pairCount: pairs.filter((p) => p.chainId === "solana").length,
    socials: chosen.info?.socials ?? [],
    websites: (chosen.info?.websites ?? []).map((w) => w.url),
    boostsActive: chosen.boosts?.active ?? 0,
    labels: chosen.labels ?? [],
  };
}

export async function fetchMarket(
  client: DexScreenerClient,
  mint: string,
  preferredPair: string | null,
): Promise<MarketSection | null> {
  return reduceMarket(await client.tokenPairs("solana", mint), preferredPair);
}
