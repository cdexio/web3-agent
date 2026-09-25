import type { SolanaRpcPool } from "../../infra/providers/solana-rpc.js";
import type { HoldersSection } from "../types.js";

interface LargestAccounts {
  value: Array<{ address: string; amount: string; decimals: number; uiAmount: number | null }>;
}

interface TokenSupply {
  value: { amount: string; decimals: number; uiAmount: number | null };
}

/** Fallback holder concentration when RugCheck is unavailable (2 RPC calls). */
export async function fetchHolders(
  rpc: SolanaRpcPool,
  mint: string,
  knownSupply: number | null,
): Promise<HoldersSection> {
  const largest = (await rpc.getTokenLargestAccounts(mint)) as LargestAccounts;
  let supply = knownSupply;
  if (supply === null) {
    const s = (await rpc.request("getTokenSupply", [
      mint,
      { commitment: "confirmed" },
    ])) as TokenSupply;
    supply = s.value.uiAmount ?? Number(s.value.amount) / 10 ** s.value.decimals;
  }
  const top20 = largest.value.slice(0, 20).map((a) => ({
    address: a.address,
    pct:
      supply && supply > 0
        ? ((a.uiAmount ?? Number(a.amount) / 10 ** a.decimals) / supply) * 100
        : 0,
  }));
  return { top20, top20Pct: supply ? top20.reduce((s, h) => s + h.pct, 0) : null, source: "rpc" };
}
