-- 0128 · The profession, "Also the clinic manager", and what a person does in each department.
--
-- Frank (the owner) approved this design for Employees and Departments:
--
--   * A  THE PROFESSION: profiles.role is the person's profession: doctor, nurse, midwife,
--        sonographer, lab_tech, pharmacist, receptionist, cashier, administrator (a non-medical
--        manager). The midwife and the administrator are new (part 1, 20270108085000). 'manager' stays
--        in the enum for old rows and old callers only.
--   * B  "ALSO THE CLINIC MANAGER": profiles.is_manager. is_manager() reads it, so every manager
--        check keeps working. The switches of the role 'manager' (role_permissions) apply to anyone
--        with the flag, on top of their profession's (has_perm, staff_perm); a manager has no "not
--        allowed" exception against them. Every row with the role 'manager' becomes a doctor and a
--        clinic manager (the owner's decision: both live managers are doctors). A write that still
--        says 'manager' (an older manage-staff function, a script) is read the same way:
--        profile_role_rules keeps the profession and sets the flag. The manager's dashboard follows
--        the flag, and the clinic keeps at least one manager (hint last_manager).
--   * C  THE MANAGER WORKS WHERE HE IS PLACED: he is no longer at every desk. desk_via never answers
--        'manager': he takes patients, appears among the people of a desk ("first free"), counts his
--        queue and answers the waiting room only at the desks his departments give, like anyone of
--        his profession. He keeps the OVERSIGHT through is_manager(): dashboard, analytics,
--        reports, In clinic, every queue on the board, the visits (records only as a doctor, 0126),
--        bills, employees, prices, settings, every worklist to look at (my_test_categories), the
--        room stores (room_store_for), ending a visit with money due, taking a patient off a desk.
--   * D  WHAT A PERSON DOES IN EACH DEPARTMENT: staff_department.services, the department's services
--        this person does there ("Does here"). The desks given by departments are the TICKED
--        services of each placement that the department still gives (in_desk_department, desk_via,
--        staff_services, service_has_staff), still within the profession's ceiling and the
--        person's exceptions. Every existing placement gets all its department's services (nobody
--        loses a desk on update day); a placement written without services (the trigger of the main
--        department, the day-one placement of 0085, an older manage-staff) gets them all too; a
--        service the department starts giving is ticked for its members (the manager unticks it).
--        set_staff_departments takes "services" in each item: a service the department does not give
--        is refused (hint service_not_given), and so is none at all when the department gives some
--        (hint no_service).
--   * E  THE REGISTRATION NUMBER is optional for everyone (set_staff_doctor no longer asks for it;
--        the "Doctor (sees patient records)" switch of 0126 leaves the employee form: a doctor is the
--        profession). is_doctor() is unchanged: the role 'doctor', or the 0126 mark (kept for the
--        rows that have it).
--   * F  READ BY THE APP: is_manager in record_sign_in, my_session_profile, staff_directory and
--        staff_profile; the services of each placement in staff_directory, staff_profile and
--        my_placement.
--
-- Errcodes: 42501 not allowed, 22023 bad input (hints: service_not_given, no_service, last_manager),
-- P0002 not found.

-- ---------------------------------------------------------------- B the manager flag
alter table profiles add column if not exists is_manager boolean not null default false;

-- the two live managers (and any other) are doctors and clinic managers
update profiles set is_manager = true, role = 'doctor' where role = 'manager';

-- 'manager' is not a profession any more; the manager's dashboard follows the flag; the clinic
-- keeps a manager.
create or replace function profile_role_rules()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- an older caller still writes the role 'manager': a clinic manager, of their profession (a new
  -- account: a doctor, as the clinic's managers are)
  if new.role = 'manager' then
    new.is_manager := true;
    new.role := case when tg_op = 'UPDATE' and old.role <> 'manager' then old.role else 'doctor' end;
  end if;
  if new.is_manager then
    new.dashboard := 'manager';
  elsif tg_op = 'UPDATE' and old.is_manager and new.dashboard = 'manager' then
    -- no longer the manager: the head's dashboard when they lead a department, else none
    new.dashboard := case when exists (
        select 1 from staff_department sd
        join department d on d.id = sd.department_id and d.deleted_at is null
        where sd.profile_id = new.id and sd.position in ('head', 'assistant')) then 'head' end;
  end if;
  if tg_op = 'UPDATE' and old.is_manager and not new.is_manager
     and not exists (select 1 from profiles m
                     where m.id <> new.id and m.is_manager and m.active and m.deleted_at is null) then
    raise exception 'the clinic must keep at least one active manager'
      using errcode = '22023', hint = 'last_manager';
  end if;
  return new;
end
$$;
revoke all on function profile_role_rules() from public, anon, authenticated;
drop trigger if exists trg_profile_role_rules on profiles;
create trigger trg_profile_role_rules before insert or update on profiles
  for each row execute function profile_role_rules();

-- ---------------------------------------------------------------- D what a person does in each department
alter table staff_department add column if not exists services text[];
update staff_department sd set services = coalesce(d.services, '{}')
from department d
where d.id = sd.department_id and sd.services is null;
update staff_department set services = '{}' where services is null;

-- A placement written without services (the main department's trigger, the day-one placement of
-- 0085, an older manage-staff): everything the department gives.
create or replace function staff_department_services_default()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.services is null then
    select coalesce(d.services, '{}') into new.services from department d where d.id = new.department_id;
    new.services := coalesce(new.services, '{}');
  end if;
  -- in the order of the desks, once each
  new.services := array(select x.d from unnest(all_desks()) with ordinality as x(d, n)
                        where x.d = any (new.services) order by x.n);
  return new;
end
$$;
revoke all on function staff_department_services_default() from public, anon, authenticated;
drop trigger if exists trg_staff_department_services on staff_department;
create trigger trg_staff_department_services before insert or update of services on staff_department
  for each row execute function staff_department_services_default();
alter table staff_department alter column services set not null;

-- ---------------------------------------------------------------- A the new professions' desks and switches
-- The midwife: a treating profession like the nurse (the nurse's ceiling and switches as they are
-- today). The administrator: no treating desk; reception when placed there, with the receptionist's
-- switches (the manager changes them in Settings › Who may do what).
insert into role_desk (role, desk, set_by)
select 'midwife', rd.desk, null from role_desk rd where rd.role = 'nurse'
on conflict do nothing;
insert into role_desk (role, desk, set_by) values ('administrator', 'reception', null)
on conflict do nothing;
insert into role_permissions (role, permission)
select 'midwife', rp.permission from role_permissions rp where rp.role = 'nurse'
on conflict do nothing;
insert into role_permissions (role, permission)
select 'administrator', rp.permission from role_permissions rp where rp.role = 'receptionist'
on conflict do nothing;

-- ---------------------------------------------------------------- B the manager check reads the flag
create or replace function is_manager()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from profiles where id = auth.uid() and active and deleted_at is null and is_manager)
$$;

-- ---------------------------------------------------------------- B the switches: the profession's, and the manager's for a manager
create or replace function has_perm(p_permission text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    -- a clinic manager has the manager's switches whatever else is set for them
    (select true from profiles me
     join role_permissions rp on rp.role = 'manager' and rp.permission = p_permission
     where me.id = auth.uid() and me.active and me.is_manager),
    (select sp.allowed from staff_permission sp
     join profiles me on me.id = sp.profile_id and me.active
     where sp.profile_id = auth.uid() and sp.permission = p_permission),
    exists (select 1 from profiles p
            join role_permissions rp on rp.role = p.role
            where p.id = auth.uid() and p.active and rp.permission = p_permission))
$$;

create or replace function staff_perm(p_user uuid, p_permission text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select true from profiles me
     join role_permissions rp on rp.role = 'manager' and rp.permission = p_permission
     where me.id = p_user and me.active and me.is_manager),
    (select sp.allowed from staff_permission sp where sp.profile_id = p_user and sp.permission = p_permission),
    exists (select 1 from profiles p join role_permissions rp on rp.role = p.role
            where p.id = p_user and p.active and rp.permission = p_permission))
$$;

-- ---------------------------------------------------------------- D in a department that gives the desk, and ticked for the person there
create or replace function in_desk_department(p_user uuid, p_desk text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from staff_department sd
                 join department d on d.id = sd.department_id and d.active and d.deleted_at is null
                 where sd.profile_id = p_user and p_desk = any (d.services) and p_desk = any (sd.services))
$$;

-- ---------------------------------------------------------------- C desk_via
-- 0128: never 'manager': the manager uses the desks of their departments, like anyone of
-- their profession; the manager's switches count for a manager.
create or replace function desk_via(p_user uuid, p_desk text)
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when not desk_key(p_desk) then null
    when ex.allowed = false then null
    -- the role's ceiling
    when not exists (select 1 from role_desk rd where rd.role = p.role and rd.desk = p_desk) then null
    when in_desk_department(p.id, p_desk)
         and (p_desk in ('laboratory', 'ultrasound', 'pharmacy') or coalesce(ex.allowed, rl.has)) then 'department'
    -- kept on day one by the rule of before (F)
    when coalesce(ex.allowed, rl.has)
         and exists (select 1 from staff_desk_keep k where k.profile_id = p.id and k.desk = p_desk) then 'kept'
    -- no department gives it: the role decides, as before
    when not desk_offered(p_desk) and coalesce(ex.allowed, rl.has)
         and desk_role_rule(p.role, p.station::text, p.specialty::text, p_desk) then 'role'
  end
  from profiles p
  cross join lateral (
    select exists (select 1 from role_permissions rp
                   where (rp.role = p.role or (p.is_manager and rp.role = 'manager'))
                     and rp.permission = desk_permission(p_desk)) as has
  ) rl
  left join staff_permission ex on ex.profile_id = p.id and ex.permission = desk_permission(p_desk)
  where p.id = p_user and p.active and p.deleted_at is null
$$;

-- ---------------------------------------------------------------- C works at the desk (0126): now simply a desk of theirs
create or replace function works_at_desk(p_desk text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(desk_via(auth.uid(), p_desk) is not null, false)
$$;

-- ---------------------------------------------------------------- C my_desks
create or replace function my_desks()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'desks', to_jsonb(my_desk_list()),
    'via', coalesce((
      select jsonb_object_agg(d.desk, coalesce(desk_via(auth.uid(), d.desk), 'cover'))
      from unnest(all_desks()) as d(desk) where may_use_desk(d.desk)), '{}'::jsonb),
    'offered', coalesce((
      select jsonb_agg(d.desk order by d.n) from unnest(all_desks()) with ordinality as d(desk, n)
      where desk_offered(d.desk)), '[]'::jsonb),
    -- 0128: the profession's ceiling, the manager's too
    'ceiling', coalesce((
      select jsonb_agg(d.desk order by d.n) from unnest(all_desks()) with ordinality as d(desk, n)
      where exists (select 1 from role_desk rd where rd.role = current_role_key() and rd.desk = d.desk)),
      '[]'::jsonb)
  )
  where auth.uid() is not null
$$;

-- ---------------------------------------------------------------- C the worklists the manager looks at (oversight), the others' own
create or replace function my_test_categories()
returns request_category[]
language sql stable security definer set search_path = public
as $$
  select array_remove(array[
    case when may_use_desk('laboratory') or is_manager() then 'lab' end,
    case when may_use_desk('ultrasound') or is_manager() then 'imaging' end
  ]::request_category[], null)
$$;

-- ---------------------------------------------------------------- C a patient for me: the manager too only where they work (0128)
create or replace function queue_entry_for_me(p_queue_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from queue_entry q
    join profiles me on me.id = auth.uid() and me.active
    where q.id = p_queue_id and q.deleted_at is null
      and (
        me.id = q.assigned_to or me.id = q.taken_by or me.id = q.return_to
        -- sent to the section: anyone who works in it
        or (q.assigned_to is null and q.taken_by is null
            and serves_station(me.id, q.station, q.service)
            and (q.department_id is null
                 or me.department_id = q.department_id
                 or exists (select 1 from staff_department sd
                            where sd.profile_id = me.id and sd.department_id = q.department_id)))
      )
  )
$$;

-- ---------------------------------------------------------------- C the queue entries that are mine (the manager's are real desks now)
create or replace function queue_entry_mine(p_queue_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from queue_entry q
                 where q.id = p_queue_id and q.deleted_at is null
                   and (auth.uid() in (q.assigned_to, q.taken_by, q.return_to)
                        or queue_entry_for_me(q.id)))
$$;

-- ---------------------------------------------------------------- C may work on a visit: the manager as anyone (where they work)
create or replace function may_work_on(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from queue_entry q
               where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
                 and queue_entry_for_me(q.id))
    -- a task on this visit for me or the people it is for (the doctor asked the nurse for an injection…)
    or exists (select 1 from internal_task k
               where k.encounter_id = p_encounter_id and k.done_at is null and k.deleted_at is null
                 and (k.assigned_to = auth.uid() or task_for_me(k.assigned_role)))
    -- a colleague who accepted to help on this patient
    or exists (select 1 from staff_call c
               where c.encounter_id = p_encounter_id and c.kind = 'help' and c.status = 'accepted'
                 and c.answered_by = auth.uid())
    -- nobody holds the patient at a treating desk (e.g. now at the cashier): whoever treated
    -- them in this visit may still complete the record
    or (not exists (select 1 from queue_entry q
                    where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
                      and station_role(q.station) in ('doctor', 'nurse', 'lab_tech', 'sonographer'))
        and exists (select 1 from queue_entry q
                    where q.encounter_id = p_encounter_id and q.deleted_at is null
                      and (q.taken_by = auth.uid() or q.assigned_to = auth.uid())))
$$;

-- ---------------------------------------------------------------- D staff_services
create or replace function staff_services(p_user uuid)
returns text[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(distinct s), '{}')
  from (
    select unnest(pr.categories) as s
    from practitioner pr where pr.user_id = p_user and pr.deleted_at is null
    union
    -- 0128: the services ticked for the person there, that the department still gives
    select s.s
    from staff_department sd join department d on d.id = sd.department_id and d.deleted_at is null
    cross join unnest(sd.services) as s(s)
    where sd.profile_id = p_user and s.s = any (d.services)
  ) x
$$;

-- ---------------------------------------------------------------- D service_has_staff
create or replace function service_has_staff(p_service text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles p
    where p.active and p.role in ('doctor', 'nurse', 'midwife', 'sonographer', 'lab_tech', 'pharmacist')
      and (exists (select 1 from practitioner pr where pr.user_id = p.id and pr.deleted_at is null
                   and p_service = any (pr.categories))
           or exists (select 1 from staff_department sd
                      join department d on d.id = sd.department_id and d.deleted_at is null
                      where sd.profile_id = p.id and p_service = any (d.services) and p_service = any (sd.services)))
  )
$$;

-- ---------------------------------------------------------------- D staff_serves: the midwife treats
create or replace function staff_serves(p_user uuid, p_service text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles p
    cross join lateral (select staff_services(p.id) as mine) s
    where p.id = p_user and p.active
      and p.role in ('doctor', 'nurse', 'midwife', 'sonographer', 'lab_tech', 'pharmacist')
      and (
        -- the section the person is set in, whatever their role
        p_service = any (s.mine)
        -- nothing set for the person, or nobody set for this section: the role's usual desk
        or ((cardinality(s.mine) = 0 or not service_has_staff(p_service))
            and role_serves(p.role, p.station, p_service, p.specialty))
      )
  )
$$;

-- ---------------------------------------------------------------- A role_serves: the midwife's usual desks are the nurse's
create or replace function role_serves(p_role role_key, p_station text, p_service text, p_specialty text)
returns boolean
language sql immutable
as $$
  select case p_role
    when 'doctor' then
      -- the desk name, as in 0071
      (p_service = 'dental' and x.desk ~ 'dent')
      or (p_service in ('surgery', 'circ') and x.desk ~ '(theat|surg|circ)')
      or (p_service = 'ultrasound' and x.desk ~ '(ultra|echo)')
      or (p_service = 'consultation' and x.desk !~ '(dent|theat|surg|ultra|echo)')
      -- the specialty adds its section
      or coalesce(p_service = x.section, false)
      or (coalesce(x.section, '') = 'surgery' and p_service = 'circ')
    when 'sonographer' then p_service = 'ultrasound'
    when 'nurse' then p_service in ('nursing', 'fp', 'hiv', 'triage')
    when 'midwife' then p_service in ('nursing', 'fp', 'hiv', 'triage')
    when 'lab_tech' then p_service = 'laboratory'
    when 'pharmacist' then p_service = 'pharmacy'
    else false
  end
  from (
    select case
      when s ~ '(\mdent|amenyo|orthodon|stomato)' then 'dental'
      when s ~ '(ultra|\m[ée]cho|sonog|radiol|imaging|imagerie|mucyuma)' then 'ultrasound'
      when s ~ '(surg|chirurg|kubaga|theat|th[ée][aâ]tre|\mcirc|gusiramura|anaesth|anesth)' then 'surgery'
      when s ~ ('(g[ée]n[ée]ral|\mgp\M|family|famille|physician|m[ée]decin|internal|interne|'
                || 'paediat|p[ée]diat|gyn|obst|ophtal|ophthal|\ment\M|\morl\M|cardio|derma|'
                || 'neuro|psychiat|urolog|gastro|pneumo|endocrin|rheumat|rhumat|muganga)') then 'consultation'
    end as section, t.desk
    from (select lower(trim(coalesce(p_specialty, ''))) as s, lower(coalesce(p_station, '')) as desk) t
  ) x
$$;

-- ---------------------------------------------------------------- A desk_usual
create or replace function desk_usual(p_role role_key, p_station text, p_specialty text, p_desk text)
returns boolean
language sql immutable
as $$
  select case
    when p_desk = 'reception' then p_role = 'receptionist'
    when p_desk = 'triage' then p_role in ('receptionist', 'nurse', 'midwife')
      or coalesce(role_serves(p_role, p_station, p_desk, p_specialty), false)
    else coalesce(role_serves(p_role, p_station, p_desk, p_specialty), false)
  end
$$;

-- ---------------------------------------------------------------- C the people of a desk ("first free"): the midwife; the manager as their profession
create or replace function station_staff(p_station station)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
begin
  if not exists (select 1 from profiles where id = auth.uid() and active) then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'service', (station_desks(p_station))[1],
    'station', p_station,
    'sectionWaiting', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                       where q.deleted_at is null and q.station = p_station and q.finished_at is null
                         and q.started_at is null and q.assigned_to is null and e.status = 'open'),
    'staff', coalesce((
      select jsonb_agg(x.j order by (x.j ->> 'workingNow') = 'true' desc, (x.j ->> 'onDuty') = 'true' desc,
                                    (x.j ->> 'waiting')::int + (x.j ->> 'seeing')::int, x.j ->> 'name')
      from (
        select jsonb_build_object(
          'id', p.id, 'name', p.full_name, 'role', p.role, 'station', p.station,
          'departments', (select string_agg(d.name, ', ' order by d.name) from staff_department sd
                          join department d on d.id = sd.department_id and d.deleted_at is null
                          where sd.profile_id = p.id),
          'specialty', pr.title,
          'workingNow', case when pr.id is null or pr.working_hours = '{}'::jsonb then null
                             else practitioner_is_working(pr.id, now()) end,
          'onDuty', (p.last_sign_in_at at time zone 'Africa/Kigali')::date = v_today,
          'waiting', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                      where q.deleted_at is null and q.assigned_to = p.id and q.finished_at is null
                        and q.started_at is null and e.status = 'open'),
          'seeing', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                     where q.deleted_at is null and q.taken_by = p.id and q.finished_at is null
                       and e.status = 'open')
        ) as j
        from profiles p
        left join practitioner pr on pr.user_id = p.id and pr.deleted_at is null
        where p.active and p.role in ('doctor', 'nurse', 'midwife', 'sonographer', 'lab_tech', 'pharmacist')
          and serves_station(p.id, p_station)
      ) x
    ), '[]'::jsonb)
  );
end
$$;

-- ---------------------------------------------------------------- A my_home_station
create or replace function my_home_station()
returns station
language sql stable security definer set search_path = public
as $$
  select coalesce(
    station_named(p.station),
    case p.role
      when 'receptionist' then 'reception'
      when 'cashier' then 'cashier'
      when 'nurse' then 'triage'
      when 'midwife' then 'nursing'
      when 'administrator' then 'reception'
      when 'doctor' then 'consultation'
      when 'lab_tech' then 'laboratory'
      when 'sonographer' then 'ultrasound'
      when 'pharmacist' then 'pharmacy'
      else null
    end::station)
  from profiles p where p.id = auth.uid() and p.active
$$;

-- ---------------------------------------------------------------- A vitals_takers
create or replace function vitals_takers()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'staffId', p.staff_id, 'role', p.role)
                            order by (p.role not in ('nurse', 'midwife')), p.full_name), '[]'::jsonb)
  from profiles p
  where p.active and p.role in ('nurse', 'midwife', 'doctor')
    and (has_perm('vitals.write') or has_perm('clinical.write'))
    -- a department that does triage, or (when none does) the role, as before
    and desk_via(p.id, 'triage') is not null
$$;

-- ---------------------------------------------------------------- A calendars
create or replace function calendar_role_ok(p_user uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from profiles where id = p_user and active
                   and (role in ('doctor', 'sonographer', 'nurse', 'midwife') or is_manager))
$$;

-- ---------------------------------------------------------------- A calendar_people
create or replace function calendar_people()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', p.id, 'name', p.full_name, 'role', p.role, 'isManager', p.is_manager, 'staffId', p.staff_id,
    'visibility', pr.calendar_visibility, 'saved', pr.id is not null
  ) order by (p.id = auth.uid()) desc, p.full_name), '[]'::jsonb)
  from profiles p
  left join practitioner pr on pr.user_id = p.id and pr.deleted_at is null
  where is_manager() and p.active and (p.role in ('doctor', 'sonographer', 'nurse', 'midwife') or p.is_manager)
$$;

-- ---------------------------------------------------------------- A ensure_practitioner
create or replace function ensure_practitioner(p_user uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_name text;
  v_staff text;
begin
  if not (has_perm('appointment.approve') or is_manager() or p_user = auth.uid()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select id into v_id from practitioner where user_id = p_user and deleted_at is null limit 1;
  if v_id is not null then
    update practitioner set active = true where id = v_id;
    return v_id;
  end if;
  select full_name, staff_id into v_name, v_staff from profiles
  where id = p_user and active and (role in ('doctor', 'sonographer', 'nurse', 'midwife') or is_manager);
  if v_name is null then
    raise exception 'only doctors, sonographers, nurses and managers can be booked' using errcode = '22023';
  end if;
  insert into practitioner (code, user_id, names, slot_minutes, working_hours, calendar_visibility, active)
  values (lower(coalesce(v_staff, 'dr-' || left(p_user::text, 8))), p_user, v_name, 30, '{}'::jsonb, 'private', true)
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------- A bookable_doctors
create or replace function bookable_doctors()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', p.id, 'name', p.full_name, 'role', p.role, 'staffId', p.staff_id,
    'hasHours', coalesce(pr.working_hours, '{}'::jsonb) <> '{}'::jsonb,
    'slotMinutes', coalesce(pr.slot_minutes, 30),
    'title', pr.title
  ) order by p.full_name), '[]'::jsonb)
  from profiles p
  left join practitioner pr on pr.user_id = p.id and pr.deleted_at is null
  where (has_perm('appointment.read') or may_book_follow_up())
    and p.active and p.deleted_at is null and (p.role in ('doctor', 'sonographer', 'nurse', 'midwife') or p.is_manager)
$$;

-- ---------------------------------------------------------------- C leave_desk
create or replace function leave_desk(p_encounter_id uuid, p_station station)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = p_station and finished_at is null;
  if not found and (current_role_key() = 'receptionist' or is_manager()) then
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and finished_at is null and deleted_at is null
      and assigned_to is null and taken_by is null and station not in ('cashier', 'pharmacy');
  end if;
end
$$;

-- ---------------------------------------------------------------- C end_visit
create or replace function end_visit(p_encounter_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_due numeric;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  select coalesce(sum(invoice_balance(i.id)), 0) into v_due from invoice i
  where i.encounter_id = p_encounter_id and i.status <> 'credited';
  if v_due > 0 then
    if not is_manager() then
      raise exception 'money is still due (% RWF): take the payment first, or ask the manager', round(v_due)
        using errcode = '23514';
    end if;
    if nullif(trim(coalesce(p_reason, '')), '') is null then
      raise exception 'money is still due (% RWF): say why the patient left without paying', round(v_due)
        using errcode = '22023';
    end if;
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and finished_at is null;
  update encounter
  set status = 'closed', closed_at = now(), closed_by = auth.uid(),
      left_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = p_encounter_id;
  -- the bill gets its number and the insurer's claim; what the patient owes stays on the unpaid list
  perform post_drafts_of_visit(p_encounter_id);
  return jsonb_build_object('due', v_due);
end
$$;

-- ---------------------------------------------------------------- C answer_call
create or replace function answer_call(p_call_id uuid, p_queue_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_c staff_call%rowtype;
  v_q queue_entry%rowtype;
  v_me role_key := current_role_key();
  v_id uuid;
begin
  select * into v_c from staff_call where id = p_call_id and kind = 'next' for update;
  if not found or v_c.status <> 'open' then
    raise exception 'this call was already answered or cancelled' using errcode = '23505';
  end if;
  if not (is_manager()
          or (v_c.target = 'reception' and v_me = 'receptionist')
          or (v_c.target = 'nurse' and v_me in ('nurse', 'midwife'))
          or (v_c.target = 'person' and v_c.to_user = auth.uid())) then
    raise exception 'this call is not for you' using errcode = '42501';
  end if;
  if active_staff_or_null(v_c.from_user) is null then
    raise exception 'the colleague who called no longer works here' using errcode = '22023';
  end if;
  select * into v_q from queue_entry where id = p_queue_id and deleted_at is null and finished_at is null for update;
  if not found or not exists (select 1 from encounter where id = v_q.encounter_id and status = 'open') then
    raise exception 'that patient is no longer waiting' using errcode = 'P0002';
  end if;
  -- only a patient waiting for a doctor, at triage or reception: not one in the middle of a
  -- test, a treatment or the bill
  if v_c.station in ('laboratory', 'ultrasound', 'pharmacy', 'cashier', 'nursing', 'beds')
     and v_q.station <> v_c.station then
    raise exception 'only a patient already sent to % can be called there', initcap(v_c.station::text) using errcode = '22023';
  end if;
  if v_q.station <> coalesce(v_c.station, v_q.station)
     and v_q.station not in ('triage', 'reception', 'consultation', 'dental') then
    raise exception 'that patient is at % (not waiting for a doctor)', initcap(v_q.station::text) using errcode = '22023';
  end if;
  if v_q.taken_by is not null or (v_q.assigned_to is not null and v_q.assigned_to <> v_c.from_user) then
    raise exception 'that patient is already with %', coalesce(patient_holder(v_q.encounter_id), 'someone')
      using errcode = '23505';
  end if;
  if v_q.station = coalesce(v_c.station, v_q.station) then
    update queue_entry set assigned_to = v_c.from_user, department_id = null, referred_by = auth.uid()
    where id = v_q.id returning id into v_id;
  else
    -- waiting at another desk (e.g. triage done): they leave it for the caller's desk
    update queue_entry set finished_at = now() where id = v_q.id;
    update queue_entry set assigned_to = v_c.from_user, department_id = null, referred_by = auth.uid()
    where encounter_id = v_q.encounter_id and station = v_c.station and finished_at is null and deleted_at is null
    returning id into v_id;
    if v_id is null then
      insert into queue_entry (encounter_id, station, ticket_no, priority, assigned_to, referred_by)
      values (v_q.encounter_id, v_c.station, v_q.ticket_no, v_q.priority, v_c.from_user, auth.uid())
      returning id into v_id;
    end if;
  end if;
  -- a patient shared between several desks leaves the others
  if v_q.pool_id is not null then
    update queue_entry set finished_at = now()
    where pool_id = v_q.pool_id and id <> v_q.id and id <> v_id and finished_at is null;
  end if;
  update staff_call
  set status = 'answered', answered_by = auth.uid(), answered_at = now(), closed_at = now(),
      encounter_id = v_q.encounter_id
  where id = p_call_id;
  delete from notification where kind = 'call_next' and params ->> 'call' = p_call_id::text;
  return jsonb_build_object('encounterId', v_q.encounter_id, 'queueId', v_id);
end
$$;

-- ---------------------------------------------------------------- C my_calls
create or replace function my_calls()
returns jsonb
language sql stable security definer set search_path = public
as $$
  with me as (select id, role from profiles where id = auth.uid() and active),
  calls as (
    select c.*, f.full_name as from_name, t.full_name as to_name, h.full_name as answered_name,
           p.surname || ' ' || p.given_names as patient_name,
           (select q.ticket_no from queue_entry q where q.encounter_id = c.encounter_id order by q.created_at limit 1) as ticket
    from staff_call c
    join profiles f on f.id = c.from_user
    left join profiles t on t.id = c.to_user
    left join profiles h on h.id = c.answered_by
    left join encounter e on e.id = c.encounter_id
    left join patient p on p.id = e.patient_id
    where (c.status = 'open' and c.created_at > now() - interval '12 hours')
       or (c.status = 'accepted' and coalesce(e.status::text, 'open') = 'open')
       or (c.status = 'answered' and c.answered_at > now() - interval '30 minutes')
  ),
  j as (
    select c.*, jsonb_build_object(
      'id', c.id, 'kind', c.kind, 'target', c.target, 'station', c.station, 'note', c.note,
      'status', c.status, 'at', c.created_at, 'fromId', c.from_user, 'fromName', c.from_name,
      'toName', c.to_name, 'answeredName', c.answered_name, 'answeredAt', c.answered_at,
      'encounterId', c.encounter_id, 'patientName', c.patient_name, 'ticket', c.ticket) as row
    from calls c
  )
  select jsonb_build_object(
    'incoming', coalesce((select jsonb_agg(j.row order by j.created_at) from j, me
      where j.status = 'open' and j.from_user <> me.id and (
        (j.target = 'reception' and me.role = 'receptionist')
        or (j.target = 'nurse' and me.role in ('nurse', 'midwife'))
        or (j.target = 'person' and j.to_user = me.id)
        or (j.target = 'doctors' and me.role = 'doctor'))), '[]'::jsonb),
    'mine', coalesce((select jsonb_agg(j.row order by j.created_at desc) from j, me
      where j.from_user = me.id), '[]'::jsonb),
    'helping', coalesce((select jsonb_agg(j.row order by j.created_at) from j, me
      where j.kind = 'help' and j.status = 'accepted' and j.answered_by = me.id), '[]'::jsonb)
  )
  from me
$$;

-- ---------------------------------------------------------------- C begin_visit: "I take the patient myself" as their profession (the manager too)
create or replace function begin_visit(
  p_patient_id uuid,
  p_station station default 'consultation',
  p_department_id uuid default null,
  p_note text default null,
  p_myself boolean default false,
  p_emergency boolean default false,
  p_service text default null,
  p_assigned_to uuid default null,
  p_triage_to uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_role role_key := current_role_key();
  v_desk station := coalesce(case when not p_myself then service_station(p_service) end, p_station);
  v_station station;
  v_enc uuid;
  v_q queue_entry%rowtype;
begin
  if not has_perm('queue.write') or not has_perm('visit.start') then
    raise exception 'you may not start visits (the manager has not allowed it)' using errcode = '42501';
  end if;
  -- A visit is started at reception. "I take the patient myself" is decided below (the person's
  -- own desk); an emergency by the people who treat, wherever reception is given.
  if not (p_myself or p_emergency) then
    perform assert_desk(array['reception'], 'starting visits');
  elsif p_emergency and not p_myself then
    perform assert_desk(array['reception', 'triage'] || treating_desks(), 'emergency visits');
  end if;
  if p_emergency and v_role in ('receptionist', 'cashier', 'administrator') then
    raise exception 'only treating staff can register an emergency' using errcode = '42501';
  end if;
  if p_service is not null and service_station(p_service) is null then
    raise exception 'unknown service' using errcode = '22023';
  end if;
  if p_myself and not (
       (v_role = 'doctor' and v_desk in ('consultation', 'dental', 'theatre', 'ultrasound'))
       or (v_role in ('nurse', 'midwife') and v_desk in ('triage', 'nursing', 'beds'))
       or (v_role = 'lab_tech' and v_desk = 'laboratory')
       or (v_role = 'sonographer' and v_desk = 'ultrasound')
       or (v_role = 'pharmacist' and v_desk = 'pharmacy')
       -- or a department of theirs gives that desk (a nurse of the Laboratory …)
       or exists (select 1 from unnest(station_desks(v_desk)) as d(desk)
                  where in_desk_department(auth.uid(), d.desk) and may_use_desk(d.desk))) then
    raise exception 'you do not work at % : send the patient there instead', initcap(v_desk::text)
      using errcode = '42501';
  end if;
  if p_assigned_to is not null and (p_service is null or not staff_serves(p_assigned_to, p_service)) then
    raise exception 'that person does not give this service' using errcode = '22023';
  end if;
  if p_triage_to is not null and not staff_serves(p_triage_to, 'triage') then
    raise exception 'that person does not work at triage' using errcode = '22023';
  end if;
  if p_department_id is not null and not exists (
       select 1 from department d where d.id = p_department_id and d.deleted_at is null
         and ((cardinality(coalesce(d.services, '{}')) > 0 and station_desks(v_desk) && d.services)
              or (cardinality(coalesce(d.services, '{}')) = 0 and station_role(v_desk) = any (d.roles)))) then
    raise exception 'that department does not work at %', initcap(v_desk::text) using errcode = '22023';
  end if;
  if exists (select 1 from encounter where patient_id = p_patient_id and status = 'open') then
    raise exception 'this patient already has an open visit' using errcode = '23505';
  end if;

  v_station := case
    when p_myself or p_emergency then v_desk
    when triage_first() then 'triage'::station
    else v_desk end;
  perform set_config('mmc.visit_open', 'on', true);
  v_enc := open_encounter(p_patient_id, 'opd', v_station);
  perform set_config('mmc.visit_open', '', true);
  -- the service and the person chosen stay with the visit (used after triage)
  update encounter
  set service = p_service, intended_to = case when p_myself then auth.uid() else p_assigned_to end,
      practitioner_id = case
        when p_assigned_to is not null and exists (select 1 from profiles where id = p_assigned_to and role = 'doctor')
        then ensure_practitioner(p_assigned_to) else practitioner_id end
  where id = v_enc;

  if p_emergency then
    update encounter
    set triage_level = 'red', triage_reason = 'Emergency: registered directly at ' || v_station::text
    where id = v_enc;
    update queue_entry set priority = 1 where encounter_id = v_enc;
  end if;

  select * into v_q from queue_entry
  where encounter_id = v_enc and station = v_station and finished_at is null and deleted_at is null
  order by created_at limit 1;
  update queue_entry
  set referral_note = coalesce(nullif(trim(coalesce(p_note, '')), ''), referral_note),
      service = p_service,
      department_id = case when v_station = v_desk and p_assigned_to is null then coalesce(p_department_id, department_id) else department_id end,
      assigned_to = case
        when v_station = 'triage' and not p_myself then coalesce(p_triage_to, assigned_to)
        when v_station = v_desk and not p_myself then coalesce(p_assigned_to, assigned_to)
        else assigned_to end,
      referred_by = auth.uid()
  where id = v_q.id
  returning * into v_q;
  if p_myself then
    perform take_patient(v_q.id);
    delete from notification where kind = 'queue' and params ->> 'queue' = v_q.id::text;
  elsif v_q.assigned_to is not null then
    -- the person chosen is told (instead of everyone at the desk)
    perform notify_queue_entry_row(v_q);
  end if;

  return jsonb_build_object(
    'encounter_id', v_enc,
    'ticket_no', v_q.ticket_no,
    'station', v_station,
    'myself', p_myself,
    'assigned', (select full_name from profiles where id = v_q.assigned_to),
    'department', (select name from department where id = p_department_id));
end
$$;

-- ---------------------------------------------------------------- A start_visit: an emergency is for treating professions
create or replace function start_visit(
  p_patient_id uuid,
  p_emergency boolean default false,
  p_station station default 'consultation',
  p_type encounter_type default 'opd'
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_station station := case when p_emergency then p_station when triage_first() then 'triage'::station else p_station end;
  v_enc uuid;
  v_ticket text;
begin
  if not has_perm('queue.write') or not has_perm('visit.start') then
    raise exception 'you may not start visits (the manager has not allowed it)' using errcode = '42501';
  end if;
  -- A visit is started at reception; an emergency by the people who treat (at any treating desk,
  -- triage or reception), wherever reception is given.
  if not p_emergency then
    perform assert_desk(array['reception'], 'starting visits');
  else
    perform assert_desk(array['reception', 'triage'] || treating_desks(), 'emergency visits');
  end if;
  -- An emergency is treated on the spot, so only staff who treat may register one.
  if p_emergency and current_role_key() in ('receptionist', 'cashier', 'administrator') then
    raise exception 'only treating staff can register an emergency' using errcode = '42501';
  end if;
  if exists (select 1 from encounter where patient_id = p_patient_id and status = 'open') then
    raise exception 'this patient already has an open visit' using errcode = '23505';
  end if;
  perform set_config('mmc.visit_open', 'on', true);
  v_enc := open_encounter(p_patient_id, p_type, v_station);
  perform set_config('mmc.visit_open', '', true);
  if p_emergency then
    update encounter
    set triage_level = 'red', triage_reason = 'Emergency: registered directly at ' || p_station::text
    where id = v_enc;
    update queue_entry set priority = 1 where encounter_id = v_enc;
  end if;
  select ticket_no into v_ticket from queue_entry where encounter_id = v_enc order by created_at desc limit 1;
  return jsonb_build_object('encounter_id', v_enc, 'ticket_no', v_ticket, 'station', v_station);
end
$$;

-- ---------------------------------------------------------------- A register_patient_file: the quick file of the midwife, as of the nurse
create or replace function register_patient_file(
  p_surname text,
  p_given_names text,
  p_sex sex default 'unknown',
  p_birth_date date default null,
  p_age_years integer default null,
  p_phone text default null,
  p_national_id text default null,
  p_sector text default null,
  p_fields jsonb default null,
  p_emergency boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if p_fields is not null and jsonb_typeof(p_fields) <> 'object' then
    raise exception 'extra must be an object' using errcode = '22023';
  end if;
  return create_patient_file(
    coalesce(p_fields, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'surname', p_surname, 'given_names', p_given_names, 'sex', p_sex, 'birth_date', p_birth_date,
      'age_years', p_age_years, 'phone_1', p_phone, 'national_id', p_national_id, 'sector', p_sector)),
    -- an emergency, or the nurse's quick file: completed later (Files to complete)
    coalesce(p_emergency, false) or current_role_key() in ('nurse', 'midwife'));
end
$$;

-- ---------------------------------------------------------------- A register_patient: the quick file of the midwife, as of the nurse
create or replace function register_patient(
  p_surname text,
  p_given_names text,
  p_sex sex default 'unknown',
  p_birth_date date default null,
  p_age_years integer default null,
  p_phone text default null,
  p_national_id text default null,
  p_sector text default null,
  p_emergency boolean default false,
  p_station station default 'consultation',
  p_type encounter_type default 'opd'
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_file jsonb;
  v_visit jsonb;
begin
  v_file := create_patient_file(
    jsonb_strip_nulls(jsonb_build_object(
      'surname', p_surname, 'given_names', p_given_names, 'sex', p_sex, 'birth_date', p_birth_date,
      'age_years', p_age_years, 'phone_1', p_phone, 'national_id', p_national_id, 'sector', p_sector)),
    coalesce(p_emergency, false) or current_role_key() in ('nurse', 'midwife'));
  v_visit := start_visit((v_file ->> 'patient_id')::uuid, p_emergency, p_station, p_type);
  return v_visit || v_file;
end
$$;

-- ---------------------------------------------------------------- C room_store_for
create or replace function room_store_for(
  p_staff uuid, p_item_id uuid, p_quantity integer, p_location uuid default null, p_station station default null
)
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := exists (select 1 from profiles where id = p_staff and active and is_manager);
  v_qty integer := greatest(coalesce(p_quantity, 1), 1);
  v_id uuid;
begin
  if p_location is not null then
    if not exists (select 1 from stock_location where id = p_location and deleted_at is null and active
                   and is_room_type(type)) then
      raise exception 'choose an open room store' using errcode = '22023', hint = 'not_room_store';
    end if;
    if not v_manager and not holds_store(p_staff, p_location) then
      raise exception 'you do not hold that store: give from your own store, or prescribe it for the pharmacy'
        using errcode = '42501', hint = 'not_holder';
    end if;
    return case when usable_stock(p_item_id, p_location) >= v_qty then p_location end;
  end if;
  if not v_manager and not exists (select 1 from stock_location l where l.deleted_at is null and l.active
                                   and is_room_type(l.type) and holds_store(p_staff, l.id)) then
    raise exception 'you hold no room store: prescribe it for the pharmacy'
      using errcode = '42501', hint = 'no_room_store';
  end if;
  select l.id into v_id
  from stock_location l
  where l.deleted_at is null and l.active and is_room_type(l.type)
    and (v_manager or holds_store(p_staff, l.id))
    and usable_stock(p_item_id, l.id) >= v_qty
  order by
    exists (select 1 from stock_location_holder h where h.location_id = l.id and h.deleted_at is null
            and h.profile_id = p_staff) desc,
    holds_store(p_staff, l.id) desc,
    (l.type = case when p_station in ('nursing', 'beds', 'triage') then 'nursing'::stock_location_type
                   when p_station = 'theatre' then 'theatre'::stock_location_type end) desc nulls last,
    l.created_at
  limit 1;
  return v_id;
end
$$;

-- ---------------------------------------------------------------- C request_approvers
create or replace function request_approvers(p_patient_id uuid, p_requester uuid)
returns uuid[]
language sql stable security definer set search_path = public
as $$
  with doc as (
    select p.id, (p.is_manager or staff_perm(p.id, 'records.approve')) as first_
    from profiles p
    where p.active and p.deleted_at is null and (p.role = 'doctor' or p.is_doctor)
      and p.id is distinct from p_requester
  )
  select case when exists (select 1 from doc where first_)
              then (select array_agg(id) from doc where first_)
              else coalesce((select array_agg(id) from doc), '{}') end
$$;

-- ---------------------------------------------------------------- C may_request_visit_edit
create or replace function may_request_visit_edit(p_encounter_id uuid, p_user uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from profiles p
                 where p.id = p_user and p.active
                   and (p.is_manager
                        or (staff_perm(p_user, 'clinical.write') and took_part(p_encounter_id, p_user))))
$$;

-- ---------------------------------------------------------------- C retire_staff
create or replace function retire_staff(p_profile_id uuid, p_by uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_p profiles%rowtype;
  v_waiting integer;
  v_returning integer;
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
  if v_p.is_manager and not exists (
       select 1 from profiles where is_manager and active and deleted_at is null and id <> p_profile_id) then
    raise exception 'the clinic needs at least one manager' using errcode = '42501';
  end if;

  -- patients and work waiting for them go back to the desk (anyone there may take them)
  update queue_entry set assigned_to = null
  where assigned_to = p_profile_id and finished_at is null and deleted_at is null;
  get diagnostics v_waiting = row_count;
  update queue_entry set taken_by = null, started_at = null
  where taken_by = p_profile_id and finished_at is null and deleted_at is null;
  -- patients at the lab, ultrasound or pharmacy who were to come back to them: back to the section
  update queue_entry set return_to = null
  where return_to = p_profile_id and finished_at is null and deleted_at is null;
  get diagnostics v_returning = row_count;
  v_waiting := v_waiting + v_returning;
  update encounter set intended_to = null where intended_to = p_profile_id and status = 'open';
  -- their calls still open ("send me the next patient", a request for help, to or from them):
  -- withdrawn with their notices, so nobody sends a patient to them any more
  delete from notification where kind in ('call_next', 'help') and params ->> 'call' in (
    select id::text from staff_call
    where status in ('open', 'accepted')
      and (from_user = p_profile_id or to_user = p_profile_id or answered_by = p_profile_id));
  update staff_call
  set status = case when status = 'accepted' then 'done' else 'cancelled' end, closed_at = now()
  where status in ('open', 'accepted')
    and (from_user = p_profile_id or to_user = p_profile_id or answered_by = p_profile_id);
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

-- ---------------------------------------------------------------- C set_staff_permission
create or replace function set_staff_permission(p_profile_id uuid, p_permission text, p_allowed boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not managed_permission(p_permission) then
    raise exception 'this feature cannot be switched here' using errcode = '22023';
  end if;
  if exists (select 1 from profiles where id = p_profile_id and is_manager) then
    raise exception 'the manager keeps every feature' using errcode = '22023';
  end if;
  if p_allowed is null then
    delete from staff_permission where profile_id = p_profile_id and permission = p_permission;
  else
    insert into staff_permission (profile_id, permission, allowed) values (p_profile_id, p_permission, p_allowed)
    on conflict (profile_id, permission) do update set allowed = excluded.allowed, set_by = auth.uid(), set_at = now();
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'profiles', p_profile_id,
          jsonb_build_object('key', 'permission_exception', 'permission', p_permission, 'allowed', p_allowed));
end
$$;

-- ---------------------------------------------------------------- E set_staff_doctor: the registration is optional
create or replace function set_staff_doctor(
  p_profile uuid,
  p_on boolean,
  p_registration_no text default null,
  p_registration_body text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_p profiles%rowtype;
  v_no text := nullif(trim(coalesce(p_registration_no, '')), '');
  v_body text := nullif(trim(coalesce(p_registration_body, '')), '');
  v_me text;
begin
  if auth.uid() is null or not is_manager() then
    raise exception 'not allowed: the manager marks who is a doctor' using errcode = '42501', hint = 'not_manager';
  end if;
  if p_on is null then
    raise exception 'say yes or no' using errcode = '22023';
  end if;
  select * into v_p from profiles where id = p_profile and deleted_at is null for update;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  -- 0128: the registration number is optional
  if v_no is not null and length(v_no) > 40 then
    raise exception 'registration number: at most 40 characters' using errcode = '22023';
  end if;
  if not p_on and v_p.role = 'doctor' then
    raise exception 'a doctor by role stays a doctor: change the role instead'
      using errcode = '22023', hint = 'doctor_by_role';
  end if;
  update profiles
  set is_doctor = p_on,
      registration_no = case when p_on then coalesce(v_no, registration_no) else registration_no end,
      registration_body = case when p_on then coalesce(v_body, registration_body) else registration_body end
  where id = p_profile
  returning * into v_p;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'profiles', p_profile,
          jsonb_build_object('key', 'staff_doctor', 'on', p_on, 'registration_no', v_p.registration_no,
                             'registration_body', v_p.registration_body));
  select full_name into v_me from profiles where id = auth.uid();
  insert into notification (kind, params, title, body, link, urgent, recipient_user, created_by)
  select 'staff_doctor',
         jsonb_build_object('profileId', p_profile, 'name', v_p.full_name, 'on', p_on, 'by', v_me,
                            'registrationNo', v_p.registration_no, 'registrationBody', v_p.registration_body),
         case when p_on then 'Marked a doctor' else 'No longer marked a doctor' end,
         v_me || case when p_on then ' marked ' || v_p.full_name || ' a doctor (sees patient records)' || coalesce(', registration ' || v_p.registration_no, '')
                                     || '.'
                      else ' took away the doctor mark of ' || v_p.full_name || ' (no longer sees patient records).' end,
         '/app/staff/profile?id=' || p_profile, false, m.id, auth.uid()
  from profiles m
  where m.is_manager and m.active and m.deleted_at is null and m.id <> auth.uid();
  return jsonb_build_object('id', p_profile, 'isDoctor', is_doctor(p_profile), 'marked', v_p.is_doctor,
                            'registrationNo', v_p.registration_no, 'registrationBody', v_p.registration_body);
end
$$;

-- ---------------------------------------------------------------- C notices to the managers reach the clinic managers
create or replace function notification_is_mine(n notification, p_me uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles p
    where p.id = p_me and p.active and (
      (n.to_all and (not n.heads_only or exists (
          select 1 from staff_department sd where sd.profile_id = p.id and sd.position in ('head', 'assistant'))))
      or n.recipient_user = p_me
      or (n.recipient_role is not null and n.recipient_department is null
          and (n.recipient_role = p.role or (n.recipient_role = 'manager' and p.is_manager)))
      or (n.recipient_department is not null and exists (
            select 1 from staff_department sd
            where sd.profile_id = p.id and sd.department_id = n.recipient_department
              and (not n.heads_only or sd.position in ('head', 'assistant'))))
      -- a patient waiting at a section: the people who work in it
      or (n.recipient_stations is not null and n.recipient_department is null and n.recipient_user is null
          and exists (select 1 from unnest(n.recipient_stations) as x(s)
                      where serves_station(p_me, x.s, n.params ->> 'service')))
    )
  )
$$;

-- ---------------------------------------------------------------- A analytics_access
create or replace function analytics_access()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := is_manager();
  v_deps jsonb;
  v_desks text[];
  v_views text[] := '{}';
  v_dash text;
  v_dash_views text[] := '{}';
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_manager then
    select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'desks', to_jsonb(coalesce(d.services, '{}')))
                              order by d.sort_order, d.name), '[]'::jsonb)
    into v_deps
    from department d where d.deleted_at is null and d.active;
    v_views := array['revenue', 'staff', 'visits', 'treatments', 'lab', 'pharmacy', 'triage', 'stock', 'waiting', 'receipts', 'documents'];
    v_dash := 'manager';
    -- the manager dashboard's order: patients, waiting, money, people, treatments, stock, the desks, documents
    v_dash_views := array['visits', 'waiting', 'revenue', 'receipts', 'staff', 'treatments', 'stock', 'lab', 'pharmacy', 'triage', 'documents'];
  else
    select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'desks', to_jsonb(coalesce(d.services, '{}')))
                              order by d.sort_order, d.name), '[]'::jsonb)
    into v_deps
    from staff_department sd
    join department d on d.id = sd.department_id and d.deleted_at is null
    join profiles p on p.id = sd.profile_id and p.active
    where sd.profile_id = auth.uid() and sd.position in ('head', 'assistant');
    if jsonb_array_length(v_deps) > 0 then
      select coalesce(array_agg(distinct x), '{}') into v_desks
      from jsonb_array_elements(v_deps) dep, jsonb_array_elements_text(dep -> 'desks') x;
      v_views := array['staff', 'visits', 'treatments']
        || case when v_desks && array['laboratory', 'ultrasound'] then array['lab'] else '{}'::text[] end
        || case when 'pharmacy' = any (v_desks) then array['pharmacy'] else '{}'::text[] end
        || case when 'triage' = any (v_desks) then array['triage'] else '{}'::text[] end
        || case when 'pharmacy' = any (v_desks) then array['stock'] else '{}'::text[] end
        || array['waiting'];
      v_dash := 'head';
      -- the department section's order: patients, waiting, orders (the lab), people, services
      v_dash_views := array['visits', 'waiting']
        || case when v_desks && array['laboratory', 'ultrasound'] then array['lab'] else '{}'::text[] end
        || array['staff', 'treatments']
        || case when 'pharmacy' = any (v_desks) then array['pharmacy', 'stock'] else '{}'::text[] end
        || case when 'triage' = any (v_desks) then array['triage'] else '{}'::text[] end
        || array['documents'];
    else
      select p.role::text into v_role from profiles p where p.id = auth.uid() and p.active;
      v_dash := case v_role
        when 'cashier' then 'cashier'
        when 'pharmacist' then 'pharmacy'
        when 'lab_tech' then 'lab'
        when 'sonographer' then 'lab'
        when 'doctor' then 'doctor'
        when 'nurse' then 'nurse'
        when 'midwife' then 'nurse'
        when 'receptionist' then 'reception'
        when 'administrator' then 'reception'
        else null
      end;
      v_dash_views := case v_dash
        when 'cashier' then array['collections', 'receipts', 'methods', 'openBills', 'refunds']
        when 'pharmacy' then array['handovers', 'walkIn', 'stock', 'expiry', 'outside']
        when 'lab' then array['tests', 'turnaround', 'verification', 'byTest']
        when 'doctor' then array['myPatients', 'waitingNow', 'diagnoses', 'prescriptions', 'orders', 'tasks']
        when 'nurse' then array['myPatients', 'vitals', 'waitingNow', 'tasks']
        when 'reception' then array['registrations', 'bookings', 'waitingNow', 'arrivals']
        else '{}'::text[]
      end;
    end if;
  end if;
  -- 0126: the Patients' documents are records: for doctors
  if not is_doctor() then
    v_views := array_remove(v_views, 'documents');
    v_dash_views := array_remove(v_dash_views, 'documents');
  end if;
  return jsonb_build_object(
    'manager', v_manager,
    'departments', v_deps,
    'views', to_jsonb(v_views),
    'dashboard', v_dash,
    'dashboardViews', to_jsonb(v_dash_views));
end
$$;

-- ---------------------------------------------------------------- C my_summary: the manager's queue is their desks'
create or replace function my_summary(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_role role_key := current_role_key();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_len integer;
  v_start timestamptz;
  v_end timestamptz;
  v_pstart timestamptz;
  v_pend timestamptz;
  -- today's first instant (Kigali): a queue entry before it is from an earlier day
  v_midnight timestamptz := (v_today::timestamp) at time zone 'Africa/Kigali';
  v_station station := my_home_station();
  v_manager boolean := is_manager();
  -- money is the business of whoever takes payments (and the manager)
  v_money boolean := has_perm('payment.take') or is_manager();
  -- the cash desk has no business with clinical kinds
  v_kinds text[] := case when v_role = 'cashier'
                         then array['registered', 'charges', 'payments', 'refunds', 'voided', 'handovers']
                         else null end;
  v_waiting jsonb;
  v_counts jsonb;
  v_work jsonb;
  v_prev jsonb;
  v_money_j jsonb := null;
begin
  if v_role is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  v_len := v_to - v_from + 1;
  v_start := (v_from::timestamp) at time zone 'Africa/Kigali';
  v_end := ((v_to + 1)::timestamp) at time zone 'Africa/Kigali';
  v_pstart := ((v_from - v_len)::timestamp) at time zone 'Africa/Kigali';
  v_pend := v_start;

  -- WAITING FOR ME: by name first (assigned to me, handed over to me and not answered yet), then
  -- my desks' queue (nobody named: the sections I serve, or the desk my profile names; a patient
  -- sent to a department only for its members), plus the patients I took and have not finished.
  -- The manager's queue: the desks of their departments, like anyone (0128).
  -- Today's first; what joined the queue on an earlier day and is still open comes last, marked
  -- 'earlier' (shown apart: "From earlier days").
  select coalesce(jsonb_agg(to_jsonb(b) || jsonb_build_object('by_name', x.by_name, 'earlier', x.earlier)
                            order by x.earlier, x.by_name desc, (b.started_at is not null) desc, b.priority, b.queued_at),
                  '[]'::jsonb)
  into v_waiting
  from queue_board b
  cross join lateral (
    select coalesce(b.assigned_to = v_me, false)
           or coalesce(b.handover_status = 'pending' and b.handover_to = v_me, false) as by_name,
           b.queued_at < v_midnight as earlier
  ) x
  where b.finished_at is null
    and (
      x.by_name
      or coalesce(b.taken_by = v_me, false)
      or (b.assigned_to is null and b.taken_by is null
          and (serves_station(v_me, b.station, b.service)
               or b.station = v_station)
          and (b.department_id is null
               or exists (select 1 from profiles me where me.id = v_me and me.department_id = b.department_id)
               or exists (select 1 from staff_department sd
                          where sd.profile_id = v_me and sd.department_id = b.department_id)))
    );

  -- today's counts; the rows from an earlier day apart
  select jsonb_build_object(
    'sentToMe', count(*) filter (where not (r ->> 'earlier')::boolean
                                   and (r ->> 'by_name')::boolean and r ->> 'started_at' is null),
    'atMyDesks', count(*) filter (where not (r ->> 'earlier')::boolean
                                    and not (r ->> 'by_name')::boolean and r ->> 'started_at' is null),
    'inProgress', count(*) filter (where not (r ->> 'earlier')::boolean and r ->> 'started_at' is not null),
    'earlier', count(*) filter (where (r ->> 'earlier')::boolean)
  ) into v_counts
  from jsonb_array_elements(v_waiting) r;

  -- MY WORK: the kinds of "Who did what", mine only, this period and the one before.
  select coalesce(jsonb_object_agg(k.kind, k.n), '{}'::jsonb) into v_work
  from (select kind, count(*) as n
        from analytics_staff_events(v_start, v_end, v_money)
        where user_id = v_me and (v_kinds is null or kind = any (v_kinds))
        group by kind) k;
  select coalesce(jsonb_object_agg(k.kind, k.n), '{}'::jsonb) into v_prev
  from (select kind, count(*) as n
        from analytics_staff_events(v_pstart, v_pend, v_money)
        where user_id = v_me and (v_kinds is null or kind = any (v_kinds))
        group by kind) k;
  -- the visits I opened (reception's work; not a kind of Who did what)
  v_work := v_work || jsonb_build_object('visitsStarted',
    (select count(*) from encounter e where e.deleted_at is null and e.created_by = v_me
      and e.arrived_at >= v_start and e.arrived_at < v_end));
  v_prev := v_prev || jsonb_build_object('visitsStarted',
    (select count(*) from encounter e where e.deleted_at is null and e.created_by = v_me
      and e.arrived_at >= v_pstart and e.arrived_at < v_pend));

  -- MY MONEY: what I took, by method; what I gave back; the walk-in sales I handed over.
  if v_money then
    select jsonb_build_object(
      'payments', jsonb_build_object(
        'count', (select count(*) from payment y where y.deleted_at is null and y.cashier_id = v_me and y.paid_at >= v_start and y.paid_at < v_end),
        'amount', (select coalesce(sum(y.amount), 0) from payment y where y.deleted_at is null and y.cashier_id = v_me and y.paid_at >= v_start and y.paid_at < v_end),
        'prevAmount', (select coalesce(sum(y.amount), 0) from payment y where y.deleted_at is null and y.cashier_id = v_me and y.paid_at >= v_pstart and y.paid_at < v_pend),
        'prevCount', (select count(*) from payment y where y.deleted_at is null and y.cashier_id = v_me and y.paid_at >= v_pstart and y.paid_at < v_pend)),
      'byMethod', coalesce((
        select jsonb_agg(jsonb_build_object('method', m.method, 'amount', m.amount, 'count', m.n) order by m.amount desc)
        from (select y.method::text as method, sum(y.amount) as amount, count(*) as n from payment y
              where y.deleted_at is null and y.cashier_id = v_me and y.paid_at >= v_start and y.paid_at < v_end
              group by y.method) m), '[]'::jsonb),
      'refunds', jsonb_build_object(
        'count', (select count(*) from refund r where r.deleted_at is null and r.cashier_id = v_me and r.refunded_at >= v_start and r.refunded_at < v_end),
        'amount', (select coalesce(sum(r.amount), 0) from refund r where r.deleted_at is null and r.cashier_id = v_me and r.refunded_at >= v_start and r.refunded_at < v_end)),
      'sales', jsonb_build_object(
        'count', (select count(*) from counter_sale s where s.deleted_at is null and s.handed_over_by = v_me and s.handed_over_at >= v_start and s.handed_over_at < v_end),
        'total', (select coalesce(sum(s.total), 0) from counter_sale s where s.deleted_at is null and s.handed_over_by = v_me and s.handed_over_at >= v_start and s.handed_over_at < v_end))
    ) into v_money_j;
  end if;

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'role', v_role,
    'station', v_station,
    'desks', to_jsonb(my_desk_list()),
    'waiting', v_waiting,
    'counts', v_counts,
    'work', v_work,
    'workPrev', v_prev,
    'money', v_money_j
  );
end
$$;

-- ---------------------------------------------------------------- C nav_counts: the manager's own desks counted; In clinic stays the whole clinic
create or replace function nav_counts()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_role role_key := current_role_key();
  v_manager boolean := is_manager();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_start timestamptz;
  v_end timestamptz;
  v_desks text[] := my_desk_list();
  v_station station;
  -- a doctor's or nurse's desk: consultation, dental, nursing, triage…
  v_treat boolean;
  v_pharmacy boolean;
  v_out jsonb := '{}'::jsonb;
  v_n integer;
  v_e integer;
begin
  if v_me is null or v_role is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  v_start := (v_today::timestamp) at time zone 'Africa/Kigali';
  v_end := ((v_today + 1)::timestamp) at time zone 'Africa/Kigali';
  v_station := my_home_station();
  -- 0128: the manager counts the work of their own desks, like anyone of their profession
  v_treat := v_role not in ('receptionist', 'cashier', 'administrator')
             and v_desks && (treating_desks() || array['triage']);
  v_pharmacy := 'pharmacy' = any (v_desks);

  -- MY QUEUE and THE PATIENTS AT MY DESKS (the rule of my_summary's "Waiting for me"): an entry
  -- that joined the queue today is today's; an older one still open is from an earlier day.
  if v_treat and has_perm('queue.read') and has_perm('patient.read') then
    with mine as (
      select q.encounter_id, q.started_at, (q.created_at >= v_start) as is_today
      from queue_entry q
      join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
      where q.deleted_at is null and q.finished_at is null
        and (q.assigned_to = v_me
             or q.taken_by = v_me
             or exists (select 1 from patient_handover h
                        where h.queue_id = q.id and h.status = 'pending' and h.to_user = v_me
                          and h.deleted_at is null)
             or (q.assigned_to is null and q.taken_by is null
                 and (serves_station(v_me, q.station, coalesce(q.service, e.service))
                      or q.station = v_station)
                 and (q.department_id is null
                      or exists (select 1 from profiles me where me.id = v_me and me.department_id = q.department_id)
                      or exists (select 1 from staff_department sd
                                 where sd.profile_id = v_me and sd.department_id = q.department_id))))
    ),
    -- a patient with an entry of today is today's, even when an older one is still open
    visits as (select encounter_id, bool_or(is_today) as is_today from mine group by encounter_id)
    select jsonb_build_object(
             'queue', (select count(*) from mine where started_at is null and is_today),
             'queueEarlier', (select count(*) from mine where started_at is null and not is_today),
             'inClinic', (select count(*) from visits where is_today),
             'inClinicEarlier', (select count(*) from visits where not is_today))
    into v_out;
  end if;
  -- the manager's In clinic is the whole clinic (oversight)
  if (v_manager or (not v_treat and v_role = 'receptionist')) and has_perm('patient.read') then
    select v_out || jsonb_build_object(
             'inClinic', count(*) filter (where e.arrived_at >= v_start),
             'inClinicEarlier', count(*) filter (where e.arrived_at < v_start))
    into v_out
    from encounter e where e.status = 'open' and e.deleted_at is null;
  end if;

  -- RESULTS FOR ME and MY PRESCRIPTIONS AT THE PHARMACY: whoever has those menu entries (a doctor
  -- at a treating desk; anyone a department of theirs gives a doctor's desk; as the menu decides)
  if ((v_role = 'doctor' and v_desks && treating_desks())
          or exists (select 1 from unnest(array['consultation', 'dental', 'surgery', 'circ']) d(desk)
                     where desk_via(v_me, d.desk) = 'department')) then
    -- given today and not seen; given on one of the 6 days before and still not seen: earlier
    select count(*) filter (where d.updated_at >= v_start),
           count(*) filter (where d.updated_at < v_start)
    into v_n, v_e
    from diagnostic_report d
    join service_request r on r.id = d.service_request_id and r.deleted_at is null
    where d.deleted_at is null and d.reviewed_at is null
      and r.status in ('resulted', 'verified')
      and d.updated_at > now() - interval '7 days'
      -- cheap first: my own request, or a visit handed over to me
      and (r.requester_id = v_me
           or exists (select 1 from patient_handover h where h.encounter_id = r.encounter_id
                      and h.to_user = v_me and h.status = 'taken' and h.deleted_at is null))
      and result_recipient(r.encounter_id, r.requester_id) = v_me;
    -- 0126: results are records: counted for doctors
    if is_doctor() then
      v_out := v_out || jsonb_build_object('results', v_n, 'resultsEarlier', v_e);
    end if;

    -- written today and still waiting at the pharmacy; written earlier: apart
    select count(*) filter (where m.created_at >= v_start),
           count(*) filter (where m.created_at < v_start)
    into v_n, v_e
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open' and e.deleted_at is null
    where coalesce(m.prescriber_id, m.created_by) = v_me and rx_pending(m);
    v_out := v_out || jsonb_build_object('prescriptions', v_n, 'prescriptionsEarlier', v_e);
  end if;

  -- MY BOOKINGS STILL TO SEE, today to 3 weeks ahead (whoever keeps a calendar; 0124, 0125)
  if has_perm('appointment.accept') or v_manager then
    select count(*) into v_n
    from appointment a
    join practitioner pr on pr.id = a.practitioner_id and pr.user_id = v_me and pr.deleted_at is null
    where a.deleted_at is null
      -- still to be seen: booked, confirmed or arrived; once the visit is taken (in progress) or
      -- done it leaves the count, one by one
      and a.status in ('approved', 'confirmed', 'arrived')
      and a.starts_at >= v_start and a.starts_at < v_start + interval '22 days';
    if v_n > 0 or exists (select 1 from practitioner pr where pr.user_id = v_me and pr.deleted_at is null) then
      v_out := v_out || jsonb_build_object('myBookings', v_n);
    end if;
  end if;

  -- TODAY'S BOOKINGS + THE REQUESTS THAT CAME TODAY (reception's Bookings page); requests still
  -- unanswered from an earlier day: apart
  if v_manager or v_role = 'receptionist' or has_perm('appointment.approve') then
    -- still to come in: booked or confirmed for today (an arrival leaves the count), and the
    -- requests of today still to answer
    select count(*) filter (where (a.status in ('approved', 'confirmed')
                                   and a.starts_at >= v_start and a.starts_at < v_end)
                                  or (a.status = 'inquiry' and a.created_at >= v_start)),
           count(*) filter (where a.status = 'inquiry' and a.created_at < v_start)
    into v_n, v_e
    from appointment a
    where a.deleted_at is null;
    v_out := v_out || jsonb_build_object('bookings', v_n, 'bookingsEarlier', v_e);
  end if;

  -- THE LABORATORY / ULTRASOUND WORKLIST (the rule of lab_worklist, open): asked today; earlier
  if v_desks && array['laboratory', 'ultrasound'] and has_perm('orders.read') then
    select count(*) filter (where r.created_at >= v_start),
           count(*) filter (where r.created_at < v_start)
    into v_n, v_e
    from service_request r
    join encounter e on e.id = r.encounter_id and e.status = 'open'
    where r.deleted_at is null
      and r.status not in ('verified', 'cancelled')
      and r.category = any (my_test_categories())
      and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station
                                   else 'laboratory'::station end) in ('laboratory', 'ultrasound')
      and (has_perm('sensitive.read') or may_use_desk(request_desk(r.station, r.category))
           or not sensitive_service(r.service_id));
    v_out := v_out || jsonb_build_object('worklist', v_n, 'worklistEarlier', v_e);
  end if;

  -- THE PHARMACY: patients with medicines written today to hand over + walk-in sales of today
  -- paid and not handed over; a patient whose medicines all date from an earlier day, and older
  -- walk-in sales: apart
  if v_pharmacy then
    with pending as (
      select m.encounter_id, bool_or(m.created_at >= v_start) as is_today
      from medication_request m
      join encounter e on e.id = m.encounter_id and e.status = 'open'
      where rx_pending(m)
      group by m.encounter_id
    ), sales as (
      select (s.created_at >= v_start) as is_today
      from counter_sale s
      join stock_location l on l.id = s.location_id
      where s.deleted_at is null and s.status = 'paid' and not is_room_type(l.type)
    )
    select (select count(*) from pending where is_today) + (select count(*) from sales where is_today),
           (select count(*) from pending where not is_today) + (select count(*) from sales where not is_today)
    into v_n, v_e;
    v_out := v_out || jsonb_build_object('pharmacy', v_n, 'pharmacyEarlier', v_e);
  elsif exists (
      select 1 from stock_location l
      where l.active and l.deleted_at is null and is_room_type(l.type) and holds_store(v_me, l.id)) then
    -- A ROOM STORE (a doctor's office, the ward): delivery notes sent today to confirm + walk-in
    -- sales of today to give; older ones apart
    with w as (
      select (t.sent_at >= v_start) as is_today from stock_transfer t
      where t.deleted_at is null and t.status = 'in_transit' and t.direction = 'to_room'
        and holds_store(v_me, t.to_location_id)
      union all
      select (s.created_at >= v_start) from counter_sale s
      join stock_location l on l.id = s.location_id
      where s.deleted_at is null and s.status = 'paid' and is_room_type(l.type)
        and holds_store(v_me, s.location_id)
    )
    select count(*) filter (where is_today), count(*) filter (where not is_today) into v_n, v_e from w;
    v_out := v_out || jsonb_build_object('stock', v_n, 'stockEarlier', v_e);
  end if;

  -- MONEY: bills opened today with something still to pay (open visits), walk-in sales of today
  -- waiting to be paid; older ones apart
  if v_manager or v_role = 'cashier' or has_perm('payment.take') then
    select count(*) filter (where i.created_at >= v_start),
           count(*) filter (where i.created_at < v_start)
    into v_n, v_e
    from invoice i join encounter e on e.id = i.encounter_id
    where i.deleted_at is null and i.status = 'draft' and e.status = 'open'
      and invoice_balance(i.id) > 0;
    v_out := v_out || jsonb_build_object('bills', v_n, 'billsEarlier', v_e);
  end if;
  if not v_manager and (v_role = 'cashier' or has_perm('payment.take')) then
    select count(*) filter (where s.created_at >= v_start),
           count(*) filter (where s.created_at < v_start)
    into v_n, v_e
    from counter_sale s where s.deleted_at is null and s.status = 'open';
    v_out := v_out || jsonb_build_object('payments', v_n, 'paymentsEarlier', v_e);
  end if;

  -- RECORD ACCESS: requests waiting for an answer (record_access_requests 'pending'); not day-bound
  -- 0126: doctors only; the requests this doctor may answer
  if is_doctor() then
    v_n := (select count(*) from record_access_request r
            join encounter e on e.id = r.encounter_id and e.status = 'open'
            where r.kind = 'request' and r.status = 'pending' and r.requested_by <> v_me
              and r.created_at > now() - interval '90 days'
              and may_answer_request(r.patient_id, r.requested_by))
           + case when v_manager then
               (select count(*) from record_access_request r
                where r.kind = 'emergency' and r.reviewed_at is null
                  and r.created_at > now() - interval '90 days')
             else 0 end;
    if v_n > 0 or v_manager or has_perm('records.approve') then
      v_out := v_out || jsonb_build_object('recordAccess', v_n);
    end if;
  end if;

  -- STAFF DOCUMENTS expiring within 60 days, or expired (staff_documents_expiring); not day-bound
  if v_manager then
    v_out := v_out || jsonb_build_object('documents',
      (select count(*) from staff_document d
       join profiles p on p.id = d.profile_id and p.active
       where d.deleted_at is null and d.kind in ('licence', 'contract')
         and d.expires_on is not null and d.expires_on <= staff_doc_today() + 60));
  end if;

  -- FILES TO COMPLETE (reception): today's only (0123), as the list opens
  if v_role = 'receptionist' and has_perm('patient.read') then
    v_out := v_out || jsonb_build_object('filesToComplete',
      (with s as (select patient_builtins() as b, patient_fields() as f)
       select count(distinct p.id)
       from patient p
       cross join s
       left join encounter e on e.patient_id = p.id and e.status = 'open' and e.deleted_at is null
       where p.deleted_at is null and p.merged_into is null
         and (coalesce(e.arrived_at, p.created_at) at time zone 'Africa/Kigali')::date
             = (now() at time zone 'Africa/Kigali')::date
         and cardinality(patient_missing_with(p, s.b, s.f)) > 0));
  end if;

  -- 0127: THE ORDERS OF THE DOCTORS TO CARRY OUT (the nurse's Home): mine by name, and those for
  -- all the nurses when I work at the nursing desk; given today, given earlier
  if has_perm('clinical.write') then
    select count(*) filter (where o.created_at >= v_start), count(*) filter (where o.created_at < v_start)
    into v_n, v_e
    from nurse_order o
    join encounter e on e.id = o.encounter_id and e.status = 'open' and e.deleted_at is null
    where o.deleted_at is null and o.status = 'open' and nurse_order_mine(o.assigned_to);
    if v_n + v_e > 0 or task_for_me('nurse') then
      v_out := v_out || jsonb_build_object('nurseOrders', v_n, 'nurseOrdersEarlier', v_e);
    end if;
  end if;

  -- an "earlier" count only when there is something from an earlier day
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_out
  from jsonb_each(v_out) x(k, v)
  where not (k like '%Earlier' and v = '0'::jsonb);

  return v_out;
end
$$;

-- ---------------------------------------------------------------- F activity_history: the actor is also the clinic manager
create or replace function activity_history(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_actor uuid default null,
  p_group text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '7 days');
  v_to timestamptz := coalesce(p_to, now());
  v_total integer;
  v_items jsonb;
  -- 0126: a reader who is not a doctor sees what was done, not the clinical words
  v_doc boolean := is_doctor();
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- Everyone sees their own activity; only the manager sees everybody's (and may pick a person).
  if not is_manager() then
    p_actor := auth.uid();
  end if;

  select count(*) into v_total
  from audit_event a
  where a.at >= v_from and a.at < v_to and a.action <> 'read'
    and (p_actor is null or a.actor_id = p_actor)
    and (p_group is null or activity_group(a.entity, a.action) = p_group);

  with ev as (
    select a.*, activity_group(a.entity, a.action) as grp, coalesce(a.after, a.before) as row
    from audit_event a
    where a.at >= v_from and a.at < v_to and a.action <> 'read'
      and (p_actor is null or a.actor_id = p_actor)
      and (p_group is null or activity_group(a.entity, a.action) = p_group)
    order by a.at desc
    limit greatest(1, least(p_limit, 500)) offset greatest(p_offset, 0)
  ),
  -- The visit behind the record: directly, through its bill, or through its test order.
  ev2 as (
    select ev.*,
      case when ev.entity = 'encounter' then ev.entity_id
        else coalesce(
          nullif(ev.row ->> 'encounter_id', '')::uuid,
          (select i.encounter_id from invoice i where i.id = nullif(ev.row ->> 'invoice_id', '')::uuid),
          (select i.encounter_id from invoice i where ev.entity = 'invoice' and i.id = ev.entity_id),
          (select sr.encounter_id from service_request sr where sr.id = nullif(ev.row ->> 'service_request_id', '')::uuid),
          (select md.encounter_id from medication_request md where md.id = nullif(ev.row ->> 'medication_request_id', '')::uuid))
      end as enc_id
    from ev
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', ev2.id,
      'at', ev2.at,
      'action', ev2.action,
      'entity', ev2.entity,
      'group', ev2.grp,
      'actor', pr.full_name,
      'actorRole', pr.role, 'actorManager', pr.is_manager,
      'actorStaffId', pr.staff_id,
      'encounterId', en.id,
      'patientId', coalesce(case when ev2.entity = 'patient' then ev2.entity_id end, en.patient_id, pp.id),
      'patient', coalesce(
        case when ev2.entity = 'patient' then (ev2.row ->> 'surname') || ' ' || (ev2.row ->> 'given_names') end,
        pe.surname || ' ' || pe.given_names,
        pp.surname || ' ' || pp.given_names,
        case when ev2.entity = 'appointment' then ev2.row ->> 'contact_name' end),
      'detail', null,
      'reason', ev2.reason,
      'row', case when v_doc or ev2.actor_id = auth.uid() then audit_clean(ev2.row)
                  else audit_redact(ev2.entity, audit_clean(ev2.row)) end,
      'changes', case when ev2.action <> 'update' then '[]'::jsonb
                      when v_doc or ev2.actor_id = auth.uid() then audit_changes(ev2.before, ev2.after)
                      else audit_changes(audit_redact(ev2.entity, ev2.before), audit_redact(ev2.entity, ev2.after)) end,
      'names', jsonb_strip_nulls(jsonb_build_object(
        'file', coalesce(case when ev2.entity = 'patient' then ev2.row ->> 'file_number' end,
                         pe.file_number, pp.file_number),
        'target', case ev2.entity
          when 'profiles' then (select p.full_name || coalesce(' (' || p.staff_id || ')', '') from profiles p where p.id = ev2.entity_id)
          when 'practitioner' then ev2.row ->> 'names'
          when 'service' then coalesce(ev2.row ->> 'name_en', (select s.name_en from service s where s.id = ev2.entity_id))
          when 'payer' then coalesce(ev2.row ->> 'name', (select y.name from payer y where y.id = ev2.entity_id))
          when 'bed' then ev2.row ->> 'name'
          when 'item' then ev2.row ->> 'name_generic'
        end,
        'service', (select s.name_en from service s where s.id = coalesce(
          nullif(ev2.row ->> 'service_id', '')::uuid,
          (select sr.service_id from service_request sr where sr.id = nullif(ev2.row ->> 'service_request_id', '')::uuid))),
        'item', case when not v_doc and ev2.actor_id is distinct from auth.uid()
                          and ev2.entity in ('medication_request', 'medication_dispense', 'prescription_doc') then null
                     else (select it.name_generic || coalesce(' ' || it.strength, '') from item it
                 where it.id = coalesce(nullif(ev2.row ->> 'item_id', '')::uuid,
                   (select md.item_id from medication_request md where md.id = nullif(ev2.row ->> 'medication_request_id', '')::uuid))) end,
        'staff', (select p.full_name from profiles p
                  where p.id = nullif(coalesce(ev2.after ->> 'assigned_to', ev2.after ->> 'taken_by',
                                               ev2.row ->> 'assigned_to', ev2.row ->> 'given_by'), '')::uuid),
        'referredBy', (select p.full_name from profiles p where p.id = nullif(ev2.row ->> 'referred_by', '')::uuid),
        'returnTo', (select p.full_name from profiles p where p.id = nullif(ev2.row ->> 'return_to', '')::uuid),
        'performer', (select p.full_name from profiles p where p.id = nullif(ev2.row ->> 'performer_id', '')::uuid),
        'practitioner', (select x.names from practitioner x where x.id = nullif(ev2.row ->> 'practitioner_id', '')::uuid),
        'bed', (select b.name from bed b where b.id = nullif(ev2.row ->> 'bed_id', '')::uuid),
        'invoice', coalesce(case when ev2.entity = 'invoice' then ev2.row ->> 'number' end,
                            (select i.number from invoice i where i.id = nullif(ev2.row ->> 'invoice_id', '')::uuid)),
        'department', (select d.name from department d where d.id = nullif(ev2.row ->> 'department_id', '')::uuid)
      ))
    ) order by ev2.at desc), '[]'::jsonb)
  into v_items
  from ev2
  left join profiles pr on pr.id = ev2.actor_id
  left join encounter en on en.id = ev2.enc_id
  left join patient pe on pe.id = en.patient_id
  left join patient pp on pp.id = nullif(ev2.row ->> 'patient_id', '')::uuid and en.id is null;

  return jsonb_build_object('total', v_total, 'items', v_items, 'from', v_from, 'to', v_to);
end
$$;

-- ---------------------------------------------------------------- F report_employees: the manager flag, what each does in a department
create or replace function report_employees(p_department uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := auth.uid() is not null and is_manager();
  v_heads uuid[] := report_my_head_departments();
  v_scope uuid[];
  v_rows jsonb;
begin
  if auth.uid() is null or not (v_manager or cardinality(v_heads) > 0) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not v_manager and p_department is not null and not (p_department = any (v_heads)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_scope := case when p_department is not null then array[p_department]
                  when v_manager then null
                  else v_heads end;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'staffId', p.staff_id, 'fullName', p.full_name,
      'username', case when v_manager then p.username end,
      'role', p.role::text, 'specialty', p.specialty, 'isManager', p.is_manager,
      'departments', coalesce((
        select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'position', sd.position,
                                            'services', to_jsonb(sd.services))
                         order by (sd.department_id = p.department_id) desc, d.sort_order, d.name)
        from staff_department sd join department d on d.id = sd.department_id and d.deleted_at is null
        where sd.profile_id = p.id), '[]'::jsonb),
      'desks', to_jsonb(desks_of(p.id)),
      'phone', case when v_manager then p.phone end,
      'email', case when v_manager then p.email end,
      'registrationNo', p.registration_no, 'registrationBody', p.registration_body,
      'active', p.active, 'deactivatedAt', p.deactivated_at, 'createdAt', p.created_at,
      'lastSignInAt', p.last_sign_in_at, 'mustChangePin', p.must_change_pin
    ) order by p.active desc, p.full_name), '[]'::jsonb)
  into v_rows
  from profiles p
  where p.deleted_at is null
    and (v_scope is null or exists (select 1 from staff_department sd
                                    where sd.profile_id = p.id and sd.department_id = any (v_scope)));
  return jsonb_build_object('scope', case when v_manager then 'all' else 'department' end,
                            'departments', to_jsonb(coalesce(v_scope, '{}')), 'rows', v_rows);
end
$$;

-- ---------------------------------------------------------------- F record_sign_in
create or replace function record_sign_in(p_device text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v profiles%rowtype;
  v_sid uuid := current_session_id();
  v_code boolean := code_just_typed();
  v_reason text;
begin
  if not v_code and enforce_code_on() and session_reason() <> 'ok' then
    raise exception 'sign-in not approved: sign in again with the e-mailed code'
      using errcode = 'PT401', hint = 'code_required';
  end if;
  update profiles set last_sign_in_at = now()
  where id = auth.uid() and active
  returning * into v;
  if not found then
    raise exception 'this account is deactivated; ask the manager' using errcode = '42501';
  end if;
  if v_code and v_sid is not null then
    -- A session signed out before is never approved again.
    insert into approved_session (session_id, user_id, via)
    values (v_sid, auth.uid(), 'code')
    on conflict (session_id) do nothing;
  end if;
  -- A code session that was signed out (or went idle) stays out.
  v_reason := session_reason();
  if v_sid is not null and enforce_code_on() and v_reason <> 'ok' then
    raise exception 'sign-in not approved: sign in again with the e-mailed code'
      using errcode = 'PT401', hint = v_reason;
  end if;
  -- Old rows go only once Supabase Auth itself forgot the session (it can never come back).
  if to_regclass('auth.sessions') is not null then
    begin
      execute 'delete from approved_session a
                where coalesce(a.ended_at, a.last_seen_at) < now() - interval ''30 days''
                  and not exists (select 1 from auth.sessions s where s.id = a.session_id)';
    exception when others then
      null; -- housekeeping only: never blocks a sign-in
    end;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, reason)
  values (auth.uid(), 'login', 'profiles', auth.uid(), p_device);
  return jsonb_build_object(
    'id', v.id, 'username', v.username, 'full_name', v.full_name, 'role', v.role,
    'station', v.station, 'dashboard', v.dashboard, 'head_of', v.head_of,
    'language', v.language, 'must_change_pin', v.must_change_pin,
    'staff_id', v.staff_id, 'email', v.email,
    -- 0128: the profession is the role; "also the clinic manager"
    'is_manager', v.is_manager, 'is_doctor', is_doctor(v.id)
  );
end
$$;

-- ---------------------------------------------------------------- F my_session_profile
create or replace function my_session_profile()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v profiles%rowtype;
begin
  select * into v from profiles where id = auth.uid();
  if not found or not v.active then
    raise exception 'this account is deactivated; ask the manager' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'id', v.id, 'username', v.username, 'full_name', v.full_name, 'role', v.role,
    'station', v.station, 'dashboard', v.dashboard, 'head_of', v.head_of,
    'language', v.language, 'must_change_pin', v.must_change_pin,
    'staff_id', v.staff_id, 'email', v.email,
    'specialty', v.specialty, 'registration_no', v.registration_no, 'registration_body', v.registration_body,
    'is_doctor', is_doctor(v.id),
    'is_manager', v.is_manager,
    'desks', to_jsonb(my_desk_list())
  );
end
$$;

-- ---------------------------------------------------------------- F my_placement
create or replace function my_placement()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'position', p.position, 'department', d.name, 'departmentId', d.id,
    'specialty', p.specialty, 'station', p.station, 'isManager', p.is_manager,
    'registrationNo', p.registration_no, 'registrationBody', p.registration_body,
    'departments', coalesce((select jsonb_agg(jsonb_build_object('id', dd.id, 'name', dd.name, 'position', sd.position,
                                                                 'services', to_jsonb(sd.services))
                                              order by (sd.department_id = p.department_id) desc, dd.name)
                             from staff_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                             where sd.profile_id = p.id), '[]'::jsonb)
  )
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null
  where p.id = auth.uid()
$$;

-- ---------------------------------------------------------------- F staff_profile
create or replace function staff_profile(p_profile uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := coalesce(p_profile, auth.uid());
  v_mgr boolean := is_manager();
  v_p profiles%rowtype;
  v_h staff_hr%rowtype;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
begin
  if auth.uid() is null or current_role_key() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not (v_mgr or v_id = auth.uid()) then
    raise exception 'not allowed: an employee sees only their own profile' using errcode = '42501';
  end if;
  select * into v_p from profiles where id = v_id and deleted_at is null;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  perform log_staff_profile_access(v_id);
  select * into v_h from staff_hr where profile_id = v_id and deleted_at is null;
  return jsonb_build_object(
    'id', v_p.id, 'fullName', v_p.full_name, 'username', v_p.username, 'staffId', v_p.staff_id,
    'role', v_p.role, 'specialty', v_p.specialty, 'station', v_p.station, 'dashboard', v_p.dashboard,
    'email', v_p.email, 'phone', v_p.phone, 'language', v_p.language,
    'active', v_p.active, 'deactivatedAt', v_p.deactivated_at,
    'createdAt', v_p.created_at, 'createdBy', (select full_name from profiles where id = v_p.created_by),
    'lastSignInAt', v_p.last_sign_in_at, 'mustChangePin', v_p.must_change_pin, 'pinChangedAt', v_p.pin_changed_at,
    'registrationNo', v_p.registration_no, 'registrationBody', v_p.registration_body,
    -- 0126: a doctor (the role, or marked by the manager): sees patient records
    'isDoctor', v_p.role = 'doctor' or v_p.is_doctor, 'doctorMarked', v_p.is_doctor,
    -- 0128: also the clinic manager
    'isManager', v_p.is_manager,
    'departments', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'position', sd.position,
                                                                  'services', to_jsonb(sd.services), 'gives', to_jsonb(coalesce(d.services, '{}')))
                                              order by (sd.department_id = v_p.department_id) desc, d.name)
                             from staff_department sd join department d on d.id = sd.department_id and d.deleted_at is null
                             where sd.profile_id = v_id), '[]'::jsonb),
    'desks', to_jsonb(desks_of(v_id)),
    'hr', jsonb_build_object(
      'emergencyName', v_h.emergency_name, 'emergencyPhone', v_h.emergency_phone, 'address', v_h.address,
      'birthDate', v_h.birth_date, 'sex', v_h.sex, 'nationalId', v_h.national_id,
      'hiredOn', v_h.hired_on, 'contractType', v_h.contract_type, 'contractEnd', v_h.contract_end,
      'registrationExpiresOn', v_h.registration_expires_on,
      'updatedAt', case when v_h.id is not null then v_h.updated_at end,
      'updatedBy', (select full_name from profiles where id = coalesce(v_h.updated_by, v_h.created_by))),
    'access', jsonb_build_object(
      'permissions', (select coalesce(jsonb_agg(jsonb_build_object(
                          'key', k.p, 'allowed', staff_perm(v_id, k.p),
                          'byRole', exists (select 1 from role_permissions rp
                                            where (rp.role = v_p.role or (v_p.is_manager and rp.role = 'manager'))
                                              and rp.permission = k.p),
                          'exception', sp.profile_id is not null,
                          'setAt', sp.set_at, 'setBy', (select full_name from profiles where id = sp.set_by))
                          order by k.n), '[]'::jsonb)
                      from unnest(array['payment.take', 'visit.start', 'vitals.write', 'charge.write', 'clinical.write',
                                        'orders.write', 'appointment.approve', 'stock.write', 'records.approve',
                                        'stock.sell_walkin']) with ordinality as k(p, n)
                      left join staff_permission sp on sp.profile_id = v_id and sp.permission = k.p),
      'trustedDevices', (select count(*)::integer from trusted_device t
                         where t.user_id = v_id and t.revoked_at is null and t.expires_at > now()),
      'signIns', coalesce((select jsonb_agg(jsonb_build_object('at', a.at, 'ok', a.reason is null or a.reason not like 'wrong PIN%',
                                                               'reason', a.reason) order by a.at desc)
                           from (select at, reason from audit_event
                                 where actor_id = v_id and action = 'login' and at > now() - interval '90 days'
                                 order by at desc limit 15) a), '[]'::jsonb),
      'failedSignIns30', (select count(*)::integer from audit_event
                          where actor_id = v_id and action = 'login' and reason like 'wrong PIN%'
                            and at > now() - interval '30 days')),
    'documents', (select jsonb_build_object(
                    'count', count(*)::integer,
                    'expired', count(*) filter (where d.expires_on < v_today)::integer,
                    'expiring', count(*) filter (where d.expires_on between v_today and v_today + 60)::integer)
                  from staff_document d where d.profile_id = v_id and d.deleted_at is null),
    'notes', case when v_mgr then coalesce((
               select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'body', n.body, 'notedOn', n.noted_on,
                                                   'at', n.created_at, 'by', (select full_name from profiles where id = n.created_by))
                                order by n.noted_on desc, n.created_at desc)
               from staff_note n where n.profile_id = v_id and n.deleted_at is null), '[]'::jsonb) end,
    'removedNotes', case when v_mgr then (select count(*)::integer from staff_note n
                                          where n.profile_id = v_id and n.deleted_at is not null) end,
    'canEdit', v_mgr,
    'self', v_id = auth.uid()
  );
end
$$;

-- ---------------------------------------------------------------- D upsert_department
create or replace function upsert_department(
  p_id uuid,
  p_name text,
  p_description text,
  p_roles role_key[],
  p_services text[] default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_before text[];
  v_bad text;
  v_new text[];
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'the department needs a name' using errcode = '22023';
  end if;
  -- the services of 0071, and reception (0085)
  select s into v_bad from unnest(coalesce(p_services, '{}')) s where not desk_key(s) limit 1;
  if v_bad is not null then
    raise exception 'unknown service %', v_bad using errcode = '22023';
  end if;
  -- the desks no department gives yet: once this one does, only departments decide them
  select array_agg(s) into v_new from unnest(coalesce(p_services, '{}')) s where not desk_offered(s);
  if v_id is null then
    insert into department (name, description, roles, services)
    values (trim(p_name), nullif(trim(coalesce(p_description, '')), ''), coalesce(p_roles, '{}'),
            coalesce(p_services, '{}'))
    returning id into v_id;
  else
    select services into v_before from department where id = v_id and deleted_at is null;
    update department set name = trim(p_name), description = nullif(trim(coalesce(p_description, '')), ''),
                          roles = coalesce(p_roles, '{}'), services = coalesce(p_services, services)
    where id = v_id and deleted_at is null;
    if not found then
      raise exception 'department not found' using errcode = 'P0002';
    end if;
    -- 0128: a service the department starts giving is ticked for its members (the manager unticks
    -- it for whoever does not do it there)
    update staff_department sd
    set services = sd.services || array(select s from unnest(coalesce(p_services, '{}')) s
                                        where not (s = any (coalesce(v_before, '{}'))))
    where sd.department_id = v_id and p_services is not null
      and exists (select 1 from unnest(p_services) s where not (s = any (coalesce(v_before, '{}'))));
    -- Heads follow the department's name on their dashboard.
    update profiles set head_of = trim(p_name)
    where id in (select profile_id from staff_department where department_id = v_id and position = 'head');
  end if;
  -- a desk now given for the first time: the people who work there as usual are placed in it when
  -- nothing else changes for them; the manager is told who lost it (F)
  if exists (select 1 from unnest(coalesce(v_new, '{}')) s where desk_offered(s)) then
    perform place_staff_for_desks(false, v_new);
  end if;
  return v_id;
end
$$;

-- ---------------------------------------------------------------- D every department of an employee, with what they do there
-- p_items: [{"department_id": "…", "position": "head|assistant|member", "services": ["dental", …]}],
-- main first (manage-staff only, after the e-mailed code). "services" (0128) are the department's
-- services this person does there; left out (an older manage-staff), a new placement gets all of
-- them and an existing one keeps its own.
create or replace function set_staff_departments(p_profile_id uuid, p_items jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_first jsonb := case when jsonb_typeof(p_items) = 'array' then p_items -> 0 end;
  v_it jsonb;
  v_dep department%rowtype;
  v_services text[];
  v_bad text;
begin
  for v_it in select e from jsonb_array_elements(coalesce(p_items, '[]')) e loop
    select * into v_dep from department where id = nullif(v_it ->> 'department_id', '')::uuid and deleted_at is null;
    if not found then
      raise exception 'department not found' using errcode = 'P0002', hint = 'not_found';
    end if;
    if jsonb_typeof(v_it -> 'services') = 'array' then
      v_services := array(select jsonb_array_elements_text(v_it -> 'services'));
      select s into v_bad from unnest(v_services) s where not (s = any (coalesce(v_dep.services, '{}'))) limit 1;
      if v_bad is not null then
        raise exception 'the department % does not give %', v_dep.name, v_bad
          using errcode = '22023', hint = 'service_not_given';
      end if;
      if cardinality(v_services) = 0 and cardinality(coalesce(v_dep.services, '{}')) > 0 then
        raise exception 'tick at least one service this person does in %', v_dep.name
          using errcode = '22023', hint = 'no_service';
      end if;
    end if;
  end loop;
  update profiles
  set department_id = nullif(v_first ->> 'department_id', '')::uuid,
      position = coalesce(nullif(v_first ->> 'position', ''), 'member')
  where id = p_profile_id;
  delete from staff_department sd
  where sd.profile_id = p_profile_id
    and not exists (select 1 from jsonb_array_elements(coalesce(p_items, '[]')) x
                    where (x ->> 'department_id')::uuid = sd.department_id);
  for v_it in select e from jsonb_array_elements(coalesce(p_items, '[]')) e loop
    v_services := case when jsonb_typeof(v_it -> 'services') = 'array'
                       then array(select jsonb_array_elements_text(v_it -> 'services')) end;
    insert into staff_department (profile_id, department_id, position, services)
    values (p_profile_id, (v_it ->> 'department_id')::uuid, coalesce(nullif(v_it ->> 'position', ''), 'member'), v_services)
    on conflict (profile_id, department_id) do update
      set position = excluded.position,
          services = case when v_services is null then staff_department.services else excluded.services end;
  end loop;
end
$$;
revoke all on function set_staff_departments(uuid, jsonb) from public, anon, authenticated;
grant execute on function set_staff_departments(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------- F the employee list
-- (the 0126 view, the same columns) with the services of each placement and, at the end, the
-- manager flag.
create or replace view staff_directory with (security_invoker = true) as
  select p.id, p.username, p.full_name, p.role, p.station, p.dashboard, p.head_of, p.language, p.phone,
         p.active, p.must_change_pin, p.last_sign_in_at, p.pin_changed_at, p.deactivated_at, p.created_at,
         p.staff_id, p.email, p.department_id, d.name as department_name, p.position, p.specialty,
         coalesce((select jsonb_agg(jsonb_build_object('id', dd.id, 'name', dd.name, 'position', sd.position,
                                                       'services', to_jsonb(sd.services))
                                    order by (sd.department_id = p.department_id) desc, dd.name)
                   from staff_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.profile_id = p.id), '[]'::jsonb) as departments,
         p.registration_no, p.registration_body,
         desks_of(p.id) as desks, kept_desks_of(p.id) as kept_desks,
         -- 0126: marked a doctor by the manager (the role 'doctor' is one anyway)
         p.is_doctor,
         -- 0128: also the clinic manager
         p.is_manager
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null
  where p.deleted_at is null;
revoke all on staff_directory from anon;
grant select on staff_directory to authenticated;
