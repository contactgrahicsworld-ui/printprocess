import { z } from "zod";
import type { AppContext } from "@/lib/context";
import type { Db } from "@/lib/db/types";
import { hasHint, pgTextArray } from "@/lib/db/types";
import type { Staff } from "@/lib/auth/types";
import { HttpError } from "@/lib/http/respond";
import { hmacHex, randomToken, safeEqualHex, sha256hex } from "@/lib/security/crypto";
import { AGENT_STATUSES, applyAgentStatus, type JobStatus } from "@/lib/orders/status";
import { audit } from "./audit";

export const MAX_SKEW_MS = 5 * 60 * 1000;
export const NONCE_TTL_MS = 10 * 60 * 1000;
export const DOWNLOAD_URL_TTL_S = 600;

// ---------------------------------------------------------------- admin management
export async function createAgent(ctx: AppContext, staff: Staff, name: string, ip: string) {
  const secret = randomToken(32);
  const hmacKey = sha256hex(secret);
  const r = (await ctx.db.query<{ id: string; created_at: Date }>(
    "insert into print_agents (name, secret_hash, hmac_key, created_by) values ($1, $2, $3, $4) returning id, created_at",
    [name, sha256hex(secret), hmacKey, staff.userId]))[0]!;
  await audit(ctx.db, staff, "agent.create", "print_agent", r.id, { name }, ip);
  // The raw secret is returned exactly once and never stored.
  return { agentId: r.id, name, secret, serverUrl: ctx.config.APP_URL };
}

export async function revokeAgent(ctx: AppContext, staff: Staff, agentId: string, ip: string) {
  const rows = await ctx.db.query("update print_agents set revoked_at = now(), revoked_by = $2 where id = $1 and revoked_at is null returning id", [agentId, staff.userId]);
  if (rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Agent not found or already revoked");
  // Return claimed-but-unstarted jobs to the queue so another agent can take them.
  await ctx.db.query("update print_jobs set status = 'QUEUED', claimed_by_agent = null, claimed_at = null, updated_at = now() where claimed_by_agent = $1 and status = 'CLAIMED'", [agentId]);
  await audit(ctx.db, staff, "agent.revoke", "print_agent", agentId, {}, ip);
  return { ok: true };
}

/** Never selects secret_hash / hmac_key. */
export async function listAgents(db: Db) {
  return db.query<{ id: string; name: string; created_at: Date; revoked_at: Date | null; last_heartbeat_at: Date | null; agent_version: string | null; hostname: string | null; printers: unknown }>(
    "select id, name, created_at, revoked_at, last_heartbeat_at, agent_version, hostname, printers from print_agents order by revoked_at nulls first, created_at desc");
}

// ---------------------------------------------------------------- request authentication (CONTRACT.md)
export interface AgentIdentity { id: string; name: string }

export function canonical(method: string, path: string, ts: string, nonce: string, body: string): string {
  return `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${sha256hex(body ?? "")}`;
}

/**
 * Verifies X-Agent-* headers. Order matters: cheap checks → agent lookup → constant-time signature check →
 * nonce insert (so unauthenticated callers cannot fill the nonce table). Any failure → 401 with a generic message.
 */
export async function authenticateAgent(ctx: AppContext, req: Request, rawBody: string): Promise<AgentIdentity> {
  const deny = (why: string) => new HttpError(401, "AGENT_AUTH_FAILED", "Agent authentication failed", { reason: why });
  const id = req.headers.get("x-agent-id") ?? "";
  const ts = req.headers.get("x-agent-timestamp") ?? "";
  const nonce = req.headers.get("x-agent-nonce") ?? "";
  const sig = (req.headers.get("x-agent-signature") ?? "").toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^\d{10,16}$/.test(ts) || !/^[0-9a-f-]{36}$/i.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) {
    throw deny("missing_or_malformed_headers");
  }
  const now = ctx.now().getTime();
  if (Math.abs(now - Number(ts)) > MAX_SKEW_MS) throw deny("timestamp_out_of_window");
  const a = (await ctx.db.query<{ id: string; name: string; hmac_key: string; revoked_at: Date | null }>(
    "select id, name, hmac_key, revoked_at from print_agents where id = $1", [id]))[0];
  const path = new URL(req.url).pathname;
  // Compute even for unknown agents so timing does not reveal which agent ids exist.
  const expected = hmacHex(a?.hmac_key ?? "0".repeat(64), canonical(req.method, path, ts, nonce, rawBody));
  const sigOk = safeEqualHex(expected, sig);
  if (!a || !sigOk) throw deny("bad_signature");
  if (a.revoked_at) throw deny("agent_revoked");
  const inserted = await ctx.db.query("insert into agent_nonces (agent_id, nonce) values ($1, $2) on conflict do nothing returning nonce", [a.id, nonce]);
  if (inserted.length === 0) throw deny("nonce_replayed");
  if (Math.random() < 0.02) {
    await ctx.db.query("delete from agent_nonces where created_at < $1", [new Date(now - NONCE_TTL_MS)]);
  }
  return { id: a.id, name: a.name };
}

// ---------------------------------------------------------------- endpoints
export const heartbeatSchema = z.object({
  agentVersion: z.string().max(40),
  hostname: z.string().max(255),
  printers: z.array(z.object({
    name: z.string().min(1).max(255),
    isDefault: z.boolean().default(false),
    status: z.string().max(64),
    supportsColor: z.boolean().default(false),
    supportsDuplex: z.boolean().default(false),
    paperSizes: z.array(z.string().max(32)).max(50).default([]),
  }).passthrough()).max(50),
}).passthrough();

export async function heartbeat(ctx: AppContext, agent: AgentIdentity, body: z.infer<typeof heartbeatSchema>) {
  await ctx.db.query("update print_agents set last_heartbeat_at = now(), agent_version = $2, hostname = $3, printers = $4::jsonb where id = $1",
    [agent.id, body.agentVersion, body.hostname, JSON.stringify(body.printers)]);
  return { ok: true, serverTime: ctx.now().getTime() };
}

export const claimSchema = z.object({ printers: z.array(z.string().max(255)).max(50).default([]) }).passthrough();

export interface PrintJobDto {
  jobId: string;
  orderNumber: string;
  orderItemId: string;
  attempt: number;
  printerName: string | null;
  fileName: string;
  mimeType: string;
  sha256: string;
  downloadUrl: string;
  settings: { colorMode: "BW" | "COLOR"; duplex: "SINGLE" | "DOUBLE"; paperSize: "A4" | "A3" | "LEGAL"; copies: number; pageRanges: string | null };
}

export async function claimJobs(ctx: AppContext, agent: AgentIdentity, body: z.infer<typeof claimSchema>): Promise<{ jobs: PrintJobDto[] }> {
  let claimed: { id: string }[];
  try {
    claimed = await ctx.db.query<{ id: string }>("select id from public.claim_print_jobs($1, $2::text[], 5)", [agent.id, pgTextArray(body.printers)]);
  } catch (e) {
    if (hasHint(e, "AGENT_REVOKED")) throw new HttpError(401, "AGENT_AUTH_FAILED", "Agent authentication failed");
    throw e;
  }
  if (claimed.length === 0) return { jobs: [] };
  const rows = await ctx.db.query<Record<string, unknown>>(
    `select j.id, j.attempt, j.printer_name, j.settings, j.order_item_id, o.order_number, f.original_name, f.detected_mime, f.sha256, f.storage_path, f.status as file_status
       from print_jobs j join orders o on o.id = j.order_id join uploaded_files f on f.id = j.file_id
      where j.id = any($1::uuid[]) order by j.claimed_at, j.created_at`, [pgTextArray(claimed.map((c) => c.id))]);
  const jobs: PrintJobDto[] = [];
  for (const r of rows) {
    if (r.file_status !== "READY") continue; // purged files are never handed out
    jobs.push({
      jobId: r.id as string,
      orderNumber: r.order_number as string,
      orderItemId: r.order_item_id as string,
      attempt: r.attempt as number,
      printerName: (r.printer_name as string | null) ?? null,
      fileName: r.original_name as string,
      mimeType: r.detected_mime as string,
      sha256: r.sha256 as string,
      downloadUrl: await ctx.storage.createSignedDownloadUrl(r.storage_path as string, DOWNLOAD_URL_TTL_S),
      settings: r.settings as PrintJobDto["settings"],
    });
  }
  return { jobs };
}

export const statusSchema = z.object({
  status: z.enum(AGENT_STATUSES),
  spoolerJobId: z.number().int().nullable().default(null),
  detail: z.string().max(2000).default(""),
  pagesPrinted: z.number().int().min(0).nullable().default(null),
  at: z.number().int().positive(),
}).passthrough();

/** Append-only event + monotonic-safe status update. Same (jobId, status) twice is a no-op. Never touches order status. */
export async function updateJobStatus(ctx: AppContext, agent: AgentIdentity, jobId: string, body: z.infer<typeof statusSchema>) {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new HttpError(404, "NOT_FOUND", "Job not found");
  return ctx.db.tx(async (tx) => {
    const j = (await tx.query<{ status: JobStatus; claimed_by_agent: string | null }>(
      "select status, claimed_by_agent from print_jobs where id = $1 for update", [jobId]))[0];
    if (!j || j.claimed_by_agent !== agent.id) throw new HttpError(404, "NOT_FOUND", "Job not found");
    const ins = await tx.query(
      `insert into print_job_events (job_id, source, status, spooler_job_id, pages_printed, detail, agent_at)
       values ($1, 'AGENT', $2, $3, $4, $5, $6) on conflict (job_id, status) where source = 'AGENT' do nothing returning id`,
      [jobId, body.status, body.spoolerJobId, body.pagesPrinted, body.detail.slice(0, 2000), new Date(body.at)]);
    if (ins.length === 0) return { ok: true };
    const next = applyAgentStatus(j.status, body.status);
    if (next) {
      await tx.query(
        `update print_jobs set status = $2, spooler_job_id = coalesce($3, spooler_job_id), pages_printed = coalesce($4, pages_printed),
                last_detail = $5, updated_at = now() where id = $1`,
        [jobId, next, body.spoolerJobId, body.pagesPrinted, body.detail.slice(0, 500)]);
    } else {
      await tx.query("update print_jobs set spooler_job_id = coalesce(spooler_job_id, $2), updated_at = now() where id = $1", [jobId, body.spoolerJobId]);
    }
    return { ok: true };
  });
}
