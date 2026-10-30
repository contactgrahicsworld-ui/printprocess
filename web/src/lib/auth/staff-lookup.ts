import type { Db } from "@/lib/db/types";
import type { Staff, StaffRole } from "./types";

export async function loadActiveStaff(db: Db, userId: string): Promise<Staff | null> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const rows = await db.query<{ user_id: string; email: string; full_name: string; role: StaffRole }>(
    "select user_id, email, full_name, role from staff_profiles where user_id = $1 and active",
    [userId],
  );
  const r = rows[0];
  return r ? { userId: r.user_id, email: r.email, fullName: r.full_name, role: r.role } : null;
}
