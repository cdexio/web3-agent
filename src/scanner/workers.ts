import type { RoutedCandidate } from "../domain/candidate.js";
import type { Route } from "../domain/types.js";
import { errorMessage } from "../infra/errors.js";
import type { Logger } from "../infra/logger.js";
import type { CandidateQueue } from "./queue.js";

export type StageOutcome = "accepted" | "rejected" | "error";

export interface StageResult {
  outcome: StageOutcome;
  stage: string;
  reason?: string;
}

/** The per-token pipeline (hard filter -> enrich -> AI -> risk -> execute), attached in later phases. */
export interface StagePipeline {
  process(item: RoutedCandidate): Promise<StageResult>;
}

/** Phase 2 placeholder: every candidate is accepted and logged. */
export class LoggingPipeline implements StagePipeline {
  constructor(private readonly logger: Logger) {}

  async process(item: RoutedCandidate): Promise<StageResult> {
    this.logger.info(
      {
        route: item.route,
        mint: item.candidate.mint,
        dex: item.candidate.dexId,
        tags: item.candidate.triggerTags,
        source: item.candidate.source,
        candidateId: item.candidateId,
      },
      "candidate accepted (stages not attached yet)",
    );
    return { outcome: "accepted", stage: "placeholder" };
  }
}

export interface WorkerStats {
  route: Route;
  workers: number;
  busy: number;
  processed: number;
  accepted: number;
  rejected: number;
  errors: number;
  /** Milliseconds from enqueue to pickup, moving average of the last 100. */
  avgWaitMs: number;
  avgProcessMs: number;
}

/**
 * N workers per route pull one candidate at a time and run the stage
 * pipeline strictly in order for that candidate (design section 4).
 */
export class WorkerPool {
  private readonly stats: WorkerStats;
  private readonly waits: number[] = [];
  private readonly durations: number[] = [];
  private running = false;
  private readonly loops: Promise<void>[] = [];

  constructor(
    private readonly route: Route,
    private readonly size: number,
    private readonly queue: CandidateQueue,
    private readonly pipeline: StagePipeline,
    private readonly logger: Logger,
  ) {
    this.stats = {
      route,
      workers: size,
      busy: 0,
      processed: 0,
      accepted: 0,
      rejected: 0,
      errors: 0,
      avgWaitMs: 0,
      avgProcessMs: 0,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (let i = 0; i < this.size; i++) this.loops.push(this.loop(i));
  }

  async stop(): Promise<void> {
    this.running = false;
    this.queue.close();
  }

  snapshot(): WorkerStats {
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    return {
      ...this.stats,
      avgWaitMs: Math.round(avg(this.waits)),
      avgProcessMs: Math.round(avg(this.durations)),
    };
  }

  private async loop(index: number): Promise<void> {
    const log = this.logger.child({ component: `worker:${this.route}:${index}` });
    while (this.running) {
      const item = await this.queue.take();
      if (!this.running) return;
      const started = Date.now();
      this.push(this.waits, started - item.enqueuedAt);
      this.stats.busy += 1;
      try {
        const result = await this.pipeline.process(item);
        this.stats.processed += 1;
        if (result.outcome === "accepted") this.stats.accepted += 1;
        else if (result.outcome === "rejected") this.stats.rejected += 1;
        else this.stats.errors += 1;
      } catch (err) {
        this.stats.processed += 1;
        this.stats.errors += 1;
        log.error({ mint: item.candidate.mint, err: errorMessage(err) }, "pipeline threw");
      } finally {
        this.stats.busy -= 1;
        this.push(this.durations, Date.now() - started);
      }
    }
  }

  private push(arr: number[], v: number): void {
    arr.push(v);
    if (arr.length > 100) arr.shift();
  }
}
