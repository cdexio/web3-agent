import { ConfigError, configHash } from "../config/load.js";
import { assertSecretsForMode } from "../config/secrets.js";
import type { Mode } from "../domain/types.js";
import { pendingMigrations, runMigrations } from "../infra/db/migrate.js";
import { ConfigVersionRepo, HeartbeatRepo, UsageRepo } from "../infra/db/repos.js";
import { errorMessage } from "../infra/errors.js";
import { buildContext, MIGRATIONS_DIR } from "./context.js";
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
    log.info(
      { mode: ctx.config.mode, instance: ctx.instanceId },
      "engine started (phase 1: infrastructure only)",
    );

    const beat = async () => {
      try {
        const health = await collectHealth(ctx);
        await heartbeats.beat(ctx.instanceId, ctx.config.mode, {
          budgets: health.budgets.map((b) => ({ p: b.provider, m: b.unitsMonth, f: b.fraction })),
          ws: ctx.providers.ws.stats(),
          queues: health.queues,
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
    await flush();
  } finally {
    await ctx.close();
  }
}
