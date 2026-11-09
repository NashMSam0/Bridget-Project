drop policy classes_read on public.classes;
create policy classes_read on public.classes for select to authenticated using(
  (instructor_id=auth.uid() and public.current_app_role() in ('instructor','admin'))
  or public.current_app_role()='admin' or public.is_class_member(id)
);
