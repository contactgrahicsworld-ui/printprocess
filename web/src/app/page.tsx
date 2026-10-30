import Link from "next/link";
import { getContext } from "@/lib/context";
import { loadShopSettings } from "@/lib/services/settings";

export const dynamic = "force-dynamic";

export default async function Home() {
  const ctx = await getContext();
  const shop = await loadShopSettings(ctx.db);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
      <div className="card text-center">
        <div className="text-5xl">🖨️</div>
        <h1 className="mt-2 text-2xl font-bold">{shop.shopName}</h1>
        <p className="text-slate-600">{shop.address}</p>
        <p className="mt-4">Scan the QR code at the counter to upload your files.</p>
        <p className="text-sm text-slate-500">Counter par QR code scan karke file bhejein.</p>
      </div>
      <Link href="/track" className="btn-primary py-3">Track my order / Order dekhein</Link>
      <Link href="/admin" className="text-center text-sm text-slate-500 underline">Staff login</Link>
    </main>
  );
}
