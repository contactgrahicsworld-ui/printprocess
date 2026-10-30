import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Per-request nonce CSP + Supabase Auth session refresh for staff pages.
 * Next.js reads the nonce from the request's Content-Security-Policy header and applies it to its own scripts.
 */
export async function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseOrigin = supabaseUrl ? new URL(supabaseUrl).origin : "";
  const supabaseWs = supabaseOrigin.replace(/^https:/, "wss:");
  const razorpay = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET);
  const dev = process.env.NODE_ENV !== "production";

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}${razorpay ? " https://checkout.razorpay.com" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data:${supabaseOrigin ? " " + supabaseOrigin : ""}`,
    `connect-src 'self'${supabaseOrigin ? ` ${supabaseOrigin} ${supabaseWs}` : ""}${razorpay ? " https://api.razorpay.com https://lumberjack.razorpay.com" : ""}${dev ? " ws:" : ""}`,
    `frame-src 'self' blob:${supabaseOrigin ? " " + supabaseOrigin : ""}${razorpay ? " https://api.razorpay.com https://checkout.razorpay.com" : ""}`,
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const path = request.nextUrl.pathname;
  if ((path.startsWith("/admin") || path.startsWith("/api/admin")) && supabaseUrl && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.AUTH_DRIVER !== "dev") {
    const supabase = createServerClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookies) => {
          for (const c of cookies) request.cookies.set(c.name, c.value);
          response = NextResponse.next({ request: { headers: requestHeaders } });
          for (const c of cookies) response.cookies.set(c.name, c.value, c.options);
        },
      },
    });
    await supabase.auth.getUser();
  }

  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|pdf.worker.min.mjs|api/agent|api/webhooks|api/cron|api/local-storage).*)" }],
};
