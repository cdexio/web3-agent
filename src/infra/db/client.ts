export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * Minimal database interface shared by the PostgreSQL pool (runtime) and
 * PGlite (tests), so repositories and migrations have one code path.
 */
export interface DbClient {
  readonly kind: "pg" | "pglite";
  /** Single parameterised statement. */
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  /** Multi-statement script without parameters (migrations). */
  exec(script: string): Promise<void>;
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
