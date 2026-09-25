import type { DexClassifier } from "../../domain/dex.js";
import type { Candidate, TriggerTag } from "../../domain/types.js";
import type { GtPool, GtTrendingDuration } from "../../infra/providers/geckoterminal.js";

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** GeckoTerminal token ids look like `solana_<mint>`. */
export function tokenIdToMint(id: string): string {
  const i = id.indexOf("_");
  return i >= 0 ? id.slice(i + 1) : id;
}

export interface GtNormalized {
  candidate: Candidate;
  bondingCurve: boolean;
}

export function normalizeGtPool(
  pool: GtPool,
  tags: TriggerTag[],
  source: string,
  classifier: DexClassifier,
  now: Date,
): GtNormalized {
  const a = pool.attributes;
  const dexId = pool.relationships.dex.data.id;
  const m5 = a.transactions.m5;
  const h1 = a.transactions.h1;
  const candidate: Candidate = {
    mint: tokenIdToMint(pool.relationships.base_token.data.id),
    poolAddress: a.address,
    dexId,
    launchpad: classifier.launchpadFor(dexId),
    quoteMint: tokenIdToMint(pool.relationships.quote_token.data.id),
    poolCreatedAt: a.pool_created_at ? new Date(a.pool_created_at) : null,
    firstSeenAt: now,
    source,
    triggerTags: tags,
    snapshot: {
      name: a.name,
      priceUsd: num(a.base_token_price_usd),
      priceNative: num(a.base_token_price_native_currency),
      fdvUsd: num(a.fdv_usd),
      marketCapUsd: num(a.market_cap_usd),
      liquidityUsd: num(a.reserve_in_usd),
      volumeUsd: {
        m5: num(a.volume_usd.m5),
        h1: num(a.volume_usd.h1),
        h6: num(a.volume_usd.h6),
        h24: num(a.volume_usd.h24),
      },
      priceChangePct: {
        m5: num(a.price_change_percentage.m5),
        h1: num(a.price_change_percentage.h1),
        h6: num(a.price_change_percentage.h6),
        h24: num(a.price_change_percentage.h24),
      },
      txns: {
        m5: m5 ? { buys: m5.buys, sells: m5.sells, buyers: m5.buyers, sellers: m5.sellers } : null,
        h1: h1 ? { buys: h1.buys, sells: h1.sells, buyers: h1.buyers, sellers: h1.sellers } : null,
      },
    },
  };
  return { candidate, bondingCurve: classifier.isBondingCurve(dexId) };
}

export function trendingTag(duration: GtTrendingDuration): TriggerTag {
  switch (duration) {
    case "5m":
      return "trending_5m";
    case "1h":
      return "trending_1h";
    default:
      return "trending_6h";
  }
}
