-- 0066 · The public site, sign-in and the catalogue (dashboard audit, wave 9).

-- ---------------------------------------------------------------- the public site's "clinic now"
-- The wait shown to the public is the wait for a first desk over the last two hours (one row per
-- visit, patients actually taken; not the cashier, the lab or the copies a doctor's take closes),
-- and "opens at" looks ahead to the next open day.
create or replace function public_clinic_status()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_local timestamp := now() at time zone 'Africa/Kigali';
  v_hours jsonb := coalesce((select value -> 'days' from setting where key = 'clinic.hours'), '{}'::jsonb);
  v_span jsonb := v_hours -> extract(dow from v_local)::int::text;
  v_waiting integer;
  v_avg numeric;
  v_open boolean := false;
  v_next_day date;
  v_next jsonb;
  i integer;
begin
  select count(distinct q.encounter_id) into v_waiting
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  where q.finished_at is null and q.deleted_at is null and e.status = 'open';
  select round(avg(w.minutes)) into v_avg
  from (
    select distinct on (q.encounter_id) extract(epoch from q.started_at - q.created_at) / 60 as minutes
    from queue_entry q
    where q.deleted_at is null and q.started_at is not null and q.started_at > now() - interval '2 hours'
      and q.station not in ('cashier', 'pharmacy', 'laboratory', 'ultrasound')
    order by q.encounter_id, q.created_at
  ) w;
  if v_span is not null and jsonb_array_length(v_span) = 2 then
    v_open := v_local::time >= (v_span ->> 0)::time and v_local::time < (v_span ->> 1)::time;
  end if;
  -- the next opening: today if not open yet, else the next day with hours
  if not v_open then
    for i in 0..7 loop
      v_next_day := v_local::date + i;
      v_next := v_hours -> extract(dow from v_next_day)::int::text;
      if v_next is not null and jsonb_array_length(v_next) = 2
         and (i > 0 or v_local::time < (v_next ->> 0)::time) then
        exit;
      end if;
      v_next := null;
    end loop;
  end if;
  return jsonb_build_object(
    'waiting', coalesce(v_waiting, 0),
    'avg_wait_min', coalesce(v_avg, 0),
    'open', v_open,
    'opens_at', case when v_open then v_span ->> 0 else v_next ->> 0 end,
    'opens_on', case when v_open or v_next is null then null else v_next_day end,
    'closes_at', case when v_open then v_span ->> 1 end,
    'as_of', now()
  );
end
$$;


-- ---------------------------------------------------------------- arrival: the booked doctor on a new visit only
-- A patient already in the clinic (with a doctor already) keeps that doctor; only a visit
-- started by the arrival is given to the booked doctor.
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
  -- the booked doctor's desk (a dentist books at Dental)
  v_desk := case when exists (select 1 from profiles where id = v_doctor and lower(coalesce(station, '')) like '%dent%')
                 then 'dental'::station else 'consultation'::station end;

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

  -- The visit belongs to the booking: the booked doctor has the patient, and the booking
  -- completes when the visit ends.
  update encounter
  set appointment_id = coalesce(appointment_id, v_appt.id),
      practitioner_id = coalesce(practitioner_id, v_appt.practitioner_id)
  where id = v_enc;

  -- already in the clinic but waiting nowhere: back in line (triage or the doctor's desk)
  if not exists (select 1 from queue_entry where encounter_id = v_enc and finished_at is null and deleted_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no)
    values (v_enc, case when triage_first() then 'triage'::station else v_desk end,
            (select ticket_no from queue_entry where encounter_id = v_enc order by created_at limit 1));
  end if;
  -- waiting at the doctor's desk, nobody has them yet: given to the booked doctor
  if v_doctor is not null then
    if not coalesce((v_visit ->> 'existing')::boolean, false) then
    update queue_entry set assigned_to = v_doctor
    where encounter_id = v_enc and finished_at is null and deleted_at is null and taken_by is null
      and assigned_to is null and station in ('consultation', 'dental');
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


-- ---------------------------------------------------------------- wrong PINs at the lock screen
-- A wrong PIN typed on a locked screen is kept (audit) like one at sign-in; the count of the last
-- 15 minutes (lock screen and sign-in together) comes back, and the tab signs out at 5.
create or replace function record_wrong_pin(p_where text default 'lock screen')
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, reason)
  values (auth.uid(), 'login', 'profiles', auth.uid(),
          'wrong PIN (' || left(coalesce(nullif(trim(p_where), ''), 'lock screen'), 40) || ')');
  select count(*)::integer into v_n from audit_event
  where actor_id = auth.uid() and action = 'login' and reason like 'wrong PIN%'
    and at > now() - interval '15 minutes';
  return v_n;
end
$$;
revoke all on function record_wrong_pin(text) from public, anon;
grant execute on function record_wrong_pin(text) to authenticated;


create or replace function create_appointment_inquiry(
  p_practitioner_code text,
  p_starts_at timestamptz,
  p_full_name text,
  p_phone text,
  p_insurer text default null,
  p_category text default null,
  p_note text default null,
  p_channel text default 'whatsapp',
  p_preferred_at timestamptz default null
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_practitioner practitioner%rowtype;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  v_ref text;
  v_year integer := extract(year from now())::integer;
  v_channel contact_channel;
begin
  if length(trim(coalesce(p_full_name, ''))) < 3 then
    raise exception 'full name is required' using errcode = '22023';
  end if;
  if v_phone !~ '^(\+?250|0)?7[0-9]{8}$' then
    raise exception 'phone must be a Rwandan mobile number (07xx xxx xxx)' using errcode = '22023';
  end if;
  v_channel := case p_channel when 'sms' then 'sms'::contact_channel when 'call' then 'none'::contact_channel else 'whatsapp'::contact_channel end;

  -- simple abuse limit: 5 inquiries per phone per day
  if (select count(*) from appointment where contact_phone = v_phone and created_at > now() - interval '1 day') >= 5 then
    raise exception 'too many requests for this phone today; please call reception' using errcode = '54000';
  end if;

  if p_practitioner_code is not null then
    select pr.* into v_practitioner from practitioner pr
    where pr.code = p_practitioner_code and pr.id in (select id from public_practitioners);
    if not found then
      raise exception 'unknown practitioner' using errcode = '22023';
    end if;
    if p_starts_at is null or p_starts_at < now() then
      raise exception 'the chosen time is in the past' using errcode = '22023';
    end if;
    if not practitioner_is_working(v_practitioner.id, p_starts_at) then
      raise exception 'the practitioner does not work at that time' using errcode = '22023';
    end if;
    if exists (select 1 from public_booked_slots b where b.practitioner_id = v_practitioner.id
               and b.starts_at < p_starts_at + make_interval(mins => coalesce(v_practitioner.slot_minutes, 60))
               and coalesce(b.ends_at, b.starts_at + interval '30 minutes') > p_starts_at) then
      raise exception 'that time has just been taken; please pick another' using errcode = '23505';
    end if;
  end if;

  v_ref := 'MMC-' || v_year || '-' || lpad(next_number('inquiry', v_year)::text, 4, '0');

  insert into appointment (
    practitioner_id, starts_at, ends_at, status, source, reason, hold_until,
    contact_name, contact_phone, contact_channel, insurer_text, category, reference, preferred_at
  ) values (
    v_practitioner.id,
    p_starts_at,
    case when p_starts_at is null then null else p_starts_at + make_interval(mins => coalesce(v_practitioner.slot_minutes, 60)) end,
    'inquiry', 'online', nullif(trim(coalesce(p_note, '')), ''), coalesce(p_starts_at, now() + interval '24 hours'),
    trim(p_full_name), v_phone, v_channel, nullif(trim(coalesce(p_insurer, '')), ''), p_category, v_ref,
    coalesce(p_starts_at, p_preferred_at)
  );
  return v_ref;
end
$$;

create or replace function approve_inquiry(
  p_appointment_id uuid,
  p_patient_id uuid,
  p_practitioner_user uuid default null,
  p_starts_at timestamptz default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_a appointment%rowtype;
  v_pr uuid;
  v_at timestamptz;
  v_hours jsonb;
  v_slot integer;
begin
  if not has_perm('appointment.approve') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_patient_id is null or not exists (select 1 from patient where id = p_patient_id and deleted_at is null) then
    raise exception 'choose the patient file' using errcode = '22023';
  end if;
  select * into v_a from appointment where id = p_appointment_id and status = 'inquiry' and deleted_at is null for update;
  if not found then
    raise exception 'inquiry not found or already handled' using errcode = 'P0002';
  end if;
  v_pr := case when p_practitioner_user is not null then ensure_practitioner(p_practitioner_user) else v_a.practitioner_id end;
  v_at := coalesce(p_starts_at, v_a.starts_at);
  if v_pr is null then
    raise exception 'choose the doctor' using errcode = '22023';
  end if;
  if v_at is null then
    raise exception 'choose the day and time' using errcode = '22023';
  end if;
  if v_at < now() then
    raise exception 'the chosen time is in the past' using errcode = '22023';
  end if;
  select working_hours, slot_minutes into v_hours, v_slot from practitioner where id = v_pr;
  if coalesce(v_hours, '{}'::jsonb) <> '{}'::jsonb and not practitioner_is_working(v_pr, v_at) then
    raise exception 'the doctor does not work at that time' using errcode = '22023';
  end if;
  if exists (select 1 from appointment b
             where b.practitioner_id = v_pr and b.id <> p_appointment_id and b.deleted_at is null
               and b.status in ('approved', 'confirmed', 'arrived', 'in_progress')
               and b.starts_at < v_at + make_interval(mins => coalesce(v_slot, 30))
               and coalesce(b.ends_at, b.starts_at + interval '30 minutes') > v_at) then
    raise exception 'the doctor already has a booking at that time' using errcode = '23505';
  end if;
  begin
    update appointment
    set status = 'approved', patient_id = p_patient_id, practitioner_id = v_pr, starts_at = v_at,
        ends_at = v_at + make_interval(mins => coalesce(v_slot, 30)),
        approved_by = auth.uid(), approved_at = now(), hold_until = null
    where id = p_appointment_id;
  exception when unique_violation then
    raise exception 'the doctor already has a booking at that time' using errcode = '23505';
  end;
end
$$;

create or replace function notify_appointment()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_doctor uuid;
  v_doctor_name text;
begin
  v_name := coalesce((select p.surname || ' ' || p.given_names from patient p where p.id = new.patient_id), new.contact_name);
  select user_id, names into v_doctor, v_doctor_name from practitioner where id = new.practitioner_id;
  if tg_op = 'INSERT' and new.status = 'inquiry' then
    insert into notification (kind, params, link, recipient_role, created_by)
    select 'inquiry', jsonb_build_object('name', v_name, 'when', coalesce(new.starts_at, new.preferred_at), 'appointment', new.id),
           '/app/appointments', r::role_key, auth.uid()
    from unnest(array['receptionist', 'manager']) r;
    return new;
  end if;
  -- The request was handled (booked, rejected, cancelled): its notice is no longer needed.
  if tg_op = 'UPDATE' and old.status = 'inquiry' and new.status <> 'inquiry' then
    delete from notification where kind = 'inquiry' and params ->> 'appointment' = new.id::text;
  end if;
  if tg_op = 'UPDATE' and new.status = 'approved' and old.status is distinct from 'approved' then
    if v_doctor is not null then
      insert into notification (kind, params, link, recipient_user, created_by)
      values ('to_accept', jsonb_build_object('name', v_name, 'when', new.starts_at, 'appointment', new.id), '/app', v_doctor, auth.uid());
    end if;
  elsif tg_op = 'UPDATE' and new.status in ('confirmed', 'declined') and old.status = 'approved' then
    -- The doctor answered: the "to accept" notice goes away.
    delete from notification where kind = 'to_accept' and params ->> 'appointment' = new.id::text;
    if new.status = 'confirmed' then
      insert into notification (kind, params, link, recipient_role, created_by)
      values ('appt_confirmed', jsonb_build_object('name', v_name, 'when', new.starts_at, 'doctor', v_doctor_name),
              '/app/appointments', 'receptionist', auth.uid());
    else
      insert into notification (kind, params, link, recipient_role, urgent, created_by)
      values ('appt_declined', jsonb_build_object('name', v_name, 'when', new.starts_at, 'doctor', v_doctor_name, 'reason', new.cancel_reason),
              '/app/appointments?day=' || to_char(new.starts_at at time zone 'Africa/Kigali', 'YYYY-MM-DD'),
              'receptionist', true, auth.uid());
    end if;
  end if;
  return new;
end
$$;

create or replace function move_category_to_department(p_category_id uuid, p_department_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_department_id is not null and not exists (select 1 from department where id = p_department_id and deleted_at is null) then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  update service set department_id = p_department_id where category_id = p_category_id and deleted_at is null;
  get diagnostics v_n = row_count;
  -- the treatments belong to that department only (or to none)
  delete from service_department
  where service_id in (select id from service where category_id = p_category_id and deleted_at is null)
    and (p_department_id is null or department_id <> p_department_id);
  if p_department_id is not null then
    insert into service_department (service_id, department_id)
    select id, p_department_id from service where category_id = p_category_id and deleted_at is null
    on conflict do nothing;
  end if;
  return v_n;
end
$$;

create or replace function move_group_to_department(p_group service_group, p_department_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_department_id is not null and not exists (select 1 from department where id = p_department_id and deleted_at is null) then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  update service set department_id = p_department_id where service_group = p_group and deleted_at is null;
  get diagnostics v_n = row_count;
  -- the treatments belong to that department only (or to none)
  delete from service_department
  where service_id in (select id from service where service_group = p_group and deleted_at is null)
    and (p_department_id is null or department_id <> p_department_id);
  if p_department_id is not null then
    insert into service_department (service_id, department_id)
    select id, p_department_id from service where service_group = p_group and deleted_at is null
    on conflict do nothing;
  end if;
  return v_n;
end
$$;
