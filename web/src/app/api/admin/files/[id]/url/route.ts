import { getContext } from "@/lib/context";
import { clientIp, handler, json } from "@/lib/http/respond";
import { requireStaff, uuidParam } from "@/lib/http/guards";
import { fileSignedUrl } from "@/lib/services/admin-orders";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req);
  const download = new URL(req.url).searchParams.get("download") === "1";
  return json(await fileSignedUrl(ctx, staff, uuidParam((await params).id), download, clientIp(req)));
});
