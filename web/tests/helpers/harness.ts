import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import QRCode from "qrcode";
import { wrapPglite } from "@/lib/db/pglite";
import { readMigrations } from "@/lib/db/migrate";
import { loadConfig } from "@/lib/config";
import { setContext, type AppContext } from "@/lib/context";
import { createLocalStorage, memoryBackend } from "@/lib/storage/local";
import { postgresRateLimiter, type RateLimiter } from "@/lib/security/ratelimit";
import { noopScanner, type Scanner } from "@/lib/files/scan";
import { loadActiveStaff } from "@/lib/auth/staff-lookup";
import type { Db } from "@/lib/db/types";
import type { StaffRole } from "@/lib/auth/types";
import { hmacHex, sha256hex } from "@/lib/security/crypto";

export const APP_URL = "http://localhost:3000";
export const ROOT = join(__dirname, "..", "..");

/** Fresh PGlite database with Supabase stubs + all real migrations applied. */
export async function createTestDb(): Promise<{ pg: PGlite; db: Db }> {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(await readFile(join(ROOT, "tests/helpers/supabase-stub.sql"), "utf8"));
  for (const m of await readMigrations(join(ROOT, "../supabase/migrations"))) {
    try {
      await pg.exec(m.sql);
    } catch (e) {
      throw new Error(`migration ${m.name} failed: ${(e as Error).message}`);
    }
  }
  return { pg, db: wrapPglite(pg) };
}

export interface TestEnv {
  pg: PGlite;
  db: Db;
  ctx: AppContext;
  files: Map<string, Uint8Array>;
  clock: { now: number };
}

export async function createTestEnv(opts: { env?: Record<string, string>; rateLimiter?: RateLimiter; scanner?: Scanner } = {}): Promise<TestEnv> {
  const { pg, db } = await createTestDb();
  const clock = { now: Date.now() };
  const backend = memoryBackend();
  const config = loadConfig({
    NODE_ENV: "test",
    APP_URL,
    APP_SECRET: "test-secret-0123456789-abcdefghijklmnop",
    DB_DRIVER: "pglite",
    STORAGE_DRIVER: "local",
    AUTH_DRIVER: "dev",
    CRON_SECRET: "cron-secret-0123456789",
    ...opts.env,
  });
  const ctx: AppContext = {
    config,
    db,
    storage: createLocalStorage({ baseUrl: APP_URL, secret: config.APP_SECRET, backend, now: () => clock.now }),
    auth: {
      // Test auth: "x-test-staff: <user uuid>" -> must be an ACTIVE staff_profiles row (same lookup as production).
      async getStaff(req) {
        const id = req.headers.get("x-test-staff");
        return id ? loadActiveStaff(db, id) : null;
      },
    },
    rateLimiter: opts.rateLimiter ?? postgresRateLimiter(db),
    scanner: opts.scanner ?? noopScanner,
    now: () => new Date(clock.now),
  };
  setContext(ctx);
  return { pg, db, ctx, files: backend.files, clock };
}

export async function seedStaff(db: Db, role: StaffRole, name = role.toLowerCase()): Promise<string> {
  const id = crypto.randomUUID();
  await db.query("insert into auth.users (id, email) values ($1, $2)", [id, `${name}-${id.slice(0, 6)}@mansa.test`]);
  await db.query("insert into staff_profiles (user_id, email, full_name, role) values ($1, $2, $3, $4)", [id, `${name}@mansa.test`, `Test ${name}`, role]);
  return id;
}

export async function seedQr(db: Db): Promise<string> {
  const token = "qr_" + crypto.randomUUID().replace(/-/g, "");
  await db.query("update shop_qr_codes set active = false where active");
  await db.query("insert into shop_qr_codes (token) values ($1)", [token]);
  return token;
}

// ---------------------------------------------------------------- HTTP helpers
type Handler = (req: Request, ctx: { params: Promise<Record<string, string | string[]>> }) => Promise<Response>;

export interface CallOpts {
  method?: string;
  body?: unknown;
  rawBody?: string | Uint8Array;
  headers?: Record<string, string>;
  params?: Record<string, string | string[]>;
  staff?: string;
  session?: string;
  ip?: string;
}

export async function call(handler: unknown, url: string, opts: CallOpts = {}): Promise<{ status: number; body: any; res: Response }> {
  const headers: Record<string, string> = { "x-real-ip": opts.ip ?? "203.0.113.10", ...opts.headers };
  if (opts.staff) {
    headers["x-test-staff"] = opts.staff;
    headers.origin = APP_URL;
  }
  if (opts.session) headers["x-session-token"] = opts.session;
  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody as BodyInit;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  const req = new Request(new URL(url, APP_URL), { method: opts.method ?? (body ? "POST" : "GET"), headers, body });
  const res = await (handler as Handler)(req, { params: Promise.resolve(opts.params ?? {}) });
  const ct = res.headers.get("content-type") ?? "";
  const out = ct.includes("json") ? await res.json() : new Uint8Array(await res.arrayBuffer());
  return { status: res.status, body: out, res };
}

/** Signs an agent request exactly as CONTRACT.md specifies. */
export function agentHeaders(agentId: string, secret: string, method: string, path: string, body: string, opts: { ts?: number; nonce?: string; key?: string } = {}) {
  const key = opts.key ?? sha256hex(secret);
  const ts = String(opts.ts ?? Date.now());
  const nonce = opts.nonce ?? crypto.randomUUID();
  const sig = hmacHex(key, `${method}\n${path}\n${ts}\n${nonce}\n${sha256hex(body)}`);
  return { "x-agent-id": agentId, "x-agent-timestamp": ts, "x-agent-nonce": nonce, "x-agent-signature": sig, "content-type": "application/json" };
}

// ---------------------------------------------------------------- fixtures
export async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage([595, 842]).drawText(`Page ${i}`, { x: 50, y: 800, size: 24, font });
  return doc.save();
}

/** A PDF whose trailer references an /Encrypt dictionary (how password-protected PDFs look to a parser). */
export async function makeEncryptedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage();
  const enc = doc.context.obj({ Filter: PDFName.of("Standard"), V: 2, R: 3, Length: 128, P: -44 });
  doc.context.trailerInfo.Encrypt = doc.context.register(enc);
  return doc.save({ useObjectStreams: false });
}

export async function makePng(): Promise<Uint8Array> {
  return new Uint8Array(await QRCode.toBuffer("hello", { type: "png", width: 64 }));
}

export function makeJpeg(): Uint8Array {
  // SOI, APP0(JFIF), SOF0 (8-bit, 16x16, 1 component), EOI — structurally valid header for signature/structure checks.
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
