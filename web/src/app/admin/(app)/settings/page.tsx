import { redirect } from "next/navigation";
import Settings from "@/components/admin/Settings";
import { getStaffForPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const staff = await getStaffForPage();
  if (!staff || staff.role === "STAFF") redirect("/admin");
  return <Settings />;
}
