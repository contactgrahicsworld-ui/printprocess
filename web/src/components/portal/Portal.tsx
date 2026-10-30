"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, fmtBytes, inr, putWithProgress } from "@/lib/client/api";
import { pdfThumbnail } from "./preview";

type Catalog = {
  rates: { bwSingleSidePaise: number; bwDoubleSidePaise: number; colorSingleSidePaise: number; colorDoubleSidePaise: number; minOrderPaise: number };
  paperSizes: { size: "A4" | "A3" | "LEGAL"; multiplierBp: number }[];
  paperTypes: { id: string; name: string; surchargePerSheetPaise: number }[];
  services: { code: string; name: string; unit: "PER_ORDER" | "PER_DOCUMENT" | "PER_COPY"; amountPaise: number }[];
};
type Limits = { maxFileBytes: number; maxFiles: number };
type ServerFile = { id: string; name: string; sizeBytes: number | null; mimeType: string | null; pageCount: number | null; status: string; rejectReason: string | null };
type Doc = {
  localId: string;
  name: string;
  size: number;
  progress: number;
  phase: "uploading" | "checking" | "ready" | "rejected" | "error";
  serverId?: string;
  pageCount?: number;
  mimeType?: string;
  error?: string;
  thumb?: string | null;
};
type Config = { colorMode: "BW" | "COLOR"; duplex: "SINGLE" | "DOUBLE"; paperSize: "A4" | "A3" | "LEGAL"; copies: number; pageMode: "all" | "custom"; pageRanges: string; paperTypeId: string | null; serviceCodes: string[]; instructions: string };
type QuoteItem = { fileId: string; name: string; pagesTotal: number; pagesSelected: number; totalSheets: number; printedSides: number; totalPaise: number; lines: { label: string; qty: number; unitPaise: number; amountPaise: number }[] };
type Quote = { items: QuoteItem[]; orderServiceLines: { label: string; amountPaise: number }[]; adjustmentPaise: number; totalPaise: number };

const ACCEPT = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";
const defaultConfig = (): Config => ({ colorMode: "BW", duplex: "SINGLE", paperSize: "A4", copies: 1, pageMode: "all", pageRanges: "", paperTypeId: null, serviceCodes: [], instructions: "" });

function contentTypeOf(f: File): "application/pdf" | "image/jpeg" | "image/png" | null {
  if (f.type === "application/pdf" || f.type === "image/jpeg" || f.type === "image/png") return f.type;
  const ext = f.name.toLowerCase().split(".").pop();
  if (ext === "pdf") return "application/pdf";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  return null;
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={o.v} type="button" aria-pressed={value === o.v} onClick={() => onChange(o.v)}>{o.l}</button>
        ))}
      </div>
    </div>
  );
}

export default function Portal({ qrToken, shopName, shopAddress }: { qrToken: string; shopName: string; shopAddress: string }) {
  const router = useRouter();
  const storeKey = `mp_session_${qrToken}`;
  const [session, setSession] = useState<string | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [configs, setConfigs] = useState<Record<string, Config>>({});
  const [orderServices, setOrderServices] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const patchDoc = useCallback((localId: string, patch: Partial<Doc>) => setDocs((ds) => ds.map((d) => (d.localId === localId ? { ...d, ...patch } : d))), []);

  // ---- session bootstrap (restores an unfinished session after a page refresh)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = typeof window !== "undefined" ? sessionStorage.getItem(storeKey) : null;
        if (saved) {
          const { token } = JSON.parse(saved) as { token: string };
          try {
            const st = await api<{ limits: Limits; catalog: Catalog; files: ServerFile[] }>("/api/public/sessions", { session: token });
            if (cancelled) return;
            setSession(token); setLimits(st.limits); setCatalog(st.catalog);
            const restored: Doc[] = st.files.filter((f) => f.status === "READY").map((f) => ({
              localId: f.id, name: f.name, size: f.sizeBytes ?? 0, progress: 100, phase: "ready", serverId: f.id, pageCount: f.pageCount ?? 1, mimeType: f.mimeType ?? undefined, thumb: null,
            }));
            setDocs(restored);
            setConfigs(Object.fromEntries(restored.map((d) => [d.serverId!, defaultConfig()])));
            return;
          } catch {
            sessionStorage.removeItem(storeKey);
          }
        }
        const s = await api<{ sessionToken: string; expiresAt: string; limits: Limits; catalog: Catalog }>("/api/public/sessions", { body: { qrToken } });
        if (cancelled) return;
        sessionStorage.setItem(storeKey, JSON.stringify({ token: s.sessionToken, idem: crypto.randomUUID() }));
        setSession(s.sessionToken); setLimits(s.limits); setCatalog(s.catalog);
      } catch (e) {
        if (!cancelled) setFatal(e instanceof ApiError ? e.message : "Could not start. Please check your internet and scan again.");
      }
    })();
    return () => { cancelled = true; };
  }, [qrToken, storeKey]);

  // ---- uploads
  const uploadOne = useCallback(async (file: File, localId: string) => {
    if (!session) return;
    const ct = contentTypeOf(file)!;
    try {
      const { fileId, upload } = await api<{ fileId: string; upload: { url: string; headers: Record<string, string> } }>("/api/public/uploads", { session, body: { name: file.name, size: file.size, contentType: ct } });
      patchDoc(localId, { serverId: fileId });
      await putWithProgress(upload.url, file, upload.headers, (p) => patchDoc(localId, { progress: p }));
      patchDoc(localId, { phase: "checking", progress: 100 });
      const { file: sf } = await api<{ file: ServerFile }>(`/api/public/uploads/${fileId}/complete`, { method: "POST", session });
      if (sf.status === "READY") {
        patchDoc(localId, { phase: "ready", pageCount: sf.pageCount ?? 1, mimeType: sf.mimeType ?? undefined });
        setConfigs((c) => ({ ...c, [fileId]: c[fileId] ?? defaultConfig() }));
      } else {
        patchDoc(localId, { phase: "rejected", error: sf.rejectReason ?? "File rejected" });
      }
    } catch (e) {
      patchDoc(localId, { phase: "error", error: e instanceof Error ? e.message : "Upload failed" });
    }
  }, [session, patchDoc]);

  const onPick = useCallback((list: FileList | null) => {
    if (!list || !limits) return;
    setNotice(null);
    const active = docs.filter((d) => d.phase !== "rejected" && d.phase !== "error").length;
    const files = Array.from(list);
    const room = limits.maxFiles - active;
    if (files.length > room) setNotice(`Only ${limits.maxFiles} files per order. / Ek order mein ${limits.maxFiles} files tak.`);
    for (const f of files.slice(0, Math.max(0, room))) {
      const localId = crypto.randomUUID();
      const ct = contentTypeOf(f);
      if (!ct) { setDocs((d) => [...d, { localId, name: f.name, size: f.size, progress: 0, phase: "rejected", error: "Only PDF, JPG, PNG allowed. / Sirf PDF, JPG, PNG." }]); continue; }
      if (f.size > limits.maxFileBytes) { setDocs((d) => [...d, { localId, name: f.name, size: f.size, progress: 0, phase: "rejected", error: `Larger than ${fmtBytes(limits.maxFileBytes)}. / File bahut badi hai.` }]); continue; }
      const thumb = ct === "application/pdf" ? null : URL.createObjectURL(f);
      setDocs((d) => [...d, { localId, name: f.name, size: f.size, progress: 0, phase: "uploading", thumb }]);
      if (ct === "application/pdf") void pdfThumbnail(f).then((t) => patchDoc(localId, { thumb: t }));
      void uploadOne(f, localId);
    }
    if (fileInput.current) fileInput.current.value = "";
  }, [docs, limits, uploadOne, patchDoc]);

  const removeDoc = useCallback(async (d: Doc) => {
    setDocs((ds) => ds.filter((x) => x.localId !== d.localId));
    if (d.serverId) {
      setConfigs((c) => { const n = { ...c }; delete n[d.serverId!]; return n; });
      if (session) await api(`/api/public/uploads/${d.serverId}`, { method: "DELETE", session }).catch(() => undefined);
    }
  }, [session]);

  const ready = useMemo(() => docs.filter((d) => d.phase === "ready" && d.serverId), [docs]);
  const busy = docs.some((d) => d.phase === "uploading" || d.phase === "checking");

  const itemsPayload = useMemo(() => ready.map((d) => {
    const c = configs[d.serverId!] ?? defaultConfig();
    return {
      fileId: d.serverId!, colorMode: c.colorMode, duplex: c.duplex, paperSize: c.paperSize, copies: c.copies,
      pageRanges: c.pageMode === "custom" && c.pageRanges.trim() ? c.pageRanges.trim() : null,
      paperTypeId: c.paperTypeId, serviceCodes: c.serviceCodes, instructions: c.instructions.trim() || null,
    };
  }), [ready, configs]);

  // ---- live server estimate (debounced)
  useEffect(() => {
    if (!session || itemsPayload.length === 0) { setQuote(null); setQuoteError(null); return; }
    const t = setTimeout(async () => {
      try {
        const q = await api<Quote>("/api/public/quote", { session, body: { items: itemsPayload, orderServiceCodes: orderServices } });
        setQuote(q); setQuoteError(null); setItemErrors({});
      } catch (e) {
        setQuote(null);
        if (e instanceof ApiError) {
          setQuoteError(e.message);
          const idx = e.body.itemIndex;
          if (typeof idx === "number" && itemsPayload[idx]) setItemErrors({ [itemsPayload[idx]!.fileId]: e.message });
        }
      }
    }, 350);
    return () => clearTimeout(t);
  }, [session, itemsPayload, orderServices]);

  const setCfg = (fileId: string, patch: Partial<Config>) => setConfigs((c) => ({ ...c, [fileId]: { ...(c[fileId] ?? defaultConfig()), ...patch } }));

  const submit = async () => {
    if (!session || !quote) return;
    if (!name.trim()) { setNotice("Please enter your name. / Apna naam likhein."); return; }
    if (phone && !/^[6-9]\d{9}$/.test(phone)) { setNotice("Enter a valid 10-digit mobile number. / Sahi mobile number likhein."); return; }
    setSubmitting(true); setNotice(null);
    const saved = JSON.parse(sessionStorage.getItem(storeKey) ?? "{}") as { token?: string; idem?: string };
    const idem = saved.idem ?? crypto.randomUUID();
    sessionStorage.setItem(storeKey, JSON.stringify({ ...saved, idem }));
    try {
      const r = await api<{ orderNumber: string; trackingToken: string }>("/api/public/orders", {
        session,
        body: { items: itemsPayload, orderServiceCodes: orderServices, idempotencyKey: idem, customerName: name.trim(), customerPhone: phone || null, notes: notes.trim() || null, expectedTotalPaise: quote.totalPaise },
      });
      sessionStorage.removeItem(storeKey);
      try {
        const list = JSON.parse(localStorage.getItem("mp_orders") ?? "[]") as { n: string; k: string }[];
        localStorage.setItem("mp_orders", JSON.stringify([{ n: r.orderNumber, k: r.trackingToken }, ...list].slice(0, 10)));
      } catch { /* storage may be unavailable */ }
      router.push(`/t/${r.orderNumber}?k=${encodeURIComponent(r.trackingToken)}&new=1`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "PRICE_MISMATCH" && e.body.quote) {
        setQuote(e.body.quote as Quote);
        setNotice("Price was updated by the shop. Please check the new total and tap Submit again. / Daam badal gaya hai.");
      } else {
        setNotice(e instanceof Error ? e.message : "Could not submit. Please try again.");
      }
      setSubmitting(false);
    }
  };

  if (fatal) {
    return (
      <main className="mx-auto max-w-md p-6"><div className="card text-center"><h1 className="text-lg font-bold">Sorry / Maaf kijiye</h1><p className="mt-2 text-slate-600">{fatal}</p></div></main>
    );
  }

  const perDocServices = catalog?.services.filter((s) => s.unit !== "PER_ORDER") ?? [];
  const perOrderServices = catalog?.services.filter((s) => s.unit === "PER_ORDER") ?? [];

  return (
    <main className="mx-auto max-w-xl pb-40">
      <header className="bg-brand-700 px-4 pb-6 pt-5 text-white">
        <h1 className="text-2xl font-bold">{shopName}</h1>
        <p className="text-sm text-brand-100">{shopAddress}</p>
        <p className="mt-3 text-base">Upload files to print · <span className="text-brand-100">Print ke liye file bhejein</span></p>
      </header>

      <section className="space-y-4 p-4">
        <div className="card">
          <h2 className="font-semibold">1. Upload karein / Upload files</h2>
          <p className="text-sm text-slate-500">PDF, JPG, PNG · max {limits ? fmtBytes(limits.maxFileBytes) : "…"} each · up to {limits?.maxFiles ?? "…"} files</p>
          <input ref={fileInput} type="file" accept={ACCEPT} multiple className="hidden" onChange={(e) => onPick(e.target.files)} data-testid="file-input" />
          <button type="button" className="btn-primary mt-3 w-full py-4 text-base" disabled={!session} onClick={() => fileInput.current?.click()}>
            📄 Choose files / File chunein
          </button>
          {notice && <p className="mt-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-800" role="alert">{notice}</p>}
        </div>

        {docs.map((d) => {
          const c = d.serverId ? configs[d.serverId] ?? defaultConfig() : null;
          const qi = quote?.items.find((q) => q.fileId === d.serverId);
          return (
            <article key={d.localId} className="card" data-testid="doc-card">
              <div className="flex gap-3">
                <div className="flex h-20 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-slate-100">
                  {d.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={d.thumb} alt="" className="h-full w-full object-cover" />
                  ) : <span className="text-2xl">{d.mimeType?.startsWith("image/") ? "🖼️" : "📄"}</span>}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium" title={d.name}>{d.name}</p>
                  <p className="text-xs text-slate-500">{fmtBytes(d.size)}{d.pageCount ? ` · ${d.pageCount} page${d.pageCount > 1 ? "s" : ""}` : ""}</p>
                  {d.phase === "uploading" && (
                    <div className="mt-2">
                      <div className="h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full bg-brand-500 transition-all" style={{ width: `${d.progress}%` }} /></div>
                      <p className="mt-1 text-xs text-slate-500">Uploading… {d.progress}%</p>
                    </div>
                  )}
                  {d.phase === "checking" && <p className="mt-2 text-xs text-slate-500">Checking file… / Jaanch ho rahi hai…</p>}
                  {(d.phase === "rejected" || d.phase === "error") && <p className="mt-2 text-sm text-red-600">{d.error}</p>}
                  {qi && <p className="mt-1 text-sm font-semibold text-brand-700">{inr(qi.totalPaise)} · {qi.totalSheets} sheet{qi.totalSheets > 1 ? "s" : ""}</p>}
                </div>
                <button type="button" className="self-start rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-red-600" aria-label={`Remove ${d.name}`} onClick={() => removeDoc(d)} disabled={d.phase === "uploading"}>✕</button>
              </div>

              {d.phase === "ready" && c && d.serverId && (
                <div className="mt-4 space-y-3 border-t pt-4">
                  <Seg label="Colour / Rang" value={c.colorMode} onChange={(v) => setCfg(d.serverId!, { colorMode: v })} options={[{ v: "BW", l: "Black & White" }, { v: "COLOR", l: "Colour" }]} />
                  <Seg label="Sides / Taraf" value={c.duplex} onChange={(v) => setCfg(d.serverId!, { duplex: v })} options={[{ v: "SINGLE", l: "Single side" }, { v: "DOUBLE", l: "Both sides" }]} />
                  <Seg label="Paper size / Kagaz" value={c.paperSize} onChange={(v) => setCfg(d.serverId!, { paperSize: v })} options={(catalog?.paperSizes ?? []).map((p) => ({ v: p.size, l: p.size === "LEGAL" ? "Legal" : p.size }))} />
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label" htmlFor={`copies-${d.serverId}`}>Copies / Pratiyan</label>
                      <div className="flex items-center gap-2">
                        <button type="button" className="btn-secondary px-3" onClick={() => setCfg(d.serverId!, { copies: Math.max(1, c.copies - 1) })} aria-label="Fewer copies">−</button>
                        <input id={`copies-${d.serverId}`} className="input text-center" inputMode="numeric" value={c.copies} onChange={(e) => setCfg(d.serverId!, { copies: Math.min(500, Math.max(1, parseInt(e.target.value || "1", 10) || 1)) })} />
                        <button type="button" className="btn-secondary px-3" onClick={() => setCfg(d.serverId!, { copies: Math.min(500, c.copies + 1) })} aria-label="More copies">+</button>
                      </div>
                    </div>
                    {(catalog?.paperTypes.length ?? 0) > 0 && (
                      <div>
                        <label className="label" htmlFor={`pt-${d.serverId}`}>Paper type</label>
                        <select id={`pt-${d.serverId}`} className="input" value={c.paperTypeId ?? ""} onChange={(e) => setCfg(d.serverId!, { paperTypeId: e.target.value || null })}>
                          <option value="">Normal</option>
                          {catalog!.paperTypes.map((p) => <option key={p.id} value={p.id}>{p.name}{p.surchargePerSheetPaise ? ` (+${inr(p.surchargePerSheetPaise)}/sheet)` : ""}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                  {(d.pageCount ?? 1) > 1 && (
                    <div>
                      <Seg label="Pages / Panne" value={c.pageMode} onChange={(v) => setCfg(d.serverId!, { pageMode: v })} options={[{ v: "all", l: `All (${d.pageCount})` }, { v: "custom", l: "Select pages" }]} />
                      {c.pageMode === "custom" && (
                        <input className="input mt-2" placeholder="e.g. 1-3,7,10-12" value={c.pageRanges} onChange={(e) => setCfg(d.serverId!, { pageRanges: e.target.value })} aria-label="Page ranges" />
                      )}
                    </div>
                  )}
                  {perDocServices.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {perDocServices.map((s) => {
                        const on = c.serviceCodes.includes(s.code);
                        return (
                          <button key={s.code} type="button" aria-pressed={on} onClick={() => setCfg(d.serverId!, { serviceCodes: on ? c.serviceCodes.filter((x) => x !== s.code) : [...c.serviceCodes, s.code] })}
                            className={`rounded-full border px-3 py-1.5 text-sm ${on ? "border-brand-600 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600"}`}>
                            {on ? "✓ " : ""}{s.name} · {inr(s.amountPaise)}{s.unit === "PER_COPY" ? "/copy" : ""}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <input className="input" maxLength={500} placeholder="Instructions (optional) / Koi nirdesh" value={c.instructions} onChange={(e) => setCfg(d.serverId!, { instructions: e.target.value })} />
                  {itemErrors[d.serverId] && <p className="text-sm text-red-600" role="alert">{itemErrors[d.serverId]}</p>}
                  {qi && (
                    <p className="text-xs text-slate-500">{qi.pagesSelected} of {qi.pagesTotal} pages × {c.copies} = {qi.printedSides} printed side{qi.printedSides > 1 ? "s" : ""}, {qi.totalSheets} sheet{qi.totalSheets > 1 ? "s" : ""}</p>
                  )}
                </div>
              )}
            </article>
          );
        })}

        {ready.length > 0 && (
          <div className="card space-y-3">
            <h2 className="font-semibold">2. Your details / Aapki jaankari</h2>
            <div>
              <label className="label" htmlFor="cust-name">Name / Naam *</label>
              <input id="cust-name" className="input" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </div>
            <div>
              <label className="label" htmlFor="cust-phone">Mobile (optional)</label>
              <input id="cust-phone" className="input" inputMode="numeric" maxLength={10} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} autoComplete="tel-national" />
            </div>
            {perOrderServices.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {perOrderServices.map((s) => {
                  const on = orderServices.includes(s.code);
                  return (
                    <button key={s.code} type="button" aria-pressed={on} onClick={() => setOrderServices(on ? orderServices.filter((x) => x !== s.code) : [...orderServices, s.code])}
                      className={`rounded-full border px-3 py-1.5 text-sm ${on ? "border-brand-600 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600"}`}>
                      {on ? "✓ " : ""}{s.name} · {inr(s.amountPaise)}
                    </button>
                  );
                })}
              </div>
            )}
            <textarea className="input" rows={2} maxLength={1000} placeholder="Note for the shop (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        )}

        {quote && (
          <div className="card" data-testid="summary">
            <h2 className="mb-2 font-semibold">3. Summary / Hisaab</h2>
            <table className="w-full text-sm">
              <tbody>
                {quote.items.map((q) => (
                  <tr key={q.fileId} className="border-b last:border-0">
                    <td className="py-2 pr-2"><div className="max-w-[14rem] truncate">{q.name}</div><div className="text-xs text-slate-500">{q.pagesSelected} pages · {q.totalSheets} sheets</div></td>
                    <td className="py-2 text-right font-medium">{inr(q.totalPaise)}</td>
                  </tr>
                ))}
                {quote.orderServiceLines.map((l) => (<tr key={l.label}><td className="py-1">{l.label}</td><td className="py-1 text-right">{inr(l.amountPaise)}</td></tr>))}
                {quote.adjustmentPaise > 0 && <tr><td className="py-1">Minimum order</td><td className="py-1 text-right">{inr(quote.adjustmentPaise)}</td></tr>}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-slate-500">Estimate. Submit ke baad dukaan ke UPI QR se pay karein ya counter par cash dein. Final amount shop confirm karta hai.</p>
          </div>
        )}
        {quoteError && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">{quoteError}</p>}
      </section>

      <div className="fixed inset-x-0 bottom-0 border-t bg-white/95 p-4 backdrop-blur">
        <div className="mx-auto flex max-w-xl items-center gap-3">
          <div className="flex-1">
            <p className="text-xs text-slate-500">Total / Kul</p>
            <p className="text-2xl font-bold" data-testid="total">{quote ? inr(quote.totalPaise) : "—"}</p>
          </div>
          <button type="button" className="btn-primary px-6 py-4 text-base" disabled={!quote || busy || submitting || ready.length === 0} onClick={submit} data-testid="submit">
            {submitting ? "Sending…" : busy ? "Uploading…" : "Submit / Bhejein"}
          </button>
        </div>
      </div>
    </main>
  );
}
