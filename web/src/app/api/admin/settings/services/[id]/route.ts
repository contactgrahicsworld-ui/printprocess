import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { requireStaff, uuidParam } from "@/lib/http/guards";
import { serviceSchema } from "@/lib/services/settings";
import { upsertService } from "@/lib/services/settings-admin";

export const dynamic = "force-dynamic";

export const PUT = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req, "ADMIN");
  return json(await upsertService(ctx, staff, uuidParam((await params).id), await readJson(req, serviceSchema), clientIp(req)));
});
