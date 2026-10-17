-- Muhazi Medical Clinic System — 0016 patient register, patient file, clinical record of a visit
-- Every registered patient is kept in `patient` for good; this adds what the screens need:
-- the register (list + search), the patient file (demographics, allergies, visits, vitals,
-- diagnoses, bills) and the clinical actions a clinician takes on a visit (diagnosis, note,
-- prescription, lab / imaging order, close).

alter table patient add column if not exists allergies text;
comment on column patient.allergies is 'Free text, shown on every visit screen in red when present.';

-- ---------------------------------------------------------------- register
create or replace function patients_list(p_query text default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with q as (select nullif(trim(coalesce(p_query, '')), '') as text),
  base as (
    select p.*,
           (select max(e.arrived_at) from encounter e where e.patient_id = p.id and e.deleted_at is null) as last_visit_at,
           (select count(*) from encounter e where e.patient_id = p.id and e.deleted_at is null) as visits,
           (select e.id from encounter e where e.patient_id = p.id and e.status = 'open' and e.deleted_at is null order by e.arrived_at desc limit 1) as open_encounter_id,
           (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id where e.patient_id = p.id and i.deleted_at is null and i.status <> 'credited') as balance_due
    from patient p, q
    where has_perm('patient.read') and p.deleted_at is null and p.merged_into is null
      and (q.text is null
        or upper(p.file_number) = upper(q.text)
        or p.national_id = q.text
        or (length(regexp_replace(q.text, '[^0-9]', '', 'g')) >= 4 and regexp_replace(coalesce(p.phone_1, ''), '[^0-9]', '', 'g') like '%' || regexp_replace(q.text, '[^0-9]', '', 'g') || '%')
        or (p.surname || ' ' || p.given_names) ilike '%' || q.text || '%'
        or (p.given_names || ' ' || p.surname) ilike '%' || q.text || '%')
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', b.id, 'fileNumber', b.file_number, 'surname', b.surname, 'givenNames', b.given_names,
        'sex', b.sex, 'birthDate', b.birth_date, 'phone', b.phone_1, 'sector', b.sector,
        'registeredAt', b.created_at, 'lastVisitAt', b.last_visit_at, 'visits', b.visits,
        'openEncounterId', b.open_encounter_id, 'balanceDue', b.balance_due, 'flags', b.flags,
        'hasAllergies', (b.allergies is not null)
      ) order by coalesce(b.last_visit_at, b.created_at) desc)
      from (select * from base order by coalesce(last_visit_at, created_at) desc limit greatest(1, least(p_limit, 200)) offset greatest(0, p_offset)) b), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------- the patient file
create or replace function patient_file(p_patient_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_patient jsonb;
  v_visits jsonb;
  v_vitals jsonb;
  v_conditions jsonb;
  v_bills jsonb;
begin
  if not has_perm('patient.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select to_jsonb(p) - 'photo_blob_id' - 'merged_into' - 'guardian_patient_id' into v_patient
  from patient p where p.id = p_patient_id and p.deleted_at is null;
  if v_patient is null then
    raise exception 'patient not found' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'arrivedAt', e.arrived_at, 'status', e.status, 'type', e.type,
      'triage', e.triage_level, 'triageReason', e.triage_reason,
      'practitioner', (select names from practitioner where id = e.practitioner_id),
      'stations', (select coalesce(jsonb_agg(distinct q.station::text), '[]'::jsonb) from queue_entry q where q.encounter_id = e.id and q.deleted_at is null),
      'currentStation', (select q.station from queue_entry q where q.encounter_id = e.id and q.finished_at is null and q.deleted_at is null order by q.created_at desc limit 1),
      'diagnosis', (select c.text from condition c where c.encounter_id = e.id and c.type = 'primary' and c.deleted_at is null order by c.created_at desc limit 1),
      'total', (select i.total from invoice i where i.encounter_id = e.id),
      'balance', (select invoice_balance(i.id) from invoice i where i.encounter_id = e.id),
      'billStatus', (select i.status from invoice i where i.encounter_id = e.id),
      'closedAt', e.closed_at
    ) order by e.arrived_at desc), '[]'::jsonb) into v_visits
  from encounter e where e.patient_id = p_patient_id and e.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'encounterId', o.encounter_id, 'code', o.code, 'value', o.value_num, 'text', o.value_text,
      'unit', o.unit, 'at', o.effective_at, 'by', (select full_name from profiles where id = o.performer_id)
    ) order by o.effective_at desc), '[]'::jsonb) into v_vitals
  from observation o join encounter e on e.id = o.encounter_id
  where e.patient_id = p_patient_id and o.deleted_at is null and o.code <> 'note';

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'encounterId', c.encounter_id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type,
      'provisional', c.provisional, 'at', c.created_at, 'by', (select full_name from profiles where id = c.created_by)
    ) order by c.created_at desc), '[]'::jsonb) into v_conditions
  from condition c join encounter e on e.id = c.encounter_id
  where e.patient_id = p_patient_id and c.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'invoiceId', i.id, 'encounterId', i.encounter_id, 'number', i.number, 'status', i.status,
      'total', i.total, 'patientShare', i.patient_share, 'insurerShare', i.insurer_share,
      'balance', invoice_balance(i.id), 'payer', (select name from payer where id = i.payer_id),
      'at', i.created_at
    ) order by i.created_at desc), '[]'::jsonb) into v_bills
  from invoice i join encounter e on e.id = i.encounter_id
  where e.patient_id = p_patient_id and i.deleted_at is null;

  return jsonb_build_object('patient', v_patient, 'visits', v_visits, 'vitals', v_vitals,
                            'conditions', v_conditions, 'bills', v_bills);
end
$$;

-- Edit demographics and the file's standing notes. Only known columns are accepted.
create or replace function update_patient(p_patient_id uuid, p_fields jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_birth date := nullif(p_fields ->> 'birth_date', '')::date;
  v_age integer := nullif(p_fields ->> 'age_years', '')::integer;
begin
  if not has_perm('patient.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_birth is null and v_age is not null then
    v_birth := (current_date - make_interval(years => v_age))::date;
  end if;
  update patient set
    surname = coalesce(nullif(trim(p_fields ->> 'surname'), ''), surname),
    given_names = coalesce(nullif(trim(p_fields ->> 'given_names'), ''), given_names),
    sex = coalesce((p_fields ->> 'sex')::sex, sex),
    birth_date = coalesce(v_birth, birth_date),
    age_estimated = case when v_birth is not null then (v_age is not null and (p_fields ->> 'birth_date') is null) else age_estimated end,
    national_id = case when p_fields ? 'national_id' then nullif(regexp_replace(coalesce(p_fields ->> 'national_id', ''), '[^0-9]', '', 'g'), '') else national_id end,
    phone_1 = case when p_fields ? 'phone_1' then nullif(trim(p_fields ->> 'phone_1'), '') else phone_1 end,
    phone_2 = case when p_fields ? 'phone_2' then nullif(trim(p_fields ->> 'phone_2'), '') else phone_2 end,
    district = case when p_fields ? 'district' then nullif(trim(p_fields ->> 'district'), '') else district end,
    sector = case when p_fields ? 'sector' then nullif(trim(p_fields ->> 'sector'), '') else sector end,
    cell = case when p_fields ? 'cell' then nullif(trim(p_fields ->> 'cell'), '') else cell end,
    village = case when p_fields ? 'village' then nullif(trim(p_fields ->> 'village'), '') else village end,
    occupation = case when p_fields ? 'occupation' then nullif(trim(p_fields ->> 'occupation'), '') else occupation end,
    emergency_name = case when p_fields ? 'emergency_name' then nullif(trim(p_fields ->> 'emergency_name'), '') else emergency_name end,
    emergency_phone = case when p_fields ? 'emergency_phone' then nullif(trim(p_fields ->> 'emergency_phone'), '') else emergency_phone end,
    blood_group = case when p_fields ? 'blood_group' then nullif(trim(p_fields ->> 'blood_group'), '') else blood_group end,
    allergies = case when p_fields ? 'allergies' then nullif(trim(p_fields ->> 'allergies'), '') else allergies end,
    notes = case when p_fields ? 'notes' then nullif(trim(p_fields ->> 'notes'), '') else notes end,
    ubudehe_category = case when p_fields ? 'ubudehe_category' then nullif(p_fields ->> 'ubudehe_category', '')::smallint else ubudehe_category end,
    language = coalesce((p_fields ->> 'language')::lang, language),
    preferred_channel = coalesce((p_fields ->> 'preferred_channel')::contact_channel, preferred_channel)
  where id = p_patient_id and deleted_at is null;
  if not found then
    raise exception 'patient not found' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------- clinical record of a visit
create or replace function add_diagnosis(p_encounter_id uuid, p_text text, p_icd10 text default null, p_type condition_type default 'primary', p_provisional boolean default false)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_text, ''))) < 2 then
    raise exception 'the diagnosis needs a description' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into condition (encounter_id, text, icd10_code, type, provisional)
  values (p_encounter_id, trim(p_text), nullif(upper(trim(coalesce(p_icd10, ''))), ''), p_type, p_provisional)
  returning id into v_id;
  return v_id;
end
$$;

-- Free-text clinical note (complaint, examination, plan) stored as an observation.
create or replace function add_clinical_note(p_encounter_id uuid, p_text text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_text, ''))) < 2 then
    raise exception 'the note is empty' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into observation (encounter_id, code, value_text) values (p_encounter_id, 'note', trim(p_text))
  returning id into v_id;
  return v_id;
end
$$;

create or replace function prescribe(
  p_encounter_id uuid, p_item_id uuid, p_quantity numeric, p_dose text default null, p_route text default null,
  p_frequency text default null, p_duration_days integer default null, p_instructions text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into medication_request (encounter_id, item_id, dose, route, frequency, duration_days, quantity, instructions)
  values (p_encounter_id, p_item_id, nullif(trim(coalesce(p_dose, '')), ''), nullif(trim(coalesce(p_route, '')), ''),
          nullif(trim(coalesce(p_frequency, '')), ''), p_duration_days, p_quantity, nullif(trim(coalesce(p_instructions, '')), ''))
  returning id into v_id;
  -- the patient is expected at the pharmacy
  if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'pharmacy' and finished_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no)
    values (p_encounter_id, 'pharmacy', (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1));
  end if;
  return v_id;
end
$$;

-- Lab or imaging order; the charge is added at once (preset price) and the patient is queued there.
create or replace function order_test(p_encounter_id uuid, p_service_id uuid, p_reason text default null, p_priority integer default 3)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_group service_group;
  v_cat request_category;
  v_station station;
begin
  if not has_perm('orders.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select service_group into v_group from service where id = p_service_id and active and deleted_at is null;
  if v_group is null then
    raise exception 'unknown service' using errcode = '22023';
  end if;
  v_cat := case when v_group = 'imaging' then 'imaging'::request_category else 'lab'::request_category end;
  v_station := case when v_group = 'imaging' then 'ultrasound'::station else 'laboratory'::station end;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into service_request (encounter_id, category, service_id, reason, priority)
  values (p_encounter_id, v_cat, p_service_id, nullif(trim(coalesce(p_reason, '')), ''), least(5, greatest(1, p_priority)))
  returning id into v_id;
  perform add_charge(p_encounter_id, v_station, p_service_id, null, 1, null, null, null, null, 'service_request', v_id);
  if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = v_station and finished_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, v_station, (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1), least(5, greatest(1, p_priority)));
  end if;
  return v_id;
end
$$;

-- Close the visit (primary diagnosis required by close_encounter) and send the patient to the cashier.
create or replace function finish_visit(p_encounter_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform close_encounter(p_encounter_id);
  if exists (select 1 from invoice i where i.encounter_id = p_encounter_id and invoice_balance(i.id) > 0) then
    update encounter set status = 'open', closed_at = null, closed_by = null where id = p_encounter_id;
    update queue_entry set finished_at = now() where encounter_id = p_encounter_id and station <> 'cashier' and finished_at is null;
    if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'cashier' and finished_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no)
      values (p_encounter_id, 'cashier', (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1));
    end if;
  end if;
end
$$;

-- What a clinician sees on the visit: diagnoses, notes, prescriptions, orders.
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
        'dispensed', exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null)) order by m.created_at)
      from medication_request m join item i on i.id = m.item_id where m.encounter_id = p_encounter_id and m.deleted_at is null), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'status', r.status, 'reason', r.reason, 'at', r.created_at,
        'result', (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null) from diagnostic_report d where d.service_request_id = r.id)) order by r.created_at)
      from service_request r join service s on s.id = r.service_id where r.encounter_id = p_encounter_id and r.deleted_at is null), '[]'::jsonb),
    'patient', (select jsonb_build_object('id', p.id, 'allergies', p.allergies, 'bloodGroup', p.blood_group, 'notes', p.notes, 'flags', p.flags)
      from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id)
  ) else null end
$$;

-- Medicines and products a clinician can prescribe.
create or replace view items_catalogue with (security_invoker = true) as
  select i.id, i.code, i.name_generic, i.name_brand, i.strength, i.form, i.unit, i.selling_unit, i.controlled, i.active,
         (select pf.price from price_for(null, i.id, null) pf) as cash_price
  from item i where i.deleted_at is null;

revoke all on items_catalogue from anon;
grant select on items_catalogue to authenticated;
grant execute on function patients_list(text, integer, integer), patient_file(uuid), update_patient(uuid, jsonb),
  add_diagnosis(uuid, text, text, condition_type, boolean), add_clinical_note(uuid, text),
  prescribe(uuid, uuid, numeric, text, text, text, integer, text), order_test(uuid, uuid, text, integer),
  finish_visit(uuid), visit_clinical(uuid) to authenticated;
revoke execute on function patients_list(text, integer, integer), patient_file(uuid), update_patient(uuid, jsonb),
  add_diagnosis(uuid, text, text, condition_type, boolean), add_clinical_note(uuid, text),
  prescribe(uuid, uuid, numeric, text, text, text, integer, text), order_test(uuid, uuid, text, integer),
  finish_visit(uuid), visit_clinical(uuid) from anon;
