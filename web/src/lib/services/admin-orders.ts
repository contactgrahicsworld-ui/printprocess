import { z } from "zod";
import type { AppContext } from "@/lib/context";
import type { Db } from "@/lib/db/types";
import { hasHint, pgTextArray } from "@/lib/db/types";
import type { Staff } from "@/lib/auth/types";
import { HttpError } from "@/lib/http/respond";
import { canTransition, EDITABLE_STATUSES, ACTIVE_JOB_STATUSES, type OrderStatus } from "@/lib/orders/status";
import { PricingError, quoteItem } from "@/lib/pricing/engine";
import { audit } from "./audit";
import { loadPriceConfig } from "./settings";
import { itemConfigSchema } from "./orders";

export const TABS = {
  new: ["RECEIVED"],
  pending: ["UNDER_REVIEW"],
  approved: ["APPROVED"],
  printing: ["PRINTING"],
  completed: ["READY", "DELIVERED"],
  cancelled: ["CANCELLED"],
} as const satisfies Record<string, readonly OrderStatus[]>;
export type Tab = keyof typeof TABS;

export async function listOrders(db: Db, tab: Tab, limit = 100) {
  const rows = await db.query<Record<string, unknown>>(
    `select o.id, o.order_number, o.customer_name, o.customer_phone, o.status, o.total_paise, o.paid_paise, o.due_paise, o.created_at,
            o.assigned_to, sp.full_name as assigned_name, sp.email as assigned_email,
            (select count(*)::int from order_items i where i.order_id = o.id) as item_count,
            (select coalesce(sum(i.total_sheets),0)::int from order_items i where i.order_id = o.id) as sheets
       from orders o left join staff_profiles sp on sp.user_id = o.assigned_to
      where o.status = any($1::order_status[]) order by o.created_at desc limit $2`,
    [pgTextArray(TABS[tab]), limit]);
  return rows;
}

export async function tabCounts(db: Db) {
  const rows = await db.query<{ status: OrderStatus; n: number }>("select status, count(*)::int as n from orders group by status");
  const m = new Map(rows.map((r) => [r.status, r.n]));
  return Object.fromEntries((Object.keys(TABS) as Tab[]).map((t) => [t, TABS[t].reduce((s, st) => s + (m.get(st) ?? 0), 0)])) as Record<Tab, number>;
}

export async function getOrderDetail(db: Db, orderId: string) {
  const order = (await db.query<Record<string, unknown>>(
    `select o.*, sp.full_name as assigned_name, sp.email as assigned_email from orders o
       left join staff_profiles sp on sp.user_id = o.assigned_to where o.id = $1`, [orderId]))[0];
  if (!order) throw new HttpError(404, "NOT_FOUND", "Order not found");
  const items = await db.query<Record<string, unknown>>(
    `select i.*, f.original_name, f.detected_mime, f.size_bytes, f.page_count as file_page_count, f.status as file_status,
            f.scan_status, f.scan_detail, f.sha256, pt.name as paper_type_name
       from order_items i join uploaded_files f on f.id = i.file_id left join paper_types pt on pt.id = i.paper_type_id
      where i.order_id = $1 order by i.position`, [orderId]);
  const jobs = await db.query<Record<string, unknown>>(
    `select j.*, a.name as agent_name, vb.full_name as verified_by_name from print_jobs j
       left join print_agents a on a.id = coalesce(j.claimed_by_agent, j.target_agent_id)
       left join staff_profiles vb on vb.user_id = j.verified_by
      where j.order_id = $1 order by j.created_at`, [orderId]);
  const jobEvents = await db.query<Record<string, unknown>>(
    `select e.* from print_job_events e join print_jobs j on j.id = e.job_id where j.order_id = $1 order by e.created_at, e.id`, [orderId]);
  const history = await db.query<Record<string, unknown>>(
    `select h.*, sp.full_name as changed_by_name from order_status_history h left join staff_profiles sp on sp.user_id = h.changed_by
      where h.order_id = $1 order by h.created_at, h.id`, [orderId]);
  const revisions = await db.query<Record<string, unknown>>(
    `select r.*, sp.full_name as changed_by_name from order_item_revisions r join order_items i on i.id = r.order_item_id
       left join staff_profiles sp on sp.user_id = r.changed_by where i.order_id = $1 order by r.created_at`, [orderId]);
  const payments = await db.query<Record<string, unknown>>(
    `select p.*, sp.full_name as recorded_by_name from payments p left join staff_profiles sp on sp.user_id = p.recorded_by
      where p.order_id = $1 order by p.created_at`, [orderId]);
  const receipts = await db.query<Record<string, unknown>>("select id, receipt_number, issued_at from receipts where order_id = $1 order by issued_at", [orderId]);
  const auditRows = await db.query<Record<string, unknown>>(
    `select a.action, a.detail, a.created_at, sp.full_name as actor_name, a.actor_role from audit_logs a
       left join staff_profiles sp on sp.user_id = a.actor
      where (a.entity_type = 'order' and a.entity_id = $1) or (a.entity_type in ('order_item','print_job','payment') and a.detail->>'orderId' = $1)
      order by a.created_at desc limit 100`, [orderId]);
  return { order, items, jobs, jobEvents, history, revisions, payments, receipts, audit: auditRows };
}

async function lockOrder(db: Db, orderId: string) {
  const o = (await db.query<{ id: string; status: OrderStatus; order_number: string; total_paise: number; paid_paise: number }>(
    "select id, status, order_number, total_paise, paid_paise from orders where id = $1 for update", [orderId]))[0];
  if (!o) throw new HttpError(404, "NOT_FOUND", "Order not found");
  return o;
}

/** Applies a status change with server-side + DB-trigger enforcement, history and audit. */
export async function setOrderStatus(db: Db, staff: Staff | null, orderId: string, to: OrderStatus, reason: string | null, ip: string | null) {
  const o = await lockOrder(db, orderId);
  if (o.status === to) return o.status;
  if (!canTransition(o.status, to)) {
    throw new HttpError(409, "INVALID_STATUS_TRANSITION", `Cannot change order from ${o.status} to ${to}`);
  }
  if (to === "READY") {
    const notVerified = (await db.query<{ n: number }>(
      `select count(*)::int as n from order_items i where i.order_id = $1
         and not exists (select 1 from print_jobs j where j.order_item_id = i.id and j.status = 'VERIFIED')`, [orderId]))[0]!.n;
    if (notVerified > 0) throw new HttpError(409, "NOT_VERIFIED", "Every document must be verified as printed before marking READY.");
  }
  if (to === "CANCELLED" || to === "APPROVED" || to === "UNDER_REVIEW") {
    const inFlight = (await db.query<{ n: number }>(
      "select count(*)::int as n from print_jobs where order_id = $1 and status in ('DOWNLOADED','SUBMITTED','SPOOLED','PRINTING')", [orderId]))[0]!.n;
    if (inFlight > 0) throw new HttpError(409, "JOB_IN_FLIGHT", "A print job is already at the printer. Wait for it to finish or fail first.");
    const cancelled = await db.query<{ id: string }>(
      "update print_jobs set status = 'CANCELLED', cancelled_by = $2, cancelled_at = now(), updated_at = now() where order_id = $1 and status in ('QUEUED','CLAIMED') returning id",
      [orderId, staff?.userId ?? null]);
    for (const j of cancelled) {
      await db.query("insert into print_job_events (job_id, source, status, detail, actor) values ($1, 'STAFF', 'CANCELLED', $2, $3)",
        [j.id, `order moved to ${to}`, staff?.userId ?? null]);
    }
  }
  if (to === "DELIVERED" && o.paid_paise < o.total_paise) {
    // Allowed (credit customers exist) but recorded explicitly in the audit trail.
    reason = reason ? `${reason} (due ₹${((o.total_paise - o.paid_paise) / 100).toFixed(2)})` : `Delivered with due ₹${((o.total_paise - o.paid_paise) / 100).toFixed(2)}`;
  }
  try {
    await db.query("update orders set status = $2::order_status, rejection_reason = case when $2::text = 'CANCELLED' then $3 else rejection_reason end where id = $1",
      [orderId, to, reason]);
  } catch (e) {
    if (hasHint(e, "INVALID_STATUS_TRANSITION")) throw new HttpError(409, "INVALID_STATUS_TRANSITION", `Cannot change order from ${o.status} to ${to}`);
    throw e;
  }
  await db.query("insert into order_status_history (order_id, from_status, to_status, changed_by, reason) values ($1,$2,$3,$4,$5)",
    [orderId, o.status, to, staff?.userId ?? null, reason]);
  await audit(db, staff, "order.status", "order", orderId, { from: o.status, to, reason }, ip);
  return to;
}

export async function changeStatus(ctx: AppContext, staff: Staff, orderId: string, to: OrderStatus, reason: string | null, ip: string) {
  if (to === "PRINTING") throw new HttpError(409, "USE_SEND_TO_PRINTER", "Use “Send to printer” — PRINTING is set when a print job is created.");
  return ctx.db.tx((tx) => setOrderStatus(tx, staff, orderId, to, reason, ip));
}

export async function approveOrder(ctx: AppContext, staff: Staff, orderId: string, ip: string) {
  return ctx.db.tx(async (tx) => {
    const bad = (await tx.query<{ n: number }>(
      `select count(*)::int as n from order_items i join uploaded_files f on f.id = i.file_id
        where i.order_id = $1 and (f.status <> 'READY' or f.scan_status in ('INFECTED','ERROR'))`, [orderId]))[0]!.n;
    if (bad > 0) throw new HttpError(409, "FILES_UNAVAILABLE", "One or more files are missing, purged or failed scanning.");
    return setOrderStatus(tx, staff, orderId, "APPROVED", null, ip);
  });
}

export async function rejectOrder(ctx: AppContext, staff: Staff, orderId: string, reason: string, ip: string) {
  if (reason.trim().length < 3) throw new HttpError(400, "REASON_REQUIRED", "Please give a reason for rejecting.");
  return ctx.db.tx((tx) => setOrderStatus(tx, staff, orderId, "CANCELLED", reason.trim(), ip));
}

export async function assignOrder(ctx: AppContext, staff: Staff, orderId: string, assigneeId: string | null, ip: string) {
  return ctx.db.tx(async (tx) => {
    await lockOrder(tx, orderId);
    if (assigneeId) {
      const ok = (await tx.query("select 1 from staff_profiles where user_id = $1 and active", [assigneeId])).length > 0;
      if (!ok) throw new HttpError(400, "BAD_ASSIGNEE", "Staff member not found or inactive");
    }
    await tx.query("update orders set assigned_to = $2 where id = $1", [orderId, assigneeId]);
    await audit(tx, staff, "order.assign", "order", orderId, { assignedTo: assigneeId }, ip);
    return { ok: true };
  });
}

export const editItemSchema = itemConfigSchema.omit({ fileId: true }).extend({ reason: z.string().trim().max(300).nullable().default(null) });

/** Staff edit of print settings: re-priced server-side, revision + audit recorded, order totals updated. */
export async function editOrderItem(ctx: AppContext, staff: Staff, itemId: string, input: z.infer<typeof editItemSchema>, ip: string) {
  return ctx.db.tx(async (tx) => {
    const item = (await tx.query<Record<string, unknown>>(
      `select i.*, f.page_count as file_pages, f.detected_mime from order_items i join uploaded_files f on f.id = i.file_id where i.id = $1`, [itemId]))[0];
    if (!item) throw new HttpError(404, "NOT_FOUND", "Item not found");
    const orderId = item.order_id as string;
    const o = await lockOrder(tx, orderId);
    if (!EDITABLE_STATUSES.includes(o.status)) throw new HttpError(409, "NOT_EDITABLE", `Settings cannot be changed while the order is ${o.status}`);
    const active = (await tx.query<{ n: number }>("select count(*)::int as n from print_jobs where order_item_id = $1 and status = any($2::print_job_status[])",
      [itemId, pgTextArray(ACTIVE_JOB_STATUSES)]))[0]!.n;
    if (active > 0) throw new HttpError(409, "JOB_ACTIVE", "Cancel the active print job before editing settings.");
    const cfg = await loadPriceConfig(tx);
    let q;
    try {
      q = quoteItem(cfg, {
        pageCount: item.file_pages as number, isImage: item.detected_mime !== "application/pdf",
        colorMode: input.colorMode, duplex: input.duplex, paperSize: input.paperSize, copies: input.copies,
        pageRanges: input.pageRanges, paperTypeId: input.paperTypeId, serviceCodes: input.serviceCodes,
      });
    } catch (e) {
      if (e instanceof PricingError) throw new HttpError(422, "INVALID_CONFIG", e.message);
      throw e;
    }
    const before = {
      colorMode: item.color_mode, duplex: item.duplex, paperSize: item.paper_size, copies: item.copies, pageRanges: item.page_ranges,
      paperTypeId: item.paper_type_id, serviceCodes: item.service_codes, instructions: item.instructions, pricePaise: item.price_paise,
      pagesSelected: item.pages_selected, totalSheets: item.total_sheets,
    };
    const after = {
      colorMode: input.colorMode, duplex: input.duplex, paperSize: input.paperSize, copies: input.copies, pageRanges: q.normalizedRanges,
      paperTypeId: input.paperTypeId, serviceCodes: [...new Set(input.serviceCodes)], instructions: input.instructions, pricePaise: q.totalPaise,
      pagesSelected: q.pagesSelected, totalSheets: q.totalSheets,
    };
    await tx.query(
      `update order_items set color_mode=$2, duplex=$3, paper_size=$4, copies=$5, page_ranges=$6, paper_type_id=$7, service_codes=$8::text[],
              instructions=$9, pages_selected=$10, sheets_per_copy=$11, total_sheets=$12, printed_sides=$13, price_paise=$14,
              price_breakdown=$15::jsonb, updated_at=now() where id=$1`,
      [itemId, input.colorMode, input.duplex, input.paperSize, input.copies, q.normalizedRanges, input.paperTypeId,
        pgTextArray(after.serviceCodes), input.instructions, q.pagesSelected, q.sheetsPerCopy, q.totalSheets, q.printedSides, q.totalPaise,
        JSON.stringify({ sideRatePaise: q.sideRatePaise, lines: q.lines })]);
    const totals = (await tx.query<{ items_total: number; services: number }>(
      "select coalesce(sum(i.price_paise),0)::int as items_total, (select services_total_paise from orders where id = $1) as services from order_items i where i.order_id = $1",
      [orderId]))[0]!;
    const subtotal = totals.items_total + totals.services;
    const adjustment = subtotal < cfg.minOrderPaise ? cfg.minOrderPaise - subtotal : 0;
    const newTotal = subtotal + adjustment;
    if (newTotal < o.paid_paise) throw new HttpError(409, "BELOW_PAID", "New total would be less than the amount already paid.");
    await tx.query("update orders set items_total_paise = $2, adjustment_paise = $3, total_paise = $4 where id = $1",
      [orderId, totals.items_total, adjustment, newTotal]);
    await tx.query("insert into order_item_revisions (order_item_id, changed_by, before, after, reason) values ($1,$2,$3::jsonb,$4::jsonb,$5)",
      [itemId, staff.userId, JSON.stringify(before), JSON.stringify(after), input.reason]);
    await audit(tx, staff, "order_item.edit", "order_item", itemId, { orderId, before, after, oldTotal: o.total_paise, newTotal, reason: input.reason }, ip);
    return { item: after, orderTotalPaise: newTotal };
  });
}

/** Short-lived signed URL (120 s) for staff preview/download of an order's file. */
export async function fileSignedUrl(ctx: AppContext, staff: Staff, fileId: string, download: boolean, ip: string) {
  const f = (await ctx.db.query<{ storage_path: string; original_name: string; status: string; order_id: string | null }>(
    `select f.storage_path, f.original_name, f.status, i.order_id from uploaded_files f left join order_items i on i.file_id = f.id where f.id = $1`, [fileId]))[0];
  if (!f || !f.order_id) throw new HttpError(404, "NOT_FOUND", "File not found");
  if (f.status !== "READY") throw new HttpError(410, "FILE_GONE", `File is ${f.status.toLowerCase()}`);
  const ttl = 120;
  const url = await ctx.storage.createSignedDownloadUrl(f.storage_path, ttl, download ? f.original_name : undefined);
  await audit(ctx.db, staff, download ? "file.download" : "file.preview", "order", f.order_id, { fileId }, ip);
  return { url, expiresInSeconds: ttl };
}

export async function listStaff(db: Db) {
  return db.query<{ user_id: string; email: string; full_name: string; role: string; active: boolean }>(
    "select user_id, email, full_name, role, active from staff_profiles order by role, full_name");
}
