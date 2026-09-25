import type { Route } from "../domain/types.js";
import type { CandidateFeatures } from "../filter/features.js";

export type SectionStatus = "ok" | "partial" | "unavailable";

export interface Section<T> {
  status: SectionStatus;
  data: T | null;
  reason?: string;
  latencyMs: number;
  cached: boolean;
}

export interface SecuritySection {
  scoreNormalised: number | null;
  score: number | null;
  risks: Array<{ name: string; level: string; score: number }>;
  dangerRisks: string[];
  mintAuthority: string | null;
  freezeAuthority: string | null;
  metadataMutable: boolean | null;
  transferFeePct: number | null;
  totalHolders: number | null;
  topHolders: Array<{ address: string; pct: number; insider: boolean; owner: string }>;
  /** Top-10 holder share excluding pool / known program accounts. */
  top10Pct: number | null;
  lpLockedPct: number | null;
  totalMarketLiquidityUsd: number | null;
  insiderNetworks: number | null;
  graphInsidersDetected: number | null;
  creator: string | null;
  creatorTokens: Array<{ mint: string; marketCapUsd: number }>;
  /** Share of the creator's earlier tokens below $1k market cap (null when too few). */
  creatorDeadTokenRatio: number | null;
  launchpad: string | null;
  rugged: boolean;
  supply: number | null;
  decimals: number | null;
}

export interface MarketSection {
  pairAddress: string;
  dexId: string;
  quoteMint: string;
  priceUsd: number | null;
  priceNative: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  pairCreatedAt: string | null;
  volumeUsd: Record<"m5" | "h1" | "h6" | "h24", number | null>;
  txns: Record<"m5" | "h1" | "h6" | "h24", { buys: number; sells: number } | null>;
  priceChangePct: Record<"m5" | "h1" | "h6" | "h24", number | null>;
  pairCount: number;
  socials: Array<{ type: string; url: string }>;
  websites: string[];
  boostsActive: number;
  labels: string[];
}

export interface FlowSection {
  trades: number;
  buys: number;
  sells: number;
  uniqueTraders: number;
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  medianInterTradeMs: number | null;
  largestTradeUsd: number;
  windowFrom: string | null;
  windowTo: string | null;
  buyersM5: number | null;
  sellersM5: number | null;
  buysM5: number | null;
  sellsM5: number | null;
}

export interface CandlesSection {
  candles: number;
  timeframe: "m1";
  lastCloseUsd: number | null;
  highUsd: number | null;
  lowUsd: number | null;
  drawdownFromHighPct: number | null;
  /** Standard deviation of 1-minute log returns, in percent. */
  volatilityPct: number | null;
  /** Volume of the last 15 candles vs the previous 45 (ratio of per-candle averages). */
  volumeTrend: number | null;
  windowFrom: string | null;
  windowTo: string | null;
}

export interface HoldersSection {
  top20: Array<{ address: string; pct: number }>;
  top20Pct: number | null;
  source: "rpc";
}

export interface KolSection {
  count: number;
  buyers: Array<{
    address: string;
    label: string | null;
    ts: string;
    tradesToday: number | null;
    botSuspect: boolean;
  }>;
  clusterWithinWindow: boolean;
  windowMin: number;
}

export interface MarketContextSection {
  solPriceUsd: number | null;
  solChangeH1Pct: number | null;
  solChangeH24Pct: number | null;
  migrationsToday: number;
  candidatesTodayByRoute: Record<string, number>;
  routeStats7d: { trades: number; winRate: number | null; meanPnlPct: number | null } | null;
}

export interface TwitterSection {
  mentions1h: number | null;
  mentions24h: number | null;
  uniqueAuthors24h: number | null;
  weightedScore: number | null;
  kolPosted: boolean | null;
  firstMentionAt: string | null;
}

export interface EnrichmentSections {
  security: Section<SecuritySection>;
  market: Section<MarketSection>;
  flow: Section<FlowSection>;
  candles: Section<CandlesSection>;
  holders: Section<HoldersSection>;
  kol: Section<KolSection>;
  twitter: Section<TwitterSection>;
  context: Section<MarketContextSection>;
}

export type SectionName = keyof EnrichmentSections;

export interface EnrichmentDocument {
  mint: string;
  route: Route;
  features: CandidateFeatures;
  sections: EnrichmentSections;
  unavailable: SectionName[];
  latenciesMs: Record<string, number>;
  createdAt: string;
}

export function unavailable<T>(reason: string, latencyMs = 0): Section<T> {
  return { status: "unavailable", data: null, reason, latencyMs, cached: false };
}
