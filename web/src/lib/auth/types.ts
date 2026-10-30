export type StaffRole = "OWNER" | "ADMIN" | "STAFF";
export interface Staff { userId: string; email: string; fullName: string; role: StaffRole }
export interface AuthResolver {
  /** Resolves the signed-in, ACTIVE staff member for this request, or null. */
  getStaff(req: Request): Promise<Staff | null>;
}
export const ROLE_RANK: Record<StaffRole, number> = { STAFF: 1, ADMIN: 2, OWNER: 3 };
export function hasRole(staff: Staff, min: StaffRole): boolean {
  return ROLE_RANK[staff.role] >= ROLE_RANK[min];
}
