import type { AppContext } from "@/lib/context";
import { hasRole, type Staff, type StaffRole } from "@/lib/auth/types";
import { assertSameOrigin, HttpError } from "./respond";

/** Cookie-authenticated staff guard: CSRF origin check for mutations + active staff + minimum role. */
export async function requireStaff(ctx: AppContext, req: Request, min: StaffRole = "STAFF"): Promise<Staff> {
  assertSameOrigin(req, ctx.config.APP_URL);
  const staff = await ctx.auth.getStaff(req);
  if (!staff) throw new HttpError(401, "UNAUTHENTICATED", "Please sign in");
  if (!hasRole(staff, min)) throw new HttpError(403, "FORBIDDEN", `Requires ${min} role`);
  return staff;
}

export function uuidParam(v: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new HttpError(404, "NOT_FOUND", "Not found");
  return v;
}
