-- OPTIONAL alternative to Vercel Cron: call the retention endpoint daily from Supabase pg_cron + pg_net.
-- Enable extensions pg_cron and pg_net in Supabase → Database → Extensions first. Replace URL and secret.
select cron.schedule(
  'mansa-retention-daily',
  '30 21 * * *',  -- 21:30 UTC = 03:00 IST
  $$ select net.http_post(
       url := 'https://print.example.in/api/cron/retention',
       headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>', 'Content-Type', 'application/json'),
       body := '{}'::jsonb) $$
);
-- To remove: select cron.unschedule('mansa-retention-daily');
