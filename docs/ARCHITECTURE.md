# Architecture — web app + database

```
 Customer phone ──scan QR──▶ /s/[token] (Next.js, mobile portal)
     │  POST /api/public/sessions        → upload session (32-byte token, header X-Session-Token)
     │  POST /api/public/uploads         → reserve file row + one-time signed upload URL
     │  PUT  <signed URL>  (XHR progress) → Supabase Storage, PRIVATE bucket "print-files"
     │  POST /api/public/uploads/:id/complete → server downloads object: size, magic bytes,
     │                                       pdf-lib parse / encryption / page count, image structure,
     │                                       ClamAV hook, sha256 → READY | REJECTED (object deleted)
     │  POST /api/public/quote           → live estimate (same price engine)
     │  POST /api/public/orders          → idempotent submit, price recomputed, MP-YYYYMMDD-NNNN
     └─ /t/[orderNumber]?k=token         → POST /api/public/track (hash compare, generic 404, rate limited)

 Staff browser ──Supabase Auth (email/password)──▶ /admin  (RLS-protected Realtime + server APIs)
     /api/admin/*  cookie session → getUser() → active staff_profiles row → role check → audit_logs
     Send to printer → print_jobs (QUEUED) ; Verify printed → VERIFIED ; payments ; receipts

 Windows Print Agent (separate team, CONTRACT.md) ──HMAC──▶ /api/agent/heartbeat | jobs/claim | jobs/:id/status
     claim → public.claim_print_jobs() (FOR UPDATE SKIP LOCKED) → signed 10-min download URL

 Vercel Cron (daily) ──Bearer CRON_SECRET──▶ /api/cron/retention → delete old objects, mark PURGED
```

## Layers (web/src)
| Path | Responsibility |
|---|---|
| `app/**/route.ts` | Thin HTTP handlers: parse/validate (zod), authenticate, call a service, uniform errors |
| `lib/services/*` | Business logic (sessions, uploads, orders, admin-orders, print-jobs, agents, payments, qr, settings, retention) |
| `lib/pricing/engine.ts`, `lib/print/pages.ts`, `lib/orders/status.ts` | Pure domain rules (price, page ranges + sheets, state machines) |
| `lib/files/*` | magic bytes, PDF inspection, ClamAV client |
| `lib/db/*` | `Db` interface: `postgres.js` (prod) and PGlite (tests/local); migrations reader |
| `lib/storage/*` | `StorageDriver`: Supabase Storage (prod) and HMAC-signed local storage (dev/tests) |
| `lib/auth/*` | `AuthResolver`: Supabase Auth (prod) and signed dev cookie (dev only, refused in production) |
| `lib/context.ts` | Wires drivers from env; tests inject their own context |
| `proxy.ts` | Per-request nonce CSP; Supabase session cookie refresh for /admin |

### Why a direct Postgres connection on the server
All customer and agent flows need multi-statement transactions with row locks (idempotent submit, order-number
sequence, job claim, payment vs due). The server therefore uses the Supabase **transaction pooler** connection
(`DATABASE_URL`, table-owner role, bypasses RLS like the service role) and enforces every rule in code **and** in the
database (CHECK constraints, triggers, unique partial indexes). Browser clients only ever hold the anon key + a staff
JWT, so everything they can touch directly is governed by RLS. Supabase JS (service role) is used only for Storage.

## Database (supabase/migrations)
| File | Contents |
|---|---|
| `…0100_schema.sql` | enums, all tables, CHECKs, indexes incl. `print_jobs_one_active_per_item` (unique partial), `shop_qr_codes_one_active`, `print_job_events_agent_once` |
| `…0200_functions.sql` | `next_counter`, `next_order_number` (Asia/Kolkata day, atomic upsert), `next_receipt_number`, `order_transition_allowed` + guard trigger, payment trigger (paid ≤ total), append-only triggers, `claim_print_jobs` (SKIP LOCKED), `rate_limit_hit`, `is_staff/is_admin/is_owner` |
| `…0300_rls.sql` | RLS on every table, REVOKE from anon/authenticated, staff read policies, admin/owner write policies, column-level grant on `print_agents` (secrets never granted) |
| `…0400_storage_realtime.sql` | private bucket `print-files` (25 MB, PDF/JPEG/PNG only), staff read policy, Realtime publication |
| `…0500_seed.sql` | default shop settings, prices, paper sizes, paper types, services |

### State machines
- Order: `RECEIVED → UNDER_REVIEW → APPROVED → PRINTING → READY → DELIVERED`, `CANCELLED` from RECEIVED/UNDER_REVIEW/APPROVED/PRINTING;
  `APPROVED ↔ UNDER_REVIEW`, `PRINTING → APPROVED` (jobs failed), `READY → PRINTING` (reprint). Enforced by
  `lib/orders/status.ts` and the `orders_status_guard` trigger (tested to be identical). PRINTING is entered only by
  creating a print job; READY requires every item to have a staff-VERIFIED job.
- Print job (CONTRACT.md): agent statuses are applied monotonic-safe (`applyAgentStatus`), every report is appended to
  `print_job_events` (unique `(job_id,status)` for agent events ⇒ duplicates are no-ops). Only staff can set VERIFIED.
  Re-queue creates a new row with `attempt+1`.

### Realtime
`orders`, `print_jobs`, `payments`, `print_agents` are in the `supabase_realtime` publication; the dashboard subscribes
with the staff JWT (RLS `staff_read` applies) and also polls every 10–15 s as a fallback.

## Local / test drivers
`DB_DRIVER=pglite` runs the real migrations in embedded Postgres 18 (PGlite) with small stubs for Supabase's `auth`
and `storage` schemas and roles (`web/tests/helpers/supabase-stub.sql` — **not** a migration). `STORAGE_DRIVER=local`
emulates signed upload/download URLs (HMAC, expiring, path-bound, single-write). `AUTH_DRIVER=dev` signs in an
existing staff row via an HMAC cookie. All three are refused when `NODE_ENV=production` (`lib/config.ts`).
