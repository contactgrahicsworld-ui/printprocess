import QRCode from "qrcode";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Db } from "@/lib/db/types";
import type { Staff } from "@/lib/auth/types";
import { randomToken } from "@/lib/security/crypto";
import { audit } from "./audit";
import { HttpError } from "@/lib/http/respond";
import { loadShopSettings } from "./settings";

export interface QrCode { id: string; token: string; label: string; active: boolean; createdAt: Date }

export function portalUrl(appUrl: string, token: string): string {
  return new URL(`/s/${encodeURIComponent(token)}`, appUrl).toString();
}

export async function getActiveQr(db: Db): Promise<QrCode | null> {
  const r = (await db.query<{ id: string; token: string; label: string; active: boolean; created_at: Date }>(
    "select id, token, label, active, created_at from shop_qr_codes where active limit 1"))[0];
  return r ? { id: r.id, token: r.token, label: r.label, active: r.active, createdAt: r.created_at } : null;
}

/** Resolves a QR token for the customer portal. Only the single active token works. */
export async function resolveQrToken(db: Db, token: string): Promise<{ id: string } | null> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  const r = (await db.query<{ id: string }>("select id from shop_qr_codes where token = $1 and active", [token]))[0];
  return r ?? null;
}

/** Creates a new active QR, deactivating the previous one (old printed posters stop working). */
export async function regenerateQr(db: Db, staff: Staff, label = "Counter QR", ip: string | null = null): Promise<QrCode> {
  return db.tx(async (tx) => {
    const old = await tx.query<{ id: string }>(
      "update shop_qr_codes set active = false, deactivated_at = now(), deactivated_by = $1 where active returning id", [staff.userId]);
    const token = randomToken(24);
    const r = (await tx.query<{ id: string; token: string; label: string; active: boolean; created_at: Date }>(
      "insert into shop_qr_codes (token, label, created_by) values ($1, $2, $3) returning id, token, label, active, created_at",
      [token, label, staff.userId]))[0]!;
    await audit(tx, staff, "qr.regenerate", "shop_qr_code", r.id, { deactivated: old.map((o) => o.id) }, ip);
    return { id: r.id, token: r.token, label: r.label, active: r.active, createdAt: r.created_at };
  });
}

export async function deactivateQr(db: Db, staff: Staff, ip: string | null = null): Promise<void> {
  await db.tx(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      "update shop_qr_codes set active = false, deactivated_at = now(), deactivated_by = $1 where active returning id", [staff.userId]);
    if (rows.length === 0) throw new HttpError(404, "NO_ACTIVE_QR", "There is no active QR code");
    await audit(tx, staff, "qr.deactivate", "shop_qr_code", rows[0]!.id, {}, ip);
  });
}

export async function qrPng(url: string, width = 1024): Promise<Buffer> {
  return QRCode.toBuffer(url, { type: "png", errorCorrectionLevel: "M", margin: 2, width });
}

/** Printable A4 poster (PDF) with the shop QR. Uses Latin text (pdf-lib standard fonts cannot render Devanagari). */
export async function qrPosterPdf(db: Db, url: string): Promise<Uint8Array> {
  const shop = await loadShopSettings(db);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${shop.shopName} - Scan to Print`);
  const page = pdf.addPage([595.28, 841.89]);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const png = await pdf.embedPng(await qrPng(url, 1200));
  const { width } = page.getSize();
  const center = (text: string, size: number, y: number, font = reg, color = rgb(0.1, 0.1, 0.1)) => {
    const w = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: (width - w) / 2, y, size, font, color });
  };
  page.drawRectangle({ x: 0, y: 741.89, width, height: 100, color: rgb(0.07, 0.25, 0.55) });
  center(shop.shopName.slice(0, 40), 34, 790, bold, rgb(1, 1, 1));
  center(shop.address.slice(0, 70), 13, 760, reg, rgb(0.9, 0.93, 1));
  center("Scan to upload & print", 30, 690, bold);
  center("Scan karein, file bhejein, print payein", 18, 662);
  const size = 360;
  page.drawImage(png, { x: (width - size) / 2, y: 270, width: size, height: size });
  center("1. Scan QR   2. Upload PDF / JPG / PNG   3. Choose settings   4. Submit", 12, 235);
  center("No login needed. Pay at the counter (Cash / UPI).", 12, 215);
  center("Login ki zarurat nahin. Counter par bhugtan karein.", 12, 197);
  center(url.length > 80 ? url.slice(0, 77) + "..." : url, 9, 150, reg, rgb(0.35, 0.35, 0.35));
  if (shop.phone) center(`Phone: ${shop.phone}`, 12, 120);
  return pdf.save();
}
