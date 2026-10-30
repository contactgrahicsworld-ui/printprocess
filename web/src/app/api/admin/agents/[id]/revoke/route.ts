import { getContext } from "@/lib/context";
import { clientIp, handler, json } from "@/lib/http/respond";
import { requireStaff, uuidParam } from "@/lib/http/guards";
import { revokeAgent } from "@/lib/services/agents";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req, "ADMIN");
  return json(await revokeAgent(ctx, staff, uuidParam((await params).id), clientIp(req)));
});
