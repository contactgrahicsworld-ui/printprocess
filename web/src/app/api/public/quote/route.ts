import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { requireSession } from "@/lib/services/sessions";
import { previewQuote, quoteSchema } from "@/lib/services/orders";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request) => {
  const ctx = await getContext();
  const session = await requireSession(ctx, req);
  const body = await readJson(req, quoteSchema);
  return json(await previewQuote(ctx, session, body, clientIp(req)));
});
