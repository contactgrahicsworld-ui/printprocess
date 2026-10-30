import { z } from "zod";
import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { requireStaff, uuidParam } from "@/lib/http/guards";
import { assignOrder } from "@/lib/services/admin-orders";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req);
  const body = await readJson(req, z.object({ staffId: z.string().uuid().nullable() }));
  return json(await assignOrder(ctx, staff, uuidParam((await params).id), body.staffId, clientIp(req)));
});
