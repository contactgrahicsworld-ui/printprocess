import type { z } from "zod";
import type { AppContext } from "@/lib/context";
import type { Staff } from "@/lib/auth/types";
import { isUniqueViolation } from "@/lib/db/types";
import { HttpError } from "@/lib/http/respond";
import { audit } from "./audit";
import { loadPriceConfig, loadShopSettings, type paperTypeSchema, type priceSettingsSchema, type serviceSchema, type shopSettingsSchema } from "./settings";

export async function updatePrices(ctx: AppContext, staff: Staff, v: z.infer<typeof priceSettingsSchema>, ip: string) {
  return ctx.db.tx(async (tx) => {
    const before = await loadPriceConfig(tx);
    await tx.query(
      `update price_settings set bw_single_side_paise=$1, bw_double_side_paise=$2, color_single_side_paise=$3, color_double_side_paise=$4,
              min_order_paise=$5, updated_at=now(), updated_by=$6 where id = 1`,
      [v.bwSingleSidePaise, v.bwDoubleSidePaise, v.colorSingleSidePaise, v.colorDoubleSidePaise, v.minOrderPaise, staff.userId]);
    for (const size of ["A4", "A3", "LEGAL"] as const) {
      await tx.query(
        `insert into paper_size_rates (paper_size, multiplier_bp, enabled) values ($1,$2,$3)
         on conflict (paper_size) do update set multiplier_bp = excluded.multiplier_bp, enabled = excluded.enabled`,
        [size, v.sizes[size].multiplierBp, v.sizes[size].enabled]);
    }
    await audit(tx, staff, "settings.prices", "price_settings", "1", { before: { ...before, paperTypes: undefined, services: undefined }, after: v }, ip);
    return loadPriceConfig(tx);
  });
}

export async function updateShop(ctx: AppContext, staff: Staff, v: z.infer<typeof shopSettingsSchema>, ip: string) {
  return ctx.db.tx(async (tx) => {
    const before = await loadShopSettings(tx);
    await tx.query(
      `update shop_settings set shop_name=$1, address=$2, phone=$3, gstin=$4, upi_id=$5, upi_payee_name=$6, max_file_bytes=$7, max_files=$8,
              session_ttl_minutes=$9, retention_days=$10, updated_at=now(), updated_by=$11 where id = 1`,
      [v.shopName, v.address, v.phone || null, v.gstin || null, v.upiId || null, v.upiPayeeName || null, v.maxFileBytes, v.maxFiles,
        v.sessionTtlMinutes, v.retentionDays, staff.userId]);
    await audit(tx, staff, "settings.shop", "shop_settings", "1", { before, after: v }, ip);
    return loadShopSettings(tx);
  });
}

export async function upsertPaperType(ctx: AppContext, staff: Staff, id: string | null, v: z.infer<typeof paperTypeSchema>, ip: string) {
  try {
    const r = id
      ? (await ctx.db.query<{ id: string }>("update paper_types set name=$2, surcharge_per_sheet_paise=$3, active=$4, sort_order=$5 where id=$1 returning id",
          [id, v.name, v.surchargePerSheetPaise, v.active, v.sortOrder]))[0]
      : (await ctx.db.query<{ id: string }>("insert into paper_types (name, surcharge_per_sheet_paise, active, sort_order) values ($1,$2,$3,$4) returning id",
          [v.name, v.surchargePerSheetPaise, v.active, v.sortOrder]))[0];
    if (!r) throw new HttpError(404, "NOT_FOUND", "Paper type not found");
    await audit(ctx.db, staff, id ? "settings.paper_type.update" : "settings.paper_type.create", "paper_type", r.id, v, ip);
    return r;
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, "DUPLICATE", "A paper type with this name exists");
    throw e;
  }
}

export async function upsertService(ctx: AppContext, staff: Staff, id: string | null, v: z.infer<typeof serviceSchema>, ip: string) {
  try {
    const r = id
      ? (await ctx.db.query<{ id: string }>("update services set code=$2, name=$3, unit=$4, amount_paise=$5, active=$6, sort_order=$7 where id=$1 returning id",
          [id, v.code, v.name, v.unit, v.amountPaise, v.active, v.sortOrder]))[0]
      : (await ctx.db.query<{ id: string }>("insert into services (code, name, unit, amount_paise, active, sort_order) values ($1,$2,$3,$4,$5,$6) returning id",
          [v.code, v.name, v.unit, v.amountPaise, v.active, v.sortOrder]))[0];
    if (!r) throw new HttpError(404, "NOT_FOUND", "Service not found");
    await audit(ctx.db, staff, id ? "settings.service.update" : "settings.service.create", "service", r.id, v, ip);
    return r;
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, "DUPLICATE", "A service with this code exists");
    throw e;
  }
}
