import QrAdmin from "@/components/admin/QrAdmin";
import { getStaffForPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function QrPage() {
  const staff = await getStaffForPage();
  return <QrAdmin canManage={staff?.role !== "STAFF"} />;
}
