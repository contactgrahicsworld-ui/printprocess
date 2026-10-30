import type { AppContext } from "@/lib/context";
import { audit } from "./audit";
import { loadShopSettings } from "./settings";

/**
 * Deletes stored customer files older than shop_settings.retention_days and marks them PURGED.
 * Files of orders still in progress (RECEIVED..READY) are kept; files from abandoned sessions are purged after 24 h.
 */
export async function runRetention(ctx: AppContext) {
  const shop = await loadShopSettings(ctx.db);
  const now = ctx.now().getTime();
  const cutoff = new Date(now - shop.retentionDays * 86_400_000);
  const abandonedCutoff = new Date(now - 86_400_000);
  const rows = await ctx.db.query<{ id: string; storage_path: string }>(
    `select f.id, f.storage_path from uploaded_files f
       left join order_items i on i.file_id = f.id left join orders o on o.id = i.order_id
      where f.status <> 'PURGED' and (
            (o.id is not null and f.created_at < $1 and o.status in ('DELIVERED','CANCELLED'))
         or (o.id is null and f.created_at < $2))
      limit 500`, [cutoff, abandonedCutoff]);
  let purged = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    await ctx.storage.remove(batch.map((r) => r.storage_path));
    for (const r of batch) {
      await ctx.db.query("update uploaded_files set status = 'PURGED', purged_at = now() where id = $1", [r.id]);
      purged++;
    }
  }
  await ctx.db.query("update upload_sessions set status = 'EXPIRED' where status = 'OPEN' and expires_at < $1", [new Date(now)]);
  await ctx.db.query("delete from agent_nonces where created_at < $1", [new Date(now - 10 * 60_000)]);
  await ctx.db.query("delete from rate_limits where window_start < $1", [new Date(now - 86_400_000)]);
  await audit(ctx.db, null, "retention.run", "system", null, { purged, retentionDays: shop.retentionDays });
  return { purged, retentionDays: shop.retentionDays, more: rows.length === 500 };
}
