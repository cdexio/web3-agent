export type Mode = "paper" | "live" | "backtest";
export type Route = "migration" | "mature";
export type CandidateRoute = Route | "warming" | "rejected";

export type TriggerTag =
  | "migration"
  | "new_pool"
  | "trending_5m"
  | "trending_1h"
  | "trending_6h"
  | "boost"
  | "profile"
  | "rugcheck_trending"
  | "kol_buy"
  | "breakout"
  | "golden_swing";

/** Normalised scanner output; every source maps its payload to this shape. */
export interface Candidate {
  mint: string;
  poolAddress: string | null;
  dexId: string | null;
  launchpad: string | null;
  quoteMint: string | null;
  poolCreatedAt: Date | null;
  firstSeenAt: Date;
  source: string;
  triggerTags: TriggerTag[];
  /** Fields the source already provided, so later stages do not refetch them. */
  snapshot: Record<string, unknown>;
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Launchpad / AMM program ids used for migration detection (research section 2.3). */
export const PROGRAM_IDS = {
  pumpFunBondingCurve: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  pumpFunMigration: "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg",
  pumpSwapAmm: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  raydiumLaunchLab: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
  meteoraDbc: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
} as const;
