import { z } from "zod";
import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { requireStaff, uuidParam } from "@/lib/http/guards";
import { changeStatus } from "@/lib/services/admin-orders";
import { ORDER_STATUSES } from "@/lib/orders/status";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req);
  const body = await readJson(req, z.object({ to: z.enum(ORDER_STATUSES), reason: z.string().trim().max(300).nullable().default(null) }));
  return json({ status: await changeStatus(ctx, staff, uuidParam((await params).id), body.to, body.reason, clientIp(req)) });
});
