import type { FailureKind } from "./errors.js";
import { type Clock, systemClock } from "./time.js";

export interface KeyPoolOptions {
  /** Base cooldown after a credential failure; doubles per consecutive failure. */
  cooldownMs?: number;
  maxCooldownMs?: number;
  /** 5xx responses are often transient: cool a key down only after this many in a row. */
  serverFailuresBeforeCooldown?: number;
  clock?: Clock;
}

export interface KeyHealth {
  id: string;
  healthy: boolean;
  cooldownUntil: number | null;
  consecutiveFailures: number;
  successes: number;
  failures: number;
  lastFailureKind: FailureKind | null;
}

export interface Leased<T> {
  id: string;
  value: T;
}

interface Slot<T> {
  id: string;
  value: T;
  cooldownUntil: number;
  consecutiveFailures: number;
  successes: number;
  failures: number;
  lastFailureKind: FailureKind | null;
}

/**
 * Round-robin credential pool with automatic failover (owner rule 8).
 * A credential that fails with a rate-limit, auth or server error is cooled
 * down with exponential backoff and skipped until the cooldown expires.
 * Works with a single credential and scales with more.
 */
export class KeyPool<T> {
  private readonly slots: Slot<T>[];
  private cursor = 0;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly serverFailuresBeforeCooldown: number;
  private readonly clock: Clock;

  constructor(
    items: readonly T[],
    idOf: (item: T, index: number) => string,
    opts: KeyPoolOptions = {},
  ) {
    this.slots = items.map((value, i) => ({
      id: idOf(value, i),
      value,
      cooldownUntil: 0,
      consecutiveFailures: 0,
      successes: 0,
      failures: 0,
      lastFailureKind: null,
    }));
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.maxCooldownMs = opts.maxCooldownMs ?? 15 * 60_000;
    this.serverFailuresBeforeCooldown = opts.serverFailuresBeforeCooldown ?? 3;
    this.clock = opts.clock ?? systemClock;
  }

  get size(): number {
    return this.slots.length;
  }

  get healthyCount(): number {
    const now = this.clock.now();
    return this.slots.filter((s) => s.cooldownUntil <= now).length;
  }

  /** Next healthy credential in round-robin order, or undefined if all are cooling down. */
  next(): Leased<T> | undefined {
    if (this.slots.length === 0) return undefined;
    const now = this.clock.now();
    for (let i = 0; i < this.slots.length; i++) {
      const idx = (this.cursor + i) % this.slots.length;
      const slot = this.slots[idx];
      if (slot && slot.cooldownUntil <= now) {
        this.cursor = (idx + 1) % this.slots.length;
        return { id: slot.id, value: slot.value };
      }
    }
    return undefined;
  }

  /** Milliseconds until at least one credential is healthy again (0 if one is). */
  msUntilAnyHealthy(): number {
    if (this.slots.length === 0) return Number.POSITIVE_INFINITY;
    const now = this.clock.now();
    let min = Number.POSITIVE_INFINITY;
    for (const s of this.slots) {
      if (s.cooldownUntil <= now) return 0;
      min = Math.min(min, s.cooldownUntil - now);
    }
    return min;
  }

  reportSuccess(id: string): void {
    const s = this.find(id);
    if (!s) return;
    s.successes += 1;
    s.consecutiveFailures = 0;
    s.cooldownUntil = 0;
  }

  reportFailure(id: string, kind: FailureKind): void {
    const s = this.find(id);
    if (!s) return;
    s.failures += 1;
    s.lastFailureKind = kind;
    // Client errors are the request's fault, not the credential's.
    if (kind === "client" || kind === "timeout" || kind === "network") return;
    s.consecutiveFailures += 1;
    // 5xx: tolerate a few in a row; the backoff exponent then counts from the first cooldown.
    const threshold = kind === "server" ? this.serverFailuresBeforeCooldown : 1;
    if (s.consecutiveFailures < threshold) return;
    const backoff = Math.min(
      this.maxCooldownMs,
      this.cooldownMs * 2 ** Math.max(0, s.consecutiveFailures - threshold),
    );
    s.cooldownUntil = this.clock.now() + backoff;
  }

  health(): KeyHealth[] {
    const now = this.clock.now();
    return this.slots.map((s) => ({
      id: s.id,
      healthy: s.cooldownUntil <= now,
      cooldownUntil: s.cooldownUntil > now ? s.cooldownUntil : null,
      consecutiveFailures: s.consecutiveFailures,
      successes: s.successes,
      failures: s.failures,
      lastFailureKind: s.lastFailureKind,
    }));
  }

  private find(id: string): Slot<T> | undefined {
    return this.slots.find((s) => s.id === id);
  }
}

/** Mask a secret for logs and ids: keeps 4 leading and 2 trailing characters. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return `${secret.slice(0, 2)}…`;
  return `${secret.slice(0, 4)}…${secret.slice(-2)}`;
}
