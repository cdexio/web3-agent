import { describe, expect, it } from "vitest";
import { createDexClassifier } from "../../src/domain/dex.js";
import type { Candidate, TriggerTag } from "../../src/domain/types.js";
import { CandidateQueue, preScore } from "../../src/scanner/queue.js";
import { Router } from "../../src/scanner/router.js";
import { FakeClock } from "../helpers/fake-clock.js";

const classifier = createDexClassifier(["pump-fun"], { pumpswap: "pump.fun" });

function candidate(over: Partial<Candidate> & { ageSec?: number }, clock: FakeClock): Candidate {
  const { ageSec, ...rest } = over;
  return {
    mint: "M",
    poolAddress: "P",
    dexId: "pumpswap",
    launchpad: null,
    quoteMint: null,
    poolCreatedAt:
      ageSec !== undefined ? new Date(clock.now() - ageSec * 1000) : new Date(clock.now()),
    firstSeenAt: new Date(clock.now()),
    source: "t",
    triggerTags: ["new_pool"],
    snapshot: {},
    ...rest,
  };
}

function router(clock: FakeClock, bypass = true) {
  return new Router({
    migrationMaxPoolAgeSec: 180,
    matureMinPoolAgeSec: 1800,
    signalsBypassWarming: bypass,
    warmingMaxSize: 3,
    warmingExpireSec: 2400,
    classifier,
    clock,
  });
}

describe("Router", () => {
  it("routes by pool age and tags", () => {
    const clock = new FakeClock();
    const r = router(clock);
    expect(r.decide(candidate({ ageSec: 10 }, clock)).route).toBe("migration");
    expect(r.decide(candidate({ ageSec: 600 }, clock)).route).toBe("warming");
    expect(r.decide(candidate({ ageSec: 3600 }, clock)).route).toBe("mature");
    expect(r.decide(candidate({ ageSec: 3600, triggerTags: ["trending_1h"] }, clock)).route).toBe(
      "mature",
    );
    // A migration event is resolved first when its pool is unknown, then routed to Migration
    // regardless of the resolved pool age.
    expect(
      r.decide(candidate({ triggerTags: ["migration"], poolAddress: null }, clock)).route,
    ).toBe("unresolved");
    expect(r.decide(candidate({ triggerTags: ["migration"], ageSec: 900 }, clock)).route).toBe(
      "migration",
    );
    expect(r.decide(candidate({ dexId: "pump-fun", ageSec: 10 }, clock)).route).toBe("launch");
    expect(r.decide(candidate({ poolAddress: null, triggerTags: ["boost"] }, clock)).route).toBe(
      "unresolved",
    );
  });

  it("lets signals bypass warming when configured", () => {
    const clock = new FakeClock();
    expect(
      router(clock, true).decide(candidate({ ageSec: 600, triggerTags: ["kol_buy"] }, clock)).route,
    ).toBe("mature");
    expect(
      router(clock, false).decide(candidate({ ageSec: 600, triggerTags: ["kol_buy"] }, clock))
        .route,
    ).toBe("warming");
  });

  it("promotes warming candidates once they age past the mature threshold", () => {
    const clock = new FakeClock();
    const r = router(clock);
    r.warm(candidate({ mint: "A", ageSec: 600 }, clock));
    r.warm(candidate({ mint: "A", ageSec: 600, triggerTags: ["boost"] }, clock));
    expect(r.warmingSize).toBe(1);
    expect(r.drainWarming().ready).toEqual([]);
    clock.advance(1300 * 1000);
    const { ready } = r.drainWarming();
    expect(ready.map((c) => c.mint)).toEqual(["A"]);
    expect(ready[0]?.triggerTags).toEqual(["new_pool", "boost"]);
    expect(r.warmingSize).toBe(0);
  });

  it("bounds the warming set and expires stale entries", () => {
    const clock = new FakeClock();
    const r = router(clock);
    for (const m of ["A", "B", "C", "D"]) r.warm(candidate({ mint: m, ageSec: 600 }, clock));
    expect(r.warmingSize).toBe(3);
    expect(r.warmingMints()).not.toContain("A");
  });
});

describe("CandidateQueue", () => {
  const item = (
    mint: string,
    clock: FakeClock,
    tags: TriggerTag[] = ["new_pool"],
    liquidityUsd = 1000,
  ) => ({
    candidate: candidate({ mint, triggerTags: tags, snapshot: { liquidityUsd } }, clock),
    route: "migration" as const,
    reason: "t",
    candidateId: null,
    enqueuedAt: clock.now(),
  });

  it("dedups by mint, merges tags, and drops the oldest on the migration route", async () => {
    const clock = new FakeClock();
    const q = new CandidateQueue({ route: "migration", max: 2, dedupCooldownMs: 1000, clock });
    expect(q.enqueue(item("A", clock))).toBe("queued");
    expect(q.enqueue(item("A", clock, ["boost"]))).toBe("merged");
    expect(q.enqueue(item("B", clock))).toBe("queued");
    expect(q.enqueue(item("C", clock))).toBe("queued");
    expect(q.depth).toBe(2);
    const first = await q.take();
    expect(first.candidate.mint).toBe("B"); // A was the oldest and got dropped
    expect(q.enqueue(item("B", clock))).toBe("deduped");
    clock.advance(1001);
    expect(q.enqueue(item("B", clock))).toBe("queued");
    expect(q.snapshot().dropped).toBe(1);
  });

  it("drops the lowest pre-score on the mature route", async () => {
    const clock = new FakeClock();
    const q = new CandidateQueue({ route: "mature", max: 2, dedupCooldownMs: 0, clock });
    q.enqueue({ ...item("low", clock, ["boost"], 100), route: "mature" });
    q.enqueue({ ...item("high", clock, ["boost", "kol_buy"], 100_000), route: "mature" });
    q.enqueue({ ...item("mid", clock, ["boost"], 10_000), route: "mature" });
    const mints = [(await q.take()).candidate.mint, (await q.take()).candidate.mint];
    expect(mints.sort()).toEqual(["high", "mid"]);
  });

  it("hands an item directly to a waiting worker", async () => {
    const clock = new FakeClock();
    const q = new CandidateQueue({ route: "migration", max: 5, dedupCooldownMs: 0, clock });
    const waiting = q.take();
    q.enqueue(item("A", clock));
    expect((await waiting).candidate.mint).toBe("A");
    expect(q.depth).toBe(0);
  });

  it("scores recency, liquidity and signals", () => {
    const clock = new FakeClock();
    const a = preScore(item("a", clock, ["boost"], 100), clock.now());
    const b = preScore(item("b", clock, ["boost", "kol_buy"], 1_000_000), clock.now());
    expect(b).toBeGreaterThan(a);
  });
});
