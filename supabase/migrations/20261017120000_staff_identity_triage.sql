-- Muhazi Medical Clinic System — 0011 staff identity, two-step sign-in, triage-first workflow
-- 1. Every employee gets a staff ID (MMC-S-0001) and a real e-mail address. Sign-in is three
--    steps: staff ID on the public page → username + PIN → one-time code sent to the e-mail.
-- 2. Registration from any station: the receptionist registers patients, but so can the nurse
--    at triage or the doctor in an emergency (MoH workflow: vitals first, unless it is an
--    emergency that goes straight to the doctor).
-- 3. Triage first: a registered patient is queued at triage; the nurse records vitals and a
--    triage colour, then sends the patient to the right station. Emergencies skip triage.

-- ---------------------------------------------------------------- staff ID and e-mail
alter table profiles
  add column staff_id text unique check (staff_id ~ '^MMC-S-[0-9]{4}$'),
  add column email text;

comment on column profiles.staff_id is 'Public staff identifier the employee types on the landing page before signing in.';
comment on column profiles.email is 'Where the sign-in code is sent (copy of auth.users.email).';

create or replace function assign_staff_id()
returns trigger
language plpgsql
as $$
begin
  if new.staff_id is null then
    new.staff_id := 'MMC-S-' || lpad(next_number('staff_id', 0)::text, 4, '0');
  end if;
  return new;
end
$$;
create trigger trg_profiles_staff_id before insert on profiles
  for each row execute function assign_staff_id();

-- Existing employees: IDs in order of creation, e-mail copied from Auth.
do $$
declare
  r record;
begin
  for r in select id from profiles where staff_id is null order by created_at, username loop
    update profiles set staff_id = 'MMC-S-' || lpad(next_number('staff_id', 0)::text, 4, '0') where id = r.id;
  end loop;
end
$$;
update profiles p set email = u.email from auth.users u where u.id = p.id and p.email is null;

-- Profile from the Auth user's metadata; the e-mail is the Auth e-mail.
create or replace function handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into profiles (id, username, full_name, role, station, dashboard, head_of, language,
                        must_change_pin, created_by, phone, email, staff_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data ->> 'role')::role_key, 'receptionist'),
    new.raw_user_meta_data ->> 'station',
    new.raw_user_meta_data ->> 'dashboard',
    new.raw_user_meta_data ->> 'head_of',
    coalesce((new.raw_user_meta_data ->> 'language')::lang, 'kin'),
    coalesce((new.raw_user_meta_data ->> 'must_change_pin')::boolean, true),
    nullif(new.raw_user_meta_data ->> 'created_by', '')::uuid,
    new.raw_user_meta_data ->> 'phone',
    new.email,
    nullif(new.raw_user_meta_data ->> 'staff_id', '')
  )
  on conflict (id) do nothing;
  return new;
end
$$;

-- Keep profiles.email in step when the manager changes the Auth e-mail.
create or replace function sync_profile_email()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.email is distinct from old.email then
    update profiles set email = new.email where id = new.id;
  end if;
  return new;
end
$$;
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function sync_profile_email();

create or replace function record_sign_in(p_device text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v profiles%rowtype;
begin
  update profiles set last_sign_in_at = now()
  where id = auth.uid() and active
  returning * into v;
  if not found then
    raise exception 'this account is deactivated; ask the manager' using errcode = '42501';
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, reason)
  values (auth.uid(), 'login', 'profiles', auth.uid(), p_device);
  return jsonb_build_object(
    'id', v.id, 'username', v.username, 'full_name', v.full_name, 'role', v.role,
    'station', v.station, 'dashboard', v.dashboard, 'head_of', v.head_of,
    'language', v.language, 'must_change_pin', v.must_change_pin,
    'staff_id', v.staff_id, 'email', v.email
  );
end
$$;

create or replace view staff_directory with (security_invoker = true) as
  select id, username, full_name, role, station, dashboard, head_of, language, phone,
         active, must_change_pin, last_sign_in_at, pin_changed_at, deactivated_at, created_at,
         staff_id, email
  from profiles;

-- ---------------------------------------------------------------- public sign-in helpers (anonymous)
-- Step 1 on the landing page: is this an active staff ID? Nothing else is revealed.
create or replace function public_staff_check(p_staff_id text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles where staff_id = upper(trim(p_staff_id)) and active
  )
$$;

-- Step 2 on the login page: the e-mail behind this staff ID + username, so Supabase Auth can
-- check the PIN and send the one-time code. Both must match an active account.
create or replace function staff_login_email(p_staff_id text, p_username text)
returns text
language sql stable security definer set search_path = public
as $$
  select email from profiles
  where staff_id = upper(trim(p_staff_id)) and username = lower(trim(p_username)) and active
$$;

grant execute on function public_staff_check(text), staff_login_email(text, text) to anon, authenticated;

-- ---------------------------------------------------------------- registration from any station
-- Treating stations may register a patient who did not pass by reception (emergencies).
insert into role_permissions (role, permission)
values ('lab_tech', 'patient.write'), ('sonographer', 'patient.write'), ('pharmacist', 'patient.write')
on conflict do nothing;

-- Patient search for the registration screen: file number, phone, national ID or name.
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
      or p.national_id = q.text
      or regexp_replace(coalesce(p.phone_1, ''), '[^0-9]', '', 'g') like '%' || regexp_replace(q.text, '[^0-9]', '', 'g') || '%'
         and length(regexp_replace(q.text, '[^0-9]', '', 'g')) >= 4
      or (p.surname || ' ' || p.given_names) ilike '%' || q.text || '%'
      or (p.given_names || ' ' || p.surname) ilike '%' || q.text || '%'
    )
  order by p.surname, p.given_names
  limit greatest(1, least(p_limit, 50))
$$;

-- Opens the visit and the first queue entry. Normal path: triage. Emergency: straight to the
-- station of the staff member registering (red triage, top priority).
create or replace function start_visit(
  p_patient_id uuid,
  p_emergency boolean default false,
  p_station station default 'consultation',
  p_type encounter_type default 'opd'
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_station station := case when p_emergency then p_station else 'triage'::station end;
  v_enc uuid;
  v_ticket text;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from encounter where patient_id = p_patient_id and status = 'open') then
    raise exception 'this patient already has an open visit' using errcode = '23505';
  end if;
  v_enc := open_encounter(p_patient_id, p_type, v_station);
  if p_emergency then
    update encounter
    set triage_level = 'red', triage_reason = 'Emergency: registered directly at ' || p_station::text
    where id = v_enc;
    update queue_entry set priority = 1 where encounter_id = v_enc;
  end if;
  select ticket_no into v_ticket from queue_entry where encounter_id = v_enc order by created_at desc limit 1;
  return jsonb_build_object('encounter_id', v_enc, 'ticket_no', v_ticket, 'station', v_station);
end
$$;

-- New patient file + visit in one call (registration screen, any station with patient.write).
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
  v_id uuid;
  v_file text;
  v_birth date := p_birth_date;
  v_estimated boolean := false;
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
  v_nid text := nullif(regexp_replace(coalesce(p_national_id, ''), '[^0-9]', '', 'g'), '');
  v_visit jsonb;
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
  v_visit := start_visit(v_id, p_emergency, p_station, p_type);
  return v_visit || jsonb_build_object('patient_id', v_id, 'file_number', v_file);
end
$$;

-- ---------------------------------------------------------------- triage: vitals, colour, next station
-- The nurse records the first measurements, gives a triage colour and sends the patient on.
-- Vitals JSON keys: bp_sys, bp_dia, pulse, temp, resp, spo2, weight, height, muac (numbers).
create or replace function record_vitals(
  p_encounter_id uuid,
  p_vitals jsonb,
  p_triage triage_level,
  p_next_station station,
  p_reason text default null
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_key text;
  v_val numeric;
  v_units jsonb := '{"bp_sys":"mmHg","bp_dia":"mmHg","pulse":"bpm","temp":"°C","resp":"/min","spo2":"%","weight":"kg","height":"cm","muac":"cm"}'::jsonb;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  for v_key, v_val in
    select key, nullif(value, '')::numeric from jsonb_each_text(coalesce(p_vitals, '{}'::jsonb))
  loop
    if v_val is not null and v_units ? v_key then
      insert into observation (encounter_id, code, value_num, unit)
      values (p_encounter_id, v_key, v_val, v_units ->> v_key);
    end if;
  end loop;
  update encounter set triage_level = p_triage, triage_reason = coalesce(p_reason, triage_reason)
  where id = p_encounter_id;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = 'triage' and finished_at is null;
  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
  insert into queue_entry (encounter_id, station, ticket_no, priority)
  values (p_encounter_id, p_next_station, v_ticket,
          case p_triage when 'red' then 1 when 'yellow' then 2 else 3 end);
  return v_ticket;
end
$$;

-- Station screens: "my queue". RLS of the underlying tables applies (security_invoker).
create or replace view queue_board with (security_invoker = true) as
  select q.id as queue_id, q.encounter_id, q.station, q.ticket_no, q.priority,
         q.created_at as queued_at, q.called_at, q.started_at, q.finished_at,
         e.patient_id, e.triage_level, e.arrived_at, e.type as encounter_type,
         p.file_number, p.surname, p.given_names, p.sex, p.birth_date, p.phone_1
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  join patient p on p.id = e.patient_id
  where q.deleted_at is null and e.status = 'open';

-- The last observations of a visit (triage card on the doctor's screen).
create or replace view visit_vitals with (security_invoker = true) as
  select distinct on (encounter_id, code)
         encounter_id, code, value_num, unit, effective_at
  from observation
  where deleted_at is null
  order by encounter_id, code, effective_at desc;

revoke all on queue_board, visit_vitals from anon;
grant select on queue_board, visit_vitals to authenticated;
grant execute on function find_patients(text, integer), start_visit(uuid, boolean, station, encounter_type),
  register_patient(text, text, sex, date, integer, text, text, text, boolean, station, encounter_type),
  record_vitals(uuid, jsonb, triage_level, station, text) to authenticated;
revoke execute on function find_patients(text, integer), start_visit(uuid, boolean, station, encounter_type),
  register_patient(text, text, sex, date, integer, text, text, text, boolean, station, encounter_type),
  record_vitals(uuid, jsonb, triage_level, station, text), assign_staff_id(), sync_profile_email() from anon;
