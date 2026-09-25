import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG_DIR } from "../../src/app/context.js";
import { loadConfig } from "../../src/config/load.js";
import type { Candidate } from "../../src/domain/types.js";
import type { SecuritySection } from "../../src/enrich/types.js";
import { extractFeatures } from "../../src/filter/features.js";
import { HardFilter } from "../../src/filter/hard-filter.js";

const cfg = loadConfig({ configDir: DEFAULT_CONFIG_DIR });
const SOL = "So11111111111111111111111111111111111111112";
const NOW = Date.UTC(2026, 8, 25, 12);

function candidate(
  over: Partial<Candidate> = {},
  snapshot: Record<string, unknown> = {},
): Candidate {
  return {
    mint: "M",
    poolAddress: "P",
    dexId: "pumpswap",
    launchpad: "pump.fun",
    quoteMint: SOL,
    poolCreatedAt: new Date(NOW - 60_000),
    firstSeenAt: new Date(NOW),
    source: "t",
    triggerTags: ["migration"],
    snapshot: {
      liquidityUsd: 12_000,
      volumeUsd: { m5: 5_000, h1: 20_000, h24: 60_000 },
      priceChangePct: { m5: 5, h1: 20, h24: 40 },
      txns: { m5: { buys: 30, sells: 10 }, h1: { buys: 200, sells: 120 } },
      socials: [{ type: "twitter", url: "x" }],
      ...snapshot,
    },
    ...over,
  };
}

function security(over: Partial<SecuritySection> = {}): SecuritySection {
  return {
    scoreNormalised: 10,
    score: 100,
    risks: [],
    dangerRisks: [],
    mintAuthority: null,
    freezeAuthority: null,
    metadataMutable: false,
    transferFeePct: 0,
    totalHolders: 400,
    topHolders: [],
    top10Pct: 20,
    lpLockedPct: 100,
    totalMarketLiquidityUsd: 12_000,
    insiderNetworks: 0,
    graphInsidersDetected: 0,
    creator: "creator",
    creatorTokens: [],
    creatorDeadTokenRatio: null,
    launchpad: "pump.fun",
    rugged: false,
    supply: 1e9,
    decimals: 6,
    ...over,
  };
}

describe("extractFeatures", () => {
  it("derives ratios, ages and signal tags from the snapshot", () => {
    const f = extractFeatures(candidate(), "migration", NOW, cfg.filter.signals);
    expect(f.poolAgeSec).toBe(60);
    expect(f.buySellRatioM5).toBe(3);
    expect(f.volumeToLiquidity24h).toBe(5);
    expect(f.socialsCount).toBe(1);
    // h1 volume 20k vs hourly average 2.5k => 8x, h1 +20%, m5 +5% => breakout
    expect(f.breakout).toBe(true);
    expect(f.tags).toContain("breakout");
    expect(f.goldenSwing).toBe(false);
  });

  it("flags a golden swing on a deep 24h drawdown with returning volume", () => {
    const f = extractFeatures(
      candidate({}, { priceChangePct: { m5: 1, h1: 8, h24: -45 } }),
      "mature",
      NOW,
      cfg.filter.signals,
    );
    expect(f.goldenSwing).toBe(true);
    expect(f.breakout).toBe(false);
  });

  it("keeps unknown fields null instead of inventing them", () => {
    const f = extractFeatures(candidate({ snapshot: {} }), "migration", NOW, cfg.filter.signals);
    expect(f.liquidityUsd).toBeNull();
    expect(f.buySellRatioM5).toBeNull();
    expect(f.breakout).toBe(false);
  });
});

describe("HardFilter migration route", () => {
  const hf = () => new HardFilter(cfg.filter, new Set(["badcreator"]));

  it("passes a healthy migration in both phases", () => {
    const f = extractFeatures(candidate(), "migration", NOW, cfg.filter.signals);
    const h = hf();
    expect(h.evaluate("pre", "migration", f, null).passed).toBe(true);
    const post = h.evaluate("post", "migration", f, security());
    expect(post.passed).toBe(true);
    expect(post.outcomes.find((o) => o.name === "min_buyers_m5")?.result).toBe("unknown");
    expect(h.snapshot().passed.migration).toBe(1);
  });

  it("skips the m5 flow rules for pools younger than the flow window", () => {
    const h = hf();
    const fresh = extractFeatures(
      candidate({ poolCreatedAt: new Date(NOW - 5_000) }, { txns: { m5: { buys: 1, sells: 3 } } }),
      "migration",
      NOW,
      cfg.filter.signals,
    );
    const pre = h.evaluate("pre", "migration", fresh, null);
    expect(pre.passed).toBe(true);
    expect(pre.outcomes.find((o) => o.name === "min_buys_m5")?.result).toBe("unknown");
    const aged = extractFeatures(
      candidate({}, { txns: { m5: { buys: 1, sells: 3 } } }),
      "migration",
      NOW,
      cfg.filter.signals,
    );
    expect(h.evaluate("pre", "migration", aged, null).failedRule).toBe("min_buys_m5");
  });

  it("rejects low liquidity and unknown liquidity in the pre phase", () => {
    const h = hf();
    const low = extractFeatures(
      candidate({}, { liquidityUsd: 3_000 }),
      "migration",
      NOW,
      cfg.filter.signals,
    );
    expect(h.evaluate("pre", "migration", low, null).failedRule).toBe("min_liquidity");
    const unknown = extractFeatures(
      candidate({ snapshot: {} }),
      "migration",
      NOW,
      cfg.filter.signals,
    );
    expect(h.evaluate("pre", "migration", unknown, null).failedRule).toBe("min_liquidity");
    expect(h.snapshot().rejectedByRule.migration.min_liquidity).toBe(2);
  });

  it("rejects mint authority, danger risks, blacklisted creators and dead-token creators in the post phase", () => {
    const h = hf();
    const f = extractFeatures(candidate(), "migration", NOW, cfg.filter.signals);
    expect(h.evaluate("post", "migration", f, security({ mintAuthority: "X" })).failedRule).toBe(
      "authorities_revoked",
    );
    expect(
      h.evaluate("post", "migration", f, security({ dangerRisks: ["Freeze Authority"] }))
        .failedRule,
    ).toBe("no_danger_risks");
    expect(h.evaluate("post", "migration", f, security({ creator: "badcreator" })).failedRule).toBe(
      "creator_blacklist",
    );
    const serial = security({
      creatorTokens: [
        { mint: "a", marketCapUsd: 100 },
        { mint: "b", marketCapUsd: 50 },
        { mint: "c", marketCapUsd: 5_000 },
      ],
      creatorDeadTokenRatio: 2 / 3,
    });
    expect(h.evaluate("post", "migration", f, serial).failedRule).toBe("creator_history");
    expect(h.evaluate("post", "migration", f, security({ transferFeePct: 2 })).failedRule).toBe(
      "max_transfer_fee",
    );
  });

  it("skips post rules when the security section is unavailable and records them as unknown", () => {
    const h = hf();
    const f = extractFeatures(candidate(), "migration", NOW, cfg.filter.signals);
    const post = h.evaluate("post", "migration", f, null);
    expect(post.passed).toBe(true);
    expect(post.outcomes.every((o) => o.result === "unknown")).toBe(true);
    expect(h.snapshot().unknownByRule.migration.authorities_revoked).toBe(1);
  });
});

describe("HardFilter mature route", () => {
  const mature = (snapshot: Record<string, unknown> = {}, over: Partial<Candidate> = {}) =>
    candidate(
      {
        triggerTags: ["trending_1h"],
        poolCreatedAt: new Date(NOW - 3 * 3600_000),
        dexId: "raydium",
        ...over,
      },
      { liquidityUsd: 60_000, volumeUsd: { m5: 2_000, h1: 15_000, h24: 120_000 }, ...snapshot },
    );

  it("requires a signal tag, liquidity and volume", () => {
    const h = new HardFilter(cfg.filter, new Set());
    const ok = extractFeatures(mature(), "mature", NOW, cfg.filter.signals);
    expect(h.evaluate("pre", "mature", ok, null).passed).toBe(true);
    // Flat price action so neither breakout nor golden swing is inferred from the snapshot.
    const noSignal = extractFeatures(
      mature({ priceChangePct: { m5: 0, h1: 1, h24: 2 } }, { triggerTags: [] }),
      "mature",
      NOW,
      cfg.filter.signals,
    );
    expect(h.evaluate("pre", "mature", noSignal, null).failedRule).toBe("signal_tag");
    const thin = extractFeatures(
      mature({ volumeUsd: { h24: 10_000 } }),
      "mature",
      NOW,
      cfg.filter.signals,
    );
    expect(h.evaluate("pre", "mature", thin, null).failedRule).toBe("min_volume_h24");
  });

  it("checks holders, concentration, LP lock and rug score after enrichment", () => {
    const h = new HardFilter(cfg.filter, new Set());
    const f = extractFeatures(mature(), "mature", NOW, cfg.filter.signals);
    expect(h.evaluate("post", "mature", f, security()).passed).toBe(true);
    expect(h.evaluate("post", "mature", f, security({ totalHolders: 50 })).failedRule).toBe(
      "min_holders",
    );
    expect(h.evaluate("post", "mature", f, security({ top10Pct: 60 })).failedRule).toBe(
      "max_top10_holders",
    );
    expect(h.evaluate("post", "mature", f, security({ lpLockedPct: 10 })).failedRule).toBe(
      "lp_locked",
    );
    expect(h.evaluate("post", "mature", f, security({ scoreNormalised: 80 })).failedRule).toBe(
      "max_rug_score",
    );
    // PumpSwap pools burn LP, so an unknown lock percentage is fine there.
    const ps = extractFeatures(
      mature({}, { dexId: "pumpswap" }),
      "mature",
      NOW,
      cfg.filter.signals,
    );
    expect(h.evaluate("post", "mature", ps, security({ lpLockedPct: null })).passed).toBe(true);
  });
});
