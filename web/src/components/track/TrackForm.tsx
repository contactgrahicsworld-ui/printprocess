"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function TrackForm() {
  const router = useRouter();
  const [n, setN] = useState("");
  const [k, setK] = useState("");
  const [recent, setRecent] = useState<{ n: string; k: string }[]>([]);
  useEffect(() => {
    try { setRecent(JSON.parse(localStorage.getItem("mp_orders") ?? "[]")); } catch { /* ignore */ }
  }, []);
  return (
    <div className="space-y-4">
      <form className="card space-y-3" onSubmit={(e) => { e.preventDefault(); router.push(`/t/${encodeURIComponent(n.trim().toUpperCase())}?k=${encodeURIComponent(k.trim())}`); }}>
        <div><label className="label" htmlFor="on">Order number</label><input id="on" className="input" placeholder="MP-20261030-0001" value={n} onChange={(e) => setN(e.target.value)} required /></div>
        <div><label className="label" htmlFor="tk">Tracking code</label><input id="tk" className="input" value={k} onChange={(e) => setK(e.target.value)} required /></div>
        <button className="btn-primary w-full" type="submit">Track / Dekhein</button>
      </form>
      {recent.length > 0 && (
        <div className="card">
          <h2 className="mb-2 font-semibold">Recent orders on this phone</h2>
          <ul className="space-y-1">{recent.map((r) => <li key={r.n}><a className="text-brand-700 underline" href={`/t/${r.n}?k=${encodeURIComponent(r.k)}`}>{r.n}</a></li>)}</ul>
        </div>
      )}
    </div>
  );
}
