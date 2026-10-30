import { z } from "zod";
import type { Db } from "@/lib/db/types";
import type { PaperSize, PriceConfig, ServiceUnit } from "@/lib/pricing/engine";

export interface ShopSettings {
  shopName: string;
  address: string;
  phone: string | null;
  gstin: string | null;
  upiId: string | null;
  upiPayeeName: string | null;
  maxFileBytes: number;
  maxFiles: number;
  sessionTtlMinutes: number;
  retentionDays: number;
}

export async function loadShopSettings(db: Db): Promise<ShopSettings> {
  const r = (await db.query<Record<string, unknown>>("select * from shop_settings where id = 1"))[0];
  if (!r) throw new Error("shop_settings row missing (run migrations/seed)");
  return {
    shopName: r.shop_name as string,
    address: r.address as string,
    phone: (r.phone as string | null) ?? null,
    gstin: (r.gstin as string | null) ?? null,
    upiId: (r.upi_id as string | null) ?? null,
    upiPayeeName: (r.upi_payee_name as string | null) ?? null,
    maxFileBytes: Number(r.max_file_bytes),
    maxFiles: Number(r.max_files),
    sessionTtlMinutes: Number(r.session_ttl_minutes),
    retentionDays: Number(r.retention_days),
  };
}

export async function loadPriceConfig(db: Db): Promise<PriceConfig> {
  const p = (await db.query<Record<string, number>>("select * from price_settings where id = 1"))[0];
  if (!p) throw new Error("price_settings row missing (run migrations/seed)");
  const sizes = await db.query<{ paper_size: PaperSize; multiplier_bp: number; enabled: boolean }>("select * from paper_size_rates");
  const paperTypes = await db.query<{ id: string; name: string; surcharge_per_sheet_paise: number; active: boolean }>(
    "select id, name, surcharge_per_sheet_paise, active from paper_types order by sort_order, name");
  const services = await db.query<{ code: string; name: string; unit: ServiceUnit; amount_paise: number; active: boolean }>(
    "select code, name, unit, amount_paise, active from services order by sort_order, name");
  const sizeMap = { A4: { multiplierBp: 10000, enabled: false }, A3: { multiplierBp: 10000, enabled: false }, LEGAL: { multiplierBp: 10000, enabled: false } } as PriceConfig["sizes"];
  for (const s of sizes) sizeMap[s.paper_size] = { multiplierBp: Number(s.multiplier_bp), enabled: s.enabled };
  return {
    bwSingleSidePaise: Number(p.bw_single_side_paise),
    bwDoubleSidePaise: Number(p.bw_double_side_paise),
    colorSingleSidePaise: Number(p.color_single_side_paise),
    colorDoubleSidePaise: Number(p.color_double_side_paise),
    minOrderPaise: Number(p.min_order_paise),
    sizes: sizeMap,
    paperTypes: paperTypes.map((t) => ({ id: t.id, name: t.name, surchargePerSheetPaise: Number(t.surcharge_per_sheet_paise), active: t.active })),
    services: services.map((s) => ({ code: s.code, name: s.name, unit: s.unit, amountPaise: Number(s.amount_paise), active: s.active })),
  };
}

/** Public catalogue shown to customers (only active / enabled entries, with prices). */
export function publicCatalog(cfg: PriceConfig) {
  return {
    rates: {
      bwSingleSidePaise: cfg.bwSingleSidePaise, bwDoubleSidePaise: cfg.bwDoubleSidePaise,
      colorSingleSidePaise: cfg.colorSingleSidePaise, colorDoubleSidePaise: cfg.colorDoubleSidePaise,
      minOrderPaise: cfg.minOrderPaise,
    },
    paperSizes: (Object.entries(cfg.sizes) as [PaperSize, { multiplierBp: number; enabled: boolean }][])
      .filter(([, v]) => v.enabled).map(([k, v]) => ({ size: k, multiplierBp: v.multiplierBp })),
    paperTypes: cfg.paperTypes.filter((p) => p.active).map(({ id, name, surchargePerSheetPaise }) => ({ id, name, surchargePerSheetPaise })),
    services: cfg.services.filter((s) => s.active).map(({ code, name, unit, amountPaise }) => ({ code, name, unit, amountPaise })),
  };
}
export type PublicCatalog = ReturnType<typeof publicCatalog>;

const paise = z.number().int().min(0).max(10_000_000);
export const priceSettingsSchema = z.object({
  bwSingleSidePaise: paise, bwDoubleSidePaise: paise, colorSingleSidePaise: paise, colorDoubleSidePaise: paise, minOrderPaise: paise,
  sizes: z.object({
    A4: z.object({ multiplierBp: z.number().int().min(1).max(1_000_000), enabled: z.boolean() }),
    A3: z.object({ multiplierBp: z.number().int().min(1).max(1_000_000), enabled: z.boolean() }),
    LEGAL: z.object({ multiplierBp: z.number().int().min(1).max(1_000_000), enabled: z.boolean() }),
  }),
});

export const shopSettingsSchema = z.object({
  shopName: z.string().trim().min(1).max(120),
  address: z.string().trim().min(1).max(300),
  phone: z.string().trim().max(20).nullable(),
  gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z0-9]{13}$/, "GSTIN must be 15 characters").nullable(),
  upiId: z.string().trim().regex(/^[A-Za-z0-9._-]{2,255}@[A-Za-z0-9.-]{2,64}$/, "Invalid UPI ID").nullable(),
  upiPayeeName: z.string().trim().max(100).nullable(),
  maxFileBytes: z.number().int().min(1024).max(52428800),
  maxFiles: z.number().int().min(1).max(50),
  sessionTtlMinutes: z.number().int().min(10).max(1440),
  retentionDays: z.number().int().min(1).max(365),
});

export const paperTypeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  surchargePerSheetPaise: paise,
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

export const serviceSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,32}$/),
  name: z.string().trim().min(1).max(80),
  unit: z.enum(["PER_ORDER", "PER_DOCUMENT", "PER_COPY"]),
  amountPaise: paise,
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
