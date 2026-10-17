-- 0017 · Customizable patient file.
--
-- The manager defines extra fields for every patient file (setting `patient.fields`, a list of
-- { key, label, type, options }) and any staff member with patient.write can also add a one-off
-- field to a single patient. Values live in patient.extra (jsonb, label → value), so no schema
-- change is needed when the clinic decides to record something new.

alter table patient add column if not exists extra jsonb not null default '{}'::jsonb;

-- Everyone who opens a patient file needs the field definitions, not only staff with settings.read.
create or replace function patient_fields()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce((select value from setting where key = 'patient.fields'), '[]'::jsonb)
$$;
grant execute on function patient_fields() to authenticated;
revoke execute on function patient_fields() from anon;

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
  if p_fields ? 'extra' and jsonb_typeof(p_fields -> 'extra') <> 'object' then
    raise exception 'extra must be an object' using errcode = '22023';
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
    preferred_channel = coalesce((p_fields ->> 'preferred_channel')::contact_channel, preferred_channel),
    -- Replace the whole map; the app always sends the full set of extra values.
    extra = case when p_fields ? 'extra' then p_fields -> 'extra' else extra end
  where id = p_patient_id and deleted_at is null;
  if not found then
    raise exception 'patient not found' using errcode = 'P0002';
  end if;
end
$$;
