-- Mansa Printer QR-to-Print: core schema
-- Money is always integer paise. Timestamps are timestamptz (UTC); order numbers use Asia/Kolkata calendar day.

create type public.staff_role as enum ('OWNER', 'ADMIN', 'STAFF');
create type public.order_status as enum ('RECEIVED', 'UNDER_REVIEW', 'APPROVED', 'PRINTING', 'READY', 'DELIVERED', 'CANCELLED');
create type public.color_mode as enum ('BW', 'COLOR');
create type public.duplex_mode as enum ('SINGLE', 'DOUBLE');
create type public.paper_size as enum ('A4', 'A3', 'LEGAL');
create type public.file_status as enum ('PENDING_UPLOAD', 'READY', 'REJECTED', 'REMOVED', 'PURGED');
create type public.scan_status as enum ('NOT_SCANNED', 'CLEAN', 'INFECTED', 'ERROR');
create type public.session_status as enum ('OPEN', 'SUBMITTED', 'EXPIRED');
create type public.print_job_status as enum (
  'QUEUED', 'CLAIMED', 'DOWNLOADED', 'SUBMITTED', 'SPOOLED', 'PRINTING', 'COMPLETED_SPOOLER', 'VERIFIED',
  'FAILED', 'PRINTER_OFFLINE', 'PAPER_OUT', 'ERROR', 'CANCELLED');
create type public.payment_method as enum ('CASH', 'UPI', 'ONLINE');
create type public.service_unit as enum ('PER_ORDER', 'PER_DOCUMENT', 'PER_COPY');

-- ---------------------------------------------------------------- settings
create table public.shop_settings (
  id smallint primary key default 1 check (id = 1),
  shop_name text not null default 'Mansa Printer',
  address text not null default 'Bhilai, Chhattisgarh',
  phone text,
  gstin text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  upi_id text check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,255}@[A-Za-z0-9.-]{2,64}$'),
  upi_payee_name text,
  max_file_bytes integer not null default 26214400 check (max_file_bytes between 1024 and 52428800),
  max_files integer not null default 10 check (max_files between 1 and 50),
  session_ttl_minutes integer not null default 120 check (session_ttl_minutes between 10 and 1440),
  retention_days integer not null default 7 check (retention_days between 1 and 365),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table public.staff_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null default '',
  role public.staff_role not null default 'STAFF',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.shop_qr_codes (
  id uuid primary key default gen_random_uuid(),
  token text not null unique check (length(token) >= 16),
  label text not null default 'Counter QR',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  deactivated_at timestamptz,
  deactivated_by uuid
);
-- At most one active QR at any time.
create unique index shop_qr_codes_one_active on public.shop_qr_codes ((true)) where active;

-- Base per-side rates (A4). See docs/PRICING.md.
create table public.price_settings (
  id smallint primary key default 1 check (id = 1),
  bw_single_side_paise integer not null check (bw_single_side_paise >= 0),
  bw_double_side_paise integer not null check (bw_double_side_paise >= 0),
  color_single_side_paise integer not null check (color_single_side_paise >= 0),
  color_double_side_paise integer not null check (color_double_side_paise >= 0),
  min_order_paise integer not null default 0 check (min_order_paise >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table public.paper_size_rates (
  paper_size public.paper_size primary key,
  multiplier_bp integer not null check (multiplier_bp between 1 and 1000000), -- 10000 = 1.00x
  enabled boolean not null default true
);

create table public.paper_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  surcharge_per_sheet_paise integer not null default 0 check (surcharge_per_sheet_paise >= 0),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9_]{2,32}$'),
  name text not null,
  unit public.service_unit not null,
  amount_paise integer not null check (amount_paise >= 0),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- customer side
create table public.upload_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  qr_code_id uuid not null references public.shop_qr_codes (id),
  status public.session_status not null default 'OPEN',
  ip_hash text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  submitted_at timestamptz
);
create index upload_sessions_expires on public.upload_sessions (expires_at) where status = 'OPEN';

create table public.uploaded_files (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.upload_sessions (id) on delete cascade,
  original_name text not null check (length(original_name) between 1 and 255),
  storage_path text not null unique,
  declared_size bigint not null check (declared_size > 0),
  size_bytes bigint,
  detected_mime text check (detected_mime in ('application/pdf', 'image/jpeg', 'image/png')),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  page_count integer check (page_count > 0),
  status public.file_status not null default 'PENDING_UPLOAD',
  scan_status public.scan_status not null default 'NOT_SCANNED',
  scan_detail text,
  reject_reason text,
  created_at timestamptz not null default now(),
  uploaded_at timestamptz,
  purged_at timestamptz,
  constraint ready_file_complete check (status <> 'READY' or (size_bytes is not null and detected_mime is not null and sha256 is not null and page_count is not null))
);
create index uploaded_files_session on public.uploaded_files (session_id);
create index uploaded_files_retention on public.uploaded_files (created_at) where status <> 'PURGED';

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique check (order_number ~ '^MP-[0-9]{8}-[0-9]{4,}$'),
  session_id uuid not null unique references public.upload_sessions (id),
  idempotency_key text not null check (length(idempotency_key) between 8 and 100),
  customer_name text not null check (length(customer_name) between 1 and 100),
  customer_phone text check (customer_phone is null or customer_phone ~ '^[6-9][0-9]{9}$'),
  notes text check (notes is null or length(notes) <= 1000),
  status public.order_status not null default 'RECEIVED',
  tracking_token_hash text not null,
  items_total_paise integer not null check (items_total_paise >= 0),
  services_total_paise integer not null default 0 check (services_total_paise >= 0),
  adjustment_paise integer not null default 0,
  total_paise integer not null check (total_paise >= 0),
  paid_paise integer not null default 0 check (paid_paise >= 0),
  due_paise integer generated always as (total_paise - paid_paise) stored,
  order_services jsonb not null default '[]'::jsonb,
  assigned_to uuid references public.staff_profiles (user_id),
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, idempotency_key)
);
create index orders_status_created on public.orders (status, created_at desc);
create index orders_assigned on public.orders (assigned_to) where assigned_to is not null;

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  file_id uuid not null unique references public.uploaded_files (id),
  position integer not null,
  color_mode public.color_mode not null,
  duplex public.duplex_mode not null,
  paper_size public.paper_size not null,
  copies integer not null check (copies between 1 and 500),
  page_ranges text check (page_ranges is null or length(page_ranges) <= 200),
  paper_type_id uuid references public.paper_types (id),
  service_codes text[] not null default '{}',
  instructions text check (instructions is null or length(instructions) <= 500),
  pages_total integer not null check (pages_total > 0),
  pages_selected integer not null check (pages_selected > 0 and pages_selected <= pages_total),
  sheets_per_copy integer not null check (sheets_per_copy > 0),
  total_sheets integer not null check (total_sheets > 0),
  printed_sides integer not null check (printed_sides > 0),
  price_paise integer not null check (price_paise >= 0),
  price_breakdown jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, position)
);
create index order_items_order on public.order_items (order_id);

create table public.order_item_revisions (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references public.order_items (id) on delete cascade,
  changed_by uuid not null,
  before jsonb not null,
  after jsonb not null,
  reason text,
  created_at timestamptz not null default now()
);
create index order_item_revisions_item on public.order_item_revisions (order_item_id, created_at);

create table public.order_status_history (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  from_status public.order_status,
  to_status public.order_status not null,
  changed_by uuid,
  reason text,
  created_at timestamptz not null default now()
);
create index order_status_history_order on public.order_status_history (order_id, created_at);

-- ---------------------------------------------------------------- print agents & jobs
create table public.print_agents (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  secret_hash text not null,           -- sha256hex(secret)  (never returned)
  hmac_key text not null,              -- sha256hex(secret) = HMAC key, service-role only (never returned)
  created_by uuid,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid,
  last_heartbeat_at timestamptz,
  agent_version text,
  hostname text,
  printers jsonb not null default '[]'::jsonb
);

create table public.agent_nonces (
  agent_id uuid not null references public.print_agents (id) on delete cascade,
  nonce text not null,
  created_at timestamptz not null default now(),
  primary key (agent_id, nonce)
);
create index agent_nonces_created on public.agent_nonces (created_at);

create table public.print_jobs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  order_item_id uuid not null references public.order_items (id) on delete cascade,
  file_id uuid not null references public.uploaded_files (id),
  attempt integer not null default 1 check (attempt >= 1),
  status public.print_job_status not null default 'QUEUED',
  target_agent_id uuid references public.print_agents (id),
  printer_name text,
  settings jsonb not null,
  claimed_by_agent uuid references public.print_agents (id),
  claimed_at timestamptz,
  spooler_job_id integer,
  pages_printed integer,
  last_detail text,
  requeued_from uuid references public.print_jobs (id),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  verified_by uuid,
  verified_at timestamptz,
  cancelled_by uuid,
  cancelled_at timestamptz,
  unique (order_item_id, attempt),
  constraint verified_has_actor check (status <> 'VERIFIED' or (verified_by is not null and verified_at is not null))
);
-- Duplicate prevention: at most one non-terminal job per order item.
create unique index print_jobs_one_active_per_item on public.print_jobs (order_item_id)
  where status in ('QUEUED', 'CLAIMED', 'DOWNLOADED', 'SUBMITTED', 'SPOOLED', 'PRINTING', 'COMPLETED_SPOOLER');
create index print_jobs_queue on public.print_jobs (created_at) where status = 'QUEUED';
create index print_jobs_order on public.print_jobs (order_id);

create table public.print_job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.print_jobs (id) on delete cascade,
  source text not null check (source in ('AGENT', 'STAFF', 'SYSTEM')),
  status public.print_job_status not null,
  spooler_job_id integer,
  pages_printed integer,
  detail text,
  agent_at timestamptz,
  actor uuid,
  created_at timestamptz not null default now()
);
-- Contract: same (jobId, status) from the agent twice is a no-op.
create unique index print_job_events_agent_once on public.print_job_events (job_id, status) where source = 'AGENT';
create index print_job_events_job on public.print_job_events (job_id, created_at);

-- ---------------------------------------------------------------- money
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  method public.payment_method not null,
  amount_paise integer not null check (amount_paise > 0),
  reference text check (reference is null or length(reference) <= 100),
  gateway_payment_id text unique,
  note text,
  recorded_by uuid,
  created_at timestamptz not null default now(),
  constraint upi_needs_reference check (method <> 'UPI' or reference is not null),
  constraint online_needs_ref check (method <> 'ONLINE' or gateway_payment_id is not null or reference is not null)
);
create index payments_order on public.payments (order_id);

create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_number text not null unique,
  order_id uuid not null references public.orders (id) on delete cascade,
  snapshot jsonb not null,
  issued_by uuid not null,
  issued_at timestamptz not null default now()
);
create index receipts_order on public.receipts (order_id);

create table public.razorpay_orders (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  rz_order_id text not null unique,
  amount_paise integer not null check (amount_paise > 0),
  status text not null default 'CREATED',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- infra
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor uuid,
  actor_role text,
  action text not null,
  entity_type text not null,
  entity_id text,
  detail jsonb not null default '{}'::jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index audit_logs_entity on public.audit_logs (entity_type, entity_id, created_at desc);
create index audit_logs_created on public.audit_logs (created_at desc);

create table public.counters (
  scope text primary key,
  value bigint not null
);

create table public.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  count integer not null
);
