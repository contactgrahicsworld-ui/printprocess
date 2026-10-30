import { z } from "zod";
import type { AppContext } from "@/lib/context";
import type { Db } from "@/lib/db/types";
import { isUniqueViolation, pgTextArray } from "@/lib/db/types";
import { HttpError } from "@/lib/http/respond";
import { hmacHex, safeEqualHex, sha256hex } from "@/lib/security/crypto";
import { LIMITS } from "@/lib/security/ratelimit";
import { PricingError, quoteOrder, type ItemInput, type OrderQuote } from "@/lib/pricing/engine";
import { loadPriceConfig, loadShopSettings } from "./settings";
import type { UploadSession } from "./sessions";

export const itemConfigSchema = z.object({
  fileId: z.string().uuid(),
  colorMode: z.enum(["BW", "COLOR"]),
  duplex: z.enum(["SINGLE", "DOUBLE"]),
  paperSize: z.enum(["A4", "A3", "LEGAL"]),
  copies: z.number().int().min(1).max(500),
  pageRanges: z.string().max(200).nullable().default(null),
  paperTypeId: z.string().uuid().nullable().default(null),
  serviceCodes: z.array(z.string().max(32)).max(10).default([]),
  instructions: z.string().trim().max(500).nullable().default(null),
});
export type ItemConfig = z.infer<typeof itemConfigSchema>;

export const quoteSchema = z.object({
  items: z.array(itemConfigSchema).min(1).max(50),
  orderServiceCodes: z.array(z.string().max(32)).max(10).default([]),
});

export const submitSchema = quoteSchema.extend({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  customerName: z.string().trim().min(1).max(100),
  customerPhone: z.string().trim().regex(/^[6-9][0-9]{9}$/, "Enter a 10-digit mobile number").nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
  expectedTotalPaise: z.number().int().min(0),
});

interface FileRow { id: string; original_name: string; detected_mime: string; page_count: number; status: string }

async function loadSessionFiles(db: Db, sessionId: string, ids: string[]): Promise<Map<string, FileRow>> {
  const rows = await db.query<FileRow>(
    "select id, original_name, detected_mime, page_count, status from uploaded_files where session_id = $1 and id = any($2::uuid[])",
    [sessionId, pgTextArray(ids)]);
  return new Map(rows.map((r) => [r.id, r]));
}

function buildInputs(items: ItemConfig[], files: Map<string, FileRow>): ItemInput[] {
  const seen = new Set<string>();
  return items.map((it, i) => {
    if (seen.has(it.fileId)) throw new HttpError(400, "DUPLICATE_FILE", `Document ${i + 1} is listed twice`);
    seen.add(it.fileId);
    const f = files.get(it.fileId);
    if (!f) throw new HttpError(400, "FILE_NOT_FOUND", `Document ${i + 1} was not found in this session`);
    if (f.status !== "READY") throw new HttpError(409, "FILE_NOT_READY", `"${f.original_name}" has not finished uploading or was rejected`);
    return {
      pageCount: f.page_count,
      isImage: f.detected_mime !== "application/pdf",
      colorMode: it.colorMode,
      duplex: it.duplex,
      paperSize: it.paperSize,
      copies: it.copies,
      pageRanges: it.pageRanges,
      paperTypeId: it.paperTypeId,
      serviceCodes: it.serviceCodes,
    };
  });
}

function pricingErr(e: unknown): never {
  if (e instanceof PricingError) {
    throw new HttpError(422, "INVALID_CONFIG", e.itemIndex === null ? e.message : `Document ${e.itemIndex + 1}: ${e.message}`, { itemIndex: e.itemIndex });
  }
  throw e;
}

export function quoteView(q: OrderQuote, files: Map<string, FileRow>, items: ItemConfig[]) {
  return {
    items: q.items.map((iq, i) => ({ fileId: items[i]!.fileId, name: files.get(items[i]!.fileId)?.original_name ?? "", ...iq })),
    orderServiceLines: q.orderServiceLines,
    itemsTotalPaise: q.itemsTotalPaise,
    servicesTotalPaise: q.servicesTotalPaise,
    adjustmentPaise: q.adjustmentPaise,
    totalPaise: q.totalPaise,
  };
}

/** Live estimate shown to the customer (never trusted at submission). */
export async function previewQuote(ctx: AppContext, session: UploadSession, body: z.infer<typeof quoteSchema>, ip: string) {
  if (!(await ctx.rateLimiter.hit(`quote:${ip}`, LIMITS.quote.max, LIMITS.quote.window))) {
    throw new HttpError(429, "RATE_LIMITED", "Too many requests. Please slow down.");
  }
  const files = await loadSessionFiles(ctx.db, session.id, body.items.map((i) => i.fileId));
  const cfg = await loadPriceConfig(ctx.db);
  try {
    return quoteView(quoteOrder(cfg, buildInputs(body.items, files), body.orderServiceCodes), files, body.items);
  } catch (e) {
    pricingErr(e);
  }
}

/** Tracking token = HMAC(APP_SECRET, order id). Only sha256(token) is stored; re-derivable only with APP_SECRET (idempotent replay). */
export function deriveTrackingToken(secret: string, orderId: string): string {
  return Buffer.from(hmacHex(secret, `track:${orderId}`), "hex").toString("base64url");
}

export function trackUrl(appUrl: string, orderNumber: string, token: string): string {
  const u = new URL(`/t/${orderNumber}`, appUrl);
  u.searchParams.set("k", token);
  return u.toString();
}

async function replay(ctx: AppContext, db: Db, sessionId: string, key: string) {
  const r = (await db.query<{ id: string; order_number: string; status: string; total_paise: number }>(
    "select id, order_number, status, total_paise from orders where session_id = $1 and idempotency_key = $2", [sessionId, key]))[0];
  if (!r) return null;
  const token = deriveTrackingToken(ctx.config.APP_SECRET, r.id);
  return { orderId: r.id, orderNumber: r.order_number, status: r.status, totalPaise: r.total_paise, trackingToken: token, trackUrl: trackUrl(ctx.config.APP_URL, r.order_number, token), replayed: true };
}

/** Final submission. Price is recomputed server-side and must match what the customer saw. */
export async function submitOrder(ctx: AppContext, session: UploadSession, body: z.infer<typeof submitSchema>, ip: string) {
  const early = await replay(ctx, ctx.db, session.id, body.idempotencyKey);
  if (early) return early;
  if (!(await ctx.rateLimiter.hit(`submit:${ip}`, LIMITS.submit.max, LIMITS.submit.window))) {
    throw new HttpError(429, "RATE_LIMITED", "Too many submissions. Please wait a few minutes.");
  }
  try {
    return await ctx.db.tx(async (tx) => {
      const s = (await tx.query<{ status: string; expires_at: Date }>(
        "select status, expires_at from upload_sessions where id = $1 for update", [session.id]))[0];
      if (!s) throw new HttpError(401, "SESSION_INVALID", "Session not found");
      const again = await replay(ctx, tx, session.id, body.idempotencyKey);
      if (again) return again;
      if (s.status !== "OPEN") throw new HttpError(409, "SESSION_CLOSED", "This upload session was already submitted.");
      if (new Date(s.expires_at).getTime() < ctx.now().getTime()) throw new HttpError(401, "SESSION_EXPIRED", "Session expired. Please scan the QR again.");

      const pending = (await tx.query<{ n: number }>(
        "select count(*)::int as n from uploaded_files where session_id = $1 and status = 'PENDING_UPLOAD'", [session.id]))[0]!.n;
      if (pending > 0) throw new HttpError(409, "UPLOAD_INCOMPLETE", "Some files are still uploading. Wait for them to finish or remove them.");

      const files = await loadSessionFiles(tx, session.id, body.items.map((i) => i.fileId));
      const inputs = buildInputs(body.items, files);
      const cfg = await loadPriceConfig(tx);
      let q: OrderQuote;
      try {
        q = quoteOrder(cfg, inputs, body.orderServiceCodes);
      } catch (e) {
        pricingErr(e);
      }
      if (q.totalPaise !== body.expectedTotalPaise) {
        throw new HttpError(409, "PRICE_MISMATCH", "The price has changed. Please review the updated total and submit again.",
          { quote: quoteView(q, files, body.items) });
      }

      const orderNumber = (await tx.query<{ n: string }>("select public.next_order_number($1) as n", [ctx.now()]))[0]!.n;
      const orderId = crypto.randomUUID();
      const token = deriveTrackingToken(ctx.config.APP_SECRET, orderId);
      await tx.query(
        `insert into orders (id, order_number, session_id, idempotency_key, customer_name, customer_phone, notes, tracking_token_hash,
                             items_total_paise, services_total_paise, adjustment_paise, total_paise, order_services)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
        [orderId, orderNumber, session.id, body.idempotencyKey, body.customerName, body.customerPhone, body.notes, sha256hex(token),
          q.itemsTotalPaise, q.servicesTotalPaise, q.adjustmentPaise, q.totalPaise,
          JSON.stringify({ codes: [...new Set(body.orderServiceCodes)], lines: q.orderServiceLines })]);
      for (let i = 0; i < body.items.length; i++) {
        const it = body.items[i]!;
        const iq = q.items[i]!;
        await tx.query(
          `insert into order_items (order_id, file_id, position, color_mode, duplex, paper_size, copies, page_ranges, paper_type_id,
                                    service_codes, instructions, pages_total, pages_selected, sheets_per_copy, total_sheets, printed_sides,
                                    price_paise, price_breakdown)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,$13,$14,$15,$16,$17,$18::jsonb)`,
          [orderId, it.fileId, i + 1, it.colorMode, it.duplex, it.paperSize, it.copies, iq.normalizedRanges, it.paperTypeId,
            pgTextArray([...new Set(it.serviceCodes)]), it.instructions, iq.pagesTotal, iq.pagesSelected, iq.sheetsPerCopy, iq.totalSheets,
            iq.printedSides, iq.totalPaise, JSON.stringify({ sideRatePaise: iq.sideRatePaise, lines: iq.lines })]);
      }
      await tx.query("insert into order_status_history (order_id, from_status, to_status, reason) values ($1, null, 'RECEIVED', 'Submitted by customer')", [orderId]);
      await tx.query("update upload_sessions set status = 'SUBMITTED', submitted_at = now() where id = $1", [session.id]);
      return { orderId, orderNumber, status: "RECEIVED", totalPaise: q.totalPaise, trackingToken: token, trackUrl: trackUrl(ctx.config.APP_URL, orderNumber, token), replayed: false };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const r = await replay(ctx, ctx.db, session.id, body.idempotencyKey);
      if (r) return r;
      throw new HttpError(409, "SESSION_CLOSED", "This upload session was already submitted.");
    }
    throw e;
  }
}

// ---------------------------------------------------------------- customer tracking
export const trackSchema = z.object({
  orderNumber: z.string().trim().toUpperCase().max(32),
  token: z.string().trim().max(128),
});

const DUMMY_HASH = sha256hex("dummy-tracking-token-for-constant-time");
const NOT_FOUND = () => new HttpError(404, "NOT_FOUND", "Order not found or the tracking link is invalid. / Order nahin mila.");

/** Verifies order number + token without revealing which part was wrong. */
export async function verifyTracking(ctx: AppContext, orderNumber: string, token: string, ip: string): Promise<string> {
  if (!(await ctx.rateLimiter.hit(`track:${ip}`, LIMITS.track.max, LIMITS.track.window))) {
    throw new HttpError(429, "RATE_LIMITED", "Too many attempts. Please wait a few minutes.");
  }
  const r = /^MP-[0-9]{8}-[0-9]{4,}$/.test(orderNumber)
    ? (await ctx.db.query<{ id: string; tracking_token_hash: string }>("select id, tracking_token_hash from orders where order_number = $1", [orderNumber]))[0]
    : undefined;
  const ok = safeEqualHex(sha256hex(token), r?.tracking_token_hash ?? DUMMY_HASH);
  if (!r || !ok) throw NOT_FOUND();
  return r.id;
}

export async function trackOrderView(ctx: AppContext, orderId: string) {
  const o = (await ctx.db.query<Record<string, unknown>>("select * from orders where id = $1", [orderId]))[0]!;
  const items = await ctx.db.query<Record<string, unknown>>(
    `select i.*, f.original_name, f.detected_mime, pt.name as paper_type_name from order_items i
       join uploaded_files f on f.id = i.file_id left join paper_types pt on pt.id = i.paper_type_id
      where i.order_id = $1 order by i.position`, [orderId]);
  const history = await ctx.db.query<{ to_status: string; created_at: Date }>(
    "select to_status, created_at from order_status_history where order_id = $1 order by created_at, id", [orderId]);
  const shop = await loadShopSettings(ctx.db);
  const due = Number(o.due_paise);
  const upiUri = shop.upiId && due > 0 && o.status !== "CANCELLED"
    ? `upi://pay?pa=${encodeURIComponent(shop.upiId)}&pn=${encodeURIComponent(shop.upiPayeeName ?? shop.shopName)}&am=${(due / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(String(o.order_number))}`
    : null;
  return {
    orderNumber: o.order_number as string,
    status: o.status as string,
    createdAt: new Date(o.created_at as string).toISOString(),
    customerName: o.customer_name as string,
    rejectionReason: (o.status === "CANCELLED" ? (o.rejection_reason as string | null) : null) ?? null,
    timeline: history.map((h) => ({ status: h.to_status, at: new Date(h.created_at).toISOString() })),
    items: items.map((i) => ({
      name: i.original_name as string,
      pagesTotal: i.pages_total as number,
      pagesSelected: i.pages_selected as number,
      pageRanges: (i.page_ranges as string | null) ?? null,
      colorMode: i.color_mode as string,
      duplex: i.duplex as string,
      paperSize: i.paper_size as string,
      paperType: (i.paper_type_name as string | null) ?? null,
      copies: i.copies as number,
      totalSheets: i.total_sheets as number,
      pricePaise: i.price_paise as number,
    })),
    orderServices: ((o.order_services as { lines?: unknown[] })?.lines ?? []) as { label: string; amountPaise: number }[],
    adjustmentPaise: Number(o.adjustment_paise),
    totalPaise: Number(o.total_paise),
    paidPaise: Number(o.paid_paise),
    duePaise: due,
    shop: { name: shop.shopName, address: shop.address, phone: shop.phone },
    upiUri,
    paymentClaim: (o.payment_claim as { method: string; reference: string; note: string | null; at: string } | null) ?? null,
    razorpayEnabled: ctx.config.razorpayEnabled && due > 0 && !["CANCELLED", "DELIVERED"].includes(o.status as string),
  };
}
