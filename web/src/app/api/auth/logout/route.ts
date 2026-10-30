import { parseCookies } from "@/lib/auth/supabase";

export const dynamic = "force-dynamic";

/** Clears staff session cookies (Supabase sb-* cookies and the dev cookie). Client also calls supabase.auth.signOut(). */
export async function POST(req: Request) {
  const res = new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  for (const c of parseCookies(req.headers.get("cookie"))) {
    if (c.name.startsWith("sb-") || c.name === "mp_dev_staff") res.headers.append("set-cookie", `${c.name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  }
  return res;
}
