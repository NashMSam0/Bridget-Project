-- Student signup does not verify email. Admin approval must therefore be manual.
drop trigger if exists zz_finish_owner_setup on auth.users;
drop function if exists public.finish_owner_setup();
update public.platform_settings set value='',updated_at=now() where key='setup.admin_email';
