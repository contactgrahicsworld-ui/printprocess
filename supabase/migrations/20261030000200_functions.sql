-- Functions: counters / order numbers, status-transition guard, atomic job claim, rate limiting, staff helpers.

-- Atomic per-scope counter (safe under concurrency: single-row upsert takes a row lock).
create or replace function public.next_counter(p_scope text)
returns bigint language sql volatile set search_path = public as $$
  insert into public.counters as c (scope, value) values (p_scope, 1)
  on conflict (scope) do update set value = c.value + 1
  returning c.value;
$$;

-- MP-YYYYMMDD-NNNN, day in Asia/Kolkata, per-day sequence (grows past 4 digits if ever needed).
create or replace function public.next_order_number(p_at timestamptz default now())
returns text language plpgsql volatile set search_path = public as $$
declare
  v_day text := to_char(p_at at time zone 'Asia/Kolkata', 'YYYYMMDD');
  v_n bigint := public.next_counter('order:' || v_day);
begin
  return 'MP-' || v_day || '-' || case when v_n < 10000 then lpad(v_n::text, 4, '0') else v_n::text end;
end $$;

-- R-YYYY-NNNNN, financial counter per calendar year (Asia/Kolkata).
create or replace function public.next_receipt_number(p_at timestamptz default now())
returns text language plpgsql volatile set search_path = public as $$
declare
  v_year text := to_char(p_at at time zone 'Asia/Kolkata', 'YYYY');
  v_n bigint := public.next_counter('receipt:' || v_year);
begin
  return 'MP-R-' || v_year || '-' || case when v_n < 100000 then lpad(v_n::text, 5, '0') else v_n::text end;
end $$;

-- Order status machine. Mirrors web/src/lib/orders/status.ts (unit tested on both sides).
create or replace function public.order_transition_allowed(p_from public.order_status, p_to public.order_status)
returns boolean language sql immutable as $$
  select case p_from
    when 'RECEIVED'     then p_to in ('UNDER_REVIEW', 'APPROVED', 'CANCELLED')
    when 'UNDER_REVIEW' then p_to in ('APPROVED', 'CANCELLED')
    when 'APPROVED'     then p_to in ('UNDER_REVIEW', 'PRINTING', 'CANCELLED')
    when 'PRINTING'     then p_to in ('APPROVED', 'READY', 'CANCELLED')
    when 'READY'        then p_to in ('PRINTING', 'DELIVERED')
    else false  -- DELIVERED, CANCELLED are terminal
  end;
$$;

create or replace function public.orders_status_guard()
returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if not public.order_transition_allowed(old.status, new.status) then
      raise exception 'invalid order status transition % -> %', old.status, new.status
        using errcode = 'P0001', hint = 'INVALID_STATUS_TRANSITION';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger orders_status_guard before update on public.orders
  for each row execute function public.orders_status_guard();

create or replace function public.orders_insert_guard()
returns trigger language plpgsql as $$
begin
  if new.status <> 'RECEIVED' then
    raise exception 'orders must start as RECEIVED' using errcode = 'P0001', hint = 'INVALID_STATUS_TRANSITION';
  end if;
  return new;
end $$;
create trigger orders_insert_guard before insert on public.orders
  for each row execute function public.orders_insert_guard();

-- Payments keep orders.paid_paise in sync and can never exceed total.
create or replace function public.payments_apply()
returns trigger language plpgsql as $$
declare v_total integer; v_paid integer;
begin
  select total_paise, paid_paise into v_total, v_paid from public.orders where id = new.order_id for update;
  if v_paid + new.amount_paise > v_total then
    raise exception 'payment exceeds due amount' using errcode = 'P0001', hint = 'OVERPAYMENT';
  end if;
  update public.orders set paid_paise = paid_paise + new.amount_paise where id = new.order_id;
  return new;
end $$;
create trigger payments_apply after insert on public.payments
  for each row execute function public.payments_apply();

-- Append-only tables.
create or replace function public.reject_mutation()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'P0001', hint = 'APPEND_ONLY';
end $$;
create trigger audit_logs_append_only before update or delete on public.audit_logs
  for each row execute function public.reject_mutation();
create trigger print_job_events_append_only before update or delete on public.print_job_events
  for each row execute function public.reject_mutation();
create trigger payments_append_only before update or delete on public.payments
  for each row execute function public.reject_mutation();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function public.reject_mutation();
create trigger print_job_events_no_truncate before truncate on public.print_job_events
  for each statement execute function public.reject_mutation();
create trigger payments_no_truncate before truncate on public.payments
  for each statement execute function public.reject_mutation();

-- Atomic job claim (CONTRACT.md §2). Returns this agent's unfinished jobs first (idempotent resume),
-- then claims QUEUED jobs with FOR UPDATE SKIP LOCKED, never more than p_limit (max 5) in total.
create or replace function public.claim_print_jobs(p_agent uuid, p_printers text[], p_limit integer default 5)
returns setof public.print_jobs
language plpgsql volatile security definer set search_path = public as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 5);
  v_existing integer;
  r public.print_jobs;
begin
  if not exists (select 1 from public.print_agents where id = p_agent and revoked_at is null) then
    raise exception 'agent revoked or unknown' using errcode = 'P0001', hint = 'AGENT_REVOKED';
  end if;

  return query
    select j.* from public.print_jobs j
    where j.claimed_by_agent = p_agent
      and j.status in ('CLAIMED', 'DOWNLOADED', 'SUBMITTED', 'SPOOLED', 'PRINTING')
    order by j.claimed_at, j.created_at
    limit v_limit;
  get diagnostics v_existing = row_count;

  if v_existing < v_limit then
    for r in
      with picked as (
        select q.id from public.print_jobs q
        join public.orders o on o.id = q.order_id
        where q.status = 'QUEUED'
          and o.status in ('APPROVED', 'PRINTING')
          and (q.target_agent_id is null or q.target_agent_id = p_agent)
          and (q.printer_name is null or q.printer_name = any (coalesce(p_printers, '{}'::text[])))
        order by q.created_at
        limit v_limit - v_existing
        for update of q skip locked
      )
      update public.print_jobs j
         set status = 'CLAIMED', claimed_by_agent = p_agent, claimed_at = now(), updated_at = now()
        from picked where j.id = picked.id
      returning j.*
    loop
      insert into public.print_job_events (job_id, source, status, detail)
        values (r.id, 'SYSTEM', 'CLAIMED', 'claimed by agent ' || p_agent::text);
      return next r;
    end loop;
  end if;
end $$;

-- Fixed-window rate limiter. Returns true if the hit is allowed.
create or replace function public.rate_limit_hit(p_key text, p_max integer, p_window_seconds integer)
returns boolean language plpgsql volatile set search_path = public as $$
declare v_count integer;
begin
  insert into public.rate_limits as r (key, window_start, count) values (p_key, now(), 1)
  on conflict (key) do update set
    count = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.count + 1 end,
    window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning count into v_count;
  return v_count <= p_max;
end $$;

-- Staff helpers for RLS (security definer so policies don't recurse into staff_profiles RLS).
create or replace function public.current_staff_role()
returns public.staff_role language sql stable security definer set search_path = public as $$
  select role from public.staff_profiles where user_id = auth.uid() and active;
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_staff_role() is not null;
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_staff_role() in ('OWNER', 'ADMIN'), false);
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_staff_role() = 'OWNER', false);
$$;
