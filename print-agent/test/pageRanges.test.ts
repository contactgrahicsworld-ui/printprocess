import { describe, expect, it } from 'vitest';
import { calcSheets, countSelectedPages, parsePageRanges, validateRangesAgainst } from '../src/pageRanges.js';

describe('page ranges + CONTRACT sheet calculation', () => {
  it('parses and counts', () => {
    expect(parsePageRanges('1-3,7')).toEqual([{ from: 1, to: 3 }, { from: 7, to: 7 }]);
    expect(countSelectedPages(parsePageRanges('1-3,7'), 10)).toBe(4);
    expect(countSelectedPages(parsePageRanges('1-3,2-4'), 10)).toBe(4);
    expect(countSelectedPages(null, 9)).toBe(9);
    expect(validateRangesAgainst(parsePageRanges('1-3,12'), 10)).toMatch(/exceeds/);
    expect(validateRangesAgainst(parsePageRanges('1-10'), 10)).toBeNull();
  });
  it('sheets: SINGLE vs DOUBLE, odd page counts, copies', () => {
    expect(calcSheets(5, 'SINGLE', 2)).toEqual({ pagesSelected: 5, sheetsPerCopy: 5, totalSheets: 10, printedSides: 10 });
    expect(calcSheets(5, 'DOUBLE', 2)).toEqual({ pagesSelected: 5, sheetsPerCopy: 3, totalSheets: 6, printedSides: 10 });
    expect(calcSheets(4, 'DOUBLE', 1)).toEqual({ pagesSelected: 4, sheetsPerCopy: 2, totalSheets: 2, printedSides: 4 });
    expect(calcSheets(1, 'DOUBLE', 3)).toEqual({ pagesSelected: 1, sheetsPerCopy: 1, totalSheets: 3, printedSides: 3 });
  });
});
