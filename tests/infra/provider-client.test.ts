import { describe, expect, it } from "vitest";
import { BudgetTracker } from "../../src/infra/budget.js";
import { ProviderError } from "../../src/infra/errors.js";
import { nullLogger } from "../../src/infra/logger.js";
import { ProviderClient, type SmokeResult } from "../../src/infra/provider-client.js";
import { FakeClock } from "../helpers/fake-clock.js";

class TestClient extends ProviderClient<string> {
  constructor(keys: string[], clock: FakeClock, budget: BudgetTracker, allowAnonymous = false) {
    super({
      name: "test",
      keys,
      keyId: (k) => k,
      allowAnonymous,
      limiterFor: () => ({ perSecond: 100 }),
      budget,
      logger: nullLogger(),
      retries: 3,
      retryBaseMs: 10,
      cooldownMs: 1000,
      clock,
    });
  }

  run<T>(fn: (key: string | null) => Promise<T>) {
    return this.call((key) => fn(key));
  }

  smoke(): Promise<SmokeResult> {
    return Promise.resolve({ provider: "test", ok: true });
  }
}

describe("ProviderClient", () => {
  it("rotates keys and fails over on rate limits", async () => {
    const clock = new FakeClock();
    const budget = new BudgetTracker({ test: { unitName: "calls" } }, 0.8, null, null, clock);
    const client = new TestClient(["k1", "k2"], clock, budget);
    const used: Array<string | null> = [];
    const result = await client.run(async (key) => {
      used.push(key);
      if (key === "k1") throw new ProviderError("test", "429", { kind: "rate_limit", status: 429 });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(used).toEqual(["k1", "k2"]);
    // k1 is now cooling down: the next call goes straight to k2.
    used.length = 0;
    await client.run(async (key) => {
      used.push(key);
      return "ok";
    });
    expect(used).toEqual(["k2"]);
    expect(budget.snapshot("test").today).toEqual({
      calls: 3,
      errors: 1,
      rateLimited: 1,
      units: 3,
    });
  });

  it("does not retry client errors", async () => {
    const clock = new FakeClock();
    const budget = new BudgetTracker({ test: { unitName: "calls" } }, 0.8, null, null, clock);
    const client = new TestClient(["k1"], clock, budget);
    let calls = 0;
    await expect(
      client.run(async () => {
        calls += 1;
        throw new ProviderError("test", "400", { kind: "client", status: 400 });
      }),
    ).rejects.toThrow("400");
    expect(calls).toBe(1);
  });

  it("gives up after the configured retries on server errors, waiting out a short cooldown", async () => {
    const clock = new FakeClock();
    const budget = new BudgetTracker({ test: { unitName: "calls" } }, 0.8, null, null, clock);
    const client = new TestClient(["k1"], clock, budget);
    let calls = 0;
    await expect(
      client.run(async () => {
        calls += 1;
        throw new ProviderError("test", "500", { kind: "server", status: 500 });
      }),
    ).rejects.toThrow("500");
    // 3 consecutive 5xx cool the only key down for 1 s; the 4th attempt waits it out
    // (the wait is the cooldown minus the retry backoff already slept).
    expect(calls).toBe(4);
    expect(clock.sleeps.some((ms) => ms >= 900 && ms <= 1000)).toBe(true);
  });

  it("fails fast when every key is cooling down for longer than the wait limit", async () => {
    const clock = new FakeClock();
    const budget = new BudgetTracker({ test: { unitName: "calls" } }, 0.8, null, null, clock);
    const client = new TestClient(["k1"], clock, budget);
    for (let i = 0; i < 6; i++) {
      await client
        .run(async () => {
          throw new ProviderError("test", "429", { kind: "rate_limit", status: 429 });
        })
        .catch(() => undefined);
    }
    await expect(client.run(async () => "x")).rejects.toThrow(/cooling down/);
  });

  it("runs anonymously when allowed and no key is configured", async () => {
    const clock = new FakeClock();
    const budget = new BudgetTracker({ test: { unitName: "calls" } }, 0.8, null, null, clock);
    const client = new TestClient([], clock, budget, true);
    const key = await client.run(async (k) => k);
    expect(key).toBeNull();
  });

  it("falls back to anonymous once when a key is rejected and anonymous is allowed", async () => {
    const clock = new FakeClock();
    const budget = new BudgetTracker({ test: { unitName: "calls" } }, 0.8, null, null, clock);
    const client = new TestClient(["bad"], clock, budget, true);
    const used: Array<string | null> = [];
    const result = await client.run(async (key) => {
      used.push(key);
      if (key !== null) throw new ProviderError("test", "401", { kind: "auth", status: 401 });
      return "anon-ok";
    });
    expect(result).toBe("anon-ok");
    expect(used).toEqual(["bad", null]);
  });

  it("pauses the anonymous lane after a 429, honouring Retry-After", async () => {
    const clock = new FakeClock();
    const budget = new BudgetTracker({ test: { unitName: "calls" } }, 0.8, null, null, clock);
    const client = new TestClient([], clock, budget, true);
    let calls = 0;
    await client.run(async () => {
      calls += 1;
      if (calls === 1)
        throw new ProviderError("test", "429", {
          kind: "rate_limit",
          status: 429,
          retryAfterMs: 30_000,
        });
      return "ok";
    });
    expect(calls).toBe(2);
    // The retry waited out the 30 s Retry-After (longer than the default 10 s pause),
    // minus the few milliseconds of retry backoff already slept.
    expect(clock.sleeps.some((ms) => ms >= 29_000 && ms <= 30_000)).toBe(true);
  });

  it("refuses to run without a key when anonymous is not allowed", async () => {
    const clock = new FakeClock();
    const budget = new BudgetTracker({ test: { unitName: "calls" } }, 0.8, null, null, clock);
    const client = new TestClient([], clock, budget, false);
    await expect(client.run(async () => "x")).rejects.toThrow("no credential configured");
  });
});
