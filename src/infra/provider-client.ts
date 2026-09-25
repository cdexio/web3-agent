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
  /**
   * After a 429 the credential (or the anonymous lane) is paused for this long, or for the
   * provider's Retry-After when it is longer. Default 10 s.
   */
  rateLimitPauseMs?: number;
  /**
   * Adaptive per-lane rate for providers whose real limit is unknown or variable
   * (GeckoTerminal rejected 11 of 20 calls at 15/min on 2026-09-25): every 429 halves the
   * rate down to `minPerMinute`; 20 consecutive successes raise it 25% up to the configured spec.
   */
  adaptiveRate?: { minPerMinute: number; successesToRaise?: number };
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
  private readonly pausedUntil = new Map<string, number>();
  private readonly adaptive = new Map<string, { perMinute: number; max: number; streak: number }>();
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

  /**
   * Whether a call could start now without queueing on the rate limiter or a
   * 429 pause. Optional enrichers use it to skip instead of waiting.
   */
  canCallNow(family = "default"): boolean {
    const lane = this.keyPool.size > 0 ? (this.keyPool.peek()?.id ?? null) : null;
    const until = this.pausedUntil.get(lane ?? "anonymous");
    if (until !== undefined && until > this.clock.now()) return false;
    return this.limiterFor(lane, family).available() >= 1;
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
    let forceAnonymous = false;
    for (;;) {
      const lease = forceAnonymous ? undefined : await this.leaseKey();
      const keyId = lease?.id ?? null;
      await this.waitIfPaused(keyId ?? "anonymous");
      const limiter = this.limiterFor(keyId, family);
      await limiter.acquire();
      const started = this.clock.now();
      try {
        const result = await fn(lease?.value ?? null, keyId);
        this.budget.record(this.name, { calls: 1, units });
        if (keyId) this.keyPool.reportSuccess(keyId);
        this.adapt(keyId, family, "success");
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
        if (kind === "rate_limit") {
          const retryAfter = isProviderError(err) ? (err.retryAfterMs ?? 0) : 0;
          const pause = Math.max(retryAfter, this.opts.rateLimitPauseMs ?? 10_000);
          this.pausedUntil.set(keyId ?? "anonymous", this.clock.now() + pause);
          this.adapt(keyId, family, "rate_limit");
        }
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
        // A rejected key on a provider that also serves anonymous traffic: retry once without it,
        // so a bad or expired key degrades to the anonymous rate limit instead of an outage.
        if (kind === "auth" && keyId && this.opts.allowAnonymous && !forceAnonymous) {
          forceAnonymous = true;
          this.logger.warn({ keyId }, "credential rejected; retrying anonymously");
          continue;
        }
        if (!retryable || attempt >= retries) throw err;
        await this.clock.sleep(
          jitter(Math.min(5_000, (this.opts.retryBaseMs ?? 250) * 2 ** attempt)),
        );
        attempt += 1;
      }
    }
  }

  /** Honour a 429 pause for the lane (credential or anonymous) before spending a limiter token. */
  private async waitIfPaused(lane: string): Promise<void> {
    const until = this.pausedUntil.get(lane);
    if (until === undefined) return;
    const wait = until - this.clock.now();
    if (wait > 0) await this.clock.sleep(wait);
    this.pausedUntil.delete(lane);
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
      limiter = new TokenBucket(this.adaptiveSpec(keyId, family), this.clock);
      this.limiters.set(id, limiter);
    }
    return limiter;
  }

  private adaptiveSpec(keyId: string | null, family: string): RateLimitSpec {
    const spec = this.opts.limiterFor(keyId, family);
    if (!this.opts.adaptiveRate) return spec;
    const id = `${keyId ?? "anonymous"}|${family}`;
    let state = this.adaptive.get(id);
    if (!state) {
      const max = spec.perMinute ?? (spec.perSecond ?? 1) * 60;
      state = { perMinute: max, max, streak: 0 };
      this.adaptive.set(id, state);
    }
    return { perMinute: state.perMinute, burst: 1 };
  }

  /** Halve the lane's rate on 429; raise it 25% after a streak of successes. */
  private adapt(keyId: string | null, family: string, event: "success" | "rate_limit"): void {
    const cfg = this.opts.adaptiveRate;
    if (!cfg) return;
    const id = `${keyId ?? "anonymous"}|${family}`;
    this.adaptiveSpec(keyId, family);
    const state = this.adaptive.get(id);
    if (!state) return;
    const before = state.perMinute;
    if (event === "rate_limit") {
      state.streak = 0;
      state.perMinute = Math.max(cfg.minPerMinute, state.perMinute / 2);
    } else {
      state.streak += 1;
      if (state.streak >= (cfg.successesToRaise ?? 20) && state.perMinute < state.max) {
        state.streak = 0;
        state.perMinute = Math.min(state.max, state.perMinute * 1.25);
      }
    }
    if (state.perMinute !== before) {
      this.limiters.set(id, new TokenBucket({ perMinute: state.perMinute, burst: 1 }, this.clock));
      this.logger.info(
        { lane: id, perMinute: Number(state.perMinute.toFixed(2)), event },
        "adaptive rate changed",
      );
    }
  }

  /** Current adaptive rates per lane (for health output). */
  adaptiveRates(): Record<string, number> {
    return Object.fromEntries(
      [...this.adaptive.entries()].map(([k, v]) => [k, Number(v.perMinute.toFixed(2))]),
    );
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
