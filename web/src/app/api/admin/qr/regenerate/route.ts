import { z } from "zod";
import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { requireStaff } from "@/lib/http/guards";
import { portalUrl, regenerateQr } from "@/lib/services/qr";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req, "ADMIN");
  const body = await readJson(req, z.object({ label: z.string().trim().min(1).max(60).default("Counter QR") }));
  const qr = await regenerateQr(ctx.db, staff, body.label, clientIp(req));
  return json({ qr: { ...qr, url: portalUrl(ctx.config.APP_URL, qr.token) } }, 201);
});
