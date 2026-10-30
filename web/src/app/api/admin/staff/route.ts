import { getContext } from "@/lib/context";
import { handler, json } from "@/lib/http/respond";
import { requireStaff } from "@/lib/http/guards";
import { listStaff } from "@/lib/services/admin-orders";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const ctx = await getContext();
  await requireStaff(ctx, req);
  return json({ staff: await listStaff(ctx.db) });
});
