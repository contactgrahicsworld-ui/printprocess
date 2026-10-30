"use client";

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, ApiError, fmtTime, inr } from "@/lib/client/api";

type View = {
  orderNumber: string; status: string; createdAt: string; customerName: string; rejectionReason: string | null;
  timeline: { status: string; at: string }[];
  items: { name: string; pagesTotal: number; pagesSelected: number; pageRanges: string | null; colorMode: string; duplex: string; paperSize: string; paperType: string | null; copies: number; totalSheets: number; pricePaise: number }[];
  orderServices: { label: string; amountPaise: number }[]; adjustmentPaise: number;
  totalPaise: number; paidPaise: number; duePaise: number;
  shop: { name: string; address: string; phone: string | null }; upiUri: string | null;
  paymentClaim: { method: string; reference: string; note: string | null; at: string } | null;
  razorpayEnabled: boolean;
};

const STEPS = ["RECEIVED", "UNDER_REVIEW", "APPROVED", "PRINTING", "READY", "DELIVERED"] as const;
const LABEL: Record<string, string> = {
  RECEIVED: "Received / Mil gaya", UNDER_REVIEW: "Under review / Jaanch", APPROVED: "Approved / Manzoor", PRINTING: "Printing / Chhap raha hai",
  READY: "Ready for pickup / Taiyaar", DELIVERED: "Delivered / De diya", CANCELLED: "Cancelled / Radd",
};

declare global {
  interface Window { Razorpay?: new (opts: Record<string, unknown>) => { open(): void } }
}

export default function TrackView({ orderNumber, token, isNew }: { orderNumber: string; token: string; isNew: boolean }) {
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [upiQr, setUpiQr] = useState<string | null>(null);
  const [payMsg, setPayMsg] = useState<string | null>(null);
  const [utr, setUtr] = useState("");
  const [claimState, setClaimState] = useState<"idle" | "sending" | "done">("idle");

  const load = useCallback(async () => {
    try {
      const data = await api<View>("/api/public/track", { body: { orderNumber, token } });
      setV(data); setErr(null);
      setUpiQr(data.upiUri ? await QRCode.toDataURL(data.upiUri, { margin: 1, width: 220 }) : null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not load order.");
    }
  }, [orderNumber, token]);

  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 20000);
    return () => clearInterval(t);
  }, [load]);

  const payOnline = async () => {
    setPayMsg(null);
    try {
      const o = await api<{ keyId: string; razorpayOrderId: string; amountPaise: number }>("/api/public/payments/razorpay", { body: { orderNumber, token } });
      if (!window.Razorpay) {
        await new Promise<void>((res, rej) => { const s = document.createElement("script"); s.src = "https://checkout.razorpay.com/v1/checkout.js"; s.onload = () => res(); s.onerror = () => rej(new Error("Could not load payment")); document.body.appendChild(s); });
      }
      new window.Razorpay!({
        key: o.keyId, order_id: o.razorpayOrderId, amount: o.amountPaise, currency: "INR", name: v?.shop.name, description: orderNumber,
        handler: () => { setPayMsg("Payment submitted. It will show as paid once confirmed by Razorpay (usually within a minute)."); setTimeout(load, 5000); },
      }).open();
    } catch (e) {
      setPayMsg(e instanceof Error ? e.message : "Payment could not start.");
    }
  };

  const claimPay = async () => {
    if (utr.trim().length < 4) { setPayMsg("UTR / payment reference likhein (kam se kam 4 akshar). / Enter the UTR first."); return; }
    setClaimState("sending"); setPayMsg(null);
    try {
      await api("/api/public/payments/claim", { body: { orderNumber, token, reference: utr.trim(), note: null } });
      setClaimState("done"); setUtr("");
      setTimeout(load, 800);
    } catch (e) {
      setClaimState("idle");
      setPayMsg(e instanceof Error ? e.message : "Could not send. / Bheja nahi ja saka.");
    }
  };

  if (err) return <main className="mx-auto max-w-md p-6"><div className="card text-center"><h1 className="text-lg font-bold">Order not found</h1><p className="mt-2 text-slate-600">{err}</p><a href="/track" className="btn-secondary mt-4">Try again</a></div></main>;
  if (!v) return <main className="mx-auto max-w-md p-6 text-center text-slate-500">Loading… / Load ho raha hai…</main>;

  const cancelled = v.status === "CANCELLED";
  const reached = new Set(v.timeline.map((t) => t.status));
  const curIdx = STEPS.indexOf(v.status as (typeof STEPS)[number]);

  return (
    <main className="mx-auto max-w-xl space-y-4 p-4 pb-10">
      {isNew && (
        <div className="card border-emerald-300 bg-emerald-50">
          <h1 className="text-lg font-bold text-emerald-800">Order sent! / Order bhej diya gaya ✓</h1>
          <p className="text-sm text-emerald-900">Show this order number at the counter. Bookmark this page to check status.</p>
        </div>
      )}
      <div className="card">
        <p className="text-sm text-slate-500">Order number</p>
        <p className="text-3xl font-bold tracking-wide" data-testid="order-number">{v.orderNumber}</p>
        <p className="mt-1 text-sm text-slate-500">{v.customerName} · {fmtTime(v.createdAt)}</p>
        <p className={`chip mt-3 ${cancelled ? "bg-red-100 text-red-700" : "bg-brand-100 text-brand-700"}`} data-testid="order-status">{LABEL[v.status] ?? v.status}</p>
        {cancelled && v.rejectionReason && <p className="mt-2 text-sm text-red-700">Reason: {v.rejectionReason}</p>}
      </div>

      {!cancelled && (
        <ol className="card space-y-3">
          {STEPS.map((s, i) => {
            const at = v.timeline.find((t) => t.status === s)?.at;
            const done = reached.has(s) || i <= curIdx;
            return (
              <li key={s} className="flex items-center gap-3">
                <span className={`flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold ${done ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-500"}`}>{done ? "✓" : i + 1}</span>
                <span className={`flex-1 ${done ? "font-medium" : "text-slate-500"}`}>{LABEL[s]}</span>
                {at && <span className="text-xs text-slate-500">{fmtTime(at)}</span>}
              </li>
            );
          })}
        </ol>
      )}

      <div className="card">
        <h2 className="mb-2 font-semibold">Documents</h2>
        <ul className="divide-y">
          {v.items.map((it, i) => (
            <li key={i} className="flex justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{it.name}</p>
                <p className="text-xs text-slate-500">
                  {it.colorMode === "BW" ? "B/W" : "Colour"} · {it.duplex === "DOUBLE" ? "Both sides" : "Single side"} · {it.paperSize}{it.paperType ? ` · ${it.paperType}` : ""} · pages {it.pageRanges ?? "all"} ({it.pagesSelected}/{it.pagesTotal}) · {it.copies} cop{it.copies > 1 ? "ies" : "y"} · {it.totalSheets} sheets
                </p>
              </div>
              <span className="font-medium">{inr(it.pricePaise)}</span>
            </li>
          ))}
          {v.orderServices.map((s) => <li key={s.label} className="flex justify-between py-2 text-sm"><span>{s.label}</span><span>{inr(s.amountPaise)}</span></li>)}
          {v.adjustmentPaise > 0 && <li className="flex justify-between py-2 text-sm"><span>Minimum order</span><span>{inr(v.adjustmentPaise)}</span></li>}
        </ul>
        <dl className="mt-3 space-y-1 border-t pt-3 text-sm">
          <div className="flex justify-between"><dt>Total</dt><dd className="font-bold">{inr(v.totalPaise)}</dd></div>
          <div className="flex justify-between"><dt>Paid</dt><dd>{inr(v.paidPaise)}</dd></div>
          <div className="flex justify-between text-base"><dt className="font-semibold">Due / Baaki</dt><dd className="font-bold" data-testid="due">{inr(v.duePaise)}</dd></div>
        </dl>
      </div>

      {v.duePaise > 0 && !cancelled && (
        <div className="card text-center">
          <h2 className="font-semibold">Pay / Bhugtan — {inr(v.duePaise)}</h2>
          {v.upiUri ? (
            <p className="mt-1 text-sm text-slate-600">Neeche ka QR GPay / PhonePe / Paytm se scan karein — payment <b>seedha dukaan ke UPI account</b> (owner ke mobile number) mein jaata hai.</p>
          ) : (
            <p className="text-sm text-slate-600">Pay at the counter with cash or UPI. Staff will confirm your payment.</p>
          )}
          {upiQr && (
            <div className="mt-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={upiQr} alt="UPI payment QR" className="mx-auto h-52 w-52" />
              <p className="text-xs text-slate-500">{v.shop.name} ko bhejein · amount ₹{(v.duePaise / 100).toFixed(2)} pre-filled hai</p>
            </div>
          )}
          {v.upiUri && <a href={v.upiUri} className="btn-primary mt-3 inline-block">UPI app se pay karein / Pay via UPI app</a>}
          {v.paymentClaim ? (
            <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800" data-testid="claim-received">
              ✓ Aapka payment record mil gaya (UTR: <b>{v.paymentClaim.reference}</b>). Shop confirm karega — uske baad print shuru hoga.
            </div>
          ) : v.upiUri && claimState !== "done" && (
            <div className="mt-4 border-t pt-3">
              <p className="text-sm font-medium">Pay kar diya? / Already paid?</p>
              <div className="mt-2 flex gap-2">
                <input className="input" placeholder="UPI reference / UTR" value={utr} onChange={(e) => setUtr(e.target.value)} maxLength={100} aria-label="UPI reference" />
                <button type="button" className="btn-primary px-4" disabled={claimState === "sending"} onClick={claimPay}>{claimState === "sending" ? "…" : "Maine pay kar diya"}</button>
              </div>
              <p className="mt-1 text-xs text-slate-500">UTR aapke UPI app ki payment details mein milta hai. Shop confirm karega.</p>
            </div>
          )}
          {claimState === "done" && <p className="mt-2 text-sm text-emerald-700">Dukaan ko bata diya gaya ✓ / The shop has been notified.</p>}
          {v.razorpayEnabled && <button type="button" className="btn-primary mt-3" onClick={payOnline}>Pay online {inr(v.duePaise)}</button>}
          {payMsg && <p className="mt-2 text-sm text-slate-700">{payMsg}</p>}
        </div>
      )}
      <p className="text-center text-xs text-slate-500">{v.shop.name} · {v.shop.address}{v.shop.phone ? ` · ${v.shop.phone}` : ""}</p>
    </main>
  );
}
