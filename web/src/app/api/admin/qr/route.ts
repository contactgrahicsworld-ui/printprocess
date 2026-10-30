import { getContext } from "@/lib/context";
import { handler, json } from "@/lib/http/respond";
import { requireStaff } from "@/lib/http/guards";
import { getActiveQr, portalUrl } from "@/lib/services/qr";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const ctx = await getContext();
  await requireStaff(ctx, req);
  const qr = await getActiveQr(ctx.db);
  return json({ qr: qr ? { ...qr, url: portalUrl(ctx.config.APP_URL, qr.token) } : null });
});
