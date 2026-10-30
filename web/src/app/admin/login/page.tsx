import LoginForm from "@/components/admin/LoginForm";
import { getConfig } from "@/lib/config";
import { getContext } from "@/lib/context";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const cfg = getConfig();
  let devStaff: { user_id: string; full_name: string; role: string }[] = [];
  if (cfg.AUTH_DRIVER === "dev" && cfg.NODE_ENV !== "production") {
    const ctx = await getContext();
    devStaff = await ctx.db.query("select user_id, full_name, role from staff_profiles where active order by role");
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-6">
      <h1 className="mb-1 text-2xl font-bold">Staff sign in</h1>
      <p className="mb-4 text-sm text-slate-600">Mansa Printer dashboard</p>
      {cfg.AUTH_DRIVER === "dev" ? (
        <div className="card space-y-2">
          <p className="text-sm text-amber-700">Local development sign-in (AUTH_DRIVER=dev). Never enabled in production.</p>
          {devStaff.map((s) => <a key={s.user_id} className="btn-secondary w-full" href={`/api/dev/login?user=${s.user_id}`}>{s.full_name} ({s.role})</a>)}
          {devStaff.length === 0 && <p className="text-sm">No staff yet. Run <code>npm run dev:seed</code>.</p>}
        </div>
      ) : <LoginForm />}
    </main>
  );
}
