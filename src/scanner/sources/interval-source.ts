import { errorMessage } from "../../infra/errors.js";
import type { Logger } from "../../infra/logger.js";
import type { ScannerMetrics } from "../metrics.js";

/** Remembers keys for a while so repeated polls do not re-emit the same item. */
export class SeenCache {
  private readonly map = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly max = 20_000,
  ) {}

  /** Returns true the first time a key is seen within the TTL. */
  first(key: string, now = Date.now()): boolean {
    const t = this.map.get(key);
    if (t !== undefined && now - t < this.ttlMs) return false;
    this.map.set(key, now);
    if (this.map.size > this.max) this.prune(now);
    return true;
  }

  prune(now = Date.now()): void {
    for (const [k, t] of this.map) if (now - t >= this.ttlMs) this.map.delete(k);
    while (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      if (first === undefined) break;
      this.map.delete(first);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * A poller that runs `tick()` on a fixed interval, never overlapping itself,
 * with a start offset so the pollers do not fire in the same second.
 */
export abstract class IntervalSource {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  protected readonly log: Logger;

  constructor(
    readonly name: string,
    private readonly intervalMs: number,
    private readonly startOffsetMs: number,
    protected readonly metrics: ScannerMetrics,
    logger: Logger,
  ) {
    this.log = logger.child({ component: `source:${name}` });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const first = setTimeout(() => {
      void this.run();
      this.timer = setInterval(() => void this.run(), this.intervalMs);
      this.timer.unref?.();
    }, this.startOffsetMs);
    first.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    try {
      await this.tick();
    } catch (err) {
      this.metrics.error(this.name);
      this.log.warn({ err: errorMessage(err) }, "tick failed");
    } finally {
      this.inFlight = false;
    }
  }

  protected abstract tick(): Promise<void>;
}
