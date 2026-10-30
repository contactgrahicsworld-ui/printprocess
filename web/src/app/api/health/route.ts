import { getContext } from "@/lib/context";
import { handler, json } from "@/lib/http/respond";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const ctx = await getContext();
  await ctx.db.query("select 1");
  return json({ ok: true, scanner: ctx.scanner.enabled ? "clamav" : "NOT_SCANNED", razorpay: ctx.config.razorpayEnabled });
});
