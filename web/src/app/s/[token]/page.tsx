import { getContext } from "@/lib/context";
import { resolveQrToken } from "@/lib/services/qr";
import { loadShopSettings } from "@/lib/services/settings";
import Portal from "@/components/portal/Portal";

export const dynamic = "force-dynamic";

export default async function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await getContext();
  const qr = await resolveQrToken(ctx.db, token);
  const shop = await loadShopSettings(ctx.db);
  if (!qr) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center p-6 text-center">
        <div className="card w-full">
          <div className="mb-3 text-5xl">🖨️</div>
          <h1 className="text-xl font-bold">This QR code is not active</h1>
          <p className="mt-1 text-slate-600">Yeh QR code ab kaam nahin karta.</p>
          <p className="mt-4 text-sm text-slate-600">
            Please scan the latest QR code at the counter of <b>{shop.shopName}</b>, or ask the staff for help.
          </p>
          <p className="mt-2 text-sm text-slate-500">Counter par lage naye QR code ko scan karein.</p>
        </div>
      </main>
    );
  }
  return <Portal qrToken={token} shopName={shop.shopName} shopAddress={shop.address} />;
}
