"use client";
import { useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "./supabase";

/**
 * Calls onChange whenever one of the tables changes (Supabase Realtime postgres_changes, RLS-filtered for staff),
 * plus a slow polling fallback so the dashboard stays correct even if the socket drops.
 */
export function useLive(tables: string[], onChange: () => void, realtime: boolean, pollMs = 15000) {
  const cb = useRef(onChange);
  useEffect(() => { cb.current = onChange; }, [onChange]);
  const key = tables.join(",");
  useEffect(() => {
    const poll = setInterval(() => { if (document.visibilityState === "visible") cb.current(); }, pollMs);
    const sb = realtime ? supabaseBrowser() : null;
    let channel: ReturnType<NonNullable<typeof sb>["channel"]> | null = null;
    if (sb) {
      channel = sb.channel(`admin-live-${key}`);
      for (const t of key.split(",")) channel.on("postgres_changes", { event: "*", schema: "public", table: t }, () => cb.current());
      channel.subscribe();
    }
    return () => { clearInterval(poll); if (sb && channel) void sb.removeChannel(channel); };
  }, [key, realtime, pollMs]);
}

/** Current time, refreshed every `ms` (keeps render pure: no Date.now() during render). */
export function useNow(ms = 15000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
