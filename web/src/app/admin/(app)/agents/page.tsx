import Agents from "@/components/admin/Agents";
import { getStaffForPage } from "@/lib/auth/server";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const staff = await getStaffForPage();
  return <Agents canManage={staff?.role !== "STAFF"} serverUrl={getConfig().APP_URL} realtime={getConfig().AUTH_DRIVER === "supabase"} />;
}
