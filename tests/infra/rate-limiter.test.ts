import { describe, expect, it } from "vitest";
import { TokenBucket } from "../../src/infra/rate-limiter.js";
import { FakeClock } from "../helpers/fake-clock.js";

describe("TokenBucket", () => {
  it("derives burst and refill from a per-minute limit", () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ perMinute: 30 }, clock);
    expect(bucket.capacity).toBe(3);
    expect(bucket.refillPerMs).toBeCloseTo(30 / 60_000);
  });

  it("allows the burst immediately and then waits for refill", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ perMinute: 30 }, clock); // 1 token per 2 s, burst 3
    expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(false);
    await bucket.acquire();
    expect(clock.sleeps.length).toBeGreaterThan(0);
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2000);
  });

  it("never exceeds the rate over a window", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ perSecond: 4, burst: 1 }, clock);
    const start = clock.now();
    for (let i = 0; i < 9; i++) await bucket.acquire();
    // 9 acquisitions at 4/s with burst 1 need at least 2 s of virtual time.
    expect(clock.now() - start).toBeGreaterThanOrEqual(2000);
  });

  it("serves waiters in FIFO order", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ perSecond: 1, burst: 1 }, clock);
    const order: number[] = [];
    await bucket.acquire();
    await Promise.all([
      bucket.acquire().then(() => order.push(1)),
      bucket.acquire().then(() => order.push(2)),
      bucket.acquire().then(() => order.push(3)),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("rejects non-positive rates", () => {
    expect(() => new TokenBucket({ perSecond: 0 })).toThrow();
  });
});
