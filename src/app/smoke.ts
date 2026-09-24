import type { Mode } from "../domain/types.js";
import { pendingMigrations } from "../infra/db/migrate.js";
import { errorMessage } from "../infra/errors.js";
import type { SmokeResult } from "../infra/provider-client.js";
import { buildContext, MIGRATIONS_DIR } from "./context.js";

export interface SmokeOptions {
  mode?: Mode;
  configDir?: string;
  withClaudeCall?: boolean;
  json?: boolean;
  timeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_r, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

/**
 * One real call per provider with the configured keys (plan 1.4). Keyless
 * providers always run; keyed ones report `skipped` when no key is set.
 */
export async function runSmoke(
  opts: SmokeOptions = {},
): Promise<{ results: SmokeResult[]; ok: boolean }> {
  const ctx = await buildContext({
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.configDir !== undefined ? { configDir: opts.configDir } : {}),
    withDb: true,
  });
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const p = ctx.providers;
  const guarded = (label: string, fn: () => Promise<SmokeResult | SmokeResult[]>) =>
    withTimeout(fn(), timeoutMs, label).catch(
      (err): SmokeResult => ({ provider: label, ok: false, error: errorMessage(err) }),
    );

  const dbSmoke = async (): Promise<SmokeResult> => {
    if (!ctx.db) return { provider: "postgres", ok: false, skipped: "DATABASE_URL not set" };
    const started = Date.now();
    const v = await ctx.db.query<{ version: string }>("SELECT version()");
    const pending = await pendingMigrations(ctx.db, MIGRATIONS_DIR);
    return {
      provider: "postgres",
      ok: true,
      latencyMs: Date.now() - started,
      detail: `${v.rows[0]?.version.split(",")[0] ?? "?"}; pending migrations: ${pending.length}`,
    };
  };

  try {
    const settled = await Promise.all([
      guarded("dexscreener", () => p.dexscreener.smoke()),
      guarded("geckoterminal", () => p.geckoterminal.smoke()),
      guarded("rugcheck", () => p.rugcheck.smoke()),
      guarded("jupiter", () => p.jupiter.smoke()),
      guarded("helius-sender", () => p.heliusSender.smoke()),
      guarded("pumpportal", () => p.pumpportal.smoke()),
      guarded("solana-rpc", () => p.rpc.smoke()),
      guarded("solana-ws", () => p.ws.smoke()),
      guarded("deepseek", () => p.deepseek.smoke()),
      guarded("claude", () => p.claude.smoke(opts.withClaudeCall ?? false)),
      guarded("postgres", dbSmoke),
    ]);
    const results = settled.flat();
    const ok = results.every((r) => r.ok || r.skipped !== undefined);
    return { results, ok };
  } finally {
    await ctx.close();
  }
}

export function formatSmokeTable(results: SmokeResult[]): string {
  const rows = results.map((r) => ({
    provider: r.provider,
    status: r.ok ? "OK" : r.skipped ? "SKIP" : "FAIL",
    latency: r.latencyMs !== undefined ? `${r.latencyMs}ms` : "-",
    detail: r.ok ? (r.detail ?? "") : (r.skipped ?? r.error ?? ""),
  }));
  const w = (k: keyof (typeof rows)[number]) => Math.max(k.length, ...rows.map((r) => r[k].length));
  const cols: Array<keyof (typeof rows)[number]> = ["provider", "status", "latency", "detail"];
  const line = (r: Record<string, string>) => cols.map((c) => r[c]?.padEnd(w(c))).join("  ");
  const header = line({
    provider: "provider",
    status: "status",
    latency: "latency",
    detail: "detail",
  });
  return [header, "-".repeat(header.length), ...rows.map((r) => line(r))].join("\n");
}
