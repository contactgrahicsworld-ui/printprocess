import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { requireStaff } from "@/lib/http/guards";
import { serviceSchema } from "@/lib/services/settings";
import { upsertService } from "@/lib/services/settings-admin";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req, "ADMIN");
  return json(await upsertService(ctx, staff, null, await readJson(req, serviceSchema), clientIp(req)), 201);
});

export const GET = handler(async (req: Request) => {
  const ctx = await getContext();
  await requireStaff(ctx, req);
  return json({ services: await ctx.db.query("select id, code, name, unit, amount_paise, active, sort_order from services order by sort_order, name") });
});
