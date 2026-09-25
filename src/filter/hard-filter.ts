import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { AppConfig } from "../config/schema.js";
import type { Route } from "../domain/types.js";
import type { SecuritySection } from "../enrich/types.js";
import type { CandidateFeatures } from "./features.js";
import { type PhaseResult, type RulePhase, rulesFor, runPhase } from "./rules.js";

const blacklistSchema = z.object({
  $comment: z.string().optional(),
  creators: z.array(
    z.object({
      address: z.string(),
      reason: z.string().optional(),
      addedAt: z.string().optional(),
    }),
  ),
});

export function loadCreatorBlacklist(file: string): Set<string> {
  if (!existsSync(file)) return new Set();
  const parsed = blacklistSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  return new Set(parsed.creators.map((c) => c.address).filter((a) => !a.startsWith("REPLACE")));
}

export interface FilterStats {
  evaluated: Record<Route, number>;
  passed: Record<Route, number>;
  rejectedByRule: Record<Route, Record<string, number>>;
  unknownByRule: Record<Route, Record<string, number>>;
}

/**
 * Deterministic, cheap rejection before enrichment/AI (phase "pre"), then a
 * second pass with the security section (phase "post"). Every decision is
 * returned with the rule outcomes so it can be persisted and tuned.
 */
export class HardFilter {
  private readonly stats: FilterStats = {
    evaluated: { migration: 0, mature: 0 },
    passed: { migration: 0, mature: 0 },
    rejectedByRule: { migration: {}, mature: {} },
    unknownByRule: { migration: {}, mature: {} },
  };

  constructor(
    private readonly cfg: AppConfig["filter"],
    private readonly blacklist: ReadonlySet<string>,
  ) {}

  thresholds(route: Route): Record<string, unknown> {
    return route === "migration" ? this.cfg.migration : this.cfg.mature;
  }

  evaluate(
    phase: RulePhase,
    route: Route,
    features: CandidateFeatures,
    security: SecuritySection | null,
  ): PhaseResult {
    const result = runPhase(rulesFor(route, this.cfg), phase, {
      route,
      features,
      security,
      blacklistedCreators: this.blacklist,
    });
    if (phase === "pre") this.stats.evaluated[route] += 1;
    for (const o of result.outcomes) {
      if (o.result === "unknown") {
        const m = this.stats.unknownByRule[route];
        m[o.name] = (m[o.name] ?? 0) + 1;
      }
    }
    if (!result.passed && result.failedRule) {
      const m = this.stats.rejectedByRule[route];
      m[result.failedRule] = (m[result.failedRule] ?? 0) + 1;
    } else if (phase === "post" && result.passed) {
      this.stats.passed[route] += 1;
    }
    return result;
  }

  snapshot(): FilterStats {
    return JSON.parse(JSON.stringify(this.stats)) as FilterStats;
  }
}
