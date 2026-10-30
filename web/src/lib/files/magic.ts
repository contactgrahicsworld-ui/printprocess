/** File type detection by content signature (magic bytes). Extension and client MIME are never trusted. */
export type DetectedType = "application/pdf" | "image/jpeg" | "image/png";

export function detectFileType(buf: Uint8Array): DetectedType | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // PDF: "%PDF-" must appear at the very start (allowing an optional UTF-8 BOM / leading whitespace, max 16 bytes).
  const head = Buffer.from(buf.subarray(0, Math.min(buf.length, 32))).toString("latin1");
  const idx = head.indexOf("%PDF-");
  if (idx >= 0 && idx <= 16 && /^[\s\uFEFF\u00EF\u00BB\u00BF]*$/.test(head.slice(0, idx))) return "application/pdf";
  return null;
}

export interface ImageInfo { width: number; height: number }

/** Parse PNG IHDR. Returns null if structurally invalid. */
export function pngInfo(buf: Uint8Array): ImageInfo | null {
  if (buf.length < 33) return null;
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (!width || !height || width > 30000 || height > 30000) return null;
  // must contain an IEND chunk (truncated uploads fail here)
  if (b.lastIndexOf(Buffer.from("IEND", "latin1")) < 0) return null;
  return { width, height };
}

/** Walk JPEG markers to the SOFn frame header. Returns null if structurally invalid. */
export function jpegInfo(buf: Uint8Array): ImageInfo | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1]!;
    while (marker === 0xff && i + 2 < b.length) { i++; marker = b[i + 1]!; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before SOF => invalid
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 7) return null;
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      if (!width || !height) return null;
      return { width, height };
    }
    i += 2 + len;
  }
  return null;
}
