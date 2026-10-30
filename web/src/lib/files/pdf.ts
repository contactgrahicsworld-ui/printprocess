import { PDFDocument } from "pdf-lib";

export type PdfInspection =
  | { ok: true; pageCount: number }
  | { ok: false; reason: "ENCRYPTED" | "CORRUPT" | "EMPTY" | "TOO_MANY_PAGES"; message: string };

export const MAX_PDF_PAGES = 2000;

/** Server-side page count. Encrypted or unparsable PDFs are rejected gracefully. */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  // Quick encryption check: an /Encrypt entry in a trailer or xref stream dictionary.
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 4096))).toString("latin1");
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/encrypt/i.test(msg) || /\/Encrypt\b/.test(tail)) {
      return { ok: false, reason: "ENCRYPTED", message: "This PDF is password-protected. Please upload an unlocked copy. / PDF par password hai." };
    }
    return { ok: false, reason: "CORRUPT", message: "This PDF could not be read (damaged file). / PDF kharab hai." };
  }
  if (doc.isEncrypted) {
    return { ok: false, reason: "ENCRYPTED", message: "This PDF is password-protected. Please upload an unlocked copy. / PDF par password hai." };
  }
  let pageCount = 0;
  try {
    pageCount = doc.getPageCount();
  } catch {
    return { ok: false, reason: "CORRUPT", message: "This PDF could not be read (damaged file). / PDF kharab hai." };
  }
  if (pageCount < 1) return { ok: false, reason: "EMPTY", message: "This PDF has no pages." };
  if (pageCount > MAX_PDF_PAGES) return { ok: false, reason: "TOO_MANY_PAGES", message: `PDF has more than ${MAX_PDF_PAGES} pages.` };
  return { ok: true, pageCount };
}
