import type { Candidate, TriggerTag } from "../../domain/types.js";
import type { DexPair, TokenProfile } from "../../infra/providers/dexscreener.js";

function num(v: string | number | undefined | null): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Boost/profile lists carry only the token address; the pool is resolved later. */
export function normalizeTokenProfile(
  profile: TokenProfile,
  tag: TriggerTag,
  source: string,
  now: Date,
): Candidate | null {
  if (profile.chainId !== "solana") return null;
  return {
    mint: profile.tokenAddress,
    poolAddress: null,
    dexId: null,
    launchpad: null,
    quoteMint: null,
    poolCreatedAt: null,
    firstSeenAt: now,
    source,
    triggerTags: [tag],
    snapshot: {
      description: profile.description ?? null,
      links: profile.links ?? [],
      boostAmount: profile.amount ?? null,
      boostTotal: profile.totalAmount ?? null,
    },
  };
}

/** Snapshot fields taken from a DexScreener pair (used by the pool resolver and warming refresh). */
export function pairSnapshot(pair: DexPair): Record<string, unknown> {
  return {
    name: `${pair.baseToken.symbol} / ${pair.quoteToken.symbol}`,
    priceUsd: num(pair.priceUsd),
    priceNative: num(pair.priceNative),
    fdvUsd: num(pair.fdv),
    marketCapUsd: num(pair.marketCap),
    liquidityUsd: num(pair.liquidity?.usd),
    volumeUsd: {
      m5: num(pair.volume.m5),
      h1: num(pair.volume.h1),
      h6: num(pair.volume.h6),
      h24: num(pair.volume.h24),
    },
    priceChangePct: {
      m5: num(pair.priceChange.m5),
      h1: num(pair.priceChange.h1),
      h6: num(pair.priceChange.h6),
      h24: num(pair.priceChange.h24),
    },
    txns: {
      m5: pair.txns.m5 ? { buys: pair.txns.m5.buys, sells: pair.txns.m5.sells } : null,
      h1: pair.txns.h1 ? { buys: pair.txns.h1.buys, sells: pair.txns.h1.sells } : null,
      h24: pair.txns.h24 ? { buys: pair.txns.h24.buys, sells: pair.txns.h24.sells } : null,
    },
    socials: pair.info?.socials ?? [],
    websites: pair.info?.websites ?? [],
    boostsActive: pair.boosts?.active ?? 0,
    labels: pair.labels ?? [],
  };
}

/** Prefer SOL/USDC-quoted pools with the most liquidity. */
export function pickPrimaryPair(
  pairs: readonly DexPair[],
  quoteMints: ReadonlySet<string>,
): DexPair | null {
  const solana = pairs.filter((p) => p.chainId === "solana");
  const quoted = solana.filter((p) => quoteMints.has(p.quoteToken.address));
  const pool = quoted.length > 0 ? quoted : solana;
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
}
