export interface SourceMetrics {
  events: number;
  candidates: number;
  launches: number;
  errors: number;
  lastEventAt: number | null;
  /** Milliseconds from on-chain/pool time to first-seen, moving average of the last 100. */
  avgDetectLagMs: number | null;
}

/** Per-source counters for the heartbeat and the health command. */
export class ScannerMetrics {
  private readonly sources = new Map<string, SourceMetrics & { lags: number[] }>();
  private readonly routes = new Map<string, number>();

  source(name: string): SourceMetrics & { lags: number[] } {
    let s = this.sources.get(name);
    if (!s) {
      s = {
        events: 0,
        candidates: 0,
        launches: 0,
        errors: 0,
        lastEventAt: null,
        avgDetectLagMs: null,
        lags: [],
      };
      this.sources.set(name, s);
    }
    return s;
  }

  event(name: string, lagMs?: number): void {
    const s = this.source(name);
    s.events += 1;
    s.lastEventAt = Date.now();
    if (lagMs !== undefined && Number.isFinite(lagMs) && lagMs >= 0) {
      s.lags.push(lagMs);
      if (s.lags.length > 100) s.lags.shift();
      s.avgDetectLagMs = Math.round(s.lags.reduce((a, b) => a + b, 0) / s.lags.length);
    }
  }

  candidate(name: string): void {
    this.source(name).candidates += 1;
  }

  launch(name: string): void {
    this.source(name).launches += 1;
  }

  error(name: string): void {
    this.source(name).errors += 1;
  }

  routed(route: string): void {
    this.routes.set(route, (this.routes.get(route) ?? 0) + 1);
  }

  snapshot(): { sources: Record<string, SourceMetrics>; routes: Record<string, number> } {
    const sources: Record<string, SourceMetrics> = {};
    for (const [k, v] of this.sources) {
      const { lags: _lags, ...rest } = v;
      sources[k] = rest;
    }
    return { sources, routes: Object.fromEntries(this.routes) };
  }
}
