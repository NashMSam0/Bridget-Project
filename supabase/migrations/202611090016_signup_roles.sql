-- Preserve the existing student/instructor signup choices. Admin is never public.
create or replace function public.create_learner_profile() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,username,display_name,role,character,age_group)
 values(new.id,new.raw_user_meta_data->>'username',new.raw_user_meta_data->>'displayName',
   case when new.raw_user_meta_data->>'role'='instructor' then 'instructor' else 'student' end,
   coalesce(new.raw_user_meta_data->>'character','girl'),new.raw_user_meta_data->>'ageGroup');
 return new;
end; $$;
