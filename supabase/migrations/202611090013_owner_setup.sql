-- The designated address is supplied privately in platform_settings, never source.
create function public.finish_owner_setup() returns trigger language plpgsql security definer set search_path='' as $$
declare owner_email text;
begin
 select value into owner_email from public.platform_settings where key='setup.admin_email' for update;
 if owner_email is not null and owner_email<>'' and lower(new.email)=lower(owner_email) and new.email_confirmed_at is not null then
  update public.profiles set role='admin' where id=new.id;
  if found then update public.platform_settings set value='',updated_at=now() where key='setup.admin_email';end if;
 end if;
 return new;
end; $$;
revoke all on function public.finish_owner_setup() from public;
create trigger zz_finish_owner_setup after insert or update of email_confirmed_at on auth.users for each row execute function public.finish_owner_setup();
