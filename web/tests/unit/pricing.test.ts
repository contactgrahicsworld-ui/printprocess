import { describe, expect, it } from "vitest";
import { formatINR, mulDivRound, quoteItem, quoteOrder, type ItemInput, type PriceConfig } from "@/lib/pricing/engine";

const cfg: PriceConfig = {
  bwSingleSidePaise: 200, bwDoubleSidePaise: 150, colorSingleSidePaise: 1000, colorDoubleSidePaise: 900, minOrderPaise: 0,
  sizes: { A4: { multiplierBp: 10000, enabled: true }, A3: { multiplierBp: 20000, enabled: true }, LEGAL: { multiplierBp: 12500, enabled: true } },
  paperTypes: [
    { id: "11111111-1111-1111-1111-111111111111", name: "Bond", surchargePerSheetPaise: 100, active: true },
    { id: "22222222-2222-2222-2222-222222222222", name: "Old", surchargePerSheetPaise: 50, active: false },
  ],
  services: [
    { code: "STAPLE", name: "Stapling", unit: "PER_COPY", amountPaise: 200, active: true },
    { code: "SPIRAL", name: "Spiral", unit: "PER_DOCUMENT", amountPaise: 3000, active: true },
    { code: "URGENT", name: "Urgent", unit: "PER_ORDER", amountPaise: 2000, active: true },
    { code: "OFF", name: "Disabled", unit: "PER_ORDER", amountPaise: 1, active: false },
  ],
};
const base: ItemInput = { pageCount: 10, isImage: false, colorMode: "BW", duplex: "SINGLE", paperSize: "A4", copies: 1, pageRanges: null, paperTypeId: null, serviceCodes: [] };

describe("price engine", () => {
  it("BW single A4: 10 pages × ₹2", () => {
    const q = quoteItem(cfg, base);
    expect(q.totalPaise).toBe(2000);
    expect(q.printedSides).toBe(10);
    expect(q.totalSheets).toBe(10);
  });
  it("BW duplex uses per-side double rate on printed sides (odd pages: blank back not charged)", () => {
    const q = quoteItem(cfg, { ...base, pageCount: 5, duplex: "DOUBLE" });
    expect(q.sideRatePaise).toBe(150);
    expect(q.printedSides).toBe(5);
    expect(q.totalSheets).toBe(3);
    expect(q.totalPaise).toBe(750);
  });
  it("colour A3 applies size multiplier", () => {
    const q = quoteItem(cfg, { ...base, pageCount: 2, colorMode: "COLOR", paperSize: "A3" });
    expect(q.sideRatePaise).toBe(2000);
    expect(q.totalPaise).toBe(4000);
  });
  it("legal multiplier 1.25 with half-up rounding", () => {
    const c2 = { ...cfg, bwDoubleSidePaise: 150 };
    expect(quoteItem(c2, { ...base, paperSize: "LEGAL", duplex: "DOUBLE", pageCount: 1 }).sideRatePaise).toBe(188); // 187.5 -> 188
    expect(mulDivRound(5, 1, 2)).toBe(3);
    expect(mulDivRound(4, 1, 3)).toBe(1);
    expect(mulDivRound(0, 12345, 10000)).toBe(0);
  });
  it("page range + duplex + copies + paper type + per-copy and per-document services", () => {
    const q = quoteItem(cfg, {
      ...base, pageCount: 12, pageRanges: "1-3,7,10-12", duplex: "DOUBLE", copies: 2,
      paperTypeId: "11111111-1111-1111-1111-111111111111", serviceCodes: ["STAPLE", "SPIRAL", "STAPLE"],
    });
    // 7 pages, duplex → 4 sheets/copy, 8 sheets, 14 sides
    expect(q.pagesSelected).toBe(7);
    expect(q.normalizedRanges).toBe("1-3,7,10-12");
    expect(q.lines.map((l) => l.amountPaise)).toEqual([14 * 150, 8 * 100, 2 * 200, 3000]);
    expect(q.totalPaise).toBe(2100 + 800 + 400 + 3000);
  });
  it("image counts as one page; page selection other than 1 is rejected", () => {
    expect(quoteItem(cfg, { ...base, isImage: true, pageCount: 1, copies: 3 }).totalPaise).toBe(600);
    expect(() => quoteItem(cfg, { ...base, isImage: true, pageCount: 1, pageRanges: "1-2" })).toThrow(/single page/);
  });
  it("rejects invalid copies, disabled size, inactive paper type, unknown or wrong-unit services", () => {
    expect(() => quoteItem(cfg, { ...base, copies: 0 })).toThrow(/Copies/);
    expect(() => quoteItem(cfg, { ...base, copies: 501 })).toThrow(/Copies/);
    expect(() => quoteItem(cfg, { ...base, copies: 1.5 })).toThrow(/Copies/);
    expect(() => quoteItem({ ...cfg, sizes: { ...cfg.sizes, A3: { multiplierBp: 20000, enabled: false } } }, { ...base, paperSize: "A3" })).toThrow(/not available/);
    expect(() => quoteItem(cfg, { ...base, paperTypeId: "22222222-2222-2222-2222-222222222222" })).toThrow(/paper type/);
    expect(() => quoteItem(cfg, { ...base, serviceCodes: ["NOPE"] })).toThrow(/Service/);
    expect(() => quoteItem(cfg, { ...base, serviceCodes: ["URGENT"] })).toThrow(/Service/);
    expect(() => quoteItem(cfg, { ...base, pageRanges: "11" })).toThrow(/does not exist/);
  });
  it("order: sums items, adds PER_ORDER services once, rejects per-document codes at order level", () => {
    const q = quoteOrder(cfg, [base, { ...base, pageCount: 3, colorMode: "COLOR" }], ["URGENT", "URGENT"]);
    expect(q.itemsTotalPaise).toBe(2000 + 3000);
    expect(q.servicesTotalPaise).toBe(2000);
    expect(q.totalPaise).toBe(7000);
    expect(() => quoteOrder(cfg, [base], ["STAPLE"])).toThrow();
    expect(() => quoteOrder(cfg, [base], ["OFF"])).toThrow();
    expect(() => quoteOrder(cfg, [], [])).toThrow(/at least one/);
  });
  it("minimum order adjustment", () => {
    const q = quoteOrder({ ...cfg, minOrderPaise: 1000 }, [{ ...base, pageCount: 1 }], []);
    expect(q.adjustmentPaise).toBe(800);
    expect(q.totalPaise).toBe(1000);
  });
  it("money is always an integer", () => {
    const q = quoteOrder({ ...cfg, sizes: { ...cfg.sizes, LEGAL: { multiplierBp: 13333, enabled: true } } }, [{ ...base, paperSize: "LEGAL", copies: 7, pageCount: 9 }], []);
    expect(Number.isInteger(q.totalPaise)).toBe(true);
  });
  it("formats en-IN rupees", () => {
    expect(formatINR(12345678)).toBe("₹1,23,456.78");
  });
});
