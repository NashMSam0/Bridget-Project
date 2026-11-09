-- Free play does not award mission points or achievements.
create table public.game_plays(
  student_id uuid not null references public.profiles(id) on delete cascade,
  game_key text not null,
  play_count integer not null default 0 check(play_count>=0),
  completed boolean not null default false,
  best_score integer not null default 0 check(best_score between 0 and 10000),
  last_played_at timestamptz not null default now(),
  primary key(student_id,game_key)
);
alter table public.game_plays enable row level security;
revoke all on public.game_plays from anon,authenticated;
grant select on public.game_plays to authenticated;
create policy game_plays_read_own on public.game_plays for select to authenticated
  using(student_id=(select auth.uid()));

create function public.record_game_play(p_game_key text, p_complete boolean default false, p_score integer default 0)
returns public.game_plays language plpgsql security definer set search_path='' as $$
declare result public.game_plays;
begin
  if not exists(select 1 from public.profiles where id=auth.uid() and role='student' and account_status='active')
    then raise exception 'Student access required'; end if;
  if p_game_key not in ('jungle-treasure','coding-maze','space-explorer','collect-the-stars','robot-racing','star-catcher','pattern-garden')
    then raise exception 'Unknown game'; end if;
  if p_score<0 or p_score>10000 then raise exception 'Invalid score'; end if;
  insert into public.game_plays(student_id,game_key,play_count,completed,best_score)
    values(auth.uid(),p_game_key,case when p_complete then 0 else 1 end,p_complete,case when p_complete then p_score else 0 end)
  on conflict(student_id,game_key) do update set
    play_count=public.game_plays.play_count+case when p_complete then 0 else 1 end,
    completed=public.game_plays.completed or p_complete,
    best_score=greatest(public.game_plays.best_score,case when p_complete then p_score else 0 end),
    last_played_at=now()
  returning * into result;
  return result;
end;
$$;
revoke all on function public.record_game_play(text,boolean,integer) from public;
grant execute on function public.record_game_play(text,boolean,integer) to authenticated;
