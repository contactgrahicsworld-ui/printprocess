import { createHash } from 'node:crypto';
import { createWriteStream, openSync, readSync, closeSync, unlinkSync } from 'node:fs';
import { isUrlAllowed } from './config.js';

export class DownloadError extends Error {
  constructor(
    msg: string,
    readonly kind: 'network' | 'http' | 'too_large' | 'url',
    readonly httpStatus?: number,
  ) {
    super(msg);
  }
}

export class IntegrityError extends Error {
  constructor(
    msg: string,
    readonly kind: 'sha256' | 'magic' | 'unsupported',
  ) {
    super(msg);
  }
}

export interface DownloadResult {
  bytes: number;
  sha256: string;
}

/** Streams the signed URL to `dest` (mode 0600), hashing on the fly. No agent HMAC headers are sent to storage. */
export async function downloadToFile(
  url: string,
  dest: string,
  opts: { maxBytes: number; timeoutMs: number; allowInsecureLocalhost: boolean; fetchImpl?: typeof fetch },
): Promise<DownloadResult> {
  if (!isUrlAllowed(url, opts.allowInsecureLocalhost)) throw new DownloadError(`refusing non-HTTPS download URL`, 'url');
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(url, { signal: AbortSignal.timeout(opts.timeoutMs) });
  } catch (e) {
    throw new DownloadError(`download failed: ${(e as Error).message}`, 'network');
  }
  if (!res.ok || !res.body) throw new DownloadError(`download HTTP ${res.status}`, 'http', res.status);
  const len = Number(res.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(len) && len > opts.maxBytes) throw new DownloadError(`file too large (${len} > ${opts.maxBytes})`, 'too_large');

  const hash = createHash('sha256');
  const out = createWriteStream(dest, { mode: 0o600 });
  let bytes = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > opts.maxBytes) {
        await reader.cancel();
        throw new DownloadError(`file too large (> ${opts.maxBytes})`, 'too_large');
      }
      hash.update(value);
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (e) {
    out.destroy();
    try { unlinkSync(dest); } catch { /* ignore */ }
    if (e instanceof DownloadError) throw e;
    throw new DownloadError(`download stream failed: ${(e as Error).message}`, 'network');
  }
  return { bytes, sha256: hash.digest('hex') };
}

export type DetectedType = 'pdf' | 'jpeg' | 'png' | 'unknown';

export function detectMagic(head: Uint8Array): DetectedType {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (head.length >= 8 && png.every((b, i) => head[i] === b)) return 'png';
  // PDF spec allows the header within the first 1024 bytes.
  const s = Buffer.from(head.subarray(0, 1024)).toString('latin1');
  if (s.includes('%PDF-')) return 'pdf';
  return 'unknown';
}

export function readHead(path: string, n = 1024): Uint8Array {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

const MIME_TO_TYPE: Record<string, DetectedType> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/pjpeg': 'jpeg',
  'image/png': 'png',
};

/** Verifies hash + magic bytes + mime consistency. Returns the detected type. */
export function verifyFile(path: string, actualSha256: string, expectedSha256: string, mimeType: string): Exclude<DetectedType, 'unknown'> {
  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new IntegrityError(`sha256 mismatch: expected ${expectedSha256.toLowerCase()}, got ${actualSha256}`, 'sha256');
  }
  const expectedType = MIME_TO_TYPE[mimeType.toLowerCase()];
  if (!expectedType) throw new IntegrityError(`unsupported mimeType ${mimeType} (PDF, JPEG, PNG only)`, 'unsupported');
  const detected = detectMagic(readHead(path));
  if (detected === 'unknown') throw new IntegrityError(`magic bytes do not match any supported type (declared ${mimeType})`, 'magic');
  if (detected !== expectedType) throw new IntegrityError(`magic bytes say ${detected} but mimeType is ${mimeType}`, 'magic');
  return detected;
}
