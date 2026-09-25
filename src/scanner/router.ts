import { hasMatureSignal, mergeCandidates, poolAgeSec } from "../domain/candidate.js";
import type { DexClassifier } from "../domain/dex.js";
import type { Candidate, CandidateRoute } from "../domain/types.js";
import { type Clock, systemClock } from "../infra/time.js";

export interface RouterOptions {
  migrationMaxPoolAgeSec: number;
  matureMinPoolAgeSec: number;
  signalsBypassWarming: boolean;
  warmingMaxSize: number;
  warmingExpireSec: number;
  classifier: DexClassifier;
  clock?: Clock;
}

export interface RoutingDecision {
  route: CandidateRoute | "launch" | "unresolved";
  reason: string;
}

/**
 * Applies the design's route split (section 4): Migration for fresh AMM pools
 * and migration events, Mature for aged pools with a signal, warming for
 * pools in between, launches for bonding-curve "pools", unresolved when the
 * pool is not known yet (the resolver fills it in and re-routes).
 */
export class Router {
  private readonly warming = new Map<string, { candidate: Candidate; since: number }>();
  private readonly clock: Clock;

  constructor(private readonly opts: RouterOptions) {
    this.clock = opts.clock ?? systemClock;
  }

  decide(candidate: Candidate): RoutingDecision {
    const now = this.clock.now();
    if (this.opts.classifier.isBondingCurve(candidate.dexId)) {
      return { route: "launch", reason: `bonding curve on ${candidate.dexId}` };
    }
    if (candidate.triggerTags.includes("migration")) {
      return { route: "migration", reason: "migration event" };
    }
    if (!candidate.poolAddress || !candidate.poolCreatedAt) {
      return { route: "unresolved", reason: "pool unknown" };
    }
    const age = poolAgeSec(candidate, now) ?? Number.POSITIVE_INFINITY;
    if (age <= this.opts.migrationMaxPoolAgeSec) {
      return {
        route: "migration",
        reason: `AMM pool age ${age}s <= ${this.opts.migrationMaxPoolAgeSec}s`,
      };
    }
    if (age >= this.opts.matureMinPoolAgeSec) {
      if (hasMatureSignal(candidate) || candidate.triggerTags.includes("new_pool")) {
        return {
          route: "mature",
          reason: `pool age ${age}s with tags ${candidate.triggerTags.join(",")}`,
        };
      }
      return { route: "rejected", reason: "aged pool without signal" };
    }
    if (this.opts.signalsBypassWarming && hasMatureSignal(candidate)) {
      return {
        route: "mature",
        reason: `young pool (${age}s) with signal ${candidate.triggerTags.join(",")}`,
      };
    }
    return { route: "warming", reason: `pool age ${age}s between migration and mature windows` };
  }

  /** Keep a warming candidate (merging repeat sightings); bounded and expiring. */
  warm(candidate: Candidate): void {
    const now = this.clock.now();
    const existing = this.warming.get(candidate.mint);
    if (existing) {
      existing.candidate = mergeCandidates(existing.candidate, candidate);
      return;
    }
    if (this.warming.size >= this.opts.warmingMaxSize) {
      const oldest = [...this.warming.entries()].sort((a, b) => a[1].since - b[1].since)[0];
      if (oldest) this.warming.delete(oldest[0]);
    }
    this.warming.set(candidate.mint, { candidate, since: now });
  }

  /** Candidates whose warming window ended: returned for re-routing; expired ones are dropped. */
  drainWarming(): { ready: Candidate[]; expired: number } {
    const now = this.clock.now();
    const ready: Candidate[] = [];
    let expired = 0;
    for (const [mint, entry] of this.warming) {
      const age = poolAgeSec(entry.candidate, now) ?? 0;
      if (age >= this.opts.matureMinPoolAgeSec) {
        ready.push(entry.candidate);
        this.warming.delete(mint);
      } else if (now - entry.since > this.opts.warmingExpireSec * 1000) {
        this.warming.delete(mint);
        expired += 1;
      }
    }
    return { ready, expired };
  }

  warmingMints(): string[] {
    return [...this.warming.keys()];
  }

  get warmingSize(): number {
    return this.warming.size;
  }
}
