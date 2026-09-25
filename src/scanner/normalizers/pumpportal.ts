import type { Candidate } from "../../domain/types.js";
import type { PumpPortalMigration, PumpPortalNewToken } from "../../infra/providers/pumpportal.js";

export interface LaunchSeen {
  mint: string;
  creator: string | null;
  launchpad: string | null;
  name: string | null;
  symbol: string | null;
  payload: Record<string, unknown>;
}

/** `pool` was "bonk" for a LetsBonk launch in the live probe; pump.fun launches carry "pump". */
export function launchpadFromPool(pool: string | undefined): string | null {
  if (!pool) return null;
  const p = pool.toLowerCase();
  if (p === "pump" || p === "pump.fun" || p === "pumpfun") return "pump.fun";
  if (p === "bonk" || p === "letsbonk") return "letsbonk";
  return p;
}

export function normalizeNewToken(event: PumpPortalNewToken): LaunchSeen {
  return {
    mint: event.mint,
    creator: event.traderPublicKey ?? null,
    launchpad: launchpadFromPool(event.pool),
    name: event.name ?? null,
    symbol: event.symbol ?? null,
    payload: {
      signature: event.signature,
      solInPool: event.solInPool ?? null,
      initialBuy: event.initialBuy ?? null,
      marketCapSol: event.marketCapSol ?? null,
      uri: event.uri ?? null,
    },
  };
}

/** Migration event -> Migration candidate; the pool address is resolved afterwards when absent. */
export function normalizeMigration(event: PumpPortalMigration, now: Date): Candidate {
  const poolAddress =
    typeof event.pool === "string" && event.pool.length > 30 ? (event.pool as string) : null;
  return {
    mint: event.mint,
    poolAddress,
    dexId: null,
    launchpad:
      launchpadFromPool(typeof event.pool === "string" ? event.pool : undefined) ?? "pump.fun",
    quoteMint: null,
    poolCreatedAt: now,
    firstSeenAt: now,
    source: "pumpportal",
    triggerTags: ["migration"],
    snapshot: { signature: event.signature ?? null, raw: event },
  };
}
