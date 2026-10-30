"use client";

import { useCallback, useEffect, useState } from "react";
import { api, inr } from "@/lib/client/api";

type Size = { multiplierBp: number; enabled: boolean };
type Prices = { bwSingleSidePaise: number; bwDoubleSidePaise: number; colorSingleSidePaise: number; colorDoubleSidePaise: number; minOrderPaise: number; sizes: Record<"A4" | "A3" | "LEGAL", Size>; paperTypes: { id: string; name: string; surchargePerSheetPaise: number; active: boolean }[]; services: { code: string; name: string; unit: string; amountPaise: number; active: boolean }[] };
type Shop = { shopName: string; address: string; phone: string | null; gstin: string | null; upiId: string | null; upiPayeeName: string | null; maxFileBytes: number; maxFiles: number; sessionTtlMinutes: number; retentionDays: number };

const rs = (p: number) => (p / 100).toFixed(2);
const paise = (v: string) => Math.round(Number(v || 0) * 100);

export default function Settings() {
  const [prices, setPrices] = useState<Prices | null>(null);
  const [shop, setShop] = useState<Shop | null>(null);
  const [svcIds, setSvcIds] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ t: "ok" | "err"; m: string } | null>(null);
  const load = useCallback(async () => {
    setPrices(await api<Prices>("/api/admin/settings/prices"));
    setShop(await api<Shop>("/api/admin/settings/shop"));
  }, []);
  useEffect(() => { void load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, ok: string) => { setMsg(null); try { await fn(); setMsg({ t: "ok", m: ok }); await load(); } catch (e) { setMsg({ t: "err", m: e instanceof Error ? e.message : "Failed" }); } };
  if (!prices || !shop) return <p>Loading…</p>;

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      {msg && <p className={`rounded-lg p-3 text-sm ${msg.t === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{msg.m}</p>}

      <form className="card space-y-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const g = (k: string) => String(f.get(k) ?? "");
        void run(() => api("/api/admin/settings/prices", { method: "PUT", body: {
          bwSingleSidePaise: paise(g("bws")), bwDoubleSidePaise: paise(g("bwd")), colorSingleSidePaise: paise(g("cs")), colorDoubleSidePaise: paise(g("cd")), minOrderPaise: paise(g("min")),
          sizes: Object.fromEntries((["A4", "A3", "LEGAL"] as const).map((s) => [s, { multiplierBp: Math.round(Number(g(`m_${s}`)) * 10000), enabled: f.get(`e_${s}`) === "on" }])),
        } }), "Prices saved"); }}>
        <h2 className="font-semibold">Prices (₹ per printed side, A4 base)</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="text-sm">B/W single-side<input name="bws" className="input" defaultValue={rs(prices.bwSingleSidePaise)} inputMode="decimal" /></label>
          <label className="text-sm">B/W double-side (per side)<input name="bwd" className="input" defaultValue={rs(prices.bwDoubleSidePaise)} inputMode="decimal" /></label>
          <label className="text-sm">Colour single-side<input name="cs" className="input" defaultValue={rs(prices.colorSingleSidePaise)} inputMode="decimal" /></label>
          <label className="text-sm">Colour double-side (per side)<input name="cd" className="input" defaultValue={rs(prices.colorDoubleSidePaise)} inputMode="decimal" /></label>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {(["A4", "A3", "LEGAL"] as const).map((s) => (
            <div key={s} className="text-sm"><span className="font-medium">{s} multiplier</span>
              <input name={`m_${s}`} className="input" defaultValue={(prices.sizes[s].multiplierBp / 10000).toString()} inputMode="decimal" />
              <label className="mt-1 flex items-center gap-1"><input type="checkbox" name={`e_${s}`} defaultChecked={prices.sizes[s].enabled} /> enabled</label>
            </div>
          ))}
        </div>
        <label className="block text-sm">Minimum order (₹)<input name="min" className="input max-w-40" defaultValue={rs(prices.minOrderPaise)} inputMode="decimal" /></label>
        <button className="btn-primary">Save prices</button>
      </form>

      <section className="card space-y-3">
        <h2 className="font-semibold">Paper types (surcharge per sheet)</h2>
        <PaperTypes items={prices.paperTypes} run={run} />
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Services (stapling, binding, urgent…)</h2>
        <ul className="space-y-2 text-sm">
          {prices.services.map((s) => (
            <li key={s.code} className="flex flex-wrap items-center gap-2"><span className="font-mono">{s.code}</span><span>{s.name}</span><span className="text-slate-500">{s.unit}</span><span>{inr(s.amountPaise)}</span>{!s.active && <span className="chip bg-slate-200">inactive</span>}
              <button className="btn-secondary ml-auto py-1" onClick={async () => {
                const id = svcIds[s.code];
                const name = prompt("Name", s.name); if (name === null) return;
                const amt = prompt("Amount (₹)", rs(s.amountPaise)); if (amt === null) return;
                const active = confirm("Active? OK = active, Cancel = inactive");
                if (!id) { setMsg({ t: "err", m: "Reload to edit (id unknown)" }); return; }
                await run(() => api(`/api/admin/settings/services/${id}`, { method: "PUT", body: { code: s.code, name, unit: s.unit, amountPaise: paise(amt), active } }), "Service saved");
              }} disabled={!svcIds[s.code]}>Edit</button></li>
          ))}
        </ul>
        <ServiceIds onIds={setSvcIds} />
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget);
          void run(() => api("/api/admin/settings/services", { body: { code: String(f.get("code")), name: String(f.get("name")), unit: String(f.get("unit")), amountPaise: paise(String(f.get("amt"))), active: true } }), "Service added"); e.currentTarget.reset(); }}>
          <input name="code" className="input w-28" placeholder="CODE" required /><input name="name" className="input w-48" placeholder="Name" required />
          <select name="unit" className="input w-40"><option value="PER_COPY">Per copy</option><option value="PER_DOCUMENT">Per document</option><option value="PER_ORDER">Per order</option></select>
          <input name="amt" className="input w-24" placeholder="₹" required inputMode="decimal" /><button className="btn-primary">Add</button>
        </form>
      </section>

      <form className="card space-y-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const g = (k: string) => String(f.get(k) ?? "").trim();
        void run(() => api("/api/admin/settings/shop", { method: "PUT", body: {
          shopName: g("shopName"), address: g("address"), phone: g("phone") || null, gstin: g("gstin") || null, upiId: g("upiId") || null, upiPayeeName: g("upiPayeeName") || null,
          maxFileBytes: Math.round(Number(g("maxMb")) * 1048576), maxFiles: Number(g("maxFiles")), sessionTtlMinutes: Number(g("ttl")), retentionDays: Number(g("ret")),
        } }), "Shop settings saved"); }}>
        <h2 className="font-semibold">Shop details, upload limits, retention</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">Shop name<input name="shopName" className="input" defaultValue={shop.shopName} required /></label>
          <label className="text-sm">Phone<input name="phone" className="input" defaultValue={shop.phone ?? ""} /></label>
          <label className="text-sm sm:col-span-2">Address<input name="address" className="input" defaultValue={shop.address} required /></label>
          <label className="text-sm">GSTIN (optional)<input name="gstin" className="input" defaultValue={shop.gstin ?? ""} /></label>
          <label className="text-sm">UPI ID (for UPI QR on tracking page)<input name="upiId" className="input" defaultValue={shop.upiId ?? ""} placeholder="shop@okaxis" /></label>
          <label className="text-sm">UPI payee name<input name="upiPayeeName" className="input" defaultValue={shop.upiPayeeName ?? ""} /></label>
          <label className="text-sm">Max file size (MB, ≤ bucket limit)<input name="maxMb" className="input" defaultValue={(shop.maxFileBytes / 1048576).toString()} inputMode="decimal" /></label>
          <label className="text-sm">Max files per order<input name="maxFiles" className="input" defaultValue={shop.maxFiles} inputMode="numeric" /></label>
          <label className="text-sm">Upload session validity (minutes)<input name="ttl" className="input" defaultValue={shop.sessionTtlMinutes} inputMode="numeric" /></label>
          <label className="text-sm">Delete files after (days)<input name="ret" className="input" defaultValue={shop.retentionDays} inputMode="numeric" /></label>
        </div>
        <button className="btn-primary">Save shop settings</button>
      </form>
    </div>
  );
}

function PaperTypes({ items, run }: { items: Prices["paperTypes"]; run: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  return (
    <>
      <ul className="space-y-2 text-sm">
        {items.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2"><span>{p.name}</span><span className="text-slate-500">+{inr(p.surchargePerSheetPaise)}/sheet</span>{!p.active && <span className="chip bg-slate-200">inactive</span>}
            <button className="btn-secondary ml-auto py-1" onClick={() => void run(() => api(`/api/admin/settings/paper-types/${p.id}`, { method: "PUT", body: { name: p.name, surchargePerSheetPaise: p.surchargePerSheetPaise, active: !p.active } }), p.active ? "Disabled" : "Enabled")}>{p.active ? "Disable" : "Enable"}</button></li>
        ))}
      </ul>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget);
        void run(() => api("/api/admin/settings/paper-types", { body: { name: String(f.get("name")), surchargePerSheetPaise: paise(String(f.get("amt"))), active: true } }), "Paper type added"); e.currentTarget.reset(); }}>
        <input name="name" className="input w-56" placeholder="e.g. Glossy 170 GSM" required /><input name="amt" className="input w-24" placeholder="₹/sheet" required inputMode="decimal" /><button className="btn-primary">Add</button>
      </form>
    </>
  );
}

/** Services API returns codes; ids are needed for PUT. Loaded via the paper/service admin listing endpoint. */
function ServiceIds({ onIds }: { onIds: (m: Record<string, string>) => void }) {
  useEffect(() => { void api<{ services: { id: string; code: string }[] }>("/api/admin/settings/services").then((r) => onIds(Object.fromEntries(r.services.map((s) => [s.code, s.id])))).catch(() => undefined); }, [onIds]);
  return null;
}
