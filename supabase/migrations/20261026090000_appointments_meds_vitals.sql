-- 0039 · Appointments that reach the doctor, medicines with prices, vitals taken once.
--
-- Appointments: a request from the website carries the time the person prefers. Reception
-- approves it with the patient's file, the doctor and the time (any doctor or sonographer can
-- be booked; a doctor's own working hours are respected when they set them). The doctor is
-- told and accepts or declines; reception is told of the answer.
--
-- Medicines: the manager keeps the medicines and supplies with their price, so they can be
-- put on the bill at any desk and when given in the room.
--
-- Vitals: once measured, every queue shows them as taken; triage sends the patient on
-- without measuring again unless something is corrected.

-- ---------------------------------------------------------------- inquiry with a preferred time
alter table appointment add column if not exists preferred_at timestamptz;

drop function if exists create_appointment_inquiry(text, timestamptz, text, text, text, text, text, text);
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
    select * into v_practitioner from practitioner where code = p_practitioner_code and active and deleted_at is null;
    if not found then
      raise exception 'unknown practitioner' using errcode = '22023';
    end if;
    if p_starts_at is null or p_starts_at < now() then
      raise exception 'the chosen time is in the past' using errcode = '22023';
    end if;
    if not practitioner_is_working(v_practitioner.id, p_starts_at) then
      raise exception 'the practitioner does not work at that time' using errcode = '22023';
    end if;
    if exists (select 1 from public_booked_slots b where b.practitioner_id = v_practitioner.id and b.starts_at = p_starts_at) then
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
    'inquiry', 'online', nullif(trim(coalesce(p_note, '')), ''), now() + interval '24 hours',
    trim(p_full_name), v_phone, v_channel, nullif(trim(coalesce(p_insurer, '')), ''), p_category, v_ref,
    coalesce(p_starts_at, p_preferred_at)
  );
  return v_ref;
end
$$;
grant execute on function create_appointment_inquiry(text, timestamptz, text, text, text, text, text, text, timestamptz) to anon, authenticated;

-- ---------------------------------------------------------------- doctors reception can book
-- A doctor's calendar row, created the first time they are booked (private, no hours yet).
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
  where id = p_user and active and role in ('doctor', 'sonographer');
  if v_name is null then
    raise exception 'only doctors and sonographers can be booked' using errcode = '22023';
  end if;
  insert into practitioner (code, user_id, names, slot_minutes, working_hours, calendar_visibility, active)
  values (lower(coalesce(v_staff, 'dr-' || left(p_user::text, 8))), p_user, v_name, 30, '{}'::jsonb, 'private', true)
  returning id into v_id;
  return v_id;
end
$$;

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
  where has_perm('appointment.read') and p.active and p.role in ('doctor', 'sonographer')
$$;

-- Requests waiting for reception, with the file that matches the phone (when exactly one does).
create or replace function inquiries_open()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'name', a.contact_name, 'phone', a.contact_phone, 'reference', a.reference,
    'category', a.category, 'channel', a.contact_channel, 'note', a.reason,
    'doctor', pr.names, 'doctorUserId', pr.user_id,
    'startsAt', a.starts_at, 'preferredAt', a.preferred_at, 'createdAt', a.created_at,
    'insurer', a.insurer_text,
    'patientId', m.id, 'patientFile', m.file_number,
    'patientName', case when m.id is null then null else m.surname || ' ' || m.given_names end,
    'matches', m.n
  ) order by a.created_at), '[]'::jsonb)
  from appointment a
  left join practitioner pr on pr.id = a.practitioner_id
  left join lateral (
    select count(*)::integer as n,
           (array_agg(p.id order by p.created_at))[1] as id,
           (array_agg(p.file_number order by p.created_at))[1] as file_number,
           (array_agg(p.surname order by p.created_at))[1] as surname,
           (array_agg(p.given_names order by p.created_at))[1] as given_names
    from patient p
    where p.deleted_at is null and p.merged_into is null
      and regexp_replace(coalesce(p.phone_1, ''), '[^0-9]', '', 'g') = regexp_replace(coalesce(a.contact_phone, ''), '[^0-9]', '', 'g')
  ) m on true
  where has_perm('appointment.read') and a.deleted_at is null and a.status = 'inquiry'
$$;

-- ---------------------------------------------------------------- approve with doctor and time
drop function if exists approve_inquiry(uuid, uuid);
drop function if exists approve_inquiry_auto(uuid, uuid);

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

create or replace function approve_inquiry_auto(
  p_appointment_id uuid,
  p_patient_id uuid default null,
  p_practitioner_user uuid default null,
  p_starts_at timestamptz default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_patient uuid := p_patient_id;
  v_phone text;
  v_matches integer;
begin
  if not has_perm('appointment.approve') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_patient is null then
    select contact_phone into v_phone from appointment where id = p_appointment_id and status = 'inquiry';
    if v_phone is null then
      raise exception 'inquiry not found or already handled' using errcode = 'P0002';
    end if;
    select count(*), (array_agg(id))[1] into v_matches, v_patient from patient
    where deleted_at is null and merged_into is null
      and regexp_replace(coalesce(phone_1, ''), '[^0-9]', '', 'g') = regexp_replace(v_phone, '[^0-9]', '', 'g');
    if v_matches <> 1 then
      raise exception 'register the patient first (no single file matches phone %)', v_phone using errcode = 'P0002';
    end if;
  end if;
  perform approve_inquiry(p_appointment_id, v_patient, p_practitioner_user, p_starts_at);
  return v_patient;
end
$$;

-- The doctor's answer reaches reception.
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
    values ('inquiry', jsonb_build_object('name', v_name, 'when', coalesce(new.starts_at, new.preferred_at)), '/app/appointments',
            'receptionist', auth.uid());
  elsif tg_op = 'UPDATE' and new.status = 'approved' and old.status is distinct from 'approved' then
    if v_doctor is not null then
      insert into notification (kind, params, link, recipient_user, created_by)
      values ('to_accept', jsonb_build_object('name', v_name, 'when', new.starts_at), '/app', v_doctor, auth.uid());
    end if;
  elsif tg_op = 'UPDATE' and new.status = 'confirmed' and old.status is distinct from 'confirmed' then
    insert into notification (kind, params, link, recipient_role, created_by)
    values ('appt_confirmed', jsonb_build_object('name', v_name, 'when', new.starts_at, 'doctor', v_doctor_name),
            '/app/appointments', 'receptionist', auth.uid());
  elsif tg_op = 'UPDATE' and new.status = 'declined' and old.status is distinct from 'declined' then
    insert into notification (kind, params, link, recipient_role, urgent, created_by)
    values ('appt_declined', jsonb_build_object('name', v_name, 'when', new.starts_at, 'doctor', v_doctor_name, 'reason', new.cancel_reason),
            '/app/appointments', 'receptionist', true, auth.uid());
  end if;
  return new;
end
$$;

revoke all on function ensure_practitioner(uuid), bookable_doctors(), inquiries_open(),
  approve_inquiry(uuid, uuid, uuid, timestamptz), approve_inquiry_auto(uuid, uuid, uuid, timestamptz) from public, anon;
grant execute on function ensure_practitioner(uuid), bookable_doctors(), inquiries_open(),
  approve_inquiry(uuid, uuid, uuid, timestamptz), approve_inquiry_auto(uuid, uuid, uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------- medicines and supplies with a price
create or replace function upsert_item(
  p_id uuid,
  p_name text,
  p_price numeric,
  p_strength text default null,
  p_form text default null,
  p_unit text default null,
  p_active boolean default true,
  p_code text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_list uuid;
  v_code text := nullif(upper(trim(coalesce(p_code, ''))), '');
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'the medicine needs a name' using errcode = '22023';
  end if;
  if p_price is null or p_price < 0 then
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  if v_id is null then
    if v_code is null then
      v_code := 'MED-' || lpad(next_number('item_code', 0)::text, 4, '0');
    end if;
    insert into item (code, name_generic, strength, form, unit, selling_unit, active)
    values (v_code, trim(p_name), nullif(trim(coalesce(p_strength, '')), ''), nullif(trim(coalesce(p_form, '')), ''),
            nullif(trim(coalesce(p_unit, '')), ''), nullif(trim(coalesce(p_unit, '')), ''), p_active)
    returning id into v_id;
  else
    update item
    set name_generic = trim(p_name), strength = nullif(trim(coalesce(p_strength, '')), ''),
        form = nullif(trim(coalesce(p_form, '')), ''), unit = nullif(trim(coalesce(p_unit, '')), ''),
        selling_unit = nullif(trim(coalesce(p_unit, '')), ''), active = p_active, code = coalesce(v_code, code)
    where id = v_id and deleted_at is null;
    if not found then
      raise exception 'medicine not found' using errcode = 'P0002';
    end if;
  end if;
  select id into v_list from price_list
  where payer_id is null and deleted_at is null and effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
  order by effective_from desc limit 1;
  if v_list is null then
    insert into price_list (payer_id, name, effective_from) values (null, 'Cash prices', current_date) returning id into v_list;
  end if;
  insert into price_list_item (price_list_id, item_id, price) values (v_list, v_id, round(p_price))
  on conflict (price_list_id, item_id) where item_id is not null
  do update set price = excluded.price, deleted_at = null;
  return v_id;
end
$$;

create or replace function delete_item(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update item set deleted_at = now(), active = false where id = p_id and deleted_at is null;
  if not found then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
end
$$;

revoke all on function upsert_item(uuid, text, numeric, text, text, text, boolean, text), delete_item(uuid) from public, anon;
grant execute on function upsert_item(uuid, text, numeric, text, text, text, boolean, text), delete_item(uuid) to authenticated;

-- ---------------------------------------------------------------- vitals taken once
create or replace view queue_board with (security_invoker = true) as
  select q.id as queue_id, q.encounter_id, q.station, q.ticket_no, q.priority,
         q.created_at as queued_at, q.called_at, q.started_at, q.finished_at,
         e.patient_id, e.triage_level, e.arrived_at, e.type as encounter_type,
         p.file_number, p.surname, p.given_names, p.sex, p.birth_date, p.phone_1,
         q.pool_id, tb.full_name as taken_by_name,
         q.assigned_to, asg.full_name as assigned_name, rb.full_name as referred_by_name,
         q.referral_note, q.return_station,
         v.effective_at as vitals_at, v.measured_by as vitals_by
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  join patient p on p.id = e.patient_id
  left join profiles tb on tb.id = q.taken_by
  left join profiles asg on asg.id = q.assigned_to
  left join profiles rb on rb.id = q.referred_by
  left join lateral (
    select o.effective_at, pm.full_name as measured_by
    from observation o
    left join profiles pm on pm.id = o.performer_id
    where o.encounter_id = q.encounter_id and o.deleted_at is null
      and o.code in ('bp_sys', 'bp_dia', 'pulse', 'temp', 'resp', 'spo2', 'weight', 'height', 'muac')
    order by o.effective_at desc limit 1
  ) v on true
  where q.deleted_at is null and e.status = 'open';

-- Triage with the vitals already taken: colour and next station only, nothing measured again.
create or replace function send_from_triage(
  p_encounter_id uuid,
  p_triage triage_level,
  p_next_station station,
  p_reason text default null
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
begin
  if not (has_perm('clinical.write') or has_perm('vitals.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if not exists (select 1 from observation where encounter_id = p_encounter_id and deleted_at is null) then
    raise exception 'take the vitals first' using errcode = '22023';
  end if;
  update encounter set triage_level = p_triage, triage_reason = coalesce(nullif(trim(coalesce(p_reason, '')), ''), triage_reason)
  where id = p_encounter_id;
  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = 'triage' and finished_at is null and deleted_at is null;
  if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = p_next_station
                 and finished_at is null and deleted_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, p_next_station, v_ticket,
            case p_triage when 'red' then 1 when 'yellow' then 2 else 3 end);
  end if;
  return v_ticket;
end
$$;
revoke all on function send_from_triage(uuid, triage_level, station, text) from public, anon;
grant execute on function send_from_triage(uuid, triage_level, station, text) to authenticated;
