-- 0197 · A doctor registers patients; a visit is sent to one named doctor by whoever starts it.
--
-- Frank (testing outcomes 1 and 2):
--   "Why is it that the doctor is unable to register patient also … the doctor must be able to
--    register a patient but in their dashboards for now that feature is not enabled for them."
--   "In the nurse portal am registering patient and when i try to send to a certain desk they are
--    telling me … he is not allowed … when the nurse creates the patient and sends him to any
--    doctor or a person who works in that department it works but when he identifies the one
--    specifically that is when the error comes in."
--
-- * THE NAMED DOCTOR (task 2). begin_visit keeps the doctor chosen on the visit
--   (encounter.practitioner_id) and asked ensure_practitioner for that doctor's calendar row.
--   ensure_practitioner is the BOOKING desk's function: it refuses ("not allowed", 42501) anyone
--   who may not answer booking requests (appointment.approve), is not the manager and is not that
--   doctor. Reception has that switch, so reception could name a doctor; a nurse (or a doctor
--   naming a colleague) was refused, while "anyone at the desk" never reached that line. Naming a
--   nurse, a lab technician or a pharmacist worked, because only a doctor is kept on the visit.
--   Now begin_visit reads the calendar row through practitioner_row (the same body, no booking
--   check, not callable from outside): starting the visit is the right that counts, and
--   begin_visit has already checked it (Start visits, the reception desk, and that the person
--   named gives the service chosen: staff_serves). ensure_practitioner keeps its own check for
--   the calendar screens.
--   The triage screen (record_vitals_to, send_from_triage_to) never called it: unchanged.
-- * THE DOCTOR REGISTERS (task 1). Since 0085 the reception desk (register, start a visit) was a
--   doctor's only while no department of the clinic gave "reception", or when the doctor was put
--   in a department giving it. From now a doctor has it by profession, whatever the departments
--   give (desk_via: 'role'), so the doctor's menu and home show Register and start_visit,
--   begin_visit and open_encounter accept them. The manager still decides: the "Start visits"
--   switch (for the profession or for one doctor) and the profession's desks in Settings → Who
--   may do what take it away. The other professions are unchanged (their departments decide).
--
-- No new refusal sentence. Errcodes as before: 42501 not allowed, 22023 bad input.

-- ---------------------------------------------------------------- the calendar row of a person, made when missing
-- (the body of ensure_practitioner from 20270108090000_profession_manager, without the check of
-- who asks: for the functions that have already checked their own right)
create or replace function practitioner_row(p_user uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_name text;
  v_staff text;
begin
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
revoke all on function practitioner_row(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- ensure_practitioner (from 20270108090000_profession_manager)
-- The same rule for the calendar screens (whoever answers bookings, the manager, or the person
-- themself); the work is in practitioner_row.
create or replace function ensure_practitioner(p_user uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
begin
  if not (has_perm('appointment.approve') or is_manager() or p_user = auth.uid()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return practitioner_row(p_user);
end
$$;

-- ---------------------------------------------------------------- begin_visit (from 20270108090000_profession_manager)
-- 0197: the doctor named is kept on the visit through practitioner_row, so whoever may start the
-- visit may name them (a nurse was refused by the booking desk's check). Nothing else changes.
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
  -- who may be named: an active person who gives the service chosen (their section, or their
  -- usual desk while nobody is set for it)
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
        -- 0197: practitioner_row, not ensure_practitioner (the right to start the visit was checked above)
        then practitioner_row(p_assigned_to) else practitioner_id end
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

-- ---------------------------------------------------------------- desk_via (from 20270129090000_pharmacy_keeper)
-- 0197: + a doctor has the reception desk (register a patient, start a visit) by profession,
-- whatever the departments give. The profession's desks (role_desk) and the "Start visits" switch
-- (the profession's, or the manager's exception for one doctor) still take it away. Everything
-- else as before.
create or replace function desk_via(p_user uuid, p_desk text)
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when not desk_key(p_desk) then null
    when ex.allowed = false then null
    -- 0170: marked by the manager as the one who keeps the pharmacy stock: the Pharmacy desk,
    -- whatever the role or the departments
    when p_desk = 'pharmacy' and p.is_pharmacist then 'keeper'
    -- the role's ceiling
    when not exists (select 1 from role_desk rd where (rd.role = p.role or (dh.here and rd.role = 'doctor')) and rd.desk = p_desk) then null
    when in_desk_department(p.id, p_desk)
         and (p_desk in ('laboratory', 'ultrasound', 'pharmacy') or coalesce(ex.allowed, rl.has)) then 'department'
    -- kept on day one by the rule of before (F)
    when coalesce(ex.allowed, rl.has)
         and exists (select 1 from staff_desk_keep k where k.profile_id = p.id and k.desk = p_desk) then 'kept'
    -- 0197: a doctor registers patients and starts visits by profession, in no reception department
    when p_desk = 'reception' and p.role = 'doctor' and coalesce(ex.allowed, rl.has) then 'role'
    -- no department gives it: the role decides, as before
    when not desk_offered(p_desk) and coalesce(ex.allowed, rl.has)
         and desk_role_rule(p.role, p.station::text, p.specialty::text, p_desk) then 'role'
  end
  from profiles p
  cross join lateral (select doctor_here_at(p.id, p_desk) as here) dh
  cross join lateral (
    select exists (select 1 from role_permissions rp
                   where (rp.role = p.role or (p.is_manager and rp.role = 'manager') or (dh.here and rp.role = 'doctor'))
                     and rp.permission = desk_permission(p_desk)) as has
  ) rl
  left join staff_permission ex on ex.profile_id = p.id and ex.permission = desk_permission(p_desk)
  where p.id = p_user and p.active and p.deleted_at is null
$$;
