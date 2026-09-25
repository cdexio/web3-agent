import type { DexClassifier } from "../domain/dex.js";
import type { Candidate } from "../domain/types.js";
import { SOL_MINT, USDC_MINT } from "../domain/types.js";
import { errorMessage } from "../infra/errors.js";
import type { Logger } from "../infra/logger.js";
import type { DexScreenerClient } from "../infra/providers/dexscreener.js";
import { type Clock, systemClock } from "../infra/time.js";
import { pairSnapshot, pickPrimaryPair } from "./normalizers/dexscreener.js";

const QUOTES = new Set([SOL_MINT, USDC_MINT]);

export interface PoolResolverOptions {
  retries: number;
  retryDelayMs: number;
  clock?: Clock;
}

/**
 * Fills pool address, dex, quote, creation time and market snapshot for a
 * candidate that arrived with only a mint (migration events, boost lists,
 * KOL buys), using DexScreener token-pairs (300 req/min, indexes new pools
 * within seconds). Retries a few times because a brand-new pool may not be
 * indexed on the first look.
 */
export class PoolResolver {
  private readonly clock: Clock;

  constructor(
    private readonly dexscreener: DexScreenerClient,
    private readonly classifier: DexClassifier,
    private readonly opts: PoolResolverOptions,
    private readonly logger: Logger,
  ) {
    this.clock = opts.clock ?? systemClock;
  }

  async resolve(candidate: Candidate): Promise<Candidate | null> {
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      try {
        const pairs = await this.dexscreener.tokenPairs("solana", candidate.mint);
        const pair = pickPrimaryPair(pairs, QUOTES);
        if (pair) {
          const dexId = pair.dexId;
          return {
            ...candidate,
            poolAddress: pair.pairAddress,
            dexId,
            launchpad: candidate.launchpad ?? this.classifier.launchpadFor(dexId),
            quoteMint: pair.quoteToken.address,
            poolCreatedAt:
              pair.pairCreatedAt !== undefined
                ? new Date(pair.pairCreatedAt)
                : candidate.poolCreatedAt,
            snapshot: { ...candidate.snapshot, ...pairSnapshot(pair), pairCount: pairs.length },
          };
        }
      } catch (err) {
        this.logger.warn(
          { mint: candidate.mint, attempt, err: errorMessage(err) },
          "pool resolve failed",
        );
      }
      if (attempt < this.opts.retries) await this.clock.sleep(this.opts.retryDelayMs);
    }
    return null;
  }
}
