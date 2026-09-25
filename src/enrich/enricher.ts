import type { AppConfig } from "../config/schema.js";
import type { Candidate, Route } from "../domain/types.js";
import type { CandidateFeatures } from "../filter/features.js";
import type { DbClient } from "../infra/db/client.js";
import { errorMessage } from "../infra/errors.js";
import type { Logger } from "../infra/logger.js";
import type { DexScreenerClient } from "../infra/providers/dexscreener.js";
import type { GeckoTerminalClient } from "../infra/providers/geckoterminal.js";
import type { RugCheckClient } from "../infra/providers/rugcheck.js";
import type { SolanaRpcPool } from "../infra/providers/solana-rpc.js";
import { type Clock, systemClock } from "../infra/time.js";
import { TtlCache } from "./cache.js";
import { fetchContext } from "./plugins/context.js";
import { fetchCandles, fetchFlow } from "./plugins/gecko.js";
import { fetchHolders } from "./plugins/holders-rpc.js";
import { fetchKol } from "./plugins/kol.js";
import { fetchMarket } from "./plugins/market.js";
import { fetchSecurity } from "./plugins/rugcheck.js";
import {
  type EnrichmentDocument,
  type EnrichmentSections,
  type Section,
  type SectionName,
  unavailable,
} from "./types.js";

export interface EnricherDeps {
  rugcheck: RugCheckClient;
  dexscreener: DexScreenerClient;
  geckoterminal: GeckoTerminalClient;
  rpc: SolanaRpcPool;
  db: DbClient;
  logger: Logger;
  clock?: Clock;
}

export interface EnricherStats {
  documents: number;
  sections: Record<
    SectionName,
    { ok: number; unavailable: number; cached: number; totalLatencyMs: number }
  >;
}

const SECTION_NAMES: SectionName[] = [
  "security",
  "market",
  "flow",
  "candles",
  "holders",
  "kol",
  "twitter",
  "context",
];

/**
 * Runs the enrichers for a candidate in parallel with per-route timeouts and
 * TTL caches, and assembles the enrichment document (plan 3.3/3.4). A
 * section that fails or times out is reported as unavailable, never invented.
 */
export class Enricher {
  private readonly cache = new TtlCache<Section<unknown>>();
  private readonly contextCache = new TtlCache<Section<unknown>>();
  private readonly clock: Clock;
  private readonly stats: EnricherStats = {
    documents: 0,
    sections: Object.fromEntries(
      SECTION_NAMES.map((n) => [n, { ok: 0, unavailable: 0, cached: 0, totalLatencyMs: 0 }]),
    ) as EnricherStats["sections"],
  };

  constructor(
    private readonly cfg: AppConfig["enrich"],
    private readonly kolCfg: AppConfig["scanner"]["kol"],
    private readonly deps: EnricherDeps,
  ) {
    this.clock = deps.clock ?? systemClock;
  }

  snapshot(): EnricherStats {
    return JSON.parse(JSON.stringify(this.stats)) as EnricherStats;
  }

  async enrich(
    candidate: Candidate,
    route: Route,
    features: CandidateFeatures,
  ): Promise<EnrichmentDocument> {
    const timeoutMs =
      route === "migration" ? this.cfg.timeouts.migrationMs : this.cfg.timeouts.matureMs;
    const ttlMs =
      (route === "migration" ? this.cfg.cacheTtl.migrationSec : this.cfg.cacheTtl.matureSec) * 1000;
    const mint = candidate.mint;
    const pool = candidate.poolAddress;
    const d = this.deps;

    // RugCheck answers in 0.6-2 s but the anonymous lane is 10 reports/min, so on the
    // Mature route (not latency-critical) the security section may wait longer in the queue.
    const securityTimeoutMs =
      route === "mature" ? Math.max(timeoutMs, this.cfg.timeouts.securityMatureMs) : timeoutMs;
    const securityP = this.section("security", mint, ttlMs, securityTimeoutMs, () =>
      fetchSecurity(d.rugcheck, mint),
    );
    const marketP = this.section("market", mint, ttlMs, timeoutMs, async () => {
      const m = await fetchMarket(d.dexscreener, mint, pool);
      if (!m) throw new Error("no solana pair on DexScreener");
      return m;
    });
    // GeckoTerminal is the tightest budget and is shared with the scanner: optional sections
    // are fetched only when a limiter token is free right now, never queued into a timeout.
    const geckoSkip = (want: boolean): string | null => {
      if (!want) return "not requested for this route";
      if (!pool) return "pool unknown";
      if (!d.geckoterminal.canCallNow()) return "gecko budget busy";
      return null;
    };
    const flowSkip = geckoSkip(route === "migration" && this.cfg.geckoFlowOnMigration);
    const flowP = flowSkip
      ? Promise.resolve(unavailable<never>(flowSkip))
      : this.section("flow", mint, ttlMs, timeoutMs, () =>
          fetchFlow(d.geckoterminal, pool as string),
        );
    const candlesSkip = geckoSkip(route === "mature" && this.cfg.geckoCandlesOnMature);
    const candlesP = candlesSkip
      ? Promise.resolve(unavailable<never>(candlesSkip))
      : this.section("candles", mint, ttlMs, timeoutMs, () =>
          fetchCandles(d.geckoterminal, pool as string),
        );
    const kolP = this.section("kol", mint, Math.min(ttlMs, 30_000), timeoutMs, () =>
      fetchKol(d.db, mint, this.cfg.kolClusterWindowMin, this.kolCfg.botSuspectTradesPerDay),
    );
    const contextP = this.cachedContext(route, timeoutMs);

    const [security, market, flow, candles, kol, context] = await Promise.all([
      securityP,
      marketP,
      flowP,
      candlesP,
      kolP,
      contextP,
    ]);

    // Holders via RPC only when RugCheck could not provide them.
    const holders =
      security.status === "ok" && security.data && security.data.topHolders.length > 0
        ? unavailable<never>("covered by security section")
        : await this.section("holders", mint, ttlMs, timeoutMs, () =>
            fetchHolders(d.rpc, mint, security.data?.supply ?? null),
          );

    const sections = {
      security,
      market,
      flow,
      candles,
      holders,
      kol,
      twitter: unavailable("sidecar not attached (phase 6)"),
      context,
    } as EnrichmentSections;

    const latenciesMs: Record<string, number> = {};
    const unavailableList: SectionName[] = [];
    for (const name of SECTION_NAMES) {
      const s = sections[name];
      latenciesMs[name] = s.latencyMs;
      if (s.status === "unavailable") unavailableList.push(name);
    }
    this.stats.documents += 1;
    return {
      mint,
      route,
      features,
      sections,
      unavailable: unavailableList,
      latenciesMs,
      createdAt: new Date(this.clock.now()).toISOString(),
    };
  }

  private async cachedContext(route: Route, timeoutMs: number): Promise<Section<unknown>> {
    const key = `context|${route}`;
    const hit = this.contextCache.get(key);
    if (hit) {
      this.stats.sections.context.cached += 1;
      return { ...hit, cached: true };
    }
    const s = await this.section("context", key, 0, timeoutMs, () =>
      fetchContext(this.deps.dexscreener, this.deps.db, this.cfg.solUsdcPair, route),
    );
    if (s.status === "ok") this.contextCache.set(key, s, this.cfg.contextCacheSec * 1000);
    return s;
  }

  private async section<T>(
    name: SectionName,
    key: string,
    ttlMs: number,
    timeoutMs: number,
    fn: () => Promise<T>,
  ): Promise<Section<T>> {
    const cacheKey = `${name}|${key}`;
    const hit = this.cache.get(cacheKey) as Section<T> | undefined;
    const st = this.stats.sections[name];
    if (hit) {
      st.cached += 1;
      return { ...hit, cached: true };
    }
    const started = this.clock.now();
    let timer: NodeJS.Timeout | null = null;
    try {
      const data = await Promise.race([
        fn(),
        new Promise<never>((_r, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
      const section: Section<T> = {
        status: "ok",
        data,
        latencyMs: this.clock.now() - started,
        cached: false,
      };
      st.ok += 1;
      st.totalLatencyMs += section.latencyMs;
      if (ttlMs > 0) this.cache.set(cacheKey, section as Section<unknown>, ttlMs);
      return section;
    } catch (err) {
      const latencyMs = this.clock.now() - started;
      st.unavailable += 1;
      st.totalLatencyMs += latencyMs;
      this.deps.logger.debug(
        { section: name, key, err: errorMessage(err) },
        "enricher unavailable",
      );
      return unavailable<T>(errorMessage(err), latencyMs);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
