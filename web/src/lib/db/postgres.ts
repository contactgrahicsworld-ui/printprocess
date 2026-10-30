import postgres from "postgres";
import type { Db, Row } from "./types";

type Sql = postgres.Sql | postgres.TransactionSql;

function wrap(sql: Sql, inTx: boolean): Db {
  return {
    async query<T = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const rows = await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as T[];
    },
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      if (inTx) return fn(wrap(sql, true));
      return (await (sql as postgres.Sql).begin((t) => fn(wrap(t, true)))) as T;
    },
  };
}

/**
 * Production driver. DATABASE_URL should be the Supabase pooler connection string
 * (transaction mode, port 6543). This role bypasses RLS (table owner) and must stay server-only.
 */
export function createPostgresDb(url: string): Db {
  const sql = postgres(url, {
    prepare: false, // required for Supabase transaction pooler (pgbouncer/supavisor)
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return wrap(sql, false);
}
