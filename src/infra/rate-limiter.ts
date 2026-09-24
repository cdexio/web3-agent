import { type Clock, systemClock } from "./time.js";

export interface RateLimitSpec {
  perSecond?: number | undefined;
  perMinute?: number | undefined;
  /** Maximum tokens available at once. Defaults to a small fraction of the rate. */
  burst?: number | undefined;
}

/**
 * Token-bucket limiter. `acquire()` resolves in FIFO order once a token is
 * available, so callers never exceed the configured provider limit even when
 * many pollers run together.
 */
export class TokenBucket {
  readonly capacity: number;
  readonly refillPerMs: number;
  private tokens: number;
  private lastRefill: number;
  private chain: Promise<void> = Promise.resolve();
  private waiting = 0;

  constructor(
    spec: RateLimitSpec,
    private readonly clock: Clock = systemClock,
  ) {
    const perSecond = spec.perSecond ?? (spec.perMinute !== undefined ? spec.perMinute / 60 : 1);
    if (!(perSecond > 0)) throw new Error("rate limit must be positive");
    this.refillPerMs = perSecond / 1000;
    const defaultBurst =
      spec.perSecond !== undefined
        ? Math.max(1, Math.floor(spec.perSecond))
        : Math.max(1, Math.ceil((spec.perMinute ?? 60) / 10));
    this.capacity = Math.max(1, spec.burst ?? defaultBurst);
    this.tokens = this.capacity;
    this.lastRefill = clock.now();
  }

  /** Tokens currently available (after refill). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** Number of callers waiting for a token. */
  get queued(): number {
    return this.waiting;
  }

  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  acquire(): Promise<void> {
    this.waiting += 1;
    const p = this.chain.then(() => this.waitForToken());
    this.chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p.finally(() => {
      this.waiting -= 1;
    });
  }

  private async waitForToken(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
      await this.clock.sleep(Math.max(1, waitMs));
    }
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }
}
