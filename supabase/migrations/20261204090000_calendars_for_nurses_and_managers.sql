-- 0094 · Calendars for nurses and the manager.
--
-- Frank: a manager may be a doctor and wants their own calendar, chosen in "Calendar of" like
-- anyone else's; a nurse keeps a calendar and is booked, on the website and at reception, like
-- a doctor.
--
-- Who keeps a calendar (and can be booked): doctors, sonographers, nurses and managers.
--  - calendar_role_ok, calendar_people (the manager sees themself), save_calendar,
--    ensure_practitioner and bookable_doctors accept the four roles.
--  - public_practitioners says the role of each public calendar, so the website labels a nurse
--    as a nurse (the column is added at the end of the view; everything else is unchanged).
--  - appointment_arrived: a nurse's booked patient waits at the Nursing desk; a doctor's or a
--    manager's at the desk their specialty implies (Dental for a dentist, else Consultation).
--  - Nurses and the manager answer the bookings made with them (appointment.accept), as the
--    sonographer does since 0056.

insert into role_permissions (role, permission) values
  ('nurse', 'appointment.accept'),
  ('manager', 'appointment.read'), ('manager', 'appointment.accept')
on conflict do nothing;

-- ---------------------------------------------------------------- who keeps a calendar
create or replace function calendar_role_ok(p_user uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from profiles where id = p_user and active
                   and role in ('doctor', 'sonographer', 'nurse', 'manager'))
$$;

-- Manager: everyone who may keep a calendar (the manager included), with whether one is saved.
create or replace function calendar_people()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', p.id, 'name', p.full_name, 'role', p.role, 'staffId', p.staff_id,
    'visibility', pr.calendar_visibility, 'saved', pr.id is not null
  ) order by (p.id = auth.uid()) desc, p.full_name), '[]'::jsonb)
  from profiles p
  left join practitioner pr on pr.user_id = p.id and pr.deleted_at is null
  where is_manager() and p.active and p.role in ('doctor', 'sonographer', 'nurse', 'manager')
$$;

create or replace function save_calendar(
  p_user uuid,
  p_hours jsonb,
  p_slot_minutes integer,
  p_visibility text,
  p_days_off date[] default '{}',
  p_note text default null,
  p_title text default null,
  p_categories text[] default '{}',
  p_languages text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_user uuid := coalesce(p_user, auth.uid());
  v_id uuid;
  v_name text;
  v_staff text;
  v_key text;
  v_span jsonb;
  v_hours jsonb := coalesce(p_hours, '{}'::jsonb);
begin
  if auth.uid() is null or (v_user <> auth.uid() and not is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not calendar_role_ok(v_user) then
    raise exception 'only doctors, sonographers, nurses and managers keep a calendar' using errcode = '22023';
  end if;
  if coalesce(p_visibility, '') not in ('private', 'staff', 'public') then
    raise exception 'choose who may see the calendar' using errcode = '22023';
  end if;
  if p_slot_minutes is null or p_slot_minutes not between 5 and 240 then
    raise exception 'the booking slot must be between 5 and 240 minutes' using errcode = '22023';
  end if;
  if jsonb_typeof(v_hours) <> 'object' then
    raise exception 'working hours are not valid' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(v_hours) loop
    if v_key not in ('0', '1', '2', '3', '4', '5', '6') or jsonb_typeof(v_hours -> v_key) <> 'array' then
      raise exception 'working hours are not valid' using errcode = '22023';
    end if;
    for v_span in select * from jsonb_array_elements(v_hours -> v_key) loop
      if (v_span ->> 0) !~ '^[0-2][0-9]:[0-5][0-9]$' or (v_span ->> 1) !~ '^[0-2][0-9]:[0-5][0-9]$'
         or (v_span ->> 0)::time >= (v_span ->> 1)::time then
        raise exception 'each working period must start before it ends' using errcode = '22023';
      end if;
    end loop;
  end loop;

  select full_name, staff_id into v_name, v_staff from profiles where id = v_user;
  select id into v_id from practitioner where user_id = v_user and deleted_at is null limit 1;
  if v_id is null then
    insert into practitioner (code, user_id, names, title, slot_minutes, working_hours, categories,
                              languages, calendar_visibility, days_off, calendar_note, active)
    values (lower(coalesce(v_staff, 'dr-' || left(v_user::text, 8))), v_user, v_name,
            nullif(trim(coalesce(p_title, '')), ''), p_slot_minutes, v_hours, coalesce(p_categories, '{}'),
            nullif(trim(coalesce(p_languages, '')), ''), p_visibility, coalesce(p_days_off, '{}'),
            nullif(trim(coalesce(p_note, '')), ''), true)
    returning id into v_id;
  else
    update practitioner
    set names = coalesce(v_name, names), title = nullif(trim(coalesce(p_title, '')), ''),
        slot_minutes = p_slot_minutes, working_hours = v_hours, categories = coalesce(p_categories, '{}'),
        languages = nullif(trim(coalesce(p_languages, '')), ''), calendar_visibility = p_visibility,
        days_off = coalesce(p_days_off, '{}'), calendar_note = nullif(trim(coalesce(p_note, '')), ''),
        active = true
    where id = v_id;
  end if;
  return v_id;
end
$$;

revoke all on function calendar_role_ok(uuid), calendar_people(),
  save_calendar(uuid, jsonb, integer, text, date[], text, text, text[], text) from public, anon;
grant execute on function calendar_people(),
  save_calendar(uuid, jsonb, integer, text, date[], text, text, text[], text) to authenticated;

-- ---------------------------------------------------------------- who can be booked
-- The calendar row of a person, created the first time they are booked (private, no hours yet).
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
  where id = p_user and active and role in ('doctor', 'sonographer', 'nurse', 'manager');
  if v_name is null then
    raise exception 'only doctors, sonographers, nurses and managers can be booked' using errcode = '22023';
  end if;
  insert into practitioner (code, user_id, names, slot_minutes, working_hours, calendar_visibility, active)
  values (lower(coalesce(v_staff, 'dr-' || left(p_user::text, 8))), p_user, v_name, 30, '{}'::jsonb, 'private', true)
  returning id into v_id;
  return v_id;
end
$$;

-- Reception's list: everyone who can be booked, with their role (the form labels a nurse).
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
  where has_perm('appointment.read') and p.active and p.role in ('doctor', 'sonographer', 'nurse', 'manager')
$$;

revoke all on function ensure_practitioner(uuid), bookable_doctors() from public, anon;
grant execute on function ensure_practitioner(uuid), bookable_doctors() to authenticated;

-- ---------------------------------------------------------------- the website: the role of each public calendar
create or replace view public_practitioners as
  select pr.id, pr.code, pr.names, pr.title, pr.specialty, pr.categories, pr.languages,
         pr.working_hours, pr.slot_minutes, pr.days_off, pr.calendar_note,
         (select p.role::text from profiles p where p.id = pr.user_id) as role
  from practitioner pr
  where pr.active and pr.deleted_at is null and pr.calendar_visibility = 'public'
    and pr.user_id is not null
    and exists (select 1 from profiles p where p.id = pr.user_id and p.active);
revoke insert, update, delete, truncate, references, trigger on public_practitioners from anon, authenticated;
grant select on public_practitioners to anon, authenticated;

-- ---------------------------------------------------------------- arrival: the booked person's desk
-- A nurse's booked patient waits at Nursing; a doctor's (or a manager's) at Dental when their
-- desk is the dental one, else at Consultation. A patient already in the clinic keeps their
-- place; only a visit started by the arrival goes to the booked person.
create or replace function appointment_arrived(p_appointment_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_appt appointment%rowtype;
  v_visit jsonb;
  v_enc uuid;
  v_doctor uuid;
  v_desk station;
  v_name text;
begin
  if not has_perm('appointment.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_appt from appointment where id = p_appointment_id and deleted_at is null for update;
  if not found or v_appt.status not in ('approved', 'confirmed') then
    raise exception 'this appointment is not waiting for the patient' using errcode = 'P0002';
  end if;
  if v_appt.patient_id is null then
    raise exception 'register the patient first, then mark the arrival' using errcode = 'P0002';
  end if;
  select user_id into v_doctor from practitioner where id = v_appt.practitioner_id;
  -- the booked person's desk: a nurse at Nursing, a dentist at Dental, anyone else at Consultation
  select case
           when p.role = 'nurse' then 'nursing'::station
           when lower(coalesce(p.station, '')) like '%dent%' then 'dental'::station
           else 'consultation'::station end
  into v_desk
  from profiles p where p.id = v_doctor;
  v_desk := coalesce(v_desk, 'consultation'::station);

  select jsonb_build_object(
           'encounter_id', e.id,
           'ticket_no', (select q.ticket_no from queue_entry q where q.encounter_id = e.id order by q.created_at limit 1),
           'station', (select q.station from queue_entry q where q.encounter_id = e.id and q.finished_at is null
                       order by q.created_at desc limit 1),
           'existing', true)
  into v_visit
  from encounter e where e.patient_id = v_appt.patient_id and e.status = 'open' and e.deleted_at is null
  order by e.arrived_at desc limit 1;

  if v_visit is null then
    v_visit := start_visit(v_appt.patient_id, false, v_desk);
  end if;
  v_enc := (v_visit ->> 'encounter_id')::uuid;

  -- The visit belongs to the booking: the booked person has the patient, and the booking
  -- completes when the visit ends.
  update encounter
  set appointment_id = coalesce(appointment_id, v_appt.id),
      practitioner_id = coalesce(practitioner_id, v_appt.practitioner_id)
  where id = v_enc;

  -- already in the clinic but waiting nowhere: back in line (triage or the booked person's desk)
  if not exists (select 1 from queue_entry where encounter_id = v_enc and finished_at is null and deleted_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no)
    values (v_enc, case when triage_first() then 'triage'::station else v_desk end,
            (select ticket_no from queue_entry where encounter_id = v_enc order by created_at limit 1));
  end if;
  -- waiting at the booked person's desk, nobody has them yet: given to that person
  if v_doctor is not null then
    if not coalesce((v_visit ->> 'existing')::boolean, false) then
    update queue_entry set assigned_to = v_doctor
    where encounter_id = v_enc and finished_at is null and deleted_at is null and taken_by is null
      and assigned_to is null and station in ('consultation', 'dental', 'nursing');
    end if;
    select p.surname || ' ' || p.given_names into v_name from patient p where p.id = v_appt.patient_id;
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('booked_arrived',
            jsonb_build_object('name', v_name, 'when', v_appt.starts_at, 'triage', triage_first()),
            '/app/visit?encounter=' || v_enc, v_doctor, auth.uid());
  end if;

  update appointment set status = 'arrived' where id = p_appointment_id;
  return v_visit || jsonb_build_object('station',
    (select q.station from queue_entry q where q.encounter_id = v_enc and q.finished_at is null order by q.created_at desc limit 1));
end
$$;
revoke all on function appointment_arrived(uuid) from public, anon;
grant execute on function appointment_arrived(uuid) to authenticated;
