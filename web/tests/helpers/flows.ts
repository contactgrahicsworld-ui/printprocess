import { expect } from "vitest";
import { call, makePdf } from "./harness";
import * as sessions from "@/app/api/public/sessions/route";
import * as uploads from "@/app/api/public/uploads/route";
import * as complete from "@/app/api/public/uploads/[fileId]/complete/route";
import * as localStorage from "@/app/api/local-storage/[...path]/route";
import * as quote from "@/app/api/public/quote/route";
import * as orders from "@/app/api/public/orders/route";

export const routes = { sessions, uploads, complete, localStorage, quote, orders };

let ipCounter = 0;
const ipBySession = new Map<string, string>();
export const ipOf = (session: string) => ipBySession.get(session);
/** Each simulated customer gets its own IP (rate limits are per IP and are tested separately). */
export function nextIp(): string {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export async function startSession(qrToken: string, ip: string = nextIp()): Promise<string> {
  const r = await call(sessions.POST, "/api/public/sessions", { body: { qrToken }, ip });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  ipBySession.set(r.body.sessionToken, ip);
  return r.body.sessionToken as string;
}

/** Full browser-equivalent upload: request signed URL → PUT bytes to it → complete (server validation). */
export async function uploadFile(session: string, name: string, bytes: Uint8Array, contentType = "application/pdf", opts: { skipPut?: boolean } = {}) {
  const r = await call(uploads.POST, "/api/public/uploads", { session, ip: ipOf(session), body: { name, size: bytes.length, contentType } });
  if (r.status !== 201) return { requestStatus: r.status, requestBody: r.body } as const;
  const { fileId, upload } = r.body as { fileId: string; upload: { url: string; method: string; headers: Record<string, string> } };
  if (!opts.skipPut) {
    const put = await call(localStorage.PUT, upload.url, { method: "PUT", rawBody: bytes, headers: upload.headers });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  }
  const c = await call(complete.POST, `/api/public/uploads/${fileId}/complete`, { session, ip: ipOf(session), params: { fileId } });
  return { requestStatus: 201, fileId, completeStatus: c.status, file: c.body.file, completeBody: c.body } as const;
}

export interface SubmittedOrder { orderId: string; orderNumber: string; trackingToken: string; totalPaise: number; fileId: string }

/** Customer flow used by many tests: 1 PDF (default 12 pages), BW duplex, pages 1-3,7,10-12, 2 copies. */
export async function submitSimpleOrder(qrToken: string, opts: { pages?: number; ranges?: string | null; idem?: string } = {}): Promise<SubmittedOrder> {
  const session = await startSession(qrToken);
  const up = await uploadFile(session, "notes.pdf", await makePdf(opts.pages ?? 12));
  expect(up.completeStatus).toBe(200);
  const item = { fileId: up.fileId!, colorMode: "BW", duplex: "DOUBLE", paperSize: "A4", copies: 2, pageRanges: opts.ranges === undefined ? "1-3,7,10-12" : opts.ranges, paperTypeId: null, serviceCodes: [], instructions: null };
  const q = await call(quote.POST, "/api/public/quote", { session, ip: ipOf(session), body: { items: [item], orderServiceCodes: [] } });
  expect(q.status, JSON.stringify(q.body)).toBe(200);
  const s = await call(orders.POST, "/api/public/orders", {
    session, ip: ipOf(session),
    body: { items: [item], orderServiceCodes: [], idempotencyKey: opts.idem ?? `idem-${crypto.randomUUID()}`, customerName: "Ravi", customerPhone: "9876543210", notes: null, expectedTotalPaise: q.body.totalPaise },
  });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  return { orderId: s.body.orderId, orderNumber: s.body.orderNumber, trackingToken: s.body.trackingToken, totalPaise: s.body.totalPaise, fileId: up.fileId! };
}
