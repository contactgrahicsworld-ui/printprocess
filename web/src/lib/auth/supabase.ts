import { createServerClient } from "@supabase/ssr";
import type { Db } from "@/lib/db/types";
import { loadActiveStaff } from "./staff-lookup";
import type { AuthResolver } from "./types";

export function parseCookies(header: string | null): { name: string; value: string }[] {
  if (!header) return [];
  return header.split(/;\s*/).filter(Boolean).map((p) => {
    const i = p.indexOf("=");
    return i < 0 ? { name: p, value: "" } : { name: p.slice(0, i), value: decodeURIComponent(p.slice(i + 1)) };
  });
}

/** Supabase Auth: validates the session JWT with the Auth server (getUser), then requires an active staff profile. */
export function supabaseAuthResolver(db: Db, url: string, anonKey: string): AuthResolver {
  return {
    async getStaff(req) {
      const supabase = createServerClient(url, anonKey, {
        cookies: { getAll: () => parseCookies(req.headers.get("cookie")), setAll: () => {} },
      });
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) return null;
      return loadActiveStaff(db, data.user.id);
    },
  };
}
