import path from "node:path";
import type { AppContext } from "../app/context.js";
import { PROJECT_ROOT } from "../app/context.js";
import type { RoutedCandidate } from "../domain/candidate.js";
import { createDexClassifier } from "../domain/dex.js";
import type { Candidate, Route } from "../domain/types.js";
import { CandidateRepo } from "../infra/db/repos.js";
import { KolRepo, LaunchRepo } from "../infra/db/scanner-repos.js";
import { errorMessage } from "../infra/errors.js";
import type { Logger } from "../infra/logger.js";
import { loadKolWallets } from "./kol-wallets.js";
import { ScannerMetrics } from "./metrics.js";
import type { LaunchSeen } from "./normalizers/pumpportal.js";
import { PoolResolver } from "./pool-resolver.js";
import { CandidateQueue } from "./queue.js";
import { Router } from "./router.js";
import { KolWatcher } from "./sources/kol-watcher.js";
import { MigrationWatcher } from "./sources/migration-watcher.js";
import {
  DexScreenerListsSource,
  GeckoNewPoolsSource,
  GeckoTrendingSource,
  RugCheckStatsSource,
  type SourceSink,
} from "./sources/poll-sources.js";
import { PumpPortalSource } from "./sources/pumpportal-source.js";
import { LoggingPipeline, type StagePipeline, WorkerPool } from "./workers.js";

export interface ScannerStats {
  queues: { migration: number; mature: number };
  queueStats: Record<Route, ReturnType<CandidateQueue["snapshot"]>>;
  workers: Record<Route, ReturnType<WorkerPool["snapshot"]>>;
  warming: number;
  resolving: number;
  unresolved: number;
  metrics: ReturnType<ScannerMetrics["snapshot"]>;
  migrationWatcher: ReturnType<MigrationWatcher["stats"]> | null;
  kol: ReturnType<KolWatcher["stats"]> | null;
}

/**
 * Wires every source into the normalised candidate stream, routes it, and
 * feeds the per-route queues and worker pools (plan Phase 2).
 */
export class Scanner {
  private readonly log: Logger;
  private readonly metrics = new ScannerMetrics();
  private readonly router: Router;
  private readonly resolver: PoolResolver;
  private readonly queues: Record<Route, CandidateQueue>;
  private readonly workers: Record<Route, WorkerPool>;
  private readonly candidates: CandidateRepo;
  private readonly launches: LaunchRepo;
  private readonly kolRepo: KolRepo;
  private readonly pollers: Array<{ start(): void; stop(): void }> = [];
  private migrationWatcher: MigrationWatcher | null = null;
  private kolWatcher: KolWatcher | null = null;
  private pumpportal: PumpPortalSource | null = null;
  private warmingTimer: NodeJS.Timeout | null = null;
  private readonly resolving = new Set<string>();
  private unresolved = 0;

  constructor(
    private readonly ctx: AppContext,
    pipelines?: Partial<Record<Route, StagePipeline>>,
  ) {
    const { config, logger } = ctx;
    if (!ctx.db) throw new Error("scanner requires a database");
    this.log = logger.child({ component: "scanner" });
    const classifier = createDexClassifier(
      config.scanner.bondingCurveDexIds,
      config.scanner.ammLaunchpadByDexId,
    );
    this.router = new Router({
      migrationMaxPoolAgeSec: config.routes.migration.maxPoolAgeSec,
      matureMinPoolAgeSec: config.routes.mature.minPoolAgeSec,
      signalsBypassWarming: config.routes.warming.signalsBypassWarming,
      warmingMaxSize: config.routes.warming.maxSize,
      warmingExpireSec: config.routes.warming.expireSec,
      classifier,
    });
    this.resolver = new PoolResolver(
      ctx.providers.dexscreener,
      classifier,
      {
        retries: config.scanner.poolResolve.retries,
        retryDelayMs: config.scanner.poolResolve.retryDelaySec * 1000,
      },
      logger,
    );
    this.queues = {
      migration: new CandidateQueue({
        route: "migration",
        max: config.routes.migration.queueMax,
        dedupCooldownMs: config.routes.migration.dedupCooldownSec * 1000,
      }),
      mature: new CandidateQueue({
        route: "mature",
        max: config.routes.mature.queueMax,
        dedupCooldownMs: config.routes.mature.dedupCooldownSec * 1000,
      }),
    };
    const fallback = new LoggingPipeline(logger);
    this.workers = {
      migration: new WorkerPool(
        "migration",
        config.routes.workersPerRoute,
        this.queues.migration,
        pipelines?.migration ?? fallback,
        logger,
      ),
      mature: new WorkerPool(
        "mature",
        config.routes.workersPerRoute,
        this.queues.mature,
        pipelines?.mature ?? fallback,
        logger,
      ),
    };
    this.candidates = new CandidateRepo(ctx.db);
    this.launches = new LaunchRepo(ctx.db);
    this.kolRepo = new KolRepo(ctx.db);

    const sink: SourceSink = {
      candidate: (c) => void this.ingest(c),
      launch: (l) => void this.recordLaunch(l),
    };
    const p = ctx.providers;
    this.pollers.push(
      new GeckoNewPoolsSource(
        p.geckoterminal,
        config.scanner.geckoNewPools,
        classifier,
        sink,
        this.metrics,
        logger,
      ),
      new GeckoTrendingSource(
        p.geckoterminal,
        config.scanner.geckoTrending,
        classifier,
        sink,
        this.metrics,
        logger,
      ),
      new DexScreenerListsSource(
        p.dexscreener,
        config.scanner.dexscreenerLists,
        sink,
        this.metrics,
        logger,
      ),
      new RugCheckStatsSource(p.rugcheck, config.scanner.rugcheckStats, sink, this.metrics, logger),
    );
    if (config.scanner.migrationWatcher.enabled) {
      this.migrationWatcher = new MigrationWatcher(
        p.ws,
        p.rpc,
        config.scanner.migrationWatcher,
        sink,
        this.metrics,
        logger,
      );
    }
    if (config.scanner.pumpportal.enabled) {
      this.pumpportal = new PumpPortalSource(p.pumpportal, sink, this.metrics, logger);
    }
    if (config.scanner.kol.enabled) {
      const file = path.isAbsolute(config.kol.walletsFile)
        ? config.kol.walletsFile
        : path.join(PROJECT_ROOT, config.kol.walletsFile);
      const wallets = loadKolWallets(file, config.scanner.kol.maxWallets);
      this.kolWatcher = new KolWatcher(
        p.ws,
        p.rpc,
        this.kolRepo,
        wallets,
        config.scanner.kol,
        sink,
        this.metrics,
        logger,
      );
    }
  }

  async start(): Promise<void> {
    this.workers.migration.start();
    this.workers.mature.start();
    for (const poller of this.pollers) poller.start();
    this.pumpportal?.start();
    await this.migrationWatcher?.start();
    await this.kolWatcher?.start();
    this.warmingTimer = setInterval(
      () => this.recheckWarming(),
      this.ctx.config.routes.warming.recheckIntervalSec * 1000,
    );
    this.warmingTimer.unref?.();
    this.log.info(
      {
        pollers: this.pollers.length,
        migrationWatcher: !!this.migrationWatcher,
        kol: this.kolWatcher?.stats() ?? null,
      },
      "scanner started",
    );
  }

  async stop(): Promise<void> {
    if (this.warmingTimer) clearInterval(this.warmingTimer);
    for (const poller of this.pollers) poller.stop();
    this.pumpportal?.stop();
    await this.migrationWatcher?.stop();
    await this.kolWatcher?.stop();
    await this.workers.migration.stop();
    await this.workers.mature.stop();
  }

  stats(): ScannerStats {
    return {
      queues: { migration: this.queues.migration.depth, mature: this.queues.mature.depth },
      queueStats: {
        migration: this.queues.migration.snapshot(),
        mature: this.queues.mature.snapshot(),
      },
      workers: {
        migration: this.workers.migration.snapshot(),
        mature: this.workers.mature.snapshot(),
      },
      warming: this.router.warmingSize,
      resolving: this.resolving.size,
      unresolved: this.unresolved,
      metrics: this.metrics.snapshot(),
      migrationWatcher: this.migrationWatcher?.stats() ?? null,
      kol: this.kolWatcher?.stats() ?? null,
    };
  }

  /** Entry point for every normalised candidate, from any source. */
  async ingest(candidate: Candidate): Promise<void> {
    try {
      const decision = this.router.decide(candidate);
      this.metrics.routed(decision.route);
      switch (decision.route) {
        case "launch":
          await this.recordLaunch({
            mint: candidate.mint,
            creator: null,
            launchpad: candidate.dexId,
            name: typeof candidate.snapshot.name === "string" ? candidate.snapshot.name : null,
            symbol: null,
            payload: { poolAddress: candidate.poolAddress },
          });
          return;
        case "unresolved":
          void this.resolveAndReingest(candidate);
          return;
        case "warming":
          this.router.warm(candidate);
          await this.candidates.insert(candidate, "warming", decision.reason);
          return;
        case "rejected":
          this.log.debug(
            { mint: candidate.mint, reason: decision.reason },
            "candidate rejected at routing",
          );
          return;
        case "migration":
        case "mature": {
          const route = decision.route;
          const candidateId = await this.candidates.insert(candidate, route, decision.reason);
          const item: RoutedCandidate = {
            candidate,
            route,
            reason: decision.reason,
            candidateId,
            enqueuedAt: Date.now(),
          };
          const outcome = this.queues[route].enqueue(item);
          this.log.info(
            {
              route,
              mint: candidate.mint,
              dex: candidate.dexId,
              tags: candidate.triggerTags,
              source: candidate.source,
              outcome,
            },
            "candidate routed",
          );
          return;
        }
      }
    } catch (err) {
      this.log.error({ mint: candidate.mint, err: errorMessage(err) }, "ingest failed");
    }
  }

  private async resolveAndReingest(candidate: Candidate): Promise<void> {
    if (this.resolving.has(candidate.mint)) return;
    this.resolving.add(candidate.mint);
    try {
      const resolved = await this.resolver.resolve(candidate);
      if (!resolved) {
        this.unresolved += 1;
        this.log.debug({ mint: candidate.mint, tags: candidate.triggerTags }, "pool not found");
        return;
      }
      await this.ingest(resolved);
    } finally {
      this.resolving.delete(candidate.mint);
    }
  }

  private recheckWarming(): void {
    const { ready, expired } = this.router.drainWarming();
    if (expired > 0) this.log.debug({ expired }, "warming candidates expired");
    for (const c of ready) void this.ingest({ ...c, firstSeenAt: new Date() });
  }

  private async recordLaunch(l: LaunchSeen): Promise<void> {
    try {
      await this.launches.upsert(l);
    } catch (err) {
      this.log.warn({ mint: l.mint, err: errorMessage(err) }, "launch upsert failed");
    }
  }
}
