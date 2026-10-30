import { getContext } from "@/lib/context";
import { handler, HttpError } from "@/lib/http/respond";
import type { LocalStorage } from "@/lib/storage/local";

export const dynamic = "force-dynamic";

/** Emulates Supabase signed URLs for STORAGE_DRIVER=local (dev/e2e only; refused in production by config). */
async function storage(): Promise<LocalStorage> {
  const ctx = await getContext();
  const s = ctx.storage as Partial<LocalStorage>;
  if (typeof s.verify !== "function") throw new HttpError(404, "NOT_FOUND", "Not found");
  return s as LocalStorage;
}

function objectPath(req: Request): string {
  const u = new URL(req.url);
  return u.pathname.replace(/^\/api\/local-storage\//, "").split("/").map(decodeURIComponent).join("/");
}

export const PUT = handler(async (req: Request) => {
  const s = await storage();
  const u = new URL(req.url);
  const path = s.verify("put", objectPath(req), u.searchParams.get("exp") ?? "", u.searchParams.get("sig") ?? "", Date.now());
  if (!path) throw new HttpError(403, "BAD_SIGNATURE", "Invalid or expired upload URL");
  if (await s.backend.read(path)) throw new HttpError(409, "EXISTS", "Object already exists");
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > s.maxBytes) throw new HttpError(413, "TOO_LARGE", "Object too large");
  await s.backend.write(path, buf);
  return new Response(JSON.stringify({ Key: path }), { status: 200, headers: { "content-type": "application/json" } });
});

export const GET = handler(async (req: Request) => {
  const s = await storage();
  const u = new URL(req.url);
  const path = s.verify("get", objectPath(req), u.searchParams.get("exp") ?? "", u.searchParams.get("sig") ?? "", Date.now());
  if (!path) throw new HttpError(403, "BAD_SIGNATURE", "Invalid or expired URL");
  const data = await s.backend.read(path);
  if (!data) throw new HttpError(404, "NOT_FOUND", "Not found");
  const name = u.searchParams.get("name");
  return new Response(Buffer.from(data), {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "private, no-store",
      ...(name ? { "content-disposition": `attachment; filename="${name.replace(/[^\w.\- ]/g, "_")}"` } : {}),
    },
  });
});
