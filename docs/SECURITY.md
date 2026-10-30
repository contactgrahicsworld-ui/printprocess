# Security model — web app + database

## Identities
| Actor | Authentication | Authorisation |
|---|---|---|
| Customer | none (no login). Possession of an **active shop QR token** → creates an upload session with a random 32-byte token (only `sha256` stored), sent as `X-Session-Token` header (not a cookie ⇒ not CSRF-able). Sessions expire (`session_ttl_minutes`, default 120). | Can only touch files/orders of its own session, only while `OPEN`. |
| Customer (tracking) | order number + tracking token (HMAC(APP_SECRET, order id), 32 bytes; DB stores only `sha256`). Constant-time compare, dummy compare when the order does not exist, one generic 404 message, rate limited per IP (20/10 min). | Read-only view of that order. |
| Staff | Supabase Auth (email/password) session cookies, validated server-side with `auth.getUser()` on every request, **plus** an active `staff_profiles` row. | Roles OWNER > ADMIN > STAFF. STAFF: orders, files, jobs, payments, receipts. ADMIN: + settings, QR, agents. OWNER: + staff management (RLS). |
| Print agent | `X-Agent-*` HMAC-SHA256 per CONTRACT.md. Key = sha256hex(secret); DB stores `secret_hash` and `hmac_key`, never returned by any API and not granted to `authenticated` (column grant). ±5 min timestamp window, nonce stored 10 min (replay → 401), revoked agents refused, constant-time compare, signature checked before the nonce is stored. | Only jobs claimed by that agent; can never set VERIFIED, never changes order status. |
| Cron | `Authorization: Bearer $CRON_SECRET` (constant-time). | Retention only. |

## Data access
- **RLS enabled on every table** in `public`; `anon` has **no** grants at all (tested); `authenticated` gets SELECT on
  operational tables only if `is_staff()`, settings writes only if `is_admin()`, staff management only if `is_owner()`,
  no access to `upload_sessions`, `agent_nonces`, `counters`, `rate_limits`, `razorpay_orders`, agent secret columns.
  Money columns (`total_paise`, `paid_paise`) are not updatable by `authenticated` (column grant).
- Server routes use the pooled Postgres connection (table owner) and enforce rules in code; the database enforces them
  again: CHECK constraints, order-status transition trigger, payments ≤ total trigger, append-only triggers on
  `audit_logs`, `payments`, `print_job_events`, unique partial index for one active print job per item, unique
  `(session_id, idempotency_key)`.
- **Storage**: bucket `print-files` is private (`public=false`, 25 MB limit, PDF/JPEG/PNG MIME allow-list). No
  insert/update/delete policies for anon/authenticated; uploads only via one-time signed upload URLs created after the
  server validated the session and declared size. Downloads only via signed URLs: staff preview/download 120 s,
  agent 600 s (CONTRACT). Paths are `sessions/<session-uuid>/<file-uuid>` (no user-controlled path segments).

## File validation (never trusts extension or client MIME)
After upload the server downloads the object and checks: actual size ≤ limit; **magic bytes** (`%PDF-`, PNG
signature, JPEG SOI); PDF parsed with pdf-lib (encrypted → rejected, corrupt → rejected, 0 pages / > 2000 pages →
rejected); PNG IHDR+IEND / JPEG SOF structure; sha256 recorded (sent to the agent for integrity). Rejected objects are
deleted from storage immediately. Malware: if `CLAMAV_HOST` is set, clamd `INSTREAM` scan (INFECTED or scanner ERROR ⇒
rejected, fail-closed); otherwise `scan_status = NOT_SCANNED` is recorded and shown to staff — the system never claims
a file was scanned.

## Money
Price recomputed server-side at submission; mismatch ⇒ 409 (tamper test). Payments recorded only by staff
(CASH, UPI with UTR, ONLINE with reference) or by a **signature-verified** Razorpay webhook (`payment.captured`,
idempotent on `gateway_payment_id`). Showing a UPI intent QR never records a payment. Overpayment is rejected in code
and by trigger.

## Web hardening
- Per-request **nonce CSP** with `strict-dynamic` (`src/proxy.ts`), `frame-ancestors 'none'`, `object-src 'none'`,
  `base-uri 'self'`, `form-action 'self'`; HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP; `Cache-Control: no-store` on APIs.
- **CSRF**: cookie-authenticated admin mutations require `Origin`/`Referer` = `APP_URL` origin (tested). Customer and
  agent endpoints do not use cookies.
- **Rate limiting** (Postgres fixed window, or Upstash if configured): session creation 10/10 min/IP, upload URLs
  60/10 min, quotes 120/10 min, submissions 10/10 min, tracking 20/10 min, Razorpay order 10/10 min.
- Input validation with zod everywhere (sizes, enums, UUIDs, lengths), JSON body size caps, generic 500 messages.
- Idempotency key per submission; duplicate submits return the original order.
- `audit_logs` for every admin action (status, approve/reject, assign, edit (before/after), file preview/download,
  print job create/verify/requeue/cancel, payments, receipts, settings, QR, agents) and system actions (retention,
  gateway payments).

## Retention
`/api/cron/retention` (daily, Vercel Cron or pg_cron snippet) deletes stored files older than `retention_days` (default 7)
for DELIVERED/CANCELLED orders, and files of abandoned sessions after 24 h, then marks rows `PURGED`; expires open
sessions; prunes nonces and rate-limit rows. Files of orders still in progress are kept until the order finishes.

## Known limitations / operator responsibilities
- Without ClamAV, files are not malware-scanned (status visible as NOT_SCANNED). Printing a PDF is generally low risk,
  but staff should not open unknown files on other machines.
- The tracking token is derived with `APP_SECRET`; keep it secret and ≥ 32 chars.
- Supabase Auth settings (disable public sign-ups, enforce strong passwords, enable MFA for OWNER) must be configured
  in the Supabase dashboard — see DEPLOYMENT.md.
- Rate limiting is per IP; customers behind one carrier-grade NAT share limits (limits are sized generously).
