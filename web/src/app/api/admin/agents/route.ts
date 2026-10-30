import { z } from "zod";
import { getContext } from "@/lib/context";
import { clientIp, handler, json, readJson } from "@/lib/http/respond";
import { requireStaff } from "@/lib/http/guards";
import { createAgent, listAgents } from "@/lib/services/agents";

export const dynamic = "force-dynamic";

/** STAFF may list agents (needed to pick a printer); only OWNER/ADMIN may create/revoke. */
export const GET = handler(async (req: Request) => {
  const ctx = await getContext();
  await requireStaff(ctx, req);
  return json({ agents: await listAgents(ctx.db) });
});

export const POST = handler(async (req: Request) => {
  const ctx = await getContext();
  const staff = await requireStaff(ctx, req, "ADMIN");
  const body = await readJson(req, z.object({ name: z.string().trim().min(1).max(80) }));
  return json(await createAgent(ctx, staff, body.name, clientIp(req)), 201);
});
