import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/** sha256 hex of a string (UTF-8) or bytes. */
export function sha256hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * CONTRACT: HMAC key (both sides) = sha256hex(secret).
 * The key is the 64-char lowercase hex string, used as UTF-8 key bytes.
 */
export function deriveHmacKey(secret: string): string {
  return sha256hex(secret);
}

/** CONTRACT canonical string: `${METHOD}\n${path}\n${timestamp}\n${nonce}\n${sha256hex(body or "")}` */
export function canonicalString(method: string, path: string, timestamp: number | string, nonce: string, body: string): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${sha256hex(body ?? '')}`;
}

export function signRequest(hmacKey: string, method: string, path: string, timestamp: number, nonce: string, body: string): string {
  return createHmac('sha256', hmacKey).update(canonicalString(method, path, timestamp, nonce, body)).digest('hex');
}

export interface SignedHeaders {
  'X-Agent-Id': string;
  'X-Agent-Timestamp': string;
  'X-Agent-Nonce': string;
  'X-Agent-Signature': string;
}

export function buildSignedHeaders(opts: {
  agentId: string;
  hmacKey: string;
  method: string;
  path: string;
  body: string;
  now: number;
  nonce?: string;
}): SignedHeaders {
  const nonce = opts.nonce ?? randomUUID();
  const ts = Math.round(opts.now);
  return {
    'X-Agent-Id': opts.agentId,
    'X-Agent-Timestamp': String(ts),
    'X-Agent-Nonce': nonce,
    'X-Agent-Signature': signRequest(opts.hmacKey, opts.method, opts.path, ts, nonce, opts.body),
  };
}

/** Server-side style verification (used by the mock server in tests and by `doctor`). */
export function verifySignature(hmacKey: string, method: string, path: string, timestamp: string, nonce: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signRequest(hmacKey, method, path, Number(timestamp), nonce, body), 'hex');
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
