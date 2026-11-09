create or replace function public.grant_completion_achievements() returns trigger language plpgsql security definer set search_path='' as $$
declare world_num integer; completed_count integer; key_name text; total_stars integer; game_count integer;
begin
 if TG_TABLE_NAME='mission_progress' and to_jsonb(new)->>'status'='completed' then
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
 elsif TG_TABLE_NAME='game_attempts' and coalesce((to_jsonb(new)->>'stars')::integer,0)>0 then
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

