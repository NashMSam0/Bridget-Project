alter table public.mission_progress drop constraint mission_progress_mission_id_check;
alter table public.mission_progress add check(mission_id between 1 and 1000000);
create table public.game_attempts(id bigint generated always as identity primary key,student_id uuid not null references public.profiles(id),mission_id integer not null references public.game_mission_catalog(id),score integer not null check(score between 0 and 10000),stars integer not null check(stars between 0 and 3),time_taken_seconds integer,blocks_used integer,program_json text,created_at timestamptz not null default now());
create index game_attempts_student on public.game_attempts(student_id,mission_id);
create table public.student_achievements(student_id uuid not null references public.profiles(id),achievement_id integer not null references public.achievement_catalog(id),earned_at timestamptz not null default now(),primary key(student_id,achievement_id));
alter table public.game_attempts enable row level security;
alter table public.student_achievements enable row level security;
revoke all on public.game_attempts,public.student_achievements from anon,authenticated;
grant select on public.game_attempts,public.student_achievements to authenticated;
create policy game_attempts_read_own on public.game_attempts for select to authenticated using(student_id=(select auth.uid()));
create policy achievements_read_own on public.student_achievements for select to authenticated using(student_id=(select auth.uid()));

create function public.grant_achievement(p_student uuid,p_key text) returns void language plpgsql security definer set search_path='' as $$
declare achievement public.achievement_catalog; granted integer;
begin
 select * into achievement from public.achievement_catalog where data->>'key'=p_key;
 if achievement.id is null then return; end if;
 insert into public.student_achievements(student_id,achievement_id) values(p_student,achievement.id) on conflict do nothing returning achievement_id into granted;
 if granted is not null then insert into public.point_transactions(student_id,amount,type,idempotency_key)
 values(p_student,(achievement.data->>'rewardPoints')::integer,'achievement','achievement:'||achievement.id||':student:'||p_student) on conflict do nothing; end if;
end; $$;
revoke all on function public.grant_achievement(uuid,text) from public,anon,authenticated;

create function public.grant_completion_achievements() returns trigger language plpgsql security definer set search_path='' as $$
declare world_num integer; completed_count integer; key_name text; total_stars integer; game_count integer;
begin
 if TG_TABLE_NAME='mission_progress' and new.status='completed' then
  perform public.grant_achievement(new.student_id,'ach-first-steps');
  if new.best_score=100 then perform public.grant_achievement(new.student_id,'ach-sequence-star'); end if;
  if new.mission_id between 4 and 6 then perform public.grant_achievement(new.student_id,'ach-loops-master'); end if;
  if exists(select 1 from public.mission_attempts where student_id=new.student_id and mission_id=new.mission_id and result='failed') then perform public.grant_achievement(new.student_id,'ach-little-solver'); end if;
  world_num:=(new.mission_id-1)/3+1;
  select count(*) into completed_count from public.mission_progress where student_id=new.student_id and status='completed' and mission_id between (world_num-1)*3+1 and world_num*3;
  if completed_count=3 then
   key_name:=(array['ach-garden-graduate','ach-forest-ranger','ach-mountain-guide','ach-workshop-inventor','ach-python-pioneer','ach-creator'])[world_num];
   if key_name is not null then perform public.grant_achievement(new.student_id,key_name); end if;
  end if;
 elsif TG_TABLE_NAME='game_attempts' and new.stars>0 then
  perform public.grant_achievement(new.student_id,'ach-first-adventure');
  if exists(select 1 from public.game_attempts where student_id=new.student_id and mission_id=new.mission_id and stars=0) then perform public.grant_achievement(new.student_id,'ach-problem-solver'); end if;
  select coalesce(sum(best),0),count(*) into total_stars,completed_count from (select max(stars) best from public.game_attempts where student_id=new.student_id group by mission_id) a where best>0;
  select count(distinct c.data->>'gameId') into game_count from public.game_attempts a join public.game_mission_catalog c on c.id=a.mission_id where a.student_id=new.student_id and a.stars>0;
  if total_stars>=10 then perform public.grant_achievement(new.student_id,'ach-star-collector'); end if;
  if game_count>=3 then perform public.grant_achievement(new.student_id,'ach-coding-explorer'); end if;
  if completed_count>=5 then perform public.grant_achievement(new.student_id,'ach-mission-champion'); end if;
 end if;
 return new;
end; $$;
revoke all on function public.grant_completion_achievements() from public;
create trigger mission_achievements after insert or update on public.mission_progress for each row execute function public.grant_completion_achievements();
create trigger game_achievements after insert on public.game_attempts for each row execute function public.grant_completion_achievements();
create function public.visit_mission_map() returns void language plpgsql security definer set search_path='' as $$ begin
 if public.current_app_role() is distinct from 'student' then raise exception 'Student access required'; end if;
 perform public.grant_achievement(auth.uid(),'ach-garden-explorer'); end; $$;
revoke all on function public.visit_mission_map() from public;
grant execute on function public.visit_mission_map() to authenticated;

create or replace function public.start_mission(p_mission_id integer) returns public.mission_progress language plpgsql security definer set search_path='' as $$
declare result public.mission_progress; mission jsonb; prerequisite integer;
begin
 if public.current_app_role() is distinct from 'student' then raise exception 'Student access required'; end if;
 select data into mission from public.mission_overrides where id=p_mission_id;
 if mission is null or not coalesce((mission->>'isPublished')::boolean,false) or coalesce((mission->>'isArchived')::boolean,false) then raise exception 'Mission unavailable'; end if;
 for prerequisite in select jsonb_array_elements_text(coalesce(mission->'prerequisiteIds','[]'))::integer loop
  if not exists(select 1 from public.mission_progress where student_id=auth.uid() and mission_id=prerequisite and status='completed') then raise exception 'Mission locked'; end if;
 end loop;
 insert into public.mission_progress(student_id,mission_id) values(auth.uid(),p_mission_id) on conflict do nothing;
 select * into result from public.mission_progress where student_id=auth.uid() and mission_id=p_mission_id;
 return result;
end; $$;

create function public.record_game_mission(p_mission integer,p_score integer,p_stars integer,p_time integer,p_blocks integer,p_program text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare mission jsonb; previous_stars integer; previous_score integer; awarded integer:=0; attempt_id bigint;
begin
 if public.current_app_role() is distinct from 'student' then raise exception 'Student access required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':game:'||p_mission,0));
 select data into mission from public.game_mission_catalog where id=p_mission;
 if mission is null then raise exception 'Mission unavailable'; end if;
 if p_score not between 0 and 10000 or p_stars not between 0 and (mission->>'starsAvailable')::integer or p_blocks not between 0 and 2000 or length(p_program)>100000 or p_time<0 or p_time>86400 then raise exception 'Invalid game attempt'; end if;
 select coalesce(max(stars),0),coalesce(max(score),0) into previous_stars,previous_score from public.game_attempts where student_id=auth.uid() and mission_id=p_mission;
 insert into public.game_attempts(student_id,mission_id,score,stars,time_taken_seconds,blocks_used,program_json) values(auth.uid(),p_mission,p_score,p_stars,p_time,p_blocks,p_program) returning id into attempt_id;
 if p_stars>0 then
  insert into public.point_transactions(student_id,amount,type,idempotency_key) values(auth.uid(),(mission->>'points')::integer,'game_mission_completion','game-mission:'||p_mission||':student:'||auth.uid()||':first') on conflict do nothing returning amount into awarded;
 end if;
 return jsonb_build_object('completed',p_stars>0,'firstCompletion',p_stars>0 and previous_stars=0,'stars',p_stars,'bestStars',greatest(p_stars,previous_stars),'score',p_score,'bestScore',greatest(p_score,previous_score),'pointsAwarded',coalesce(awarded,0),'totalPoints',(select coalesce(sum(amount),0) from public.point_transactions where student_id=auth.uid()),'attemptId',attempt_id);
end; $$;
revoke all on function public.record_game_mission(integer,integer,integer,integer,integer,text) from public;
grant execute on function public.record_game_mission(integer,integer,integer,integer,integer,text) to authenticated;
