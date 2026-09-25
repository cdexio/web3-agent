import type { DbClient } from "../../infra/db/client.js";
import type { KolSection } from "../types.js";

/** KOL overlap from our own trade log: who bought this mint recently and whether they cluster. */
export async function fetchKol(
  db: DbClient,
  mint: string,
  windowMin: number,
  botThreshold: number,
): Promise<KolSection> {
  const res = await db.query<{
    address: string;
    label: string | null;
    ts: Date;
    trades_today: string;
  }>(
    `SELECT t.address, w.label, t.ts,
            (SELECT COUNT(*) FROM kol_trades x WHERE x.address = t.address AND x.ts >= date_trunc('day', now())) AS trades_today
       FROM (SELECT DISTINCT ON (address) address, ts FROM kol_trades
              WHERE mint = $1 AND side = 'buy' AND ts >= now() - ($2::int * interval '1 minute')
              ORDER BY address, ts DESC) t
       JOIN kol_wallets w ON w.address = t.address
      ORDER BY t.ts DESC`,
    [mint, windowMin],
  );
  const buyers = res.rows.map((r) => ({
    address: r.address,
    label: r.label,
    ts: new Date(r.ts).toISOString(),
    tradesToday: Number(r.trades_today),
    botSuspect: Number(r.trades_today) > botThreshold,
  }));
  return { count: buyers.length, buyers, clusterWithinWindow: buyers.length >= 2, windowMin };
}
