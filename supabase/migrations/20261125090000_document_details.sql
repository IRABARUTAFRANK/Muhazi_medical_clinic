-- 0084 · What the printed documents need: date of birth, phone, insurer, member number, weight,
-- allergies, the visit's reference, the prescriber's registration number and prescription numbers.
--
-- Frank: "Make the printed documents show date of birth, phone and member number". The document
-- builders (commit 35ad0aa) accept these fields; the screens could not read most of them.
--
--   * A  REGISTRATION NUMBER. profiles.registration_no (professional council number) and
--        profiles.registration_body (RMDC, NCNM, NPC, RAHPC…). Saved by the manager through the
--        manage-staff function, like the specialty. Read in staff_directory (manager),
--        my_placement() and my_session_profile() (the person themselves), and with each
--        prescriber / result author in visit_clinical, lab_worklist and desk_orders.
--   * B  VISIT REFERENCE. encounter.reference V-YYYY-NNNNNN (Kigali year of arrival), given when the
--        visit opens, existing visits numbered in order of arrival. The medical report prints
--        MR-{reference}.
--   * C  NO KNOWN ALLERGIES. patient.allergies_none: the nurse or doctor recorded "no known
--        allergies" (update_patient with allergies_none = true). Three states: allergies (text),
--        none (allergies_none), not recorded (neither). Writing an allergy clears "none".
--   * D  PRESCRIPTION NUMBERS. prescription_number(encounter): RX-YYYY-NNNNNN, one per printed
--        prescription of a visit, kept in prescription_doc (number, visit, lines, who, when). The
--        same number comes back while no line was added since; a new line gives a new number.
--        Rights: whoever reads the visit's prescriptions (prescription.read or clinical.read).
--   * E  DOCUMENT DETAILS in the existing reads (no new endpoint for reading):
--        visit_clinical:  patient + birthDate, sex, phone, insurer, memberNo, coveragePct,
--                         weightKg, weightAt, allergiesNone; visit {reference, at, …};
--                         prescriptions[].prescriber, orders[].result.byPerson
--        patient_file:    document {…the same patient details…}, visits[].reference
--        lab_worklist / desk_orders: the same patient details, visitReference, resultByPerson
--        visit_bill:      member_no, coverage_pct and the latest payment (receipt_no, method…)
--
-- Errcodes: 42501 not allowed, 22023 bad input (hint no_lines: nothing prescribed), P0002 not found.

-- ---------------------------------------------------------------- A registration number
alter table profiles add column if not exists registration_no text;
alter table profiles add column if not exists registration_body text;
alter table profiles drop constraint if exists profiles_registration_no_len;
alter table profiles add constraint profiles_registration_no_len
  check (registration_no is null or char_length(registration_no) between 1 and 40);
alter table profiles drop constraint if exists profiles_registration_body_len;
alter table profiles add constraint profiles_registration_body_len
  check (registration_body is null or char_length(registration_body) between 1 and 60);
comment on column profiles.registration_no is
  'Professional council registration number (RMDC, NCNM, Pharmacy Council…), printed on prescriptions and reports.';
comment on column profiles.registration_body is 'The council that registered the person (RMDC, NCNM, NPC, RAHPC…).';

-- the lists leave former employees out (0076); the registration is added at the end
create or replace view staff_directory with (security_invoker = true) as
  select p.id, p.username, p.full_name, p.role, p.station, p.dashboard, p.head_of, p.language, p.phone,
         p.active, p.must_change_pin, p.last_sign_in_at, p.pin_changed_at, p.deactivated_at, p.created_at,
         p.staff_id, p.email, p.department_id, d.name as department_name, p.position, p.specialty,
         coalesce((select jsonb_agg(jsonb_build_object('id', dd.id, 'name', dd.name, 'position', sd.position)
                                    order by (sd.department_id = p.department_id) desc, dd.name)
                   from staff_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.profile_id = p.id), '[]'::jsonb) as departments,
         p.registration_no, p.registration_body
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null
  where p.deleted_at is null;

create or replace function my_placement()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'position', p.position, 'department', d.name, 'departmentId', d.id,
    'specialty', p.specialty, 'station', p.station,
    'registrationNo', p.registration_no, 'registrationBody', p.registration_body,
    'departments', coalesce((select jsonb_agg(jsonb_build_object('id', dd.id, 'name', dd.name, 'position', sd.position)
                                              order by (sd.department_id = p.department_id) desc, dd.name)
                             from staff_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                             where sd.profile_id = p.id), '[]'::jsonb)
  )
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null
  where p.id = auth.uid()
$$;

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
    'specialty', v.specialty, 'registration_no', v.registration_no, 'registration_body', v.registration_body
  );
end
$$;

-- One staff member as a document prints them: name, role, specialty or title, registration.
create or replace function doc_person(p_profile_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object('id', p.id, 'name', p.full_name, 'role', p.role, 'specialty', p.specialty,
                            'registrationNo', p.registration_no, 'registrationBody', p.registration_body)
  from profiles p where p.id = p_profile_id
$$;

-- ---------------------------------------------------------------- B visit reference
alter table encounter add column if not exists reference text;

create or replace function assign_visit_reference()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_year integer := extract(year from (coalesce(new.arrived_at, now()) at time zone 'Africa/Kigali'))::integer;
begin
  if new.reference is null then
    new.reference := 'V-' || v_year || '-' || lpad(next_number('visit', v_year)::text, 6, '0');
  end if;
  return new;
end
$$;
drop trigger if exists trg_visit_reference on encounter;
create trigger trg_visit_reference before insert on encounter
  for each row execute function assign_visit_reference();

-- existing visits: numbered in order of arrival, per year (no audit row, no "updated" stamp)
alter table encounter disable trigger trg_audit;
alter table encounter disable trigger trg_touch;
with n as (
  select e.id, y.year,
         row_number() over (partition by y.year order by e.arrived_at, e.created_at, e.id)
           + coalesce((select s.last from number_series s where s.key = 'visit' and s.year = y.year), 0) as k
  from encounter e
  cross join lateral (select extract(year from (e.arrived_at at time zone 'Africa/Kigali'))::integer as year) y
  where e.reference is null
)
update encounter e set reference = 'V-' || n.year || '-' || lpad(n.k::text, 6, '0')
from n where e.id = n.id;
alter table encounter enable trigger trg_audit;
alter table encounter enable trigger trg_touch;
insert into number_series (key, year, last)
select 'visit', split_part(reference, '-', 2)::integer, max(split_part(reference, '-', 3)::integer)
from encounter where reference ~ '^V-[0-9]{4}-[0-9]+$'
group by 2
on conflict (key, year) do update set last = greatest(number_series.last, excluded.last);
create unique index if not exists encounter_reference_uq on encounter (reference);

-- The visit as a document prints it: reference, when, the service, the department, who referred.
create or replace function doc_visit(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', e.id, 'reference', e.reference, 'at', e.arrived_at, 'status', e.status, 'closedAt', e.closed_at,
    'service', e.service,
    'department', (select d.name from queue_entry q join department d on d.id = q.department_id
                   where q.encounter_id = e.id and q.deleted_at is null order by q.created_at desc limit 1),
    'referredBy', (select pr.full_name from queue_entry q join profiles pr on pr.id = q.referred_by
                   where q.encounter_id = e.id and q.deleted_at is null order by q.created_at desc limit 1))
  from encounter e where e.id = p_encounter_id
$$;

-- ---------------------------------------------------------------- C no known allergies
alter table patient add column if not exists allergies_none boolean not null default false;
comment on column patient.allergies_none is
  'The nurse or doctor recorded "no known allergies". allergies (text) = known allergies; neither = not recorded.';

create or replace function update_patient(p_patient_id uuid, p_fields jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_birth date := nullif(p_fields ->> 'birth_date', '')::date;
  v_age integer := nullif(p_fields ->> 'age_years', '')::integer;
  v_allergies text := nullif(trim(coalesce(p_fields ->> 'allergies', '')), '');
  v_none boolean;
begin
  if not has_perm('patient.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_fields ? 'extra' and jsonb_typeof(p_fields -> 'extra') <> 'object' then
    raise exception 'extra must be an object' using errcode = '22023';
  end if;
  if p_fields ? 'allergies_none' and jsonb_typeof(p_fields -> 'allergies_none') not in ('boolean', 'null') then
    raise exception 'allergies_none must be true or false' using errcode = '22023';
  end if;
  v_none := coalesce((p_fields ->> 'allergies_none')::boolean, false);
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
    -- an allergy written wins; "no known allergies" clears the text
    allergies = case when v_allergies is not null then v_allergies
                     when p_fields ? 'allergies' then null
                     when v_none then null
                     else allergies end,
    allergies_none = case when v_allergies is not null then false
                          when p_fields ? 'allergies_none' then v_none
                          else allergies_none end,
    notes = case when p_fields ? 'notes' then nullif(trim(p_fields ->> 'notes'), '') else notes end,
    ubudehe_category = case when p_fields ? 'ubudehe_category' then nullif(p_fields ->> 'ubudehe_category', '')::smallint else ubudehe_category end,
    language = coalesce((p_fields ->> 'language')::lang, language),
    preferred_channel = coalesce((p_fields ->> 'preferred_channel')::contact_channel, preferred_channel),
    -- Replace the whole map; the app always sends the full set of extra values.
    extra = case when p_fields ? 'extra' then p_fields -> 'extra' else extra end
  where id = p_patient_id and deleted_at is null;
  if not found then
    raise exception 'patient not found' using errcode = 'P0002';
  end if;
end
$$;

-- The patient as a document prints them. With a visit: that visit's insurer (cash = none) and
-- the weight measured at that visit, else the last one in the 90 days before it. Without a
-- visit (the patient file): the current insurance and the last weight ever measured.
create or replace function doc_patient(p_patient_id uuid, p_encounter_id uuid default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'birthDate', p.birth_date, 'ageEstimated', p.age_estimated, 'sex', p.sex,
    'phone', coalesce(p.phone_1, p.phone_2),
    'allergies', p.allergies, 'allergiesNone', p.allergies_none and p.allergies is null,
    'bloodGroup', p.blood_group,
    'insurer', cv.insurer, 'insurerType', cv.type, 'memberNo', cv.member_number, 'coveragePct', cv.pct,
    'weightKg', w.value_num, 'weightAt', w.effective_at)
  from patient p
  left join encounter e on e.id = p_encounter_id and e.patient_id = p.id
  left join lateral (
    select py.name as insurer, py.type, c.member_number, pl.coverage_pct as pct
    from coverage c
    join payer py on py.id = c.payer_id and py.type <> 'cash'
    left join plan pl on pl.id = c.plan_id
    where c.deleted_at is null and c.patient_id = p.id
      and c.id = case
        when p_encounter_id is not null then
          coalesce((select i.coverage_id from invoice i where i.encounter_id = p_encounter_id and i.deleted_at is null),
                   e.coverage_id)
        else (select c2.id from coverage c2 join payer py2 on py2.id = c2.payer_id and py2.type <> 'cash'
              where c2.patient_id = p.id and c2.active and c2.deleted_at is null
                and (c2.valid_to is null or c2.valid_to >= (now() at time zone 'Africa/Kigali')::date)
              order by c2.created_at desc limit 1) end
  ) cv on true
  left join lateral (
    select o.value_num, o.effective_at
    from observation o join encounter oe on oe.id = o.encounter_id
    where oe.patient_id = p.id and o.code = 'weight' and o.deleted_at is null and o.value_num is not null
      and (p_encounter_id is null
           or o.encounter_id = p_encounter_id
           or (o.effective_at <= coalesce(e.closed_at, now())
               and o.effective_at >= coalesce(e.arrived_at, now()) - interval '90 days'))
    order by (o.encounter_id = p_encounter_id) desc, o.effective_at desc
    limit 1
  ) w on true
  where p.id = p_patient_id
$$;

-- ---------------------------------------------------------------- D prescription numbers
create table if not exists prescription_doc (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  encounter_id uuid not null references encounter (id),
  line_ids uuid[] not null,
  issued_by uuid default auth.uid() references profiles (id) on delete set null,
  issued_at timestamptz not null default now()
);
create index if not exists prescription_doc_encounter_idx on prescription_doc (encounter_id, issued_at desc);
comment on table prescription_doc is
  'Printed prescriptions: RX-YYYY-NNNNNN for a set of prescribed lines of a visit (prescription_number).';
alter table prescription_doc enable row level security;
drop policy if exists prescription_doc_read on prescription_doc;
create policy prescription_doc_read on prescription_doc for select
  using (has_perm('prescription.read') or has_perm('clinical.read'));
revoke insert, update, delete on prescription_doc from authenticated, anon;
grant select on prescription_doc to authenticated;

-- The number of the visit's prescription: the last one issued while it still holds every line
-- prescribed now (no line added since; a cancelled line does not need a new number), else a new
-- RX-YYYY-NNNNNN. With it: the prescriber (the doctor who wrote the lines for the pharmacy, else
-- the first line) and who issued it.
create or replace function prescription_number(p_encounter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_lines uuid[];
  v_doc prescription_doc%rowtype;
  v_new boolean := false;
  v_year integer := extract(year from (now() at time zone 'Africa/Kigali'))::integer;
  v_prescriber uuid;
begin
  if not (has_perm('prescription.read') or has_perm('clinical.read')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- one number at a time per visit (two printers at once get the same one)
  perform 1 from encounter where id = p_encounter_id and deleted_at is null for update;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into v_lines
  from medication_request m
  where m.encounter_id = p_encounter_id and m.deleted_at is null and m.cancelled_at is null;
  if cardinality(v_lines) = 0 then
    raise exception 'nothing is prescribed for this visit' using errcode = '22023', hint = 'no_lines';
  end if;
  select * into v_doc from prescription_doc
  where encounter_id = p_encounter_id order by issued_at desc, number desc limit 1;
  if v_doc.id is null or not (v_lines <@ v_doc.line_ids) then
    insert into prescription_doc (number, encounter_id, line_ids, issued_by)
    values ('RX-' || v_year || '-' || lpad(next_number('prescription', v_year)::text, 6, '0'),
            p_encounter_id, v_lines, auth.uid())
    returning * into v_doc;
    v_new := true;
  end if;
  select coalesce(m.prescriber_id, m.created_by) into v_prescriber
  from medication_request m
  where m.id = any (v_lines)
  order by (m.supply = 'room'), m.created_at
  limit 1;
  return jsonb_build_object(
    'number', v_doc.number, 'issuedAt', v_doc.issued_at, 'issuedById', v_doc.issued_by,
    'issuedBy', (select full_name from profiles where id = v_doc.issued_by),
    'lineIds', to_jsonb(v_doc.line_ids), 'isNew', v_new,
    'prescriber', doc_person(v_prescriber));
end
$$;

-- ---------------------------------------------------------------- E the reads
-- The visit's clinical record (0082), plus what the documents print.
create or replace function visit_clinical(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  -- clinicians; the lab and the pharmacy read the record too (their orders and prescriptions)
  select case when has_perm('clinical.read') or has_perm('orders.read') or has_perm('prescription.read')
              then jsonb_build_object(
    'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by)) order by c.created_at)
      from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.value_text, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id)) order by o.effective_at)
      from observation o where o.encounter_id = p_encounter_id and o.code = 'note' and o.deleted_at is null), '[]'::jsonb),
    'prescriptions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by)), 'item', i.name_generic || coalesce(' ' || i.strength, ''), 'dose', m.dose, 'route', m.route,
        'frequency', m.frequency, 'days', m.duration_days, 'quantity', m.quantity, 'instructions', m.instructions, 'at', m.created_at,
        'dispensed', m.supply = 'room' or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'supply', m.supply, 'givenAt', m.given_at, 'givenBy', (select full_name from profiles where id = m.given_by),
        'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason,
        'prescriberId', coalesce(m.prescriber_id, m.created_by), 'pending', rx_pending(m),
        'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
        'cancelledBy', (select full_name from profiles where id = m.cancelled_by),
        'prescriber', doc_person(coalesce(m.prescriber_id, m.created_by))) order by m.created_at)
      from medication_request m join item i on i.id = m.item_id where m.encounter_id = p_encounter_id and m.deleted_at is null), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end), 'status', r.status, 'reason', r.reason, 'at', r.created_at,
        'result', (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
          'corrected', d.corrected_at is not null, 'correctionReason', d.correction_reason,
          'at', coalesce(d.verified_at, d.updated_at), 'by', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
          'byPerson', doc_person(coalesce(d.verified_by, d.created_by)))
          from diagnostic_report d where d.service_request_id = r.id and d.deleted_at is null)) order by r.created_at)
      from service_request r join service s on s.id = r.service_id where r.encounter_id = p_encounter_id and r.deleted_at is null), '[]'::jsonb),
    'patient', (select jsonb_build_object('id', p.id, 'allergies', p.allergies, 'bloodGroup', p.blood_group, 'notes', p.notes, 'flags', p.flags)
                       || doc_patient(p.id, e.id)
      from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id),
    'visit', doc_visit(p_encounter_id)
  ) else null end
$$;

-- The patient file (0017), plus the document details and each visit's reference.
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
      'id', e.id, 'reference', e.reference, 'arrivedAt', e.arrived_at, 'status', e.status, 'type', e.type,
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
                            'conditions', v_conditions, 'bills', v_bills,
                            'document', doc_patient(p_patient_id, null));
end
$$;

-- The lab / ultrasound worklist (0063), plus what the result report prints.
create or replace function lab_worklist(p_scope text default 'open')
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.prio, x.at), '[]'::jsonb)
  from (
    select r.priority as prio, r.created_at as at, doc_patient(p.id, e.id) || jsonb_build_object(
      'id', r.id, 'encounterId', r.encounter_id, 'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'sex', p.sex, 'birthDate', p.birth_date,
      'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = r.encounter_id order by q.created_at limit 1),
      'triage', e.triage_level,
      'test', s.name_en, 'category', r.category, 'status', r.status, 'priority', r.priority,
      'reason', r.reason, 'orderedAt', r.created_at,
      'orderedBy', (select full_name from profiles where id = r.requester_id),
      'findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
      'corrected', d.corrected_at is not null,
      'resultAt', coalesce(d.verified_at, d.updated_at),
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
      'resultByPerson', doc_person(coalesce(d.verified_by, d.created_by)),
      'visitReference', e.reference, 'visitAt', e.arrived_at
    ) as j
    from service_request r
    join encounter e on e.id = r.encounter_id and (p_scope = 'done' or e.status = 'open')
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and has_perm('orders.read')
      and r.category = any (my_test_categories()) and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) in ('laboratory', 'ultrasound')
      and case when p_scope = 'done'
            then r.status in ('resulted', 'verified')
                 and (coalesce(d.verified_at, d.updated_at) at time zone 'Africa/Kigali')::date
                     = (now() at time zone 'Africa/Kigali')::date
            else r.status not in ('verified', 'cancelled') end
  ) x
$$;

-- Orders waiting at a desk other than the lab (0059), with the same details.
create or replace function desk_orders(p_station station)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.prio, x.at), '[]'::jsonb)
  from (
    select r.priority as prio, r.created_at as at, doc_patient(p.id, e.id) || jsonb_build_object(
      'id', r.id, 'encounterId', r.encounter_id, 'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'sex', p.sex, 'birthDate', p.birth_date,
      'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = r.encounter_id order by q.created_at limit 1),
      'triage', e.triage_level,
      'test', s.name_en, 'category', r.category, 'status', r.status, 'priority', r.priority,
      'reason', r.reason, 'orderedAt', r.created_at,
      'orderedBy', (select full_name from profiles where id = r.requester_id),
      'findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
      'resultAt', coalesce(d.verified_at, d.updated_at),
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
      'resultByPerson', doc_person(coalesce(d.verified_by, d.created_by)),
      'visitReference', e.reference, 'visitAt', e.arrived_at
    ) as j
    from service_request r
    join encounter e on e.id = r.encounter_id and e.status = 'open'
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and r.station = p_station and p_station not in ('laboratory', 'ultrasound')
      and r.status not in ('verified', 'cancelled')
      and (has_perm('clinical.read') or has_perm('orders.read'))
  ) x
$$;

-- The visit's bill (0072), plus the member number, the cover and the latest payment (reprints).
create or replace view visit_bill with (security_invoker = true) as
  select i.id as invoice_id, i.encounter_id, i.status, i.payer_id, py.name as payer_name,
         i.total, i.patient_share, i.insurer_share, i.number,
         invoice_balance(i.id) as balance,
         (select coalesce(sum(p.amount), 0) from payment p where p.invoice_id = i.id and p.deleted_at is null) as paid,
         lp.paid_at as settled_at,
         lp.cashier as settled_by,
         invoice_refunded(i.id) as refunded,
         cv.member_number as member_no,
         cv.coverage_pct,
         lp.receipt_no,
         lp.method::text as receipt_method,
         lp.amount as receipt_amount,
         lp.reference as receipt_reference
  from invoice i
  left join payer py on py.id = i.payer_id
  left join lateral (
    select c.member_number, pl.coverage_pct
    from coverage c left join plan pl on pl.id = c.plan_id
    where c.id = i.coverage_id
  ) cv on true
  left join lateral (
    select p.paid_at, pr.full_name as cashier, p.receipt_no, p.method, p.amount, p.reference
    from payment p
    left join profiles pr on pr.id = p.cashier_id
    where p.invoice_id = i.id and p.deleted_at is null
    order by p.paid_at desc limit 1
  ) lp on true;

-- ---------------------------------------------------------------- grants
revoke all on function prescription_number(uuid) from public, anon;
grant execute on function prescription_number(uuid) to authenticated;
-- internal: only the checked functions call them
revoke all on function doc_person(uuid), doc_visit(uuid), doc_patient(uuid, uuid), assign_visit_reference()
  from public, anon, authenticated;
