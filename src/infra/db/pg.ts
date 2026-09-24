import pg from "pg";
import type { DbClient, QueryResult } from "./client.js";

export interface PgOptions {
  connectionString: string;
  poolMax: number;
  statementTimeoutMs: number;
}

class TxClient implements DbClient {
  readonly kind = "pg" as const;
  constructor(private readonly client: pg.PoolClient) {}

  async query<T>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.client.query(text, params as unknown[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
  }

  async exec(script: string): Promise<void> {
    // No parameters => simple query protocol, which allows several statements.
    await this.client.query(script);
  }

  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    // Nested transactions are flattened onto the outer one.
    return fn(this);
  }

  async close(): Promise<void> {
    // The owning PgDb releases the client.
  }
}

export class PgDb implements DbClient {
  readonly kind = "pg" as const;
  private readonly pool: pg.Pool;

  constructor(opts: PgOptions) {
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.poolMax,
      statement_timeout: opts.statementTimeoutMs,
      application_name: "zetrynai",
    });
  }

  async query<T>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(text, params as unknown[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
  }

  async exec(script: string): Promise<void> {
    await this.pool.query(script);
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new TxClient(client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
