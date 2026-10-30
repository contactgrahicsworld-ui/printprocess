// LOCAL DEVELOPMENT / E2E ONLY. Creates an embedded PGlite database with the real migrations and demo data:
// an OWNER and a STAFF user, an active QR token and a print agent with a known secret.
// Usage: PGLITE_DATA_DIR=.pglite-dev node scripts/dev-seed.mjs [--reset]
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.PGLITE_DATA_DIR ?? ".pglite-dev";
if (process.argv.includes("--reset")) {
  await rm(join(root, dataDir), { recursive: true, force: true });
  await rm(join(root, process.env.LOCAL_STORAGE_DIR ?? ".local-storage"), { recursive: true, force: true });
}

export const SEED = {
  ownerId: "00000000-0000-4000-8000-000000000001",
  staffId: "00000000-0000-4000-8000-000000000002",
  qrToken: "dev-qr-token-mansa-0001",
  agentId: "00000000-0000-4000-8000-0000000000a1",
  agentSecret: "dev-agent-secret-do-not-use-in-production-0001",
};

await mkdir(join(root, dataDir), { recursive: true });
const pg = new PGlite(join(root, dataDir));
await pg.waitReady;
const has = await pg.query("select to_regclass('public.orders') is not null as e");
if (!has.rows[0].e) {
  await pg.exec(await readFile(join(root, "tests/helpers/supabase-stub.sql"), "utf8"));
  const dir = join(root, "../supabase/migrations");
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(".sql")).sort()) await pg.exec(await readFile(join(dir, f), "utf8"));
  console.log("migrations applied");
}
const sha = (s) => createHash("sha256").update(s).digest("hex");
await pg.query("insert into auth.users (id, email) values ($1,'owner@mansa.local'),($2,'staff@mansa.local') on conflict do nothing", [SEED.ownerId, SEED.staffId]);
await pg.query(`insert into staff_profiles (user_id, email, full_name, role) values ($1,'owner@mansa.local','Manish (Owner)','OWNER'),($2,'staff@mansa.local','Counter Staff','STAFF') on conflict do nothing`, [SEED.ownerId, SEED.staffId]);
await pg.query("insert into shop_qr_codes (token, label) select $1, 'Dev QR' where not exists (select 1 from shop_qr_codes where active)", [SEED.qrToken]);
await pg.query("insert into print_agents (id, name, secret_hash, hmac_key) values ($1, 'Dev Counter PC', $2, $2) on conflict do nothing", [SEED.agentId, sha(SEED.agentSecret)]);
await pg.query("update shop_settings set upi_id = 'mansaprinter@upi', phone = '9999999999' where id = 1");
await pg.close();
console.log(JSON.stringify(SEED, null, 2));
