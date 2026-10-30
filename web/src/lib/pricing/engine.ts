/**
 * Server-side price engine. All amounts are integer paise. See docs/PRICING.md.
 *
 * side_rate      = round_half_up( base_rate[colorMode][duplex] * size_multiplier_bp / 10000 )
 * print_charge   = side_rate * printed_sides
 * paper_charge   = paper_type.surcharge_per_sheet * total_sheets
 * item_services  = Σ PER_DOCUMENT amount + Σ PER_COPY amount * copies   (selected on the item)
 * item_total     = print_charge + paper_charge + item_services
 * order_services = Σ PER_ORDER amount                                   (selected on the order)
 * subtotal       = Σ item_total + order_services
 * total          = max(subtotal, min_order)   (min_order_adjustment line if applied)
 */
import { calcSheets, type DuplexMode, parsePageRanges } from "@/lib/print/pages";

export type ColorMode = "BW" | "COLOR";
export type PaperSize = "A4" | "A3" | "LEGAL";
export type ServiceUnit = "PER_ORDER" | "PER_DOCUMENT" | "PER_COPY";

export interface PriceConfig {
  bwSingleSidePaise: number;
  bwDoubleSidePaise: number;
  colorSingleSidePaise: number;
  colorDoubleSidePaise: number;
  minOrderPaise: number;
  sizes: Record<PaperSize, { multiplierBp: number; enabled: boolean }>;
  paperTypes: { id: string; name: string; surchargePerSheetPaise: number; active: boolean }[];
  services: { code: string; name: string; unit: ServiceUnit; amountPaise: number; active: boolean }[];
}

export interface ItemInput {
  pageCount: number;
  isImage: boolean;
  colorMode: ColorMode;
  duplex: DuplexMode;
  paperSize: PaperSize;
  copies: number;
  pageRanges: string | null;
  paperTypeId: string | null;
  serviceCodes: string[];
}

export interface PriceLine {
  label: string;
  qty: number;
  unitPaise: number;
  amountPaise: number;
}

export interface ItemQuote {
  pagesTotal: number;
  pagesSelected: number;
  normalizedRanges: string | null;
  sheetsPerCopy: number;
  totalSheets: number;
  printedSides: number;
  sideRatePaise: number;
  lines: PriceLine[];
  totalPaise: number;
}

export interface OrderQuote {
  items: ItemQuote[];
  orderServiceLines: PriceLine[];
  itemsTotalPaise: number;
  servicesTotalPaise: number;
  adjustmentPaise: number;
  totalPaise: number;
}

export class PricingError extends Error {
  constructor(public readonly itemIndex: number | null, message: string) {
    super(message);
  }
}

export const MAX_COPIES = 500;

/** Integer round-half-up of a*b/c for non-negative integers. */
export function mulDivRound(a: number, b: number, c: number): number {
  const big = (BigInt(a) * BigInt(b) * 2n + BigInt(c)) / (2n * BigInt(c));
  return Number(big);
}

export function baseRate(cfg: PriceConfig, colorMode: ColorMode, duplex: DuplexMode): number {
  if (colorMode === "BW") return duplex === "DOUBLE" ? cfg.bwDoubleSidePaise : cfg.bwSingleSidePaise;
  return duplex === "DOUBLE" ? cfg.colorDoubleSidePaise : cfg.colorSingleSidePaise;
}

export function quoteItem(cfg: PriceConfig, input: ItemInput, index = 0): ItemQuote {
  if (!Number.isInteger(input.copies) || input.copies < 1 || input.copies > MAX_COPIES) {
    throw new PricingError(index, `Copies must be between 1 and ${MAX_COPIES}`);
  }
  const size = cfg.sizes[input.paperSize];
  if (!size || !size.enabled) throw new PricingError(index, `Paper size ${input.paperSize} is not available`);
  const pagesTotal = input.isImage ? 1 : input.pageCount;
  if (input.isImage && input.pageRanges && input.pageRanges.trim() !== "" && input.pageRanges.trim() !== "1") {
    throw new PricingError(index, "Images have a single page; page selection is not allowed");
  }
  const parsed = parsePageRanges(input.isImage ? null : input.pageRanges, pagesTotal);
  if (!parsed.ok) throw new PricingError(index, parsed.error);
  const sheets = calcSheets(parsed.count, input.duplex, input.copies);

  const sideRate = mulDivRound(baseRate(cfg, input.colorMode, input.duplex), size.multiplierBp, 10000);
  const lines: PriceLine[] = [
    {
      label: `${input.colorMode === "BW" ? "B/W" : "Colour"} ${input.duplex === "DOUBLE" ? "double-side" : "single-side"} ${input.paperSize} printed sides`,
      qty: sheets.printedSides,
      unitPaise: sideRate,
      amountPaise: sideRate * sheets.printedSides,
    },
  ];

  if (input.paperTypeId) {
    const pt = cfg.paperTypes.find((p) => p.id === input.paperTypeId && p.active);
    if (!pt) throw new PricingError(index, "Selected paper type is not available");
    if (pt.surchargePerSheetPaise > 0) {
      lines.push({ label: `Paper: ${pt.name} (per sheet)`, qty: sheets.totalSheets, unitPaise: pt.surchargePerSheetPaise, amountPaise: pt.surchargePerSheetPaise * sheets.totalSheets });
    }
  }

  const seen = new Set<string>();
  for (const code of input.serviceCodes) {
    if (seen.has(code)) continue;
    seen.add(code);
    const svc = cfg.services.find((s) => s.code === code && s.active);
    if (!svc || svc.unit === "PER_ORDER") throw new PricingError(index, `Service ${code} is not available for a document`);
    const qty = svc.unit === "PER_COPY" ? input.copies : 1;
    lines.push({ label: svc.name, qty, unitPaise: svc.amountPaise, amountPaise: svc.amountPaise * qty });
  }

  const totalPaise = lines.reduce((s, l) => s + l.amountPaise, 0);
  return {
    pagesTotal,
    pagesSelected: sheets.pagesSelected,
    normalizedRanges: parsed.normalized,
    sheetsPerCopy: sheets.sheetsPerCopy,
    totalSheets: sheets.totalSheets,
    printedSides: sheets.printedSides,
    sideRatePaise: sideRate,
    lines,
    totalPaise,
  };
}

export function quoteOrder(cfg: PriceConfig, items: ItemInput[], orderServiceCodes: string[]): OrderQuote {
  if (items.length === 0) throw new PricingError(null, "Add at least one document");
  const quotes = items.map((it, i) => quoteItem(cfg, it, i));
  const orderServiceLines: PriceLine[] = [];
  for (const code of new Set(orderServiceCodes)) {
    const svc = cfg.services.find((s) => s.code === code && s.active);
    if (!svc || svc.unit !== "PER_ORDER") throw new PricingError(null, `Service ${code} is not available for an order`);
    orderServiceLines.push({ label: svc.name, qty: 1, unitPaise: svc.amountPaise, amountPaise: svc.amountPaise });
  }
  const itemsTotalPaise = quotes.reduce((s, q) => s + q.totalPaise, 0);
  const servicesTotalPaise = orderServiceLines.reduce((s, l) => s + l.amountPaise, 0);
  const subtotal = itemsTotalPaise + servicesTotalPaise;
  const adjustmentPaise = subtotal < cfg.minOrderPaise ? cfg.minOrderPaise - subtotal : 0;
  return { items: quotes, orderServiceLines, itemsTotalPaise, servicesTotalPaise, adjustmentPaise, totalPaise: subtotal + adjustmentPaise };
}

export function formatINR(paise: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(paise / 100);
}
