import { getContext } from "@/lib/context";
import { handler, HttpError } from "@/lib/http/respond";
import { requireStaff } from "@/lib/http/guards";
import { getActiveQr, portalUrl, qrPng } from "@/lib/services/qr";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const ctx = await getContext();
  await requireStaff(ctx, req);
  const qr = await getActiveQr(ctx.db);
  if (!qr) throw new HttpError(404, "NO_ACTIVE_QR", "No active QR code");
  const png = await qrPng(portalUrl(ctx.config.APP_URL, qr.token), 1024);
  return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "content-disposition": 'attachment; filename="mansa-printer-qr.png"', "cache-control": "no-store" } });
});
