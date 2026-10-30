import type { Db } from "@/lib/db/types";
import type { Staff } from "@/lib/auth/types";

export async function audit(
  db: Db,
  actor: Staff | null,
  action: string,
  entityType: string,
  entityId: string | null,
  detail: Record<string, unknown> = {},
  ip: string | null = null,
): Promise<void> {
  await db.query(
    "insert into audit_logs (actor, actor_role, action, entity_type, entity_id, detail, ip) values ($1, $2, $3, $4, $5, $6::jsonb, $7)",
    [actor?.userId ?? null, actor?.role ?? (actor ? null : "SYSTEM"), action, entityType, entityId, JSON.stringify(detail), ip],
  );
}
