import type { Db } from "@/lib/db/types";
import { sha256hex } from "./crypto";

export interface RateLimiter {
  /** Returns true when allowed. */
  hit(key: string, max: number, windowSeconds: number): Promise<boolean>;
}

export function postgresRateLimiter(db: Db): RateLimiter {
  return {
    async hit(key, max, windowSeconds) {
      const rows = await db.query<{ ok: boolean }>("select public.rate_limit_hit($1, $2, $3) as ok", [sha256hex(key), max, windowSeconds]);
      return rows[0]?.ok === true;
    },
  };
}

/** Upstash Redis REST (used automatically when UPSTASH_REDIS_REST_URL/TOKEN are set). */
export function upstashRateLimiter(url: string, token: string): RateLimiter {
  return {
    async hit(key, max, windowSeconds) {
      const k = "rl:" + sha256hex(key);
      const res = await fetch(`${url}/pipeline`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify([["INCR", k], ["EXPIRE", k, String(windowSeconds), "NX"]]),
        cache: "no-store",
      });
      if (!res.ok) return true; // fail-open on limiter outage; Postgres constraints still protect data
      const data = (await res.json()) as { result: number }[];
      return (data[0]?.result ?? 0) <= max;
    },
  };
}

export const LIMITS = {
  sessionCreate: { max: 10, window: 600 },
  uploadUrl: { max: 60, window: 600 },
  quote: { max: 120, window: 600 },
  submit: { max: 10, window: 600 },
  track: { max: 20, window: 600 },
  razorpay: { max: 10, window: 600 },
} as const;
