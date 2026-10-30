"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmtBytes, fmtTime, inr } from "@/lib/client/api";
import { useLive, useNow } from "@/lib/client/useLive";
import { STATUS_CHIP } from "./Dashboard";

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Detail = { order: R; items: R[]; jobs: R[]; jobEvents: R[]; history: R[]; revisions: R[]; payments: R[]; receipts: R[]; audit: R[] };
type Agent = { id: string; name: string; revoked_at: string | null; last_heartbeat_at: string | null; printers: { name: string; status: string; isDefault?: boolean; supportsColor?: boolean; supportsDuplex?: boolean }[] };
type Catalog = { paperTypes: { id: string; name: string; active: boolean }[]; services: { code: string; name: string; unit: string; active: boolean }[] };

const JOB_LABEL: Record<string, { l: string; c: string }> = {
  QUEUED: { l: "Queued — waiting for agent", c: "bg-slate-200 text-slate-700" },
  CLAIMED: { l: "Claimed by agent", c: "bg-sky-100 text-sky-800" },
  DOWNLOADED: { l: "Downloaded by agent", c: "bg-sky-100 text-sky-800" },
  SUBMITTED: { l: "SUBMITTED to spooler (not printed yet)", c: "bg-indigo-100 text-indigo-800" },
  SPOOLED: { l: "SPOOLED — in Windows queue", c: "bg-indigo-100 text-indigo-800" },
  PRINTING: { l: "Spooler says PRINTING", c: "bg-purple-100 text-purple-800" },
  COMPLETED_SPOOLER: { l: "Spooler finished — NOT VERIFIED (check the paper!)", c: "bg-amber-100 text-amber-900" },
  VERIFIED: { l: "✓ VERIFIED printed by staff", c: "bg-emerald-100 text-emerald-800" },
  FAILED: { l: "Failed", c: "bg-red-100 text-red-700" },
  PRINTER_OFFLINE: { l: "Printer offline", c: "bg-red-100 text-red-700" },
  PAPER_OUT: { l: "Paper out", c: "bg-red-100 text-red-700" },
  ERROR: { l: "Printer error", c: "bg-red-100 text-red-700" },
  CANCELLED: { l: "Cancelled", c: "bg-slate-200 text-slate-600" },
};
const FAILED = ["FAILED", "PRINTER_OFFLINE", "PAPER_OUT", "ERROR", "CANCELLED"];
const VERIFIABLE = ["SUBMITTED", "SPOOLED", "PRINTING", "COMPLETED_SPOOLER"];
const EDITABLE = ["RECEIVED", "UNDER_REVIEW", "APPROVED"];
const ONLINE_MS = 2 * 60_000;

export default function OrderDetail({ orderId, realtime, staffId }: { orderId: string; realtime: boolean; staffId: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [staffList, setStaffList] = useState<{ user_id: string; full_name: string; email: string; active: boolean }[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [msg, setMsg] = useState<{ t: "ok" | "err"; m: string } | null>(null);
  const [preview, setPreview] = useState<{ url: string; mime: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setD(await api<Detail>(`/api/admin/orders/${orderId}`)); } catch (e) { setMsg({ t: "err", m: e instanceof Error ? e.message : "Failed" }); }
  }, [orderId]);
  const loadAgents = useCallback(async () => { try { setAgents((await api<{ agents: Agent[] }>("/api/admin/agents")).agents); } catch { /* ignore */ } }, []);
  useEffect(() => {
    void load(); void loadAgents();
    void api<{ staff: typeof staffList }>("/api/admin/staff").then((r) => setStaffList(r.staff)).catch(() => undefined);
    void api<Catalog>("/api/admin/settings/prices").then(setCatalog).catch(() => undefined);
  }, [load, loadAgents]);
  useLive(["orders", "print_jobs", "payments", "print_agents"], () => { void load(); void loadAgents(); }, realtime, 10000);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try { await fn(); setMsg({ t: "ok", m: ok }); await load(); } catch (e) { setMsg({ t: "err", m: e instanceof Error ? e.message : "Failed" }); }
  };

  if (!d) return <p className="text-slate-500">{msg?.m ?? "Loading…"}</p>;
  const o = d.order;
  const status: string = o.status;

  const openFile = async (fileId: string, mime: string, download: boolean) => {
    try {
      const r = await api<{ url: string }>(`/api/admin/files/${fileId}/url${download ? "?download=1" : ""}`);
      if (download) window.location.assign(r.url); else setPreview({ url: r.url, mime });
    } catch (e) { setMsg({ t: "err", m: e instanceof Error ? e.message : "Failed" }); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/admin" className="text-sm text-slate-500 hover:underline">← Orders</Link>
        <h1 className="font-mono text-2xl font-bold">{o.order_number}</h1>
        <span className={`chip ${STATUS_CHIP[status] ?? ""}`} data-testid="admin-order-status">{status.replace("_", " ")}</span>
        <span className="text-sm text-slate-500">{fmtTime(o.created_at)}</span>
      </div>
      {msg && <p className={`rounded-lg p-3 text-sm ${msg.t === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`} role="status">{msg.m}</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {d.items.map((it) => {
            const jobs = d.jobs.filter((j) => j.order_item_id === it.id);
            const active = jobs.find((j) => !FAILED.includes(j.status) && j.status !== "VERIFIED");
            return (
              <section key={it.id} className="card space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 className="font-semibold">{it.position}. {it.original_name}</h2>
                    <p className="text-xs text-slate-500">{it.detected_mime} · {fmtBytes(Number(it.size_bytes ?? 0))} · {it.file_page_count} page(s) (server count) · scan: <b className={it.scan_status === "NOT_SCANNED" ? "text-amber-700" : ""}>{it.scan_status}</b> · file: {it.file_status}</p>
                  </div>
                  <div className="flex gap-2">
                    <button className="btn-secondary" disabled={it.file_status !== "READY"} onClick={() => openFile(it.file_id, it.detected_mime, false)}>Preview</button>
                    <button className="btn-secondary" disabled={it.file_status !== "READY"} onClick={() => openFile(it.file_id, it.detected_mime, true)}>Download</button>
                  </div>
                </div>
                {editing === it.id ? (
                  <EditItem item={it} catalog={catalog} onCancel={() => setEditing(null)} onSave={(body) => act(async () => { await api(`/api/admin/order-items/${it.id}`, { method: "PATCH", body }); setEditing(null); }, "Settings updated and price recalculated")} />
                ) : (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="chip bg-slate-100">{it.color_mode === "BW" ? "B/W" : "Colour"}</span>
                    <span className="chip bg-slate-100">{it.duplex === "DOUBLE" ? "Double side" : "Single side"}</span>
                    <span className="chip bg-slate-100">{it.paper_size}</span>
                    {it.paper_type_name && <span className="chip bg-slate-100">{it.paper_type_name}</span>}
                    <span className="chip bg-slate-100">Pages {it.page_ranges ?? "all"} ({it.pages_selected}/{it.pages_total})</span>
                    <span className="chip bg-slate-100">{it.copies} copies</span>
                    <span className="chip bg-slate-100">{it.total_sheets} sheets · {it.printed_sides} sides</span>
                    {(it.service_codes ?? []).map((s: string) => <span key={s} className="chip bg-brand-50 text-brand-700">{s}</span>)}
                    <span className="ml-auto font-semibold">{inr(it.price_paise)}</span>
                    {EDITABLE.includes(status) && !active && <button className="btn-secondary py-1" onClick={() => setEditing(it.id)}>Edit settings</button>}
                  </div>
                )}
                {it.instructions && <p className="rounded-lg bg-amber-50 p-2 text-sm">📝 {it.instructions}</p>}

                <div className="rounded-xl bg-slate-50 p-3">
                  <h3 className="mb-2 text-sm font-semibold">Print jobs</h3>
                  {jobs.length === 0 && <p className="text-sm text-slate-500">Not sent to a printer yet.</p>}
                  <ul className="space-y-2">
                    {jobs.map((j) => (
                      <li key={j.id} className="rounded-lg border bg-white p-2 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs">#{j.attempt}</span>
                          <span className={`chip ${JOB_LABEL[j.status]?.c ?? ""}`} data-testid="job-status">{JOB_LABEL[j.status]?.l ?? j.status}</span>
                          <span className="text-xs text-slate-500">{j.agent_name ?? "agent"} → {j.printer_name ?? "default printer"}{j.spooler_job_id != null ? ` · spool #${j.spooler_job_id}` : ""}</span>
                          <div className="ml-auto flex gap-2">
                            {VERIFIABLE.includes(j.status) && <button className="btn-success py-1" onClick={() => act(() => api(`/api/admin/print-jobs/${j.id}/verify`, { method: "POST" }), "Marked as verified printed")}>Verify printed</button>}
                            {FAILED.includes(j.status) && !active && ["APPROVED", "PRINTING", "READY"].includes(status) && <button className="btn-secondary py-1" onClick={() => act(() => api(`/api/admin/print-jobs/${j.id}/requeue`, { method: "POST", body: {} }), "Re-queued")}>Re-queue</button>}
                            {["QUEUED", "CLAIMED"].includes(j.status) && <button className="btn-secondary py-1" onClick={() => act(() => api(`/api/admin/print-jobs/${j.id}/cancel`, { method: "POST" }), "Job cancelled")}>Cancel</button>}
                          </div>
                        </div>
                        {["QUEUED", "CLAIMED", "DOWNLOADED"].includes(j.status) && (() => {
                          const ag = agents.find((x) => x.id === (j.claimed_by_agent ?? j.target_agent_id));
                          const pr = ag?.printers.find((x) => x.name === j.printer_name);
                          return pr ? <p className={`mt-1 text-xs ${pr.status === "Normal" ? "text-slate-500" : "font-semibold text-red-700"}`}>Printer now: {pr.status}{pr.status !== "Normal" ? " — agent is waiting, job not sent yet" : ""}</p> : null;
                        })()}
                        {j.last_detail && <p className="mt-1 text-xs text-slate-500">{j.last_detail}</p>}
                        {j.verified_at && <p className="mt-1 text-xs text-emerald-700">Verified by {j.verified_by_name ?? "staff"} at {fmtTime(j.verified_at)}</p>}
                        <details className="mt-1"><summary className="cursor-pointer text-xs text-slate-500">Event log</summary>
                          <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                            {d.jobEvents.filter((e) => e.job_id === j.id).map((e) => <li key={e.id}>{fmtTime(e.created_at)} · {e.source} · {e.status}{e.detail ? ` — ${e.detail}` : ""}</li>)}
                          </ul>
                        </details>
                      </li>
                    ))}
                  </ul>
                  {!active && ["APPROVED", "PRINTING", "READY"].includes(status) && it.file_status === "READY" && (
                    <SendToPrinter agents={agents} item={it} onSend={(agentId, printerName) => act(() => api(`/api/admin/order-items/${it.id}/print-jobs`, { body: { agentId, printerName } }), "Sent to printer")} />
                  )}
                </div>
              </section>
            );
          })}
        </div>

        <aside className="space-y-4">
          <section className="card space-y-2 text-sm">
            <h2 className="font-semibold">Customer</h2>
            <p>{o.customer_name}{o.customer_phone && <> · <a className="text-brand-700" href={`tel:${o.customer_phone}`}>{o.customer_phone}</a></>}</p>
            {o.notes && <p className="rounded-lg bg-amber-50 p-2">{o.notes}</p>}
            <label className="label mt-2" htmlFor="assign">Assigned to</label>
            <select id="assign" className="input" value={o.assigned_to ?? ""} onChange={(e) => act(() => api(`/api/admin/orders/${orderId}/assign`, { body: { staffId: e.target.value || null } }), "Assignment updated")}>
              <option value="">— Unassigned —</option>
              {staffList.filter((s) => s.active).map((s) => <option key={s.user_id} value={s.user_id}>{s.full_name || s.email}{s.user_id === staffId ? " (me)" : ""}</option>)}
            </select>
          </section>

          <section className="card space-y-2">
            <h2 className="font-semibold">Workflow</h2>
            <div className="flex flex-wrap gap-2">
              {status === "RECEIVED" && <button className="btn-secondary" onClick={() => act(() => api(`/api/admin/orders/${orderId}/status`, { body: { to: "UNDER_REVIEW" } }), "Marked under review")}>Start review</button>}
              {["RECEIVED", "UNDER_REVIEW"].includes(status) && <button className="btn-success" onClick={() => act(() => api(`/api/admin/orders/${orderId}/approve`, { method: "POST" }), "Approved")}>Approve</button>}
              {["RECEIVED", "UNDER_REVIEW", "APPROVED"].includes(status) && <RejectButton onReject={(reason) => act(() => api(`/api/admin/orders/${orderId}/reject`, { body: { reason } }), "Order rejected")} />}
              {status === "PRINTING" && <button className="btn-secondary" onClick={() => act(() => api(`/api/admin/orders/${orderId}/status`, { body: { to: "READY" } }), "Marked ready")}>Mark ready</button>}
              {status === "PRINTING" && <button className="btn-secondary" onClick={() => act(() => api(`/api/admin/orders/${orderId}/status`, { body: { to: "APPROVED" } }), "Moved back to approved")}>Back to approved</button>}
              {status === "READY" && <button className="btn-primary" onClick={() => { if (o.due_paise > 0 && !confirm(`Due ${inr(o.due_paise)} is unpaid. Deliver anyway?`)) return; void act(() => api(`/api/admin/orders/${orderId}/status`, { body: { to: "DELIVERED" } }), "Delivered"); }}>Mark delivered</button>}
            </div>
            {o.rejection_reason && <p className="text-sm text-red-700">Reason: {o.rejection_reason}</p>}
          </section>

          <section className="card space-y-2 text-sm">
            <h2 className="font-semibold">Payment</h2>
            <dl className="space-y-1">
              {(o.order_services?.lines ?? []).map((l: R) => <div key={l.label} className="flex justify-between"><dt>{l.label}</dt><dd>{inr(l.amountPaise)}</dd></div>)}
              {o.adjustment_paise > 0 && <div className="flex justify-between"><dt>Min. order adj.</dt><dd>{inr(o.adjustment_paise)}</dd></div>}
              <div className="flex justify-between font-semibold"><dt>Total</dt><dd>{inr(o.total_paise)}</dd></div>
              <div className="flex justify-between"><dt>Paid</dt><dd>{inr(o.paid_paise)}</dd></div>
              <div className={`flex justify-between font-bold ${o.due_paise > 0 ? "text-red-700" : "text-emerald-700"}`}><dt>Due</dt><dd data-testid="admin-due">{inr(o.due_paise)}</dd></div>
            </dl>
            <ul className="space-y-1 text-xs text-slate-600">
              {d.payments.map((p) => <li key={p.id}>{fmtTime(p.created_at)} · {p.method} {inr(p.amount_paise)}{p.reference ? ` · ${p.reference}` : ""} · {p.recorded_by_name ?? (p.gateway_payment_id ? "gateway (verified webhook)" : "")}</li>)}
            </ul>
            {o.due_paise > 0 && status !== "CANCELLED" && (
              <>
                {o.payment_claim && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900" data-testid="payment-claim">
                    <b>Customer says paid via UPI:</b> UTR <b>{o.payment_claim.reference}</b> · {fmtTime(o.payment_claim.at)}{o.payment_claim.note ? ` · ${o.payment_claim.note}` : ""} — verify in your UPI app, then record below.
                  </div>
                )}
                <PaymentForm due={o.due_paise} defaultMethod={o.payment_claim ? "UPI" : "CASH"} defaultRef={o.payment_claim?.reference ?? ""} onSave={(b) => act(() => api(`/api/admin/orders/${orderId}/payments`, { body: b }), "Payment recorded")} />
              </>
            )}
            <div className="border-t pt-2">
              <button className="btn-secondary w-full" onClick={() => act(async () => { const r = await api<{ receiptId: string }>(`/api/admin/orders/${orderId}/receipts`, { method: "POST" }); window.open(`/admin/receipts/${r.receiptId}`, "_blank"); }, "Receipt issued")}>Generate receipt</button>
              <ul className="mt-2 space-y-1 text-xs">
                {d.receipts.map((r) => <li key={r.id}><a className="text-brand-700 underline" href={`/admin/receipts/${r.id}`} target="_blank" rel="noreferrer">{r.receipt_number}</a> · <a className="underline" href={`/api/admin/receipts/${r.id}/pdf`} target="_blank" rel="noreferrer">PDF</a> · {fmtTime(r.issued_at)}</li>)}
              </ul>
            </div>
          </section>

          <section className="card text-xs">
            <h2 className="mb-2 text-sm font-semibold">History</h2>
            <ul className="space-y-1">
              {d.history.map((h) => <li key={h.id}>{fmtTime(h.created_at)} · {h.from_status ?? "—"} → <b>{h.to_status}</b>{h.changed_by_name ? ` · ${h.changed_by_name}` : ""}{h.reason ? ` · ${h.reason}` : ""}</li>)}
            </ul>
            {d.revisions.length > 0 && <>
              <h3 className="mb-1 mt-3 font-semibold">Setting changes</h3>
              <ul className="space-y-1">{d.revisions.map((r) => <li key={r.id}>{fmtTime(r.created_at)} · {r.changed_by_name}: {inr(r.before.pricePaise)} → {inr(r.after.pricePaise)} (copies {r.before.copies}→{r.after.copies}, pages {r.before.pageRanges ?? "all"}→{r.after.pageRanges ?? "all"}){r.reason ? ` · ${r.reason}` : ""}</li>)}</ul>
            </>}
            <h3 className="mb-1 mt-3 font-semibold">Audit</h3>
            <ul className="max-h-48 space-y-1 overflow-auto">{d.audit.map((a, i) => <li key={i}>{fmtTime(a.created_at)} · {a.actor_name ?? a.actor_role ?? "system"} · {a.action}</li>)}</ul>
          </section>
        </aside>
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/70 p-4" onClick={() => setPreview(null)}>
          <div className="mb-2 flex justify-end gap-2"><a className="btn-secondary" href={preview.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open in new tab</a><button className="btn-secondary" onClick={() => setPreview(null)}>Close (link expires in 2 min)</button></div>
          {preview.mime.startsWith("image/")
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={preview.url} alt="preview" className="mx-auto max-h-full max-w-full rounded bg-white object-contain" />
            : <iframe src={preview.url} title="preview" className="h-full w-full rounded bg-white" />}
        </div>
      )}
    </div>
  );
}

function SendToPrinter({ agents, item, onSend }: { agents: Agent[]; item: R; onSend: (agentId: string, printer: string | null) => void }) {
  const usable = agents.filter((a) => !a.revoked_at);
  const [agentId, setAgentId] = useState("");
  const [printer, setPrinter] = useState("");
  const now = useNow();
  const agent = usable.find((a) => a.id === agentId);
  const online = agent?.last_heartbeat_at && now - new Date(agent.last_heartbeat_at).getTime() < ONLINE_MS;
  const p = agent?.printers.find((x) => x.name === printer);
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
      <div><label className="label">Agent</label>
        <select className="input" aria-label="Agent" value={agentId} onChange={(e) => { setAgentId(e.target.value); setPrinter(""); }}>
          <option value="">Choose…</option>
          {usable.map((a) => <option key={a.id} value={a.id}>{a.name}{a.last_heartbeat_at && now - new Date(a.last_heartbeat_at).getTime() < ONLINE_MS ? " (online)" : " (offline)"}</option>)}
        </select></div>
      <div><label className="label">Printer</label>
        <select className="input" aria-label="Printer" value={printer} onChange={(e) => setPrinter(e.target.value)} disabled={!agent}>
          <option value="">Choose…</option>
          {agent?.printers.map((x) => <option key={x.name} value={x.name}>{x.name} — {x.status}{x.isDefault ? " (default)" : ""}</option>)}
        </select></div>
      <button className="btn-primary" disabled={!agentId || !printer} onClick={() => onSend(agentId, printer)}>Send to printer</button>
      {agent && !online && <p className="w-full text-xs text-amber-700">Agent has not sent a heartbeat in the last 2 minutes — the job will wait in the queue.</p>}
      {p && item.color_mode === "COLOR" && p.supportsColor === false && <p className="w-full text-xs text-red-700">This printer does not report colour support.</p>}
      {p && item.duplex === "DOUBLE" && p.supportsDuplex === false && <p className="w-full text-xs text-red-700">This printer does not report duplex support.</p>}
      {p && p.status !== "Normal" && <p className="w-full text-xs text-amber-700">Printer status: {p.status}</p>}
    </div>
  );
}

function EditItem({ item, catalog, onSave, onCancel }: { item: R; catalog: Catalog | null; onSave: (b: R) => void; onCancel: () => void }) {
  const [f, setF] = useState({ colorMode: item.color_mode, duplex: item.duplex, paperSize: item.paper_size, copies: item.copies, pageRanges: item.page_ranges ?? "", paperTypeId: item.paper_type_id ?? "", serviceCodes: (item.service_codes ?? []) as string[], instructions: item.instructions ?? "", reason: "" });
  return (
    <div className="grid gap-2 rounded-xl border p-3 text-sm sm:grid-cols-3">
      <select className="input" value={f.colorMode} onChange={(e) => setF({ ...f, colorMode: e.target.value })}><option value="BW">B/W</option><option value="COLOR">Colour</option></select>
      <select className="input" value={f.duplex} onChange={(e) => setF({ ...f, duplex: e.target.value })}><option value="SINGLE">Single side</option><option value="DOUBLE">Double side</option></select>
      <select className="input" value={f.paperSize} onChange={(e) => setF({ ...f, paperSize: e.target.value })}><option>A4</option><option>A3</option><option value="LEGAL">Legal</option></select>
      <input className="input" type="number" min={1} max={500} value={f.copies} onChange={(e) => setF({ ...f, copies: Number(e.target.value) })} aria-label="Copies" />
      <input className="input" placeholder={`Pages (1-${item.file_page_count}) blank = all`} value={f.pageRanges} onChange={(e) => setF({ ...f, pageRanges: e.target.value })} aria-label="Pages" />
      <select className="input" value={f.paperTypeId} onChange={(e) => setF({ ...f, paperTypeId: e.target.value })}><option value="">Normal paper</option>{catalog?.paperTypes.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <div className="flex flex-wrap gap-2 sm:col-span-3">{catalog?.services.filter((s) => s.active && s.unit !== "PER_ORDER").map((s) => (
        <label key={s.code} className="flex items-center gap-1"><input type="checkbox" checked={f.serviceCodes.includes(s.code)} onChange={(e) => setF({ ...f, serviceCodes: e.target.checked ? [...f.serviceCodes, s.code] : f.serviceCodes.filter((x) => x !== s.code) })} />{s.name}</label>
      ))}</div>
      <input className="input sm:col-span-3" placeholder="Instructions" value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} />
      <input className="input sm:col-span-2" placeholder="Reason for change (saved in history)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      <div className="flex gap-2"><button className="btn-primary" onClick={() => onSave({ ...f, pageRanges: f.pageRanges.trim() || null, paperTypeId: f.paperTypeId || null, instructions: f.instructions.trim() || null, reason: f.reason.trim() || null })}>Save</button><button className="btn-secondary" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

function RejectButton({ onReject }: { onReject: (reason: string) => void }) {
  return <button className="btn-danger" onClick={() => { const r = prompt("Reason for rejection (shown to customer):"); if (r && r.trim().length >= 3) onReject(r.trim()); }}>Reject</button>;
}

function PaymentForm({ due, onSave, defaultMethod = "CASH", defaultRef = "" }: { due: number; onSave: (b: R) => void; defaultMethod?: string; defaultRef?: string }) {
  const [method, setMethod] = useState(defaultMethod);
  const [amount, setAmount] = useState((due / 100).toFixed(2));
  const [ref, setRef] = useState(defaultRef);
  return (
    <form className="space-y-2 border-t pt-2" onSubmit={(e) => { e.preventDefault(); onSave({ method, amountPaise: Math.round(Number(amount) * 100), reference: ref.trim() || null }); }}>
      <div className="flex gap-2">
        <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}><option value="CASH">Cash</option><option value="UPI">UPI</option><option value="ONLINE">Online / bank</option></select>
        <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount in rupees" />
      </div>
      {method !== "CASH" && <input className="input" placeholder={method === "UPI" ? "UPI reference / UTR (required)" : "Transaction reference (required)"} value={ref} onChange={(e) => setRef(e.target.value)} required />}
      <button className="btn-primary w-full">Record payment</button>
    </form>
  );
}
