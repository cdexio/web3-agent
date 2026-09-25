import { describe, expect, it } from "vitest";
import { createDexClassifier } from "../../src/domain/dex.js";
import type { DexPair } from "../../src/infra/providers/dexscreener.js";
import type { GtPool } from "../../src/infra/providers/geckoterminal.js";
import type { PumpPortalNewToken } from "../../src/infra/providers/pumpportal.js";
import {
  normalizeTokenProfile,
  pickPrimaryPair,
} from "../../src/scanner/normalizers/dexscreener.js";
import { normalizeGtPool, tokenIdToMint } from "../../src/scanner/normalizers/geckoterminal.js";
import {
  launchpadFromPool,
  normalizeMigration,
  normalizeNewToken,
} from "../../src/scanner/normalizers/pumpportal.js";

const classifier = createDexClassifier(["pump-fun", "raydium-launchlab", "meteora-dbc"], {
  pumpswap: "pump.fun",
});

/** Recorded from GeckoTerminal /networks/solana/new_pools on 2026-09-24. */
const gtPool: GtPool = {
  id: "solana_44s1JM1khBD4cjgkLnb7tVbk1GdmNXqa3beUUwRyHSq3",
  type: "pool",
  attributes: {
    address: "44s1JM1khBD4cjgkLnb7tVbk1GdmNXqa3beUUwRyHSq3",
    name: "mayhem / SOL",
    pool_created_at: "2026-09-24T15:32:28Z",
    base_token_price_usd: "0.0000044331",
    base_token_price_native_currency: "0.0000000383",
    quote_token_price_usd: "115.62",
    fdv_usd: "8866.34",
    market_cap_usd: null,
    reserve_in_usd: "2534.82",
    price_change_percentage: { m5: "33.778", h1: "33.778" },
    transactions: { m5: { buys: 5, sells: 5, buyers: 2, sellers: 2 } },
    volume_usd: { m5: "318.23", h24: "318.23" },
  },
  relationships: {
    base_token: {
      data: { id: "solana_9YpdgMkT98KmR3f5SzUWBmaNPcCeRhvKzLGUpfJspump", type: "token" },
    },
    quote_token: {
      data: { id: "solana_So11111111111111111111111111111111111111112", type: "token" },
    },
    dex: { data: { id: "pump-fun", type: "dex" } },
  },
};

describe("GeckoTerminal normaliser", () => {
  it("extracts mint, pool, quote and market snapshot", () => {
    const now = new Date("2026-09-24T15:33:00Z");
    const { candidate, bondingCurve } = normalizeGtPool(
      gtPool,
      ["new_pool"],
      "test",
      classifier,
      now,
    );
    expect(candidate.mint).toBe("9YpdgMkT98KmR3f5SzUWBmaNPcCeRhvKzLGUpfJspump");
    expect(candidate.poolAddress).toBe("44s1JM1khBD4cjgkLnb7tVbk1GdmNXqa3beUUwRyHSq3");
    expect(candidate.quoteMint).toBe("So11111111111111111111111111111111111111112");
    expect(candidate.poolCreatedAt?.toISOString()).toBe("2026-09-24T15:32:28.000Z");
    expect(candidate.snapshot.liquidityUsd).toBeCloseTo(2534.82);
    expect((candidate.snapshot.txns as { m5: { buyers: number } }).m5.buyers).toBe(2);
    expect(bondingCurve).toBe(true);
  });

  it("classifies graduated pools as AMM with the launchpad", () => {
    const pool: GtPool = {
      ...gtPool,
      relationships: { ...gtPool.relationships, dex: { data: { id: "pumpswap", type: "dex" } } },
    };
    const { candidate, bondingCurve } = normalizeGtPool(
      pool,
      ["new_pool"],
      "test",
      classifier,
      new Date(),
    );
    expect(bondingCurve).toBe(false);
    expect(candidate.launchpad).toBe("pump.fun");
  });

  it("strips the network prefix from token ids", () => {
    expect(tokenIdToMint("solana_abc")).toBe("abc");
    expect(tokenIdToMint("abc")).toBe("abc");
  });
});

describe("PumpPortal normaliser", () => {
  /** Recorded from wss://pumpportal.fun/api/data on 2026-09-24 (LetsBonk launch). */
  const newToken: PumpPortalNewToken = {
    signature:
      "4WFYMGwXmDYT3Aj3UQR7x88xHsULGUif1vRAv7bmxL5nduRxgaeUAm4NBddiF5G5axKZNuhdMCQBUgip9tLUpS4m",
    traderPublicKey: "49du6W9suoSBJeNX2ePb2cyxBh4HBG4ERxc5LC9QRonK",
    txType: "create",
    mint: "3dSmXG9erQc3xzaQ2nNM5uSvhooEWuqc2X9r1pA2xpeg",
    solInPool: 0.99,
    initialBuy: 34193904.63,
    marketCapSol: 29.83,
    name: "xPEG",
    symbol: "XPEG",
    pool: "bonk",
  };

  it("maps a new token to a launch with creator and launchpad", () => {
    const l = normalizeNewToken(newToken);
    expect(l.creator).toBe("49du6W9suoSBJeNX2ePb2cyxBh4HBG4ERxc5LC9QRonK");
    expect(l.launchpad).toBe("letsbonk");
    expect(l.symbol).toBe("XPEG");
    expect(launchpadFromPool("pump")).toBe("pump.fun");
    expect(launchpadFromPool(undefined)).toBeNull();
  });

  it("maps a migration event to a Migration candidate", () => {
    const now = new Date();
    const c = normalizeMigration(
      { mint: "Mint1", txType: "migrate", pool: "pump", signature: "sig" },
      now,
    );
    expect(c.triggerTags).toEqual(["migration"]);
    expect(c.launchpad).toBe("pump.fun");
    expect(c.poolAddress).toBeNull();
  });
});

describe("DexScreener normaliser", () => {
  const pair = (over: Partial<DexPair>): DexPair => ({
    chainId: "solana",
    dexId: "pumpswap",
    url: "",
    pairAddress: "P1",
    baseToken: { address: "M1", name: "m", symbol: "M" },
    quoteToken: {
      address: "So11111111111111111111111111111111111111112",
      name: "SOL",
      symbol: "SOL",
    },
    priceNative: "1",
    priceUsd: "1",
    txns: {
      m5: { buys: 0, sells: 0 },
      h1: { buys: 0, sells: 0 },
      h6: { buys: 0, sells: 0 },
      h24: { buys: 0, sells: 0 },
    },
    volume: {},
    priceChange: {},
    liquidity: { usd: 100 },
    ...over,
  });

  it("picks the most liquid SOL/USDC-quoted solana pair", () => {
    const quotes = new Set(["So11111111111111111111111111111111111111112"]);
    const best = pickPrimaryPair(
      [
        pair({ pairAddress: "small", liquidity: { usd: 10 } }),
        pair({ pairAddress: "eth", chainId: "ethereum", liquidity: { usd: 9999 } }),
        pair({ pairAddress: "big", liquidity: { usd: 500 } }),
        pair({
          pairAddress: "odd-quote",
          quoteToken: { address: "X", name: "x", symbol: "X" },
          liquidity: { usd: 9000 },
        }),
      ],
      quotes,
    );
    expect(best?.pairAddress).toBe("big");
    expect(pickPrimaryPair([], quotes)).toBeNull();
  });

  it("ignores non-solana profiles", () => {
    expect(
      normalizeTokenProfile(
        { url: "", chainId: "base", tokenAddress: "0x" },
        "boost",
        "t",
        new Date(),
      ),
    ).toBeNull();
    const c = normalizeTokenProfile(
      { url: "", chainId: "solana", tokenAddress: "Mint", amount: 30 },
      "boost",
      "t",
      new Date(),
    );
    expect(c?.triggerTags).toEqual(["boost"]);
    expect(c?.snapshot.boostAmount).toBe(30);
  });
});
