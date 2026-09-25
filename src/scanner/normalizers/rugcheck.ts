import type { Candidate } from "../../domain/types.js";
import type { RugStatsToken } from "../../infra/providers/rugcheck.js";

export function normalizeRugStats(
  token: RugStatsToken,
  source: string,
  now: Date,
): Candidate | null {
  if (!token.mint || typeof token.mint !== "string") return null;
  return {
    mint: token.mint,
    poolAddress: null,
    dexId: null,
    launchpad: null,
    quoteMint: null,
    poolCreatedAt: null,
    firstSeenAt: now,
    source,
    triggerTags: ["rugcheck_trending"],
    snapshot: {
      symbol: token.symbol ?? null,
      name: token.name ?? null,
      upVotes: token.up_count ?? null,
      votes: token.vote_count ?? null,
    },
  };
}
