"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtTime } from "@/lib/client/api";
import { useLive, useNow } from "@/lib/client/useLive";

type Agent = { id: string; name: string; created_at: string; revoked_at: string | null; last_heartbeat_at: string | null; agent_version: string | null; hostname: string | null; printers: { name: string; status: string; isDefault?: boolean; supportsColor?: boolean; supportsDuplex?: boolean; paperSizes?: string[] }[] };

export default function Agents({ canManage, serverUrl, realtime }: { canManage: boolean; serverUrl: string; realtime: boolean }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ agentId: string; secret: string; name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const now = useNow();
  const load = useCallback(async () => { try { setAgents((await api<{ agents: Agent[] }>("/api/admin/agents")).agents); } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); } }, []);
  useEffect(() => { void load(); }, [load]);
  useLive(["print_agents"], load, realtime, 15000);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Print agents</h1>
      {err && <p className="text-red-600">{err}</p>}
      {canManage && (
        <form className="card flex flex-wrap items-end gap-2" onSubmit={async (e) => {
          e.preventDefault(); setErr(null);
          try { const r = await api<{ agentId: string; secret: string; name: string }>("/api/admin/agents", { body: { name } }); setCreated(r); setName(""); await load(); } catch (ex) { setErr(ex instanceof Error ? ex.message : "Failed"); }
        }}>
          <div className="flex-1"><label className="label" htmlFor="an">New agent name (e.g. Counter PC)</label><input id="an" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></div>
          <button className="btn-primary">Create agent</button>
        </form>
      )}
      {created && (
        <div className="card border-amber-400 bg-amber-50">
          <h2 className="font-bold text-amber-900">Copy these now — the secret is shown only once</h2>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-white p-3 text-xs" data-testid="agent-secret">{JSON.stringify({ serverUrl, agentId: created.agentId, agentSecret: created.secret }, null, 2)}</pre>
          <p className="mt-2 text-sm">Paste into the print agent&apos;s config on the shop PC (see the print-agent install guide). Only a hash is stored on the server.</p>
          <button className="btn-secondary mt-2" onClick={() => setCreated(null)}>I have saved it</button>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {agents.map((a) => {
          const online = a.last_heartbeat_at && now - new Date(a.last_heartbeat_at).getTime() < 120000;
          return (
            <div key={a.id} className={`card ${a.revoked_at ? "opacity-60" : ""}`}>
              <div className="flex items-center gap-2">
                <h2 className="font-semibold">{a.name}</h2>
                {a.revoked_at ? <span className="chip bg-red-100 text-red-700">Revoked</span> : <span className={`chip ${online ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700"}`}>{online ? "● Online" : "Offline"}</span>}
                {canManage && !a.revoked_at && <button className="btn-danger ml-auto py-1" onClick={async () => { if (!confirm(`Revoke ${a.name}? It will stop printing immediately.`)) return; await api(`/api/admin/agents/${a.id}/revoke`, { method: "POST" }).catch((e) => setErr(e.message)); await load(); }}>Revoke</button>}
              </div>
              <p className="mt-1 text-xs text-slate-500">ID {a.id}<br />{a.hostname ?? "—"} · v{a.agent_version ?? "?"} · last heartbeat {a.last_heartbeat_at ? fmtTime(a.last_heartbeat_at) : "never"}</p>
              <ul className="mt-2 space-y-1 text-sm">
                {a.printers.map((p) => (
                  <li key={p.name} className="flex flex-wrap items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${p.status === "Normal" ? "bg-emerald-500" : "bg-red-500"}`} />
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-slate-500">{p.status}{p.isDefault ? " · default" : ""}{p.supportsColor ? " · colour" : " · B/W"}{p.supportsDuplex ? " · duplex" : ""}{p.paperSizes?.length ? ` · ${p.paperSizes.join("/")}` : ""}</span>
                  </li>
                ))}
                {a.printers.length === 0 && <li className="text-xs text-slate-500">No printers reported yet.</li>}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
