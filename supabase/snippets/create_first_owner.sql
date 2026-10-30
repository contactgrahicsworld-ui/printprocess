-- Run ONCE in Supabase → SQL Editor after creating the user in Authentication → Users.
-- Replace the email. Promotes that existing auth user to OWNER.
insert into public.staff_profiles (user_id, email, full_name, role, active)
select id, email, 'Owner', 'OWNER', true from auth.users where email = 'owner@example.com'
on conflict (user_id) do update set role = 'OWNER', active = true;

-- Add more staff later the same way (role 'ADMIN' or 'STAFF'), or deactivate:
-- update public.staff_profiles set active = false where email = 'someone@example.com';
