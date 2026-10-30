import { z } from "zod";
import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { requireStaff, uuidParam } from "@/lib/http/guards";
import { requeuePrintJob } from "@/lib/services/print-jobs";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req);
  const body = await readJson(req, z.object({ agentId: z.string().uuid().optional(), printerName: z.string().trim().min(1).max(200).nullable().optional() }));
  return json(await requeuePrintJob(ctx, staff, uuidParam((await params).id), body, clientIp(req)), 201);
});
