import { describe, expect, it } from "vitest";
import { KeyPool, maskSecret } from "../../src/infra/key-pool.js";
import { FakeClock } from "../helpers/fake-clock.js";

function pool(keys: string[], clock = new FakeClock()) {
  return {
    pool: new KeyPool(keys, (k) => `k:${k}`, { clock, cooldownMs: 1000, maxCooldownMs: 8000 }),
    clock,
  };
}

describe("KeyPool", () => {
  it("rotates round-robin over healthy keys", () => {
    const { pool: p } = pool(["a", "b", "c"]);
    expect([p.next()?.value, p.next()?.value, p.next()?.value, p.next()?.value]).toEqual([
      "a",
      "b",
      "c",
      "a",
    ]);
  });

  it("works with a single key", () => {
    const { pool: p } = pool(["only"]);
    expect(p.next()?.value).toBe("only");
    expect(p.next()?.value).toBe("only");
  });

  it("returns undefined for an empty pool", () => {
    const { pool: p } = pool([]);
    expect(p.next()).toBeUndefined();
    expect(p.msUntilAnyHealthy()).toBe(Number.POSITIVE_INFINITY);
  });

  it("cools a rate-limited key down and skips it until expiry", () => {
    const { pool: p, clock } = pool(["a", "b"]);
    p.reportFailure("k:a", "rate_limit");
    expect(p.healthyCount).toBe(1);
    expect(p.next()?.value).toBe("b");
    expect(p.next()?.value).toBe("b");
    clock.advance(1001);
    expect(p.healthyCount).toBe(2);
  });

  it("backs off exponentially on consecutive failures, capped", () => {
    const { pool: p, clock } = pool(["a"]);
    p.reportFailure("k:a", "rate_limit"); // 1000
    expect(p.msUntilAnyHealthy()).toBe(1000);
    clock.advance(1000);
    p.reportFailure("k:a", "rate_limit"); // 2000
    expect(p.msUntilAnyHealthy()).toBe(2000);
    clock.advance(2000);
    p.reportFailure("k:a", "rate_limit"); // 4000
    clock.advance(4000);
    p.reportFailure("k:a", "rate_limit"); // 8000 (cap)
    clock.advance(8000);
    p.reportFailure("k:a", "rate_limit"); // still 8000
    expect(p.msUntilAnyHealthy()).toBe(8000);
  });

  it("cools down on server errors only after three in a row", () => {
    const { pool: p } = pool(["a"]);
    p.reportFailure("k:a", "server");
    p.reportFailure("k:a", "server");
    expect(p.healthyCount).toBe(1);
    p.reportFailure("k:a", "server");
    expect(p.healthyCount).toBe(0);
  });

  it("does not cool down on client, timeout or network failures", () => {
    const { pool: p } = pool(["a"]);
    p.reportFailure("k:a", "client");
    p.reportFailure("k:a", "timeout");
    p.reportFailure("k:a", "network");
    expect(p.healthyCount).toBe(1);
    expect(p.health()[0]?.failures).toBe(3);
  });

  it("resets the backoff after a success", () => {
    const { pool: p, clock } = pool(["a"]);
    p.reportFailure("k:a", "rate_limit");
    clock.advance(1000);
    p.reportFailure("k:a", "rate_limit");
    expect(p.msUntilAnyHealthy()).toBe(2000);
    clock.advance(2000);
    p.reportSuccess("k:a");
    p.reportFailure("k:a", "rate_limit");
    expect(p.msUntilAnyHealthy()).toBe(1000);
  });

  it("starts the server-error backoff at the base cooldown", () => {
    const { pool: p } = pool(["a"]);
    p.reportFailure("k:a", "server");
    p.reportFailure("k:a", "server");
    p.reportFailure("k:a", "server");
    expect(p.msUntilAnyHealthy()).toBe(1000);
  });

  it("masks secrets for ids and logs", () => {
    expect(maskSecret("abcdefghijklmnop")).toBe("abcd…op");
    expect(maskSecret("short")).toBe("sh…");
  });
});
