"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmtTime, inr } from "@/lib/client/api";
import { useLive } from "@/lib/client/useLive";

const TABS = [
  { k: "new", l: "New" }, { k: "pending", l: "Under review" }, { k: "approved", l: "Approved" },
  { k: "printing", l: "Printing" }, { k: "completed", l: "Ready / Delivered" }, { k: "cancelled", l: "Cancelled" },
] as const;
type TabKey = (typeof TABS)[number]["k"];
type Row = { id: string; order_number: string; customer_name: string; customer_phone: string | null; status: string; total_paise: number; paid_paise: number; due_paise: number; created_at: string; assigned_name: string | null; item_count: number; sheets: number };

export const STATUS_CHIP: Record<string, string> = {
  RECEIVED: "bg-sky-100 text-sky-800", UNDER_REVIEW: "bg-amber-100 text-amber-800", APPROVED: "bg-indigo-100 text-indigo-800",
  PRINTING: "bg-purple-100 text-purple-800", READY: "bg-emerald-100 text-emerald-800", DELIVERED: "bg-slate-200 text-slate-700", CANCELLED: "bg-red-100 text-red-700",
};

export default function Dashboard({ realtime }: { realtime: boolean }) {
  const [tab, setTab] = useState<TabKey>("new");
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<{ orders: Row[]; counts: Record<string, number> }>(`/api/admin/orders?tab=${tab}`);
      setRows(r.orders); setCounts(r.counts); setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed to load"); }
  }, [tab]);
  useEffect(() => { void load(); }, [load]);
  useLive(["orders", "print_jobs", "payments"], load, realtime);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-4 text-2xl font-bold">Orders</h1>
        <span className={`chip ${realtime ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700"}`}>{realtime ? "● Live" : "Auto-refresh 15s"}</span>
      </div>
      <div className="mb-4 flex gap-1 overflow-x-auto rounded-xl bg-white p-1 shadow-sm">
        {TABS.map((t) => (
          <button key={t.k} type="button" onClick={() => setTab(t.k)} className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium ${tab === t.k ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
            {t.l} <span className="ml-1 opacity-75">{counts[t.k] ?? 0}</span>
          </button>
        ))}
      </div>
      {err && <p className="mb-3 text-red-600">{err}</p>}
      <div className="overflow-x-auto rounded-2xl border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr><th className="p-3">Order</th><th className="p-3">Customer</th><th className="p-3">Docs</th><th className="p-3">Status</th><th className="p-3 text-right">Total</th><th className="p-3 text-right">Due</th><th className="p-3">Assigned</th><th className="p-3">Received</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t hover:bg-slate-50">
                <td className="p-3 font-mono font-semibold"><Link className="text-brand-700 hover:underline" href={`/admin/orders/${r.id}`}>{r.order_number}</Link></td>
                <td className="p-3">{r.customer_name}{r.customer_phone && <div className="text-xs text-slate-500">{r.customer_phone}</div>}</td>
                <td className="p-3">{r.item_count} · {r.sheets} sh</td>
                <td className="p-3"><span className={`chip ${STATUS_CHIP[r.status] ?? ""}`}>{r.status.replace("_", " ")}</span></td>
                <td className="p-3 text-right">{inr(r.total_paise)}</td>
                <td className={`p-3 text-right ${r.due_paise > 0 ? "font-semibold text-red-700" : "text-emerald-700"}`}>{inr(r.due_paise)}</td>
                <td className="p-3">{r.assigned_name ?? "—"}</td>
                <td className="p-3 text-slate-500">{fmtTime(r.created_at)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="p-8 text-center text-slate-500">No orders here.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
