import { getContext } from "@/lib/context";
import { handler, HttpError, json } from "@/lib/http/respond";
import { requireStaff } from "@/lib/http/guards";
import { listOrders, TABS, tabCounts, type Tab } from "@/lib/services/admin-orders";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const ctx = await getContext();
  await requireStaff(ctx, req);
  const tab = (new URL(req.url).searchParams.get("tab") ?? "new") as Tab;
  if (!(tab in TABS)) throw new HttpError(400, "BAD_TAB", "Unknown tab");
  return json({ orders: await listOrders(ctx.db, tab), counts: await tabCounts(ctx.db) });
});
