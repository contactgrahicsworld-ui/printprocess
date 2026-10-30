import { z } from "zod";
import type { AppContext } from "@/lib/context";
import { isUniqueViolation } from "@/lib/db/types";
import type { Staff } from "@/lib/auth/types";
import { HttpError } from "@/lib/http/respond";
import { FAILURE_STATUSES, type JobStatus } from "@/lib/orders/status";
import { audit } from "./audit";
import { setOrderStatus } from "./admin-orders";

export const sendToPrinterSchema = z.object({
  agentId: z.string().uuid(),
  printerName: z.string().trim().min(1).max(200).nullable().default(null),
});

interface PrinterInfo { name: string; status?: string }

async function assertPrinter(ctx: AppContext, agentId: string, printerName: string | null) {
  const a = (await ctx.db.query<{ revoked_at: Date | null; printers: PrinterInfo[] }>(
    "select revoked_at, printers from print_agents where id = $1", [agentId]))[0];
  if (!a || a.revoked_at) throw new HttpError(400, "BAD_AGENT", "Print agent not found or revoked");
  if (printerName && !(a.printers ?? []).some((p) => p.name === printerName)) {
    throw new HttpError(400, "BAD_PRINTER", "That printer was not reported by the agent's last heartbeat");
  }
}

/** "Send to printer": creates a QUEUED print job for an APPROVED order item (CONTRACT.md duplicate prevention). */
export async function createPrintJob(ctx: AppContext, staff: Staff, itemId: string, input: z.infer<typeof sendToPrinterSchema>, ip: string) {
  await assertPrinter(ctx, input.agentId, input.printerName);
  try {
    return await ctx.db.tx(async (tx) => {
      const item = (await tx.query<Record<string, unknown>>(
        `select i.*, o.status as order_status, f.status as file_status from order_items i join orders o on o.id = i.order_id
           join uploaded_files f on f.id = i.file_id where i.id = $1 for update of i`, [itemId]))[0];
      if (!item) throw new HttpError(404, "NOT_FOUND", "Order item not found");
      const orderId = item.order_id as string;
      if (!["APPROVED", "PRINTING", "READY"].includes(item.order_status as string)) {
        throw new HttpError(409, "NOT_APPROVED", "Approve the order before sending it to the printer.");
      }
      if (item.file_status !== "READY") throw new HttpError(410, "FILE_GONE", "The file is no longer available.");
      const attempt = (await tx.query<{ n: number }>("select coalesce(max(attempt),0)::int + 1 as n from print_jobs where order_item_id = $1", [itemId]))[0]!.n;
      const settings = {
        colorMode: item.color_mode, duplex: item.duplex, paperSize: item.paper_size, copies: item.copies,
        pageRanges: (item.page_ranges as string | null) ?? null,
      };
      const job = (await tx.query<{ id: string }>(
        `insert into print_jobs (order_id, order_item_id, file_id, attempt, target_agent_id, printer_name, settings, created_by)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) returning id`,
        [orderId, itemId, item.file_id, attempt, input.agentId, input.printerName, JSON.stringify(settings), staff.userId]))[0]!;
      await tx.query("insert into print_job_events (job_id, source, status, detail, actor) values ($1,'STAFF','QUEUED',$2,$3)",
        [job.id, `sent to ${input.printerName ?? "agent default printer"}`, staff.userId]);
      if (item.order_status !== "PRINTING") await setOrderStatus(tx, staff, orderId, "PRINTING", "Sent to printer", ip);
      await audit(tx, staff, "print_job.create", "print_job", job.id, { orderId, itemId, attempt, ...input }, ip);
      return { jobId: job.id, attempt, status: "QUEUED" as JobStatus };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, "DUPLICATE_JOB", "This document already has an active print job.");
    throw e;
  }
}

/** Staff physically checked the output. Only staff can set VERIFIED (agents never can). */
export async function verifyPrintJob(ctx: AppContext, staff: Staff, jobId: string, ip: string) {
  return ctx.db.tx(async (tx) => {
    const j = (await tx.query<{ status: JobStatus; order_id: string; order_item_id: string }>(
      "select status, order_id, order_item_id from print_jobs where id = $1 for update", [jobId]))[0];
    if (!j) throw new HttpError(404, "NOT_FOUND", "Print job not found");
    if (!["SUBMITTED", "SPOOLED", "PRINTING", "COMPLETED_SPOOLER"].includes(j.status)) {
      throw new HttpError(409, "CANNOT_VERIFY", `A job in state ${j.status} cannot be verified`);
    }
    await tx.query("update print_jobs set status = 'VERIFIED', verified_by = $2, verified_at = now(), updated_at = now() where id = $1", [jobId, staff.userId]);
    await tx.query("insert into print_job_events (job_id, source, status, detail, actor) values ($1,'STAFF','VERIFIED',$2,$3)",
      [jobId, `verified printed (was ${j.status})`, staff.userId]);
    await audit(tx, staff, "print_job.verify", "print_job", jobId, { orderId: j.order_id, previous: j.status }, ip);
    const o = (await tx.query<{ status: string; remaining: number }>(
      `select o.status, (select count(*)::int from order_items i where i.order_id = o.id and not exists
          (select 1 from print_jobs pj where pj.order_item_id = i.id and pj.status = 'VERIFIED')) as remaining
         from orders o where o.id = $1`, [j.order_id]))[0]!;
    let orderStatus = o.status;
    if (o.status === "PRINTING" && o.remaining === 0) orderStatus = await setOrderStatus(tx, staff, j.order_id, "READY", "All documents verified printed", ip);
    return { ok: true, orderStatus };
  });
}

/** Re-queue a failed job as a NEW job row with attempt+1 (old row stays as history). */
export async function requeuePrintJob(ctx: AppContext, staff: Staff, jobId: string, override: { agentId?: string; printerName?: string | null }, ip: string) {
  const j0 = (await ctx.db.query<{ target_agent_id: string | null; printer_name: string | null }>(
    "select target_agent_id, printer_name from print_jobs where id = $1", [jobId]))[0];
  if (!j0) throw new HttpError(404, "NOT_FOUND", "Print job not found");
  const agentId = override.agentId ?? j0.target_agent_id;
  const printerName = override.printerName === undefined ? j0.printer_name : override.printerName;
  if (!agentId) throw new HttpError(400, "BAD_AGENT", "Choose a print agent");
  await assertPrinter(ctx, agentId, printerName);
  try {
    return await ctx.db.tx(async (tx) => {
      const j = (await tx.query<Record<string, unknown>>("select * from print_jobs where id = $1 for update", [jobId]))[0]!;
      if (!FAILURE_STATUSES.includes(j.status as JobStatus) && j.status !== "CANCELLED") {
        throw new HttpError(409, "NOT_FAILED", "Only failed or cancelled jobs can be re-queued");
      }
      const o = (await tx.query<{ status: string }>("select status from orders where id = $1 for update", [j.order_id]))[0]!;
      if (!["APPROVED", "PRINTING", "READY"].includes(o.status)) throw new HttpError(409, "NOT_APPROVED", `Order is ${o.status}`);
      const attempt = (await tx.query<{ n: number }>("select max(attempt)::int + 1 as n from print_jobs where order_item_id = $1", [j.order_item_id]))[0]!.n;
      const item = (await tx.query<Record<string, unknown>>("select * from order_items where id = $1", [j.order_item_id]))[0]!;
      const settings = { colorMode: item.color_mode, duplex: item.duplex, paperSize: item.paper_size, copies: item.copies, pageRanges: item.page_ranges ?? null };
      const n = (await tx.query<{ id: string }>(
        `insert into print_jobs (order_id, order_item_id, file_id, attempt, target_agent_id, printer_name, settings, created_by, requeued_from)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) returning id`,
        [j.order_id, j.order_item_id, j.file_id, attempt, agentId, printerName, JSON.stringify(settings), staff.userId, jobId]))[0]!;
      await tx.query("insert into print_job_events (job_id, source, status, detail, actor) values ($1,'STAFF','QUEUED',$2,$3)",
        [n.id, `re-queued from attempt ${j.attempt as number}`, staff.userId]);
      if (o.status !== "PRINTING") await setOrderStatus(tx, staff, j.order_id as string, "PRINTING", "Re-queued print job", ip);
      await audit(tx, staff, "print_job.requeue", "print_job", n.id, { orderId: j.order_id, from: jobId, attempt }, ip);
      return { jobId: n.id, attempt, status: "QUEUED" as JobStatus };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, "DUPLICATE_JOB", "This document already has an active print job.");
    throw e;
  }
}

export async function cancelPrintJob(ctx: AppContext, staff: Staff, jobId: string, ip: string) {
  return ctx.db.tx(async (tx) => {
    const j = (await tx.query<{ status: JobStatus; order_id: string }>("select status, order_id from print_jobs where id = $1 for update", [jobId]))[0];
    if (!j) throw new HttpError(404, "NOT_FOUND", "Print job not found");
    if (j.status !== "QUEUED" && j.status !== "CLAIMED") throw new HttpError(409, "CANNOT_CANCEL", `A job in state ${j.status} cannot be cancelled from here`);
    await tx.query("update print_jobs set status = 'CANCELLED', cancelled_by = $2, cancelled_at = now(), updated_at = now() where id = $1", [jobId, staff.userId]);
    await tx.query("insert into print_job_events (job_id, source, status, detail, actor) values ($1,'STAFF','CANCELLED','cancelled by staff',$2)", [jobId, staff.userId]);
    await audit(tx, staff, "print_job.cancel", "print_job", jobId, { orderId: j.order_id }, ip);
    return { ok: true };
  });
}
