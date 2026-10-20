-- 0035 — Lab results in the file, medicines given in the room, a nurse covering for a doctor.
--
-- Results: the lab (or ultrasound) records findings and the conclusion for each test ordered; the
-- doctor who ordered it is told, and every result is listed in the patient file.
-- Medicines: each prescribed medicine is either collected at the pharmacy (the patient is queued
-- there) or given in the room by the prescriber (recorded as given, charged to the bill, no
-- pharmacy queue).
-- Cover: a doctor (or the manager) asks a nurse to cover for a period; during it the nurse has the
-- doctor's rights, receives the patients sent to that doctor, and sees the doctor's queue.

-- ---------------------------------------------------------------- results
create or replace function record_result(
  p_request_id uuid,
  p_findings text,
  p_impression text,
  p_verify boolean default true
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req service_request%rowtype;
  v_test text;
  v_name text;
begin
  if not has_perm('orders.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_req from service_request where id = p_request_id and deleted_at is null;
  if not found then
    raise exception 'test order not found' using errcode = 'P0002';
  end if;
  if nullif(trim(coalesce(p_findings, '')), '') is null and nullif(trim(coalesce(p_impression, '')), '') is null then
    raise exception 'write the findings or the conclusion' using errcode = '22023';
  end if;
  insert into diagnostic_report (service_request_id, findings, impression, verified_by, verified_at)
  values (p_request_id, nullif(trim(coalesce(p_findings, '')), ''), nullif(trim(coalesce(p_impression, '')), ''),
          case when p_verify then auth.uid() end, case when p_verify then now() end)
  on conflict (service_request_id) do update
  set findings = excluded.findings, impression = excluded.impression,
      verified_by = excluded.verified_by, verified_at = excluded.verified_at, updated_at = now();
  update service_request set status = case when p_verify then 'verified'::request_status else 'resulted'::request_status end
  where id = p_request_id;
  -- Tell the doctor who ordered it.
  if v_req.requester_id is not null and v_req.requester_id is distinct from auth.uid() then
    select s.name_en into v_test from service s where s.id = v_req.service_id;
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_req.encounter_id;
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('result',
            jsonb_build_object('test', v_test, 'name', v_name,
                               'impression', nullif(trim(coalesce(p_impression, '')), ''),
                               'verified', p_verify),
            '/app/visit?encounter=' || v_req.encounter_id,
            v_req.requester_id, auth.uid());
  end if;
end
$$;

-- Every test result of a patient, newest first (patient file).
create or replace function patient_results(p_patient_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'encounterId', r.encounter_id, 'test', s.name_en, 'category', r.category,
      'status', r.status, 'reason', r.reason, 'orderedAt', r.created_at,
      'orderedBy', (select full_name from profiles where id = r.requester_id),
      'findings', d.findings, 'impression', d.impression,
      'verified', d.verified_at is not null, 'resultAt', coalesce(d.verified_at, d.updated_at),
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by))
    ) order by r.created_at desc), '[]'::jsonb)
  from service_request r
  join encounter e on e.id = r.encounter_id
  join service s on s.id = r.service_id
  left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
  where e.patient_id = p_patient_id and r.deleted_at is null
    and (has_perm('clinical.read') or has_perm('orders.read'))
$$;

-- ---------------------------------------------------------------- medicines: pharmacy or the room
alter table medication_request add column if not exists supply text not null default 'pharmacy'
  check (supply in ('pharmacy', 'room'));
alter table medication_request add column if not exists given_at timestamptz;
alter table medication_request add column if not exists given_by uuid references profiles (id) on delete set null;

drop function if exists prescribe(uuid, uuid, numeric, text, text, text, integer, text);
create or replace function prescribe(
  p_encounter_id uuid, p_item_id uuid, p_quantity numeric, p_dose text default null, p_route text default null,
  p_frequency text default null, p_duration_days integer default null, p_instructions text default null,
  p_supply text default 'pharmacy', p_station station default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_charged boolean := false;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if coalesce(p_supply, 'pharmacy') not in ('pharmacy', 'room') then
    raise exception 'unknown supply' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into medication_request (encounter_id, item_id, dose, route, frequency, duration_days, quantity,
                                  instructions, supply, given_at, given_by)
  values (p_encounter_id, p_item_id, nullif(trim(coalesce(p_dose, '')), ''), nullif(trim(coalesce(p_route, '')), ''),
          nullif(trim(coalesce(p_frequency, '')), ''), p_duration_days, p_quantity,
          nullif(trim(coalesce(p_instructions, '')), ''), coalesce(p_supply, 'pharmacy'),
          case when p_supply = 'room' then now() end, case when p_supply = 'room' then auth.uid() end)
  returning id into v_id;
  if p_supply = 'room' then
    -- Given here: on the bill at the medicine's price (if it has one); no pharmacy queue.
    begin
      perform add_charge(p_encounter_id, coalesce(p_station, 'consultation'::station), null, p_item_id, p_quantity,
                         null, null, null, null, 'medication_request', v_id);
      v_charged := true;
    exception when sqlstate 'P0002' then
      v_charged := false;
    end;
  elsif not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'pharmacy' and finished_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no)
    values (p_encounter_id, 'pharmacy', (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1));
  end if;
  return jsonb_build_object('id', v_id, 'supply', coalesce(p_supply, 'pharmacy'), 'charged', v_charged);
end
$$;

-- ---------------------------------------------------------------- a nurse covering for a doctor
create table if not exists clinician_cover (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references profiles (id) on delete cascade,
  nurse_id uuid not null references profiles (id) on delete cascade,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  check (ends_at > starts_at),
  check (doctor_id <> nurse_id)
);
alter table clinician_cover enable row level security;
drop policy if exists clinician_cover_read on clinician_cover;
create policy clinician_cover_read on clinician_cover for select to authenticated
  using (doctor_id = auth.uid() or nurse_id = auth.uid() or is_manager());

-- The doctor someone is covering for right now (null when not covering).
create or replace function covering_for(p_user uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select c.doctor_id from clinician_cover c
  where c.nurse_id = p_user and c.ended_at is null and now() >= c.starts_at and now() < c.ends_at
  order by c.starts_at desc limit 1
$$;

-- Rights: the person's own role, plus the doctor's while covering (never the sensitive ones).
create or replace function has_perm(p_permission text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from profiles p
    join role_permissions rp on rp.role = p.role
    where p.id = auth.uid() and p.active and rp.permission = p_permission
  ) or (
    p_permission not like 'sensitive.%' and exists (
      select 1
      from clinician_cover c
      join profiles d on d.id = c.doctor_id
      join role_permissions rp on rp.role = d.role
      join profiles me on me.id = c.nurse_id and me.active
      where c.nurse_id = auth.uid() and c.ended_at is null
        and now() >= c.starts_at and now() < c.ends_at
        and rp.permission = p_permission
    )
  )
$$;

create or replace function start_cover(
  p_nurse uuid,
  p_until timestamptz,
  p_note text default null,
  p_doctor uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_doctor uuid := coalesce(p_doctor, auth.uid());
  v_id uuid;
  v_doctor_name text;
begin
  if v_doctor <> auth.uid() and not is_manager() then
    raise exception 'only the doctor or the manager can arrange cover' using errcode = '42501';
  end if;
  if not exists (select 1 from profiles where id = v_doctor and active and role = 'doctor') then
    raise exception 'cover is arranged for a doctor' using errcode = '22023';
  end if;
  if not exists (select 1 from profiles where id = p_nurse and active and role in ('nurse', 'doctor')) then
    raise exception 'choose an active nurse (or doctor) to cover' using errcode = '22023';
  end if;
  if p_until is null or p_until <= now() or p_until > now() + interval '14 days' then
    raise exception 'the cover must end later today or within 14 days' using errcode = '22023';
  end if;
  -- One cover at a time for a doctor: a new one replaces the current one.
  update clinician_cover set ended_at = now()
  where doctor_id = v_doctor and ended_at is null and ends_at > now();
  insert into clinician_cover (doctor_id, nurse_id, ends_at, note)
  values (v_doctor, p_nurse, p_until, nullif(trim(coalesce(p_note, '')), ''))
  returning id into v_id;
  select full_name into v_doctor_name from profiles where id = v_doctor;
  -- Patients already waiting for that doctor go to the nurse.
  update queue_entry
  set assigned_to = p_nurse,
      referral_note = coalesce(referral_note || ' · ', '') || 'covering for ' || v_doctor_name
  where assigned_to = v_doctor and finished_at is null and deleted_at is null;
  insert into notification (kind, params, link, urgent, recipient_user, created_by)
  values ('cover',
          jsonb_build_object('doctor', v_doctor_name, 'until', p_until,
                             'note', nullif(trim(coalesce(p_note, '')), '')),
          '/app', true, p_nurse, auth.uid());
  return v_id;
end
$$;

create or replace function end_cover(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update clinician_cover set ended_at = now()
  where id = p_id and ended_at is null
    and (doctor_id = auth.uid() or nurse_id = auth.uid() or is_manager());
  if not found then
    raise exception 'cover not found or not yours' using errcode = 'P0002';
  end if;
end
$$;

-- For the dashboards: whom I cover now, and who covers for me.
create or replace function my_cover()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'covering', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'doctorId', c.doctor_id, 'doctor', d.full_name,
               'station', d.station, 'until', c.ends_at, 'note', c.note) order by c.starts_at)
      from clinician_cover c join profiles d on d.id = c.doctor_id
      where c.nurse_id = auth.uid() and c.ended_at is null and now() >= c.starts_at and now() < c.ends_at
    ), '[]'::jsonb),
    'coveredBy', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'nurseId', c.nurse_id, 'nurse', n.full_name,
               'until', c.ends_at, 'note', c.note) order by c.starts_at)
      from clinician_cover c join profiles n on n.id = c.nurse_id
      where c.doctor_id = auth.uid() and c.ended_at is null and now() >= c.starts_at and now() < c.ends_at
    ), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------- patched: room medicines and result details
create or replace function visit_clinical(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case when has_perm('clinical.read') then jsonb_build_object(
    'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by)) order by c.created_at)
      from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.value_text, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id)) order by o.effective_at)
      from observation o where o.encounter_id = p_encounter_id and o.code = 'note' and o.deleted_at is null), '[]'::jsonb),
    'prescriptions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'item', i.name_generic || coalesce(' ' || i.strength, ''), 'dose', m.dose, 'route', m.route,
        'frequency', m.frequency, 'days', m.duration_days, 'quantity', m.quantity, 'instructions', m.instructions, 'at', m.created_at,
        'dispensed', m.supply = 'room' or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'supply', m.supply, 'givenAt', m.given_at, 'givenBy', (select full_name from profiles where id = m.given_by)) order by m.created_at)
      from medication_request m join item i on i.id = m.item_id where m.encounter_id = p_encounter_id and m.deleted_at is null), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'status', r.status, 'reason', r.reason, 'at', r.created_at,
        'result', (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
          'at', coalesce(d.verified_at, d.updated_at), 'by', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)))
          from diagnostic_report d where d.service_request_id = r.id and d.deleted_at is null)) order by r.created_at)
      from service_request r join service s on s.id = r.service_id where r.encounter_id = p_encounter_id and r.deleted_at is null), '[]'::jsonb),
    'patient', (select jsonb_build_object('id', p.id, 'allergies', p.allergies, 'bloodGroup', p.blood_group, 'notes', p.notes, 'flags', p.flags)
      from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id)
  ) else null end
$$;

-- ---------------------------------------------------------------- patched: referrals reach the covering nurse
create or replace function refer_patient(
  p_encounter_id uuid,
  p_from station,
  p_to station,
  p_to_user uuid default null,
  p_note text default null,
  p_return boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_id uuid;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  -- A doctor who is covered by a nurse right now: the patient goes to the nurse.
  if p_to_user is not null then
    p_to_user := coalesce((select c.nurse_id from clinician_cover c
                           where c.doctor_id = p_to_user and c.ended_at is null
                             and now() >= c.starts_at and now() < c.ends_at
                           order by c.starts_at desc limit 1), p_to_user);
  end if;
  if p_to_user is not null and not exists (select 1 from profiles where id = p_to_user and active) then
    raise exception 'that colleague is not an active employee' using errcode = '22023';
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = p_from and finished_at is null;
  -- Already waiting at that desk: update the waiting entry instead of adding a second one.
  update queue_entry
  set assigned_to = p_to_user, referred_by = auth.uid(),
      referral_note = nullif(trim(coalesce(p_note, '')), ''),
      return_station = case when p_return then p_from end,
      return_to = case when p_return then auth.uid() end
  where encounter_id = p_encounter_id and station = p_to and finished_at is null and deleted_at is null
  returning id into v_id;
  if v_id is null then
    select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
    insert into queue_entry (encounter_id, station, ticket_no, assigned_to, referred_by, referral_note,
                             return_station, return_to)
    values (p_encounter_id, p_to, coalesce(v_ticket, 'A-000'), p_to_user, auth.uid(),
            nullif(trim(coalesce(p_note, '')), ''),
            case when p_return then p_from end,
            case when p_return then auth.uid() end)
    returning id into v_id;
  end if;
  return jsonb_build_object('queueId', v_id, 'station', p_to);
end
$$;

grant execute on function record_result(uuid, text, text, boolean), patient_results(uuid),
  prescribe(uuid, uuid, numeric, text, text, text, integer, text, text, station),
  start_cover(uuid, timestamptz, text, uuid), end_cover(uuid), my_cover(), covering_for(uuid)
  to authenticated;
revoke execute on function record_result(uuid, text, text, boolean), patient_results(uuid),
  prescribe(uuid, uuid, numeric, text, text, text, integer, text, text, station),
  start_cover(uuid, timestamptz, text, uuid), end_cover(uuid), my_cover(), covering_for(uuid)
  from anon, public;
