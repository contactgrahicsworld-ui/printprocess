import { getContext } from "@/lib/context";
import { getReceipt } from "@/lib/services/payments";
import PrintButton from "@/components/admin/PrintButton";

export const dynamic = "force-dynamic";

const inr = (p: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(p / 100);

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return <p>Not found</p>;
  const ctx = await getContext();
  const s = await getReceipt(ctx.db, id);
  return (
    <div className="mx-auto max-w-2xl bg-white p-8 text-sm shadow print:shadow-none">
      <div className="no-print mb-4 flex justify-end gap-2"><PrintButton /><a className="btn-secondary" href={`/api/admin/receipts/${id}/pdf`}>Download PDF</a></div>
      <header className="flex justify-between border-b pb-4">
        <div><h1 className="text-2xl font-bold">{s.shop.name}</h1><p>{s.shop.address}</p>{s.shop.phone && <p>Phone: {s.shop.phone}</p>}{s.shop.gstin && <p>GSTIN: {s.shop.gstin}</p>}</div>
        <div className="text-right"><p className="text-lg font-bold">RECEIPT</p><p className="font-mono">{s.receiptNumber}</p><p>{new Date(s.issuedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</p></div>
      </header>
      <p className="mt-4"><b>Order:</b> <span className="font-mono">{s.order.orderNumber}</span> · <b>Customer:</b> {s.order.customerName}{s.order.customerPhone ? ` (${s.order.customerPhone})` : ""}</p>
      <table className="mt-4 w-full">
        <thead><tr className="border-b text-left"><th className="py-2">Item</th><th className="py-2 text-right">Amount</th></tr></thead>
        <tbody>
          {s.items.map((it, i) => <tr key={i} className="border-b"><td className="py-2"><b>{it.name}</b><div className="text-xs text-slate-600">{it.description}</div></td><td className="py-2 text-right">{inr(it.amountPaise)}</td></tr>)}
          {s.services.map((sv) => <tr key={sv.label} className="border-b"><td className="py-2">{sv.label}</td><td className="py-2 text-right">{inr(sv.amountPaise)}</td></tr>)}
          {s.adjustmentPaise > 0 && <tr className="border-b"><td className="py-2">Minimum order adjustment</td><td className="py-2 text-right">{inr(s.adjustmentPaise)}</td></tr>}
        </tbody>
        <tfoot>
          <tr><td className="pt-3 text-right font-bold">Total</td><td className="pt-3 text-right font-bold">{inr(s.totalPaise)}</td></tr>
          {s.payments.map((p, i) => <tr key={i}><td className="text-right text-xs">Paid ({p.method}{p.reference ? ` · ${p.reference}` : ""})</td><td className="text-right text-xs">{inr(p.amountPaise)}</td></tr>)}
          <tr><td className="text-right font-semibold">Paid</td><td className="text-right">{inr(s.paidPaise)}</td></tr>
          <tr><td className="text-right font-semibold">Balance due</td><td className="text-right font-bold">{inr(s.duePaise)}</td></tr>
        </tfoot>
      </table>
      <p className="mt-8 text-center">Thank you! / Dhanyavaad!</p>
    </div>
  );
}
