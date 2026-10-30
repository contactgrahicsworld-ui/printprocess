-- Row Level Security. anon has NO direct table access. All customer flows go through server routes
-- (direct Postgres connection as table owner / service role) with strict checks.
-- Authenticated users only see data if they have an active staff_profiles row.

do $$
declare t text;
begin
  foreach t in array array[
    'shop_settings','staff_profiles','shop_qr_codes','price_settings','paper_size_rates','paper_types','services',
    'upload_sessions','uploaded_files','orders','order_items','order_item_revisions','order_status_history',
    'print_agents','agent_nonces','print_jobs','print_job_events','payments','receipts','razorpay_orders',
    'audit_logs','counters','rate_limits']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

revoke execute on function public.claim_print_jobs(uuid, text[], integer) from public, anon, authenticated;
revoke execute on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
revoke execute on function public.next_counter(text) from public, anon, authenticated;
revoke execute on function public.next_order_number(timestamptz) from public, anon, authenticated;
revoke execute on function public.next_receipt_number(timestamptz) from public, anon, authenticated;

-- Read access for staff (needed for dashboard reads + Realtime postgres_changes).
grant select on public.orders, public.order_items, public.order_item_revisions, public.order_status_history,
  public.print_jobs, public.print_job_events, public.payments, public.receipts, public.uploaded_files,
  public.staff_profiles, public.shop_settings, public.price_settings, public.paper_size_rates, public.paper_types,
  public.services, public.shop_qr_codes to authenticated;

create policy staff_read on public.orders for select to authenticated using (public.is_staff());
create policy staff_read on public.order_items for select to authenticated using (public.is_staff());
create policy staff_read on public.order_item_revisions for select to authenticated using (public.is_staff());
create policy staff_read on public.order_status_history for select to authenticated using (public.is_staff());
create policy staff_read on public.print_jobs for select to authenticated using (public.is_staff());
create policy staff_read on public.print_job_events for select to authenticated using (public.is_staff());
create policy staff_read on public.payments for select to authenticated using (public.is_staff());
create policy staff_read on public.receipts for select to authenticated using (public.is_staff());
create policy staff_read on public.uploaded_files for select to authenticated using (public.is_staff());
create policy staff_read on public.staff_profiles for select to authenticated using (public.is_staff());
create policy staff_read on public.shop_settings for select to authenticated using (public.is_staff());
create policy staff_read on public.price_settings for select to authenticated using (public.is_staff());
create policy staff_read on public.paper_size_rates for select to authenticated using (public.is_staff());
create policy staff_read on public.paper_types for select to authenticated using (public.is_staff());
create policy staff_read on public.services for select to authenticated using (public.is_staff());
create policy staff_read on public.shop_qr_codes for select to authenticated using (public.is_staff());

-- Staff may move orders through the workflow directly (the status trigger still enforces transitions).
grant update (status, assigned_to, rejection_reason) on public.orders to authenticated;
create policy staff_update on public.orders for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- Settings: OWNER/ADMIN only.
grant insert, update on public.price_settings, public.paper_size_rates, public.shop_settings to authenticated;
grant insert, update, delete on public.paper_types, public.services, public.shop_qr_codes to authenticated;
create policy admin_write on public.price_settings for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_write on public.paper_size_rates for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_write on public.shop_settings for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_write on public.paper_types for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_write on public.services for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_write on public.shop_qr_codes for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Staff management: OWNER only.
grant insert, update, delete on public.staff_profiles to authenticated;
create policy owner_write on public.staff_profiles for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- Print agents: OWNER/ADMIN may read NON-SECRET columns only. secret_hash / hmac_key are never granted.
grant select (id, name, created_by, created_at, revoked_at, revoked_by, last_heartbeat_at, agent_version, hostname, printers)
  on public.print_agents to authenticated;
create policy admin_read on public.print_agents for select to authenticated using (public.is_admin());

-- Audit log: OWNER/ADMIN read; nobody writes through the API (server inserts as table owner).
grant select on public.audit_logs to authenticated;
create policy admin_read on public.audit_logs for select to authenticated using (public.is_admin());

-- upload_sessions, agent_nonces, counters, rate_limits, razorpay_orders: no policies => deny all for anon/authenticated.
