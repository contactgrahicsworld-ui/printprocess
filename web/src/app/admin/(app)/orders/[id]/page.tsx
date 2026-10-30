import OrderDetail from "@/components/admin/OrderDetail";
import { getStaffForPage } from "@/lib/auth/server";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const staff = await getStaffForPage();
  return <OrderDetail orderId={id} realtime={getConfig().AUTH_DRIVER === "supabase"} staffId={staff?.userId ?? ""} />;
}
