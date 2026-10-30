import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Reads supabase/migrations/*.sql in filename order. Used by tests and the local PGlite dev driver. */
export async function readMigrations(migrationsDir: string): Promise<{ name: string; sql: string }[]> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(files.map(async (name) => ({ name, sql: await readFile(join(migrationsDir, name), "utf8") })));
}
