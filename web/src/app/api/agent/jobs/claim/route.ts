import { getContext } from "@/lib/context";
import { handler, HttpError, json, parseJsonText } from "@/lib/http/respond";
import { authenticateAgent, claimJobs, claimSchema } from "@/lib/services/agents";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request) => {
  const ctx = await getContext();
  const raw = await req.text();
  if (raw.length > 64 * 1024) throw new HttpError(413, "TOO_LARGE", "Body too large");
  const agent = await authenticateAgent(ctx, req, raw);
  return json(await claimJobs(ctx, agent, claimSchema.parse(parseJsonText(raw))));
});
