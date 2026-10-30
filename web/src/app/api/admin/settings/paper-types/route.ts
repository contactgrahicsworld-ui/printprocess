import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { requireStaff } from "@/lib/http/guards";
import { paperTypeSchema } from "@/lib/services/settings";
import { upsertPaperType } from "@/lib/services/settings-admin";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req, "ADMIN");
  return json(await upsertPaperType(ctx, staff, null, await readJson(req, paperTypeSchema), clientIp(req)), 201);
});
