import { getContext } from "@/lib/context";
import { clientIp, handler, json } from "@/lib/http/respond";
import { requireStaff, uuidParam } from "@/lib/http/guards";
import { issueReceipt } from "@/lib/services/payments";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req);
  return json(await issueReceipt(ctx, staff, uuidParam((await params).id), clientIp(req)), 201);
});
