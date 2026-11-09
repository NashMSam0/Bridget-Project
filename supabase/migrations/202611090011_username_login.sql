create function public.find_login_user(p_username text) returns uuid language sql stable security definer set search_path='' as $$
 select id from public.profiles where lower(username)=lower(p_username) limit 1;
$$;
revoke all on function public.find_login_user(text) from public,anon,authenticated;
grant execute on function public.find_login_user(text) to service_role;
