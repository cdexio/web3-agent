import type { Route } from "../../domain/types.js";
import type { DbClient } from "../../infra/db/client.js";
import type { DexScreenerClient } from "../../infra/providers/dexscreener.js";
import type { MarketContextSection } from "../types.js";

/** Market context shared by every candidate: SOL trend, today's flow, our own recent results. */
export async function fetchContext(
  dexscreener: DexScreenerClient,
  db: DbClient,
  solUsdcPair: string,
  route: Route,
): Promise<MarketContextSection> {
  const [pairs, today, stats] = await Promise.all([
    dexscreener.pairsByAddresses("solana", [solUsdcPair]).catch(() => []),
    db.query<{ route: string; n: string }>(
      "SELECT route, COUNT(*) AS n FROM candidates WHERE first_seen_at >= date_trunc('day', now() AT TIME ZONE 'utc') GROUP BY route",
    ),
    db.query<{ trades: string; wins: string; mean_pnl: string | null }>(
      `SELECT COUNT(*) AS trades, COALESCE(SUM(CASE WHEN win THEN 1 ELSE 0 END), 0) AS wins, AVG(pnl_pct) AS mean_pnl
         FROM outcomes WHERE route = $1 AND closed_at >= now() - interval '7 days'`,
      [route],
    ),
  ]);
  const sol = pairs[0];
  const byRoute = Object.fromEntries(today.rows.map((r) => [r.route, Number(r.n)]));
  const s = stats.rows[0];
  const trades = Number(s?.trades ?? 0);
  return {
    solPriceUsd: sol?.priceUsd ? Number(sol.priceUsd) : null,
    solChangeH1Pct: sol?.priceChange.h1 ?? null,
    solChangeH24Pct: sol?.priceChange.h24 ?? null,
    migrationsToday: byRoute.migration ?? 0,
    candidatesTodayByRoute: byRoute,
    routeStats7d:
      trades > 0
        ? {
            trades,
            winRate: Number(s?.wins ?? 0) / trades,
            meanPnlPct:
              s?.mean_pnl === null || s?.mean_pnl === undefined ? null : Number(s.mean_pnl),
          }
        : null,
  };
}
