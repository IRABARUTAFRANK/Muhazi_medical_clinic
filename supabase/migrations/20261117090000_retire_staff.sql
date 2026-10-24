-- 0076 · Deleting an employee keeps the clinic's records.
--
-- The staff profile was tied to the sign-in account (profiles.id → auth.users ON DELETE CASCADE):
-- deleting an account deleted the profile, and every visit, payment, result, note and history
-- line lost the name of who did it. Now:
--   * deleting an employee (manage-staff 'delete', after the manager's e-mailed code) removes the
--     sign-in for good and frees the username and e-mail, but keeps the profile as a former
--     employee (deleted_at): the clinic's records keep their name;
--   * what was personal to the account goes: departments, access exceptions, trusted devices,
--     temporary PIN, sign-in requests, their own notices; their calendar leaves the website;
--     patients waiting for them, tasks and covers go back to the desk;
--   * deactivating stays the advised choice (it can be undone). An account deactivated for 30
--     days is pointed out to the managers once, with the advice to delete it if the person is
--     not coming back.

alter table profiles drop constraint if exists profiles_id_fkey;
alter table profiles add column if not exists deleted_at timestamptz;
alter table profiles add column if not exists deleted_by uuid;
alter table profiles add column if not exists deletion_reminded_at timestamptz;

-- ---------------------------------------------------------------- delete, keep the records
create or replace function retire_staff(p_profile_id uuid, p_by uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_p profiles%rowtype;
  v_waiting integer;
begin
  select * into v_p from profiles where id = p_profile_id for update;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  if v_p.deleted_at is not null then
    raise exception 'this account is already deleted' using errcode = '23505';
  end if;
  if p_profile_id = p_by then
    raise exception 'you cannot delete your own account' using errcode = '42501';
  end if;
  if v_p.role = 'manager' and not exists (
       select 1 from profiles where role = 'manager' and active and deleted_at is null and id <> p_profile_id) then
    raise exception 'the clinic needs at least one manager' using errcode = '42501';
  end if;

  -- patients and work waiting for them go back to the desk (anyone there may take them)
  update queue_entry set assigned_to = null
  where assigned_to = p_profile_id and finished_at is null and deleted_at is null;
  get diagnostics v_waiting = row_count;
  update queue_entry set taken_by = null, started_at = null
  where taken_by = p_profile_id and finished_at is null and deleted_at is null;
  update encounter set intended_to = null where intended_to = p_profile_id and status = 'open';
  update internal_task set assigned_to = null,
         assigned_role = coalesce(assigned_role, v_p.role::text::role_key)
  where assigned_to = p_profile_id and done_at is null and deleted_at is null;
  update clinician_cover set ended_at = now()
  where (doctor_id = p_profile_id or nurse_id = p_profile_id) and ended_at is null;
  -- their calendar leaves the website and the booking lists
  update practitioner set calendar_visibility = 'private', active = false where user_id = p_profile_id;

  -- what belonged to the account only
  delete from staff_department where profile_id = p_profile_id;
  delete from staff_permission where profile_id = p_profile_id;
  delete from trusted_device where user_id = p_profile_id;
  delete from staff_temp_pin where user_id = p_profile_id;
  delete from login_request where user_id = p_profile_id;
  delete from notification where recipient_user = p_profile_id;

  -- the former employee: name, role and staff ID stay on every record
  update profiles
  set active = false,
      deactivated_at = coalesce(deactivated_at, now()),
      deleted_at = now(),
      deleted_by = p_by,
      dashboard = null,
      head_of = null,
      department_id = null,
      position = 'member',
      email = null,
      username = 'former.' || lower(coalesce(staff_id, left(id::text, 8)))
  where id = p_profile_id;

  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (p_by, 'delete', 'profiles', p_profile_id,
          jsonb_build_object('name', v_p.full_name, 'staff_id', v_p.staff_id, 'role', v_p.role,
                             'patients_back_to_desk', v_waiting));
  return jsonb_build_object('name', v_p.full_name, 'staffId', v_p.staff_id, 'patientsBack', v_waiting);
end
$$;
revoke all on function retire_staff(uuid, uuid) from public, anon, authenticated;
grant execute on function retire_staff(uuid, uuid) to service_role;

-- ---------------------------------------------------------------- deactivated for a month
-- Called by the manager's screens: each account deactivated for 30 days or more is pointed out
-- once (again only if deactivated again later).
create or replace function deactivation_reminders()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer := 0;
  r record;
begin
  if not is_manager() then
    return 0;
  end if;
  for r in
    select id, full_name, staff_id, role, deactivated_at from profiles
    where not active and deleted_at is null and deactivated_at < now() - interval '30 days'
      and (deletion_reminded_at is null or deletion_reminded_at < deactivated_at)
  loop
    insert into notification (kind, params, link, recipient_role, created_by)
    values ('deactivated_long',
            jsonb_build_object('name', r.full_name, 'staffId', r.staff_id, 'role', r.role,
                               'since', r.deactivated_at,
                               'days', extract(day from now() - r.deactivated_at)::int),
            '/app/staff', 'manager', auth.uid());
    update profiles set deletion_reminded_at = now() where id = r.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;
revoke all on function deactivation_reminders() from public, anon;
grant execute on function deactivation_reminders() to authenticated;

-- ---------------------------------------------------------------- the lists leave former employees out
create or replace view staff_directory with (security_invoker = true) as
  select p.id, p.username, p.full_name, p.role, p.station, p.dashboard, p.head_of, p.language, p.phone,
         p.active, p.must_change_pin, p.last_sign_in_at, p.pin_changed_at, p.deactivated_at, p.created_at,
         p.staff_id, p.email, p.department_id, d.name as department_name, p.position, p.specialty,
         coalesce((select jsonb_agg(jsonb_build_object('id', dd.id, 'name', dd.name, 'position', sd.position)
                                    order by (sd.department_id = p.department_id) desc, dd.name)
                   from staff_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.profile_id = p.id), '[]'::jsonb) as departments
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null
  where p.deleted_at is null;
