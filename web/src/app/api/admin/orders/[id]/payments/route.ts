import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { requireStaff, uuidParam } from "@/lib/http/guards";
import { paymentSchema, recordPayment } from "@/lib/services/payments";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req);
  const body = await readJson(req, paymentSchema);
  return json(await recordPayment(ctx, staff, uuidParam((await params).id), body, clientIp(req)), 201);
});
