"use client";

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, fmtTime } from "@/lib/client/api";

type Qr = { id: string; token: string; label: string; createdAt: string; url: string };

export default function QrAdmin({ canManage }: { canManage: boolean }) {
  const [qr, setQr] = useState<Qr | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await api<{ qr: Qr | null }>("/api/admin/qr");
    setQr(r.qr); setLoaded(true);
    setImg(r.qr ? await QRCode.toDataURL(r.qr.url, { width: 320, margin: 2 }) : null);
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold">Customer QR code</h1>
      {msg && <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{msg}</p>}
      {loaded && !qr && <div className="card"><p className="font-semibold text-red-700">No active QR code. Customers cannot upload.</p></div>}
      {qr && (
        <div className="card flex flex-col items-center gap-3 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {img && <img src={img} alt="Shop QR code" className="h-64 w-64" />}
          <p className="break-all font-mono text-xs text-slate-500">{qr.url}</p>
          <p className="text-xs text-slate-500">{qr.label} · active since {fmtTime(qr.createdAt)}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <a className="btn-primary" href="/api/admin/qr/png">Download PNG</a>
            <a className="btn-secondary" href="/api/admin/qr/poster">Download A4 poster (PDF)</a>
            <a className="btn-secondary" href={qr.url} target="_blank" rel="noreferrer">Open portal</a>
          </div>
        </div>
      )}
      {canManage && (
        <div className="card space-y-2">
          <h2 className="font-semibold">Manage</h2>
          <p className="text-sm text-slate-600">Regenerating creates a new QR and permanently disables the old one (old posters stop working). Use it if the QR is misused.</p>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={async () => { if (!confirm("Create a new QR and disable the current one?")) return; await api("/api/admin/qr/regenerate", { body: { label: "Counter QR" } }); setMsg("New QR created. Print the new poster."); await load(); }}>{qr ? "Regenerate" : "Create QR"}</button>
            {qr && <button className="btn-danger" onClick={async () => { if (!confirm("Disable the QR? Customers will not be able to upload until you create a new one.")) return; await api("/api/admin/qr/deactivate", { method: "POST" }); setMsg("QR disabled."); await load(); }}>Deactivate</button>}
          </div>
        </div>
      )}
    </div>
  );
}
