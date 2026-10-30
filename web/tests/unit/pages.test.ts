import { describe, expect, it } from "vitest";
import { calcSheets, formatRanges, parsePageRanges } from "@/lib/print/pages";

describe("parsePageRanges", () => {
  it("parses the example 1-3,7,10-12", () => {
    const r = parsePageRanges("1-3,7,10-12", 12);
    expect(r).toEqual({ ok: true, pages: [1, 2, 3, 7, 10, 11, 12], normalized: "1-3,7,10-12", count: 7 });
  });
  it("empty / null / 'all' = all pages, normalized null", () => {
    for (const v of ["", "  ", null, undefined, "all", "ALL"]) {
      const r = parsePageRanges(v, 5);
      expect(r.ok && r.count === 5 && r.normalized === null).toBe(true);
    }
  });
  it("tolerates whitespace and en-dash", () => {
    const r = parsePageRanges(" 1 - 2 , 4–5 ", 5);
    expect(r.ok && r.normalized).toBe("1-2,4-5");
  });
  it("merges overlaps/duplicates and sorts so charge == what prints", () => {
    const r = parsePageRanges("7,1-3,2-4,3,3", 10);
    expect(r.ok && r.normalized).toBe("1-4,7");
    expect(r.ok && r.count).toBe(5);
  });
  it("selection covering every page normalizes to all (null)", () => {
    const r = parsePageRanges("1-2,3", 3);
    expect(r.ok && r.normalized).toBeNull();
  });
  it("single page document", () => {
    expect(parsePageRanges("1", 1)).toMatchObject({ ok: true, count: 1, normalized: null });
    expect(parsePageRanges("2", 1).ok).toBe(false);
  });
  it.each([
    ["0", "start at 1"],
    ["0-2", "start at 1"],
    ["3-1", "backwards"],
    ["1-13", "does not exist"],
    ["13", "does not exist"],
    ["1,,2", "Empty entry"],
    [",1", "Empty entry"],
    ["1,", "Empty entry"],
    ["a", "Invalid"],
    ["1-2-3", "Invalid"],
    ["-1", "Invalid"],
    ["1.5", "Invalid"],
    ["1;2", "Invalid"],
  ])("rejects %s", (input, msg) => {
    const r = parsePageRanges(input, 12);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(msg);
  });
  it("rejects overly long input and too many tokens", () => {
    expect(parsePageRanges("1,".repeat(150) + "1", 5).ok).toBe(false);
    expect(parsePageRanges(Array.from({ length: 101 }, () => "1").join(","), 5).ok).toBe(false);
  });
  it("rejects invalid page count", () => {
    expect(parsePageRanges("1", 0).ok).toBe(false);
  });
  it("formatRanges compresses consecutive runs", () => {
    expect(formatRanges([1, 2, 3, 5, 7, 8])).toBe("1-3,5,7-8");
    expect(formatRanges([])).toBe("");
  });
});

describe("calcSheets (CONTRACT.md)", () => {
  it("single-sided: one sheet per page", () => {
    expect(calcSheets(5, "SINGLE", 1)).toEqual({ pagesSelected: 5, sheetsPerCopy: 5, totalSheets: 5, printedSides: 5 });
  });
  it("duplex with odd pages rounds sheets up, sides unchanged", () => {
    expect(calcSheets(5, "DOUBLE", 1)).toEqual({ pagesSelected: 5, sheetsPerCopy: 3, totalSheets: 3, printedSides: 5 });
    expect(calcSheets(1, "DOUBLE", 1)).toEqual({ pagesSelected: 1, sheetsPerCopy: 1, totalSheets: 1, printedSides: 1 });
  });
  it("duplex with even pages", () => {
    expect(calcSheets(4, "DOUBLE", 1)).toMatchObject({ sheetsPerCopy: 2, totalSheets: 2, printedSides: 4 });
  });
  it("copies multiply per copy (odd duplex is per copy, not pooled)", () => {
    expect(calcSheets(5, "DOUBLE", 3)).toEqual({ pagesSelected: 5, sheetsPerCopy: 3, totalSheets: 9, printedSides: 15 });
    expect(calcSheets(7, "SINGLE", 2)).toEqual({ pagesSelected: 7, sheetsPerCopy: 7, totalSheets: 14, printedSides: 14 });
  });
  it("range + duplex + copies combined: '1-3,7,10-12' of 12 pages, duplex, 2 copies", () => {
    const r = parsePageRanges("1-3,7,10-12", 12);
    if (!r.ok) throw new Error();
    expect(calcSheets(r.count, "DOUBLE", 2)).toEqual({ pagesSelected: 7, sheetsPerCopy: 4, totalSheets: 8, printedSides: 14 });
  });
  it("rejects invalid input", () => {
    expect(() => calcSheets(0, "SINGLE", 1)).toThrow();
    expect(() => calcSheets(2, "SINGLE", 0)).toThrow();
    expect(() => calcSheets(2.5, "SINGLE", 1)).toThrow();
  });
});
