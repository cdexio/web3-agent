/** Injectable clock/sleep so limiters and pools are deterministic in tests. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    }),
};

export function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function utcMonthStart(ms: number): Date {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function jitter(baseMs: number, spread = 0.3): number {
  const delta = baseMs * spread;
  return Math.max(0, Math.round(baseMs - delta + Math.random() * 2 * delta));
}
