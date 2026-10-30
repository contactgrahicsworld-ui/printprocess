import { getConfig, type AppConfig } from "./config";
import type { Db } from "./db/types";
import type { StorageDriver } from "./storage/types";
import type { AuthResolver } from "./auth/types";
import type { RateLimiter } from "./security/ratelimit";
import type { Scanner } from "./files/scan";

export interface AppContext {
  config: AppConfig;
  db: Db;
  storage: StorageDriver;
  auth: AuthResolver;
  rateLimiter: RateLimiter;
  scanner: Scanner;
  now: () => Date;
}

let override: AppContext | null = null;
// Stored on globalThis: Next.js may evaluate this module once per bundle layer (route handlers vs. server
// components). One context per process matters for pooled connections and is required for embedded PGlite.
const g = globalThis as typeof globalThis & { __mansaCtx?: Promise<AppContext> };

/** Tests inject a fully wired context (PGlite + memory storage + header auth). */
export function setContext(ctx: AppContext | null): void {
  override = ctx;
}

export async function getContext(): Promise<AppContext> {
  if (override) return override;
  if (!g.__mansaCtx) g.__mansaCtx = buildContext();
  return g.__mansaCtx;
}

async function buildContext(): Promise<AppContext> {
  const config = getConfig();
  let db: Db;
  if (config.DB_DRIVER === "pglite") {
    const { createDevPglite } = await import("./db/dev-pglite");
    db = await createDevPglite(config.PGLITE_DATA_DIR);
  } else {
    const { createPostgresDb } = await import("./db/postgres");
    db = createPostgresDb(config.DATABASE_URL!);
  }

  let storage: StorageDriver;
  if (config.STORAGE_DRIVER === "local") {
    const { createLocalStorage, fsBackend } = await import("./storage/local");
    storage = createLocalStorage({ baseUrl: config.APP_URL, secret: config.APP_SECRET, backend: fsBackend(config.LOCAL_STORAGE_DIR) });
  } else {
    const { createSupabaseStorage } = await import("./storage/supabase");
    storage = createSupabaseStorage(config.NEXT_PUBLIC_SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!, config.STORAGE_BUCKET);
  }

  let auth: AuthResolver;
  if (config.AUTH_DRIVER === "dev") {
    const { devAuthResolver } = await import("./auth/dev");
    auth = devAuthResolver(db, config.APP_SECRET);
  } else {
    const { supabaseAuthResolver } = await import("./auth/supabase");
    auth = supabaseAuthResolver(db, config.NEXT_PUBLIC_SUPABASE_URL!, config.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  }

  const rl = await import("./security/ratelimit");
  const rateLimiter = config.UPSTASH_REDIS_REST_URL && config.UPSTASH_REDIS_REST_TOKEN
    ? rl.upstashRateLimiter(config.UPSTASH_REDIS_REST_URL, config.UPSTASH_REDIS_REST_TOKEN)
    : rl.postgresRateLimiter(db);

  const scan = await import("./files/scan");
  const scanner = config.CLAMAV_HOST ? scan.clamdScanner(config.CLAMAV_HOST, config.CLAMAV_PORT) : scan.noopScanner;

  return { config, db, storage, auth, rateLimiter, scanner, now: () => new Date() };
}
