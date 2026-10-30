"use client";

import { useState } from "react";
import { supabaseBrowser } from "@/lib/client/supabase";

export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sb = supabaseBrowser();
  if (!sb) return <p className="card text-sm text-red-700">Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY).</p>;
  return (
    <form className="card space-y-3" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) { setErr("Wrong email or password."); setBusy(false); return; }
      window.location.assign(new URL("/admin", window.location.origin).toString());
    }}>
      <div><label className="label" htmlFor="em">Email</label><input id="em" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></div>
      <div><label className="label" htmlFor="pw">Password</label><input id="pw" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></div>
      {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
      <button className="btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
