import { z } from "zod";
import type { AppContext } from "@/lib/context";
import { HttpError } from "@/lib/http/respond";
import { sha256hex } from "@/lib/security/crypto";
import { LIMITS } from "@/lib/security/ratelimit";
import { detectFileType, jpegInfo, pngInfo } from "@/lib/files/magic";
import { inspectPdf } from "@/lib/files/pdf";
import { loadShopSettings } from "./settings";
import { fileView, type UploadSession } from "./sessions";

export const uploadRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  size: z.number().int().positive(),
  contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
});

export function sanitizeFileName(name: string): string {
  const cleaned = name.normalize("NFC").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_").replace(/\s+/g, " ").trim();
  return (cleaned || "file").slice(0, 255);
}

/** Step 1: validate declared metadata, reserve a file row and return a one-time signed upload URL. */
export async function requestUpload(ctx: AppContext, session: UploadSession, input: z.infer<typeof uploadRequestSchema>, ip: string) {
  if (!(await ctx.rateLimiter.hit(`upload:${ip}`, LIMITS.uploadUrl.max, LIMITS.uploadUrl.window))) {
    throw new HttpError(429, "RATE_LIMITED", "Too many uploads. Please wait a few minutes.");
  }
  const shop = await loadShopSettings(ctx.db);
  if (input.size > shop.maxFileBytes) {
    throw new HttpError(413, "FILE_TOO_LARGE", `File is larger than ${Math.floor(shop.maxFileBytes / 1048576)} MB. / File bahut badi hai.`);
  }
  return ctx.db.tx(async (tx) => {
    await tx.query("select id from upload_sessions where id = $1 for update", [session.id]);
    const count = (await tx.query<{ n: number }>(
      "select count(*)::int as n from uploaded_files where session_id = $1 and status in ('PENDING_UPLOAD','READY')", [session.id]))[0]!.n;
    if (count >= shop.maxFiles) throw new HttpError(409, "TOO_MANY_FILES", `Maximum ${shop.maxFiles} files per order.`);
    const id = crypto.randomUUID();
    const path = `sessions/${session.id}/${id}`;
    await tx.query(
      "insert into uploaded_files (id, session_id, original_name, storage_path, declared_size) values ($1, $2, $3, $4, $5)",
      [id, session.id, sanitizeFileName(input.name), path, input.size]);
    const upload = await ctx.storage.createSignedUploadUrl(path, input.contentType);
    return { fileId: id, upload };
  });
}

async function reject(ctx: AppContext, fileId: string, path: string, reason: string, extra: { size?: number; scan?: { status: string; detail: string | null } } = {}) {
  await ctx.storage.remove([path]).catch(() => undefined);
  await ctx.db.query(
    `update uploaded_files set status = 'REJECTED', reject_reason = $2, size_bytes = coalesce($3, size_bytes),
            scan_status = coalesce($4::scan_status, scan_status), scan_detail = coalesce($5, scan_detail) where id = $1`,
    [fileId, reason, extra.size ?? null, extra.scan?.status ?? null, extra.scan?.detail ?? null]);
}

/**
 * Step 2 (after the browser finished the PUT): download the stored object and validate it for real —
 * size, magic bytes, PDF parse/encryption/page count, image structure, malware scan hook, sha256.
 */
export async function completeUpload(ctx: AppContext, session: UploadSession, fileId: string) {
  const row = (await ctx.db.query<{ id: string; storage_path: string; status: string }>(
    "select id, storage_path, status from uploaded_files where id = $1 and session_id = $2", [fileId, session.id]))[0];
  if (!row) throw new HttpError(404, "FILE_NOT_FOUND", "File not found");
  if (row.status !== "PENDING_UPLOAD") {
    const cur = (await ctx.db.query<Record<string, unknown>>("select * from uploaded_files where id = $1", [fileId]))[0]!;
    return fileView(cur);
  }
  const bytes = await ctx.storage.getObject(row.storage_path);
  if (!bytes || bytes.length === 0) {
    throw new HttpError(409, "NOT_UPLOADED", "Upload did not finish. Please try uploading this file again. / Upload poora nahin hua.");
  }
  const shop = await loadShopSettings(ctx.db);
  if (bytes.length > shop.maxFileBytes) {
    await reject(ctx, fileId, row.storage_path, "File too large", { size: bytes.length });
  } else {
    const type = detectFileType(bytes);
    let pageCount: number | null = null;
    let problem: string | null = null;
    if (!type) problem = "Not a real PDF, JPG or PNG file (content check failed). / Sirf PDF, JPG, PNG.";
    else if (type === "application/pdf") {
      const insp = await inspectPdf(bytes);
      if (insp.ok) pageCount = insp.pageCount;
      else problem = insp.message;
    } else {
      const info = type === "image/png" ? pngInfo(bytes) : jpegInfo(bytes);
      if (!info) problem = "Image file is damaged or incomplete. / Photo kharab hai.";
      else pageCount = 1;
    }
    if (problem || !type || pageCount === null) {
      await reject(ctx, fileId, row.storage_path, problem ?? "Invalid file", { size: bytes.length });
    } else {
      const scan = await ctx.scanner.scan(bytes);
      if (scan.status === "INFECTED") {
        await reject(ctx, fileId, row.storage_path, "File failed the malware scan.", { size: bytes.length, scan });
      } else if (scan.status === "ERROR") {
        await reject(ctx, fileId, row.storage_path, "File could not be scanned right now. Please try again.", { size: bytes.length, scan });
      } else {
        await ctx.db.query(
          `update uploaded_files set status = 'READY', size_bytes = $2, detected_mime = $3, sha256 = $4, page_count = $5,
                  scan_status = $6::scan_status, scan_detail = $7, uploaded_at = now() where id = $1 and status = 'PENDING_UPLOAD'`,
          [fileId, bytes.length, type, sha256hex(bytes), pageCount, scan.status, scan.detail]);
      }
    }
  }
  const cur = (await ctx.db.query<Record<string, unknown>>("select * from uploaded_files where id = $1", [fileId]))[0]!;
  return fileView(cur);
}

export async function removeUpload(ctx: AppContext, session: UploadSession, fileId: string) {
  const row = (await ctx.db.query<{ storage_path: string }>(
    "update uploaded_files set status = 'REMOVED' where id = $1 and session_id = $2 and status in ('PENDING_UPLOAD','READY','REJECTED') returning storage_path",
    [fileId, session.id]))[0];
  if (!row) throw new HttpError(404, "FILE_NOT_FOUND", "File not found");
  await ctx.storage.remove([row.storage_path]).catch(() => undefined);
  return { ok: true };
}
