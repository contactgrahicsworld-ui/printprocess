"use client";
import { supabaseBrowser } from "@/lib/client/supabase";

export default function LogoutButton() {
  return (
    <button type="button" className="rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100" onClick={async () => {
      await supabaseBrowser()?.auth.signOut().catch(() => undefined);
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.assign(new URL("/admin/login", window.location.origin).toString());
    }}>Sign out</button>
  );
}
