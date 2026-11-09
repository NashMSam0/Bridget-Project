create function public.current_app_role() returns text language sql stable security definer set search_path='' as $$
  select role from public.profiles where id=auth.uid() and account_status='active';
$$;
revoke all on function public.current_app_role() from public;
grant execute on function public.current_app_role() to authenticated;
create table public.classes(
  id bigint generated always as identity primary key,
  instructor_id uuid not null references public.profiles(id),
  name text not null check(length(trim(name)) between 1 and 200),description text,
  join_code text unique,join_code_expires_at timestamptz,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.class_memberships(
  id bigint generated always as identity primary key,
  class_id bigint not null references public.classes(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),unique(class_id,student_id)
);
create function public.can_manage_class(class_ref bigint) returns boolean language sql stable security definer set search_path='' as $$
 select public.current_app_role()='admin' or (public.current_app_role()='instructor' and exists(select 1 from public.classes where id=class_ref and instructor_id=auth.uid()));
$$;
create function public.is_class_member(class_ref bigint) returns boolean language sql stable security definer set search_path='' as $$
 select public.current_app_role()='student' and exists(select 1 from public.class_memberships where class_id=class_ref and student_id=auth.uid());
$$;
revoke all on function public.can_manage_class(bigint),public.is_class_member(bigint) from public;
grant execute on function public.can_manage_class(bigint),public.is_class_member(bigint) to authenticated;
alter table public.classes enable row level security;
alter table public.class_memberships enable row level security;
revoke all on public.classes,public.class_memberships from anon,authenticated;
grant select,insert,update,delete on public.classes,public.class_memberships to authenticated;
grant usage on sequence public.classes_id_seq,public.class_memberships_id_seq to authenticated;
create policy classes_read on public.classes for select to authenticated using(public.can_manage_class(id) or public.is_class_member(id));
create policy classes_insert on public.classes for insert to authenticated with check(instructor_id=auth.uid() and public.current_app_role() in ('instructor','admin'));
create policy classes_update on public.classes for update to authenticated using(public.can_manage_class(id)) with check(public.can_manage_class(id));
create policy classes_delete on public.classes for delete to authenticated using(public.can_manage_class(id));
create policy memberships_read on public.class_memberships for select to authenticated using(public.can_manage_class(class_id) or student_id=auth.uid());
create policy memberships_insert on public.class_memberships for insert to authenticated with check(public.can_manage_class(class_id) and exists(select 1 from public.profiles where id=student_id and role='student' and account_status='active'));
create policy memberships_delete on public.class_memberships for delete to authenticated using(public.can_manage_class(class_id));

create table public.assignments(
  id bigint generated always as identity primary key,
  instructor_id uuid not null references public.profiles(id),
  class_id bigint not null references public.classes(id) on delete cascade,
  title text not null check(length(trim(title)) between 1 and 200),description text,
  mission_ids integer[] not null default '{}',deadline timestamptz,
  status text not null default 'draft' check(status in ('draft','published','closed')),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.assignment_submissions(
  id bigint generated always as identity primary key,
  assignment_id bigint not null references public.assignments(id) on delete cascade,
  student_id uuid not null references public.profiles(id),
  status text not null default 'submitted' check(status in ('submitted','graded')),
  score integer check(score between 0 and 100),feedback text,notes text,
  submitted_at timestamptz not null default now(),created_at timestamptz not null default now(),
  unique(assignment_id,student_id)
);
alter table public.assignments enable row level security;
alter table public.assignment_submissions enable row level security;
revoke all on public.assignments,public.assignment_submissions from anon,authenticated;
grant select,insert,update,delete on public.assignments to authenticated;
grant select on public.assignment_submissions to authenticated;
grant usage on sequence public.assignments_id_seq to authenticated;
create policy assignments_read on public.assignments for select to authenticated using(public.can_manage_class(class_id) or (status<>'draft' and public.is_class_member(class_id)));
create policy assignments_insert on public.assignments for insert to authenticated with check(instructor_id=auth.uid() and public.can_manage_class(class_id));
create policy assignments_update on public.assignments for update to authenticated using(public.can_manage_class(class_id)) with check(public.can_manage_class(class_id));
create policy assignments_delete on public.assignments for delete to authenticated using(public.can_manage_class(class_id));
create policy submissions_read on public.assignment_submissions for select to authenticated using(student_id=auth.uid() or exists(select 1 from public.assignments where id=assignment_id and public.can_manage_class(class_id)));

create function public.join_class(p_code text) returns bigint language plpgsql security definer set search_path='' as $$
declare class_ref bigint;
begin
 if public.current_app_role() is distinct from 'student' then raise exception 'Student access required'; end if;
 select id into class_ref from public.classes where join_code=upper(trim(p_code)) and join_code_expires_at>now();
 if class_ref is null then raise exception 'Join code is invalid or expired'; end if;
 insert into public.class_memberships(class_id,student_id) values(class_ref,auth.uid()) on conflict do nothing;
 return class_ref;
end; $$;
revoke all on function public.join_class(text) from public;
grant execute on function public.join_class(text) to authenticated;
create function public.submit_assignment(p_assignment bigint,p_notes text) returns bigint language plpgsql security definer set search_path='' as $$
declare result bigint; assignment public.assignments;
begin
 if public.current_app_role() is distinct from 'student' then raise exception 'Student access required'; end if;
 select * into assignment from public.assignments where id=p_assignment;
 if assignment.id is null or assignment.status<>'published' or not public.is_class_member(assignment.class_id) then raise exception 'Assignment unavailable'; end if;
 if length(p_notes)>10000 then raise exception 'Notes too long'; end if;
 insert into public.assignment_submissions(assignment_id,student_id,notes) values(p_assignment,auth.uid(),p_notes)
 on conflict(assignment_id,student_id) do update set notes=excluded.notes,submitted_at=now() where public.assignment_submissions.status<>'graded'
 returning id into result;
 if result is null then raise exception 'A graded submission cannot be changed'; end if;
 return result;
end; $$;
revoke all on function public.submit_assignment(bigint,text) from public;
grant execute on function public.submit_assignment(bigint,text) to authenticated;
create function public.grade_submission(p_submission bigint,p_score integer,p_feedback text) returns void language plpgsql security definer set search_path='' as $$
begin
 if p_score not between 0 and 100 or length(p_feedback)>10000 then raise exception 'Invalid grade'; end if;
 update public.assignment_submissions s set score=p_score,feedback=p_feedback,status='graded'
 where s.id=p_submission and exists(select 1 from public.assignments a where a.id=s.assignment_id and public.can_manage_class(a.class_id));
 if not found then raise exception 'Submission unavailable'; end if;
end; $$;
revoke all on function public.grade_submission(bigint,integer,text) from public;
grant execute on function public.grade_submission(bigint,integer,text) to authenticated;
