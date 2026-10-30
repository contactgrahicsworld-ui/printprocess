import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { hmacHex, safeEqualHex } from "@/lib/security/crypto";
import type { StorageDriver } from "./types";

/**
 * Local/dev/test storage that behaves like Supabase Storage signed URLs: every URL is HMAC-signed,
 * expires, and is bound to one operation and one path. Served by /api/local-storage/[...path].
 * Not allowed in production (see config.ts).
 */
export interface LocalBackend {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

export function memoryBackend(): LocalBackend & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async read(p) { return files.get(p) ?? null; },
    async write(p, d) { files.set(p, d); },
    async remove(p) { files.delete(p); },
  };
}

export function fsBackend(root: string): LocalBackend {
  const base = resolve(root);
  const full = (p: string) => {
    const f = resolve(join(base, p));
    if (!f.startsWith(base + "/")) throw new Error("path traversal");
    return f;
  };
  return {
    async read(p) { try { return new Uint8Array(await readFile(full(p))); } catch { return null; } },
    async write(p, d) { const f = full(p); await mkdir(dirname(f), { recursive: true }); await writeFile(f, d); },
    async remove(p) { await rm(full(p), { force: true }); },
  };
}

export interface LocalStorage extends StorageDriver {
  backend: LocalBackend;
  /** Verifies a signed URL; returns the object path or null. */
  verify(op: "get" | "put", path: string, exp: string, sig: string, nowMs: number): string | null;
  maxBytes: number;
}

export function createLocalStorage(opts: { baseUrl: string; secret: string; backend: LocalBackend; maxBytes?: number; now?: () => number }): LocalStorage {
  const now = opts.now ?? (() => Date.now());
  const sign = (op: string, path: string, exp: number) => hmacHex(opts.secret, `local-storage\n${op}\n${path}\n${exp}`);
  const url = (op: "get" | "put", path: string, ttlSec: number, name?: string) => {
    const exp = Math.floor(now() / 1000) + ttlSec;
    const u = new URL(`/api/local-storage/${path.split("/").map(encodeURIComponent).join("/")}`, opts.baseUrl);
    u.searchParams.set("op", op);
    u.searchParams.set("exp", String(exp));
    u.searchParams.set("sig", sign(op, path, exp));
    if (name) u.searchParams.set("name", name);
    return u.toString();
  };
  return {
    backend: opts.backend,
    maxBytes: opts.maxBytes ?? 52428800,
    async createSignedUploadUrl(path, contentType) {
      return { url: url("put", path, 2 * 3600), method: "PUT", headers: { "content-type": contentType } };
    },
    getObject: (p) => opts.backend.read(p),
    putObject: (p, d) => opts.backend.write(p, d),
    async remove(paths) { for (const p of paths) await opts.backend.remove(p); },
    async createSignedDownloadUrl(path, ttl, name) { return url("get", path, ttl, name); },
    verify(op, path, exp, sig, nowMs) {
      const e = Number(exp);
      if (!Number.isFinite(e) || e * 1000 < nowMs) return null;
      return safeEqualHex(sign(op, path, e), sig) ? path : null;
    },
  };
}
