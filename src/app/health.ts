import type { Mode } from "../domain/types.js";
import type { BudgetSnapshot } from "../infra/budget.js";
import { pendingMigrations } from "../infra/db/migrate.js";
import { HeartbeatRepo, UsageRepo } from "../infra/db/repos.js";
import { errorMessage } from "../infra/errors.js";
import { type AppContext, buildContext, MIGRATIONS_DIR } from "./context.js";

export interface HealthReport {
  instanceId: string;
  mode: Mode;
  providers: unknown[];
  rpc: unknown[];
  budgets: BudgetSnapshot[];
  db: {
    configured: boolean;
    reachable: boolean;
    pendingMigrations: number;
    lastHeartbeat: { instance: string; ageSec: number } | null;
    error?: string;
  };
  queues: { migration: number; mature: number };
}

/** Provider health, budgets, DB status and heartbeat age (plan 1.6). */
export async function collectHealth(ctx: AppContext): Promise<HealthReport> {
  const p = ctx.providers;
  const db: HealthReport["db"] = {
    configured: ctx.db !== null,
    reachable: false,
    pendingMigrations: 0,
    lastHeartbeat: null,
  };
  if (ctx.db) {
    try {
      await ctx.db.query("SELECT 1");
      db.reachable = true;
      db.pendingMigrations = (await pendingMigrations(ctx.db, MIGRATIONS_DIR)).length;
      if (db.pendingMigrations === 0) {
        ctx.budget.setSink(new UsageRepo(ctx.db));
        await ctx.budget.loadMonthToDate().catch(() => undefined);
        const hb = await new HeartbeatRepo(ctx.db).latest();
        if (hb)
          db.lastHeartbeat = {
            instance: hb.instance_id,
            ageSec: Math.round((Date.now() - new Date(hb.ts).getTime()) / 1000),
          };
      }
    } catch (err) {
      db.error = errorMessage(err);
    }
  }
  return {
    instanceId: ctx.instanceId,
    mode: ctx.config.mode,
    providers: [
      p.dexscreener.health(),
      p.geckoterminal.health(),
      p.rugcheck.health(),
      p.jupiter.health(),
      p.heliusSender.health(),
      p.deepseek.health(),
      { provider: "pumpportal", connected: p.pumpportal.connected, ...p.pumpportal.stats() },
      { provider: "solana-ws", ...p.ws.stats() },
    ],
    rpc: p.rpc.health(),
    budgets: ctx.budget.snapshots(),
    db,
    queues: { migration: 0, mature: 0 },
  };
}

export async function runHealth(opts: { mode?: Mode; configDir?: string }): Promise<HealthReport> {
  const ctx = await buildContext({
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.configDir !== undefined ? { configDir: opts.configDir } : {}),
    withDb: true,
  });
  try {
    return await collectHealth(ctx);
  } finally {
    await ctx.close();
  }
}

export function formatHealth(h: HealthReport): string {
  const lines: string[] = [];
  lines.push(`instance ${h.instanceId}  mode=${h.mode}`);
  lines.push("");
  lines.push("database:");
  if (!h.db.configured) lines.push("  not configured (DATABASE_URL missing)");
  else if (!h.db.reachable) lines.push(`  unreachable: ${h.db.error ?? "unknown error"}`);
  else {
    lines.push(`  reachable; pending migrations: ${h.db.pendingMigrations}`);
    lines.push(
      h.db.lastHeartbeat
        ? `  last heartbeat: ${h.db.lastHeartbeat.instance} ${h.db.lastHeartbeat.ageSec}s ago`
        : "  last heartbeat: none",
    );
  }
  lines.push("");
  lines.push("budgets (month to date):");
  for (const b of h.budgets) {
    const pct = b.fraction !== null ? ` ${(b.fraction * 100).toFixed(1)}%` : "";
    const budget = b.monthlyBudget !== null ? `/${b.monthlyBudget}` : "";
    lines.push(
      `  ${b.provider.padEnd(14)} ${String(b.unitsMonth).padStart(10)}${budget} ${b.unitName}${pct}${b.alarm ? "  ALARM" : ""}  today: ${b.today.calls} calls, ${b.today.errors} errors, ${b.today.rateLimited} rate-limited`,
    );
  }
  lines.push("");
  lines.push("rpc endpoints:");
  for (const g of h.rpc as Array<{
    provider: string;
    keys: Array<{ id: string; healthy: boolean; failures: number; successes: number }>;
  }>) {
    if (g.keys.length === 0) {
      lines.push(`  ${g.provider}: none configured`);
      continue;
    }
    for (const k of g.keys) {
      lines.push(
        `  ${k.id.padEnd(28)} ${k.healthy ? "healthy" : "cooling"}  ok=${k.successes} fail=${k.failures}`,
      );
    }
  }
  lines.push("");
  lines.push(`queues: migration=${h.queues.migration} mature=${h.queues.mature}`);
  return lines.join("\n");
}
