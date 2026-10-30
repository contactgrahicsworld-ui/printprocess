import { getContext } from "@/lib/context";
import { handler, json } from "@/lib/http/respond";
import { requireStaff, uuidParam } from "@/lib/http/guards";
import { getOrderDetail } from "@/lib/services/admin-orders";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getContext();
  await requireStaff(ctx, req);
  return json(await getOrderDetail(ctx.db, uuidParam((await params).id)));
});
