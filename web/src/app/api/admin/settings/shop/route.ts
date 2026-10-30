import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { requireStaff } from "@/lib/http/guards";
import { loadShopSettings, shopSettingsSchema } from "@/lib/services/settings";
import { updateShop } from "@/lib/services/settings-admin";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const ctx = await getContext();
  await requireStaff(ctx, req);
  return json(await loadShopSettings(ctx.db));
});

export const PUT = handler(async (req: Request) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req, "ADMIN");
  return json(await updateShop(ctx, staff, await readJson(req, shopSettingsSchema), clientIp(req)));
});
