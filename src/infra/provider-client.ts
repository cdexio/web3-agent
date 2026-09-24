import type { BudgetTracker } from "./budget.js";
import { errorMessage, isProviderError, ProviderError } from "./errors.js";
import { type KeyHealth, KeyPool } from "./key-pool.js";
import type { Logger } from "./logger.js";
import { type RateLimitSpec, TokenBucket } from "./rate-limiter.js";
import { type Clock, jitter, systemClock } from "./time.js";

export interface SmokeResult {
  provider: string;
  ok: boolean;
  /** Present when the check could not run (e.g. no key configured). */
  skipped?: string;
  latencyMs?: number;
  detail?: string;
  error?: string;
}

export interface ProviderHealth {
  provider: string;
  keys: KeyHealth[];
  anonymous: boolean;
  limiters: Array<{ id: string; available: number; queued: number }>;
}

export interface ProviderClientOptions<K> {
  name: string;
  keys: readonly K[];
  keyId: (key: K, index: number) => string;
  /** Rate-limit spec for a key (null = anonymous) and a request family. */
  limiterFor: (keyId: string | null, family: string) => RateLimitSpec;
  /** Whether requests may run without a key when the pool is empty or fully cooling down. */
  allowAnonymous: boolean;
  budget: BudgetTracker;
  logger: Logger;
  retries?: number;
  retryBaseMs?: number;
  cooldownMs?: number;
  /** Longest wait for a cooling credential before giving up (default 5 s). */
  maxCooldownWaitMs?: number;
  clock?: Clock;
}

export interface CallOptions {
  /** Request family used to pick the limiter (e.g. DexScreener "pairs" vs "profiles"). */
  family?: string;
  /** Budget units consumed by this call (credits/CU); defaults to 1 call. */
  units?: number;
  retries?: number;
  label?: string;
}

/**
 * Base for every external provider: key rotation with failover, per-key and
 * per-family rate limiting, retries with jitter, and usage accounting.
 * Subclasses implement typed endpoints on top of `call()` and a `smoke()`.
 */
export abstract class ProviderClient<K = string> {
  readonly name: string;
  protected readonly keyPool: KeyPool<K>;
  protected readonly logger: Logger;
  protected readonly budget: BudgetTracker;
  protected readonly clock: Clock;
  private readonly limiters = new Map<string, TokenBucket>();
  private readonly opts: ProviderClientOptions<K>;

  constructor(opts: ProviderClientOptions<K>) {
    this.opts = opts;
    this.name = opts.name;
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger.child({ component: `provider:${opts.name}` });
    this.budget = opts.budget;
    this.keyPool = new KeyPool(opts.keys, opts.keyId, {
      clock: this.clock,
      ...(opts.cooldownMs !== undefined ? { cooldownMs: opts.cooldownMs } : {}),
    });
  }

  abstract smoke(): Promise<SmokeResult>;

  get hasKeys(): boolean {
    return this.keyPool.size > 0;
  }

  get keyCount(): number {
    return this.keyPool.size;
  }

  health(): ProviderHealth {
    return {
      provider: this.name,
      keys: this.keyPool.health(),
      anonymous: this.keyPool.size === 0,
      limiters: [...this.limiters.entries()].map(([id, l]) => ({
        id,
        available: Math.floor(l.available()),
        queued: l.queued,
      })),
    };
  }

  protected async call<T>(
    fn: (key: K | null, keyId: string | null) => Promise<T>,
    options: CallOptions = {},
  ): Promise<T> {
    const retries = options.retries ?? this.opts.retries ?? 2;
    const family = options.family ?? "default";
    const units = options.units ?? 1;
    let attempt = 0;
    for (;;) {
      const lease = await this.leaseKey();
      const keyId = lease?.id ?? null;
      const limiter = this.limiterFor(keyId, family);
      await limiter.acquire();
      const started = this.clock.now();
      try {
        const result = await fn(lease?.value ?? null, keyId);
        this.budget.record(this.name, { calls: 1, units });
        if (keyId) this.keyPool.reportSuccess(keyId);
        return result;
      } catch (err) {
        const kind = isProviderError(err) ? err.kind : "network";
        this.budget.record(this.name, {
          calls: 1,
          errors: 1,
          rateLimited: kind === "rate_limit" ? 1 : 0,
          units,
        });
        if (keyId) this.keyPool.reportFailure(keyId, kind);
        const retryable = isProviderError(err) ? err.retryable : true;
        this.logger.warn(
          {
            keyId,
            family,
            label: options.label,
            attempt,
            kind,
            latencyMs: this.clock.now() - started,
            err: errorMessage(err),
          },
          "provider call failed",
        );
        if (!retryable || attempt >= retries) throw err;
        await this.clock.sleep(
          jitter(Math.min(5_000, (this.opts.retryBaseMs ?? 250) * 2 ** attempt)),
        );
        attempt += 1;
      }
    }
  }

  private async leaseKey(): Promise<{ id: string; value: K } | undefined> {
    if (this.keyPool.size === 0) {
      if (!this.opts.allowAnonymous) {
        throw new ProviderError(this.name, "no credential configured", { kind: "auth" });
      }
      return undefined;
    }
    const lease = this.keyPool.next();
    if (lease) return lease;
    if (this.opts.allowAnonymous) return undefined;
    // Every credential is cooling down: wait for the soonest one when the wait is short.
    const wait = this.keyPool.msUntilAnyHealthy();
    if (wait <= (this.opts.maxCooldownWaitMs ?? 5_000)) {
      await this.clock.sleep(wait);
      const retried = this.keyPool.next();
      if (retried) return retried;
    }
    throw new ProviderError(
      this.name,
      `all credentials cooling down (${Math.ceil(wait / 1000)}s)`,
      {
        kind: "rate_limit",
      },
    );
  }

  private limiterFor(keyId: string | null, family: string): TokenBucket {
    const id = `${keyId ?? "anonymous"}|${family}`;
    let limiter = this.limiters.get(id);
    if (!limiter) {
      limiter = new TokenBucket(this.opts.limiterFor(keyId, family), this.clock);
      this.limiters.set(id, limiter);
    }
    return limiter;
  }

  protected async timed<T>(fn: () => Promise<T>): Promise<{ result: T; latencyMs: number }> {
    const started = this.clock.now();
    const result = await fn();
    return { result, latencyMs: this.clock.now() - started };
  }

  protected smokeFailure(err: unknown): SmokeResult {
    return { provider: this.name, ok: false, error: errorMessage(err) };
  }
}
