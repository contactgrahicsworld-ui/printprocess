import type { AppContext } from "@/lib/context";
import { HttpError } from "@/lib/http/respond";
import { randomToken, sha256hex } from "@/lib/security/crypto";
import { LIMITS } from "@/lib/security/ratelimit";
import { resolveQrToken } from "./qr";
import { loadPriceConfig, loadShopSettings, publicCatalog } from "./settings";

export interface UploadSession { id: string; qrCodeId: string; status: "OPEN" | "SUBMITTED" | "EXPIRED"; expiresAt: Date }

export const SESSION_HEADER = "x-session-token";

export async function createUploadSession(ctx: AppContext, qrToken: string, ip: string) {
  if (!(await ctx.rateLimiter.hit(`session:${ip}`, LIMITS.sessionCreate.max, LIMITS.sessionCreate.window))) {
    throw new HttpError(429, "RATE_LIMITED", "Too many attempts. Please wait a few minutes. / Kuch der baad koshish karein.");
  }
  const qr = await resolveQrToken(ctx.db, qrToken);
  if (!qr) throw new HttpError(404, "QR_INVALID", "This QR code is no longer active. Please scan the latest QR at the counter.");
  const shop = await loadShopSettings(ctx.db);
  const token = randomToken(32);
  const expiresAt = new Date(ctx.now().getTime() + shop.sessionTtlMinutes * 60_000);
  await ctx.db.query(
    "insert into upload_sessions (token_hash, qr_code_id, ip_hash, expires_at) values ($1, $2, $3, $4)",
    [sha256hex(token), qr.id, sha256hex(`${ctx.config.APP_SECRET}:${ip}`), expiresAt],
  );
  const cfg = await loadPriceConfig(ctx.db);
  return {
    sessionToken: token,
    expiresAt: expiresAt.toISOString(),
    limits: { maxFileBytes: shop.maxFileBytes, maxFiles: shop.maxFiles },
    shop: { name: shop.shopName, address: shop.address },
    catalog: publicCatalog(cfg),
  };
}

/** Loads an OPEN, unexpired session from the raw token in the X-Session-Token header. */
export async function requireSession(ctx: AppContext, req: Request, opts: { allowSubmitted?: boolean } = {}): Promise<UploadSession> {
  const raw = req.headers.get(SESSION_HEADER) ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new HttpError(401, "SESSION_INVALID", "Session expired. Please scan the QR again.");
  const r = (await ctx.db.query<{ id: string; qr_code_id: string; status: UploadSession["status"]; expires_at: Date; qr_active: boolean }>(
    `select s.id, s.qr_code_id, s.status, s.expires_at, q.active as qr_active
       from upload_sessions s join shop_qr_codes q on q.id = s.qr_code_id where s.token_hash = $1`,
    [sha256hex(raw)]))[0];
  if (!r) throw new HttpError(401, "SESSION_INVALID", "Session expired. Please scan the QR again.");
  const s: UploadSession = { id: r.id, qrCodeId: r.qr_code_id, status: r.status, expiresAt: new Date(r.expires_at) };
  if (s.status === "SUBMITTED" && opts.allowSubmitted) return s;
  if (s.status !== "OPEN") throw new HttpError(409, "SESSION_CLOSED", "This upload session is already submitted. Scan the QR to start a new order.");
  if (s.expiresAt.getTime() < ctx.now().getTime()) throw new HttpError(401, "SESSION_EXPIRED", "Session expired. Please scan the QR again.");
  return s;
}

export async function getSessionState(ctx: AppContext, session: UploadSession) {
  const shop = await loadShopSettings(ctx.db);
  const files = await ctx.db.query<Record<string, unknown>>(
    `select id, original_name, size_bytes, detected_mime, page_count, status, scan_status, reject_reason
       from uploaded_files where session_id = $1 and status in ('PENDING_UPLOAD','READY','REJECTED') order by created_at`, [session.id]);
  const cfg = await loadPriceConfig(ctx.db);
  return {
    expiresAt: session.expiresAt.toISOString(),
    limits: { maxFileBytes: shop.maxFileBytes, maxFiles: shop.maxFiles },
    shop: { name: shop.shopName, address: shop.address },
    catalog: publicCatalog(cfg),
    files: files.map(fileView),
  };
}

export function fileView(r: Record<string, unknown>) {
  return {
    id: r.id as string,
    name: r.original_name as string,
    sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
    mimeType: (r.detected_mime as string | null) ?? null,
    pageCount: (r.page_count as number | null) ?? null,
    status: r.status as string,
    scanStatus: r.scan_status as string,
    rejectReason: (r.reject_reason as string | null) ?? null,
  };
}
export type FileView = ReturnType<typeof fileView>;
