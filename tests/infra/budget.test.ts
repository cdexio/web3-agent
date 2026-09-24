import { describe, expect, it } from "vitest";
import {
  type BudgetSnapshot,
  BudgetTracker,
  type UsageRow,
  type UsageSink,
} from "../../src/infra/budget.js";
import { FakeClock } from "../helpers/fake-clock.js";

class MemorySink implements UsageSink {
  rows: UsageRow[] = [];
  failNext = false;
  monthUnits = new Map<string, number>();

  async flush(rows: UsageRow[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("db down");
    }
    this.rows.push(...rows);
  }

  async monthToDate(provider: string): Promise<number> {
    return this.monthUnits.get(provider) ?? 0;
  }
}

describe("BudgetTracker", () => {
  it("accumulates calls, errors and units per provider per day", () => {
    const clock = new FakeClock(Date.UTC(2026, 8, 24, 12));
    const t = new BudgetTracker(
      { helius: { unitName: "credits", monthlyBudget: 1_000_000 } },
      0.8,
      null,
      null,
      clock,
    );
    t.record("helius", { calls: 1, units: 10 });
    t.record("helius", { calls: 1, errors: 1, rateLimited: 1, units: 1 });
    const s = t.snapshot("helius");
    expect(s.today).toEqual({ calls: 2, errors: 1, rateLimited: 1, units: 11 });
    expect(s.unitsMonth).toBe(11);
    expect(s.fraction).toBeCloseTo(11 / 1_000_000);
    expect(s.alarm).toBe(false);
  });

  it("fires the alarm once per day when crossing the fraction", () => {
    const clock = new FakeClock(Date.UTC(2026, 8, 24, 12));
    const alarms: BudgetSnapshot[] = [];
    const t = new BudgetTracker(
      { p: { unitName: "u", monthlyBudget: 100 } },
      0.8,
      null,
      (s) => alarms.push(s),
      clock,
    );
    t.record("p", { units: 79 });
    expect(alarms.length).toBe(0);
    t.record("p", { units: 1 });
    expect(alarms.length).toBe(1);
    t.record("p", { units: 5 });
    expect(alarms.length).toBe(1);
    clock.advance(24 * 3600 * 1000);
    t.record("p", { units: 1 });
    expect(alarms.length).toBe(2);
  });

  it("flushes deltas to the sink and re-queues them when the sink fails", async () => {
    const clock = new FakeClock(Date.UTC(2026, 8, 24, 12));
    const sink = new MemorySink();
    const t = new BudgetTracker({ p: { unitName: "calls" } }, 0.8, sink, null, clock);
    t.record("p", { calls: 2 });
    sink.failNext = true;
    await expect(t.flush()).rejects.toThrow("db down");
    t.record("p", { calls: 3 });
    await t.flush();
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]?.calls).toBe(5);
    await t.flush();
    expect(sink.rows).toHaveLength(1);
  });

  it("loads month-to-date usage from the sink", async () => {
    const sink = new MemorySink();
    sink.monthUnits.set("p", 400);
    const t = new BudgetTracker({ p: { unitName: "u", monthlyBudget: 1000 } }, 0.8, sink);
    await t.loadMonthToDate();
    expect(t.snapshot("p").unitsMonth).toBe(400);
    t.record("p", { units: 100 });
    expect(t.snapshot("p").fraction).toBeCloseTo(0.5);
  });
});
