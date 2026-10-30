import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { trackOrderView, trackSchema, verifyTracking } from "@/lib/services/orders";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request) => {
  const ctx = await getContext();
  const body = await readJson(req, trackSchema);
  const orderId = await verifyTracking(ctx, body.orderNumber, body.token, clientIp(req));
  return json(await trackOrderView(ctx, orderId));
});
