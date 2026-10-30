import Dashboard from "@/components/admin/Dashboard";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default function AdminHome() {
  return <Dashboard realtime={getConfig().AUTH_DRIVER === "supabase"} />;
}
