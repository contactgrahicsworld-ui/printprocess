import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { requireStaff } from "@/lib/http/guards";
import { loadPriceConfig, priceSettingsSchema } from "@/lib/services/settings";
import { updatePrices } from "@/lib/services/settings-admin";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const ctx = await getContext();
  await requireStaff(ctx, req);
  return json(await loadPriceConfig(ctx.db));
});

export const PUT = handler(async (req: Request) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req, "ADMIN");
  return json(await updatePrices(ctx, staff, await readJson(req, priceSettingsSchema), clientIp(req)));
});
