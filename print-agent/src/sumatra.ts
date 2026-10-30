/**
 * SumatraPDF command-line construction.
 * SumatraPDF.exe -print-to "<printer>" -print-settings "<pages>,<copies>x,duplexlong|simplex,color|monochrome,paper=A4" -silent -exit-when-done <file>
 */
import type { JobSettings, PaperSize } from './types.js';
import { formatPageRanges, isAllPages, parsePageRanges } from './pageRanges.js';

export type SumatraScaling = 'noscale' | 'shrink' | 'fit';

export const SUMATRA_PAPER: Record<PaperSize, string> = {
  A4: 'A4',
  A3: 'A3',
  LEGAL: 'legal',
};

export class SettingsError extends Error {}

export function buildPrintSettings(settings: JobSettings, opts: { scaling?: SumatraScaling | null; isImage?: boolean } = {}): string {
  const parts: string[] = [];
  // Page ranges: images are rendered to a 1-page PDF, so ranges are not applied to them.
  if (!isAllPages(settings.pageRanges) && !opts.isImage) {
    parts.push(formatPageRanges(parsePageRanges(settings.pageRanges!)));
  }
  if (!Number.isInteger(settings.copies) || settings.copies < 1 || settings.copies > 999) {
    throw new SettingsError(`invalid copies ${String(settings.copies)} (1..999)`);
  }
  parts.push(`${settings.copies}x`);
  if (settings.duplex === 'DOUBLE') parts.push('duplexlong');
  else if (settings.duplex === 'SINGLE') parts.push('simplex');
  else throw new SettingsError(`invalid duplex ${String(settings.duplex)}`);
  if (settings.colorMode === 'COLOR') parts.push('color');
  else if (settings.colorMode === 'BW') parts.push('monochrome');
  else throw new SettingsError(`invalid colorMode ${String(settings.colorMode)}`);
  const paper = SUMATRA_PAPER[settings.paperSize];
  if (!paper) throw new SettingsError(`invalid paperSize ${String(settings.paperSize)}`);
  parts.push(`paper=${paper}`);
  if (opts.scaling) parts.push(opts.scaling);
  return parts.join(',');
}

/** Argument vector (no shell quoting needed: spawned without a shell). */
export function buildSumatraArgs(printerName: string, printSettings: string, filePath: string): string[] {
  if (!printerName) throw new SettingsError('printer name required');
  return ['-print-to', printerName, '-print-settings', printSettings, '-silent', '-exit-when-done', filePath];
}
