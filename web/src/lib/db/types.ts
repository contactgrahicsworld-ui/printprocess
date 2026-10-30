export type Row = Record<string, unknown>;

/** Minimal SQL interface shared by the production (postgres.js) and test (PGlite) drivers. */
export interface Db {
  query<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs fn in a transaction. Nested calls reuse the outer transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export interface PgErrorLike {
  code?: string;
  hint?: string;
  message: string;
  constraint?: string;
  constraint_name?: string;
}

export function pgError(e: unknown): PgErrorLike | null {
  if (e && typeof e === "object" && "message" in e) return e as PgErrorLike;
  return null;
}

/** True when a Postgres error was raised by our functions with the given HINT. */
export function hasHint(e: unknown, hint: string): boolean {
  return pgError(e)?.hint === hint;
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const pe = pgError(e);
  if (!pe || pe.code !== "23505") return false;
  if (!constraint) return true;
  return pe.constraint === constraint || pe.constraint_name === constraint || pe.message.includes(constraint);
}

/** Encode a JS string array as a Postgres text[] literal (pass with ::text[]). */
export function pgTextArray(values: readonly string[]): string {
  return "{" + values.map((v) => '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"').join(",") + "}";
}
