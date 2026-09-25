import type { AppConfig } from "../../config/schema.js";
import type { DexClassifier } from "../../domain/dex.js";
import type { Candidate } from "../../domain/types.js";
import type { Logger } from "../../infra/logger.js";
import type { DexScreenerClient } from "../../infra/providers/dexscreener.js";
import type { GeckoTerminalClient } from "../../infra/providers/geckoterminal.js";
import type { RugCheckClient } from "../../infra/providers/rugcheck.js";
import type { ScannerMetrics } from "../metrics.js";
import { normalizeTokenProfile } from "../normalizers/dexscreener.js";
import { normalizeGtPool, trendingTag } from "../normalizers/geckoterminal.js";
import type { LaunchSeen } from "../normalizers/pumpportal.js";
import { normalizeRugStats } from "../normalizers/rugcheck.js";
import { IntervalSource, SeenCache } from "./interval-source.js";

export interface SourceSink {
  candidate(c: Candidate): void;
  launch(l: LaunchSeen): void;
}

/** GeckoTerminal new pools on every DEX: fresh AMM pools become candidates, bonding curves become launches. */
export class GeckoNewPoolsSource extends IntervalSource {
  private readonly seen = new SeenCache(60 * 60_000);

  constructor(
    private readonly gecko: GeckoTerminalClient,
    private readonly cfg: AppConfig["scanner"]["geckoNewPools"],
    private readonly classifier: DexClassifier,
    private readonly sink: SourceSink,
    metrics: ScannerMetrics,
    logger: Logger,
  ) {
    super("gecko-new-pools", cfg.intervalSec * 1000, 0, metrics, logger);
  }

  protected async tick(): Promise<void> {
    const now = new Date();
    for (let page = 1; page <= this.cfg.pages; page++) {
      const pools = await this.gecko.newPools(page);
      for (const pool of pools) {
        if (!this.seen.first(pool.attributes.address)) continue;
        const { candidate, bondingCurve } = normalizeGtPool(
          pool,
          ["new_pool"],
          this.name,
          this.classifier,
          now,
        );
        const lag = candidate.poolCreatedAt
          ? now.getTime() - candidate.poolCreatedAt.getTime()
          : undefined;
        this.metrics.event(this.name, lag);
        if (bondingCurve) {
          this.metrics.launch(this.name);
          this.sink.launch({
            mint: candidate.mint,
            creator: null,
            launchpad: candidate.dexId,
            name: typeof candidate.snapshot.name === "string" ? candidate.snapshot.name : null,
            symbol: null,
            payload: { poolAddress: candidate.poolAddress, poolCreatedAt: candidate.poolCreatedAt },
          });
          continue;
        }
        this.metrics.candidate(this.name);
        this.sink.candidate(candidate);
      }
    }
  }
}

export class GeckoTrendingSource extends IntervalSource {
  private readonly seen = new SeenCache(15 * 60_000);

  constructor(
    private readonly gecko: GeckoTerminalClient,
    private readonly cfg: AppConfig["scanner"]["geckoTrending"],
    private readonly classifier: DexClassifier,
    private readonly sink: SourceSink,
    metrics: ScannerMetrics,
    logger: Logger,
  ) {
    super("gecko-trending", cfg.intervalSec * 1000, 3_000, metrics, logger);
  }

  protected async tick(): Promise<void> {
    const now = new Date();
    for (const duration of this.cfg.durations) {
      const pools = await this.gecko.trendingPools(duration);
      const tag = trendingTag(duration);
      for (const pool of pools) {
        this.metrics.event(this.name);
        if (!this.seen.first(`${tag}:${pool.attributes.address}`)) continue;
        const { candidate, bondingCurve } = normalizeGtPool(
          pool,
          [tag],
          this.name,
          this.classifier,
          now,
        );
        if (bondingCurve) continue; // trending bonding curves are not tradable pools
        this.metrics.candidate(this.name);
        this.sink.candidate(candidate);
      }
    }
  }
}

/** DexScreener paid attention signals: boosts (latest/top) and fresh token profiles. */
export class DexScreenerListsSource extends IntervalSource {
  private readonly seen = new SeenCache(30 * 60_000);

  constructor(
    private readonly dexscreener: DexScreenerClient,
    cfg: AppConfig["scanner"]["dexscreenerLists"],
    private readonly sink: SourceSink,
    metrics: ScannerMetrics,
    logger: Logger,
  ) {
    super("dexscreener-lists", cfg.intervalSec * 1000, 6_000, metrics, logger);
  }

  protected async tick(): Promise<void> {
    const now = new Date();
    const lists = [
      { tag: "boost" as const, items: await this.dexscreener.tokenBoostsLatest() },
      { tag: "boost" as const, items: await this.dexscreener.tokenBoostsTop() },
      { tag: "profile" as const, items: await this.dexscreener.tokenProfilesLatest() },
    ];
    for (const list of lists) {
      for (const item of list.items) {
        this.metrics.event(this.name);
        const c = normalizeTokenProfile(item, list.tag, this.name, now);
        if (!c || !this.seen.first(`${list.tag}:${c.mint}`)) continue;
        this.metrics.candidate(this.name);
        this.sink.candidate(c);
      }
    }
  }
}

export class RugCheckStatsSource extends IntervalSource {
  private readonly seen = new SeenCache(30 * 60_000);

  constructor(
    private readonly rugcheck: RugCheckClient,
    cfg: AppConfig["scanner"]["rugcheckStats"],
    private readonly sink: SourceSink,
    metrics: ScannerMetrics,
    logger: Logger,
  ) {
    super("rugcheck-stats", cfg.intervalSec * 1000, 9_000, metrics, logger);
  }

  protected async tick(): Promise<void> {
    const now = new Date();
    const lists = [await this.rugcheck.statsTrending(), await this.rugcheck.statsNewTokens()];
    for (const list of lists) {
      for (const token of list) {
        this.metrics.event(this.name);
        const c = normalizeRugStats(token, this.name, now);
        if (!c || !this.seen.first(c.mint)) continue;
        this.metrics.candidate(this.name);
        this.sink.candidate(c);
      }
    }
  }
}
