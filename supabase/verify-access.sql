BEGIN;
create temporary table test_ids(label text,id uuid);
insert into test_ids values('a',gen_random_uuid()),('b',gen_random_uuid()),('teacher',gen_random_uuid());
grant select on test_ids to authenticated,service_role;
insert into auth.users(id,email,raw_user_meta_data)
select id,'codebloom-test-'||id||'@example.invalid',jsonb_build_object('username','test_'||replace(id::text,'-',''),'displayName','Temporary verification account','character','girl') from test_ids;
update public.profiles set role='instructor' where id=(select id from test_ids where label='teacher');
select set_config('request.jwt.claim.sub',(select id::text from test_ids where label='a'),true);
set local role authenticated;
do $$ begin
 if (select count(*) from public.profiles)<>1 then raise exception 'Profile isolation failed'; end if;
 begin update public.profiles set role='admin' where id=auth.uid();raise exception 'Privilege escalation permitted';exception when insufficient_privilege then null;end;
 begin perform public.start_mission(2);raise exception 'Locked mission was available';exception when raise_exception then if SQLERRM<>'Mission locked' then raise;end if;end;
 perform public.start_mission(1);
 insert into public.projects(student_id,title,content) values(auth.uid(),'Verification project','version one');
 update public.projects set content='version two' where student_id=auth.uid();
 if (select count(*) from public.project_versions)<>2 then raise exception 'Project version history failed';end if;
end; $$;
select set_config('request.jwt.claim.sub',(select id::text from test_ids where label='b'),true);
do $$ begin if exists(select 1 from public.projects) or exists(select 1 from public.project_versions) then raise exception 'Cross-student project leak';end if;end;$$;
reset role;
set local role service_role;
select public.submit_validated_mission((select id from test_ids where label='a'),1,100,true,'[{"type":"move"},{"type":"move"},{"type":"move"}]');
select public.submit_validated_mission((select id from test_ids where label='a'),1,100,true,'[{"type":"move"},{"type":"move"},{"type":"move"}]');
do $$begin
 if (select count(*) from public.point_transactions where student_id=(select id from test_ids where label='a') and type='mission_completion')<>1 then raise exception 'Replay granted duplicate mission points';end if;
 if (select count(*) from public.student_achievements where student_id=(select id from test_ids where label='a'))<>2 then raise exception 'Mission achievements failed';end if;
end;$$;
reset role;
select set_config('request.jwt.claim.sub',(select id::text from test_ids where label='a'),true);
set local role authenticated;
select public.record_game_mission(1,100,3,10,5,'[]');
select public.record_game_mission(1,100,3,10,5,'[]');
do $$ begin
 if (select count(*) from public.point_transactions where type='game_mission_completion')<>1 then raise exception 'Replay granted duplicate game points';end if;
 begin perform public.submit_validated_mission(auth.uid(),1,100,true,'[]');raise exception 'Student can call trusted scoring function';exception when insufficient_privilege then null;end;
end;$$;
reset role;
update public.profiles set account_status='suspended' where id=(select id from test_ids where label='a');
set local role authenticated;
do $$begin
 begin perform public.start_mission(1);raise exception 'Suspended account started a mission';exception when raise_exception then if SQLERRM<>'Student access required' then raise;end if;end;
 begin perform public.visit_mission_map();raise exception 'Suspended account earned a reward';exception when raise_exception then if SQLERRM<>'Student access required' then raise;end if;end;
end;$$;
reset role;
ROLLBACK;
