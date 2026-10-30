import { beforeAll, describe, expect, it } from "vitest";
import { agentHeaders, call, createTestEnv, makeEncryptedPdf, makeJpeg, makePdf, makePng, seedQr, seedStaff, utf8, type TestEnv } from "../helpers/harness";
import { routes, startSession, submitSimpleOrder, uploadFile } from "../helpers/flows";
import * as approve from "@/app/api/admin/orders/[id]/approve/route";
import * as adminOrder from "@/app/api/admin/orders/[id]/route";
import * as sendToPrinter from "@/app/api/admin/order-items/[id]/print-jobs/route";
import * as agents from "@/app/api/admin/agents/route";
import * as revoke from "@/app/api/admin/agents/[id]/revoke/route";
import * as heartbeat from "@/app/api/agent/heartbeat/route";
import * as claim from "@/app/api/agent/jobs/claim/route";
import * as jobStatus from "@/app/api/agent/jobs/[jobId]/status/route";
import * as requeue from "@/app/api/admin/print-jobs/[id]/requeue/route";
import * as cancelJob from "@/app/api/admin/print-jobs/[id]/cancel/route";
import * as track from "@/app/api/public/track/route";
import * as removeFile from "@/app/api/public/uploads/[fileId]/route";
import * as regen from "@/app/api/admin/qr/regenerate/route";
import * as deact from "@/app/api/admin/qr/deactivate/route";
import * as qrPng from "@/app/api/admin/qr/png/route";
import * as qrPoster from "@/app/api/admin/qr/poster/route";
import * as cron from "@/app/api/cron/retention/route";
import * as shop from "@/app/api/admin/settings/shop/route";

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

describe("upload validation", () => {
  it("rejects a file whose content is not PDF/JPG/PNG even if named .pdf and declared application/pdf", async () => {
    const s = await startSession(qr);
    const exe = utf8("MZ\x90\x00\x03\x00\x00\x00 this program cannot be run in DOS mode");
    const up = await uploadFile(s, "invoice.pdf", exe, "application/pdf");
    expect(up.completeStatus).toBe(200);
    expect(up.file.status).toBe("REJECTED");
    expect(up.file.rejectReason).toMatch(/Not a real PDF/);
    const path = (await env.db.query<{ storage_path: string }>("select storage_path from uploaded_files where id = $1", [up.fileId]))[0]!.storage_path;
    expect(env.files.has(path)).toBe(false); // rejected object removed from storage
  });

  it("accepts real PNG and JPEG images as 1 page each", async () => {
    const s = await startSession(qr);
    const png = await uploadFile(s, "photo.png", await makePng(), "image/png");
    expect(png.file).toMatchObject({ status: "READY", pageCount: 1, mimeType: "image/png" });
    const jpg = await uploadFile(s, "photo.jpg", makeJpeg(), "image/jpeg");
    expect(jpg.file).toMatchObject({ status: "READY", pageCount: 1, mimeType: "image/jpeg" });
  });

  it("rejects oversized uploads: declared size before URL is issued, and actual bytes after upload", async () => {
    await env.db.query("update shop_settings set max_file_bytes = 2048");
    try {
      const s = await startSession(qr);
      const big = await call(routes.uploads.POST, "/api/public/uploads", { session: s, body: { name: "big.pdf", size: 5000, contentType: "application/pdf" } });
      expect(big.status).toBe(413);
      expect(big.body.error).toBe("FILE_TOO_LARGE");
      // lie about size, then upload more bytes than allowed
      const r = await call(routes.uploads.POST, "/api/public/uploads", { session: s, body: { name: "liar.pdf", size: 100, contentType: "application/pdf" } });
      expect(r.status).toBe(201);
      await call(routes.localStorage.PUT, r.body.upload.url, { method: "PUT", rawBody: new Uint8Array(4096).fill(0x25) });
      const c = await call(routes.complete.POST, "x", { session: s, params: { fileId: r.body.fileId } });
      expect(c.body.file.status).toBe("REJECTED");
      expect(c.body.file.rejectReason).toMatch(/too large/i);
    } finally {
      await env.db.query("update shop_settings set max_file_bytes = 26214400");
    }
  });

  it("rejects encrypted and corrupt PDFs gracefully (no 500)", async () => {
    const s = await startSession(qr);
    const enc = await uploadFile(s, "locked.pdf", await makeEncryptedPdf());
    expect(enc.completeStatus).toBe(200);
    expect(enc.file.status).toBe("REJECTED");
    expect(enc.file.rejectReason).toMatch(/password/i);
    const bad = await uploadFile(s, "broken.pdf", (await makePdf(3)).subarray(0, 300));
    expect(bad.file.status).toBe("REJECTED");
  });

  it("enforces max files per session and allows removing before submit", async () => {
    await env.db.query("update shop_settings set max_files = 2");
    try {
      const s = await startSession(qr);
      const a = await uploadFile(s, "a.pdf", await makePdf(1));
      await uploadFile(s, "b.pdf", await makePdf(1));
      const c = await call(routes.uploads.POST, "/api/public/uploads", { session: s, body: { name: "c.pdf", size: 100, contentType: "application/pdf" } });
      expect(c.status).toBe(409);
      expect((await call(removeFile.DELETE, "x", { method: "DELETE", session: s, params: { fileId: a.fileId! } })).status).toBe(200);
      const d = await call(routes.uploads.POST, "/api/public/uploads", { session: s, body: { name: "c.pdf", size: 100, contentType: "application/pdf" } });
      expect(d.status).toBe(201);
    } finally {
      await env.db.query("update shop_settings set max_files = 10");
    }
  });

  it("signed upload URLs are bound to path and cannot be forged or reused", async () => {
    const s = await startSession(qr);
    const r = await call(routes.uploads.POST, "/api/public/uploads", { session: s, body: { name: "x.pdf", size: 100, contentType: "application/pdf" } });
    const forged = r.body.upload.url.replace(/sig=[0-9a-f]+/, "sig=" + "0".repeat(64));
    expect((await call(routes.localStorage.PUT, forged, { method: "PUT", rawBody: await makePdf(1) })).status).toBe(403);
    expect((await call(routes.localStorage.PUT, r.body.upload.url, { method: "PUT", rawBody: await makePdf(1) })).status).toBe(200);
    expect((await call(routes.localStorage.PUT, r.body.upload.url, { method: "PUT", rawBody: await makePdf(2) })).status).toBe(409);
  });
});

describe("interrupted upload / incomplete session", () => {
  it("cannot complete a file that was never uploaded, and cannot submit while a file is pending", async () => {
    const s = await startSession(qr);
    const ok = await uploadFile(s, "ok.pdf", await makePdf(2));
    const half = await uploadFile(s, "half.pdf", await makePdf(2), "application/pdf", { skipPut: true });
    expect(half.completeStatus).toBe(409);
    expect(half.completeBody.error).toBe("NOT_UPLOADED");
    const item = (fileId: string) => ({ fileId, colorMode: "BW", duplex: "SINGLE", paperSize: "A4", copies: 1, pageRanges: null, paperTypeId: null, serviceCodes: [], instructions: null });
    // pending file referenced directly
    const r1 = await call(routes.orders.POST, "x", { session: s, body: { items: [item(half.fileId!)], orderServiceCodes: [], idempotencyKey: "idem-interrupt-1", customerName: "A", customerPhone: null, notes: null, expectedTotalPaise: 400 } });
    expect(r1.status).toBe(409);
    // only the good file referenced, but another is still pending
    const r2 = await call(routes.orders.POST, "x", { session: s, body: { items: [item(ok.fileId!)], orderServiceCodes: [], idempotencyKey: "idem-interrupt-2", customerName: "A", customerPhone: null, notes: null, expectedTotalPaise: 400 } });
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe("UPLOAD_INCOMPLETE");
    expect((await env.db.query("select 1 from orders where session_id = (select session_id from uploaded_files where id = $1)", [ok.fileId])).length).toBe(0);
  });

  it("expired session cannot upload or submit", async () => {
    const s = await startSession(qr);
    env.clock.now += 3 * 3600_000;
    try {
      const r = await call(routes.uploads.POST, "x", { session: s, body: { name: "a.pdf", size: 10, contentType: "application/pdf" } });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("SESSION_EXPIRED");
    } finally {
      env.clock.now -= 3 * 3600_000;
    }
  });

  it("garbage session token is rejected", async () => {
    const r = await call(routes.uploads.POST, "x", { session: "nope", body: { name: "a.pdf", size: 10, contentType: "application/pdf" } });
    expect(r.status).toBe(401);
  });
});

describe("pricing tamper + idempotency", () => {
  async function prepared() {
    const s = await startSession(qr);
    const up = await uploadFile(s, "doc.pdf", await makePdf(5));
    const item = { fileId: up.fileId!, colorMode: "BW", duplex: "DOUBLE", paperSize: "A4", copies: 1, pageRanges: null, paperTypeId: null, serviceCodes: [], instructions: null };
    return { s, item };
  }

  it("rejects a tampered (lower) price and returns the real quote; nothing is created", async () => {
    const { s, item } = await prepared();
    const r = await call(routes.orders.POST, "x", { session: s, body: { items: [item], orderServiceCodes: [], idempotencyKey: "idem-tamper-1", customerName: "A", customerPhone: null, notes: null, expectedTotalPaise: 1 } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("PRICE_MISMATCH");
    expect(r.body.quote.totalPaise).toBe(750);
    expect((await env.db.query("select 1 from orders where idempotency_key = 'idem-tamper-1'")).length).toBe(0);
  });

  it("rejects client-invented fields (unknown service, out-of-range page, bad copies)", async () => {
    const { s, item } = await prepared();
    const bad = async (patch: object) => (await call(routes.quote.POST, "x", { session: s, body: { items: [{ ...item, ...patch }], orderServiceCodes: [] } })).status;
    expect(await bad({ serviceCodes: ["FREE_PRINT"] })).toBe(422);
    expect(await bad({ pageRanges: "1-9" })).toBe(422);
    expect(await bad({ copies: 0 })).toBe(400);
    expect(await bad({ copies: 10000 })).toBe(400);
    expect(await bad({ colorMode: "RAINBOW" })).toBe(400);
  });

  it("same idempotency key twice → one order, same response (incl. tracking token); concurrent duplicates too", async () => {
    const { s, item } = await prepared();
    const body = { items: [item], orderServiceCodes: [], idempotencyKey: "idem-dupe-key-1", customerName: "A", customerPhone: null, notes: null, expectedTotalPaise: 750 };
    const [a, b] = await Promise.all([call(routes.orders.POST, "x", { session: s, body }), call(routes.orders.POST, "x", { session: s, body })]);
    const c = await call(routes.orders.POST, "x", { session: s, body });
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 201]);
    expect(c.status).toBe(200);
    expect(c.body.replayed).toBe(true);
    expect(new Set([a.body.orderNumber, b.body.orderNumber, c.body.orderNumber]).size).toBe(1);
    expect(c.body.trackingToken).toBe(a.body.trackingToken);
    expect((await env.db.query("select 1 from orders where idempotency_key = 'idem-dupe-key-1'")).length).toBe(1);
    // a different key on the same (now submitted) session is refused
    const d = await call(routes.orders.POST, "x", { session: s, body: { ...body, idempotencyKey: "idem-dupe-key-2" } });
    expect(d.status).toBe(409);
  });
});

describe("print jobs + agent auth", () => {
  let agentId: string;
  let secret: string;
  let order: { orderId: string; itemId: string };

  beforeAll(async () => {
    const a = await call(agents.POST, "x", { staff: owner, body: { name: "Agent A" } });
    agentId = a.body.agentId;
    secret = a.body.secret;
    const hb = JSON.stringify({ agentVersion: "1.0.0", hostname: "PC", printers: [{ name: "Epson L3150", isDefault: true, status: "Normal", supportsColor: true, supportsDuplex: false, paperSizes: ["A4"] }] });
    await call(heartbeat.POST, "/api/agent/heartbeat", { rawBody: hb, headers: agentHeaders(agentId, secret, "POST", "/api/agent/heartbeat", hb) });
    const o = await submitSimpleOrder(qr);
    await call(approve.POST, "x", { staff, params: { id: o.orderId } });
    const d = await call(adminOrder.GET, "x", { staff, params: { id: o.orderId } });
    order = { orderId: o.orderId, itemId: d.body.items[0].id };
  });

  const signedClaim = (opts: { ts?: number; nonce?: string; key?: string; id?: string; body?: string; signBody?: string; path?: string } = {}) => {
    const body = opts.body ?? JSON.stringify({ printers: ["Epson L3150"] });
    const h = agentHeaders(opts.id ?? agentId, secret, "POST", opts.path ?? "/api/agent/jobs/claim", opts.signBody ?? body, opts);
    return call(claim.POST, "/api/agent/jobs/claim", { rawBody: body, headers: h });
  };

  it("refuses to send unapproved orders and printers not in the heartbeat", async () => {
    const o = await submitSimpleOrder(qr);
    const d = await call(adminOrder.GET, "x", { staff, params: { id: o.orderId } });
    const r = await call(sendToPrinter.POST, "x", { staff, params: { id: d.body.items[0].id }, body: { agentId, printerName: "Epson L3150" } });
    expect(r.status).toBe(409);
    const r2 = await call(sendToPrinter.POST, "x", { staff, params: { id: order.itemId }, body: { agentId, printerName: "Imaginary Printer" } });
    expect(r2.status).toBe(400);
  });

  it("duplicate job creation is blocked (sequential and concurrent) by the unique partial index", async () => {
    const send = () => call(sendToPrinter.POST, "x", { staff, params: { id: order.itemId }, body: { agentId, printerName: "Epson L3150" } });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const c = await send();
    expect(c.status).toBe(409);
    expect(c.body.error).toBe("DUPLICATE_JOB");
    expect((await env.db.query("select 1 from print_jobs where order_item_id = $1", [order.itemId])).length).toBe(1);
  });

  it("rejects bad signature, wrong body, wrong path, unknown agent, expired / future timestamps", async () => {
    expect((await signedClaim({ key: "f".repeat(64) })).status).toBe(401);
    expect((await signedClaim({ signBody: '{"printers":[]}' })).status).toBe(401);
    expect((await signedClaim({ path: "/api/agent/heartbeat" })).status).toBe(401);
    expect((await signedClaim({ id: crypto.randomUUID() })).status).toBe(401);
    expect((await signedClaim({ ts: Date.now() - 6 * 60_000 })).status).toBe(401);
    expect((await signedClaim({ ts: Date.now() + 6 * 60_000 })).status).toBe(401);
    const noHeaders = await call(claim.POST, "/api/agent/jobs/claim", { rawBody: "{}" });
    expect(noHeaders.status).toBe(401);
    // nothing was claimed by the failed attempts
    expect((await env.db.query("select 1 from print_jobs where status = 'CLAIMED'")).length).toBe(0);
  });

  it("rejects a replayed nonce", async () => {
    const nonce = crypto.randomUUID();
    const first = await signedClaim({ nonce });
    expect(first.status).toBe(200);
    expect(first.body.jobs).toHaveLength(1);
    const replay = await signedClaim({ nonce });
    expect(replay.status).toBe(401);
    expect(replay.body.reason).toBe("nonce_replayed");
  });

  it("another agent cannot claim or update this agent's job", async () => {
    const b = await call(agents.POST, "x", { staff: owner, body: { name: "Agent B" } });
    const body = JSON.stringify({ printers: ["Epson L3150"] });
    const r = await call(claim.POST, "/api/agent/jobs/claim", { rawBody: body, headers: agentHeaders(b.body.agentId, b.body.secret, "POST", "/api/agent/jobs/claim", body) });
    expect(r.body.jobs).toHaveLength(0);
    const jobId = (await env.db.query<{ id: string }>("select id from print_jobs where order_item_id = $1", [order.itemId]))[0]!.id;
    const path = `/api/agent/jobs/${jobId}/status`;
    const sb = JSON.stringify({ status: "PRINTING", spoolerJobId: 1, detail: "", pagesPrinted: null, at: Date.now() });
    const u = await call(jobStatus.POST, path, { rawBody: sb, params: { jobId }, headers: agentHeaders(b.body.agentId, b.body.secret, "POST", path, sb) });
    expect(u.status).toBe(404);
  });

  it("failed job can be re-queued as attempt 2; staff can cancel queued jobs; agent cannot resurrect terminal jobs", async () => {
    const jobId = (await env.db.query<{ id: string }>("select id from print_jobs where order_item_id = $1", [order.itemId]))[0]!.id;
    const path = `/api/agent/jobs/${jobId}/status`;
    const sb = JSON.stringify({ status: "PAPER_OUT", spoolerJobId: null, detail: "Tray 1 empty", pagesPrinted: null, at: Date.now() });
    expect((await call(jobStatus.POST, path, { rawBody: sb, params: { jobId }, headers: agentHeaders(agentId, secret, "POST", path, sb) })).status).toBe(200);
    const sb2 = JSON.stringify({ status: "COMPLETED_SPOOLER", spoolerJobId: null, detail: "", pagesPrinted: null, at: Date.now() });
    await call(jobStatus.POST, path, { rawBody: sb2, params: { jobId }, headers: agentHeaders(agentId, secret, "POST", path, sb2) });
    expect((await env.db.query<{ status: string }>("select status from print_jobs where id = $1", [jobId]))[0]!.status).toBe("PAPER_OUT");
    const rq = await call(requeue.POST, "x", { staff, params: { id: jobId }, body: {} });
    expect(rq.status, JSON.stringify(rq.body)).toBe(201);
    expect(rq.body.attempt).toBe(2);
    const rq2 = await call(requeue.POST, "x", { staff, params: { id: jobId }, body: {} });
    expect(rq2.status).toBe(409); // new attempt is active → duplicate prevented
    const cancel = await call(cancelJob.POST, "x", { staff, params: { id: rq.body.jobId } });
    expect(cancel.status).toBe(200);
    const nb = JSON.stringify({ printers: ["Epson L3150"] });
    const r = await call(claim.POST, "/api/agent/jobs/claim", { rawBody: nb, headers: agentHeaders(agentId, secret, "POST", "/api/agent/jobs/claim", nb) });
    expect(r.body.jobs).toHaveLength(0); // cancelled job is never handed out
  });

  it("revoked agent is refused", async () => {
    expect((await call(revoke.POST, "x", { staff: owner, params: { id: agentId } })).status).toBe(200);
    const r = await signedClaim();
    expect(r.status).toBe(401);
  });
});

describe("tracking access control", () => {
  it("cross-order token, wrong token and unknown order all return the same generic 404", async () => {
    const a = await submitSimpleOrder(qr);
    const b = await submitSimpleOrder(qr);
    const cross = await call(track.POST, "x", { body: { orderNumber: b.orderNumber, token: a.trackingToken }, ip: "198.51.100.1" });
    const wrong = await call(track.POST, "x", { body: { orderNumber: a.orderNumber, token: "x".repeat(43) }, ip: "198.51.100.1" });
    const unknown = await call(track.POST, "x", { body: { orderNumber: "MP-20990101-9999", token: a.trackingToken }, ip: "198.51.100.1" });
    for (const r of [cross, wrong, unknown]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual(cross.body);
    }
    expect((await call(track.POST, "x", { body: { orderNumber: a.orderNumber, token: a.trackingToken }, ip: "198.51.100.1" })).status).toBe(200);
  });

  it("is rate limited per IP", async () => {
    let last = 0;
    for (let i = 0; i < 22; i++) last = (await call(track.POST, "x", { body: { orderNumber: "MP-20990101-0001", token: "t" }, ip: "198.51.100.77" })).status;
    expect(last).toBe(429);
  });
});

describe("QR lifecycle", () => {
  it("regenerate deactivates the old token; deactivate leaves no active QR; PNG + A4 poster download", async () => {
    const old = qr;
    const r = await call(regen.POST, "x", { staff: owner, body: { label: "Counter" } });
    expect(r.status).toBe(201);
    const oldTry = await call(routes.sessions.POST, "x", { body: { qrToken: old }, ip: "192.0.2.50" });
    expect(oldTry.status).toBe(404);
    expect(oldTry.body.error).toBe("QR_INVALID");
    expect((await call(routes.sessions.POST, "x", { body: { qrToken: r.body.qr.token }, ip: "192.0.2.50" })).status).toBe(201);
    const png = await call(qrPng.GET, "x", { staff });
    expect(png.res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(png.body).subarray(1, 4).toString()).toBe("PNG");
    const pdf = await call(qrPoster.GET, "x", { staff });
    expect(Buffer.from(pdf.body).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await call(regen.POST, "x", { staff, body: {} })).status).toBe(403); // STAFF cannot regenerate
    expect((await call(deact.POST, "x", { staff: owner })).status).toBe(200);
    expect((await call(routes.sessions.POST, "x", { body: { qrToken: r.body.qr.token }, ip: "192.0.2.50" })).status).toBe(404);
    qr = (await call(regen.POST, "x", { staff: owner, body: {} })).body.qr.token;
  });

  it("session creation is rate limited per IP", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call(routes.sessions.POST, "x", { body: { qrToken: qr }, ip: "192.0.2.99" })).status;
    expect(last).toBe(429);
  });
});

describe("retention cron", () => {
  it("requires CRON_SECRET and purges files of finished orders older than retention_days", async () => {
    expect((await call(cron.GET, "/api/cron/retention")).status).toBe(401);
    expect((await call(cron.GET, "/api/cron/retention", { headers: { authorization: "Bearer wrong-secret-123456" } })).status).toBe(401);
    const o = await submitSimpleOrder(qr);
    await env.db.query("update orders set status = 'CANCELLED' where id = $1", [o.orderId]);
    await env.db.query("update uploaded_files set created_at = now() - interval '30 days' where id = $1", [o.fileId]);
    const path = (await env.db.query<{ storage_path: string }>("select storage_path from uploaded_files where id = $1", [o.fileId]))[0]!.storage_path;
    expect(env.files.has(path)).toBe(true);
    const r = await call(cron.GET, "/api/cron/retention", { headers: { authorization: "Bearer cron-secret-0123456789" } });
    expect(r.status).toBe(200);
    expect(r.body.purged).toBeGreaterThanOrEqual(1);
    expect(env.files.has(path)).toBe(false);
    expect((await env.db.query<{ status: string }>("select status from uploaded_files where id = $1", [o.fileId]))[0]!.status).toBe("PURGED");
  });
});

describe("admin API RBAC + CSRF", () => {
  const shopBody = { shopName: "Mansa Printer", address: "Bhilai", phone: null, gstin: null, upiId: "mansa@upi", upiPayeeName: null, maxFileBytes: 26214400, maxFiles: 10, sessionTtlMinutes: 120, retentionDays: 7 };
  it("STAFF cannot change settings or manage agents; unauthenticated gets 401; cross-site POST gets 403", async () => {
    expect((await call(shop.PUT, "x", { method: "PUT", staff, body: shopBody })).status).toBe(403);
    expect((await call(agents.POST, "x", { staff, body: { name: "x" } })).status).toBe(403);
    expect((await call(shop.PUT, "x", { method: "PUT", body: shopBody, headers: { origin: "http://localhost:3000" } })).status).toBe(401);
    const csrf = await call(shop.PUT, "x", { method: "PUT", body: shopBody, headers: { "x-test-staff": owner, origin: "https://evil.example" } });
    expect(csrf.status).toBe(403);
    expect(csrf.body.error).toBe("CSRF");
    expect((await call(shop.PUT, "x", { method: "PUT", staff: owner, body: shopBody })).status).toBe(200);
  });
  it("deactivated staff lose access immediately", async () => {
    const s2 = await seedStaff(env.db, "ADMIN", "temp");
    await env.db.query("update staff_profiles set active = false where user_id = $1", [s2]);
    expect((await call(shop.GET, "x", { staff: s2 })).status).toBe(401);
  });
});
