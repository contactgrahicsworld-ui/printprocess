import { z } from "zod";

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly extra?: Record<string, unknown>) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.code, message: e.message, ...e.extra }, e.status);
  if (e instanceof z.ZodError) {
    return json({ error: "VALIDATION", message: e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, 400);
  }
  console.error("[api] unhandled error", e);
  return json({ error: "INTERNAL", message: "Something went wrong. Please try again." }, 500);
}

/** Wraps a route handler with uniform error handling. */
export function handler<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function readJson<T>(req: Request, schema: z.ZodType<T>, maxBytes = 256 * 1024): Promise<T> {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "TOO_LARGE", "Request body too large");
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "BAD_JSON", "Invalid JSON");
  }
  return schema.parse(data);
}

export function clientIp(req: Request): string {
  return req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/**
 * CSRF defence for cookie-authenticated (admin) mutations: the Origin (or Referer) must match APP_URL's origin.
 * Customer endpoints authenticate with a header token (not cookies) and agent endpoints with HMAC, so they are not CSRF-able.
 */
export function assertSameOrigin(req: Request, appUrl: string): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const expected = new URL(appUrl).origin;
  const origin = req.headers.get("origin") ?? (req.headers.get("referer") ? new URL(req.headers.get("referer")!).origin : null);
  const reqOrigin = new URL(req.url).origin;
  if (!origin || (origin !== expected && origin !== reqOrigin)) {
    throw new HttpError(403, "CSRF", "Cross-site request blocked");
  }
}

export function parseJsonText(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "BAD_JSON", "Invalid JSON");
  }
}
