import { type Clock, systemClock } from "../infra/time.js";

/** Small TTL cache keyed by string; entries expire lazily. */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly max = 5_000,
    private readonly clock: Clock = systemClock,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.clock.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.map.set(key, { value, expiresAt: this.clock.now() + ttlMs });
    if (this.map.size > this.max) this.prune();
  }

  prune(): void {
    const now = this.clock.now();
    for (const [k, e] of this.map) if (e.expiresAt <= now) this.map.delete(k);
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
