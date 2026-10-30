# Deployment — web app + database (Supabase + Vercel)

Everything below uses only environment variables; no credentials are stored in the repo.
Commands assume a terminal at the repo root (`qr-print/`). Replace `<…>` placeholders.

## 0. Prerequisites
- Node.js 20+ (22 used in CI/sandbox), npm.
- Supabase CLI ≥ 1.200 (`npm i -g supabase` or `brew install supabase/tap/supabase`).
- Vercel account (+ optional `npm i -g vercel`), GitHub account.

## 1. Git repository
```bash
cd qr-print
git init -b main            # skip if already a repo
git add .gitignore CONTRACT.md web supabase docs
git commit -m "Web app + database for QR-to-print"
# print-agent/ is committed by its own team (git add print-agent)
gh repo create mansa-qr-print --private --source . --push
#   or: git remote add origin git@github.com:<you>/mansa-qr-print.git && git push -u origin main
```

## 2. Supabase project
1. https://supabase.com/dashboard → **New project**. Region: **South Asia (Mumbai) ap-south-1**. Save the DB password.
2. Link and push migrations:
   ```bash
   supabase login
   supabase link --project-ref <project-ref>        # asks for the DB password
   supabase db push                                  # applies supabase/migrations/*.sql in order
   ```
   This creates all tables, enums, functions, RLS policies, the **private bucket `print-files`**
   (25 MB, PDF/JPEG/PNG), its staff-read policy, the Realtime publication entries and default prices.
3. Verify in the dashboard:
   - *Table editor*: every table shows "RLS enabled".
   - *Storage*: bucket `print-files` exists and is **not public**. (If the insert into `storage.buckets` was
     blocked in your project, create it manually: name `print-files`, Public OFF, file size limit 25 MB,
     allowed MIME types `application/pdf,image/jpeg,image/png`.)
   - *Database → Publications → supabase_realtime*: includes `orders`, `print_jobs`, `payments`, `print_agents`.
4. **Auth settings** (Authentication → Providers / Settings):
   - Email provider ON, **"Allow new users to sign up" OFF** (staff are created by the owner only).
   - Minimum password length ≥ 10; enable leaked-password protection if available; MFA recommended for the owner.
   - Site URL = your app URL (e.g. `https://print.mansaprinter.in`); add `https://<vercel-domain>` to Redirect URLs.
5. **Create the first OWNER**: Authentication → Users → *Add user* → email + strong password (auto-confirm).
   Then SQL Editor → run `supabase/snippets/create_first_owner.sql` with that email. Add further staff the same way
   (role `ADMIN` or `STAFF`).
6. Collect values for env vars: Project Settings → API (`URL`, `anon` key, `service_role` key) and
   Project Settings → Database → Connection string → **Transaction pooler** URI (port 6543).

## 3. Environment variables
See `web/.env.example` (authoritative list). Production values:

| Name | Required | Value |
|---|---|---|
| `APP_URL` | yes | `https://print.mansaprinter.in` (final public URL, no trailing slash) |
| `APP_SECRET` | yes | `openssl rand -base64 48` |
| `DB_DRIVER` | yes | `postgres` |
| `DATABASE_URL` | yes | Supabase transaction-pooler URI (port 6543) |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | service_role key (server only) |
| `STORAGE_DRIVER` / `STORAGE_BUCKET` / `AUTH_DRIVER` | yes | `supabase` / `print-files` / `supabase` |
| `CRON_SECRET` | yes | `openssl rand -hex 24` |
| `CLAMAV_HOST`, `CLAMAV_PORT` | optional | clamd reachable over TCP (e.g. a small VM/Fly.io app). Unset ⇒ files marked NOT_SCANNED |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | optional | all three ⇒ online payment shown |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | optional | Upstash rate limiting instead of Postgres |

## 4. Deploy to Vercel
1. Vercel → **Add New → Project** → import the GitHub repo.
2. **Root Directory: `web`**. Framework: Next.js (auto). Build command `npm run build`, install `npm install`
   (the repo's `web/.npmrc` sets `legacy-peer-deps=true`). Node.js 20.x or 22.x.
3. Add all env vars from §3 for *Production* (and *Preview* if you use preview deployments with a separate Supabase project).
4. Deploy. `web/vercel.json` pins the region to `bom1` (Mumbai) and registers the cron.
5. Smoke test: `curl https://<domain>/api/health` → `{"ok":true,"scanner":"NOT_SCANNED"|"clamav","razorpay":false|true}`.

CLI alternative: `cd web && vercel link && vercel env add … && vercel --prod`.

## 5. Retention cron
- **Vercel Cron** (default): `web/vercel.json` → `GET /api/cron/retention` daily at 21:30 UTC (03:00 IST).
  Vercel automatically sends `Authorization: Bearer $CRON_SECRET` when `CRON_SECRET` is set.
  Check: Vercel → Project → Settings → Cron Jobs → *Run*; response shows `{"purged":n,…}`.
- **Or Supabase pg_cron**: enable `pg_cron` + `pg_net`, run `supabase/snippets/pg_cron_retention.sql`.
- Manual: `curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/retention`.
- Retention days are set in Admin → Settings (default 7).

## 6. Custom domain
Vercel → Project → Settings → Domains → add `print.mansaprinter.in` → create the shown CNAME
(`cname.vercel-dns.com`) at your DNS provider. After it is verified: set `APP_URL` to the domain, update Supabase
Auth Site URL / Redirect URLs, redeploy. **Regenerate/download the QR after changing the domain** (the QR encodes `APP_URL`).

## 7. Print the customer QR
1. Sign in at `https://<domain>/admin` as OWNER/ADMIN → **QR code**.
2. First time: click **Create QR**. Then **Download A4 poster (PDF)** and print it (or Download PNG for a custom design).
3. Stick it at the counter; scan it once with a phone to test the upload flow.
4. If the QR is misused: **Regenerate** (old posters stop working immediately) or **Deactivate**.

## 8. Connect the Windows Print Agent
Admin → **Print agents** → *Create agent* → copy `serverUrl`, `agentId`, `agentSecret` (shown once) into the agent
config on the shop PC (see the print-agent team's install guide). The agent appears Online after its first heartbeat.

## 9. Razorpay (optional)
1. Razorpay Dashboard → Settings → API Keys → generate (test mode first). Set `RAZORPAY_KEY_ID/SECRET`.
2. Settings → Webhooks → Add: URL `https://<domain>/api/webhooks/razorpay`, secret = `RAZORPAY_WEBHOOK_SECRET`,
   events `payment.captured` (and optionally `order.paid`). Redeploy.
3. A payment is recorded **only** when a webhook with a valid `X-Razorpay-Signature` arrives.

## 10. Local development (no cloud needed)
```bash
cd web
npm install
cp .env.development.local.example .env.development.local
npm run dev:local         # seeds PGlite (real migrations) + starts http://localhost:3000
# Portal: http://localhost:3000/s/dev-qr-token-mansa-0001   Admin: http://localhost:3000/admin/login
npm test                  # unit + integration (PGlite)
npx playwright install firefox && npm run test:e2e
```

---

## BLOCKED in the build sandbox — exact verification procedure
No Supabase/Vercel/Razorpay/ClamAV credentials or services were available, so these were **not** executed against the
real services. Everything else was run (see TEST_RESULTS.md). After deploying, run this checklist:

| # | Item | Procedure | Expected |
|---|---|---|---|
| B1 | Migrations on real Supabase | `supabase db push` | completes without error; `select count(*) from pg_tables where schemaname='public' and rowsecurity` = 23 |
| B2 | anon key has no table access | `curl "$SUPABASE_URL/rest/v1/orders?select=*" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"` | HTTP 401/403 with `permission denied for table orders` (never rows) — repeat for `print_agents`, `uploaded_files`, `payments` |
| B3 | Private bucket | open `https://<ref>.supabase.co/storage/v1/object/public/print-files/anything` | 400/404 "Bucket not public" |
| B4 | Signed upload with progress (browser → Supabase) | On a phone, open the QR URL, upload a 10–20 MB PDF | progress bar advances; card shows page count; row in `uploaded_files` is READY with sha256 |
| B5 | Magic-byte rejection in prod | rename a `.exe`/`.docx` to `.pdf` and upload | card shows "Not a real PDF…"; object absent in Storage |
| B6 | Staff login + RBAC | sign in as STAFF → Settings link hidden; `PUT /api/admin/settings/prices` from devtools | 403 |
| B7 | Realtime | keep dashboard open, submit an order from a phone | appears within ~2 s without reload ("● Live" chip) |
| B8 | Signed preview URL expiry | click Preview, copy URL, retry after 3 min | Supabase returns 400 "Token expired" |
| B9 | Agent end-to-end | install agent, create agent in Admin, send a test order | job goes QUEUED→CLAIMED→…→COMPLETED_SPOOLER; staff Verify → READY |
| B10 | Vercel cron | Vercel → Cron Jobs → Run `/api/cron/retention` | 200 JSON with `purged` |
| B11 | Security headers | `curl -sI https://<domain>/` | `content-security-policy` with `nonce-`, HSTS, `x-frame-options: DENY` |
| B12 | Razorpay (if enabled) | test-mode payment on tracking page | payment appears only after webhook; Razorpay dashboard shows 200 webhook delivery |
| B13 | ClamAV (if enabled) | upload EICAR test file (`X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*` saved as .pdf will fail magic bytes first; instead embed EICAR in a PDF attachment) | file REJECTED "failed the malware scan"; `/api/health` shows `"scanner":"clamav"` |
