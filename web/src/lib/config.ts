import { z } from "zod";

const bool = z.enum(["true", "false"]).optional().transform((v) => v === "true");

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters"),
  DB_DRIVER: z.enum(["postgres", "pglite"]).default("postgres"),
  DATABASE_URL: z.string().optional(),
  PGLITE_DATA_DIR: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  STORAGE_DRIVER: z.enum(["supabase", "local"]).default("supabase"),
  STORAGE_BUCKET: z.string().default("print-files"),
  LOCAL_STORAGE_DIR: z.string().default(".local-storage"),
  AUTH_DRIVER: z.enum(["supabase", "dev"]).default("supabase"),
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().default(3310),
  CRON_SECRET: z.string().min(16).optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  TRUST_PROXY: bool,
});

export type AppConfig = z.infer<typeof schema> & { razorpayEnabled: boolean };

let cached: AppConfig | null = null;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.parse(env);
  if (parsed.NODE_ENV === "production") {
    if (parsed.AUTH_DRIVER === "dev") throw new Error("AUTH_DRIVER=dev is not allowed in production");
    if (parsed.STORAGE_DRIVER === "local" && !env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION) {
      throw new Error("STORAGE_DRIVER=local is not allowed in production");
    }
  }
  if (parsed.DB_DRIVER === "postgres" && !parsed.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (parsed.STORAGE_DRIVER === "supabase" && (!parsed.NEXT_PUBLIC_SUPABASE_URL || !parsed.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for Supabase storage");
  }
  const razorpayEnabled = Boolean(parsed.RAZORPAY_KEY_ID && parsed.RAZORPAY_KEY_SECRET && parsed.RAZORPAY_WEBHOOK_SECRET);
  return { ...parsed, razorpayEnabled };
}

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}
