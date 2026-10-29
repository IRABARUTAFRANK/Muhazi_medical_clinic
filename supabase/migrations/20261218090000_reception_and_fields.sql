-- 0108 · Reception and the patient file's fields.
--
-- 1. A booking without a patient file (a website request with only a name and a phone) no longer
--    gets a bare file: "Arrived" links an existing file (p_patient_id) or creates one from the
--    registration form (p_registration), validated like register_patient_file, required fields
--    included, in the same transaction as the arrival. Reception may also book a request without
--    a file ("the file is made when the patient arrives": approve_inquiry_auto p_without_file).
-- 2. Identity by ID type: national ID = exactly 16 digits (stored digits only), passport or another
--    ID = 6 to 20 letters or digits (stored upper case, spaces and dashes removed). Checked with a
--    clear sentence on create and update; the column checks of the new columns are NOT VALID, so
--    nothing already recorded is re-checked (national_id is char(16) with its digit check since
--    0002: no longer value can exist).
-- 3. record_vitals: whoever records may name themselves as the one who measured (reception
--    included); naming nobody still asks who measured when the person has no clinical rights.
-- 4. Customizable patient file: the built-in fields are shown, hidden or required (setting
--    patient.builtins, read by patient_builtins()); the manager's extra fields (patient.fields)
--    carry "required" and their order. Required fields are checked when a file is created (not
--    for an emergency, nor the nurse's quick file: those are completed later) and a required
--    field already filled may not be emptied on update; older files are not re-checked, they list
--    what is missing (patient_missing, files_to_complete, appointments_day).

-- ---------------------------------------------------------------- 1. new columns
alter table patient add column if not exists id_type text;
alter table patient add column if not exists id_number text;
alter table patient add column if not exists email text;
alter table patient add column if not exists province text;
alter table patient add column if not exists marital_status text;

alter table patient drop constraint if exists patient_id_type_check;
alter table patient add constraint patient_id_type_check
  check (id_type is null or id_type in ('national_id', 'passport', 'other')) not valid;
alter table patient drop constraint if exists patient_id_number_check;
alter table patient add constraint patient_id_number_check
  check (id_number is null or id_number ~ '^[A-Z0-9]{6,20}$') not valid;
alter table patient drop constraint if exists patient_email_check;
alter table patient add constraint patient_email_check
  check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') not valid;
alter table patient drop constraint if exists patient_marital_status_check;
alter table patient add constraint patient_marital_status_check
  check (marital_status is null or marital_status in ('single', 'married', 'widowed', 'divorced', 'separated')) not valid;
create index if not exists patient_id_number_idx on patient (id_number) where id_number is not null;

-- ---------------------------------------------------------------- 2. the built-in fields' settings
-- Shown, hidden or required per built-in field; surname, given names, sex and the date of birth
-- (or age) are not listed: always shown and required. The defaults keep the file as it was; the
-- fields new in 0108 (e-mail, province, marital status) start hidden.
create or replace function patient_builtins()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select '{"national_id":"shown","phone_1":"shown","phone_2":"shown","email":"hidden","province":"hidden",
           "district":"shown","sector":"shown","cell":"shown","village":"shown","occupation":"shown",
           "marital_status":"hidden","ubudehe_category":"shown","emergency":"shown"}'::jsonb
         || coalesce((select value from setting where key = 'patient.builtins' and jsonb_typeof(value) = 'object'),
                     '{}'::jsonb)
$$;

create or replace function save_patient_builtins(p_value jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_key text;
  v_state text;
  v_known jsonb := patient_builtins();
  v_clean jsonb := '{}'::jsonb;
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p_value) is distinct from 'object' then
    raise exception 'a field is shown, hidden or required' using errcode = '22023';
  end if;
  for v_key, v_state in select key, value #>> '{}' from jsonb_each(p_value) loop
    if not v_known ? v_key then
      raise exception 'unknown patient field %', v_key using errcode = '22023';
    end if;
    if v_state is null or v_state not in ('shown', 'hidden', 'required') then
      raise exception 'a field is shown, hidden or required' using errcode = '22023';
    end if;
    v_clean := v_clean || jsonb_build_object(v_key, v_state);
  end loop;
  insert into setting (key, value, changed_by, changed_at)
  values ('patient.builtins', v_clean, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, changed_by = auth.uid(), changed_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'setting', null, jsonb_build_object('key', 'patient.builtins'));
  return patient_builtins();
end
$$;

-- ---------------------------------------------------------------- 3. what a file still needs
-- The file has an identity document, or says why not, or is a child under 16.
create or replace function patient_has_id(p patient)
returns boolean
language sql stable
as $$
  select p.national_id is not null or p.id_number is not null or p.no_national_id is not null
         or (p.birth_date is not null and p.birth_date > current_date - interval '16 years')
$$;

-- The required fields (settings b = patient_builtins(), f = patient_fields()) the file lacks, as
-- the keys the app translates: national_id, phone, phone_2, email, province, district, address
-- (the sector), cell, village, occupation, marital_status, ubudehe_category, emergency, and
-- extra:<key> for the manager's fields (in the manager's order).
create or replace function patient_required_keys(p patient, b jsonb, f jsonb)
returns text[]
language sql stable
as $$
  select array_remove(array[
    case when b ->> 'national_id' = 'required' and not patient_has_id(p) then 'national_id' end,
    case when b ->> 'phone_1' = 'required' and nullif(trim(coalesce(p.phone_1, '')), '') is null then 'phone' end,
    case when b ->> 'phone_2' = 'required' and nullif(trim(coalesce(p.phone_2, '')), '') is null then 'phone_2' end,
    case when b ->> 'email' = 'required' and nullif(trim(coalesce(p.email, '')), '') is null then 'email' end,
    case when b ->> 'province' = 'required' and nullif(trim(coalesce(p.province, '')), '') is null then 'province' end,
    case when b ->> 'district' = 'required' and nullif(trim(coalesce(p.district, '')), '') is null then 'district' end,
    case when b ->> 'sector' = 'required' and nullif(trim(coalesce(p.sector, '')), '') is null then 'address' end,
    case when b ->> 'cell' = 'required' and nullif(trim(coalesce(p.cell, '')), '') is null then 'cell' end,
    case when b ->> 'village' = 'required' and nullif(trim(coalesce(p.village, '')), '') is null then 'village' end,
    case when b ->> 'occupation' = 'required' and nullif(trim(coalesce(p.occupation, '')), '') is null then 'occupation' end,
    case when b ->> 'marital_status' = 'required' and p.marital_status is null then 'marital_status' end,
    case when b ->> 'ubudehe_category' = 'required' and p.ubudehe_category is null then 'ubudehe_category' end,
    case when b ->> 'emergency' = 'required'
          and (nullif(trim(coalesce(p.emergency_name, '')), '') is null
               or nullif(trim(coalesce(p.emergency_phone, '')), '') is null) then 'emergency' end
  ], null)
  || coalesce(array(
       select 'extra:' || (d ->> 'key')
       from jsonb_array_elements(case when jsonb_typeof(f) = 'array' then f else '[]'::jsonb end)
            with ordinality as x(d, n)
       where d -> 'required' = 'true'::jsonb and nullif(d ->> 'key', '') is not null
         and nullif(trim(coalesce(p.extra ->> (d ->> 'key'), p.extra ->> (d ->> 'label'), '')), '') is null
       order by n), '{}'::text[])
$$;

-- What the file still needs: the details reception always completes (phone, ID, address, unless
-- the manager hid them; the age), then whatever the clinic made required.
create or replace function patient_missing_with(p patient, b jsonb, f jsonb)
returns text[]
language sql stable
as $$
  with l as (
    select array_remove(array[
      case when b ->> 'phone_1' <> 'hidden' and nullif(trim(coalesce(p.phone_1, '')), '') is null then 'phone' end,
      case when b ->> 'national_id' <> 'hidden' and not patient_has_id(p) then 'national_id' end,
      case when b ->> 'sector' <> 'hidden' and nullif(trim(coalesce(p.sector, '')), '') is null then 'address' end,
      case when p.birth_date is null then 'age' end
    ], null) as a
  )
  select l.a || coalesce(array(
           select k from unnest(patient_required_keys(p, b, f)) with ordinality as r(k, n)
           where not k = any(l.a) order by n), '{}'::text[])
  from l
$$;

create or replace function patient_missing(p patient)
returns text[]
language sql stable security definer set search_path = public
as $$
  select patient_missing_with(p, patient_builtins(), patient_fields())
$$;

-- The keys above in words, for a refusal ("fill in the required fields: national ID, phone").
create or replace function patient_field_names(p_keys text[], f jsonb)
returns text
language sql stable
as $$
  select string_agg(
           case
             when k like 'extra:%' then coalesce(
               (select d ->> 'label' from jsonb_array_elements(case when jsonb_typeof(f) = 'array' then f else '[]'::jsonb end) d
                where d ->> 'key' = substr(k, 7) limit 1), substr(k, 7))
             else coalesce(jsonb_build_object(
               'national_id', 'national ID', 'phone', 'phone', 'phone_2', 'other phone', 'email', 'e-mail',
               'province', 'province', 'district', 'district', 'address', 'sector', 'cell', 'cell',
               'village', 'village', 'occupation', 'occupation', 'marital_status', 'marital status',
               'ubudehe_category', 'Ubudehe category', 'emergency', 'emergency contact',
               'age', 'date of birth or age') ->> k, k)
           end, ', ' order by n)
  from unnest(p_keys) with ordinality as x(k, n)
$$;

-- files_to_complete (from 20261019210000): the settings read once for the whole list.
create or replace function files_to_complete()
returns jsonb
language sql stable security definer set search_path = public
as $$
  with s as (select patient_builtins() as b, patient_fields() as f)
  select coalesce(jsonb_agg(x.j order by x.in_clinic desc, x.at desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
             'patientId', p.id,
             'fileNumber', p.file_number,
             'name', p.surname || ' ' || p.given_names,
             'sex', p.sex,
             'birthDate', p.birth_date,
             'missing', to_jsonb(m.missing),
             'registeredBy', rb.full_name,
             'registeredAt', p.created_at,
             'encounterId', e.id,
             'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = e.id order by q.created_at limit 1),
             'station', (select q.station from queue_entry q where q.encounter_id = e.id and q.finished_at is null
                         and q.deleted_at is null order by q.created_at desc limit 1)
           ) as j,
           (e.id is not null) as in_clinic,
           coalesce(e.arrived_at, p.created_at) as at
    from patient p
    cross join s
    left join encounter e on e.patient_id = p.id and e.status = 'open' and e.deleted_at is null
    left join profiles rb on rb.id = p.created_by
    cross join lateral (select patient_missing_with(p, s.b, s.f) as missing) m
    where has_perm('patient.read') and p.deleted_at is null and p.merged_into is null
      and (e.id is not null or p.created_at > now() - interval '2 days')
      and cardinality(m.missing) > 0
  ) x
$$;

-- ---------------------------------------------------------------- 4. identity and details
-- The identity part of a file, checked and cleaned: {id_type, national_id, id_number,
-- no_national_id}. National ID: 16 digits, digits only. Passport or other ID: 6 to 20 letters or
-- digits, upper case. One number per file; the same number on another file is refused.
create or replace function patient_identity(p jsonb, p_self uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_type text := nullif(trim(coalesce(p ->> 'id_type', '')), '');
  v_nid text := nullif(regexp_replace(coalesce(p ->> 'national_id', ''), '[^0-9]', '', 'g'), '');
  v_num text := nullif(upper(regexp_replace(coalesce(p ->> 'id_number', ''), '[[:space:].-]', '', 'g')), '');
  v_none text := nullif(trim(coalesce(p ->> 'no_national_id', '')), '');
  v_file text;
begin
  v_type := coalesce(v_type, case when v_num is not null and v_nid is null then 'other' else 'national_id' end);
  if v_type not in ('national_id', 'passport', 'other') then
    raise exception 'unknown ID type' using errcode = '22023';
  end if;
  if v_none is not null and v_none not in ('child', 'not_issued', 'foreigner') then
    raise exception 'unknown reason' using errcode = '22023';
  end if;
  if v_type = 'national_id' then
    v_num := null;
    if v_none is not null then
      v_nid := null;
    end if;
    if v_nid is not null and length(v_nid) <> 16 then
      raise exception 'the national ID has 16 digits' using errcode = '22023';
    end if;
  else
    v_nid := null;
    if v_num is not null and v_num !~ '^[A-Z0-9]{6,20}$' then
      raise exception 'a passport or other ID number has 6 to 20 letters or digits' using errcode = '22023';
    end if;
  end if;
  if v_nid is not null then
    select file_number into v_file from patient
    where national_id = v_nid and deleted_at is null and id is distinct from p_self limit 1;
    if found then
      raise exception 'a patient with this national ID already exists: %', v_file using errcode = '23505';
    end if;
  end if;
  if v_num is not null then
    select file_number into v_file from patient
    where id_number = v_num and deleted_at is null and id is distinct from p_self limit 1;
    if found then
      raise exception 'a patient with this ID number already exists: %', v_file using errcode = '23505';
    end if;
  end if;
  return jsonb_build_object('id_type', v_type, 'national_id', v_nid, 'id_number', v_num, 'no_national_id', v_none);
end
$$;

-- E-mail, marital status and Ubudehe category, when given.
create or replace function patient_check_details(p jsonb)
returns void
language plpgsql immutable
as $$
declare
  v_email text := nullif(trim(coalesce(p ->> 'email', '')), '');
  v_marital text := nullif(trim(coalesce(p ->> 'marital_status', '')), '');
  v_ubudehe text := nullif(trim(coalesce(p ->> 'ubudehe_category', '')), '');
begin
  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'the e-mail address is not valid' using errcode = '22023';
  end if;
  if v_marital is not null and v_marital not in ('single', 'married', 'widowed', 'divorced', 'separated') then
    raise exception 'unknown marital status' using errcode = '22023';
  end if;
  if v_ubudehe is not null and v_ubudehe not in ('1', '2', '3', '4') then
    raise exception 'the Ubudehe category is 1, 2, 3 or 4' using errcode = '22023';
  end if;
end
$$;

-- The manager's fields and one-off fields: an object of non-empty texts.
create or replace function patient_extra_clean(p jsonb)
returns jsonb
language sql immutable
as $$
  select coalesce(jsonb_object_agg(key, trim(value #>> '{}')), '{}'::jsonb)
  from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end)
  where jsonb_typeof(value) in ('string', 'number', 'boolean') and nullif(trim(value #>> '{}'), '') is not null
$$;

-- ---------------------------------------------------------------- 5. creating a file
-- One place makes a file: register_patient_file (registration, a booking), register_patient (with
-- a visit) and appointment_arrived (the booking's patient registered on arrival). p is the form:
-- surname, given_names, sex, birth_date or age_years, the identity, phone_1, phone_2, email,
-- province, district, sector, cell, village, occupation, marital_status, ubudehe_category,
-- emergency_name, emergency_phone, extra. The required fields are checked unless
-- p_skip_required (an emergency, the nurse's quick file).
create or replace function create_patient_file(p jsonb, p_skip_required boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_birth date := nullif(trim(coalesce(p ->> 'birth_date', '')), '')::date;
  v_age integer := nullif(trim(coalesce(p ->> 'age_years', '')), '')::integer;
  v_estimated boolean := false;
  v_ident jsonb;
  v_row patient%rowtype;
  v_f jsonb := patient_fields();
  v_missing text[];
begin
  if not has_perm('patient.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception 'surname and given names are required' using errcode = '22023';
  end if;
  if length(trim(coalesce(p ->> 'surname', ''))) < 2 or length(trim(coalesce(p ->> 'given_names', ''))) < 2 then
    raise exception 'surname and given names are required' using errcode = '22023';
  end if;
  if p ? 'extra' and jsonb_typeof(p -> 'extra') not in ('object', 'null') then
    raise exception 'extra must be an object' using errcode = '22023';
  end if;
  if v_birth is null and v_age is null then
    raise exception 'give the date of birth or the age' using errcode = '22023';
  end if;
  if v_birth is not null and v_birth > current_date then
    raise exception 'the date of birth is in the future' using errcode = '22023';
  end if;
  if v_birth is null and (v_age < 0 or v_age > 130) then
    raise exception 'the age is a number of years from 0 to 130' using errcode = '22023';
  end if;
  if v_birth is null then
    v_birth := (current_date - make_interval(years => v_age))::date;
    v_estimated := true;
  end if;
  v_ident := patient_identity(p, null);
  perform patient_check_details(p);
  insert into patient (
    surname, given_names, sex, birth_date, age_estimated,
    id_type, national_id, id_number, no_national_id,
    phone_1, phone_2, email, province, district, sector, cell, village,
    occupation, marital_status, ubudehe_category, emergency_name, emergency_phone, extra
  ) values (
    trim(p ->> 'surname'), trim(p ->> 'given_names'),
    coalesce(nullif(p ->> 'sex', '')::sex, 'unknown'), v_birth, v_estimated,
    v_ident ->> 'id_type', v_ident ->> 'national_id', v_ident ->> 'id_number', v_ident ->> 'no_national_id',
    nullif(regexp_replace(coalesce(p ->> 'phone_1', ''), '[^0-9+]', '', 'g'), ''),
    nullif(trim(coalesce(p ->> 'phone_2', '')), ''),
    lower(nullif(trim(coalesce(p ->> 'email', '')), '')),
    nullif(trim(coalesce(p ->> 'province', '')), ''),
    nullif(trim(coalesce(p ->> 'district', '')), ''),
    nullif(trim(coalesce(p ->> 'sector', '')), ''),
    nullif(trim(coalesce(p ->> 'cell', '')), ''),
    nullif(trim(coalesce(p ->> 'village', '')), ''),
    nullif(trim(coalesce(p ->> 'occupation', '')), ''),
    nullif(trim(coalesce(p ->> 'marital_status', '')), ''),
    nullif(trim(coalesce(p ->> 'ubudehe_category', '')), '')::smallint,
    nullif(trim(coalesce(p ->> 'emergency_name', '')), ''),
    nullif(trim(coalesce(p ->> 'emergency_phone', '')), ''),
    patient_extra_clean(p -> 'extra')
  )
  returning * into v_row;
  if not p_skip_required then
    v_missing := patient_required_keys(v_row, patient_builtins(), v_f);
    if cardinality(v_missing) > 0 then
      raise exception 'fill in the required fields: %', patient_field_names(v_missing, v_f) using errcode = '22023';
    end if;
  end if;
  return jsonb_build_object('patient_id', v_row.id, 'file_number', v_row.file_number);
end
$$;

-- register_patient_file (from 20261101120000): + p_fields (the rest of the form) and p_emergency.
drop function if exists register_patient_file(text, text, sex, date, integer, text, text, text);
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
    coalesce(p_emergency, false) or current_role_key() = 'nurse');
end
$$;

-- register_patient (from 20261017120000): the file through create_patient_file, then the visit.
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
    coalesce(p_emergency, false) or current_role_key() = 'nurse');
  v_visit := start_visit((v_file ->> 'patient_id')::uuid, p_emergency, p_station, p_type);
  return v_visit || v_file;
end
$$;

-- ---------------------------------------------------------------- 6. editing a file
-- update_patient (from 20261130090000_patient_privacy), plus: the identity by ID type (national
-- ID 16 digits; passport or other ID 6 to 20 letters or digits; the "no ID" reason), e-mail,
-- province and marital status, the date of birth and age checked, and a required field already
-- filled may not be emptied (an older file's empty required fields stay listed as missing).
create or replace function update_patient(p_patient_id uuid, p_fields jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_birth date := nullif(p_fields ->> 'birth_date', '')::date;
  v_age integer := nullif(p_fields ->> 'age_years', '')::integer;
  v_allergies text;
  v_none boolean;
  v_old patient%rowtype;
  v_new patient%rowtype;
  v_ident jsonb;
  v_b jsonb := patient_builtins();
  v_f jsonb := patient_fields();
  v_lost text[];
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
  select * into v_old from patient where id = p_patient_id and deleted_at is null;
  if not found then
    raise exception 'patient not found' using errcode = 'P0002';
  end if;
  if patient_level(p_patient_id) = 'identity' then
    p_fields := p_fields - 'allergies_none';
    if v_old.allergies is not null or v_old.allergies_none
       or nullif(trim(coalesce(p_fields ->> 'allergies', '')), '') is null then
      p_fields := p_fields - 'allergies';
    end if;
    if v_old.blood_group is not null or nullif(trim(coalesce(p_fields ->> 'blood_group', '')), '') is null then
      p_fields := p_fields - 'blood_group';
    end if;
    if v_old.notes is not null or nullif(trim(coalesce(p_fields ->> 'notes', '')), '') is null then
      p_fields := p_fields - 'notes';
    end if;
    -- the manager's "medical" extra fields: never shown at this level, so a value already there
    -- is kept as it is; an empty one may be filled in (like the allergies above)
    if p_fields ? 'extra' then
      p_fields := jsonb_set(p_fields, '{extra}',
        ((p_fields -> 'extra') - private_extra_keys())
        || coalesce((select jsonb_object_agg(k,
                              case when nullif(trim(coalesce(v_old.extra ->> k, '')), '') is not null
                                   then v_old.extra -> k else p_fields -> 'extra' -> k end)
                     from unnest(private_extra_keys()) k
                     where coalesce(v_old.extra, '{}'::jsonb) ? k or (p_fields -> 'extra') ? k), '{}'::jsonb));
    end if;
  end if;
  if v_birth is not null and v_birth > current_date then
    raise exception 'the date of birth is in the future' using errcode = '22023';
  end if;
  if v_birth is null and v_age is not null and (v_age < 0 or v_age > 130) then
    raise exception 'the age is a number of years from 0 to 130' using errcode = '22023';
  end if;
  -- the identity, when any part of it is sent: what is not sent stays as it is; a national ID
  -- typed without a reason ends an earlier "no ID" reason
  if p_fields ?| array['national_id', 'id_type', 'id_number', 'no_national_id'] then
    v_ident := patient_identity(jsonb_build_object(
      'id_type', case when p_fields ? 'id_type' then p_fields ->> 'id_type' else v_old.id_type end,
      'national_id', case when p_fields ? 'national_id' then p_fields ->> 'national_id' else v_old.national_id end,
      'id_number', case when p_fields ? 'id_number' then p_fields ->> 'id_number' else v_old.id_number end,
      'no_national_id', case when p_fields ? 'no_national_id' then p_fields ->> 'no_national_id'
                             when nullif(regexp_replace(coalesce(p_fields ->> 'national_id', ''), '[^0-9]', '', 'g'), '') is not null
                               or nullif(trim(coalesce(p_fields ->> 'id_number', '')), '') is not null then null
                             else v_old.no_national_id end), p_patient_id);
  end if;
  perform patient_check_details(p_fields);
  v_allergies := nullif(trim(coalesce(p_fields ->> 'allergies', '')), '');
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
    id_type = case when v_ident is not null then v_ident ->> 'id_type' else id_type end,
    national_id = case when v_ident is not null then v_ident ->> 'national_id' else national_id end,
    id_number = case when v_ident is not null then v_ident ->> 'id_number' else id_number end,
    no_national_id = case when v_ident is not null then v_ident ->> 'no_national_id' else no_national_id end,
    phone_1 = case when p_fields ? 'phone_1' then nullif(trim(p_fields ->> 'phone_1'), '') else phone_1 end,
    phone_2 = case when p_fields ? 'phone_2' then nullif(trim(p_fields ->> 'phone_2'), '') else phone_2 end,
    email = case when p_fields ? 'email' then lower(nullif(trim(p_fields ->> 'email'), '')) else email end,
    province = case when p_fields ? 'province' then nullif(trim(p_fields ->> 'province'), '') else province end,
    district = case when p_fields ? 'district' then nullif(trim(p_fields ->> 'district'), '') else district end,
    sector = case when p_fields ? 'sector' then nullif(trim(p_fields ->> 'sector'), '') else sector end,
    cell = case when p_fields ? 'cell' then nullif(trim(p_fields ->> 'cell'), '') else cell end,
    village = case when p_fields ? 'village' then nullif(trim(p_fields ->> 'village'), '') else village end,
    occupation = case when p_fields ? 'occupation' then nullif(trim(p_fields ->> 'occupation'), '') else occupation end,
    marital_status = case when p_fields ? 'marital_status' then nullif(trim(p_fields ->> 'marital_status'), '') else marital_status end,
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
    ubudehe_category = case when p_fields ? 'ubudehe_category' then nullif(trim(p_fields ->> 'ubudehe_category'), '')::smallint else ubudehe_category end,
    language = coalesce((p_fields ->> 'language')::lang, language),
    preferred_channel = coalesce((p_fields ->> 'preferred_channel')::contact_channel, preferred_channel),
    -- Replace the whole map; the app always sends the full set of extra values.
    extra = case when p_fields ? 'extra' then p_fields -> 'extra' else extra end
  where id = p_patient_id and deleted_at is null
  returning * into v_new;
  -- a required field that was filled stays filled
  v_lost := coalesce(array(
    select k from unnest(patient_required_keys(v_new, v_b, v_f)) with ordinality as x(k, n)
    where not k = any(patient_required_keys(v_old, v_b, v_f)) order by n), '{}'::text[]);
  if cardinality(v_lost) > 0 then
    raise exception 'a required field cannot be emptied: %', patient_field_names(v_lost, v_f) using errcode = '22023';
  end if;
end
$$;

-- find_patients (from 20261203090000_guide_fixes): a national ID typed with spaces, a passport
-- or other ID number.
create or replace function find_patients(p_query text, p_limit integer default 10)
returns table (
  id uuid, file_number text, surname text, given_names text, sex sex, birth_date date,
  phone_1 text, has_open_visit boolean
)
language sql stable security definer set search_path = public
as $$
  with q as (select trim(coalesce(p_query, '')) as text)
  select p.id, p.file_number, p.surname, p.given_names, p.sex, p.birth_date, p.phone_1,
         exists (select 1 from encounter e where e.patient_id = p.id and e.status = 'open') as has_open_visit
  from patient p, q
  where has_perm('patient.read')
    and p.deleted_at is null and p.merged_into is null and length(q.text) >= 2
    and (
      upper(p.file_number) = upper(q.text)
      -- a file number of a duplicate merged into this one
      or exists (select 1 from patient_alias a where a.patient_id = p.id and upper(a.file_number) = upper(q.text))
      or p.national_id = q.text
      or (length(regexp_replace(q.text, '[^0-9]', '', 'g')) = 16
          and p.national_id = regexp_replace(q.text, '[^0-9]', '', 'g') and q.text !~ '[A-Za-z]')
      or (p.id_number is not null and p.id_number = upper(regexp_replace(q.text, '[[:space:].-]', '', 'g')))
      or regexp_replace(coalesce(p.phone_1, ''), '[^0-9]', '', 'g') like '%' || regexp_replace(q.text, '[^0-9]', '', 'g') || '%'
         and length(regexp_replace(q.text, '[^0-9]', '', 'g')) >= 4
      or (p.surname || ' ' || p.given_names) ilike '%' || q.text || '%'
      or (p.given_names || ' ' || p.surname) ilike '%' || q.text || '%'
    )
  order by p.surname, p.given_names
  limit greatest(1, least(p_limit, 50))
$$;

-- ---------------------------------------------------------------- 7. bookings
-- approve_inquiry_auto (from 20261106090000_desks_wave8): + p_without_file, the request booked
-- with only the name and phone the person gave; the file is made when the patient arrives.
drop function if exists approve_inquiry_auto(uuid, uuid, uuid, timestamptz);
create or replace function approve_inquiry_auto(
  p_appointment_id uuid,
  p_patient_id uuid default null,
  p_practitioner_user uuid default null,
  p_starts_at timestamptz default null,
  p_without_file boolean default false
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
  if v_patient is null and not coalesce(p_without_file, false) then
    select contact_phone into v_phone from appointment where id = p_appointment_id and status = 'inquiry';
    if v_phone is null then
      raise exception 'inquiry not found or already handled' using errcode = 'P0002';
    end if;
    select count(*), (array_agg(id))[1] into v_matches, v_patient from patient
    where deleted_at is null and merged_into is null
      and phone_key(phone_1) = phone_key(v_phone);
    if v_matches <> 1 then
      raise exception 'register the patient first (no single file matches phone %)', v_phone using errcode = 'P0002';
    end if;
  end if;
  perform approve_inquiry(p_appointment_id, v_patient, p_practitioner_user, p_starts_at);
  return v_patient;
end
$$;

-- approve_inquiry (from 20261107090000_desks_wave9): the file may come later.
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
  -- 0108: a request may be booked without a file (made when the patient arrives)
  if p_patient_id is not null and not exists (select 1 from patient where id = p_patient_id and deleted_at is null) then
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

-- appointment_arrived (from 20261204090000_calendars_for_nurses_and_managers): + p_patient_id
-- (a file found for the booking) and p_registration (the file made from the registration form).
drop function if exists appointment_arrived(uuid);
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
    (select q.station from queue_entry q where q.encounter_id = v_enc and q.finished_at is null order by q.created_at desc limit 1),
    'patient_id', v_appt.patient_id,
    'file_number', (select file_number from patient where id = v_appt.patient_id),
    'new_file', v_file is not null);
end
$$;

-- appointments_day (from 20261211090000_booking_seen_rule): + what the booked file still needs.
create or replace function appointments_day(p_day date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id,
      'time', to_char(a.starts_at at time zone 'Africa/Kigali', 'HH24:MI'),
      'startsAt', a.starts_at,
      'status', a.status,
      'patientId', a.patient_id,
      'fileNumber', p.file_number,
      'name', coalesce(p.surname || ' ' || p.given_names, a.contact_name),
      'phone', coalesce(p.phone_1, a.contact_phone),
      'doctor', pr.names,
      'reason', a.reason,
      'reference', a.reference,
      'source', a.source,
      'channel', a.contact_channel,
      'late', a.status in ('approved', 'confirmed') and a.starts_at < now() - interval '15 minutes',
      'doctorUserId', pr.user_id,
      'encounterId', (select e.id from encounter e where e.appointment_id = a.id order by e.arrived_at desc limit 1),
      -- 0108: what the booked patient's file still needs (null: no file yet)
      'missing', case when p.id is not null then to_jsonb(patient_missing(p)) end,
      'declineReason', case when a.status = 'declined' then a.cancel_reason end,
      'cancelReason', case when a.status = 'cancelled' then a.cancel_reason end,
      -- a declined booking already booked again (a later booking of the same patient)
      'rebooked', a.status = 'declined' and exists (
        select 1 from appointment b
        where b.patient_id = a.patient_id and b.id <> a.id and b.deleted_at is null
          and b.created_at > a.updated_at
          and b.status not in ('declined', 'rejected', 'cancelled'))
    ) order by a.starts_at), '[]'::jsonb)
  from appointment a
  left join patient p on p.id = a.patient_id
  left join practitioner pr on pr.id = a.practitioner_id
  where (has_perm('appointment.read') or has_perm('appointment.approve')) and a.deleted_at is null
    and a.status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed', 'no_show', 'cancelled', 'declined')
    and (a.starts_at at time zone 'Africa/Kigali')::date = coalesce(p_day, (now() at time zone 'Africa/Kigali')::date)
$$;

-- ---------------------------------------------------------------- 8. vitals measured by reception
-- record_vitals (from 20261213090000_vitals_custom): reception may name herself as the one who
-- measured; the observation's author (created_by) stays the person typing.
create or replace function record_vitals(
  p_encounter_id uuid,
  p_vitals jsonb,
  p_triage triage_level default null,
  p_next_station station default null,
  p_reason text default null,
  p_measured_by uuid default null,
  p_measured_at timestamptz default null
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_key text;
  v_raw jsonb;
  v_val numeric;
  v_unit text;
  v_label text;
  v_type vital_type%rowtype;
  v_count integer := 0;
  v_by uuid := coalesce(p_measured_by, auth.uid());
  v_at timestamptz := coalesce(p_measured_at, now());
  v_arrived timestamptz;
  v_at_triage boolean;
begin
  if not has_perm('vitals.write') then
    raise exception 'you may not record vital signs (the manager has not allowed it)' using errcode = '42501', hint = 'not_permitted';
  end if;
  -- open, or finished and inside the person's edit window (20261212 visit_edit_lock)
  select arrived_at into v_arrived from encounter
  where id = p_encounter_id and deleted_at is null and (status = 'open' or visit_edit_active(id));
  if not found then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  select exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'triage'
                 and finished_at is null and deleted_at is null) into v_at_triage;
  -- At triage: the people of a department that does triage (when none does, as before).
  if v_at_triage then
    perform assert_desk(array['triage'], 'triage');
  end if;
  -- Sending on from triage is for whoever may work on the patient (as with "Send on"): reception
  -- that sent the patient to triage, or a nurse other than the one named, records only.
  if v_at_triage and p_next_station is not null and not may_route(p_encounter_id) then
    if current_role_key() = 'receptionist' then
      raise exception 'this patient is with %: record the measurements without choosing where they go next; the nurse there sends them on',
        coalesce(patient_holder(p_encounter_id), 'triage') using errcode = '42501';
    end if;
    perform assert_may_work_on(p_encounter_id, true);
  end if;
  -- Without clinical rights the person typing says who measured: the nurse whose paper sheet it
  -- is, or themselves (0108: reception may measure too; "Me" is sent as their own id).
  if not has_perm('clinical.write') and p_measured_by is null then
    raise exception 'choose the nurse who took the measurements' using errcode = '22023';
  end if;
  if not exists (select 1 from profiles where id = v_by and active) then
    raise exception 'unknown staff member for "measured by"' using errcode = '22023';
  end if;
  -- the person named as having measured must be allowed to record vital signs themselves
  if v_by <> auth.uid() and not staff_perm(v_by, 'vitals.write') then
    raise exception 'the person named as "measured by" is not allowed to take vital signs'
      using errcode = '42501', hint = 'not_permitted';
  end if;
  if v_at > now() + interval '5 minutes' then
    raise exception 'the measurement time is in the future' using errcode = '22023';
  end if;
  if v_at < v_arrived - interval '1 hour' then
    raise exception 'the measurement time is before the patient arrived' using errcode = '22023';
  end if;

  for v_key, v_raw in select key, value from jsonb_each(coalesce(p_vitals, '{}'::jsonb)) loop
    v_unit := null;
    v_label := null;
    if jsonb_typeof(v_raw) = 'object' then
      v_val := nullif(trim(v_raw ->> 'value'), '')::numeric;
      v_unit := nullif(trim(v_raw ->> 'unit'), '');
      v_label := nullif(trim(v_raw ->> 'label'), '');
    else
      v_val := nullif(trim(v_raw #>> '{}'), '')::numeric;
    end if;
    if v_val is null then
      continue;
    end if;
    select * into v_type from vital_type where code = v_key;
    if found then
      -- the same limits as the form (newborn to adult, critically ill included): outside them it
      -- is a typing mistake
      case v_key
        when 'bp_sys' then
          if v_val not between 40 and 300 then
            raise exception 'the systolic blood pressure must be between 40 and 300 mmHg' using errcode = '22023';
          end if;
        when 'bp_dia' then
          if v_val not between 20 and 200 then
            raise exception 'the diastolic blood pressure must be between 20 and 200 mmHg' using errcode = '22023';
          end if;
        when 'pulse' then
          if v_val not between 20 and 250 then
            raise exception 'the pulse must be between 20 and 250 per minute' using errcode = '22023';
          end if;
        when 'temp' then
          if v_val not between 30 and 44 then
            raise exception 'the temperature must be between 30 and 44 °C' using errcode = '22023';
          end if;
        when 'resp' then
          if v_val not between 4 and 100 then
            raise exception 'the breathing rate must be between 4 and 100 per minute' using errcode = '22023';
          end if;
        when 'spo2' then
          if v_val not between 40 and 100 then
            raise exception 'the oxygen saturation must be between 40 and 100 %%' using errcode = '22023';
          end if;
        when 'weight' then
          if v_val not between 0.3 and 350 then
            raise exception 'the weight must be between 0.3 and 350 kg' using errcode = '22023';
          end if;
        when 'height' then
          if v_val not between 20 and 250 then
            raise exception 'the height must be between 20 and 250 cm' using errcode = '22023';
          end if;
        when 'muac' then
          if v_val not between 5 and 60 then
            raise exception 'the arm circumference must be between 5 and 60 cm' using errcode = '22023';
          end if;
        else
          if v_val not between v_type.min_value and v_type.max_value then
            raise exception 'the measurement % must be between % and % %', v_key, v_type.min_value, v_type.max_value, v_type.unit
              using errcode = '22023', hint = 'vital_range';
          end if;
      end case;
      v_unit := v_type.unit;
      v_label := null;
    elsif v_key ~ '^custom_[a-z0-9_]{1,40}$' then
      -- a custom measurement: its typed name, its unit as typed (or none)
      if v_label is null or length(v_label) > 60 then
        raise exception 'write the name of the measurement' using errcode = '22023', hint = 'vital_name';
      end if;
      if v_unit is not null and length(v_unit) > 20 then
        raise exception 'the unit is 20 characters at most' using errcode = '22023', hint = 'vital_name';
      end if;
      if abs(v_val) > 1000000 then
        raise exception 'the measurement % must be between % and % %', v_key, -1000000, 1000000, coalesce(v_unit, '')
          using errcode = '22023', hint = 'vital_range';
      end if;
    else
      raise exception 'unknown measurement %', v_key using errcode = '22023', hint = 'vital_unknown';
    end if;
    insert into observation (encounter_id, code, value_num, unit, label, performer_id, effective_at)
    values (p_encounter_id, v_key, v_val, v_unit, v_label, v_by, v_at);
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then
    raise exception 'enter at least one measurement' using errcode = '22023';
  end if;

  if v_by <> auth.uid() then
    insert into audit_event (actor_id, action, entity, entity_id, after, reason)
    values (auth.uid(), 'create', 'observation', p_encounter_id,
            jsonb_build_object('measured_by', v_by, 'measured_at', v_at, 'count', v_count),
            'vitals entered on behalf of the person who measured');
  end if;
  perform note_visit_edit(p_encounter_id, 'create', 'observation', p_encounter_id,
                          jsonb_build_object('vitals', p_vitals, 'measured_by', v_by, 'measured_at', v_at));

  if p_triage is not null then
    update encounter set triage_level = p_triage, triage_reason = coalesce(p_reason, triage_reason)
    where id = p_encounter_id;
    -- the colour reorders the places where the patient waits (red first)
    update queue_entry set priority = case p_triage when 'red' then 1 when 'yellow' then 2 else 3 end
    where encounter_id = p_encounter_id and finished_at is null and started_at is null and deleted_at is null;
  end if;

  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;

  -- At triage: close the triage turn and send the patient on. Later (e.g. the doctor typing
  -- the nurse's paper sheet): measurements only, the patient stays where they are.
  if v_at_triage and p_next_station is not null then
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = 'triage' and finished_at is null;
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, p_next_station, v_ticket,
            case coalesce(p_triage, 'green') when 'red' then 1 when 'yellow' then 2 else 3 end);
  end if;
  return v_ticket;
end
$$;

-- ---------------------------------------------------------------- 9. who may call what
-- inner workings: only through the functions above
revoke all on function create_patient_file(jsonb, boolean), patient_identity(jsonb, uuid),
  patient_check_details(jsonb), patient_extra_clean(jsonb), patient_field_names(text[], jsonb),
  patient_required_keys(patient, jsonb, jsonb), patient_missing_with(patient, jsonb, jsonb),
  patient_has_id(patient)
  from public, anon, authenticated;
revoke all on function patient_builtins(), save_patient_builtins(jsonb), patient_missing(patient),
  files_to_complete(), register_patient_file(text, text, sex, date, integer, text, text, text, jsonb, boolean),
  register_patient(text, text, sex, date, integer, text, text, text, boolean, station, encounter_type),
  update_patient(uuid, jsonb), find_patients(text, integer),
  approve_inquiry_auto(uuid, uuid, uuid, timestamptz, boolean),
  approve_inquiry(uuid, uuid, uuid, timestamptz), appointment_arrived(uuid, uuid, jsonb),
  appointments_day(date),
  record_vitals(uuid, jsonb, triage_level, station, text, uuid, timestamptz)
  from public, anon;
grant execute on function patient_builtins(), save_patient_builtins(jsonb), patient_missing(patient),
  files_to_complete(), register_patient_file(text, text, sex, date, integer, text, text, text, jsonb, boolean),
  register_patient(text, text, sex, date, integer, text, text, text, boolean, station, encounter_type),
  update_patient(uuid, jsonb), find_patients(text, integer),
  approve_inquiry_auto(uuid, uuid, uuid, timestamptz, boolean),
  approve_inquiry(uuid, uuid, uuid, timestamptz), appointment_arrived(uuid, uuid, jsonb),
  appointments_day(date),
  record_vitals(uuid, jsonb, triage_level, station, text, uuid, timestamptz)
  to authenticated;
