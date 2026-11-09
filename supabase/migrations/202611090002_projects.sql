create table public.projects (
  id bigint generated always as identity primary key,
  student_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 200),
  description text,
  content text not null default '' check (length(content) <= 1000000),
  status text not null default 'draft' check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_student on public.projects(student_id);
alter table public.projects enable row level security;
create policy projects_owner on public.projects for all to authenticated
  using (student_id = (select auth.uid()) and exists (
    select 1 from public.profiles where id = auth.uid() and role = 'student' and account_status = 'active'
  )) with check (student_id = (select auth.uid()) and exists (
    select 1 from public.profiles where id = auth.uid() and role = 'student' and account_status = 'active'
  ));
grant select, insert, update, delete on public.projects to authenticated;
grant usage on sequence public.projects_id_seq to authenticated;

create table public.project_versions (
  id bigint generated always as identity primary key,
  project_id bigint not null references public.projects(id) on delete cascade,
  version_number integer not null,
  content text not null,
  created_at timestamptz not null default now(),
  unique(project_id, version_number)
);
alter table public.project_versions enable row level security;
create policy versions_owner_read on public.project_versions for select to authenticated
  using (exists(select 1 from public.projects where id = project_id and student_id = auth.uid()));
grant select on public.project_versions to authenticated;
revoke insert, update, delete on public.project_versions from authenticated, anon;

create function public.version_project() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'INSERT' or new.content is distinct from old.content then
    insert into public.project_versions(project_id, version_number, content)
    select new.id, coalesce(max(version_number),0)+1, new.content
    from public.project_versions where project_id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function public.version_project() from public;
create trigger project_history after insert or update on public.projects
for each row execute function public.version_project();
