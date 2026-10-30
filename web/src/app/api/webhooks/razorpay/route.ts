import { getContext } from "@/lib/context";
import { handler, json } from "@/lib/http/respond";
import { handleRazorpayWebhook } from "@/lib/services/payments";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request) => {
  const ctx = await getContext();
  const raw = await req.text();
  return json(await handleRazorpayWebhook(ctx, raw, req.headers.get("x-razorpay-signature") ?? ""));
});
