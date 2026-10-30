import Link from "next/link";
import { redirect } from "next/navigation";
import { getStaffForPage } from "@/lib/auth/server";
import LogoutButton from "@/components/admin/LogoutButton";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const staff = await getStaffForPage();
  if (!staff) redirect("/admin/login");
  const admin = staff.role !== "STAFF";
  return (
    <div className="min-h-dvh">
      <nav className="no-print sticky top-0 z-10 border-b bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-1 px-4 py-2 text-sm">
          <Link href="/admin" className="mr-3 font-bold text-brand-700">Mansa Printer</Link>
          <Link href="/admin" className="rounded-lg px-3 py-2 hover:bg-slate-100">Orders</Link>
          <Link href="/admin/qr" className="rounded-lg px-3 py-2 hover:bg-slate-100">QR code</Link>
          <Link href="/admin/agents" className="rounded-lg px-3 py-2 hover:bg-slate-100">Print agents</Link>
          {admin && <Link href="/admin/settings" className="rounded-lg px-3 py-2 hover:bg-slate-100">Settings</Link>}
          <span className="ml-auto text-slate-500">{staff.fullName || staff.email} · {staff.role}</span>
          <LogoutButton />
        </div>
      </nav>
      <div className="mx-auto max-w-7xl p-4">{children}</div>
    </div>
  );
}
