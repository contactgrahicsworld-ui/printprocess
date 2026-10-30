import { describe, expect, it } from "vitest";
import { detectFileType, jpegInfo, pngInfo } from "@/lib/files/magic";
import { inspectPdf } from "@/lib/files/pdf";
import { hmacHex, randomToken, safeEqual, safeEqualHex, sha256hex } from "@/lib/security/crypto";
import { canonical } from "@/lib/services/agents";
import { verifyRazorpaySignature } from "@/lib/services/payments";
import { makeEncryptedPdf, makeJpeg, makePdf, makePng, utf8 } from "../helpers/harness";

describe("magic bytes", () => {
  it("detects real PDF/PNG/JPEG by content", async () => {
    expect(detectFileType(await makePdf(1))).toBe("application/pdf");
    expect(detectFileType(await makePng())).toBe("image/png");
    expect(detectFileType(makeJpeg())).toBe("image/jpeg");
  });
  it("rejects lookalikes and other formats", () => {
    expect(detectFileType(utf8("hello world"))).toBeNull();
    expect(detectFileType(utf8("MZ\x90\x00 fake.pdf"))).toBeNull(); // Windows EXE renamed .pdf
    expect(detectFileType(utf8("<html>%PDF-1.4"))).toBeNull();
    expect(detectFileType(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBeNull(); // zip/docx
    expect(detectFileType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // truncated PNG sig
    expect(detectFileType(new Uint8Array([]))).toBeNull();
  });
  it("validates image structure", async () => {
    expect(pngInfo(await makePng())).toMatchObject({ width: 64, height: 64 });
    expect(pngInfo((await makePng()).subarray(0, 40))).toBeNull(); // truncated: no IEND
    expect(jpegInfo(makeJpeg())).toEqual({ width: 16, height: 16 });
    expect(jpegInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});

describe("PDF inspection", () => {
  it("counts pages server-side", async () => {
    expect(await inspectPdf(await makePdf(7))).toEqual({ ok: true, pageCount: 7 });
  });
  it("rejects encrypted PDFs gracefully", async () => {
    const r = await inspectPdf(await makeEncryptedPdf());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ENCRYPTED");
  });
  it("rejects corrupt PDFs gracefully", async () => {
    const r = await inspectPdf(utf8("%PDF-1.7\n garbage garbage"));
    expect(r.ok).toBe(false);
    const good = await makePdf(3);
    const r2 = await inspectPdf(good.subarray(0, 200));
    expect(r2.ok).toBe(false);
  });
});

describe("crypto + HMAC", () => {
  it("random tokens are 32 bytes url-safe and unique", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });
  it("constant-time compares", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqualHex("00ff", "00FF")).toBe(true);
    expect(safeEqualHex("00ff", "00fe")).toBe(false);
    expect(safeEqualHex("zz", "zz")).toBe(false);
    expect(safeEqualHex("", "")).toBe(false);
  });
  it("agent canonical string + signature match CONTRACT.md byte-for-byte", () => {
    const secret = "s3cr3t";
    const key = sha256hex(secret);
    const c = canonical("post", "/api/agent/heartbeat", "1730000000000", "6f1c6a3e-0000-4000-8000-000000000000", '{"a":1}');
    expect(c).toBe(`POST\n/api/agent/heartbeat\n1730000000000\n6f1c6a3e-0000-4000-8000-000000000000\n${sha256hex('{"a":1}')}`);
    expect(canonical("POST", "/p", "1", "n", "")).toBe(`POST\n/p\n1\nn\n${sha256hex("")}`);
    // known-answer test (computed independently with: printf '%s' "$C" | openssl dgst -sha256 -hmac "$KEY")
    expect(hmacHex(key, c)).toBe("9f20a44cb9a327d6edbf3f0c44f1c761cfce21fd4a513339d9cceb78f3b49f1d");
    expect(hmacHex(key, c)).not.toBe(hmacHex(sha256hex("other"), c));
  });
  it("Razorpay webhook signature verification", () => {
    const body = '{"event":"payment.captured"}';
    const sig = hmacHex("whsec", body);
    expect(verifyRazorpaySignature(body, sig, "whsec")).toBe(true);
    expect(verifyRazorpaySignature(body + " ", sig, "whsec")).toBe(false);
    expect(verifyRazorpaySignature(body, sig, "other")).toBe(false);
    expect(verifyRazorpaySignature(body, "", "whsec")).toBe(false);
  });
});
