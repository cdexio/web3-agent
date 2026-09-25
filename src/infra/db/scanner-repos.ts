import type { KolWallet } from "../../scanner/kol-wallets.js";
import type { LaunchSeen } from "../../scanner/normalizers/pumpportal.js";
import type { DbClient } from "./client.js";

export class LaunchRepo {
  constructor(private readonly db: DbClient) {}

  async upsert(l: LaunchSeen): Promise<void> {
    await this.db.query(
      `INSERT INTO launches_seen (mint, creator, launchpad, name, symbol, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (mint) DO UPDATE SET
         creator = COALESCE(EXCLUDED.creator, launches_seen.creator),
         launchpad = COALESCE(EXCLUDED.launchpad, launches_seen.launchpad),
         name = COALESCE(EXCLUDED.name, launches_seen.name),
         symbol = COALESCE(EXCLUDED.symbol, launches_seen.symbol)`,
      [l.mint, l.creator, l.launchpad, l.name, l.symbol, JSON.stringify(l.payload)],
    );
  }

  /** Creator history for the hard filter: launches seen and how many later appeared as candidates. */
  async creatorStats(creator: string): Promise<{ launches: number; firstSeen: Date | null }> {
    const res = await this.db.query<{ launches: string; first_seen: Date | null }>(
      "SELECT COUNT(*) AS launches, MIN(seen_at) AS first_seen FROM launches_seen WHERE creator = $1",
      [creator],
    );
    return {
      launches: Number(res.rows[0]?.launches ?? 0),
      firstSeen: res.rows[0]?.first_seen ?? null,
    };
  }

  async creatorOf(mint: string): Promise<string | null> {
    const res = await this.db.query<{ creator: string | null }>(
      "SELECT creator FROM launches_seen WHERE mint = $1",
      [mint],
    );
    return res.rows[0]?.creator ?? null;
  }
}

export class KolRepo {
  constructor(private readonly db: DbClient) {}

  async syncWallets(wallets: readonly KolWallet[]): Promise<void> {
    for (const w of wallets) {
      await this.db.query(
        `INSERT INTO kol_wallets (address, label, source, active)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (address) DO UPDATE SET label = EXCLUDED.label, source = EXCLUDED.source, active = true`,
        [w.address, w.label, w.source],
      );
      await this.db.query(
        "INSERT INTO kol_wallet_stats (address) VALUES ($1) ON CONFLICT (address) DO NOTHING",
        [w.address],
      );
    }
    if (wallets.length > 0) {
      await this.db.query(
        "UPDATE kol_wallets SET active = false WHERE NOT (address = ANY($1::text[]))",
        [wallets.map((w) => w.address)],
      );
    }
  }

  async recordTrade(t: {
    address: string;
    mint: string;
    side: "buy" | "sell";
    solAmount: number;
    signature: string | null;
  }): Promise<void> {
    await this.db.query(
      "INSERT INTO kol_trades (address, mint, side, sol_amount, signature) VALUES ($1, $2, $3, $4, $5)",
      [t.address, t.mint, t.side, t.solAmount, t.signature],
    );
    await this.db.query(
      `UPDATE kol_wallet_stats SET
         buys = buys + $2, sells = sells + $3,
         last_buy_at = CASE WHEN $2 > 0 THEN now() ELSE last_buy_at END,
         updated_at = now()
       WHERE address = $1`,
      [t.address, t.side === "buy" ? 1 : 0, t.side === "sell" ? 1 : 0],
    );
  }

  /** Distinct KOL wallets that bought the mint within the window, newest first. */
  async buyersOf(
    mint: string,
    withinMinutes: number,
  ): Promise<Array<{ address: string; ts: Date }>> {
    const res = await this.db.query<{ address: string; ts: Date }>(
      `SELECT DISTINCT ON (address) address, ts FROM kol_trades
       WHERE mint = $1 AND side = 'buy' AND ts >= now() - ($2::int * interval '1 minute')
       ORDER BY address, ts DESC`,
      [mint, withinMinutes],
    );
    return res.rows;
  }

  async tradesToday(address: string): Promise<number> {
    const res = await this.db.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM kol_trades WHERE address = $1 AND ts >= date_trunc('day', now())",
      [address],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async flag(address: string, flags: Record<string, unknown>): Promise<void> {
    await this.db.query("UPDATE kol_wallets SET flags = flags || $2::jsonb WHERE address = $1", [
      address,
      JSON.stringify(flags),
    ]);
  }
}
