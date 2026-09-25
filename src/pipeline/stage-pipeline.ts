import type { AppConfig } from "../config/schema.js";
import type { RoutedCandidate } from "../domain/candidate.js";
import type { Enricher, EnricherStats } from "../enrich/enricher.js";
import type { EnrichmentDocument } from "../enrich/types.js";
import { type CandidateFeatures, extractFeatures } from "../filter/features.js";
import type { FilterStats, HardFilter } from "../filter/hard-filter.js";
import type { CandidateRepo } from "../infra/db/repos.js";
import { errorMessage } from "../infra/errors.js";
import type { Logger } from "../infra/logger.js";
import { type Clock, systemClock } from "../infra/time.js";
import type { StagePipeline, StageResult } from "../scanner/workers.js";

export interface PipelineStats {
  filter: FilterStats;
  enricher: EnricherStats;
  stages: Record<string, number>;
  /** Milliseconds from pickup to final stage, moving average of the last 100. */
  avgTotalMs: number;
  p95TotalMs: number;
}

/** What later stages (AI, risk) receive for a candidate that survived the hard filter. */
export interface EnrichedCandidate {
  item: RoutedCandidate;
  features: CandidateFeatures;
  document: EnrichmentDocument;
  enrichmentId: number;
}

export type NextStage = (input: EnrichedCandidate) => Promise<StageResult>;

/**
 * Per-token stage order (design section 4): hard filter (pre) -> enrichers
 * -> hard filter (post, with the security section) -> next stage. Every
 * decision is persisted with its inputs.
 */
export class FilterEnrichPipeline implements StagePipeline {
  private readonly log: Logger;
  private readonly clock: Clock;
  private readonly stages: Record<string, number> = {};
  private readonly totals: number[] = [];

  constructor(
    private readonly filterCfg: AppConfig["filter"],
    private readonly hardFilter: HardFilter,
    private readonly enricher: Enricher,
    private readonly candidates: CandidateRepo,
    private readonly next: NextStage,
    logger: Logger,
    clock: Clock = systemClock,
  ) {
    this.log = logger.child({ component: "pipeline" });
    this.clock = clock;
  }

  snapshot(): PipelineStats {
    const sorted = [...this.totals].sort((a, b) => a - b);
    const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    const p95 = sorted.length
      ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] as number)
      : 0;
    return {
      filter: this.hardFilter.snapshot(),
      enricher: this.enricher.snapshot(),
      stages: { ...this.stages },
      avgTotalMs: Math.round(avg),
      p95TotalMs: Math.round(p95),
    };
  }

  async process(item: RoutedCandidate): Promise<StageResult> {
    const started = this.clock.now();
    const { candidate, route } = item;
    const thresholds = this.hardFilter.thresholds(route);
    try {
      const features = extractFeatures(candidate, route, this.clock.now(), this.filterCfg.signals);

      const pre = this.hardFilter.evaluate("pre", route, features, null);
      if (!pre.passed) {
        await this.persistDecision(item, features, false, pre.failedRule, pre.outcomes, thresholds);
        return this.finish(started, "rejected", "hard_filter_pre", pre.failedRule ?? "unknown");
      }

      const document = await this.enricher.enrich(candidate, route, features);
      // Flow section fills in the buyer counts that DexScreener does not expose.
      if (document.sections.flow.data && features.buyersM5 === null) {
        features.buyersM5 = document.sections.flow.data.buyersM5;
        features.sellersM5 = document.sections.flow.data.sellersM5;
      }
      const enrichmentId = await this.candidates.recordEnrichment(
        item.candidateId ?? 0,
        candidate.mint,
        document as unknown as Record<string, unknown>,
        document.unavailable,
        document.latenciesMs,
      );

      const post = this.hardFilter.evaluate(
        "post",
        route,
        features,
        document.sections.security.data,
      );
      await this.persistDecision(
        item,
        features,
        post.passed,
        post.failedRule,
        [...pre.outcomes, ...post.outcomes],
        thresholds,
      );
      if (!post.passed) {
        return this.finish(started, "rejected", "hard_filter_post", post.failedRule ?? "unknown");
      }

      const result = await this.next({ item, features, document, enrichmentId });
      return this.finish(started, result.outcome, result.stage, result.reason ?? "");
    } catch (err) {
      this.log.error(
        { mint: candidate.mint, route, err: errorMessage(err) },
        "pipeline stage failed",
      );
      return this.finish(started, "error", "pipeline", errorMessage(err));
    }
  }

  private async persistDecision(
    item: RoutedCandidate,
    features: CandidateFeatures,
    passed: boolean,
    failedRule: string | null,
    outcomes: unknown[],
    thresholds: Record<string, unknown>,
  ): Promise<void> {
    if (item.candidateId === null) return;
    await this.candidates.recordFilterDecision(
      item.candidateId,
      item.route,
      passed,
      failedRule,
      { ...features, outcomes } as unknown as Record<string, unknown>,
      thresholds,
    );
  }

  private finish(
    started: number,
    outcome: StageResult["outcome"],
    stage: string,
    reason: string,
  ): StageResult {
    const key = `${stage}:${outcome}${outcome === "rejected" ? `:${reason}` : ""}`;
    this.stages[key] = (this.stages[key] ?? 0) + 1;
    this.totals.push(this.clock.now() - started);
    if (this.totals.length > 100) this.totals.shift();
    return { outcome, stage, reason };
  }
}

/** Placeholder for the AI stage (phase 4): accepts everything and says so. */
export const awaitingAiStage: NextStage = async () => ({
  outcome: "accepted",
  stage: "filter_enrich",
  reason: "awaiting AI stage (phase 4)",
});
