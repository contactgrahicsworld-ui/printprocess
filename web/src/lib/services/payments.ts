import { z } from "zod";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { AppContext } from "@/lib/context";
import type { Db } from "@/lib/db/types";
import { hasHint, isUniqueViolation } from "@/lib/db/types";
import type { Staff } from "@/lib/auth/types";
import { HttpError } from "@/lib/http/respond";
import { hmacHex, safeEqualHex } from "@/lib/security/crypto";
import { LIMITS } from "@/lib/security/ratelimit";
import { audit } from "./audit";
import { loadShopSettings } from "./settings";

export const paymentSchema = z.object({
  method: z.enum(["CASH", "UPI", "ONLINE"]),
  amountPaise: z.number().int().positive().max(100_000_000),
  reference: z.string().trim().max(100).nullable().default(null),
  note: z.string().trim().max(300).nullable().default(null),
}).superRefine((v, c) => {
  if (v.method === "UPI" && !v.reference) c.addIssue({ code: "custom", path: ["reference"], message: "UPI reference (UTR) is required" });
  if (v.method === "ONLINE" && !v.reference) c.addIssue({ code: "custom", path: ["reference"], message: "Transaction reference is required" });
});

/** Staff-confirmed payment (partial payments allowed; can never exceed the due amount — enforced by DB trigger). */
export async function recordPayment(ctx: AppContext, staff: Staff, orderId: string, input: z.infer<typeof paymentSchema>, ip: string) {
  return ctx.db.tx(async (tx) => {
    const o = (await tx.query<{ status: string; due_paise: number }>("select status, due_paise from orders where id = $1 for update", [orderId]))[0];
    if (!o) throw new HttpError(404, "NOT_FOUND", "Order not found");
    if (o.status === "CANCELLED") throw new HttpError(409, "ORDER_CANCELLED", "Cannot take payment for a cancelled order");
    if (input.amountPaise > o.due_paise) throw new HttpError(409, "OVERPAYMENT", `Amount exceeds due balance (₹${(o.due_paise / 100).toFixed(2)})`);
    let p: { id: string };
    try {
      p = (await tx.query<{ id: string }>(
        "insert into payments (order_id, method, amount_paise, reference, note, recorded_by) values ($1,$2,$3,$4,$5,$6) returning id",
        [orderId, input.method, input.amountPaise, input.reference, input.note, staff.userId]))[0]!;
    } catch (e) {
      if (hasHint(e, "OVERPAYMENT")) throw new HttpError(409, "OVERPAYMENT", "Amount exceeds due balance");
      throw e;
    }
    await audit(tx, staff, "payment.record", "payment", p.id, { orderId, ...input }, ip);
    const after = (await tx.query<{ paid_paise: number; due_paise: number }>("select paid_paise, due_paise from orders where id = $1", [orderId]))[0]!;
    return { paymentId: p.id, paidPaise: after.paid_paise, duePaise: after.due_paise };
  });
}

// ---------------------------------------------------------------- customer UPI claim
export const claimSchema = z.object({
  reference: z.string().trim().min(4, "UTR must be at least 4 characters").max(100),
  note: z.string().trim().max(300).nullable().default(null),
});

/**
 * Customer says "I have paid to the shop's UPI QR" — stores the UTR claim on the order.
 * Staff see it in the admin order panel and record the payment after verifying in their UPI app.
 */
export async function claimUpiPayment(ctx: AppContext, orderId: string, input: z.infer<typeof claimSchema>, ip: string) {
  if (!(await ctx.rateLimiter.hit(`claim:${ip}`, LIMITS.claim.max, LIMITS.claim.window))) {
    throw new HttpError(429, "RATE_LIMITED", "Too many attempts. Please wait a few minutes.");
  }
  const o = (await ctx.db.query<{ status: string; due_paise: number; order_number: string }>(
    "select status, due_paise, order_number from orders where id = $1 for update", [orderId]))[0];
  if (!o) throw new HttpError(404, "NOT_FOUND", "Order not found");
  if (o.status === "CANCELLED") throw new HttpError(409, "ORDER_CANCELLED", "Order was cancelled. / Order radd kar diya gaya.");
  if (Number(o.due_paise) <= 0) throw new HttpError(409, "ALREADY_PAID", "Nothing is due on this order. / Is order par kuch baaki nahi hai.");
  const claim = { method: "UPI", amountPaise: Number(o.due_paise), reference: input.reference, note: input.note, at: ctx.now().toISOString() };
  // jsonb_build_object with scalar params — avoids driver-side JSON double-encoding
  await ctx.db.query(
    "update orders set payment_claim = jsonb_build_object('method','UPI','amountPaise',$2::int,'reference',$3::text,'note',$4::text,'at',$5::text) where id = $1",
    [orderId, claim.amountPaise, claim.reference, claim.note, claim.at]);
  return { ok: true, claim };
}

// ---------------------------------------------------------------- receipts
export async function issueReceipt(ctx: AppContext, staff: Staff, orderId: string, ip: string) {
  return ctx.db.tx(async (tx) => {
    const snapshot = await buildReceiptSnapshot(tx, orderId);
    const number = (await tx.query<{ n: string }>("select public.next_receipt_number($1) as n", [ctx.now()]))[0]!.n;
    const r = (await tx.query<{ id: string }>(
      "insert into receipts (receipt_number, order_id, snapshot, issued_by) values ($1,$2,$3::jsonb,$4) returning id",
      [number, orderId, JSON.stringify({ ...snapshot, receiptNumber: number, issuedAt: ctx.now().toISOString() }), staff.userId]))[0]!;
    await audit(tx, staff, "receipt.issue", "order", orderId, { receiptId: r.id, receiptNumber: number }, ip);
    return { receiptId: r.id, receiptNumber: number };
  });
}

export interface ReceiptSnapshot {
  receiptNumber: string;
  issuedAt: string;
  shop: { name: string; address: string; phone: string | null; gstin: string | null };
  order: { orderNumber: string; customerName: string; customerPhone: string | null; createdAt: string; status: string };
  items: { name: string; description: string; amountPaise: number }[];
  services: { label: string; amountPaise: number }[];
  adjustmentPaise: number;
  totalPaise: number;
  payments: { method: string; amountPaise: number; reference: string | null; at: string }[];
  paidPaise: number;
  duePaise: number;
}

async function buildReceiptSnapshot(db: Db, orderId: string): Promise<Omit<ReceiptSnapshot, "receiptNumber" | "issuedAt">> {
  const o = (await db.query<Record<string, unknown>>("select * from orders where id = $1", [orderId]))[0];
  if (!o) throw new HttpError(404, "NOT_FOUND", "Order not found");
  const shop = await loadShopSettings(db);
  const items = await db.query<Record<string, unknown>>(
    `select i.*, f.original_name, pt.name as paper_type_name from order_items i join uploaded_files f on f.id = i.file_id
       left join paper_types pt on pt.id = i.paper_type_id where i.order_id = $1 order by i.position`, [orderId]);
  const payments = await db.query<Record<string, unknown>>("select method, amount_paise, reference, created_at from payments where order_id = $1 order by created_at", [orderId]);
  return {
    shop: { name: shop.shopName, address: shop.address, phone: shop.phone, gstin: shop.gstin },
    order: { orderNumber: o.order_number as string, customerName: o.customer_name as string, customerPhone: (o.customer_phone as string | null) ?? null,
      createdAt: new Date(o.created_at as string).toISOString(), status: o.status as string },
    items: items.map((i) => ({
      name: i.original_name as string,
      description: `${i.color_mode === "BW" ? "B/W" : "Colour"}, ${i.duplex === "DOUBLE" ? "double-side" : "single-side"}, ${i.paper_size}` +
        `${i.paper_type_name ? `, ${i.paper_type_name as string}` : ""}, pages ${(i.page_ranges as string | null) ?? "all"} (${i.pages_selected as number}), ` +
        `${i.copies as number} cop${i.copies === 1 ? "y" : "ies"}, ${i.total_sheets as number} sheets`,
      amountPaise: i.price_paise as number,
    })),
    services: (((o.order_services as { lines?: { label: string; amountPaise: number }[] })?.lines) ?? []).map((l) => ({ label: l.label, amountPaise: l.amountPaise })),
    adjustmentPaise: Number(o.adjustment_paise),
    totalPaise: Number(o.total_paise),
    payments: payments.map((p) => ({ method: p.method as string, amountPaise: p.amount_paise as number, reference: (p.reference as string | null) ?? null, at: new Date(p.created_at as string).toISOString() })),
    paidPaise: Number(o.paid_paise),
    duePaise: Number(o.due_paise),
  };
}

export async function getReceipt(db: Db, receiptId: string): Promise<ReceiptSnapshot> {
  const r = (await db.query<{ snapshot: ReceiptSnapshot }>("select snapshot from receipts where id = $1", [receiptId]))[0];
  if (!r) throw new HttpError(404, "NOT_FOUND", "Receipt not found");
  return r.snapshot;
}

const rs = (p: number) => `Rs. ${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Receipt PDF (pdf-lib standard fonts are WinAnsi, so "Rs." is used instead of the ₹ glyph). */
export async function receiptPdf(s: ReceiptSnapshot): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Receipt ${s.receiptNumber}`);
  const page = pdf.addPage([595.28, 841.89]);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const clean = (t: string) => t.replace(/[^\x20-\x7E]/g, "?");
  let y = 790;
  const text = (t: string, x: number, size = 10, font = reg) => page.drawText(clean(t), { x, y, size, font, color: rgb(0.1, 0.1, 0.1) });
  const right = (t: string, xr: number, size = 10, font = reg) => page.drawText(clean(t), { x: xr - font.widthOfTextAtSize(clean(t), size), y, size, font });
  text(s.shop.name, 50, 20, bold); right("RECEIPT", 545, 16, bold); y -= 18;
  text(s.shop.address, 50); right(s.receiptNumber, 545, 10, bold); y -= 14;
  if (s.shop.phone) { text(`Phone: ${s.shop.phone}`, 50); }
  right(new Date(s.issuedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), 545); y -= 14;
  if (s.shop.gstin) { text(`GSTIN: ${s.shop.gstin}`, 50); y -= 14; }
  y -= 10;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 1, color: rgb(0.7, 0.7, 0.7) }); y -= 20;
  text(`Order: ${s.order.orderNumber}`, 50, 11, bold); right(`Status: ${s.order.status}`, 545); y -= 14;
  text(`Customer: ${s.order.customerName}${s.order.customerPhone ? ` (${s.order.customerPhone})` : ""}`, 50); y -= 24;
  text("Item", 50, 10, bold); right("Amount", 545, 10, bold); y -= 16;
  for (const it of s.items) {
    if (y < 120) break;
    text(it.name.slice(0, 70), 50, 10, bold); right(rs(it.amountPaise), 545); y -= 13;
    text(it.description.slice(0, 110), 60, 8); y -= 16;
  }
  for (const sv of s.services) { text(sv.label, 50); right(rs(sv.amountPaise), 545); y -= 14; }
  if (s.adjustmentPaise) { text("Minimum order adjustment", 50); right(rs(s.adjustmentPaise), 545); y -= 14; }
  page.drawLine({ start: { x: 300, y: y + 4 }, end: { x: 545, y: y + 4 }, thickness: 1, color: rgb(0.7, 0.7, 0.7) }); y -= 12;
  text("Total", 300, 12, bold); right(rs(s.totalPaise), 545, 12, bold); y -= 16;
  for (const p of s.payments) { text(`Paid (${p.method}${p.reference ? ` ${p.reference}` : ""})`, 300, 9); right(rs(p.amountPaise), 545, 9); y -= 13; }
  text("Paid", 300, 11, bold); right(rs(s.paidPaise), 545, 11, bold); y -= 15;
  text("Balance due", 300, 11, bold); right(rs(s.duePaise), 545, 11, bold); y -= 30;
  text("Thank you! / Dhanyavaad!", 50, 11);
  return pdf.save();
}

// ---------------------------------------------------------------- Razorpay (enabled only when keys are configured)
export async function createRazorpayOrder(ctx: AppContext, orderId: string) {
  if (!ctx.config.razorpayEnabled) throw new HttpError(404, "NOT_ENABLED", "Online payment is not enabled");
  const o = (await ctx.db.query<{ order_number: string; status: string; due_paise: number }>("select order_number, status, due_paise from orders where id = $1", [orderId]))[0]!;
  if (o.due_paise <= 0 || ["CANCELLED", "DELIVERED"].includes(o.status)) throw new HttpError(409, "NOTHING_DUE", "Nothing to pay for this order");
  const auth = Buffer.from(`${ctx.config.RAZORPAY_KEY_ID}:${ctx.config.RAZORPAY_KEY_SECRET}`).toString("base64");
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({ amount: o.due_paise, currency: "INR", receipt: o.order_number, notes: { order_id: orderId, order_number: o.order_number } }),
    cache: "no-store",
  });
  if (!res.ok) throw new HttpError(502, "GATEWAY_ERROR", "Payment gateway is unavailable. Please pay at the counter.");
  const rz = (await res.json()) as { id: string; amount: number };
  await ctx.db.query("insert into razorpay_orders (order_id, rz_order_id, amount_paise) values ($1,$2,$3)", [orderId, rz.id, rz.amount]);
  return { keyId: ctx.config.RAZORPAY_KEY_ID!, razorpayOrderId: rz.id, amountPaise: rz.amount, orderNumber: o.order_number };
}

export function verifyRazorpaySignature(rawBody: string, signature: string, secret: string): boolean {
  return safeEqualHex(hmacHex(secret, rawBody), (signature || "").toLowerCase());
}

/** Webhook: payment is recorded ONLY after the signature verifies and only for captured payments. */
export async function handleRazorpayWebhook(ctx: AppContext, rawBody: string, signature: string) {
  if (!ctx.config.razorpayEnabled) throw new HttpError(404, "NOT_ENABLED", "Not enabled");
  if (!verifyRazorpaySignature(rawBody, signature, ctx.config.RAZORPAY_WEBHOOK_SECRET!)) throw new HttpError(401, "BAD_SIGNATURE", "Invalid signature");
  const evt = JSON.parse(rawBody) as { event: string; payload?: { payment?: { entity?: { id: string; order_id: string; amount: number; status: string; method?: string } } } };
  if (evt.event !== "payment.captured" && evt.event !== "order.paid") return { ok: true, ignored: evt.event };
  const p = evt.payload?.payment?.entity;
  if (!p || p.status !== "captured") return { ok: true, ignored: "not_captured" };
  const rz = (await ctx.db.query<{ order_id: string }>("select order_id from razorpay_orders where rz_order_id = $1", [p.order_id]))[0];
  if (!rz) return { ok: true, ignored: "unknown_order" };
  try {
    await ctx.db.tx(async (tx) => {
      await tx.query("insert into payments (order_id, method, amount_paise, reference, gateway_payment_id, note) values ($1,'ONLINE',$2,$3,$4,'Razorpay webhook (verified)')",
        [rz.order_id, p.amount, p.method ?? "razorpay", p.id]);
      await tx.query("update razorpay_orders set status = 'PAID' where rz_order_id = $1", [p.order_id]);
      await audit(tx, null, "payment.razorpay", "payment", p.id, { orderId: rz.order_id, amountPaise: p.amount });
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: true, duplicate: true };
    if (hasHint(e, "OVERPAYMENT")) {
      await audit(ctx.db, null, "payment.razorpay_overpayment", "order", rz.order_id, { paymentId: p.id, amountPaise: p.amount });
      return { ok: true, recorded: false };
    }
    throw e;
  }
  return { ok: true, recorded: true };
}
