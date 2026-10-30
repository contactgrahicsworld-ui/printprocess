/**
 * Page range parsing + CONTRACT sheet calculation.
 *
 * pages_selected = count of pages in ranges (or total pages); images = 1 page each.
 * sheets_per_copy = duplex DOUBLE ? ceil(pages_selected/2) : pages_selected
 * total_sheets = sheets_per_copy * copies
 * printed_sides = pages_selected * copies
 */
import type { DuplexMode } from './types.js';

export interface PageRange {
  from: number;
  to: number;
}

export class PageRangeError extends Error {}

/** Parse "1-3,7" into ranges. Whitespace tolerated. Throws PageRangeError on invalid syntax. */
export function parsePageRanges(spec: string): PageRange[] {
  const trimmed = spec.replace(/\s+/g, '').replace(/[\u2013\u2014]/g, '-');
  if (trimmed === '') throw new PageRangeError('empty page range');
  const out: PageRange[] = [];
  for (const part of trimmed.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new PageRangeError(`invalid page range segment "${part}"`);
    const from = Number(m[1]);
    const to = m[2] !== undefined ? Number(m[2]) : from;
    if (from < 1 || to < 1) throw new PageRangeError(`page numbers start at 1 ("${part}")`);
    if (to < from) throw new PageRangeError(`descending range "${part}" not allowed`);
    out.push({ from, to });
  }
  return out;
}

/** Validate ranges against a known page count. Returns an error string or null. */
export function validateRangesAgainst(ranges: PageRange[], totalPages: number): string | null {
  for (const r of ranges) {
    if (r.to > totalPages) return `page range ${r.from}-${r.to} exceeds document page count ${totalPages}`;
  }
  return null;
}

/**
 * Canonical string for SumatraPDF: overlaps/duplicates merged and sorted, exactly like the web app
 * (web/src/lib/print/pages.ts formatRanges), so what prints is exactly what was charged.
 * "1-3,2-5,9,8" → "1-5,8-9"
 */
export function formatPageRanges(ranges: PageRange[]): string {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const merged: PageRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged.map((r) => (r.from === r.to ? String(r.from) : `${r.from}-${r.to}`)).join(',');
}

/** True for null / "" / "all" (= every page). */
export function isAllPages(spec: string | null | undefined): boolean {
  const t = (spec ?? '').trim().toLowerCase();
  return t === '' || t === 'all';
}

/** Number of distinct selected pages (overlapping ranges counted once). */
export function countSelectedPages(ranges: PageRange[] | null, totalPages: number): number {
  if (!ranges) return totalPages;
  const set = new Set<number>();
  for (const r of ranges) {
    for (let p = r.from; p <= Math.min(r.to, totalPages); p++) set.add(p);
  }
  return set.size;
}

export interface SheetCalc {
  pagesSelected: number;
  sheetsPerCopy: number;
  totalSheets: number;
  printedSides: number;
}

export function calcSheets(pagesSelected: number, duplex: DuplexMode, copies: number): SheetCalc {
  const sheetsPerCopy = duplex === 'DOUBLE' ? Math.ceil(pagesSelected / 2) : pagesSelected;
  return {
    pagesSelected,
    sheetsPerCopy,
    totalSheets: sheetsPerCopy * copies,
    printedSides: pagesSelected * copies,
  };
}
