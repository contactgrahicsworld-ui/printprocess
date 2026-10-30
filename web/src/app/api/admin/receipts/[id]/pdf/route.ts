import { getContext } from "@/lib/context";
import { handler } from "@/lib/http/respond";
import { requireStaff, uuidParam } from "@/lib/http/guards";
import { getReceipt, receiptPdf } from "@/lib/services/payments";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getContext();
  await requireStaff(ctx, req);
  const snap = await getReceipt(ctx.db, uuidParam((await params).id));
  const bytes = await receiptPdf(snap);
  return new Response(Buffer.from(bytes), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${snap.receiptNumber}.pdf"`, "cache-control": "no-store" } });
});
