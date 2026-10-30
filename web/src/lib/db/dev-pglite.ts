import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { wrapPglite } from "./pglite";
import { readMigrations } from "./migrate";
import type { Db } from "./types";

/**
 * LOCAL DEVELOPMENT / E2E ONLY: embedded Postgres (PGlite) with the real migrations applied on first start,
 * plus the Supabase auth/storage stubs from tests/helpers/supabase-stub.sql.
 */
export async function createDevPglite(dataDir?: string): Promise<Db> {
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const pg = new PGlite(dataDir);
  await pg.waitReady;
  const root = process.cwd();
  const applied = await pg.query<{ exists: boolean }>("select to_regclass('public.orders') is not null as exists");
  if (!applied.rows[0]?.exists) {
    await pg.exec(await readFile(join(root, "tests/helpers/supabase-stub.sql"), "utf8"));
    for (const m of await readMigrations(join(root, "../supabase/migrations"))) await pg.exec(m.sql);
  }
  return wrapPglite(pg);
}
