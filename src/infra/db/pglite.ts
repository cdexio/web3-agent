import type { DbClient, QueryResult } from "./client.js";

interface PgliteLike {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(script: string): Promise<unknown>;
  transaction<T>(fn: (tx: PgliteLike) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PgliteTx implements DbClient {
  readonly kind = "pglite" as const;
  constructor(private readonly tx: PgliteLike) {}

  async query<T>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.tx.query<T>(text, [...params]);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  }

  async exec(script: string): Promise<void> {
    await this.tx.exec(script);
  }

  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}
}

/**
 * In-process PostgreSQL (WASM) for tests only. Loaded dynamically so the
 * runtime bundle never depends on it.
 */
export class PgliteDb implements DbClient {
  readonly kind = "pglite" as const;
  private constructor(private readonly db: PgliteLike) {}

  static async create(): Promise<PgliteDb> {
    const mod = (await import("@electric-sql/pglite")) as unknown as {
      PGlite: new () => PgliteLike;
    };
    const db = new mod.PGlite();
    return new PgliteDb(db);
  }

  async query<T>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.db.query<T>(text, [...params]);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  }

  async exec(script: string): Promise<void> {
    await this.db.exec(script);
  }

  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new PgliteTx(tx)));
  }

  close(): Promise<void> {
    return this.db.close();
  }
}
