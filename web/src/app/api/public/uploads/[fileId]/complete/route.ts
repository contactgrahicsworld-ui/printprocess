import { getContext } from "@/lib/context";
import { handler, json } from "@/lib/http/respond";
import { uuidParam } from "@/lib/http/guards";
import { requireSession } from "@/lib/services/sessions";
import { completeUpload } from "@/lib/services/uploads";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = handler(async (req: Request, { params }: { params: Promise<{ fileId: string }> }) => {
  const ctx = await getContext();
  const session = await requireSession(ctx, req);
  const { fileId } = await params;
  return json({ file: await completeUpload(ctx, session, uuidParam(fileId)) });
});
