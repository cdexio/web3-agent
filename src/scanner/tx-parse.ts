import { SOL_MINT, USDC_MINT } from "../domain/types.js";

/** Subset of a `jsonParsed` getTransaction result used by the scanners. */
export interface ParsedTransaction {
  slot?: number;
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    logMessages?: string[];
  } | null;
  transaction?: {
    signatures?: string[];
    message?: {
      accountKeys?: Array<{ pubkey: string; signer?: boolean; writable?: boolean } | string>;
      instructions?: Array<{ programId?: string; program?: string; parsed?: unknown }>;
    };
  };
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString?: string;
  };
}

export const QUOTE_MINTS: ReadonlySet<string> = new Set([SOL_MINT, USDC_MINT]);

export interface LogsNotification {
  signature: string;
  err: unknown;
  logs: string[];
}

/**
 * `logsNotification` payloads are `{ context, value: { signature, err, logs } }`
 * (verified on Alchemy, Helius and the public RPC 2026-09-25); slot
 * notifications are flat. Accept both shapes.
 */
export function unwrapLogsNotification(result: unknown): LogsNotification | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as { value?: unknown; signature?: unknown };
  const v = (typeof r.value === "object" && r.value !== null ? r.value : result) as {
    signature?: unknown;
    err?: unknown;
    logs?: unknown;
  };
  if (typeof v.signature !== "string") return null;
  return {
    signature: v.signature,
    err: v.err ?? null,
    logs: Array.isArray(v.logs) ? (v.logs as string[]) : [],
  };
}

export function accountKey(tx: ParsedTransaction, index: number): string | null {
  const key = tx.transaction?.message?.accountKeys?.[index];
  if (!key) return null;
  return typeof key === "string" ? key : key.pubkey;
}

export function txSucceeded(tx: ParsedTransaction): boolean {
  return !tx.meta?.err;
}

/**
 * Mints touched by the transaction, excluding SOL and USDC, ordered by how
 * many token accounts reference them. For a migration / pool creation the
 * first entry is the new token.
 */
export function nonQuoteMints(tx: ParsedTransaction): string[] {
  const counts = new Map<string, number>();
  for (const b of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) {
    if (QUOTE_MINTS.has(b.mint)) continue;
    counts.set(b.mint, (counts.get(b.mint) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([mint]) => mint);
}

export interface WalletTrade {
  mint: string;
  side: "buy" | "sell";
  /** Token amount change in ui units (positive for buy). */
  tokenDelta: number;
  /** SOL spent (buy) or received (sell), in SOL, including fees paid by the wallet. */
  solAmount: number;
}

/**
 * Detects a buy or sell by `wallet` from pre/post balances: a token balance
 * owned by the wallet moved while its SOL (or USDC) balance moved the other way.
 */
export function detectWalletTrade(tx: ParsedTransaction, wallet: string): WalletTrade | null {
  if (!txSucceeded(tx)) return null;
  const pre = new Map<string, number>();
  const post = new Map<string, number>();
  for (const b of tx.meta?.preTokenBalances ?? []) {
    if (b.owner === wallet && !QUOTE_MINTS.has(b.mint))
      pre.set(b.mint, (pre.get(b.mint) ?? 0) + (b.uiTokenAmount.uiAmount ?? 0));
  }
  for (const b of tx.meta?.postTokenBalances ?? []) {
    if (b.owner === wallet && !QUOTE_MINTS.has(b.mint))
      post.set(b.mint, (post.get(b.mint) ?? 0) + (b.uiTokenAmount.uiAmount ?? 0));
  }
  let best: { mint: string; delta: number } | null = null;
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const delta = (post.get(mint) ?? 0) - (pre.get(mint) ?? 0);
    if (delta === 0) continue;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { mint, delta };
  }
  if (!best) return null;

  const keys = tx.transaction?.message?.accountKeys ?? [];
  const idx = keys.findIndex((k) => (typeof k === "string" ? k : k.pubkey) === wallet);
  let solDelta = 0;
  if (idx >= 0) {
    const preSol = tx.meta?.preBalances?.[idx] ?? 0;
    const postSol = tx.meta?.postBalances?.[idx] ?? 0;
    solDelta = (postSol - preSol) / 1_000_000_000;
  }
  // USDC-quoted trades: count the stablecoin move as the "SOL" amount in USDC units when SOL did not move.
  if (solDelta === 0) {
    const usdcPre = (tx.meta?.preTokenBalances ?? []).filter(
      (b) => b.owner === wallet && b.mint === USDC_MINT,
    );
    const usdcPost = (tx.meta?.postTokenBalances ?? []).filter(
      (b) => b.owner === wallet && b.mint === USDC_MINT,
    );
    const sum = (xs: TokenBalance[]) => xs.reduce((a, b) => a + (b.uiTokenAmount.uiAmount ?? 0), 0);
    solDelta = sum(usdcPost) - sum(usdcPre);
  }
  const side: "buy" | "sell" = best.delta > 0 ? "buy" : "sell";
  if ((side === "buy" && solDelta > 0) || (side === "sell" && solDelta < 0)) return null; // transfer, not a trade
  return { mint: best.mint, side, tokenDelta: best.delta, solAmount: Math.abs(solDelta) };
}
