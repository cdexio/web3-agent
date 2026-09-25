import type { Candidate, Route, TriggerTag } from "./types.js";

export const MATURE_SIGNAL_TAGS: ReadonlySet<TriggerTag> = new Set<TriggerTag>([
  "trending_5m",
  "trending_1h",
  "trending_6h",
  "boost",
  "profile",
  "rugcheck_trending",
  "kol_buy",
  "breakout",
  "golden_swing",
]);

export function poolAgeSec(candidate: Candidate, now: number): number | null {
  if (!candidate.poolCreatedAt) return null;
  return Math.max(0, Math.round((now - candidate.poolCreatedAt.getTime()) / 1000));
}

export function hasMatureSignal(candidate: Candidate): boolean {
  return candidate.triggerTags.some((t) => MATURE_SIGNAL_TAGS.has(t));
}

/** Merge a later sighting of the same mint into an earlier one (tags, snapshot, pool details). */
export function mergeCandidates(base: Candidate, incoming: Candidate): Candidate {
  const tags = [...new Set<TriggerTag>([...base.triggerTags, ...incoming.triggerTags])];
  return {
    ...base,
    poolAddress: base.poolAddress ?? incoming.poolAddress,
    dexId: base.dexId ?? incoming.dexId,
    launchpad: base.launchpad ?? incoming.launchpad,
    quoteMint: base.quoteMint ?? incoming.quoteMint,
    poolCreatedAt: base.poolCreatedAt ?? incoming.poolCreatedAt,
    triggerTags: tags,
    snapshot: { ...base.snapshot, ...incoming.snapshot },
    source: `${base.source}+${incoming.source}`,
  };
}

export interface RoutedCandidate {
  candidate: Candidate;
  route: Route;
  reason: string;
  /** Row id in `candidates` once persisted. */
  candidateId: number | null;
  enqueuedAt: number;
}

export function numberField(snapshot: Record<string, unknown>, key: string): number | null {
  const v = snapshot[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
