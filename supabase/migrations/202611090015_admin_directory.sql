create function public.admin_user_directory() returns table(
 id uuid,username text,email text,display_name text,role text,account_status text,"character" text,total_points bigint,created_at timestamptz
) language sql stable security definer set search_path='' as $$
 select p.id,p.username,u.email::text,p.display_name,p.role,p.account_status,p.character,
 (select coalesce(sum(amount),0) from public.point_transactions t where t.student_id=p.id),p.created_at
 from public.profiles p join auth.users u on u.id=p.id
 where public.current_app_role()='admin' order by p.created_at desc;
$$;
revoke all on function public.admin_user_directory() from public;
grant execute on function public.admin_user_directory() to authenticated;
