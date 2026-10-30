import { describe, expect, it } from 'vitest';
import { buildPrintSettings, buildSumatraArgs, SettingsError } from '../src/sumatra.js';
import { PageRangeError } from '../src/pageRanges.js';
import type { JobSettings } from '../src/types.js';

const base: JobSettings = { colorMode: 'BW', duplex: 'SINGLE', paperSize: 'A4', copies: 1, pageRanges: null };

describe('SumatraPDF -print-settings builder', () => {
  const cases: Array<[Partial<JobSettings>, string]> = [
    [{}, '1x,simplex,monochrome,paper=A4'],
    [{ colorMode: 'COLOR' }, '1x,simplex,color,paper=A4'],
    [{ duplex: 'DOUBLE' }, '1x,duplexlong,monochrome,paper=A4'],
    [{ paperSize: 'A3' }, '1x,simplex,monochrome,paper=A3'],
    [{ paperSize: 'LEGAL' }, '1x,simplex,monochrome,paper=legal'],
    [{ copies: 2 }, '2x,simplex,monochrome,paper=A4'],
    [{ copies: 25, colorMode: 'COLOR', duplex: 'DOUBLE', paperSize: 'A3' }, '25x,duplexlong,color,paper=A3'],
    [{ pageRanges: '1-3,7' }, '1-3,7,1x,simplex,monochrome,paper=A4'],
    [{ pageRanges: ' 2 - 4 , 6 ' }, '2-4,6,1x,simplex,monochrome,paper=A4'],
    [{ pageRanges: '5' }, '5,1x,simplex,monochrome,paper=A4'],
    [{ pageRanges: '3-3' }, '3,1x,simplex,monochrome,paper=A4'],
    [{ pageRanges: '' }, '1x,simplex,monochrome,paper=A4'],
    [{ pageRanges: 'all' }, '1x,simplex,monochrome,paper=A4'],
    [{ pageRanges: '3-5,1-4' }, '1-5,1x,simplex,monochrome,paper=A4'],
    [{ pageRanges: '9,8,1-2,2' }, '1-2,8-9,1x,simplex,monochrome,paper=A4'],
    [{ pageRanges: '1\u20133' }, '1-3,1x,simplex,monochrome,paper=A4'],
    [{ pageRanges: '1-10,12,15-20', copies: 3, duplex: 'DOUBLE', colorMode: 'COLOR', paperSize: 'LEGAL' }, '1-10,12,15-20,3x,duplexlong,color,paper=legal'],
  ];
  for (const [s, expected] of cases) {
    it(`${JSON.stringify(s)} → ${expected}`, () => {
      expect(buildPrintSettings({ ...base, ...s })).toBe(expected);
    });
  }

  it('scaling option is appended', () => {
    expect(buildPrintSettings(base, { scaling: 'shrink' })).toBe('1x,simplex,monochrome,paper=A4,shrink');
    expect(buildPrintSettings(base, { scaling: 'fit' })).toBe('1x,simplex,monochrome,paper=A4,fit');
    expect(buildPrintSettings(base, { scaling: null })).toBe('1x,simplex,monochrome,paper=A4');
  });

  it('page ranges are ignored for images (single-page PDF)', () => {
    expect(buildPrintSettings({ ...base, pageRanges: '1' }, { isImage: true })).toBe('1x,simplex,monochrome,paper=A4');
  });

  it('full colour/duplex/paper/copies matrix produces well-formed strings', () => {
    for (const colorMode of ['BW', 'COLOR'] as const)
      for (const duplex of ['SINGLE', 'DOUBLE'] as const)
        for (const paperSize of ['A4', 'A3', 'LEGAL'] as const)
          for (const copies of [1, 2, 99]) {
            const s = buildPrintSettings({ colorMode, duplex, paperSize, copies, pageRanges: '1-2' });
            expect(s).toMatch(/^1-2,\d+x,(duplexlong|simplex),(color|monochrome),paper=(A4|A3|legal)$/);
            expect(s).toContain(colorMode === 'COLOR' ? ',color,' : ',monochrome,');
            expect(s).toContain(duplex === 'DOUBLE' ? 'duplexlong' : 'simplex');
          }
  });

  it('rejects invalid input instead of guessing', () => {
    expect(() => buildPrintSettings({ ...base, copies: 0 })).toThrow(SettingsError);
    expect(() => buildPrintSettings({ ...base, copies: 1.5 })).toThrow(SettingsError);
    expect(() => buildPrintSettings({ ...base, copies: 1000 })).toThrow(SettingsError);
    expect(() => buildPrintSettings({ ...base, paperSize: 'A5' as never })).toThrow(SettingsError);
    expect(() => buildPrintSettings({ ...base, colorMode: 'GRAY' as never })).toThrow(SettingsError);
    expect(() => buildPrintSettings({ ...base, duplex: 'SHORT' as never })).toThrow(SettingsError);
    expect(() => buildPrintSettings({ ...base, pageRanges: '3-1' })).toThrow(PageRangeError);
    expect(() => buildPrintSettings({ ...base, pageRanges: '0-2' })).toThrow(PageRangeError);
    expect(() => buildPrintSettings({ ...base, pageRanges: 'odd' })).toThrow(PageRangeError);
    expect(() => buildPrintSettings({ ...base, pageRanges: '1;2' })).toThrow(PageRangeError);
  });

  it('argv has no shell quoting and keeps printer names with spaces intact', () => {
    expect(buildSumatraArgs('HP LaserJet M1136 MFP', '1x,simplex,monochrome,paper=A4', 'C:\\ProgramData\\MansaPrintAgent\\tmp\\j-1\\MP_MP-1_j.pdf')).toEqual([
      '-print-to',
      'HP LaserJet M1136 MFP',
      '-print-settings',
      '1x,simplex,monochrome,paper=A4',
      '-silent',
      '-exit-when-done',
      'C:\\ProgramData\\MansaPrintAgent\\tmp\\j-1\\MP_MP-1_j.pdf',
    ]);
  });
});
