-- 0205 · Physiotherapy, a section of its own like Dental; HIV testing is a service, not a section
-- (Frank, 2026-11-25: "Replace HIV and testing with Physiotherapy … it must also appear on the home
-- page … the same as dental or minor surgery … a department where people are placed in order to
-- give it; HIV and testing is just a service, it must not have a department").
--
-- The station 'physio' (added alone by 20270222090000_physio_station) becomes a desk and a section:
-- patients are sent there and called there (ticket F-…), the people of a department that gives it
-- work there, it counts in the waiting times, the patients seen, the menu counts and the beds
-- board, and it may carry out orders. Every function that lists the treating desks is copied whole
-- from its latest definition with 'physio' beside 'dental'; 'hiv' leaves the desks and sections
-- (HIV testing and vaccination stay what they are in the price list: services, at Nursing or the
-- laboratory). The roles that may use Dental may use Physiotherapy; a department "Physiotherapy" is
-- made when none gives it, for the manager to place people in.

-- service_station: copied whole from 20261111090000_triage_nurse_track; 0205: physio.
create or replace function service_station(p_service text)
returns station
language sql immutable
as $$
  select case p_service
    when 'consultation' then 'consultation'
    when 'dental' then 'dental'
    when 'physio' then 'physio'
    when 'laboratory' then 'laboratory'
    when 'ultrasound' then 'ultrasound'
    when 'nursing' then 'nursing'
    when 'surgery' then 'theatre'
    when 'circ' then 'theatre'
    when 'fp' then 'nursing'
    when 'pharmacy' then 'pharmacy'
    when 'triage' then 'triage'
  end::station
$$;

-- all_desks: copied whole from 20261126090000_departments_decide_desks; 0205: physio.
create or replace function all_desks()
returns text[]
language sql immutable
as $$
  select array['reception', 'triage', 'consultation', 'dental', 'physio', 'surgery', 'circ', 'nursing', 'fp',
               'laboratory', 'ultrasound', 'pharmacy']
$$;

-- treating_desks: copied whole from 20261126090000_departments_decide_desks; 0205: physio.
create or replace function treating_desks()
returns text[]
language sql immutable
as $$
  select array['consultation', 'dental', 'physio', 'surgery', 'circ', 'nursing', 'fp']
$$;

-- station_desks: copied whole from 20261126090000_departments_decide_desks; 0205: physio.
create or replace function station_desks(p_station station)
returns text[]
language sql immutable
as $$
  select case p_station
    when 'reception' then array['reception']
    when 'triage' then array['triage']
    when 'consultation' then array['consultation']
    when 'dental' then array['dental']
    when 'physio' then array['physio']
    when 'theatre' then array['surgery', 'circ']
    when 'nursing' then array['nursing', 'fp']
    when 'beds' then array['nursing']
    when 'laboratory' then array['laboratory']
    when 'ultrasound' then array['ultrasound']
    when 'pharmacy' then array['pharmacy']
    else '{}'::text[]
  end
$$;

-- station_role: copied whole from 20261020120000_departments_notifications; 0205: physio.
create or replace function station_role(p_station station)
returns role_key
language sql immutable
as $$
  select case p_station
    when 'reception' then 'receptionist'
    when 'triage' then 'nurse'
    when 'nursing' then 'nurse'
    when 'beds' then 'nurse'
    when 'consultation' then 'doctor'
    when 'dental' then 'doctor'
    when 'physio' then 'doctor'
    when 'theatre' then 'doctor'
    when 'laboratory' then 'lab_tech'
    when 'ultrasound' then 'sonographer'
    when 'pharmacy' then 'pharmacist'
    when 'cashier' then 'cashier'
  end::role_key
$$;

-- serves_station: copied whole from 20261112090000_sections_not_roles; 0205: physio.
create or replace function serves_station(p_user uuid, p_station station, p_service text default null)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    when p_service is not null and service_station(p_service) = p_station then staff_serves(p_user, p_service)
    when p_station in ('consultation', 'dental', 'physio', 'laboratory', 'ultrasound', 'nursing', 'theatre', 'pharmacy', 'triage') then
      exists (select 1 from unnest(array['consultation', 'dental', 'physio', 'laboratory', 'ultrasound', 'nursing', 'surgery',
                                         'circ', 'fp', 'pharmacy', 'triage']) as x(s)
              where service_station(x.s) = p_station and staff_serves(p_user, x.s))
    else exists (select 1 from profiles where id = p_user and active and role = station_role(p_station))
  end
$$;

-- role_serves: copied whole from 20270108090000_profession_manager; 0205: physio.
create or replace function role_serves(p_role role_key, p_station text, p_service text, p_specialty text)
returns boolean
language sql immutable
as $$
  select case p_role
    when 'doctor' then
      -- the desk name, as in 0071
      (p_service = 'dental' and x.desk ~ 'dent')
      or (p_service = 'physio' and x.desk ~ '(physio|kin[ée]si|fiziyo|fizyo)')
      or (p_service in ('surgery', 'circ') and x.desk ~ '(theat|surg|circ)')
      or (p_service = 'ultrasound' and x.desk ~ '(ultra|echo)')
      or (p_service = 'consultation' and x.desk !~ '(dent|physio|kin[ée]si|fiziyo|fizyo|theat|surg|ultra|echo)')
      -- the specialty adds its section
      or coalesce(p_service = x.section, false)
      or (coalesce(x.section, '') = 'surgery' and p_service = 'circ')
    when 'sonographer' then p_service = 'ultrasound'
    when 'nurse' then p_service in ('nursing', 'fp', 'triage')
    when 'midwife' then p_service in ('nursing', 'fp', 'triage')
    when 'lab_tech' then p_service = 'laboratory'
    when 'pharmacist' then p_service = 'pharmacy'
    else false
  end
  from (
    select case
      when s ~ '(\mdent|amenyo|orthodon|stomato)' then 'dental'
      when s ~ '(physio|kin[ée]si|fiziyo|fizyo)' then 'physio'
      when s ~ '(ultra|\m[ée]cho|sonog|radiol|imaging|imagerie|mucyuma)' then 'ultrasound'
      when s ~ '(surg|chirurg|kubaga|theat|th[ée][aâ]tre|\mcirc|gusiramura|anaesth|anesth)' then 'surgery'
      when s ~ ('(g[ée]n[ée]ral|\mgp\M|family|famille|physician|m[ée]decin|internal|interne|'
                || 'paediat|p[ée]diat|gyn|obst|ophtal|ophthal|\ment\M|\morl\M|cardio|derma|'
                || 'neuro|psychiat|urolog|gastro|pneumo|endocrin|rheumat|rhumat|muganga)') then 'consultation'
    end as section, t.desk
    from (select lower(trim(coalesce(p_specialty, ''))) as s, lower(coalesce(p_station, '')) as desk) t
  ) x
$$;

-- station_named: copied whole from 20261231090000_personal_dashboards; 0205: physio.
create or replace function station_named(p_text text)
returns station
language sql immutable
as $$
  select case
    when p_text is null then null
    when p_text ilike '%dent%' then 'dental'
    when p_text ~* '(physio|kin[ée]si|fiziyo|fizyo)' then 'physio'
    when p_text ilike '%lab%' then 'laboratory'
    when p_text ilike '%ultra%' or p_text ilike '%echo%' then 'ultrasound'
    when p_text ilike '%pharm%' or p_text ilike '%farum%' then 'pharmacy'
    when p_text ilike '%theat%' or p_text ilike '%surg%' then 'theatre'
    when p_text ilike '%triage%' then 'triage'
    when p_text ilike '%nurs%' then 'nursing'
    when p_text ilike '%recep%' then 'reception'
    when p_text ilike '%cash%' or p_text ilike '%caiss%' then 'cashier'
    when p_text ilike '%consult%' then 'consultation'
    else null
  end::station
$$;

-- open_encounter: copied whole from 20261126090000_departments_decide_desks; 0205: physio.
create or replace function open_encounter(
  p_patient_id uuid,
  p_type encounter_type default 'opd',
  p_station station default 'triage',
  p_coverage_id uuid default null,
  p_appointment_id uuid default null,
  p_practitioner_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_ticket text;
  v_prefix text := case p_station when 'dental' then 'D' when 'physio' then 'F' when 'laboratory' then 'L' when 'ultrasound' then 'U' when 'pharmacy' then 'P' else 'A' end;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if coalesce(current_setting('mmc.visit_open', true), '') <> 'on' then
    if not has_perm('visit.start') then
      raise exception 'you may not start visits (the manager has not allowed it)' using errcode = '42501';
    end if;
    perform assert_desk(array['reception'], 'starting visits');
  end if;
  insert into encounter (patient_id, type, coverage_id, appointment_id, practitioner_id)
  values (p_patient_id, p_type, p_coverage_id, p_appointment_id, p_practitioner_id)
  returning id into v_id;
  v_ticket := v_prefix || '-' || lpad(next_number('ticket_' || v_prefix, to_char(now(), 'YYYYDDD')::integer)::text, 3, '0');
  insert into queue_entry (encounter_id, station, ticket_no) values (v_id, p_station, v_ticket);
  if p_appointment_id is not null then
    update appointment set status = 'arrived' where id = p_appointment_id and status in ('confirmed', 'approved');
  end if;
  return v_id;
end
$$;

-- begin_visit: copied whole from 20270215090000_register_and_send_rights; 0205: physio.
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
       (v_role = 'doctor' and v_desk in ('consultation', 'dental', 'physio', 'theatre', 'ultrasound'))
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

-- answer_call: copied whole from 20270108090000_profession_manager; 0205: physio.
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
     and v_q.station not in ('triage', 'reception', 'consultation', 'dental', 'physio') then
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

-- appointment_arrived: copied whole from 20261218090000_reception_and_fields; 0205: physio.
create or replace function appointment_arrived(
  p_appointment_id uuid,
  p_patient_id uuid default null,
  p_registration jsonb default null
)
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
  v_file jsonb;
begin
  if not has_perm('appointment.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_appt from appointment where id = p_appointment_id and deleted_at is null for update;
  if not found or v_appt.status not in ('approved', 'confirmed') then
    raise exception 'this appointment is not waiting for the patient' using errcode = 'P0002';
  end if;
  -- 0108: a booking without a file: an existing file is chosen (p_patient_id), or the file is
  -- made now from the registration form (checked like any new file, required fields included);
  -- never a bare file. It all happens with the arrival, or not at all.
  if v_appt.patient_id is null then
    if p_patient_id is not null then
      if not exists (select 1 from patient where id = p_patient_id and deleted_at is null and merged_into is null) then
        raise exception 'patient not found' using errcode = 'P0002';
      end if;
      v_appt.patient_id := p_patient_id;
    elsif p_registration is not null and jsonb_typeof(p_registration) = 'object' then
      v_file := create_patient_file(p_registration, false);
      v_appt.patient_id := (v_file ->> 'patient_id')::uuid;
    else
      raise exception 'register the patient first, then mark the arrival' using errcode = 'P0002';
    end if;
    update appointment set patient_id = v_appt.patient_id where id = p_appointment_id;
  elsif (p_patient_id is not null and p_patient_id <> v_appt.patient_id) or p_registration is not null then
    raise exception 'this booking already has a patient file' using errcode = '22023';
  end if;
  select user_id into v_doctor from practitioner where id = v_appt.practitioner_id;
  -- the booked person's desk: a nurse at Nursing, a dentist at Dental, anyone else at Consultation
  select case
           when p.role = 'nurse' then 'nursing'::station
           when lower(coalesce(p.station, '')) like '%dent%' then 'dental'::station
           when lower(coalesce(p.station, '')) ~ '(physio|kin[ée]si|fiziyo|fizyo)' then 'physio'::station
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
      and assigned_to is null and station in ('consultation', 'dental', 'physio', 'nursing');
    end if;
    select p.surname || ' ' || p.given_names into v_name from patient p where p.id = v_appt.patient_id;
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('booked_arrived',
            jsonb_build_object('name', v_name, 'when', v_appt.starts_at, 'triage', triage_first()),
            '/app/visit?encounter=' || v_enc, v_doctor, auth.uid());
  end if;

  update appointment set status = 'arrived' where id = p_appointment_id;
  return v_visit || jsonb_build_object('station',
    (select q.station from queue_entry q where q.encounter_id = v_enc and q.finished_at is null order by q.created_at desc limit 1),
    'patient_id', v_appt.patient_id,
    'file_number', (select file_number from patient where id = v_appt.patient_id),
    'new_file', v_file is not null);
end
$$;

-- nav_counts: copied whole from 20270218090000_dose_parts_schedule; 0205: physio.
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
  v_l integer; -- 0198
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
      select q.encounter_id, q.started_at, (q.created_at >= v_start or visit_in_bed(q.encounter_id)) as is_today
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
             'inClinic', count(*) filter (where e.arrived_at >= v_start or visit_in_bed(e.id)),
             'inClinicEarlier', count(*) filter (where e.arrived_at < v_start and not visit_in_bed(e.id)))
    into v_out
    from encounter e where e.status = 'open' and e.deleted_at is null;
  end if;

  -- RESULTS FOR ME and MY PRESCRIPTIONS AT THE PHARMACY: whoever has those menu entries (a doctor
  -- at a treating desk; anyone a department of theirs gives a doctor's desk; as the menu decides)
  if ((v_role = 'doctor' and v_desks && treating_desks())
          or exists (select 1 from unnest(array['consultation', 'dental', 'physio', 'surgery', 'circ']) d(desk)
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
  -- all the nurses when I work at the nursing desk. 0198: only those with a time due now or late (a
  -- time within the next 30 minutes, or past; an order written before 0198 since it was written):
  -- due today, due on an earlier day; + nurseOrdersLate: the times more than an hour late, on the
  -- orders written with a time (0198 onwards). An order for later is not counted until it is due.
  if has_perm('clinical.write') then
    with mine as (
      select case when o.every_minutes is null then coalesce(o.first_at, o.created_at)
                  else (select min(t.due_at) from order_times(o.id) t where t.dose_id is null) end as next_due,
             case when o.first_at is null then 0
                  when o.every_minutes is null then (o.first_at < now() - interval '60 minutes')::integer
                  else (select count(*)::integer from order_times(o.id) t
                        where t.dose_id is null and t.due_at < now() - interval '60 minutes') end as late_n
      from nurse_order o
      join encounter e on e.id = o.encounter_id and e.status = 'open' and e.deleted_at is null
      where o.deleted_at is null and o.status = 'open' and nurse_order_mine(o.assigned_to)
    )
    select count(*) filter (where next_due <= now() + interval '30 minutes' and next_due >= v_start),
           count(*) filter (where next_due <= now() + interval '30 minutes' and next_due < v_start),
           coalesce(sum(late_n), 0)
    into v_n, v_e, v_l
    from mine;
    if v_n + v_e > 0 or task_for_me('nurse') then
      v_out := v_out || jsonb_build_object('nurseOrders', v_n, 'nurseOrdersEarlier', v_e, 'nurseOrdersLate', v_l);
    end if;
  end if;

  -- 0197: PATIENTS IN BEDS now (information): whoever reads the beds
  if has_perm('queue.read') or has_perm('billing.write') or has_perm('payment.take') then
    v_out := v_out || jsonb_build_object('inBeds',
      (select count(distinct s.encounter_id) from bed_stay s
       join encounter e on e.id = s.encounter_id and e.status = 'open' and e.deleted_at is null
       where s.discharged_at is null and s.deleted_at is null));
  end if;

  -- an "earlier" count only when there is something from an earlier day
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_out
  from jsonb_each(v_out) x(k, v)
  where not (k like '%Earlier' and v = '0'::jsonb);

  return v_out;
end
$$;

-- wait_time_stats: copied whole from 20261127090000_analytics; 0205: physio.
create or replace function wait_time_stats(p_from date default null, p_to date default null, p_department uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  s record;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_len integer;
  v_start timestamptz;
  v_end timestamptz;
  -- the desks where a wait is measured (reception and beds: not)
  v_measured station[] := array['triage', 'consultation', 'dental', 'physio', 'theatre', 'nursing', 'laboratory', 'ultrasound',
                                'pharmacy', 'cashier']::station[];
  v_stations station[];
  v_result jsonb;
begin
  select * into s from analytics_scope(p_department);
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  v_len := v_to - v_from + 1;
  v_start := v_from::timestamp at time zone 'Africa/Kigali';
  v_end := (v_to + 1)::timestamp at time zone 'Africa/Kigali';
  select coalesce(array_agg(x order by array_position(v_measured, x)), '{}') into v_stations
  from unnest(v_measured) x where x = any (s.s_stations);

  with w as (
    -- one wait per queue entry: from joining the desk's queue to the desk's end event
    select q.id, q.station, q.encounter_id, q.created_at as start_at,
           case
             when q.station in ('consultation', 'dental', 'physio', 'theatre', 'nursing', 'laboratory', 'ultrasound') then q.started_at
             when q.station = 'triage' then (
               select min(o.effective_at) from observation o
               where o.encounter_id = q.encounter_id and o.deleted_at is null and o.code <> 'note'
                 and o.effective_at >= q.created_at and o.effective_at <= coalesce(q.finished_at, now()))
             when q.station = 'cashier' then (
               select min(y.paid_at) from payment y join invoice i on i.id = y.invoice_id
               where i.encounter_id = q.encounter_id and y.paid_at >= q.created_at and y.paid_at <= coalesce(q.finished_at, now()))
             when q.station = 'pharmacy' then (
               select min(x.at) from (
                 select md.created_at as at from medication_dispense md
                 where md.encounter_id = q.encounter_id and md.deleted_at is null
                 union all
                 select m.given_at from medication_request m
                 where m.encounter_id = q.encounter_id and m.deleted_at is null and m.given_at is not null) x
               where x.at >= q.created_at and x.at <= coalesce(q.finished_at, now()))
           end as end_at
    from queue_entry q
    where q.deleted_at is null and q.station = any (v_stations)
      and q.created_at < v_end and q.created_at >= v_start - interval '2 days'
  ),
  d as (
    select w.*, extract(epoch from w.end_at - w.start_at)::float8 / 60 as minutes,
           (w.end_at at time zone 'Africa/Kigali')::date as day,
           (w.end_at - w.start_at > interval '12 hours'
            or (w.start_at at time zone 'Africa/Kigali')::date <> (w.end_at at time zone 'Africa/Kigali')::date) as excluded
    from w
    where w.end_at is not null and w.end_at >= w.start_at and w.end_at >= v_start and w.end_at < v_end
  ),
  -- arrival to the first desk where a patient is seen (triage, consultation, dental)
  fe as (
    select w.encounter_id, min(w.end_at) as end_at from w
    where w.station in ('triage', 'consultation', 'dental', 'physio') and w.end_at is not null and w.end_at >= w.start_at
    group by w.encounter_id
  ),
  ar as (
    select extract(epoch from fe.end_at - e.arrived_at)::float8 / 60 as minutes,
           (fe.end_at - e.arrived_at > interval '12 hours'
            or (e.arrived_at at time zone 'Africa/Kigali')::date <> (fe.end_at at time zone 'Africa/Kigali')::date) as excluded
    from fe join encounter e on e.id = fe.encounter_id and e.deleted_at is null
    where fe.end_at >= v_start and fe.end_at < v_end and fe.end_at >= e.arrived_at
  ),
  per as (
    select d.station,
           count(*) filter (where not d.excluded) as n,
           round((percentile_cont(0.5) within group (order by d.minutes) filter (where not d.excluded))::numeric, 1) as median,
           round((percentile_cont(0.9) within group (order by d.minutes) filter (where not d.excluded))::numeric, 1) as p90,
           round((avg(d.minutes) filter (where not d.excluded))::numeric, 1) as mean,
           count(*) filter (where d.excluded) as excluded
    from d group by d.station
  ),
  dd as (
    select g::date as day from generate_series(v_from, v_to, interval '1 day') g where v_len <= 400
    union
    select d.day from d where not d.excluded
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_to, 'department', s.s_department,
    'rules', jsonb_build_object('minN', 5, 'maxHours', 12),
    'desks', coalesce((
      select jsonb_agg(jsonb_build_object(
          'station', st::text, 'n', coalesce(per.n, 0), 'median', per.median, 'p90', per.p90, 'mean', per.mean,
          'excluded', coalesce(per.excluded, 0), 'waitingNow', coalesce(l.waiting, 0), 'longestNow', l.longest,
          'forgotten', coalesce(l.forgotten, 0)) order by array_position(v_stations, st))
      from unnest(v_stations) st
      left join per on per.station = st
      left join queue_now(v_stations) l on l.station = st::text), '[]'::jsonb),
    'overall', (
      select jsonb_build_object(
        'n', count(*) filter (where not d.excluded),
        'median', round((percentile_cont(0.5) within group (order by d.minutes) filter (where not d.excluded))::numeric, 1),
        'p90', round((percentile_cont(0.9) within group (order by d.minutes) filter (where not d.excluded))::numeric, 1),
        'excluded', count(*) filter (where d.excluded))
      from d),
    'arrival', (
      select jsonb_build_object(
        'n', count(*) filter (where not ar.excluded),
        'median', round((percentile_cont(0.5) within group (order by ar.minutes) filter (where not ar.excluded))::numeric, 1),
        'p90', round((percentile_cont(0.9) within group (order by ar.minutes) filter (where not ar.excluded))::numeric, 1),
        'excluded', count(*) filter (where ar.excluded))
      from ar),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', dd.day, 'n', coalesce(x.n, 0), 'median', x.median) order by dd.day)
      from dd
      left join (select d.day, count(*) as n,
                        round((percentile_cont(0.5) within group (order by d.minutes))::numeric, 1) as median
                 from d where not d.excluded group by d.day) x on x.day = dd.day), '[]'::jsonb),
    -- tests: from the order to the verified result (turnaround, not waiting)
    'turnaround', coalesce((
      select jsonb_agg(jsonb_build_object('station', t.desk, 'n', t.n, 'median', t.median, 'p90', t.p90) order by t.desk)
      from (
        select request_desk(r.station, r.category) as desk, count(*) as n,
               round((percentile_cont(0.5) within group (order by extract(epoch from rep.verified_at - r.created_at)::float8 / 60))::numeric, 1) as median,
               round((percentile_cont(0.9) within group (order by extract(epoch from rep.verified_at - r.created_at)::float8 / 60))::numeric, 1) as p90
        from service_request r
        join diagnostic_report rep on rep.service_request_id = r.id and rep.deleted_at is null
        where r.deleted_at is null and rep.verified_at >= v_start and rep.verified_at < v_end and rep.verified_at >= r.created_at
          and (s.s_desks is null or request_desk(r.station, r.category) = any (s.s_desks))
        group by 1) t), '[]'::jsonb)
  ) into v_result;
  return v_result;
end
$$;

-- report_patients_seen: copied whole from 20270217090000_no_icd_words; 0205: physio.
create or replace function report_patients_seen(
  p_from date, p_to date, p_clinician uuid default null, p_department uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_mgr boolean := is_manager();
  v_heads uuid[] := report_head_departments();
  -- 0126: the diagnosis column for doctors
  v_doc boolean := is_doctor();
  v_sens boolean := has_perm('sensitive.read');
begin
  perform report_assert_clinical_reader();
  perform report_assert_period(p_from, p_to);
  return coalesce((
    with enc as (
      select e.id, e.patient_id, e.arrived_at, e.reference, e.status, e.clinical_done_at, e.left_reason,
             e.no_diagnosis_kind, e.no_diagnosis_note
      from encounter e
      where e.deleted_at is null and (e.arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to
    ), seen as (
      select q.encounter_id, q.taken_by as clinician_id, min(coalesce(q.started_at, q.created_at)) as seen_at,
             (array_agg(q.station::text order by q.created_at))[1] as station
      from queue_entry q join enc on enc.id = q.encounter_id
      where q.deleted_at is null and q.taken_by is not null
        and q.station in ('consultation', 'dental', 'physio', 'theatre', 'nursing', 'beds', 'ultrasound')
      group by 1, 2
      union all
      select c.encounter_id, c.created_by, min(c.created_at), null
      from condition c join enc on enc.id = c.encounter_id
      where c.deleted_at is null and c.created_by is not null
        and not exists (select 1 from queue_entry q
                        where q.encounter_id = c.encounter_id and q.deleted_at is null and q.taken_by = c.created_by
                          and q.station in ('consultation', 'dental', 'physio', 'theatre', 'nursing', 'beds', 'ultrasound'))
      group by 1, 2
    ), r as (
      select s.*, e.patient_id, e.arrived_at, e.reference, e.status, e.clinical_done_at, e.left_reason,
             e.no_diagnosis_kind, e.no_diagnosis_note,
             visit_departments(e.id) as depts
      from seen s join enc e on e.id = s.encounter_id
    )
    select jsonb_agg(jsonb_build_object(
        'encounterId', r.encounter_id, 'visitAt', r.arrived_at, 'seenAt', r.seen_at, 'reference', r.reference,
        'patientId', p.id, 'patient', p.surname || ' ' || p.given_names, 'fileNo', p.file_number, 'sex', p.sex,
        'age', case when p.birth_date is not null
                    then extract(year from age((r.arrived_at at time zone 'Africa/Kigali')::date, p.birth_date))::integer end,
        'clinicianId', r.clinician_id, 'clinician', pr.full_name, 'clinicianRole', pr.role, 'desk', r.station,
        'department', (select string_agg(d.name, ', ' order by d.name) from department d where d.id = any (r.depts)),
        -- 0197: the diagnoses in words only (was: each one's code before its words)
        'diagnosis', case when v_doc then coalesce((select string_agg(c.text, '; '
                                        order by (c.type = 'primary') desc, c.created_at)
                      from condition c where c.encounter_id = r.encounter_id and c.deleted_at is null and c.stage = 'definitive'
                        and (v_sens or coalesce(c.icd10_code, '') !~ '^B2[0-4]')),
                      no_diagnosis_marker(r.no_diagnosis_kind, r.no_diagnosis_note)) end,
        -- 0127: the chief complaint (step 1), for doctors
        'complaint', case when v_doc then visit_complaint(r.encounter_id) end,
        'prescriptions', (select count(*) from medication_request m
                          where m.encounter_id = r.encounter_id and m.deleted_at is null and m.cancelled_at is null
                            and coalesce(m.prescriber_id, m.created_by) = r.clinician_id)::integer,
        'tests', (select count(*) from service_request x
                  where x.encounter_id = r.encounter_id and x.deleted_at is null
                    and x.requester_id = r.clinician_id)::integer,
        'outcome', case
            when exists (select 1 from queue_entry q2
                         where q2.encounter_id = r.encounter_id and q2.deleted_at is null
                           and q2.referred_by = r.clinician_id and q2.taken_by is distinct from r.clinician_id
                           and q2.station in ('consultation', 'dental', 'physio', 'theatre', 'nursing', 'beds')) then 'referred'
            when r.status = 'open' and r.clinical_done_at is null then 'open'
            when r.left_reason is not null
                 or (r.clinical_done_at is null and r.no_diagnosis_kind is null
                     and not exists (select 1 from condition c where c.encounter_id = r.encounter_id
                                     and c.deleted_at is null and c.type = 'primary')) then 'left'
            else 'finished' end
      ) order by r.arrived_at desc, p.surname, pr.full_name)
    from r
    join patient p on p.id = r.patient_id
    join profiles pr on pr.id = r.clinician_id
    where (v_mgr or r.clinician_id = v_me or r.depts && v_heads)
      and (p_clinician is null or r.clinician_id = p_clinician)
      and (p_department is null or p_department = any (r.depts))
  ), '[]'::jsonb);
end
$$;

-- bed_board: copied whole from 20270216090000_beds_stay; 0205: physio.
create or replace function bed_board()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'state', b.status,
      'nightlyPrice', b.nightly_price,
      'encounterId', s.encounter_id,
      'patient', case when s.id is not null then p.surname || ' ' || p.given_names end,
      'since', case when s.id is not null
                    then coalesce((select min(x.admitted_at) from bed_stay x
                                   where x.encounter_id = s.encounter_id and x.deleted_at is null and x.by_day
                                     and exists (select 1 from bed_day d where d.stay_id = x.id)),
                                  s.admitted_at) end,
      'nights', s.planned_nights,
      'until', s.planned_until,
      'stayId', s.id,
      'patientId', p.id,
      'fileNumber', p.file_number,
      'byDay', s.by_day,
      'days', case when s.id is not null then (select count(*) from bed_day d where d.encounter_id = s.encounter_id) end,
      'expectedDays', s.expected_days,
      'reason', s.reason,
      'givenBy', (select full_name from profiles where id = s.given_by),
      'doctor', case when s.id is not null then coalesce(
                  (select pr.full_name from queue_entry q join profiles pr on pr.id = q.taken_by
                   where q.encounter_id = s.encounter_id and q.deleted_at is null
                     and q.station in ('consultation', 'dental', 'physio', 'theatre')
                   order by q.started_at desc nulls last limit 1),
                  (select full_name from profiles where id = s.given_by and is_doctor(id))) end,
      'amount', case when s.id is not null then
                  (select coalesce(sum(round(l.unit_price * l.quantity)), 0)
                   from invoice_line l join invoice i on i.id = l.invoice_id
                   where i.encounter_id = s.encounter_id and l.deleted_at is null and l.source_type = 'bed_stay') end,
      'owed', case when s.id is not null then
                (select invoice_balance(i.id) from invoice i where i.encounter_id = s.encounter_id limit 1) end
    ) order by b.sort_order, b.name), '[]'::jsonb)
  from bed b
  left join bed_stay s on s.bed_id = b.id and s.discharged_at is null and s.deleted_at is null
  left join encounter e on e.id = s.encounter_id
  left join patient p on p.id = e.patient_id
  where b.deleted_at is null
    and (has_perm('queue.read') or has_perm('billing.write') or has_perm('payment.take'))
$$;

-- save_category: copied whole from 20261101090000_category_desks; 0205: physio.
create or replace function save_category(
  p_id uuid,
  p_name_en text,
  p_name_kin text default null,
  p_name_fr text default null,
  p_kind category_kind default 'treatment',
  p_order_station station default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_old category_kind;
  v_old_station station;
  v_station station := p_order_station;
  v_kind category_kind;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name_en, ''))) < 2 then
    raise exception 'give the category a name' using errcode = '22023';
  end if;
  if exists (select 1 from service_category where lower(name_en) = lower(trim(p_name_en))
             and deleted_at is null and id is distinct from p_id) then
    raise exception 'a category with this name already exists' using errcode = '23505';
  end if;
  -- an older caller names the kind only
  if v_station is null and p_kind = 'lab' then v_station := 'laboratory'; end if;
  if v_station is null and p_kind = 'imaging' then v_station := 'ultrasound'; end if;
  if v_station is not null and v_station not in ('laboratory', 'ultrasound', 'nursing', 'dental', 'physio', 'theatre', 'consultation') then
    raise exception 'this desk cannot carry out orders' using errcode = '22023';
  end if;
  v_kind := case when p_kind = 'bed' then 'bed'::category_kind
                 when v_station = 'laboratory' then 'lab'::category_kind
                 when v_station = 'ultrasound' then 'imaging'::category_kind
                 else 'treatment'::category_kind end;
  if v_kind = 'bed' then v_station := null; end if;
  if v_id is null then
    if v_kind = 'bed' then
      raise exception 'bed stays have their own built-in category' using errcode = '22023';
    end if;
    insert into service_category (name_en, name_kin, name_fr, kind, order_station)
    values (trim(p_name_en), nullif(trim(coalesce(p_name_kin, '')), ''), nullif(trim(coalesce(p_name_fr, '')), ''),
            v_kind, v_station)
    returning id into v_id;
  else
    select kind, order_station into v_old, v_old_station from service_category where id = v_id and deleted_at is null;
    if not found then
      raise exception 'category not found' using errcode = 'P0002';
    end if;
    if (v_old = 'bed') <> (v_kind = 'bed') then
      raise exception 'the bed category keeps its kind' using errcode = '22023';
    end if;
    update service_category
    set name_en = trim(p_name_en), name_kin = nullif(trim(coalesce(p_name_kin, '')), ''),
        name_fr = nullif(trim(coalesce(p_name_fr, '')), ''), kind = v_kind, order_station = v_station
    where id = v_id;
    if v_old <> v_kind then
      update service set category_id = category_id where category_id = v_id;
    end if;
  end if;
  return v_id;
end
$$;


-- ---------------------------------------------------------------- the data
-- 'hiv' was a desk: no one keeps it, no department or calendar gives it any more
delete from role_desk where desk = 'hiv';
delete from staff_desk_keep where desk = 'hiv';
update department set services = array_remove(services, 'hiv') where 'hiv' = any (services);
update staff_department set services = array_remove(services, 'hiv') where 'hiv' = any (services);
update practitioner set categories = array_remove(categories, 'hiv') where 'hiv' = any (categories);
-- the roles that may use Dental may use Physiotherapy (the manager's own choices kept)
insert into role_desk (role, desk, set_by)
select r.role, 'physio', null from role_desk r where r.desk = 'dental'
on conflict do nothing;
-- the public booking categories: Physiotherapy in, HIV out (its services go to the laboratory or
-- to Nursing, where they are done)
update service set booking_category = case when service_group::text = 'lab' then 'laboratory' else 'nursing' end
where booking_category = 'hiv';
alter table service drop constraint if exists service_booking_category_check;
alter table service add constraint service_booking_category_check
  check (booking_category in ('consultation', 'dental', 'physio', 'laboratory', 'ultrasound', 'nursing', 'surgery',
                              'fp', 'circ'));
-- a department for the manager to place people in, when none gives Physiotherapy yet
insert into department (name, description, roles, services)
select 'Physiotherapy', 'Physiotherapy: assessment, exercises and rehabilitation sessions', '{doctor,nurse}', '{physio}'
where not exists (select 1 from department d where d.deleted_at is null
                  and ('physio' = any (d.services) or lower(d.name) ~ '(physio|kin[ée]si|fiziyo|fizyo)'));
