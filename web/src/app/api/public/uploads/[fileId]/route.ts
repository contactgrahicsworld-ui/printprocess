import { getContext } from "@/lib/context";
import { handler, json } from "@/lib/http/respond";
import { uuidParam } from "@/lib/http/guards";
import { requireSession } from "@/lib/services/sessions";
import { removeUpload } from "@/lib/services/uploads";

export const dynamic = "force-dynamic";

export const DELETE = handler(async (req: Request, { params }: { params: Promise<{ fileId: string }> }) => {
  const ctx = await getContext();
  const session = await requireSession(ctx, req);
  const { fileId } = await params;
  return json(await removeUpload(ctx, session, uuidParam(fileId)));
});
