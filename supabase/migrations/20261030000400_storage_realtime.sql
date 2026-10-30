-- Private storage bucket for customer files. No public access; files are only reachable through
-- short-lived signed URLs minted server-side with the service role.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('print-files', 'print-files', false, 26214400, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Staff may read objects in the bucket (e.g. dashboard previews via their own session). No insert/update/delete
-- policies exist for anon/authenticated: uploads use one-time signed upload URLs issued by the server.
drop policy if exists "print-files staff read" on storage.objects;
create policy "print-files staff read" on storage.objects for select to authenticated
  using (bucket_id = 'print-files' and public.is_staff());

-- Realtime: dashboard subscribes to these tables (RLS staff_read policies apply to Realtime too).
alter publication supabase_realtime add table public.orders, public.print_jobs, public.payments, public.print_agents;
