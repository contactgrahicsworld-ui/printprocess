import { z } from "zod";
import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { createUploadSession, getSessionState, requireSession } from "@/lib/services/sessions";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request) => {
  const ctx = await getContext();
  const body = await readJson(req, z.object({ qrToken: z.string().max(128) }));
  return json(await createUploadSession(ctx, body.qrToken, clientIp(req)), 201);
});

export const GET = handler(async (req: Request) => {
  const ctx = await getContext();
  const session = await requireSession(ctx, req);
  return json(await getSessionState(ctx, session));
});
