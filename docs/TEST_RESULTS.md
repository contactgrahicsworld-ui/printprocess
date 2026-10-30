# Test results — web app + database

Recorded on 2026-10-30 in the build sandbox (Linux arm64, Node 22.23.3, npm 10.9.9).
All output below is copied from real runs; nothing is simulated. Database = **real migrations** applied to
embedded Postgres 18 (PGlite 0.5.13) with the Supabase `auth`/`storage` stubs in `web/tests/helpers/supabase-stub.sql`.

## Summary
| Check | Command (in `web/`) | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` (strict, `noUncheckedIndexedAccess`) | **pass** (exit 0, no output) |
| Lint | `npx eslint .` (eslint-config-next 16 core-web-vitals + typescript) | **pass** (exit 0, 0 problems) |
| Unit + integration | `npx vitest run` | **129 / 129 passed**, 11 files |
| Production build | `npx next build` | **pass** (Next.js 16.4.3, Turbopack) |
| E2E (browser) | `npx playwright test` (Firefox, 412×915 mobile viewport, real `next dev` + PGlite + local signed storage) | **2 / 2 passed** |
| Production smoke | `next start` (NODE_ENV=production) + curl | CSP with per-request nonce present and applied to every `<script>`; HSTS/XFO/Referrer-Policy present; `/admin` → 307 `/admin/login`; `/api/dev/login` → 404 in production; unsigned agent call → 401 |

### Tests per file
| File | Tests | Covers |
|---|---|---|
| unit/pages.test.ts | 28 | page-range parser (valid, whitespace, en-dash, overlaps merge, 13 invalid inputs, limits), CONTRACT sheet calc (odd duplex, copies, combined) |
| unit/pricing.test.ts | 11 | per-side rates, duplex, size multipliers + half-up rounding, paper type, PER_COPY/PER_DOCUMENT/PER_ORDER services, min order, invalid configs, en-IN ₹ format |
| unit/security.test.ts | 10 | magic bytes (PDF/PNG/JPEG vs EXE/ZIP/HTML/truncated), image structure, PDF page count / encrypted / corrupt, random tokens, constant-time compare, agent canonical string + **HMAC known-answer test cross-checked with `openssl dgst -hmac`**, Razorpay signature |
| unit/status.test.ts | 9 | order transitions (happy path, terminal, skips), agent job status monotonicity, failures, terminal freeze, agent can't reach VERIFIED |
| unit/clamd.test.ts | 4 | ClamAV INSTREAM client against a TCP clamd emulator: CLEAN (multi-chunk), INFECTED, unreachable ⇒ ERROR (fail-closed), NOT_SCANNED when unset |
| integration/db.test.ts | 6 | migrations apply + seed, RLS enabled on every table, order numbers MP-YYYYMMDD-NNNN (IST day, 25 concurrent unique), **SQL vs TS transition table identical (49 pairs)**, rate limiter, anon has no access |
| integration/full-flow.test.ts | 17 | session → upload (signed URL PUT) → configure BW duplex `1-3, 7, 10-12` ×2 + staple + urgent → server quote ₹45.00 → submit → track → admin preview (signed URL) → edit (revision + audit, ₹57.50) → assign → approve → create agent (secret once, hashes only) → heartbeat (HMAC) → send to printer → **agent claim** (exact PrintJob shape, sha256 + 10-min URL verified, idempotent resume) → status chain (dupes no-op, late events no regression, COMPLETED_SPOOLER ≠ READY) → staff verify → READY → partial CASH + UPI, overpay rejected → DELIVERED → receipt number + PDF → customer timeline → audit coverage |
| integration/failures.test.ts | 26 | invalid signature (EXE as .pdf), PNG/JPEG accepted, oversized (declared and actual), encrypted/corrupt PDF, max files + remove, forged/reused upload URL, **interrupted upload cannot complete or submit**, expired/garbage session, **tampered price**, client-invented fields, **duplicate submission (concurrent + replay + new key)**, unapproved/unknown printer, **duplicate job (concurrent + sequential)**, **bad / wrong-body / wrong-path / unknown agent / expired / future signatures**, **replayed nonce**, cross-agent claim/update, failed → re-queue attempt 2, cancel, terminal can't be resurrected, revoked agent, **cross-order tracking denied (identical generic 404)**, tracking + session rate limits, QR regenerate/deactivate + PNG/A4 PDF, retention cron auth + purge, RBAC (STAFF 403, unauth 401, CSRF 403), deactivated staff |
| integration/rls.test.ts | 13 | real policies via `SET ROLE authenticated` + `request.jwt.claims`: anon denied; non-staff sees nothing; STAFF read-only on settings, can't self-promote, can't read agents/audit, can't touch money columns or insert payments, status trigger still enforced; ADMIN can edit prices but **cannot read `hmac_key`/`secret_hash`**; only OWNER manages staff; append-only audit/payments/events; storage policy |
| integration/payments-razorpay.test.ts | 4 | disabled ⇒ endpoints 404; gateway order created server-side for due amount (Razorpay HTTP mocked at `fetch`); bad webhook signature records nothing; verified webhook records ONLINE once (idempotent) |
| integration/agent-contract-compat.test.ts | 1 | heartbeat signed by the **print agent's own** `print-agent/src/hmac.ts` is accepted by the server (read-only import) |

## Raw output — `npx vitest run --reporter=verbose`
```
 ✓ tests/integration/payments-razorpay.test.ts > Razorpay disabled (no keys) > endpoints are hidden and tracking does not offer online payment
 ✓ tests/integration/payments-razorpay.test.ts > Razorpay enabled > creates a gateway order server-side for the due amount (gateway HTTP mocked at fetch level)
 ✓ tests/integration/payments-razorpay.test.ts > Razorpay enabled > rejects webhooks with a bad signature and records nothing
 ✓ tests/integration/payments-razorpay.test.ts > Razorpay enabled > records ONLINE payment only on a verified webhook, exactly once
 ✓ tests/integration/failures.test.ts > upload validation > rejects a file whose content is not PDF/JPG/PNG even if named .pdf and declared application/pdf
 ✓ tests/integration/failures.test.ts > upload validation > accepts real PNG and JPEG images as 1 page each
 ✓ tests/integration/failures.test.ts > upload validation > rejects oversized uploads: declared size before URL is issued, and actual bytes after upload
 ✓ tests/integration/failures.test.ts > upload validation > rejects encrypted and corrupt PDFs gracefully (no 500)
 ✓ tests/integration/failures.test.ts > upload validation > enforces max files per session and allows removing before submit
 ✓ tests/integration/failures.test.ts > upload validation > signed upload URLs are bound to path and cannot be forged or reused
 ✓ tests/integration/failures.test.ts > interrupted upload / incomplete session > cannot complete a file that was never uploaded, and cannot submit while a file is pending
 ✓ tests/integration/failures.test.ts > interrupted upload / incomplete session > expired session cannot upload or submit
 ✓ tests/integration/failures.test.ts > interrupted upload / incomplete session > garbage session token is rejected
 ✓ tests/integration/failures.test.ts > pricing tamper + idempotency > rejects a tampered (lower) price and returns the real quote; nothing is created
 ✓ tests/integration/failures.test.ts > pricing tamper + idempotency > rejects client-invented fields (unknown service, out-of-range page, bad copies)
 ✓ tests/integration/failures.test.ts > pricing tamper + idempotency > same idempotency key twice → one order, same response (incl. tracking token); concurrent duplicates too
 ✓ tests/integration/failures.test.ts > print jobs + agent auth > refuses to send unapproved orders and printers not in the heartbeat
 ✓ tests/integration/failures.test.ts > print jobs + agent auth > duplicate job creation is blocked (sequential and concurrent) by the unique partial index
 ✓ tests/integration/failures.test.ts > print jobs + agent auth > rejects bad signature, wrong body, wrong path, unknown agent, expired / future timestamps
 ✓ tests/integration/failures.test.ts > print jobs + agent auth > rejects a replayed nonce
 ✓ tests/integration/failures.test.ts > print jobs + agent auth > another agent cannot claim or update this agent's job
 ✓ tests/integration/failures.test.ts > print jobs + agent auth > failed job can be re-queued as attempt 2; staff can cancel queued jobs; agent cannot resurrect terminal jobs
 ✓ tests/integration/failures.test.ts > print jobs + agent auth > revoked agent is refused
 ✓ tests/integration/failures.test.ts > tracking access control > cross-order token, wrong token and unknown order all return the same generic 404
 ✓ tests/integration/failures.test.ts > tracking access control > is rate limited per IP
 ✓ tests/integration/failures.test.ts > QR lifecycle > regenerate deactivates the old token; deactivate leaves no active QR; PNG + A4 poster download
 ✓ tests/integration/failures.test.ts > QR lifecycle > session creation is rate limited per IP
 ✓ tests/integration/failures.test.ts > retention cron > requires CRON_SECRET and purges files of finished orders older than retention_days
 ✓ tests/integration/failures.test.ts > admin API RBAC + CSRF > STAFF cannot change settings or manage agents; unauthenticated gets 401; cross-site POST gets 403
 ✓ tests/integration/failures.test.ts > admin API RBAC + CSRF > deactivated staff lose access immediately
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > customer: session, upload real PDF, server counts pages
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > customer: configures BW duplex, pages 1-3,7,10-12, 2 copies + stapling; live server quote
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > customer: submits; gets MP-YYYYMMDD-NNNN + tracking token (only hash stored)
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > customer: tracks the order
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > admin: sees order in 'new' tab, previews file via short-lived signed URL
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > admin: edits settings (copies 2→3) with revision + audit and server re-price
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > admin: assigns, approves
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > owner: creates a print agent; secret shown once, only hashes stored
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > agent: heartbeat with printers (valid HMAC)
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > admin: sends to printer → job QUEUED, order PRINTING
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > agent: claims the job with full CONTRACT PrintJob shape and a working 10-minute download URL
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > agent: status updates are append-only, idempotent and monotonic; COMPLETED_SPOOLER does NOT make the order READY
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > staff: Verify printed → job VERIFIED → order READY
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > staff: partial CASH + UPI payment, overpayment rejected, then delivered
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > staff: issues receipt with receipt number; HTML snapshot + PDF
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > customer: tracking shows the full timeline, paid, due
 ✓ tests/integration/full-flow.test.ts > full flow: QR → upload → configure → price → submit → approve → print job → agent → verify → deliver → pay → receipt > every admin action wrote an audit log
 ✓ tests/integration/rls.test.ts > RLS: anon > anon cannot read or write any table
 ✓ tests/integration/rls.test.ts > RLS: authenticated non-staff > a signed-in user without a staff profile sees nothing
 ✓ tests/integration/rls.test.ts > RLS: authenticated non-staff > cannot update orders
 ✓ tests/integration/rls.test.ts > RLS: STAFF role > can read operational data (dashboard + Realtime)
 ✓ tests/integration/rls.test.ts > RLS: STAFF role > cannot change prices, paper types, services, shop settings, QR codes
 ✓ tests/integration/rls.test.ts > RLS: STAFF role > cannot grant itself OWNER or create staff
 ✓ tests/integration/rls.test.ts > RLS: STAFF role > cannot read print agents at all, nor audit logs
 ✓ tests/integration/rls.test.ts > RLS: STAFF role > cannot insert payments, print jobs or order money fields directly
 ✓ tests/integration/rls.test.ts > RLS: STAFF role > status updates through RLS still hit the transition trigger
 ✓ tests/integration/rls.test.ts > RLS: ADMIN / OWNER > ADMIN can change prices but can never read agent secrets
 ✓ tests/integration/rls.test.ts > RLS: ADMIN / OWNER > ADMIN cannot manage staff; OWNER can
 ✓ tests/integration/rls.test.ts > RLS: ADMIN / OWNER > nobody can tamper with the audit log or job events (append-only)
 ✓ tests/integration/rls.test.ts > RLS: ADMIN / OWNER > storage objects: staff policy only; anon has no access
 ✓ tests/integration/agent-contract-compat.test.ts > print-agent ⇄ server HMAC compatibility > heartbeat signed by print-agent/src/hmac.ts is accepted
 ✓ tests/integration/db.test.ts > migrations (PGlite) > apply cleanly and seed defaults
 ✓ tests/integration/db.test.ts > migrations (PGlite) > enables RLS on every public table
 ✓ tests/integration/db.test.ts > migrations (PGlite) > generates per-day order numbers MP-YYYYMMDD-NNNN (Asia/Kolkata day) without duplicates under concurrency
 ✓ tests/integration/db.test.ts > migrations (PGlite) > SQL order transition function matches the TypeScript state machine exactly
 ✓ tests/integration/db.test.ts > migrations (PGlite) > rate_limit_hit allows max hits per window
 ✓ tests/integration/db.test.ts > migrations (PGlite) > anon role has no direct table access
 ✓ tests/unit/security.test.ts > magic bytes > detects real PDF/PNG/JPEG by content
 ✓ tests/unit/security.test.ts > magic bytes > rejects lookalikes and other formats
 ✓ tests/unit/security.test.ts > magic bytes > validates image structure
 ✓ tests/unit/security.test.ts > PDF inspection > counts pages server-side
 ✓ tests/unit/security.test.ts > PDF inspection > rejects encrypted PDFs gracefully
 ✓ tests/unit/security.test.ts > PDF inspection > rejects corrupt PDFs gracefully
 ✓ tests/unit/security.test.ts > crypto + HMAC > random tokens are 32 bytes url-safe and unique
 ✓ tests/unit/security.test.ts > crypto + HMAC > constant-time compares
 ✓ tests/unit/security.test.ts > crypto + HMAC > agent canonical string + signature match CONTRACT.md byte-for-byte
 ✓ tests/unit/security.test.ts > crypto + HMAC > Razorpay webhook signature verification
 ✓ tests/unit/clamd.test.ts > ClamAV clamd INSTREAM client > reports CLEAN and streams the full content in chunks
 ✓ tests/unit/clamd.test.ts > ClamAV clamd INSTREAM client > reports INFECTED on a signature hit
 ✓ tests/unit/clamd.test.ts > ClamAV clamd INSTREAM client > reports ERROR (fail-closed) when clamd is unreachable
 ✓ tests/unit/clamd.test.ts > ClamAV clamd INSTREAM client > without CLAMAV_HOST records NOT_SCANNED (never claims a scan)
 ✓ tests/unit/pricing.test.ts > price engine > BW single A4: 10 pages × ₹2
 ✓ tests/unit/pricing.test.ts > price engine > BW duplex uses per-side double rate on printed sides (odd pages: blank back not charged)
 ✓ tests/unit/pricing.test.ts > price engine > colour A3 applies size multiplier
 ✓ tests/unit/pricing.test.ts > price engine > legal multiplier 1.25 with half-up rounding
 ✓ tests/unit/pricing.test.ts > price engine > page range + duplex + copies + paper type + per-copy and per-document services
 ✓ tests/unit/pricing.test.ts > price engine > image counts as one page; page selection other than 1 is rejected
 ✓ tests/unit/pricing.test.ts > price engine > rejects invalid copies, disabled size, inactive paper type, unknown or wrong-unit services
 ✓ tests/unit/pricing.test.ts > price engine > order: sums items, adds PER_ORDER services once, rejects per-document codes at order level
 ✓ tests/unit/pricing.test.ts > price engine > minimum order adjustment
 ✓ tests/unit/pricing.test.ts > price engine > money is always an integer
 ✓ tests/unit/pricing.test.ts > price engine > formats en-IN rupees
 ✓ tests/unit/pages.test.ts > parsePageRanges > parses the example 1-3,7,10-12
 ✓ tests/unit/pages.test.ts > parsePageRanges > empty / null / 'all' = all pages, normalized null
 ✓ tests/unit/pages.test.ts > parsePageRanges > tolerates whitespace and en-dash
 ✓ tests/unit/pages.test.ts > parsePageRanges > merges overlaps/duplicates and sorts so charge == what prints
 ✓ tests/unit/pages.test.ts > parsePageRanges > selection covering every page normalizes to all (null)
 ✓ tests/unit/pages.test.ts > parsePageRanges > single page document
 ✓ tests/unit/pages.test.ts > parsePageRanges > rejects 0
 ✓ tests/unit/pages.test.ts > parsePageRanges > rejects 0-2
 ✓ tests/unit/pages.test.ts > parsePageRanges > rejects 3-1
 ✓ tests/unit/pages.test.ts > parsePageRanges > rejects 1-13
 ✓ tests/unit/pages.test.ts > parsePageRanges > rejects 13
 ✓ tests/unit/pages.test.ts > parsePageRanges > rejects 1,,2
 ✓ tests/unit/pages.test.ts > parsePageRanges > rejects ,1
 ✓ tests/unit/pages.test.ts > parsePageRanges > rejects 1,
 ✓ tests/unit/pages.test.ts > parsePageRanges > rejects a
 ✓ tests/unit/pages.test.ts > parsePageRanges > rejects 1-2-3
 ✓ tests/unit/pages.test.ts > parsePageRanges > rejects -1
 ✓ tests/unit/pages.test.ts > parsePageRanges > rejects 1.5
 ✓ tests/unit/pages.test.ts > parsePageRanges > rejects 1;2
 ✓ tests/unit/pages.test.ts > parsePageRanges > rejects overly long input and too many tokens
 ✓ tests/unit/pages.test.ts > parsePageRanges > rejects invalid page count
 ✓ tests/unit/pages.test.ts > parsePageRanges > formatRanges compresses consecutive runs
 ✓ tests/unit/pages.test.ts > calcSheets (CONTRACT.md) > single-sided: one sheet per page
 ✓ tests/unit/pages.test.ts > calcSheets (CONTRACT.md) > duplex with odd pages rounds sheets up, sides unchanged
 ✓ tests/unit/pages.test.ts > calcSheets (CONTRACT.md) > duplex with even pages
 ✓ tests/unit/pages.test.ts > calcSheets (CONTRACT.md) > copies multiply per copy (odd duplex is per copy, not pooled)
 ✓ tests/unit/pages.test.ts > calcSheets (CONTRACT.md) > range + duplex + copies combined: '1-3,7,10-12' of 12 pages, duplex, 2 copies
 ✓ tests/unit/pages.test.ts > calcSheets (CONTRACT.md) > rejects invalid input
 ✓ tests/unit/status.test.ts > order status transitions > allows the happy path
 ✓ tests/unit/status.test.ts > order status transitions > terminal states cannot move
 ✓ tests/unit/status.test.ts > order status transitions > forbids skipping (RECEIVED→PRINTING/READY/DELIVERED) and backwards jumps
 ✓ tests/unit/status.test.ts > order status transitions > no self transitions in the table
 ✓ tests/unit/status.test.ts > agent job status (monotonic-safe) > moves forward along the CONTRACT chain
 ✓ tests/unit/status.test.ts > agent job status (monotonic-safe) > never regresses (late/out-of-order events)
 ✓ tests/unit/status.test.ts > agent job status (monotonic-safe) > failures only from CLAIMED..PRINTING
 ✓ tests/unit/status.test.ts > agent job status (monotonic-safe) > terminal states are frozen; agent can never reach VERIFIED
 ✓ tests/unit/status.test.ts > agent job status (monotonic-safe) > QUEUED jobs must be claimed first
 Test Files  11 passed (11)
      Tests  129 passed (129)
   Duration  47.88s (transform 2.31s, setup 0ms, import 12.40s, tests 30.07s, environment 2ms)
```

## Raw output — `npx playwright test`
```
Running 2 tests using 1 worker
  ✓  1 [mobile-firefox] › e2e/full-flow.spec.ts:34:1 › inactive QR shows a friendly error (9.8s)
  ✓  2 [mobile-firefox] › e2e/full-flow.spec.ts:39:1 › customer → admin → agent → verify → pay → deliver (real UI, real API, real DB) (1.0m)
  2 passed (1.7m)
EXIT=0
```

## Raw output — `npx next build` (head; full route table in the build log)
```
▲ Next.js 16.4.3 (Turbopack)
✓ Running next.config.ts took 159ms
  Creating an optimized production build ...
✓ Compiled successfully in 10.0s
  Running TypeScript ...
  Finished TypeScript in 9.9s ...
  Collecting page data using 1 worker ...
  Generating static pages using 1 worker (0/3) ...
✓ Generating static pages using 1 worker (3/3) in 380ms
...
ƒ Proxy (Middleware)
build exit=0
```

## Not verifiable here (see docs/DEPLOYMENT.md → "BLOCKED")
Live Supabase (PostgREST/Realtime RLS, Storage signed uploads, Auth), Vercel deploy + cron, Razorpay live webhooks and
a real clamd daemon. The procedures B1–B13 in DEPLOYMENT.md verify each one after deployment.
Note: PGlite is single-connection, so "concurrent" tests prove the logic/constraints (unique indexes, idempotency,
counter upsert) but not true multi-connection lock contention; `claim_print_jobs` uses `FOR UPDATE SKIP LOCKED`,
which is standard Postgres semantics on Supabase.
