import { beforeAll, describe, expect, it } from "vitest";
import { agentHeaders, call, createTestEnv, makePdf, seedQr, seedStaff, type TestEnv } from "../helpers/harness";
import { routes, startSession, uploadFile } from "../helpers/flows";
import * as adminOrder from "@/app/api/admin/orders/[id]/route";
import * as adminOrders from "@/app/api/admin/orders/route";
import * as approve from "@/app/api/admin/orders/[id]/approve/route";
import * as assign from "@/app/api/admin/orders/[id]/assign/route";
import * as status from "@/app/api/admin/orders/[id]/status/route";
import * as payments from "@/app/api/admin/orders/[id]/payments/route";
import * as receipts from "@/app/api/admin/orders/[id]/receipts/route";
import * as receiptPdf from "@/app/api/admin/receipts/[id]/pdf/route";
import * as editItem from "@/app/api/admin/order-items/[id]/route";
import * as sendToPrinter from "@/app/api/admin/order-items/[id]/print-jobs/route";
import * as verify from "@/app/api/admin/print-jobs/[id]/verify/route";
import * as agents from "@/app/api/admin/agents/route";
import * as fileUrl from "@/app/api/admin/files/[id]/url/route";
import * as heartbeat from "@/app/api/agent/heartbeat/route";
import * as claim from "@/app/api/agent/jobs/claim/route";
import * as jobStatus from "@/app/api/agent/jobs/[jobId]/status/route";
import * as track from "@/app/api/public/track/route";
import { sha256hex } from "@/lib/security/crypto";

let env: TestEnv;
let owner: string;
let staff: string;
let qr: string;

beforeAll(async () => {
  env = await createTestEnv();
  owner = await seedStaff(env.db, "OWNER");
  staff = await seedStaff(env.db, "STAFF");
  qr = await seedQr(env.db);
});

describe("full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt", () => {
  const state: Record<string, any> = {};

  it("customer: session, upload real PDF, server counts pages", async () => {
    state.session = await startSession(qr);
    state.pdf = await makePdf(12);
    const up = await uploadFile(state.session, "Class 10 notes.pdf", state.pdf);
    expect(up.completeStatus).toBe(200);
    expect(up.file).toMatchObject({ status: "READY", pageCount: 12, mimeType: "application/pdf", scanStatus: "NOT_SCANNED" });
    state.fileId = up.fileId;
    const st = await call(routes.sessions.GET, "/api/public/sessions", { session: state.session });
    expect(st.body.files).toHaveLength(1);
    expect(st.body.catalog.services.map((s: any) => s.code)).toContain("STAPLE");
  });

  it("customer: configures BW duplex, pages 1-3,7,10-12, 2 copies + stapling; live server quote", async () => {
    state.item = { fileId: state.fileId, colorMode: "BW", duplex: "DOUBLE", paperSize: "A4", copies: 2, pageRanges: "1-3, 7, 10-12", paperTypeId: null, serviceCodes: ["STAPLE"], instructions: "Staple top-left" };
    const q = await call(routes.quote.POST, "/api/public/quote", { session: state.session, body: { items: [state.item], orderServiceCodes: ["URGENT"] } });
    expect(q.status).toBe(200);
    const it0 = q.body.items[0];
    expect(it0).toMatchObject({ pagesTotal: 12, pagesSelected: 7, normalizedRanges: "1-3,7,10-12", sheetsPerCopy: 4, totalSheets: 8, printedSides: 14 });
    // 14 sides × ₹1.50 + stapling 2 copies × ₹2 = 21 + 4 = ₹25 ; + urgent ₹20 = ₹45
    expect(it0.totalPaise).toBe(2100 + 400);
    expect(q.body.totalPaise).toBe(4500);
    state.total = q.body.totalPaise;
  });

  it("customer: submits; gets MP-YYYYMMDD-NNNN + tracking token (only hash stored)", async () => {
    const r = await call(routes.orders.POST, "/api/public/orders", {
      session: state.session,
      body: { items: [state.item], orderServiceCodes: ["URGENT"], idempotencyKey: "idem-full-flow-1", customerName: "Ravi Kumar", customerPhone: "9876543210", notes: null, expectedTotalPaise: state.total },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.orderNumber).toMatch(/^MP-\d{8}-\d{4}$/);
    expect(r.body.trackUrl).toContain(`/t/${r.body.orderNumber}?k=`);
    Object.assign(state, { orderId: r.body.orderId, orderNumber: r.body.orderNumber, token: r.body.trackingToken });
    const row = (await env.db.query<{ tracking_token_hash: string; status: string }>("select tracking_token_hash, status from orders where id = $1", [state.orderId]))[0]!;
    expect(row.tracking_token_hash).toBe(sha256hex(state.token));
    expect(row.tracking_token_hash).not.toContain(state.token);
    expect(row.status).toBe("RECEIVED");
  });

  it("customer: tracks the order", async () => {
    const t = await call(track.POST, "/api/public/track", { body: { orderNumber: state.orderNumber, token: state.token } });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ status: "RECEIVED", totalPaise: 4500, paidPaise: 0, duePaise: 4500 });
    expect(t.body.items[0]).toMatchObject({ pagesSelected: 7, copies: 2, totalSheets: 8 });
  });

  it("admin: sees order in 'new' tab, previews file via short-lived signed URL", async () => {
    const l = await call(adminOrders.GET, "/api/admin/orders?tab=new", { staff });
    expect(l.body.orders.map((o: any) => o.order_number)).toContain(state.orderNumber);
    const d = await call(adminOrder.GET, `/api/admin/orders/${state.orderId}`, { staff, params: { id: state.orderId } });
    expect(d.body.items).toHaveLength(1);
    state.itemId = d.body.items[0].id;
    const u = await call(fileUrl.GET, `/api/admin/files/${state.fileId}/url`, { staff, params: { id: state.fileId } });
    expect(u.status).toBe(200);
    expect(u.body.expiresInSeconds).toBeLessThanOrEqual(300);
    const got = await call(routes.localStorage.GET, u.body.url);
    expect(Buffer.from(got.body).equals(Buffer.from(state.pdf))).toBe(true);
  });

  it("admin: edits settings (copies 2→3) with revision + audit and server re-price", async () => {
    const e = await call(editItem.PATCH, `/api/admin/order-items/${state.itemId}`, {
      method: "PATCH", staff, params: { id: state.itemId },
      body: { colorMode: "BW", duplex: "DOUBLE", paperSize: "A4", copies: 3, pageRanges: "1-3,7,10-12", paperTypeId: null, serviceCodes: ["STAPLE"], instructions: "Staple top-left", reason: "Customer asked for 3" },
    });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    // 21 sides × 150 = 3150 + staple 3 × 200 = 600 → 3750 ; + urgent 2000 = 5750
    expect(e.body.orderTotalPaise).toBe(5750);
    const revs = await env.db.query("select * from order_item_revisions where order_item_id = $1", [state.itemId]);
    expect(revs).toHaveLength(1);
    const aud = await env.db.query("select * from audit_logs where action = 'order_item.edit'");
    expect(aud).toHaveLength(1);
  });

  it("admin: assigns, approves", async () => {
    expect((await call(assign.POST, "x", { staff, params: { id: state.orderId }, body: { staffId: staff } })).status).toBe(200);
    const a = await call(approve.POST, "x", { staff, params: { id: state.orderId } });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.status).toBe("APPROVED");
  });

  it("owner: creates a print agent; secret shown once, only hashes stored", async () => {
    const r = await call(agents.POST, "/api/admin/agents", { staff: owner, body: { name: "Counter PC" } });
    expect(r.status).toBe(201);
    state.agentId = r.body.agentId;
    state.secret = r.body.secret;
    const row = (await env.db.query<{ secret_hash: string; hmac_key: string }>("select secret_hash, hmac_key from print_agents where id = $1", [state.agentId]))[0]!;
    expect(row.secret_hash).toBe(sha256hex(state.secret));
    expect(row.hmac_key).toBe(sha256hex(state.secret));
    const list = await call(agents.GET, "/api/admin/agents", { staff });
    expect(JSON.stringify(list.body)).not.toContain(row.hmac_key);
  });

  it("agent: heartbeat with printers (valid HMAC)", async () => {
    const body = JSON.stringify({ agentVersion: "1.0.0", hostname: "COUNTER-PC", printers: [{ name: "HP LaserJet", isDefault: true, status: "Normal", supportsColor: false, supportsDuplex: true, paperSizes: ["A4", "Legal"] }] });
    const r = await call(heartbeat.POST, "/api/agent/heartbeat", { rawBody: body, headers: agentHeaders(state.agentId, state.secret, "POST", "/api/agent/heartbeat", body) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.serverTime).toBe("number");
  });

  it("admin: sends to printer → job QUEUED, order PRINTING", async () => {
    const r = await call(sendToPrinter.POST, "x", { staff, params: { id: state.itemId }, body: { agentId: state.agentId, printerName: "HP LaserJet" } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    state.jobId = r.body.jobId;
    const o = (await env.db.query<{ status: string }>("select status from orders where id = $1", [state.orderId]))[0]!;
    expect(o.status).toBe("PRINTING");
  });

  it("agent: claims the job with full CONTRACT PrintJob shape and a working 10-minute download URL", async () => {
    const body = JSON.stringify({ printers: ["HP LaserJet"] });
    const r = await call(claim.POST, "/api/agent/jobs/claim", { rawBody: body, headers: agentHeaders(state.agentId, state.secret, "POST", "/api/agent/jobs/claim", body) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.jobs).toHaveLength(1);
    const j = r.body.jobs[0];
    expect(Object.keys(j).sort()).toEqual(["attempt", "downloadUrl", "fileName", "jobId", "mimeType", "orderItemId", "orderNumber", "printerName", "settings", "sha256"].sort());
    expect(j).toMatchObject({ jobId: state.jobId, orderNumber: state.orderNumber, orderItemId: state.itemId, attempt: 1, printerName: "HP LaserJet", fileName: "Class 10 notes.pdf", mimeType: "application/pdf", sha256: sha256hex(state.pdf) });
    expect(j.settings).toEqual({ colorMode: "BW", duplex: "DOUBLE", paperSize: "A4", copies: 3, pageRanges: "1-3,7,10-12" });
    const exp = Number(new URL(j.downloadUrl).searchParams.get("exp"));
    expect(exp * 1000 - env.clock.now).toBeLessThanOrEqual(600_000);
    const dl = await call(routes.localStorage.GET, j.downloadUrl);
    expect(sha256hex(Buffer.from(dl.body))).toBe(j.sha256);
    // idempotent resume: claiming again returns the same unfinished job, not a new one
    const body2 = JSON.stringify({ printers: ["HP LaserJet"] });
    const r2 = await call(claim.POST, "/api/agent/jobs/claim", { rawBody: body2, headers: agentHeaders(state.agentId, state.secret, "POST", "/api/agent/jobs/claim", body2) });
    expect(r2.body.jobs.map((x: any) => x.jobId)).toEqual([state.jobId]);
  });

  it("agent: status updates are append-only, idempotent and monotonic; COMPLETED_SPOOLER does NOT make the order READY", async () => {
    const send = async (s: string, extra: Record<string, unknown> = {}) => {
      const path = `/api/agent/jobs/${state.jobId}/status`;
      const body = JSON.stringify({ status: s, spoolerJobId: 12, detail: s.toLowerCase(), pagesPrinted: null, at: Date.now(), ...extra });
      return call(jobStatus.POST, path, { rawBody: body, params: { jobId: state.jobId }, headers: agentHeaders(state.agentId, state.secret, "POST", path, body) });
    };
    for (const s of ["DOWNLOADED", "SUBMITTED", "SPOOLED", "PRINTING"]) expect((await send(s)).status).toBe(200);
    expect((await send("SUBMITTED")).body).toEqual({ ok: true }); // duplicate: no-op
    expect((await send("COMPLETED_SPOOLER", { pagesPrinted: 21 })).status).toBe(200);
    expect((await send("SPOOLED")).status).toBe(200); // late event, no regression
    const j = (await env.db.query<{ status: string; spooler_job_id: number; pages_printed: number }>("select status, spooler_job_id, pages_printed from print_jobs where id = $1", [state.jobId]))[0]!;
    expect(j).toEqual({ status: "COMPLETED_SPOOLER", spooler_job_id: 12, pages_printed: 21 });
    const ev = await env.db.query<{ status: string }>("select status from print_job_events where job_id = $1 and source = 'AGENT' order by id", [state.jobId]);
    expect(ev.map((e) => e.status)).toEqual(["DOWNLOADED", "SUBMITTED", "SPOOLED", "PRINTING", "COMPLETED_SPOOLER"]);
    const o = (await env.db.query<{ status: string }>("select status from orders where id = $1", [state.orderId]))[0]!;
    expect(o.status).toBe("PRINTING");
    // READY is refused until staff verifies
    const ready = await call(status.POST, "x", { staff, params: { id: state.orderId }, body: { to: "READY" } });
    expect(ready.status).toBe(409);
    expect(ready.body.error).toBe("NOT_VERIFIED");
  });

  it("staff: Verify printed → job VERIFIED → order READY", async () => {
    const v = await call(verify.POST, "x", { staff, params: { id: state.jobId } });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.orderStatus).toBe("READY");
    const j = (await env.db.query<{ status: string; verified_by: string }>("select status, verified_by from print_jobs where id = $1", [state.jobId]))[0]!;
    expect(j).toEqual({ status: "VERIFIED", verified_by: staff });
  });

  it("staff: partial CASH + UPI payment, overpayment rejected, then delivered", async () => {
    const p1 = await call(payments.POST, "x", { staff, params: { id: state.orderId }, body: { method: "CASH", amountPaise: 2000 } });
    expect(p1.status, JSON.stringify(p1.body)).toBe(201);
    expect(p1.body).toMatchObject({ paidPaise: 2000, duePaise: 3750 });
    const noRef = await call(payments.POST, "x", { staff, params: { id: state.orderId }, body: { method: "UPI", amountPaise: 100 } });
    expect(noRef.status).toBe(400);
    const over = await call(payments.POST, "x", { staff, params: { id: state.orderId }, body: { method: "CASH", amountPaise: 999999 } });
    expect(over.status).toBe(409);
    const p2 = await call(payments.POST, "x", { staff, params: { id: state.orderId }, body: { method: "UPI", amountPaise: 3750, reference: "UTR123456789" } });
    expect(p2.body).toMatchObject({ paidPaise: 5750, duePaise: 0 });
    const d = await call(status.POST, "x", { staff, params: { id: state.orderId }, body: { to: "DELIVERED" } });
    expect(d.status).toBe(200);
  });

  it("staff: issues receipt with receipt number; HTML snapshot + PDF", async () => {
    const r = await call(receipts.POST, "x", { staff, params: { id: state.orderId } });
    expect(r.status).toBe(201);
    expect(r.body.receiptNumber).toMatch(/^MP-R-\d{4}-\d{5}$/);
    const pdf = await call(receiptPdf.GET, "x", { staff, params: { id: r.body.receiptId } });
    expect(pdf.status).toBe(200);
    expect(pdf.res.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(pdf.body).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("customer: tracking shows the full timeline, paid, due", async () => {
    const t = await call(track.POST, "/api/public/track", { body: { orderNumber: state.orderNumber, token: state.token } });
    expect(t.body.status).toBe("DELIVERED");
    expect(t.body.timeline.map((x: any) => x.status)).toEqual(["RECEIVED", "APPROVED", "PRINTING", "READY", "DELIVERED"]);
    expect(t.body).toMatchObject({ totalPaise: 5750, paidPaise: 5750, duePaise: 0 });
  });

  it("every admin action wrote an audit log", async () => {
    const actions = (await env.db.query<{ action: string }>("select distinct action from audit_logs")).map((a) => a.action);
    for (const a of ["order_item.edit", "order.assign", "order.status", "agent.create", "print_job.create", "print_job.verify", "payment.record", "receipt.issue", "file.preview"]) {
      expect(actions).toContain(a);
    }
  });
});
