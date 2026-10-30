import { getContext } from "@/lib/context";
import { handler, HttpError, json } from "@/lib/http/respond";
import { safeEqual } from "@/lib/security/crypto";
import { runRetention } from "@/lib/services/retention";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Called daily by Vercel Cron (Authorization: Bearer $CRON_SECRET) or by Supabase pg_cron via pg_net. */
async function run(req: Request) {
  const ctx = await getContext();
  const secret = ctx.config.CRON_SECRET;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || !safeEqual(given, secret)) throw new HttpError(401, "UNAUTHORIZED", "Unauthorized");
  return json(await runRetention(ctx));
}
export const GET = handler(run);
export const POST = handler(run);
