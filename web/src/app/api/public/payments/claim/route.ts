import { z } from "zod";
import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { verifyTracking } from "@/lib/services/orders";
import { claimSchema, claimUpiPayment } from "@/lib/services/payments";

export const dynamic = "force-dynamic";

/** Customer submits the UTR after paying to the shop's UPI QR ("I have paid"). */
export const POST = handler(async (req: Request) => {
  const ctx = await getContext();
  const body = await readJson(req, claimSchema.extend({ orderNumber: z.string(), token: z.string() }));
  const orderId = await verifyTracking(ctx, body.orderNumber, body.token, clientIp(req));
  return json(await claimUpiPayment(ctx, orderId, { reference: body.reference, note: body.note }, clientIp(req)), 201);
});
