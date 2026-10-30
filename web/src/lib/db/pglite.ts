import type { PGlite, Transaction } from "@electric-sql/pglite";
import type { Db, Row } from "./types";

type Q = PGlite | Transaction;

export function wrapPglite(pg: Q, inTx = false): Db {
  return {
    async query<T = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const res = await pg.query<T>(text, params as unknown[]);
      return res.rows;
    },
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      if (inTx) return fn(wrapPglite(pg, true));
      return (pg as PGlite).transaction((t) => fn(wrapPglite(t, true)));
    },
  };
}
