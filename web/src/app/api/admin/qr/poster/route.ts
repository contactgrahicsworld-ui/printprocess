import { getContext } from "@/lib/context";
import { handler, HttpError } from "@/lib/http/respond";
import { requireStaff } from "@/lib/http/guards";
import { getActiveQr, portalUrl, qrPosterPdf } from "@/lib/services/qr";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const ctx = await getContext();
  await requireStaff(ctx, req);
  const qr = await getActiveQr(ctx.db);
  if (!qr) throw new HttpError(404, "NO_ACTIVE_QR", "No active QR code");
  const pdf = await qrPosterPdf(ctx.db, portalUrl(ctx.config.APP_URL, qr.token));
  return new Response(Buffer.from(pdf), { headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="mansa-printer-qr-poster-a4.pdf"', "cache-control": "no-store" } });
});
