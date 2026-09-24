import { type Clock, systemClock, utcDateString, utcMonthStart } from "./time.js";

export interface UsageDelta {
  calls?: number;
  errors?: number;
  rateLimited?: number;
  /** Provider-specific units: Helius credits, Alchemy compute units, or calls. */
  units?: number;
}

export interface UsageRow {
  provider: string;
  usageDate: string;
  calls: number;
  errors: number;
  rateLimited: number;
  units: number;
  unitName: string;
}

export interface UsageSink {
  /** Add the deltas to the per-provider per-day rows (upsert, additive). */
  flush(rows: UsageRow[]): Promise<void>;
  /** Units already consumed by this provider since the given UTC month start. */
  monthToDate(provider: string, monthStart: Date): Promise<number>;
}

export interface BudgetSpec {
  unitName: string;
  monthlyBudget?: number;
}

export interface BudgetSnapshot {
  provider: string;
  unitName: string;
  monthlyBudget: number | null;
  unitsMonth: number;
  fraction: number | null;
  today: { calls: number; errors: number; rateLimited: number; units: number };
  alarm: boolean;
}

export type AlarmHandler = (snapshot: BudgetSnapshot) => void;

/**
 * Per-provider usage accounting against free-tier monthly budgets.
 * Counts in memory, flushes deltas to the sink (Postgres `api_usage`), and
 * fires an alarm once per day when a provider crosses the alarm fraction.
 */
export class BudgetTracker {
  private readonly pending = new Map<string, UsageRow>();
  private readonly todayTotals = new Map<string, UsageRow>();
  private readonly monthUnits = new Map<string, number>();
  private readonly alarmedOn = new Map<string, string>();
  private readonly clock: Clock;
  private sink: UsageSink | null;

  constructor(
    private readonly specs: Record<string, BudgetSpec>,
    private readonly alarmFraction: number,
    sink: UsageSink | null = null,
    private readonly onAlarm: AlarmHandler | null = null,
    clock: Clock = systemClock,
  ) {
    this.sink = sink;
    this.clock = clock;
  }

  /** Attach the persistence sink once the database is available (boot order). */
  setSink(sink: UsageSink | null): void {
    this.sink = sink;
  }

  providers(): string[] {
    return Object.keys(this.specs);
  }

  record(provider: string, delta: UsageDelta): void {
    const spec = this.specs[provider] ?? { unitName: "calls" };
    const date = utcDateString(this.clock.now());
    const key = `${provider}|${date}`;
    const units = delta.units ?? delta.calls ?? 0;
    for (const map of [this.pending, this.todayTotals]) {
      const row = map.get(key) ?? {
        provider,
        usageDate: date,
        calls: 0,
        errors: 0,
        rateLimited: 0,
        units: 0,
        unitName: spec.unitName,
      };
      row.calls += delta.calls ?? 0;
      row.errors += delta.errors ?? 0;
      row.rateLimited += delta.rateLimited ?? 0;
      row.units += units;
      map.set(key, row);
    }
    this.monthUnits.set(provider, (this.monthUnits.get(provider) ?? 0) + units);
    this.checkAlarm(provider, date);
  }

  snapshot(provider: string): BudgetSnapshot {
    const spec = this.specs[provider] ?? { unitName: "calls" };
    const date = utcDateString(this.clock.now());
    const today = this.todayTotals.get(`${provider}|${date}`);
    const unitsMonth = this.monthUnits.get(provider) ?? 0;
    const budget = spec.monthlyBudget ?? null;
    const fraction = budget ? unitsMonth / budget : null;
    return {
      provider,
      unitName: spec.unitName,
      monthlyBudget: budget,
      unitsMonth,
      fraction,
      today: {
        calls: today?.calls ?? 0,
        errors: today?.errors ?? 0,
        rateLimited: today?.rateLimited ?? 0,
        units: today?.units ?? 0,
      },
      alarm: fraction !== null && fraction >= this.alarmFraction,
    };
  }

  snapshots(): BudgetSnapshot[] {
    return this.providers().map((p) => this.snapshot(p));
  }

  /** Load month-to-date units from the sink so restarts do not reset budgets. */
  async loadMonthToDate(): Promise<void> {
    if (!this.sink) return;
    const monthStart = utcMonthStart(this.clock.now());
    for (const provider of this.providers()) {
      const used = await this.sink.monthToDate(provider, monthStart);
      this.monthUnits.set(provider, used);
    }
  }

  async flush(): Promise<void> {
    if (!this.sink || this.pending.size === 0) return;
    const rows = [...this.pending.values()];
    this.pending.clear();
    try {
      await this.sink.flush(rows);
    } catch (err) {
      // Put the deltas back so nothing is lost; the next flush retries.
      for (const row of rows) {
        const key = `${row.provider}|${row.usageDate}`;
        const existing = this.pending.get(key);
        if (existing) {
          existing.calls += row.calls;
          existing.errors += row.errors;
          existing.rateLimited += row.rateLimited;
          existing.units += row.units;
        } else {
          this.pending.set(key, row);
        }
      }
      throw err;
    }
  }

  private checkAlarm(provider: string, date: string): void {
    const snap = this.snapshot(provider);
    if (!snap.alarm) return;
    if (this.alarmedOn.get(provider) === date) return;
    this.alarmedOn.set(provider, date);
    this.onAlarm?.(snap);
  }
}
