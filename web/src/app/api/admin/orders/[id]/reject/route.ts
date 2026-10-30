import { z } from "zod";
import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { requireStaff, uuidParam } from "@/lib/http/guards";
import { rejectOrder } from "@/lib/services/admin-orders";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req);
  const body = await readJson(req, z.object({ reason: z.string().trim().min(3).max(300) }));
  return json({ status: await rejectOrder(ctx, staff, uuidParam((await params).id), body.reason, clientIp(req)) });
});
