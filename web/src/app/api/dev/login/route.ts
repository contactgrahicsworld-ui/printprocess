import { getContext } from "@/lib/context";
import { handler, HttpError } from "@/lib/http/respond";
import { DEV_COOKIE, devCookieValue } from "@/lib/auth/dev";
import { loadActiveStaff } from "@/lib/auth/staff-lookup";

export const dynamic = "force-dynamic";

/** AUTH_DRIVER=dev only (never in production): sign in as an existing staff_profiles row for local testing. */
export const GET = handler(async (req: Request) => {
  const ctx = await getContext();
  if (ctx.config.AUTH_DRIVER !== "dev" || ctx.config.NODE_ENV === "production") throw new HttpError(404, "NOT_FOUND", "Not found");
  const userId = new URL(req.url).searchParams.get("user") ?? "";
  const staff = await loadActiveStaff(ctx.db, userId);
  if (!staff) throw new HttpError(404, "NOT_FOUND", "No such active staff user");
  return new Response(null, {
    status: 303,
    headers: { location: "/admin", "set-cookie": `${DEV_COOKIE}=${devCookieValue(ctx.config.APP_SECRET, staff.userId)}; Path=/; HttpOnly; SameSite=Lax` },
  });
});
