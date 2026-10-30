import { getContext } from "@/lib/context";
import { handler, HttpError, json, parseJsonText } from "@/lib/http/respond";
import { authenticateAgent, statusSchema, updateJobStatus } from "@/lib/services/agents";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request, { params }: { params: Promise<{ jobId: string }> }) => {
  const ctx = await getContext();
  const raw = await req.text();
  if (raw.length > 64 * 1024) throw new HttpError(413, "TOO_LARGE", "Body too large");
  const agent = await authenticateAgent(ctx, req, raw);
  const { jobId } = await params;
  return json(await updateJobStatus(ctx, agent, jobId, statusSchema.parse(parseJsonText(raw))));
});
