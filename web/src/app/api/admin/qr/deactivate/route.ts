import { getContext } from "@/lib/context";
import { clientIp, handler, json } from "@/lib/http/respond";
import { requireStaff } from "@/lib/http/guards";
import { deactivateQr } from "@/lib/services/qr";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req, "ADMIN");
  await deactivateQr(ctx.db, staff, clientIp(req));
  return json({ ok: true });
});
