import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadKolWallets } from "../../src/scanner/kol-wallets.js";
import {
  detectWalletTrade,
  nonQuoteMints,
  type ParsedTransaction,
} from "../../src/scanner/tx-parse.js";

const SOL = "So11111111111111111111111111111111111111112";
const WALLET = "KoL1111111111111111111111111111111111111111";
const MINT = "Meme11111111111111111111111111111111111111";

function swapTx(over: Partial<ParsedTransaction["meta"]> = {}): ParsedTransaction {
  return {
    slot: 1,
    blockTime: 1_790_000_000,
    transaction: {
      message: { accountKeys: [{ pubkey: WALLET, signer: true }, { pubkey: "pool" }] },
    },
    meta: {
      err: null,
      preBalances: [5_000_000_000, 0],
      postBalances: [3_990_000_000, 0],
      preTokenBalances: [
        {
          accountIndex: 2,
          mint: MINT,
          owner: WALLET,
          uiTokenAmount: { amount: "0", decimals: 6, uiAmount: 0 },
        },
        {
          accountIndex: 3,
          mint: SOL,
          owner: "pool",
          uiTokenAmount: { amount: "1", decimals: 9, uiAmount: 100 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 2,
          mint: MINT,
          owner: WALLET,
          uiTokenAmount: { amount: "1", decimals: 6, uiAmount: 1500 },
        },
        {
          accountIndex: 3,
          mint: SOL,
          owner: "pool",
          uiTokenAmount: { amount: "1", decimals: 9, uiAmount: 101 },
        },
      ],
      ...over,
    },
  };
}

describe("tx-parse", () => {
  it("finds the non-quote mint of a transaction", () => {
    expect(nonQuoteMints(swapTx())).toEqual([MINT]);
  });

  it("detects a KOL buy with the SOL spent", () => {
    const t = detectWalletTrade(swapTx(), WALLET);
    expect(t).toEqual({ mint: MINT, side: "buy", tokenDelta: 1500, solAmount: 1.01 });
  });

  it("detects a sell", () => {
    const t = detectWalletTrade(
      swapTx({
        preBalances: [1_000_000_000, 0],
        postBalances: [1_800_000_000, 0],
        preTokenBalances: [
          {
            accountIndex: 2,
            mint: MINT,
            owner: WALLET,
            uiTokenAmount: { amount: "1", decimals: 6, uiAmount: 1500 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 2,
            mint: MINT,
            owner: WALLET,
            uiTokenAmount: { amount: "0", decimals: 6, uiAmount: 0 },
          },
        ],
      }),
      WALLET,
    );
    expect(t?.side).toBe("sell");
    expect(t?.solAmount).toBeCloseTo(0.8);
  });

  it("ignores failed transactions, transfers and other wallets", () => {
    expect(
      detectWalletTrade(swapTx({ err: { InstructionError: [0, "Custom"] } }), WALLET),
    ).toBeNull();
    expect(detectWalletTrade(swapTx(), "someone-else")).toBeNull();
    // Token in AND SOL in (airdrop/transfer), not a trade.
    expect(
      detectWalletTrade(swapTx({ preBalances: [1, 0], postBalances: [2, 0] }), WALLET),
    ).toBeNull();
  });
});

describe("kol wallet file", () => {
  it("loads, dedups and caps the owner's list; ignores placeholders and missing files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zetryn-kol-"));
    const file = path.join(dir, "kol-wallets.json");
    writeFileSync(
      file,
      JSON.stringify({
        wallets: [
          { address: "REPLACE_WITH_BASE58_WALLET_ADDRESS", label: "x" },
          { address: "49du6W9suoSBJeNX2ePb2cyxBh4HBG4ERxc5LC9QRonK", label: "a", source: "gmgn" },
          { address: "49du6W9suoSBJeNX2ePb2cyxBh4HBG4ERxc5LC9QRonK", label: "dup" },
          { address: "3dSmXG9erQc3xzaQ2nNM5uSvhooEWuqc2X9r1pA2xpeg", label: "b" },
        ],
      }),
    );
    const all = loadKolWallets(file, 10);
    expect(all.map((w) => w.label)).toEqual(["a", "b"]);
    expect(loadKolWallets(file, 1)).toHaveLength(1);
    expect(loadKolWallets(path.join(dir, "missing.json"), 10)).toEqual([]);
  });
});
