create table public.mission_progress(
  student_id uuid not null references public.profiles(id) on delete cascade,
  mission_id integer not null check(mission_id between 1 and 18),
  status text not null default 'in_progress' check(status in ('in_progress','completed')),
  attempts integer not null default 0,
  best_score integer not null default 0,
  latest_score integer not null default 0,
  points_earned integer not null default 0,
  hints_used integer not null default 0,
  saved_game_state_json text,
  checkpoint text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(student_id,mission_id)
);
create table public.mission_attempts(
  id bigint generated always as identity primary key,
  student_id uuid not null references public.profiles(id) on delete cascade,
  mission_id integer not null,
  attempt_number integer not null,
  score integer not null,
  result text not null check(result in ('success','failed')),
  program_json text not null,
  created_at timestamptz not null default now(),
  unique(student_id,mission_id,attempt_number)
);
create table public.point_transactions(
  id bigint generated always as identity primary key,
  student_id uuid not null references public.profiles(id) on delete cascade,
  mission_id integer,
  amount integer not null,
  type text not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
alter table public.mission_progress enable row level security;
alter table public.mission_attempts enable row level security;
alter table public.point_transactions enable row level security;
revoke all on public.mission_progress,public.mission_attempts,public.point_transactions from anon,authenticated;
grant select on public.mission_progress,public.mission_attempts,public.point_transactions to authenticated;
create policy progress_read_own on public.mission_progress for select to authenticated using(student_id=(select auth.uid()));
create policy attempts_read_own on public.mission_attempts for select to authenticated using(student_id=(select auth.uid()));
create policy points_read_own on public.point_transactions for select to authenticated using(student_id=(select auth.uid()));

create function public.start_mission(p_mission_id integer) returns public.mission_progress
language plpgsql security definer set search_path='' as $$
declare result public.mission_progress;
begin
  if not exists(select 1 from public.profiles where id=auth.uid() and role='student' and account_status='active') then raise exception 'Student access required'; end if;
  if p_mission_id<1 or p_mission_id>18 then raise exception 'Mission not found'; end if;
  if p_mission_id>1 and not exists(select 1 from public.mission_progress where student_id=auth.uid() and mission_id=p_mission_id-1 and status='completed') then raise exception 'Mission locked'; end if;
  insert into public.mission_progress(student_id,mission_id) values(auth.uid(),p_mission_id) on conflict do nothing;
  select * into result from public.mission_progress where student_id=auth.uid() and mission_id=p_mission_id;
  return result;
end; $$;
revoke all on function public.start_mission(integer) from public;
grant execute on function public.start_mission(integer) to authenticated;

create function public.save_mission_checkpoint(p_mission_id integer,p_state text,p_checkpoint text,p_hints integer)
returns public.mission_progress language plpgsql security definer set search_path='' as $$
declare result public.mission_progress;
begin
  if not exists(select 1 from public.profiles where id=auth.uid() and role='student' and account_status='active') then raise exception 'Student access required'; end if;
  if length(p_state)>100000 or length(p_checkpoint)>1000 or p_hints not between 0 and 3 then raise exception 'Invalid checkpoint'; end if;
  update public.mission_progress set saved_game_state_json=coalesce(p_state,saved_game_state_json),checkpoint=coalesce(p_checkpoint,checkpoint),hints_used=greatest(hints_used,coalesce(p_hints,0)) where student_id=auth.uid() and mission_id=p_mission_id returning * into result;
  if result.student_id is null then raise exception 'Start the mission first'; end if;
  return result;
end; $$;
revoke all on function public.save_mission_checkpoint(integer,text,text,integer) from public;
grant execute on function public.save_mission_checkpoint(integer,text,text,integer) to authenticated;

-- Called only by the Edge Function after executing the trusted mission config.
create function public.submit_validated_mission(p_student uuid,p_mission integer,p_score integer,p_success boolean,p_program text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare progress public.mission_progress; awarded integer:=0; first_completion boolean:=false; total integer;
begin
  if not exists(select 1 from public.profiles where id=p_student and role='student' and account_status='active') then raise exception 'Student access required'; end if;
  if p_score not between 0 and 100 or length(p_program)>100000 then raise exception 'Invalid attempt'; end if;
  select * into progress from public.mission_progress where student_id=p_student and mission_id=p_mission for update;
  if progress.student_id is null then raise exception 'Start the mission first'; end if;
  first_completion:=p_success and progress.status<>'completed';
  if first_completion then
    insert into public.point_transactions(student_id,mission_id,amount,type,idempotency_key)
      values(p_student,p_mission,p_score,'mission_completion','mission:'||p_mission||':student:'||p_student||':first')
      on conflict do nothing returning amount into awarded;
    awarded:=coalesce(awarded,0);
  end if;
  insert into public.mission_attempts(student_id,mission_id,attempt_number,score,result,program_json)
    values(p_student,p_mission,progress.attempts+1,p_score,case when p_success then 'success' else 'failed' end,p_program);
  update public.mission_progress set attempts=attempts+1,latest_score=p_score,best_score=greatest(best_score,p_score),
    status=case when p_success then 'completed' else status end,
    completed_at=case when p_success then coalesce(completed_at,now()) else completed_at end,
    points_earned=points_earned+awarded where student_id=p_student and mission_id=p_mission returning * into progress;
  select coalesce(sum(amount),0) into total from public.point_transactions where student_id=p_student;
  return jsonb_build_object('progress',to_jsonb(progress),'firstCompletion',first_completion,'pointsEarned',awarded,'totalPoints',total);
end; $$;
revoke all on function public.submit_validated_mission(uuid,integer,integer,boolean,text) from public,anon,authenticated;
grant execute on function public.submit_validated_mission(uuid,integer,integer,boolean,text) to service_role;
