import type { Db } from "@/lib/db/types";
import { hmacHex, safeEqualHex } from "@/lib/security/crypto";
import { parseCookies } from "./supabase";
import { loadActiveStaff } from "./staff-lookup";
import type { AuthResolver } from "./types";

export const DEV_COOKIE = "mp_dev_staff";

/** Local development / e2e only (refused when NODE_ENV=production). Cookie = userId.hmac(APP_SECRET). */
export function devCookieValue(secret: string, userId: string): string {
  return `${userId}.${hmacHex(secret, "dev-staff:" + userId)}`;
}

export function devAuthResolver(db: Db, secret: string): AuthResolver {
  return {
    async getStaff(req) {
      const c = parseCookies(req.headers.get("cookie")).find((x) => x.name === DEV_COOKIE);
      if (!c) return null;
      const [userId, sig] = c.value.split(".");
      if (!userId || !sig || !safeEqualHex(hmacHex(secret, "dev-staff:" + userId), sig)) return null;
      return loadActiveStaff(db, userId);
    },
  };
}
