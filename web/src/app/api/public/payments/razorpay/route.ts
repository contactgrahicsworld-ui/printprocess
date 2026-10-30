import { getContext } from "@/lib/context";
import { clientIp, handler, HttpError, json, readJson } from "@/lib/http/respond";
import { LIMITS } from "@/lib/security/ratelimit";
import { trackSchema, verifyTracking } from "@/lib/services/orders";
import { createRazorpayOrder } from "@/lib/services/payments";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request) => {
  const ctx = await getContext();
  if (!ctx.config.razorpayEnabled) throw new HttpError(404, "NOT_ENABLED", "Online payment is not enabled");
  const body = await readJson(req, trackSchema);
  const ip = clientIp(req);
  if (!(await ctx.rateLimiter.hit(`rzp:${ip}`, LIMITS.razorpay.max, LIMITS.razorpay.window))) throw new HttpError(429, "RATE_LIMITED", "Too many attempts");
  const orderId = await verifyTracking(ctx, body.orderNumber, body.token, ip);
  return json(await createRazorpayOrder(ctx, orderId));
});
