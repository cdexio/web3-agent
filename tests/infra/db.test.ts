import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "../../src/app/context.js";
import {
  appliedVersions,
  listMigrations,
  pendingMigrations,
  runMigrations,
} from "../../src/infra/db/migrate.js";
import { PgliteDb } from "../../src/infra/db/pglite.js";
import {
  CandidateRepo,
  ConfigVersionRepo,
  HeartbeatRepo,
  PositionRepo,
  UsageRepo,
} from "../../src/infra/db/repos.js";

let db: PgliteDb;

beforeAll(async () => {
  db = await PgliteDb.create();
});

afterAll(async () => {
  await db.close();
});

describe("migrations", () => {
  it("lists shipped migrations in order", () => {
    const ms = listMigrations(MIGRATIONS_DIR);
    expect(ms.length).toBeGreaterThanOrEqual(1);
    expect(ms[0]?.version).toBe(1);
    expect(ms[0]?.name).toBe("init");
  });

  it("applies pending migrations once and is idempotent", async () => {
    const first = await runMigrations(db, MIGRATIONS_DIR);
    expect(first.map((m) => m.version)).toEqual(
      listMigrations(MIGRATIONS_DIR).map((m) => m.version),
    );
    const second = await runMigrations(db, MIGRATIONS_DIR);
    expect(second).toEqual([]);
    expect(await pendingMigrations(db, MIGRATIONS_DIR)).toEqual([]);
    expect(await appliedVersions(db)).toContain(1);
  });
});

describe("repositories", () => {
  it("upserts api_usage additively and reports month-to-date", async () => {
    const usage = new UsageRepo(db);
    const row = {
      provider: "helius",
      usageDate: "2026-09-24",
      calls: 2,
      errors: 1,
      rateLimited: 0,
      units: 20,
      unitName: "credits",
    };
    await usage.flush([row]);
    await usage.flush([{ ...row, calls: 3, units: 5 }]);
    const res = await db.query<{ calls: number; units: string }>(
      "SELECT calls, units FROM api_usage WHERE provider = 'helius'",
    );
    expect(Number(res.rows[0]?.calls)).toBe(5);
    expect(Number(res.rows[0]?.units)).toBe(25);
    expect(await usage.monthToDate("helius", new Date(Date.UTC(2026, 8, 1)))).toBe(25);
    expect(await usage.monthToDate("helius", new Date(Date.UTC(2026, 9, 1)))).toBe(0);
  });

  it("records heartbeats and config versions", async () => {
    const hb = new HeartbeatRepo(db);
    await hb.beat("test:1", "paper", { ok: true });
    const latest = await hb.latest();
    expect(latest?.instance_id).toBe("test:1");

    const cv = new ConfigVersionRepo(db);
    const id1 = await cv.recordIfChanged("paper", "hash-a", { a: 1 }, "boot");
    const id2 = await cv.recordIfChanged("paper", "hash-a", { a: 1 });
    const id3 = await cv.recordIfChanged("paper", "hash-b", { a: 2 });
    expect(id1).not.toBeNull();
    expect(id2).toBeNull();
    expect(id3).not.toBeNull();
  });

  it("stores candidates, filter decisions, positions and outcomes", async () => {
    const candidates = new CandidateRepo(db);
    const id = await candidates.insert(
      {
        mint: "Mint111",
        poolAddress: "Pool111",
        dexId: "pumpswap",
        launchpad: "pump.fun",
        quoteMint: "So11111111111111111111111111111111111111112",
        poolCreatedAt: new Date("2026-09-24T10:00:00Z"),
        firstSeenAt: new Date("2026-09-24T10:00:05Z"),
        source: "geckoterminal",
        triggerTags: ["migration", "new_pool"],
        snapshot: { liquidityUsd: 9000 },
      },
      "migration",
      "pool age 5s",
    );
    expect(id).toBeGreaterThan(0);
    await candidates.recordFilterDecision(
      id,
      "migration",
      false,
      "min_liquidity",
      { liquidityUsd: 9000 },
      { minLiquidityUsd: 8000 },
    );
    const counts = await candidates.countByRoute(24 * 365);
    expect(counts.find((c) => c.route === "migration")?.n).toBe(1);

    const positions = new PositionRepo(db);
    const pid = await positions.open({
      candidateId: id,
      aiDecisionId: null,
      route: "migration",
      mint: "Mint111",
      poolAddress: "Pool111",
      mode: "paper",
      sizeSol: 0.05,
      entryPrice: 0.000001,
      reentryIndex: 0,
    });
    expect((await positions.openPositions()).map((p) => p.id)).toContain(pid);
    await positions.close(pid, {
      exitPrice: 0.0000012,
      exitReason: "take_profit",
      realizedPnlSol: 0.009,
      feesSol: 0.001,
      holdSeconds: 180,
    });
    expect(await positions.openPositions()).toEqual([]);
    await positions.recordOutcome({
      positionId: pid,
      aiDecisionId: null,
      route: "migration",
      win: true,
      realizedPnlSol: 0.009,
      pnlPct: 18,
      peakMultiple: 1.3,
      holdSeconds: 180,
      exitReason: "take_profit",
      features: { liquidityBand: "5k-10k" },
    });
    const outcomes = await db.query<{ win: boolean }>(
      "SELECT win FROM outcomes WHERE position_id = $1",
      [pid],
    );
    expect(outcomes.rows[0]?.win).toBe(true);
  });
});
