import path from "node:path";
import { ConfigError, configHash } from "../config/load.js";
import { assertSecretsForMode } from "../config/secrets.js";
import type { Mode } from "../domain/types.js";
import { Enricher } from "../enrich/enricher.js";
import { HardFilter, loadCreatorBlacklist } from "../filter/hard-filter.js";
import { pendingMigrations, runMigrations } from "../infra/db/migrate.js";
import { CandidateRepo, ConfigVersionRepo, HeartbeatRepo, UsageRepo } from "../infra/db/repos.js";
import { errorMessage } from "../infra/errors.js";
import { awaitingAiStage, FilterEnrichPipeline } from "../pipeline/stage-pipeline.js";
import { Scanner } from "../scanner/scanner.js";
import { buildContext, MIGRATIONS_DIR, PROJECT_ROOT } from "./context.js";
import { collectHealth } from "./health.js";

export interface StartOptions {
  mode?: Mode;
  configDir?: string;
  pretty?: boolean;
  /** Apply pending migrations at boot instead of refusing to start. */
  migrate?: boolean;
}

/**
 * Phase 1 boot: validate secrets for the mode, connect to Postgres, require
 * an up-to-date schema, load month-to-date budgets, record the config
 * version, then run heartbeat and budget-flush loops until SIGINT/SIGTERM.
 * Scanners and trading stages are attached in later phases.
 */
export async function start(opts: StartOptions = {}): Promise<void> {
  const ctx = await buildContext({
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.configDir !== undefined ? { configDir: opts.configDir } : {}),
    pretty: opts.pretty ?? false,
    withDb: true,
  });
  const log = ctx.logger.child({ component: "app" });
  try {
    assertSecretsForMode(ctx.secrets, ctx.config.mode);
    if (!ctx.db) throw new ConfigError("DATABASE_URL is required to start");

    const pending = await pendingMigrations(ctx.db, MIGRATIONS_DIR);
    if (pending.length > 0) {
      if (!opts.migrate) {
        throw new ConfigError(
          `${pending.length} pending migration(s): ${pending.map((m) => m.file).join(", ")}. Run \`pnpm migrate\` or start with --migrate.`,
        );
      }
      await runMigrations(ctx.db, MIGRATIONS_DIR, log);
    }

    const usage = new UsageRepo(ctx.db);
    const heartbeats = new HeartbeatRepo(ctx.db);
    const configVersions = new ConfigVersionRepo(ctx.db);
    ctx.budget.setSink(usage);
    await ctx.budget.loadMonthToDate();
    const versionId = await configVersions.recordIfChanged(
      ctx.config.mode,
      configHash(ctx.config),
      ctx.config,
      "boot",
    );
    if (versionId !== null) log.info({ versionId }, "config version recorded");

    if (ctx.config.mode === "live") {
      log.warn("LIVE MODE: real transactions will be sent once execution is attached (Phase 5/9)");
    }
    const blacklistFile = path.isAbsolute(ctx.config.filter.creatorBlacklistFile)
      ? ctx.config.filter.creatorBlacklistFile
      : path.join(PROJECT_ROOT, ctx.config.filter.creatorBlacklistFile);
    const hardFilter = new HardFilter(ctx.config.filter, loadCreatorBlacklist(blacklistFile));
    const enricher = new Enricher(ctx.config.enrich, ctx.config.scanner.kol, {
      rugcheck: ctx.providers.rugcheck,
      dexscreener: ctx.providers.dexscreener,
      geckoterminal: ctx.providers.geckoterminal,
      rpc: ctx.providers.rpc,
      db: ctx.db,
      logger: ctx.logger,
    });
    const pipeline = new FilterEnrichPipeline(
      ctx.config.filter,
      hardFilter,
      enricher,
      new CandidateRepo(ctx.db),
      awaitingAiStage,
      ctx.logger,
    );
    const scanner =
      ctx.config.mode === "backtest"
        ? null
        : new Scanner(ctx, { migration: pipeline, mature: pipeline });
    if (scanner) await scanner.start();
    log.info(
      { mode: ctx.config.mode, instance: ctx.instanceId, scanner: scanner !== null },
      "engine started (phase 3: scanners, hard filter and enrichers; AI/risk/execution not attached)",
    );

    const beat = async () => {
      try {
        const stats = scanner?.stats();
        const health = await collectHealth(ctx, stats ? { queues: stats.queues } : undefined);
        await heartbeats.beat(ctx.instanceId, ctx.config.mode, {
          budgets: health.budgets.map((b) => ({ p: b.provider, m: b.unitsMonth, f: b.fraction })),
          pipeline: pipeline.snapshot(),
          ws: ctx.providers.ws.stats(),
          queues: health.queues,
          scanner: stats
            ? {
                queueStats: stats.queueStats,
                workers: stats.workers,
                warming: stats.warming,
                resolving: stats.resolving,
                unresolved: stats.unresolved,
                sources: stats.metrics.sources,
                routes: stats.metrics.routes,
                migrationWatcher: stats.migrationWatcher,
                kol: stats.kol,
              }
            : null,
        });
      } catch (err) {
        log.warn({ err: errorMessage(err) }, "heartbeat failed");
      }
    };
    const flush = async () => {
      try {
        await ctx.budget.flush();
      } catch (err) {
        log.warn({ err: errorMessage(err) }, "budget flush failed");
      }
    };
    await beat();
    const beatTimer = setInterval(beat, ctx.config.db.heartbeatIntervalSec * 1000);
    const flushTimer = setInterval(flush, 30_000);

    await new Promise<void>((resolve) => {
      const stop = (signal: string) => {
        log.info({ signal }, "shutting down");
        clearInterval(beatTimer);
        clearInterval(flushTimer);
        resolve();
      };
      process.once("SIGINT", () => stop("SIGINT"));
      process.once("SIGTERM", () => stop("SIGTERM"));
    });
    if (scanner) {
      await scanner.stop();
      const s = scanner.stats();
      log.info(
        { routes: s.metrics.routes, sources: s.metrics.sources, workers: s.workers },
        "scanner stopped",
      );
      log.info(pipeline.snapshot(), "pipeline stopped");
    }
    await beat();
    await flush();
  } finally {
    await ctx.close();
  }
}
