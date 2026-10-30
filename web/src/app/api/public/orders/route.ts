import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { requireSession } from "@/lib/services/sessions";
import { submitOrder, submitSchema } from "@/lib/services/orders";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request) => {
  const ctx = await getContext();
  // allowSubmitted: an idempotent retry after a lost response must still get the original order back.
  const session = await requireSession(ctx, req, { allowSubmitted: true });
  const body = await readJson(req, submitSchema);
  const res = await submitOrder(ctx, session, body, clientIp(req));
  return json(res, res.replayed ? 200 : 201);
});
