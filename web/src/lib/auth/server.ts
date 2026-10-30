import { headers } from "next/headers";
import { getContext } from "@/lib/context";
import type { Staff } from "./types";

/** Resolves the signed-in staff member inside Server Components (same resolver as API routes). */
export async function getStaffForPage(): Promise<Staff | null> {
  const ctx = await getContext();
  const h = await headers();
  return ctx.auth.getStaff(new Request(ctx.config.APP_URL, { headers: h }));
}
