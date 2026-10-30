import { getContext } from "@/lib/context";
import { clientIp, handler, json } from "@/lib/http/respond";
import { requireStaff, uuidParam } from "@/lib/http/guards";
import { approveOrder } from "@/lib/services/admin-orders";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req);
  return json({ status: await approveOrder(ctx, staff, uuidParam((await params).id), clientIp(req)) });
});
