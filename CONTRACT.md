# QR-to-Print System — Shared Contract (web app ⇄ Windows Print Agent)

Repo layout (monorepo at /workspace/work/qr-print):
- `web/`   Next.js 14+ App Router, TypeScript, Supabase (Postgres, Auth, private Storage, Realtime)
- `supabase/migrations/` SQL migrations (owned by web team)
- `print-agent/` Node 20 + TypeScript Windows Print Agent (owned by agent team)
- `docs/` deployment, install, verification, final report

## Print Agent authentication
- Admin creates an agent in dashboard → server generates `agent_id` (uuid) + random 32-byte secret, shown ONCE; DB stores sha256(secret) only in `print_agents.secret_hash`.
- Agent config stores the raw secret. HMAC key (both sides) = sha256hex(secret). DB column `print_agents.hmac_key_hash` = sha256hex(hmac key) for lookup is NOT enough to verify HMAC, so DB stores `print_agents.hmac_key` (= sha256hex(secret)) in a column readable only by service role (RLS denies all), never returned by any API.
- Every agent request: headers `X-Agent-Id`, `X-Agent-Timestamp` (unix ms), `X-Agent-Nonce` (uuid), `X-Agent-Signature` = hex HMAC-SHA256(key, `${METHOD}\n${path}\n${timestamp}\n${nonce}\n${sha256hex(body or "")}`). Server rejects if |now - ts| > 5 min, nonce reused (store nonces 10 min), agent revoked, or bad signature (constant-time compare).
- All agent endpoints under `/api/agent/*`, served over HTTPS only.

## Agent endpoints
1. `POST /api/agent/heartbeat`
   body `{ "agentVersion": "1.0.0", "hostname": "...", "printers": [{ "name": "...", "isDefault": true, "status": "Normal|Offline|PaperOut|Error|...", "supportsColor": true, "supportsDuplex": true, "paperSizes": ["A4","A3","Legal"] }] }`
   → `200 { "ok": true, "serverTime": 1730000000000 }`
2. `POST /api/agent/jobs/claim`
   body `{ "printers": ["HP LaserJet"] }`
   → `200 { "jobs": [PrintJob] }` — atomically moves up to 5 `print_jobs` rows from `QUEUED` to `CLAIMED` for this agent (SELECT ... FOR UPDATE SKIP LOCKED). A job already CLAIMED by this agent and not finished is returned again (idempotent resume).
   PrintJob = `{ "jobId": uuid, "orderNumber": "MP-20261030-0042", "orderItemId": uuid, "attempt": 1, "printerName": "HP LaserJet" | null, "fileName": "notes.pdf", "mimeType": "application/pdf", "sha256": "<hex of file>", "downloadUrl": "<signed URL, expires in 10 min>", "settings": { "colorMode": "BW|COLOR", "duplex": "SINGLE|DOUBLE", "paperSize": "A4|A3|LEGAL", "copies": 2, "pageRanges": "1-3,7" | null } }`
3. `POST /api/agent/jobs/{jobId}/status`
   body `{ "status": "DOWNLOADED|SUBMITTED|SPOOLED|PRINTING|COMPLETED_SPOOLER|FAILED|PRINTER_OFFLINE|PAPER_OUT|ERROR", "spoolerJobId": 12 | null, "detail": "text", "pagesPrinted": 4 | null, "at": unixMs }`
   → `200 { "ok": true }`. Status updates are append-only into `print_job_events`; `print_jobs.status` is updated monotonic-safe. Server NEVER sets order to READY from agent alone; COMPLETED_SPOOLER means "spooler reports job finished/left queue with no error" — NOT physically verified. Physical verification = staff clicks "Verify printed" in dashboard → `print_jobs.verified_by`, `verified_at`, job status `VERIFIED`.
   Idempotency: same (jobId, status) sent twice is a no-op.

## Job state machine (print_jobs.status)
QUEUED → CLAIMED → DOWNLOADED → SUBMITTED → SPOOLED → PRINTING → COMPLETED_SPOOLER → VERIFIED
Any of CLAIMED..PRINTING → FAILED | PRINTER_OFFLINE | PAPER_OUT | ERROR (admin can re-queue → new attempt row / attempt+1)
Admin can CANCEL a QUEUED/CLAIMED job.

## Duplicate prevention
- Server: a job is created only when admin clicks "Send to printer" on an APPROVED order item; unique partial index prevents two active (non-terminal) jobs per order_item.
- Agent: local SQLite/JSON log keyed by jobId+attempt; never submits to spooler twice for the same jobId+attempt; on restart, reconciles SUBMITTED jobs with spooler by stored spoolerJobId/document name `MP:{orderNumber}:{jobId}`.

## Sheet calculation (shared rule, implement identically & unit test)
pages_selected = count of pages in ranges (or total pages); images = 1 page each.
sheets_per_copy = duplex DOUBLE ? ceil(pages_selected/2) : pages_selected
total_sheets = sheets_per_copy * copies
printed_sides = pages_selected * copies
Price (server-side only): per printed side: base rate by colorMode (BW/COLOR) × paper-size multiplier/rate, side rate per side for SINGLE or DOUBLE, plus per-order service charges. Exact formula documented in docs/PRICING.md and configurable in `price_settings`. All money in paise (integers).

## Order statuses
RECEIVED, UNDER_REVIEW, APPROVED, PRINTING, READY, DELIVERED, CANCELLED.

## Changes
### 2026-10-30 — print agent (no API shape changes; clarifications + one naming deviation)
1. **Spooler document name** (deviation from `MP:{orderNumber}:{jobId}`): Windows file names cannot contain `:` and SumatraPDF sets the spooler document name from the file it prints. The agent therefore prints a temp file named `MP_{orderNumber}_{jobId}.pdf` (characters outside `[A-Za-z0-9._-]` replaced by `-`). The spooler `Document` is that name, sometimes with the full path. The agent matches its job by `jobId` substring plus the submit time window, or by the stored `spoolerJobId`. Dashboard/staff should search the Windows queue for `MP_<orderNumber>_`.
2. **HMAC key encoding** (clarification, matches `web/src/lib/security/crypto.ts`): key = `sha256hex(secret)` as the 64-char lowercase **hex string used as UTF-8 key bytes** (not hex-decoded). `path` = URL pathname without query string. Nonce = UUID v4, timestamp = integer unix ms.
3. **Printer not ready before submit** (clarification of agent behaviour, required by the server state machine where `PRINTER_OFFLINE | PAPER_OUT | ERROR` are terminal and re-queue creates a new job row): while the printer is offline, out of paper or in error **before** submission, the agent does **not** send a failure status. The job stays `CLAIMED`/`DOWNLOADED`, so it cannot be re-queued into a duplicate, and the agent retries with backoff. The printer's state reaches the dashboard through `heartbeat.printers[].status`, and the agent sends an immediate heartbeat when the condition changes. If the printer is still not ready after `maxPrinterWaitMs` (default 15 min), the agent sends the matching `PRINTER_OFFLINE | PAPER_OUT | ERROR` once, as final, with detail "Job was NOT sent to the printer — safe to re-queue", and never prints that jobId+attempt. **Web suggestion:** show the agent's printer status next to CLAIMED/DOWNLOADED jobs.
4. **Errors after submission:** the agent reports `PAPER_OUT | PRINTER_OFFLINE | ERROR` as soon as the spooler job carries the flag. The detail says the job is still in the Windows queue and may resume, so staff should check before re-queueing. The agent keeps monitoring and, when the job leaves the queue, sends a final `ERROR` event with the evidence. The server keeps the first failure status (monotonic rule), and that later event is informational only. `COMPLETED_SPOOLER` is never sent after an error flag was seen.
5. **Page ranges:** before printing, the agent merges and sorts overlapping ranges exactly like `web/src/lib/print/pages.ts` and accepts `all`/empty as every page, so the pages printed equal the pages charged.

### 2026-10-30 — web app / server (no API shape changes; clarifications + one additive behaviour)
1. **Error responses** (clarification): all `/api/agent/*` errors are JSON `{ "error": CODE, "message": text, ...}`.
   `401 AGENT_AUTH_FAILED` (with `reason`: `missing_or_malformed_headers | timestamp_out_of_window | bad_signature | agent_revoked | nonce_replayed`)
   for any authentication failure — do not retry with the same nonce; `400 VALIDATION | BAD_JSON`; `404 NOT_FOUND` for a jobId
   that does not exist **or is not claimed by this agent**; `413 TOO_LARGE` (body > 256 KB heartbeat / 64 KB others); `500 INTERNAL`.
2. **Claim resume** (clarification): "already claimed and not finished" = this agent's jobs in `CLAIMED | DOWNLOADED | SUBMITTED | SPOOLED | PRINTING`.
   They are returned first (with a fresh 10-min `downloadUrl`), then new `QUEUED` jobs, max 5 total. A job is only claimable when its
   `printerName` is null or is in the request's `printers` list, its target agent (chosen by staff) is this agent, and the order is
   `APPROVED | PRINTING`. Files purged by retention are never handed out.
3. **Status updates on terminal jobs** (clarification): if staff cancelled or verified a job (or it already failed), later agent
   reports still get `200 {"ok":true}` and are appended to `print_job_events`, but `print_jobs.status` does not change.
   The first failure status wins (matches agent Change #4).
4. **`pageRanges` in PrintJob** are already normalised by the server (sorted, merged, e.g. `"1-4,7"`) or `null` = all pages.
5. **Staff "Verify printed"** (additive): staff may verify a job in `SUBMITTED | SPOOLED | PRINTING | COMPLETED_SPOOLER` (a physical check
   overrides a spooler that never reports completion). The dashboard labels `COMPLETED_SPOOLER` as "Spooler finished — NOT verified".
   The agent never sends `VERIFIED`, and the server never sets an order to READY because of an agent report alone.
6. **Revoking an agent** (additive) returns its `CLAIMED` (not yet downloaded) jobs to `QUEUED`; any jobs further along stay with it and
   further requests from the revoked agent get `401`.
7. **Re-queue** creates a new `print_jobs` row with `attempt + 1` and a new `jobId` (old row kept as history). The agent's
   jobId+attempt log therefore never sees a reused pair.
