import { mergeCandidates, numberField, type RoutedCandidate } from "../domain/candidate.js";
import type { Route } from "../domain/types.js";
import { type Clock, systemClock } from "../infra/time.js";

export type EnqueueOutcome = "queued" | "merged" | "deduped" | "dropped";

export interface QueueOptions {
  route: Route;
  max: number;
  dedupCooldownMs: number;
  clock?: Clock;
}

export interface QueueStats {
  route: Route;
  depth: number;
  queued: number;
  merged: number;
  deduped: number;
  dropped: number;
  taken: number;
}

/**
 * Bounded per-route queue with dedup by mint and a cooldown after a mint was
 * taken. Migration drops the oldest item when full (stale by definition);
 * Mature drops the lowest pre-score. Workers `take()` and await new items.
 */
export class CandidateQueue {
  private readonly items: RoutedCandidate[] = [];
  private readonly lastTaken = new Map<string, number>();
  private readonly waiters: Array<(item: RoutedCandidate) => void> = [];
  private readonly clock: Clock;
  private readonly stats: QueueStats;
  private closed = false;

  constructor(private readonly opts: QueueOptions) {
    this.clock = opts.clock ?? systemClock;
    this.stats = {
      route: opts.route,
      depth: 0,
      queued: 0,
      merged: 0,
      deduped: 0,
      dropped: 0,
      taken: 0,
    };
  }

  get depth(): number {
    return this.items.length;
  }

  snapshot(): QueueStats {
    return { ...this.stats, depth: this.items.length };
  }

  enqueue(item: RoutedCandidate): EnqueueOutcome {
    const mint = item.candidate.mint;
    const now = this.clock.now();
    const taken = this.lastTaken.get(mint);
    if (taken !== undefined && now - taken < this.opts.dedupCooldownMs) {
      this.stats.deduped += 1;
      return "deduped";
    }
    const existing = this.items.find((i) => i.candidate.mint === mint);
    if (existing) {
      existing.candidate = mergeCandidates(existing.candidate, item.candidate);
      this.stats.merged += 1;
      return "merged";
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      this.stats.queued += 1;
      this.stats.taken += 1;
      this.lastTaken.set(mint, now);
      waiter(item);
      return "queued";
    }
    this.items.push(item);
    this.stats.queued += 1;
    while (this.items.length > this.opts.max) {
      this.evict();
      this.stats.dropped += 1;
    }
    return "queued";
  }

  take(): Promise<RoutedCandidate> {
    const next = this.items.shift();
    if (next) {
      this.stats.taken += 1;
      this.lastTaken.set(next.candidate.mint, this.clock.now());
      return Promise.resolve(next);
    }
    if (this.closed) return new Promise(() => undefined);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.closed = true;
  }

  /** Forget cooldown entries older than the cooldown window (call periodically). */
  prune(): void {
    const now = this.clock.now();
    for (const [mint, t] of this.lastTaken) {
      if (now - t >= this.opts.dedupCooldownMs) this.lastTaken.delete(mint);
    }
  }

  private evict(): void {
    if (this.opts.route === "migration") {
      this.items.shift();
      return;
    }
    let worstIdx = 0;
    let worst = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.items.length; i++) {
      const s = preScore(this.items[i] as RoutedCandidate, this.clock.now());
      if (s < worst) {
        worst = s;
        worstIdx = i;
      }
    }
    this.items.splice(worstIdx, 1);
  }
}

/** Ranking used only to decide what to drop when the Mature queue overflows. */
export function preScore(item: RoutedCandidate, now: number): number {
  const c = item.candidate;
  const ageMin = Math.max(0, (now - item.enqueuedAt) / 60_000);
  const recency = Math.max(0, 10 - ageMin); // 0..10, fades over 10 minutes
  const liquidity = numberField(c.snapshot, "liquidityUsd");
  const liq = liquidity !== null && liquidity > 0 ? Math.min(10, Math.log10(liquidity)) : 0;
  const tags = c.triggerTags.length;
  const kol = c.triggerTags.includes("kol_buy") ? 2 : 0;
  const kolCount = numberField(c.snapshot, "kolCount") ?? 0;
  return recency + liq + tags + kol + kolCount * 2;
}
