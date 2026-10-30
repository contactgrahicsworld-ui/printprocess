import { describe, expect, it, beforeAll } from "vitest";
import { createTestDb } from "../helpers/harness";
import type { Db } from "@/lib/db/types";
import type { PGlite } from "@electric-sql/pglite";
import { ORDER_STATUSES, ORDER_TRANSITIONS } from "@/lib/orders/status";

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await createTestDb());
});

describe("migrations (PGlite)", () => {
  it("apply cleanly and seed defaults", async () => {
    const p = await db.query<{ bw_single_side_paise: number }>("select * from price_settings");
    expect(p[0]!.bw_single_side_paise).toBe(200);
    expect((await db.query("select * from paper_size_rates")).length).toBe(3);
    expect((await db.query("select * from services where active")).length).toBe(3);
    const b = await db.query<{ public: boolean; file_size_limit: number }>("select public, file_size_limit from storage.buckets where id = 'print-files'");
    expect(b[0]!.public).toBe(false);
  });

  it("enables RLS on every public table", async () => {
    const rows = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'");
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) expect(r.relrowsecurity, r.relname).toBe(true);
  });

  it("generates per-day order numbers MP-YYYYMMDD-NNNN (Asia/Kolkata day) without duplicates under concurrency", async () => {
    const at = "2026-10-30T20:00:00Z"; // = 31 Oct 01:30 IST
    const results = await Promise.all(Array.from({ length: 25 }, () => db.query<{ n: string }>("select next_order_number($1::timestamptz) as n", [at])));
    const nums = results.map((r) => r[0]!.n);
    expect(new Set(nums).size).toBe(25);
    expect(nums.every((n) => n.startsWith("MP-20261031-"))).toBe(true);
    expect(nums.sort()[0]).toBe("MP-20261031-0001");
    const other = await db.query<{ n: string }>("select next_order_number('2026-11-01T06:00:00Z'::timestamptz) as n");
    expect(other[0]!.n).toBe("MP-20261101-0001");
  });

  it("SQL order transition function matches the TypeScript state machine exactly", async () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const r = await db.query<{ ok: boolean }>("select order_transition_allowed($1::order_status, $2::order_status) as ok", [from, to]);
        expect(r[0]!.ok, `${from}->${to}`).toBe(ORDER_TRANSITIONS[from].includes(to));
      }
    }
  });

  it("rate_limit_hit allows max hits per window", async () => {
    const res: boolean[] = [];
    for (let i = 0; i < 4; i++) res.push((await db.query<{ ok: boolean }>("select rate_limit_hit('k1', 3, 60) as ok"))[0]!.ok);
    expect(res).toEqual([true, true, true, false]);
  });

  it("anon role has no direct table access", async () => {
    await pg.exec("set role anon");
    try {
      for (const t of ["orders", "uploaded_files", "print_agents", "price_settings", "upload_sessions", "audit_logs"]) {
        await expect(pg.query(`select * from public.${t} limit 1`), t).rejects.toThrow(/permission denied/);
      }
      await expect(pg.query("select public.claim_print_jobs(gen_random_uuid(), '{}', 5)")).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec("reset role");
    }
  });
});
