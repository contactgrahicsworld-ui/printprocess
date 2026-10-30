import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestEnv, seedQr, seedStaff, type TestEnv } from "../helpers/harness";
import { submitSimpleOrder } from "../helpers/flows";

/**
 * Exercises the real RLS policies as Supabase would: SET ROLE authenticated + request.jwt.claims (sub = user id).
 * This is exactly what PostgREST/Realtime do for browser clients using the anon key + a user JWT.
 */
let env: TestEnv;
let pg: PGlite;
let ids: Record<"owner" | "admin" | "staff" | "inactive" | "outsider", string>;

async function as<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
  await pg.exec(userId ? "set role authenticated" : "set role anon");
  await pg.query("select set_config('request.jwt.claims', $1, false)", [userId ? JSON.stringify({ sub: userId, role: "authenticated" }) : ""]);
  try {
    return await fn();
  } finally {
    await pg.exec("reset role");
    await pg.query("select set_config('request.jwt.claims', '', false)");
  }
}

beforeAll(async () => {
  env = await createTestEnv();
  pg = env.pg;
  ids = {
    owner: await seedStaff(env.db, "OWNER"),
    admin: await seedStaff(env.db, "ADMIN"),
    staff: await seedStaff(env.db, "STAFF"),
    inactive: await seedStaff(env.db, "ADMIN", "inactive"),
    outsider: crypto.randomUUID(),
  };
  await env.db.query("update staff_profiles set active = false where user_id = $1", [ids.inactive]);
  await env.db.query("insert into auth.users (id, email) values ($1, 'random@gmail.test')", [ids.outsider]);
  const qr = await seedQr(env.db);
  await submitSimpleOrder(qr);
  await env.db.query("insert into print_agents (name, secret_hash, hmac_key) values ('A', 'h', 'k')");
});

afterEach(async () => {
  await pg.exec("reset role");
});

describe("RLS: anon", () => {
  it("anon cannot read or write any table", async () => {
    for (const t of ["orders", "order_items", "uploaded_files", "payments", "staff_profiles", "price_settings", "print_jobs"]) {
      await expect(as(null, () => pg.query(`select * from public.${t}`)), t).rejects.toThrow(/permission denied/);
    }
    await expect(as(null, () => pg.query("insert into public.payments (order_id, method, amount_paise) values (gen_random_uuid(), 'CASH', 1)"))).rejects.toThrow(/permission denied/);
  });
});

describe("RLS: authenticated non-staff", () => {
  it("a signed-in user without a staff profile sees nothing", async () => {
    expect((await as(ids.outsider, () => pg.query("select * from public.orders"))).rows).toHaveLength(0);
    expect((await as(ids.outsider, () => pg.query("select * from public.uploaded_files"))).rows).toHaveLength(0);
    expect((await as(ids.inactive, () => pg.query("select * from public.orders"))).rows).toHaveLength(0);
  });
  it("cannot update orders", async () => {
    const r = await as(ids.outsider, () => pg.query("update public.orders set status = 'APPROVED' returning id"));
    expect(r.rows).toHaveLength(0);
  });
});

describe("RLS: STAFF role", () => {
  it("can read operational data (dashboard + Realtime)", async () => {
    expect((await as(ids.staff, () => pg.query("select * from public.orders"))).rows.length).toBeGreaterThan(0);
    expect((await as(ids.staff, () => pg.query("select * from public.order_items"))).rows.length).toBeGreaterThan(0);
  });
  it("cannot change prices, paper types, services, shop settings, QR codes", async () => {
    expect((await as(ids.staff, () => pg.query("update public.price_settings set bw_single_side_paise = 1 returning id"))).rows).toHaveLength(0);
    await expect(as(ids.staff, () => pg.query("insert into public.services (code, name, unit, amount_paise) values ('FREE', 'x', 'PER_ORDER', 0)"))).rejects.toThrow(/row-level security/);
    expect((await as(ids.staff, () => pg.query("update public.shop_settings set upi_id = 'thief@upi' returning id"))).rows).toHaveLength(0);
    expect((await as(ids.staff, () => pg.query("delete from public.paper_types returning id"))).rows).toHaveLength(0);
    expect((await env.db.query<{ bw_single_side_paise: number }>("select bw_single_side_paise from price_settings"))[0]!.bw_single_side_paise).toBe(200);
  });
  it("cannot grant itself OWNER or create staff", async () => {
    expect((await as(ids.staff, () => pg.query("update public.staff_profiles set role = 'OWNER' where user_id = $1 returning user_id", [ids.staff]))).rows).toHaveLength(0);
    await expect(as(ids.staff, () => pg.query("insert into public.staff_profiles (user_id, email, role) values ($1, 'x', 'OWNER')", [ids.outsider]))).rejects.toThrow(/row-level security/);
  });
  it("cannot read print agents at all, nor audit logs", async () => {
    expect((await as(ids.staff, () => pg.query("select id, name from public.print_agents"))).rows).toHaveLength(0);
    expect((await as(ids.staff, () => pg.query("select * from public.audit_logs"))).rows).toHaveLength(0);
  });
  it("cannot insert payments, print jobs or order money fields directly", async () => {
    await expect(as(ids.staff, () => pg.query("insert into public.payments (order_id, method, amount_paise) select id, 'CASH', 1 from public.orders limit 1"))).rejects.toThrow(/permission denied/);
    await expect(as(ids.staff, () => pg.query("update public.orders set paid_paise = total_paise"))).rejects.toThrow(/permission denied/);
    await expect(as(ids.staff, () => pg.query("update public.orders set total_paise = 0"))).rejects.toThrow(/permission denied/);
  });
  it("status updates through RLS still hit the transition trigger", async () => {
    await expect(as(ids.staff, () => pg.query("update public.orders set status = 'DELIVERED'"))).rejects.toThrow(/invalid order status transition/);
  });
});

describe("RLS: ADMIN / OWNER", () => {
  it("ADMIN can change prices but can never read agent secrets", async () => {
    expect((await as(ids.admin, () => pg.query("update public.price_settings set bw_single_side_paise = 250 returning id"))).rows).toHaveLength(1);
    await env.db.query("update price_settings set bw_single_side_paise = 200");
    expect((await as(ids.admin, () => pg.query("select id, name, last_heartbeat_at from public.print_agents"))).rows).toHaveLength(1);
    await expect(as(ids.admin, () => pg.query("select hmac_key from public.print_agents"))).rejects.toThrow(/permission denied/);
    await expect(as(ids.owner, () => pg.query("select secret_hash from public.print_agents"))).rejects.toThrow(/permission denied/);
  });
  it("ADMIN cannot manage staff; OWNER can", async () => {
    expect((await as(ids.admin, () => pg.query("update public.staff_profiles set role = 'OWNER' where user_id = $1 returning user_id", [ids.admin]))).rows).toHaveLength(0);
    expect((await as(ids.owner, () => pg.query("update public.staff_profiles set full_name = 'Renamed' where user_id = $1 returning user_id", [ids.staff]))).rows).toHaveLength(1);
  });
  it("nobody can tamper with the audit log or job events (append-only)", async () => {
    await env.db.query("insert into audit_logs (action, entity_type) values ('test', 'test')");
    await env.db.query("insert into payments (order_id, method, amount_paise) select id, 'CASH', 100 from orders limit 1");
    await expect(as(ids.owner, () => pg.query("delete from public.audit_logs"))).rejects.toThrow(/permission denied/);
    await expect(env.db.query("truncate audit_logs")).rejects.toThrow(/append-only/);
    await expect(env.db.query("delete from audit_logs")).rejects.toThrow(/append-only/);
    await expect(env.db.query("update payments set amount_paise = 1")).rejects.toThrow(/append-only/);
  });
  it("storage objects: staff policy only; anon has no access", async () => {
    await env.db.query("insert into storage.objects (bucket_id, name) values ('print-files', 'sessions/x/y')");
    expect((await as(ids.staff, () => pg.query("select * from storage.objects"))).rows).toHaveLength(1);
    expect((await as(ids.outsider, () => pg.query("select * from storage.objects"))).rows).toHaveLength(0);
    expect((await as(null, () => pg.query("select * from storage.objects"))).rows).toHaveLength(0);
  });
});
