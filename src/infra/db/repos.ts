import type { Candidate, CandidateRoute, Mode, Route } from "../../domain/types.js";
import type { UsageRow, UsageSink } from "../budget.js";
import type { DbClient } from "./client.js";

/** `api_usage` as the BudgetTracker sink. */
export class UsageRepo implements UsageSink {
  constructor(private readonly db: DbClient) {}

  async flush(rows: UsageRow[]): Promise<void> {
    for (const r of rows) {
      await this.db.query(
        `INSERT INTO api_usage (provider, usage_date, calls, errors, rate_limited, units, unit_name, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (provider, usage_date) DO UPDATE SET
           calls = api_usage.calls + EXCLUDED.calls,
           errors = api_usage.errors + EXCLUDED.errors,
           rate_limited = api_usage.rate_limited + EXCLUDED.rate_limited,
           units = api_usage.units + EXCLUDED.units,
           unit_name = EXCLUDED.unit_name,
           updated_at = now()`,
        [r.provider, r.usageDate, r.calls, r.errors, r.rateLimited, r.units, r.unitName],
      );
    }
  }

  async monthToDate(provider: string, monthStart: Date): Promise<number> {
    const res = await this.db.query<{ units: string | number | null }>(
      "SELECT COALESCE(SUM(units), 0) AS units FROM api_usage WHERE provider = $1 AND usage_date >= $2",
      [provider, monthStart.toISOString().slice(0, 10)],
    );
    return Number(res.rows[0]?.units ?? 0);
  }

  async byDay(
    days: number,
  ): Promise<
    Array<{ provider: string; usage_date: string; calls: number; errors: number; units: number }>
  > {
    const res = await this.db.query<{
      provider: string;
      usage_date: string;
      calls: string;
      errors: string;
      units: string;
    }>(
      `SELECT provider, usage_date::text, calls, errors, units FROM api_usage
       WHERE usage_date >= (CURRENT_DATE - ($1::int - 1)) ORDER BY usage_date DESC, provider`,
      [days],
    );
    return res.rows.map((r) => ({
      provider: r.provider,
      usage_date: r.usage_date,
      calls: Number(r.calls),
      errors: Number(r.errors),
      units: Number(r.units),
    }));
  }
}

export class HeartbeatRepo {
  constructor(private readonly db: DbClient) {}

  async beat(instanceId: string, mode: Mode, details: Record<string, unknown>): Promise<void> {
    await this.db.query("INSERT INTO heartbeats (instance_id, mode, details) VALUES ($1, $2, $3)", [
      instanceId,
      mode,
      JSON.stringify(details),
    ]);
  }

  async latest(): Promise<{ instance_id: string; mode: string; ts: Date } | null> {
    const res = await this.db.query<{ instance_id: string; mode: string; ts: Date }>(
      "SELECT instance_id, mode, ts FROM heartbeats ORDER BY ts DESC LIMIT 1",
    );
    return res.rows[0] ?? null;
  }

  async prune(olderThanDays: number): Promise<number> {
    const res = await this.db.query(
      "DELETE FROM heartbeats WHERE ts < now() - ($1::int * interval '1 day')",
      [olderThanDays],
    );
    return res.rowCount;
  }
}

export class ConfigVersionRepo {
  constructor(private readonly db: DbClient) {}

  /** Records the config when its hash differs from the latest stored one. Returns the row id or null. */
  async recordIfChanged(
    mode: Mode,
    hash: string,
    config: unknown,
    note?: string,
  ): Promise<number | null> {
    const latest = await this.db.query<{ config_hash: string }>(
      "SELECT config_hash FROM config_versions ORDER BY id DESC LIMIT 1",
    );
    if (latest.rows[0]?.config_hash === hash) return null;
    const res = await this.db.query<{ id: number }>(
      "INSERT INTO config_versions (mode, config_hash, config, note) VALUES ($1, $2, $3, $4) RETURNING id",
      [mode, hash, JSON.stringify(config), note ?? null],
    );
    return res.rows[0]?.id ?? null;
  }
}

export class CandidateRepo {
  constructor(private readonly db: DbClient) {}

  async insert(
    candidate: Candidate,
    route: CandidateRoute,
    routingReason: string | null,
  ): Promise<number> {
    const res = await this.db.query<{ id: number }>(
      `INSERT INTO candidates
         (mint, pool_address, dex_id, launchpad, quote_mint, route, source, trigger_tags, pool_created_at, first_seen_at, snapshot, routing_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        candidate.mint,
        candidate.poolAddress,
        candidate.dexId,
        candidate.launchpad,
        candidate.quoteMint,
        route,
        candidate.source,
        candidate.triggerTags,
        candidate.poolCreatedAt,
        candidate.firstSeenAt,
        JSON.stringify(candidate.snapshot),
        routingReason,
      ],
    );
    const id = res.rows[0]?.id;
    if (id === undefined) throw new Error("candidate insert returned no id");
    return Number(id);
  }

  async recordFilterDecision(
    candidateId: number,
    route: Route,
    passed: boolean,
    failedRule: string | null,
    features: Record<string, unknown>,
    thresholds: Record<string, unknown>,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO filter_decisions (candidate_id, route, passed, failed_rule, features, thresholds)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        candidateId,
        route,
        passed,
        failedRule,
        JSON.stringify(features),
        JSON.stringify(thresholds),
      ],
    );
  }

  async recordEnrichment(
    candidateId: number,
    mint: string,
    document: Record<string, unknown>,
    unavailable: string[],
    latenciesMs: Record<string, number>,
  ): Promise<number> {
    const res = await this.db.query<{ id: number }>(
      `INSERT INTO enrichments (candidate_id, mint, document, unavailable, latencies_ms)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [candidateId, mint, JSON.stringify(document), unavailable, JSON.stringify(latenciesMs)],
    );
    return Number(res.rows[0]?.id);
  }

  async countByRoute(sinceHours: number): Promise<Array<{ route: string; n: number }>> {
    const res = await this.db.query<{ route: string; n: string }>(
      `SELECT route, COUNT(*) AS n FROM candidates
       WHERE first_seen_at >= now() - ($1::int * interval '1 hour') GROUP BY route ORDER BY route`,
      [sinceHours],
    );
    return res.rows.map((r) => ({ route: r.route, n: Number(r.n) }));
  }
}

export interface AiCallRecord {
  candidateId: number | null;
  route: Route;
  provider: "claude" | "deepseek";
  model: string;
  purpose: "score" | "recheck" | "review" | "benchmark";
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  ok: boolean;
  error: string | null;
  fallbackReason: string | null;
  inputHash: string | null;
}

export class AiRepo {
  constructor(private readonly db: DbClient) {}

  async recordCall(r: AiCallRecord): Promise<number> {
    const res = await this.db.query<{ id: number }>(
      `INSERT INTO ai_calls
         (candidate_id, route, provider, model, purpose, latency_ms, input_tokens, output_tokens, ok, error, fallback_reason, input_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        r.candidateId,
        r.route,
        r.provider,
        r.model,
        r.purpose,
        r.latencyMs,
        r.inputTokens,
        r.outputTokens,
        r.ok,
        r.error,
        r.fallbackReason,
        r.inputHash,
      ],
    );
    return Number(res.rows[0]?.id);
  }

  async recordDecision(d: {
    candidateId: number;
    aiCallId: number | null;
    route: Route;
    verdict: "buy" | "veto";
    pWin: number | null;
    confidence: number | null;
    threshold: number;
    gatedBuy: boolean;
    output: unknown;
    inputHash: string | null;
  }): Promise<number> {
    const res = await this.db.query<{ id: number }>(
      `INSERT INTO ai_decisions
         (candidate_id, ai_call_id, route, verdict, p_win, confidence, threshold, gated_buy, output, input_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        d.candidateId,
        d.aiCallId,
        d.route,
        d.verdict,
        d.pWin,
        d.confidence,
        d.threshold,
        d.gatedBuy,
        JSON.stringify(d.output),
        d.inputHash,
      ],
    );
    return Number(res.rows[0]?.id);
  }
}

export class PositionRepo {
  constructor(private readonly db: DbClient) {}

  async open(p: {
    candidateId: number | null;
    aiDecisionId: number | null;
    route: Route;
    mint: string;
    poolAddress: string | null;
    mode: Mode;
    sizeSol: number;
    entryPrice: number;
    reentryIndex: number;
  }): Promise<number> {
    const res = await this.db.query<{ id: number }>(
      `INSERT INTO positions
         (candidate_id, ai_decision_id, route, mint, pool_address, mode, status, size_sol, entry_price, entry_at, peak_price, reentry_index)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, now(), $8, $9) RETURNING id`,
      [
        p.candidateId,
        p.aiDecisionId,
        p.route,
        p.mint,
        p.poolAddress,
        p.mode,
        p.sizeSol,
        p.entryPrice,
        p.reentryIndex,
      ],
    );
    return Number(res.rows[0]?.id);
  }

  async close(
    id: number,
    c: {
      exitPrice: number;
      exitReason: string;
      realizedPnlSol: number;
      feesSol: number;
      holdSeconds: number;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE positions SET status = 'closed', exit_price = $2, exit_at = now(), exit_reason = $3,
         realized_pnl_sol = $4, fees_sol = $5, hold_seconds = $6, updated_at = now() WHERE id = $1`,
      [id, c.exitPrice, c.exitReason, c.realizedPnlSol, c.feesSol, c.holdSeconds],
    );
  }

  async openPositions(): Promise<
    Array<{ id: number; route: Route; mint: string; size_sol: string }>
  > {
    const res = await this.db.query<{ id: number; route: Route; mint: string; size_sol: string }>(
      "SELECT id, route, mint, size_sol FROM positions WHERE status IN ('open', 'closing') ORDER BY id",
    );
    return res.rows;
  }

  async recordOutcome(o: {
    positionId: number;
    aiDecisionId: number | null;
    route: Route;
    win: boolean;
    realizedPnlSol: number;
    pnlPct: number;
    peakMultiple: number | null;
    holdSeconds: number | null;
    exitReason: string | null;
    features: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO outcomes
         (position_id, ai_decision_id, route, win, realized_pnl_sol, pnl_pct, peak_multiple, hold_seconds, exit_reason, features)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (position_id) DO NOTHING`,
      [
        o.positionId,
        o.aiDecisionId,
        o.route,
        o.win,
        o.realizedPnlSol,
        o.pnlPct,
        o.peakMultiple,
        o.holdSeconds,
        o.exitReason,
        JSON.stringify(o.features),
      ],
    );
  }
}
