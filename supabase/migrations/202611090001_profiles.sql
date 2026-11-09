-- Additive foundation. Does not import, alter or delete the SQL Server database.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (username ~ '^[a-zA-Z0-9_]{3,40}$'),
  display_name text not null check (length(display_name) between 1 and 100),
  role text not null default 'student' check (role in ('student','instructor','admin')),
  account_status text not null default 'active' check (account_status in ('active','suspended')),
  character text not null default 'girl' check (character in ('boy','girl')),
  age_group text,
  preferences jsonb not null default '{"sound":true,"reducedMotion":false,"showHints":true}',
  created_at timestamptz not null default now()
);
create unique index profiles_username_unique on public.profiles(lower(username));
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, character, age_group, preferences) on public.profiles to authenticated;
create policy profiles_read_own on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create function public.create_learner_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- User-editable signup metadata never grants instructor/admin privileges.
  insert into public.profiles(id, username, display_name, character, age_group)
  values (new.id, new.raw_user_meta_data->>'username',
    new.raw_user_meta_data->>'displayName',
    coalesce(new.raw_user_meta_data->>'character','girl'),
    new.raw_user_meta_data->>'ageGroup');
  return new;
end;
$$;
revoke all on function public.create_learner_profile() from public;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.create_learner_profile();

-- Durable per-user quota, shared across Edge Function instances.
create table public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_day date not null,
  requests integer not null default 0,
  primary key (user_id, usage_day)
);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;
create function public.consume_ai_quota() returns boolean
language plpgsql security definer set search_path = '' as $$
declare consumed integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles where id = auth.uid() and account_status = 'active'
  ) then return false; end if;
  insert into public.ai_usage(user_id, usage_day, requests) values (auth.uid(), current_date, 1)
  on conflict (user_id, usage_day) do update set requests = public.ai_usage.requests + 1
    where public.ai_usage.requests < 30
  returning requests into consumed;
  return consumed is not null;
end;
$$;
revoke all on function public.consume_ai_quota() from public;
grant execute on function public.consume_ai_quota() to authenticated;
