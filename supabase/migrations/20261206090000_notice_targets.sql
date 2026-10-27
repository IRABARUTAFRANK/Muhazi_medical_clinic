-- 0096 · Notices open the exact thing they are about.
--
-- Frank: a doctor clicked "Booking to accept" and landed at the top of Home with the booking far
-- below. The app now works out each notice's destination from its kind and params
-- (lib/notice-target.ts) and points Home items with `?focus=<kind>:<id>` (scrolled into view and
-- outlined). Every kind already carries the id it needs except 'task': a task given without a
-- visit had no link at all and no task id. It now carries the task id ('task') and, without a
-- visit, the link to the Tasks panel of Home (`/app?focus=task:<id>`); a task on a visit still
-- opens the visit.

-- notify_task (last in 20261126090000_departments_decide_desks): the same recipients as before.
create or replace function notify_task()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_link text := case when new.encounter_id is not null then '/app/visit?encounter=' || new.encounter_id
                      else '/app?focus=task:' || new.id end;
  v_params jsonb;
begin
  select p.surname || ' ' || p.given_names into v_name from patient p where p.id = new.patient_id;
  v_params := jsonb_build_object('title', new.title, 'name', v_name, 'due', new.due_at, 'task', new.id);
  if new.assigned_to is null and new.assigned_role = 'nurse' and desk_offered('nursing') then
    insert into notification (kind, params, link, recipient_user, created_by)
    select 'task', v_params, v_link, p.id, auth.uid()
    from profiles p
    where p.active and p.deleted_at is null and p.role <> 'manager' and desk_via(p.id, 'nursing') is not null;
  else
    insert into notification (kind, params, link, recipient_role, recipient_user, created_by)
    values ('task', v_params, v_link,
            case when new.assigned_to is null then new.assigned_role end,
            new.assigned_to,
            auth.uid());
  end if;
  return new;
end
$$;
