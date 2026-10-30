import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PaperSize } from './types.js';

/** Paper sizes in PDF points (portrait). */
export const PAPER_POINTS: Record<PaperSize, [number, number]> = {
  A4: [595.28, 841.89],
  A3: [841.89, 1190.55],
  LEGAL: [612, 1008],
};

/**
 * Converts a JPEG/PNG into a one-page PDF at the chosen paper size, scaled to fit
 * (never upscaled beyond the printable box) and centred. Landscape images get a landscape page.
 */
export async function imageToPdf(
  imagePath: string,
  type: 'jpeg' | 'png',
  paper: PaperSize,
  outPath: string,
  opts: { marginPt?: number; title?: string } = {},
): Promise<void> {
  const doc = await PDFDocument.create();
  const bytes = readFileSync(imagePath);
  const img = type === 'jpeg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  const [pw, ph] = PAPER_POINTS[paper];
  const landscape = img.width > img.height;
  const pageW = landscape ? ph : pw;
  const pageH = landscape ? pw : ph;
  const margin = opts.marginPt ?? 14; // ~5 mm: most printers cannot print to the edge
  const boxW = pageW - 2 * margin;
  const boxH = pageH - 2 * margin;
  const scale = Math.min(boxW / img.width, boxH / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const page = doc.addPage([pageW, pageH]);
  page.drawImage(img, { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h });
  if (opts.title) doc.setTitle(opts.title);
  doc.setProducer('Mansa Print Agent');
  writeFileSync(outPath, await doc.save(), { mode: 0o600 });
}

/** Page count, or null if the PDF cannot be parsed (encrypted/damaged: SumatraPDF may still print it). */
export async function countPdfPages(path: string): Promise<number | null> {
  try {
    const doc = await PDFDocument.load(readFileSync(path), { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    return null;
  }
}

export async function makeTestPagePdf(outPath: string, info: { printerName: string; hostname: string; agentVersion: string; now: Date }): Promise<void> {
  const doc = await PDFDocument.create();
  const [w, h] = PAPER_POINTS.A4;
  const page = doc.addPage([w, h]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 36, y: 36, width: w - 72, height: h - 72, borderColor: rgb(0, 0, 0), borderWidth: 2 });
  page.drawText('Mansa Printer - Print Agent test page', { x: 60, y: h - 100, size: 22, font: bold });
  const lines = [
    `Printer: ${info.printerName}`,
    `Computer: ${info.hostname}`,
    `Agent version: ${info.agentVersion}`,
    `Printed at (local): ${info.now.toString()}`,
    `Printed at (UTC): ${info.now.toISOString()}`,
    '',
    'If you can read this, the agent can reach this printer through the Windows spooler.',
    'Check: the border is complete on all four sides, text is sharp, no streaks.',
  ];
  lines.forEach((t, i) => page.drawText(t.replace(/[^\x20-\x7e]/g, '?'), { x: 60, y: h - 150 - i * 22, size: 12, font }));
  // grayscale + colour swatches for a quick colour check
  const sw: Array<[number, number, number]> = [
    [0, 0, 0],
    [0.5, 0.5, 0.5],
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 0],
  ];
  sw.forEach((c, i) => page.drawRectangle({ x: 60 + i * 90, y: 200, width: 80, height: 80, color: rgb(c[0], c[1], c[2]) }));
  doc.setTitle('Mansa Print Agent test page');
  writeFileSync(outPath, await doc.save(), { mode: 0o600 });
}
