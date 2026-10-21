-- 0053 · A patient file without a visit (a booking for a future day).
--
-- register_patient always starts a visit (ticket, queue, bill). When reception books an
-- appointment for someone who has no file yet, only the file is created now; the visit starts
-- when the patient arrives ("Arrived" on the booking).

create or replace function register_patient_file(
  p_surname text,
  p_given_names text,
  p_sex sex default 'unknown',
  p_birth_date date default null,
  p_age_years integer default null,
  p_phone text default null,
  p_national_id text default null,
  p_sector text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_file text;
  v_birth date := p_birth_date;
  v_estimated boolean := false;
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
  v_nid text := nullif(regexp_replace(coalesce(p_national_id, ''), '[^0-9]', '', 'g'), '');
begin
  if not has_perm('patient.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_surname, ''))) < 2 or length(trim(coalesce(p_given_names, ''))) < 2 then
    raise exception 'surname and given names are required' using errcode = '22023';
  end if;
  if v_birth is null and p_age_years is not null then
    v_birth := (current_date - make_interval(years => p_age_years))::date;
    v_estimated := true;
  end if;
  if v_nid is not null and length(v_nid) <> 16 then
    raise exception 'the national ID has 16 digits' using errcode = '22023';
  end if;
  if v_nid is not null then
    select file_number into v_file from patient where national_id = v_nid and deleted_at is null;
    if found then
      raise exception 'a patient with this national ID already exists: %', v_file using errcode = '23505';
    end if;
  end if;
  insert into patient (surname, given_names, sex, birth_date, age_estimated, phone_1, national_id, sector)
  values (trim(p_surname), trim(p_given_names), p_sex, v_birth, v_estimated, v_phone, v_nid, nullif(trim(coalesce(p_sector, '')), ''))
  returning id, file_number into v_id, v_file;
  return jsonb_build_object('patient_id', v_id, 'file_number', v_file);
end
$$;

revoke all on function register_patient_file(text, text, sex, date, integer, text, text, text) from public, anon;
grant execute on function register_patient_file(text, text, sex, date, integer, text, text, text) to authenticated;
