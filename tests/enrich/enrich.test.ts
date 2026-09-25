import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG_DIR } from "../../src/app/context.js";
import { loadConfig } from "../../src/config/load.js";
import type { Candidate } from "../../src/domain/types.js";
import { TtlCache } from "../../src/enrich/cache.js";
import { Enricher } from "../../src/enrich/enricher.js";
import { reduceCandles, reduceFlow } from "../../src/enrich/plugins/gecko.js";
import { reduceMarket } from "../../src/enrich/plugins/market.js";
import { reduceRugReport } from "../../src/enrich/plugins/rugcheck.js";
import { extractFeatures } from "../../src/filter/features.js";
import { nullLogger } from "../../src/infra/logger.js";
import type { DexPair } from "../../src/infra/providers/dexscreener.js";
import type { GtCandle, GtTrade } from "../../src/infra/providers/geckoterminal.js";
import type { RugReport } from "../../src/infra/providers/rugcheck.js";
import { FakeClock } from "../helpers/fake-clock.js";

const cfg = loadConfig({ configDir: DEFAULT_CONFIG_DIR });
const SOL = "So11111111111111111111111111111111111111112";

describe("reduceRugReport", () => {
  it("extracts the security section from a report (shape recorded 2026-09-24)", () => {
    const report = {
      mint: "M",
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      creator: "C",
      creatorBalance: 0,
      token: { mintAuthority: null, freezeAuthority: null, supply: 1e15, decimals: 6 },
      tokenMeta: { name: "n", symbol: "s", uri: "", mutable: true, updateAuthority: "U" },
      topHolders: [
        {
          address: "pool",
          amount: 1,
          decimals: 6,
          pct: 40,
          uiAmount: 1,
          uiAmountString: "1",
          owner: "poolOwner",
          insider: false,
        },
        {
          address: "h1",
          amount: 1,
          decimals: 6,
          pct: 12,
          uiAmount: 1,
          uiAmountString: "1",
          owner: "h1",
          insider: true,
        },
        {
          address: "h2",
          amount: 1,
          decimals: 6,
          pct: 8,
          uiAmount: 1,
          uiAmountString: "1",
          owner: "h2",
          insider: false,
        },
      ],
      freezeAuthority: null,
      mintAuthority: null,
      risks: [
        { name: "Mutable metadata", value: "", description: "", score: 100, level: "warn" },
        { name: "Low Liquidity", value: "", description: "", score: 500, level: "danger" },
      ],
      score: 601,
      score_normalised: 42,
      markets: [
        {
          pubkey: "p",
          marketType: "pump_amm",
          mintA: "M",
          mintB: SOL,
          mintLP: "",
          liquidityA: "",
          liquidityB: "",
          lp: {
            lpLockedPct: 100,
            lpLockedUSD: 1,
            lpLocked: 1,
            lpUnlocked: 0,
            quoteUSD: 1,
            baseUSD: 1,
            holders: null,
          },
        },
      ],
      totalMarketLiquidity: 9_800,
      totalStableLiquidity: 0,
      totalLPProviders: 1,
      totalHolders: 320,
      price: 0,
      rugged: false,
      tokenType: "",
      transferFee: null,
      knownAccounts: { poolOwner: { name: "PumpSwap Pool", type: "AMM" } },
      graphInsidersDetected: 1,
      insiderNetworks: [{}],
      detectedAt: "",
      creatorTokens: [
        { mint: "M", marketCap: 50_000, createdAt: "" },
        { mint: "old1", marketCap: 200, createdAt: "" },
        { mint: "old2", marketCap: 30_000, createdAt: "" },
      ],
      launchpad: "pump.fun",
      deployPlatform: null,
      verification: null,
    } as unknown as RugReport;
    const s = reduceRugReport(report);
    expect(s.scoreNormalised).toBe(42);
    expect(s.dangerRisks).toEqual(["Low Liquidity"]);
    expect(s.top10Pct).toBe(20); // pool account excluded
    expect(s.lpLockedPct).toBe(100);
    expect(s.metadataMutable).toBe(true);
    expect(s.creatorDeadTokenRatio).toBe(0.5); // old1 dead, old2 alive, M itself excluded
    expect(s.insiderNetworks).toBe(1);
    expect(s.supply).toBe(1e15);
  });
});

describe("gecko reducers", () => {
  it("summarises trade flow and candle statistics", () => {
    const t = (kind: "buy" | "sell", ts: number, vol: number, from: string): GtTrade => ({
      id: "",
      type: "trade",
      attributes: {
        block_number: 1,
        block_timestamp: new Date(ts).toISOString(),
        tx_hash: "",
        tx_from_address: from,
        kind,
        from_token_address: "",
        to_token_address: "",
        from_token_amount: "0",
        to_token_amount: "0",
        price_from_in_usd: "0",
        price_to_in_usd: "0",
        volume_in_usd: String(vol),
      },
    });
    const base = Date.UTC(2026, 8, 25);
    const flow = reduceFlow(
      [t("buy", base, 100, "a"), t("buy", base + 2000, 300, "b"), t("sell", base + 3000, 50, "a")],
      null,
    );
    expect(flow.buys).toBe(2);
    expect(flow.sells).toBe(1);
    expect(flow.uniqueTraders).toBe(2);
    expect(flow.buyVolumeUsd).toBe(400);
    expect(flow.medianInterTradeMs).toBe(1500);
    expect(flow.largestTradeUsd).toBe(300);

    const candles: GtCandle[] = [];
    for (let i = 0; i < 60; i++) {
      const close = 1 + (59 - i) * 0.01;
      candles.push([
        1_790_000_000 - i * 60,
        close,
        close + 0.1,
        close - 0.05,
        close,
        i < 15 ? 200 : 100,
      ]);
    }
    const c = reduceCandles(candles);
    expect(c.candles).toBe(60);
    expect(c.lastCloseUsd).toBeCloseTo(1.59);
    expect(c.highUsd).toBeCloseTo(1.69);
    expect(c.drawdownFromHighPct).toBeCloseTo(((1.59 - 1.69) / 1.69) * 100);
    expect(c.volumeTrend).toBeCloseTo(2);
    expect(c.volatilityPct).toBeGreaterThan(0);
  });
});

describe("reduceMarket", () => {
  it("prefers the candidate's own pool and keeps socials", () => {
    const pair = (addr: string, liq: number): DexPair => ({
      chainId: "solana",
      dexId: "pumpswap",
      url: "",
      pairAddress: addr,
      baseToken: { address: "M", name: "m", symbol: "M" },
      quoteToken: { address: SOL, name: "SOL", symbol: "SOL" },
      priceNative: "0.001",
      priceUsd: "0.1",
      txns: {
        m5: { buys: 1, sells: 0 },
        h1: { buys: 2, sells: 1 },
        h6: { buys: 3, sells: 2 },
        h24: { buys: 4, sells: 3 },
      },
      volume: { h24: 1000 },
      priceChange: { h1: 5 },
      liquidity: { usd: liq },
      info: { socials: [{ type: "telegram", url: "t" }] },
    });
    const m = reduceMarket([pair("big", 900), pair("mine", 100)], "mine");
    expect(m?.pairAddress).toBe("mine");
    expect(m?.pairCount).toBe(2);
    expect(m?.socials).toHaveLength(1);
    expect(m?.txns.h24).toEqual({ buys: 4, sells: 3 });
    expect(reduceMarket([], null)).toBeNull();
  });
});

describe("Enricher orchestration", () => {
  const candidate: Candidate = {
    mint: "M",
    poolAddress: "P",
    dexId: "pumpswap",
    launchpad: "pump.fun",
    quoteMint: SOL,
    poolCreatedAt: new Date(),
    firstSeenAt: new Date(),
    source: "t",
    triggerTags: ["migration"],
    snapshot: { liquidityUsd: 10_000 },
  };

  function enricher(
    overrides: Partial<Record<string, () => Promise<unknown>>>,
    clock = new FakeClock(),
  ) {
    const rugcheck = {
      report:
        overrides.report ??
        (async () => {
          throw new Error("rugcheck down");
        }),
    };
    const dexscreener = {
      tokenPairs: overrides.tokenPairs ?? (async () => []),
      pairsByAddresses: async () => [],
    };
    const geckoterminal = {
      poolTrades: overrides.poolTrades ?? (async () => []),
      pool: async () => null,
      ohlcv: async () => [],
      canCallNow: () => true,
    };
    const rpc = {
      getTokenLargestAccounts: async () => ({
        value: [{ address: "a", amount: "10", decimals: 0, uiAmount: 10 }],
      }),
      request: async () => ({ value: { amount: "100", decimals: 0, uiAmount: 100 } }),
    };
    const db = { query: async () => ({ rows: [], rowCount: 0 }) };
    return new Enricher(cfg.enrich, cfg.scanner.kol, {
      rugcheck: rugcheck as never,
      dexscreener: dexscreener as never,
      geckoterminal: geckoterminal as never,
      rpc: rpc as never,
      db: db as never,
      logger: nullLogger(),
      clock,
    });
  }

  it("marks failing sections unavailable, falls back to RPC holders, and never invents data", async () => {
    const e = enricher({});
    const features = extractFeatures(candidate, "migration", Date.now(), cfg.filter.signals);
    const doc = await e.enrich(candidate, "migration", features);
    expect(doc.sections.security.status).toBe("unavailable");
    expect(doc.sections.security.reason).toContain("rugcheck down");
    expect(doc.sections.market.status).toBe("unavailable");
    expect(doc.sections.holders.status).toBe("ok");
    expect(doc.sections.holders.data?.top20Pct).toBe(10);
    expect(doc.sections.twitter.status).toBe("unavailable");
    expect(doc.sections.candles.reason).toBe("not requested for this route");
    expect(doc.unavailable).toContain("security");
    expect(doc.unavailable).not.toContain("holders");
  });

  it("times out slow enrichers and caches successful sections", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const e = enricher(
      {
        report: () => new Promise(() => undefined), // never resolves
        poolTrades: async () => {
          calls += 1;
          return [];
        },
      },
      clock,
    );
    const features = extractFeatures(candidate, "migration", Date.now(), cfg.filter.signals);
    const doc1 = await e.enrich(candidate, "migration", features);
    expect(doc1.sections.security.status).toBe("unavailable");
    expect(doc1.sections.security.reason).toMatch(/timeout/);
    expect(doc1.sections.flow.status).toBe("ok");
    const doc2 = await e.enrich(candidate, "migration", features);
    expect(doc2.sections.flow.cached).toBe(true);
    expect(calls).toBe(1);
    expect(e.snapshot().sections.flow.cached).toBe(1);
  });
});

describe("TtlCache", () => {
  it("expires entries", () => {
    const clock = new FakeClock();
    const c = new TtlCache<number>(10, clock);
    c.set("a", 1, 1000);
    expect(c.get("a")).toBe(1);
    clock.advance(1001);
    expect(c.get("a")).toBeUndefined();
  });
});
