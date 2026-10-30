/**
 * Page ranges + CONTRACT.md sheet calculation (shared rule with the print agent).
 *
 * pages_selected = count of pages in ranges (or total pages); images = 1 page each.
 * sheets_per_copy = duplex DOUBLE ? ceil(pages_selected/2) : pages_selected
 * total_sheets = sheets_per_copy * copies
 * printed_sides = pages_selected * copies
 */
export type DuplexMode = "SINGLE" | "DOUBLE";

export const MAX_RANGE_INPUT = 200;
export const MAX_RANGE_TOKENS = 100;

export type RangeResult =
  | { ok: true; pages: number[]; normalized: string | null; count: number }
  | { ok: false; error: string };

/**
 * Parse a customer page-range string such as "1-3,7,10-12" against the real page count.
 * Empty / "all" means all pages (normalized = null). Overlaps and duplicates are merged,
 * the result is sorted and stored in normalized form so what we charge is exactly what prints.
 */
export function parsePageRanges(input: string | null | undefined, pageCount: number): RangeResult {
  if (!Number.isInteger(pageCount) || pageCount < 1) return { ok: false, error: "Invalid document page count" };
  const raw = (input ?? "").trim();
  if (raw === "" || raw.toLowerCase() === "all") {
    return { ok: true, pages: range(1, pageCount), normalized: null, count: pageCount };
  }
  if (raw.length > MAX_RANGE_INPUT) return { ok: false, error: "Page range is too long" };
  const compact = raw.replace(/\s+/g, "").replace(/[–—]/g, "-");
  const parts = compact.split(",");
  if (parts.length > MAX_RANGE_TOKENS) return { ok: false, error: "Too many page ranges" };
  const set = new Set<number>();
  for (const part of parts) {
    if (part === "") return { ok: false, error: "Empty entry in page range (check commas)" };
    const m = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(part);
    if (!m) return { ok: false, error: `Invalid page range "${part}". Use format like 1-3,7` };
    const from = Number(m[1]);
    const to = m[2] !== undefined ? Number(m[2]) : from;
    if (from < 1 || to < 1) return { ok: false, error: "Page numbers start at 1" };
    if (to < from) return { ok: false, error: `Range "${part}" is backwards` };
    if (to > pageCount) {
      return { ok: false, error: `Page ${to} does not exist — document has ${pageCount} page${pageCount === 1 ? "" : "s"}` };
    }
    for (let p = from; p <= to; p++) set.add(p);
  }
  const pages = [...set].sort((a, b) => a - b);
  if (pages.length === pageCount) return { ok: true, pages, normalized: null, count: pageCount };
  return { ok: true, pages, normalized: formatRanges(pages), count: pages.length };
}

export function formatRanges(sortedPages: readonly number[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < sortedPages.length) {
    const start = sortedPages[i]!;
    let end = start;
    while (i + 1 < sortedPages.length && sortedPages[i + 1] === end + 1) {
      i++;
      end = sortedPages[i]!;
    }
    out.push(start === end ? String(start) : `${start}-${end}`);
    i++;
  }
  return out.join(",");
}

export interface SheetCalc {
  pagesSelected: number;
  sheetsPerCopy: number;
  totalSheets: number;
  printedSides: number;
}

export function calcSheets(pagesSelected: number, duplex: DuplexMode, copies: number): SheetCalc {
  if (!Number.isInteger(pagesSelected) || pagesSelected < 1) throw new RangeError("pagesSelected must be a positive integer");
  if (!Number.isInteger(copies) || copies < 1) throw new RangeError("copies must be a positive integer");
  const sheetsPerCopy = duplex === "DOUBLE" ? Math.ceil(pagesSelected / 2) : pagesSelected;
  return { pagesSelected, sheetsPerCopy, totalSheets: sheetsPerCopy * copies, printedSides: pagesSelected * copies };
}

function range(a: number, b: number): number[] {
  const r: number[] = [];
  for (let i = a; i <= b; i++) r.push(i);
  return r;
}
