-- Muhazi Medical Clinic System — all migrations + seed, generated 2026-10-15T19:05:30.800Z
-- Paste into the Supabase SQL editor and run once on an empty project.

-- ============================================================ 20261015180000_foundation.sql
-- Muhazi Medical Clinic System — 0001 foundation
-- Enums, staff profiles and permissions, the common-column template every table copies,
-- the append-only audit log, human-number series, settings and devices.
-- Source: Final Project Document §1.4 (roles), §10 (database design), §5.12 (audit).

-- gen_random_uuid() is built in; pgcrypto is only used for future hashing helpers.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pgcrypto') then
    create extension if not exists pgcrypto;
  end if;
end
$$;

-- ---------------------------------------------------------------- enums
create type lang as enum ('kin', 'en', 'fr');
create type sex as enum ('female', 'male', 'other', 'unknown');
create type contact_channel as enum ('whatsapp', 'sms', 'email', 'none');
create type role_key as enum (
  'receptionist', 'cashier', 'nurse', 'doctor', 'sonographer', 'lab_tech', 'pharmacist', 'manager'
);
create type payer_type as enum ('cash', 'rssb_rama', 'cbhi', 'mmi', 'private', 'employer');
create type service_group as enum (
  'consultation', 'dental', 'lab', 'imaging', 'procedure', 'nursing', 'bed', 'registration', 'pharmacy', 'other'
);
create type tax_type as enum ('exempt', 'standard');
create type appointment_status as enum (
  'inquiry', 'approved', 'confirmed', 'arrived', 'in_progress', 'completed',
  'cancelled', 'no_show', 'rejected', 'declined'
);
create type appointment_source as enum ('reception', 'phone', 'online');
create type encounter_type as enum ('opd', 'dental', 'procedure', 'observation', 'direct_service', 'external_lab');
create type encounter_status as enum ('open', 'closed');
create type triage_level as enum ('red', 'yellow', 'green');
create type station as enum (
  'reception', 'triage', 'consultation', 'dental', 'laboratory', 'ultrasound',
  'theatre', 'nursing', 'pharmacy', 'cashier', 'beds'
);
create type result_flag as enum ('low', 'normal', 'high', 'critical');
create type condition_type as enum ('primary', 'secondary');
create type request_category as enum ('lab', 'imaging');
create type request_status as enum ('ordered', 'collected', 'in_process', 'resulted', 'verified', 'cancelled');
create type stock_location_type as enum ('main_store', 'pharmacy', 'nursing', 'lab', 'theatre');
create type stock_movement_type as enum ('receipt', 'dispense', 'transfer', 'adjustment', 'return', 'consumption');
create type invoice_status as enum ('draft', 'posted', 'credited');
create type price_origin as enum ('preset', 'manual', 'pharmacy');
create type payment_method as enum ('cash', 'momo', 'airtel', 'card', 'bank', 'insurer', 'credit', 'deposit');
create type claim_status as enum ('open', 'batched', 'submitted', 'paid', 'rejected', 'resubmitted', 'written_off');
create type batch_status as enum ('draft', 'submitted', 'paid', 'closed');
create type charge_mode as enum ('hour', 'day');
create type bed_status as enum ('free', 'occupied', 'cleaning', 'out_of_service');
create type document_type as enum (
  'national_id', 'insurance_card', 'referral', 'consent', 'outside_result', 'certificate', 'other'
);
create type message_channel as enum ('whatsapp', 'sms', 'email', 'in_app');
create type message_status as enum ('queued', 'sent', 'delivered', 'failed');
create type audit_action as enum ('read', 'create', 'update', 'delete', 'login', 'break_glass', 'settings');
create type device_platform as enum ('web', 'android', 'ios', 'windows');

-- ---------------------------------------------------------------- staff identity
-- One row per staff member. `id` is the Supabase Auth user id; the row is created
-- automatically from the user's metadata (see handle_new_user).
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9._-]{3,32}$'),
  full_name text not null,
  role role_key not null,
  station text,
  dashboard text check (dashboard in ('manager', 'head')),
  head_of text,
  language lang not null default 'kin',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Permission keys per role (doc §1.4). Policies call has_perm('<key>').
create table role_permissions (
  role role_key not null,
  permission text not null,
  primary key (role, permission)
);

create or replace function current_role_key()
returns role_key
language sql stable security definer set search_path = public
as $$
  select role from profiles where id = auth.uid() and active
$$;

create or replace function has_perm(p_permission text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from profiles p
    join role_permissions rp on rp.role = p.role
    where p.id = auth.uid() and p.active and rp.permission = p_permission
  )
$$;

create or replace function is_manager()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from profiles where id = auth.uid() and active and role = 'manager')
$$;

-- Create the profile when an auth user is created (metadata: username, full_name, role, station, dashboard, head_of, language).
create or replace function handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into profiles (id, username, full_name, role, station, dashboard, head_of, language)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data ->> 'role')::role_key, 'receptionist'),
    new.raw_user_meta_data ->> 'station',
    new.raw_user_meta_data ->> 'dashboard',
    new.raw_user_meta_data ->> 'head_of',
    coalesce((new.raw_user_meta_data ->> 'language')::lang, 'kin')
  )
  on conflict (id) do nothing;
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------- common columns
-- Template copied by every business table with `like mmc_base including all` (doc §10.1).
create table mmc_base (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  device_id uuid,
  received_at timestamptz default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  version integer not null default 1
);
comment on table mmc_base is 'Column template only (LIKE … INCLUDING ALL). Never holds rows.';

create or replace function touch_row()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  new.version := old.version + 1;
  return new;
end
$$;

-- ---------------------------------------------------------------- audit (append-only, monthly partitions)
create table audit_event (
  id bigint generated always as identity,
  actor_id uuid,
  device_id uuid,
  action audit_action not null,
  entity text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  at timestamptz not null default now(),
  primary key (id, at)
) partition by range (at);

create table audit_event_default partition of audit_event default;
create index audit_event_entity_idx on audit_event (entity, entity_id, at);
create index audit_event_actor_idx on audit_event (actor_id, at);

create or replace function ensure_audit_partitions(p_months integer default 12)
returns void
language plpgsql
as $$
declare
  m date := date_trunc('month', now())::date;
  i integer;
begin
  for i in 0 .. p_months - 1 loop
    execute format(
      'create table if not exists %I partition of audit_event for values from (%L) to (%L)',
      'audit_event_' || to_char(m + make_interval(months => i), 'YYYY_MM'),
      m + make_interval(months => i),
      m + make_interval(months => i + 1)
    );
  end loop;
end
$$;
select ensure_audit_partitions(18);

create or replace function audit_row()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_action audit_action;
  v_before jsonb;
  v_after jsonb;
  v_id uuid;
begin
  if tg_op = 'INSERT' then
    v_action := 'create'; v_after := to_jsonb(new); v_id := new.id;
  elsif tg_op = 'UPDATE' then
    v_action := 'update'; v_before := to_jsonb(old); v_after := to_jsonb(new); v_id := new.id;
  else
    v_action := 'delete'; v_before := to_jsonb(old); v_id := old.id;
  end if;
  insert into audit_event (actor_id, device_id, action, entity, entity_id, before, after)
  values (
    auth.uid(),
    nullif(coalesce(v_after ->> 'device_id', v_before ->> 'device_id'), '')::uuid,
    v_action, tg_table_name, v_id, v_before, v_after
  );
  return null;
end
$$;

-- Adds the updated_at/version trigger and the audit trigger to a table.
create or replace function install_common_triggers(p_table regclass)
returns void
language plpgsql
as $$
begin
  execute format('drop trigger if exists trg_touch on %s', p_table);
  execute format('create trigger trg_touch before update on %s for each row execute function touch_row()', p_table);
  execute format('drop trigger if exists trg_audit on %s', p_table);
  execute format('create trigger trg_audit after insert or update or delete on %s for each row execute function audit_row()', p_table);
end
$$;

-- Audit of reads and break-glass access is written by the app through this function.
create or replace function log_access(p_entity text, p_entity_id uuid, p_action audit_action default 'read', p_reason text default null)
returns void
language sql security definer set search_path = public
as $$
  insert into audit_event (actor_id, action, entity, entity_id, reason)
  values (auth.uid(), p_action, p_entity, p_entity_id, p_reason)
$$;

-- ---------------------------------------------------------------- human numbers (hub-assigned, doc §9.2)
create table number_series (
  key text not null,
  year integer not null,
  last integer not null default 0,
  primary key (key, year)
);

create or replace function next_number(p_key text, p_year integer)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v integer;
begin
  insert into number_series (key, year, last) values (p_key, p_year, 1)
  on conflict (key, year) do update set last = number_series.last + 1
  returning last into v;
  return v;
end
$$;

-- ---------------------------------------------------------------- settings, translations, devices
create table setting (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  changed_by uuid,
  changed_at timestamptz not null default now()
);

create table translation (
  key text not null,
  language lang not null,
  text text not null,
  primary key (key, language)
);

create table device (
  like mmc_base including all,
  name text not null,
  platform device_platform not null default 'web',
  user_id uuid references profiles (id),
  enrolled_by uuid,
  enrolled_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_sync_at timestamptz
);
select install_common_triggers('device');


-- ============================================================ 20261015180100_patients_payers.sql
-- Muhazi Medical Clinic System — 0002 patients and payers
-- payer, plan, patient (file number assigned here), patient_alias, coverage.
-- Source: doc §2 (the patient file), §4.5 (insurers), §10.2.

create table payer (
  like mmc_base including all,
  code text not null unique,
  name text not null unique,
  type payer_type not null,
  contacts jsonb not null default '{}'::jsonb,
  claims_officer text,
  cycle_day smallint check (cycle_day between 1 and 28),
  required_docs jsonb not null default '[]'::jsonb,
  form_template_id uuid,
  active boolean not null default true
);
comment on table payer is 'Insurers and cash. Cash is a payer with 0 % coverage so pricing is uniform.';

create table plan (
  like mmc_base including all,
  payer_id uuid not null references payer (id),
  name text not null,
  coverage_pct numeric(5, 2) not null check (coverage_pct between 0 and 100),
  pct_by_group jsonb not null default '{}'::jsonb,
  annual_cap numeric(12, 0),
  exclusions jsonb not null default '[]'::jsonb,
  preauth_rules jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  unique (payer_id, name)
);
comment on column plan.pct_by_group is 'Optional override per service_group, e.g. {"dental": 50}.';

create table patient (
  like mmc_base including all,
  file_number text unique,
  surname text not null,
  given_names text not null,
  sex sex not null default 'unknown',
  birth_date date,
  age_estimated boolean not null default false,
  national_id char(16) unique check (national_id ~ '^[0-9]{16}$'),
  id_verified boolean not null default false,
  id_source text,
  phone_1 text,
  phone_2 text,
  preferred_channel contact_channel not null default 'sms',
  language lang not null default 'kin',
  district text,
  sector text,
  cell text,
  village text,
  ubudehe_category smallint check (ubudehe_category between 1 and 4),
  occupation text,
  emergency_name text,
  emergency_phone text,
  guardian_patient_id uuid references patient (id),
  blood_group text,
  flags jsonb not null default '{}'::jsonb,
  consent_treatment boolean not null default false,
  consent_messages boolean not null default false,
  consent_insurer boolean not null default false,
  merged_into uuid references patient (id),
  photo_blob_id uuid,
  notes text
);
comment on column patient.flags is '{"vip":true,"debtor":true,"confidential":true,"deceased":true}';
create index patient_phone_idx on patient (phone_1);
create index patient_surname_idx on patient (lower(surname));
create index patient_given_idx on patient (lower(given_names));

-- File number MMC-000123, assigned by the hub (this database), never by a device.
create or replace function assign_file_number()
returns trigger
language plpgsql
as $$
begin
  if new.file_number is null then
    new.file_number := 'MMC-' || lpad(next_number('patient_file', 0)::text, 6, '0');
  end if;
  return new;
end
$$;
create trigger trg_patient_file_number before insert on patient
  for each row execute function assign_file_number();

-- Old file numbers keep working after a merge.
create table patient_alias (
  file_number text primary key,
  patient_id uuid not null references patient (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table coverage (
  like mmc_base including all,
  patient_id uuid not null references patient (id),
  payer_id uuid not null references payer (id),
  plan_id uuid references plan (id),
  member_number text,
  principal_patient_id uuid references patient (id),
  relation text,
  valid_from date,
  valid_to date,
  card_blob_id uuid,
  active boolean not null default true
);
create index coverage_patient_idx on coverage (patient_id) where active;

select install_common_triggers('payer');
select install_common_triggers('plan');
select install_common_triggers('patient');
select install_common_triggers('coverage');

-- Duplicate check before saving (same ID, then same phone, then same names + birth date).
create or replace function find_patient_duplicates(
  p_national_id text,
  p_phone text,
  p_surname text,
  p_given_names text,
  p_birth_date date
)
returns setof patient
language sql stable security definer set search_path = public
as $$
  select *
  from patient
  where deleted_at is null and merged_into is null and (
    (p_national_id is not null and national_id = p_national_id)
    or (p_phone is not null and phone_1 = p_phone)
    or (
      p_surname is not null and p_birth_date is not null
      and lower(surname) = lower(p_surname)
      and lower(given_names) = lower(coalesce(p_given_names, given_names))
      and birth_date = p_birth_date
    )
  )
  limit 10
$$;

-- Merge duplicate files: the old number becomes an alias, the old row points at the survivor.
create or replace function merge_patients(p_keep uuid, p_merge uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_old_number text;
begin
  if not is_manager() then
    raise exception 'only the manager can merge patient files' using errcode = '42501';
  end if;
  select file_number into v_old_number from patient where id = p_merge;
  insert into patient_alias (file_number, patient_id) values (v_old_number, p_keep)
  on conflict (file_number) do update set patient_id = p_keep;
  update patient set merged_into = p_keep where id = p_merge;
  update coverage set patient_id = p_keep where patient_id = p_merge;
end
$$;


-- ============================================================ 20261015180200_catalogue.sql
-- Muhazi Medical Clinic System — 0003 catalogue and pricing
-- service (preset treatments), item (medicines and products), price lists per payer,
-- practitioners with calendars, and the price-resolution function used by every charge.
-- Source: doc §4.1 (three ways a price enters the bill), §5.2 (calendars), §10.2.

create table service (
  like mmc_base including all,
  code text not null unique,
  name_en text not null,
  name_kin text,
  name_fr text,
  service_group service_group not null,
  tax_type tax_type not null default 'exempt',
  hmis_mapping text,
  allow_manual_price boolean not null default false,
  default_duration_min integer,
  active boolean not null default true
);

create table item (
  like mmc_base including all,
  code text not null unique,
  name_generic text not null,
  name_brand text,
  strength text,
  form text,
  unit text,
  pack_size integer,
  selling_unit text,
  controlled boolean not null default false,
  reorder_level integer not null default 0,
  max_level integer,
  rwanda_fda_reg text,
  active boolean not null default true
);

-- A price list belongs to one payer; payer_id null = cash price list.
create table price_list (
  like mmc_base including all,
  payer_id uuid references payer (id),
  name text not null,
  effective_from date not null default current_date,
  effective_to date,
  check (effective_to is null or effective_to >= effective_from)
);
create index price_list_payer_idx on price_list (payer_id, effective_from desc);

create table price_list_item (
  like mmc_base including all,
  price_list_id uuid not null references price_list (id) on delete cascade,
  service_id uuid references service (id),
  item_id uuid references item (id),
  price numeric(12, 0) not null check (price >= 0),
  check ((service_id is null) <> (item_id is null))
);
create unique index price_list_item_service_uq on price_list_item (price_list_id, service_id)
  where service_id is not null;
create unique index price_list_item_item_uq on price_list_item (price_list_id, item_id)
  where item_id is not null;

create table practitioner (
  like mmc_base including all,
  code text unique,
  user_id uuid references profiles (id),
  names text not null,
  title text,
  specialty text,
  licence_number text,
  signature_blob_id uuid,
  slot_minutes integer not null default 60 check (slot_minutes between 5 and 240),
  working_hours jsonb not null default '{}'::jsonb,
  rooms jsonb not null default '[]'::jsonb,
  categories text[] not null default '{}',
  languages text,
  active boolean not null default true
);
comment on column practitioner.working_hours is
  'JS weekday keys (0 = Sunday) to [["HH:MM","HH:MM"], …], e.g. {"1":[["08:00","17:00"]]}.';

select install_common_triggers('service');
select install_common_triggers('item');
select install_common_triggers('price_list');
select install_common_triggers('price_list_item');
select install_common_triggers('practitioner');

-- Price lookup: latest effective list of the payer, else the cash list (flagged as fallback).
create or replace function price_for(
  p_service_id uuid,
  p_item_id uuid,
  p_payer_id uuid,
  p_at date default current_date
)
returns table (price numeric, list_payer_id uuid, fallback boolean)
language plpgsql stable
as $$
begin
  if p_payer_id is not null then
    return query
      select pli.price, pl.payer_id, false
      from price_list pl
      join price_list_item pli on pli.price_list_id = pl.id
      where pl.payer_id = p_payer_id
        and pl.deleted_at is null and pli.deleted_at is null
        and pl.effective_from <= p_at and (pl.effective_to is null or pl.effective_to >= p_at)
        and ((p_service_id is not null and pli.service_id = p_service_id)
          or (p_item_id is not null and pli.item_id = p_item_id))
      order by pl.effective_from desc
      limit 1;
    if found then
      return;
    end if;
  end if;
  return query
    select pli.price, null::uuid, (p_payer_id is not null)
    from price_list pl
    join price_list_item pli on pli.price_list_id = pl.id
    where pl.payer_id is null
      and pl.deleted_at is null and pli.deleted_at is null
      and pl.effective_from <= p_at and (pl.effective_to is null or pl.effective_to >= p_at)
      and ((p_service_id is not null and pli.service_id = p_service_id)
        or (p_item_id is not null and pli.item_id = p_item_id))
    order by pl.effective_from desc
    limit 1;
end
$$;

-- Coverage percentage for a plan and service group (per-group override, else the plan default).
create or replace function coverage_pct_for(p_plan_id uuid, p_group service_group)
returns numeric
language sql stable
as $$
  select coalesce((p.pct_by_group ->> p_group::text)::numeric, p.coverage_pct, 0)
  from plan p
  where p.id = p_plan_id
$$;

-- Is the practitioner working at this moment (working_hours in local clinic time)?
create or replace function practitioner_is_working(p_practitioner_id uuid, p_at timestamptz)
returns boolean
language plpgsql stable
as $$
declare
  v_hours jsonb;
  v_day text;
  v_span jsonb;
  v_time time;
begin
  select working_hours into v_hours from practitioner where id = p_practitioner_id and active and deleted_at is null;
  if v_hours is null then
    return false;
  end if;
  v_day := extract(dow from p_at at time zone 'Africa/Kigali')::int::text;
  v_time := (p_at at time zone 'Africa/Kigali')::time;
  for v_span in select * from jsonb_array_elements(coalesce(v_hours -> v_day, '[]'::jsonb)) loop
    if v_time >= (v_span ->> 0)::time and v_time < (v_span ->> 1)::time then
      return true;
    end if;
  end loop;
  return false;
end
$$;

-- Public, anonymous read for the booking page: no contact details, no licence numbers.
create view public_practitioners as
  select id, code, names, title, specialty, categories, languages, working_hours, slot_minutes
  from practitioner
  where active and deleted_at is null;


-- ============================================================ 20261015180300_visits.sql
-- Muhazi Medical Clinic System — 0004 visits
-- appointment (inquiry → approved → confirmed → arrived …), encounter (the visit), queue_entry,
-- clinical records (observation, condition, service_request, diagnostic_report, procedure,
-- medication_request, medication_dispense), beds, programme events, documents.
-- Source: doc §3 (patient journey), §5.2–5.4, §6 (booking workflow), §10.2.

-- ---------------------------------------------------------------- appointments
create table appointment (
  like mmc_base including all,
  patient_id uuid references patient (id),
  practitioner_id uuid references practitioner (id),
  starts_at timestamptz,
  ends_at timestamptz,
  status appointment_status not null default 'inquiry',
  source appointment_source not null default 'reception',
  reason text,
  hold_until timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  accepted_by uuid,
  accepted_at timestamptz,
  cancel_reason text,
  series_id uuid,
  -- captured on public inquiries before a patient file exists
  contact_name text,
  contact_phone text,
  contact_channel contact_channel,
  insurer_text text,
  category text,
  reference text unique,
  check (status = 'inquiry' or patient_id is not null or contact_phone is not null),
  check (practitioner_id is not null or status in ('inquiry', 'rejected', 'cancelled'))
);
-- No double booking once a slot is approved or confirmed (doc §6).
create unique index appointment_slot_uq on appointment (practitioner_id, starts_at)
  where status in ('approved', 'confirmed', 'arrived', 'in_progress') and deleted_at is null;
create index appointment_patient_idx on appointment (patient_id, starts_at desc);
create index appointment_practitioner_idx on appointment (practitioner_id, starts_at);
create index appointment_status_idx on appointment (status, created_at desc);

-- ---------------------------------------------------------------- encounter: one visit, one record, one invoice
create table encounter (
  like mmc_base including all,
  patient_id uuid not null references patient (id),
  type encounter_type not null default 'opd',
  arrived_at timestamptz not null default now(),
  practitioner_id uuid references practitioner (id),
  triage_level triage_level,
  triage_reason text,
  coverage_id uuid references coverage (id),
  appointment_id uuid references appointment (id),
  status encounter_status not null default 'open',
  closed_at timestamptz,
  closed_by uuid,
  reopen_reason text
);
create index encounter_patient_idx on encounter (patient_id, arrived_at desc);
create index encounter_open_idx on encounter (status, arrived_at) where status = 'open';

create table queue_entry (
  like mmc_base including all,
  encounter_id uuid not null references encounter (id),
  station station not null,
  ticket_no text not null,
  priority smallint not null default 3 check (priority between 1 and 5),
  called_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  entered_by uuid default auth.uid()
);
create index queue_station_idx on queue_entry (station, created_at) where finished_at is null;

-- ---------------------------------------------------------------- clinical records (append-only; corrections supersede)
create table observation (
  like mmc_base including all,
  encounter_id uuid not null references encounter (id),
  code text not null,
  value_num numeric,
  value_text text,
  unit text,
  flag result_flag,
  performer_id uuid default auth.uid(),
  effective_at timestamptz not null default now(),
  supersedes_id uuid references observation (id)
);
create index observation_encounter_idx on observation (encounter_id, effective_at);

create table condition (
  like mmc_base including all,
  encounter_id uuid not null references encounter (id),
  icd10_code text,
  text text not null,
  type condition_type not null default 'primary',
  provisional boolean not null default false,
  onset date
);
create index condition_encounter_idx on condition (encounter_id);

create table service_request (
  like mmc_base including all,
  encounter_id uuid not null references encounter (id),
  category request_category not null,
  service_id uuid not null references service (id),
  reason text,
  status request_status not null default 'ordered',
  sample_id text unique,
  priority smallint not null default 3,
  requester_id uuid default auth.uid()
);
create index service_request_worklist_idx on service_request (category, status, created_at);

create table diagnostic_report (
  like mmc_base including all,
  service_request_id uuid not null unique references service_request (id),
  findings text,
  impression text,
  template_id uuid,
  verified_by uuid,
  verified_at timestamptz,
  attachments jsonb not null default '[]'::jsonb
);

create table procedure (
  like mmc_base including all,
  encounter_id uuid not null references encounter (id),
  service_id uuid not null references service (id),
  consent_blob_id uuid,
  note text,
  performer_id uuid default auth.uid(),
  tooth_number smallint check (tooth_number between 11 and 85),
  follow_up_date date,
  performed_at timestamptz not null default now()
);

create table medication_request (
  like mmc_base including all,
  encounter_id uuid not null references encounter (id),
  item_id uuid not null references item (id),
  dose text,
  route text,
  frequency text,
  duration_days integer,
  quantity numeric(10, 2) not null check (quantity > 0),
  instructions text,
  allergy_override_reason text,
  prescriber_id uuid default auth.uid()
);
create index medication_request_encounter_idx on medication_request (encounter_id);

-- ---------------------------------------------------------------- beds and programme events
create table bed (
  like mmc_base including all,
  name text not null unique,
  status bed_status not null default 'free',
  sort_order integer not null default 0
);

create table bed_stay (
  like mmc_base including all,
  encounter_id uuid not null references encounter (id),
  bed_id uuid not null references bed (id),
  admitted_at timestamptz not null default now(),
  discharged_at timestamptz,
  responsible_practitioner_id uuid references practitioner (id),
  charge_mode charge_mode not null default 'hour'
);
create unique index bed_stay_open_uq on bed_stay (bed_id) where discharged_at is null;

create table vaccination (
  like mmc_base including all,
  encounter_id uuid references encounter (id),
  patient_id uuid not null references patient (id),
  product_item_id uuid references item (id),
  vaccine text not null,
  lot text,
  dose_no smallint,
  next_due date,
  register jsonb not null default '{}'::jsonb
);

create table fp_event (
  like mmc_base including all,
  encounter_id uuid references encounter (id),
  patient_id uuid not null references patient (id),
  method text not null,
  counselling jsonb not null default '{}'::jsonb,
  next_due date,
  register jsonb not null default '{}'::jsonb
);

-- Sensitive (doc §2.3): separate table, separate policy, never in lists or exports.
create table hiv_test (
  like mmc_base including all,
  encounter_id uuid references encounter (id),
  patient_id uuid not null references patient (id),
  result text not null,
  counselling jsonb not null default '{}'::jsonb,
  tested_at timestamptz not null default now(),
  register jsonb not null default '{}'::jsonb
);

create table document (
  like mmc_base including all,
  patient_id uuid references patient (id),
  encounter_id uuid references encounter (id),
  type document_type not null default 'other',
  mime text,
  size integer,
  storage_key text not null,
  uploader_id uuid default auth.uid()
);
create index document_patient_idx on document (patient_id);

select install_common_triggers('appointment');
select install_common_triggers('encounter');
select install_common_triggers('queue_entry');
select install_common_triggers('observation');
select install_common_triggers('condition');
select install_common_triggers('service_request');
select install_common_triggers('diagnostic_report');
select install_common_triggers('procedure');
select install_common_triggers('medication_request');
select install_common_triggers('bed');
select install_common_triggers('bed_stay');
select install_common_triggers('vaccination');
select install_common_triggers('fp_event');
select install_common_triggers('hiv_test');
select install_common_triggers('document');

-- Verified reports are immutable (doc §10.4).
create or replace function guard_verified_report()
returns trigger
language plpgsql
as $$
begin
  if old.verified_at is not null and (new.findings is distinct from old.findings
      or new.impression is distinct from old.impression or new.attachments is distinct from old.attachments) then
    raise exception 'verified report % is immutable; issue a corrected report instead', old.id using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger trg_report_immutable before update on diagnostic_report
  for each row execute function guard_verified_report();

-- ---------------------------------------------------------------- public booking (anonymous)
-- Busy slots only: no names, no reasons. Held inquiries count as busy until hold_until.
create view public_booked_slots as
  select practitioner_id, starts_at, ends_at
  from appointment
  where deleted_at is null and practitioner_id is not null and starts_at is not null and (
    status in ('approved', 'confirmed', 'arrived', 'in_progress')
    or (status = 'inquiry' and hold_until > now())
  );

-- The only write the public site can make (doc §6: inquiry, slot held 24 h).
create or replace function create_appointment_inquiry(
  p_practitioner_code text,
  p_starts_at timestamptz,
  p_full_name text,
  p_phone text,
  p_insurer text default null,
  p_category text default null,
  p_note text default null,
  p_channel text default 'whatsapp'
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
    contact_name, contact_phone, contact_channel, insurer_text, category, reference
  ) values (
    v_practitioner.id,
    p_starts_at,
    case when p_starts_at is null then null else p_starts_at + make_interval(mins => coalesce(v_practitioner.slot_minutes, 60)) end,
    'inquiry', 'online', nullif(trim(coalesce(p_note, '')), ''), now() + interval '24 hours',
    trim(p_full_name), v_phone, v_channel, nullif(trim(coalesce(p_insurer, '')), ''), p_category, v_ref
  );
  return v_ref;
end
$$;

-- ---------------------------------------------------------------- staff workflow (doc §6 figure 2)
create or replace function approve_inquiry(p_appointment_id uuid, p_patient_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('appointment.approve') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update appointment
  set status = 'approved', patient_id = p_patient_id, approved_by = auth.uid(), approved_at = now(), hold_until = null
  where id = p_appointment_id and status = 'inquiry';
  if not found then
    raise exception 'inquiry not found or already handled' using errcode = 'P0002';
  end if;
end
$$;

create or replace function reject_inquiry(p_appointment_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('appointment.approve') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update appointment set status = 'rejected', cancel_reason = p_reason, hold_until = null
  where id = p_appointment_id and status = 'inquiry';
  if not found then
    raise exception 'inquiry not found or already handled' using errcode = 'P0002';
  end if;
end
$$;

create or replace function accept_appointment(p_appointment_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('appointment.accept') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update appointment set status = 'confirmed', accepted_by = auth.uid(), accepted_at = now()
  where id = p_appointment_id and status = 'approved';
  if not found then
    raise exception 'appointment not found or not approved' using errcode = 'P0002';
  end if;
end
$$;

create or replace function decline_appointment(p_appointment_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('appointment.accept') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update appointment set status = 'declined', cancel_reason = p_reason
  where id = p_appointment_id and status = 'approved';
  if not found then
    raise exception 'appointment not found or not approved' using errcode = 'P0002';
  end if;
end
$$;

-- Walk-in ticket or arrival of a booked patient: opens the encounter and the first queue entry.
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
  v_prefix text := case p_station when 'dental' then 'D' when 'laboratory' then 'L' when 'ultrasound' then 'U' when 'pharmacy' then 'P' else 'A' end;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
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

-- Closing a visit needs a primary diagnosis for clinical encounter types (doc §10.2 condition).
create or replace function close_encounter(p_encounter_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_type encounter_type;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select type into v_type from encounter where id = p_encounter_id and status = 'open';
  if not found then
    raise exception 'encounter not found or already closed' using errcode = 'P0002';
  end if;
  if v_type in ('opd', 'dental', 'procedure', 'observation')
     and not exists (select 1 from condition where encounter_id = p_encounter_id and type = 'primary' and deleted_at is null) then
    raise exception 'a primary diagnosis is required before closing the visit' using errcode = '23514';
  end if;
  update encounter set status = 'closed', closed_at = now(), closed_by = auth.uid() where id = p_encounter_id;
  update queue_entry set finished_at = coalesce(finished_at, now()) where encounter_id = p_encounter_id;
end
$$;


-- ============================================================ 20261015180400_stock.sql
-- Muhazi Medical Clinic System — 0005 pharmacy and stock
-- Locations, suppliers, batches, movements (the ledger), dispensing, purchase orders.
-- Quantities are never stored as editable numbers: stock on hand is a sum of movements (doc §9.2, §10.4).

create table stock_location (
  like mmc_base including all,
  name text not null unique,
  type stock_location_type not null
);

create table supplier (
  like mmc_base including all,
  name text not null unique,
  contacts jsonb not null default '{}'::jsonb,
  terms text,
  active boolean not null default true
);

create table batch (
  like mmc_base including all,
  item_id uuid not null references item (id),
  batch_no text not null,
  expiry date not null,
  unit_cost numeric(12, 2) not null default 0 check (unit_cost >= 0),
  supplier_id uuid references supplier (id),
  received_on timestamptz not null default now(),
  unique (item_id, batch_no)
);
create index batch_expiry_idx on batch (item_id, expiry);

create table stock_movement (
  like mmc_base including all,
  item_id uuid not null references item (id),
  batch_id uuid references batch (id),
  from_location_id uuid references stock_location (id),
  to_location_id uuid references stock_location (id),
  quantity integer not null check (quantity > 0),
  type stock_movement_type not null,
  reason text,
  approver_id uuid,
  procedure_id uuid references procedure (id),
  dispense_id uuid,
  moved_at timestamptz not null default now(),
  check (from_location_id is not null or to_location_id is not null)
);
create index stock_movement_item_idx on stock_movement (item_id, batch_id, moved_at);

create table medication_dispense (
  like mmc_base including all,
  medication_request_id uuid references medication_request (id),
  encounter_id uuid not null references encounter (id),
  item_id uuid not null references item (id),
  batch_id uuid not null references batch (id),
  quantity numeric(10, 2) not null check (quantity > 0),
  dispenser_id uuid default auth.uid(),
  label_printed boolean not null default false,
  substitution_reason text
);
alter table stock_movement add constraint stock_movement_dispense_fk
  foreign key (dispense_id) references medication_dispense (id);

create table purchase_order (
  like mmc_base including all,
  supplier_id uuid not null references supplier (id),
  number text unique,
  status text not null default 'draft' check (status in ('draft', 'sent', 'partially_received', 'received', 'cancelled')),
  expected_at date,
  note text
);

create table purchase_order_line (
  like mmc_base including all,
  purchase_order_id uuid not null references purchase_order (id) on delete cascade,
  item_id uuid not null references item (id),
  quantity integer not null check (quantity > 0),
  unit_price numeric(12, 2) not null default 0,
  received_quantity integer not null default 0
);

create table goods_receipt (
  like mmc_base including all,
  purchase_order_id uuid references purchase_order (id),
  supplier_id uuid references supplier (id),
  received_on timestamptz not null default now(),
  note text
);

select install_common_triggers('stock_location');
select install_common_triggers('supplier');
select install_common_triggers('batch');
select install_common_triggers('stock_movement');
select install_common_triggers('medication_dispense');
select install_common_triggers('purchase_order');
select install_common_triggers('purchase_order_line');
select install_common_triggers('goods_receipt');

-- Stock on hand per item, batch and location = receipts in − issues out.
create view stock_on_hand as
  with moves as (
    select item_id, batch_id, to_location_id as location_id, quantity from stock_movement where to_location_id is not null and deleted_at is null
    union all
    select item_id, batch_id, from_location_id, -quantity from stock_movement where from_location_id is not null and deleted_at is null
  )
  select m.item_id, m.batch_id, m.location_id, sum(m.quantity)::integer as quantity, b.expiry
  from moves m
  left join batch b on b.id = m.batch_id
  group by m.item_id, m.batch_id, m.location_id, b.expiry;

create view items_below_reorder as
  select i.id as item_id, i.code, i.name_generic, i.reorder_level, coalesce(sum(s.quantity), 0)::integer as on_hand
  from item i
  left join stock_on_hand s on s.item_id = i.id
  where i.active and i.deleted_at is null
  group by i.id
  having coalesce(sum(s.quantity), 0) < i.reorder_level;

-- Dispense earliest-expiry-first from one location; writes the ledger and the invoice line is added by billing.
create or replace function dispense_fefo(
  p_encounter_id uuid,
  p_item_id uuid,
  p_quantity integer,
  p_location_id uuid,
  p_medication_request_id uuid default null,
  p_substitution_reason text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_remaining integer := p_quantity;
  v_row record;
  v_take integer;
  v_dispense_id uuid;
  v_first boolean := true;
begin
  if not has_perm('stock.dispense') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_quantity <= 0 then
    raise exception 'quantity must be positive' using errcode = '22023';
  end if;
  for v_row in
    select s.batch_id, s.quantity
    from stock_on_hand s
    where s.item_id = p_item_id and s.location_id = p_location_id and s.quantity > 0 and s.batch_id is not null
    order by s.expiry asc nulls last
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.quantity, v_remaining);
    if v_first then
      insert into medication_dispense (medication_request_id, encounter_id, item_id, batch_id, quantity, substitution_reason)
      values (p_medication_request_id, p_encounter_id, p_item_id, v_row.batch_id, p_quantity, p_substitution_reason)
      returning id into v_dispense_id;
      v_first := false;
    end if;
    insert into stock_movement (item_id, batch_id, from_location_id, quantity, type, dispense_id)
    values (p_item_id, v_row.batch_id, p_location_id, v_take, 'dispense', v_dispense_id);
    v_remaining := v_remaining - v_take;
  end loop;
  if v_remaining > 0 then
    raise exception 'insufficient stock: % unit(s) short', v_remaining using errcode = '23514';
  end if;
  return v_dispense_id;
end
$$;


-- ============================================================ 20261015180500_billing.sql
-- Muhazi Medical Clinic System — 0006 billing, cashier, claims
-- One draft invoice per encounter accumulates charges office by office; the cashier collects the
-- patient share; posting makes the invoice immutable and opens the insurer claim.
-- Source: doc §4 (billing and pricing model), §5.7, §5.8, §10.2, §10.4.

create table invoice (
  like mmc_base including all,
  encounter_id uuid not null unique references encounter (id),
  number text unique,
  status invoice_status not null default 'draft',
  payer_id uuid references payer (id),
  coverage_id uuid references coverage (id),
  total numeric(12, 0) not null default 0,
  patient_share numeric(12, 0) not null default 0,
  insurer_share numeric(12, 0) not null default 0,
  tax_fields jsonb not null default '{}'::jsonb,
  posted_at timestamptz,
  posted_by uuid,
  provisional_no text
);
create index invoice_status_idx on invoice (status, posted_at desc);
create index invoice_payer_idx on invoice (payer_id, posted_at desc);

create table invoice_line (
  like mmc_base including all,
  invoice_id uuid not null references invoice (id),
  service_id uuid references service (id),
  item_id uuid references item (id),
  description text not null,
  quantity numeric(10, 2) not null default 1 check (quantity > 0),
  unit_price numeric(12, 0) not null check (unit_price >= 0),
  coverage_pct numeric(5, 2) not null default 0,
  patient_share numeric(12, 0) not null default 0,
  insurer_share numeric(12, 0) not null default 0,
  tax_type tax_type not null default 'exempt',
  office station not null,
  performed_by uuid,
  entered_by uuid default auth.uid(),
  entered_for uuid,
  source_type text,
  source_id uuid,
  price_origin price_origin not null default 'preset',
  manual_reason text,
  check ((service_id is null) <> (item_id is null))
);
create index invoice_line_invoice_idx on invoice_line (invoice_id, office);

create table payment (
  like mmc_base including all,
  invoice_id uuid not null references invoice (id),
  method payment_method not null,
  amount numeric(12, 0) not null check (amount > 0),
  reference text,
  payer_phone text,
  cashier_id uuid default auth.uid(),
  paid_at timestamptz not null default now(),
  day_close_id uuid,
  provider_status jsonb not null default '{}'::jsonb
);
create index payment_invoice_idx on payment (invoice_id);
create index payment_day_idx on payment (paid_at, method);

create table credit_note (
  like mmc_base including all,
  invoice_id uuid not null references invoice (id),
  number text unique,
  lines jsonb not null default '[]'::jsonb,
  total numeric(12, 0) not null default 0,
  reason text not null,
  approver_id uuid,
  refund_payment_id uuid references payment (id)
);

create table claim_batch (
  like mmc_base including all,
  payer_id uuid not null references payer (id),
  period_start date not null,
  period_end date not null,
  number text unique,
  status batch_status not null default 'draft',
  submitted_at timestamptz,
  submitted_by uuid,
  total_claimed numeric(12, 0) not null default 0,
  total_paid numeric(12, 0) not null default 0
);

create table claim (
  like mmc_base including all,
  invoice_id uuid not null unique references invoice (id),
  payer_id uuid not null references payer (id),
  member_number text,
  amount numeric(12, 0) not null default 0,
  status claim_status not null default 'open',
  rejection_reason text,
  batch_id uuid references claim_batch (id),
  resubmitted_in uuid references claim_batch (id),
  missing_docs jsonb not null default '[]'::jsonb
);
create index claim_payer_status_idx on claim (payer_id, status);

create table day_close (
  like mmc_base including all,
  date date not null,
  cashier_id uuid not null default auth.uid(),
  expected jsonb not null default '{}'::jsonb,
  counted jsonb not null default '{}'::jsonb,
  variance numeric(12, 0) not null default 0,
  note text,
  unique (date, cashier_id)
);
alter table payment add constraint payment_day_close_fk foreign key (day_close_id) references day_close (id);

select install_common_triggers('invoice');
select install_common_triggers('invoice_line');
select install_common_triggers('payment');
select install_common_triggers('credit_note');
select install_common_triggers('claim_batch');
select install_common_triggers('claim');
select install_common_triggers('day_close');

-- ---------------------------------------------------------------- immutability (doc §4.2, §10.4)
create or replace function guard_posted_invoice()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('posted', 'credited') then
    -- Only the status transition posted → credited and the provisional number are allowed to change.
    if new.total is distinct from old.total or new.patient_share is distinct from old.patient_share
       or new.insurer_share is distinct from old.insurer_share or new.number is distinct from old.number
       or new.payer_id is distinct from old.payer_id or new.encounter_id is distinct from old.encounter_id
       or (new.status is distinct from old.status and not (old.status = 'posted' and new.status = 'credited')) then
      raise exception 'invoice % is posted and immutable; issue a credit note', old.number using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;
create trigger trg_invoice_immutable before update on invoice
  for each row execute function guard_posted_invoice();

create or replace function guard_posted_invoice_lines()
returns trigger
language plpgsql
as $$
declare
  v_status invoice_status;
begin
  select status into v_status from invoice where id = coalesce(new.invoice_id, old.invoice_id);
  if v_status <> 'draft' then
    raise exception 'lines of a posted invoice cannot change' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;
create trigger trg_invoice_line_immutable before insert or update or delete on invoice_line
  for each row execute function guard_posted_invoice_lines();

create or replace function guard_submitted_batch()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('submitted', 'paid', 'closed') and new.status = 'draft' then
    raise exception 'a submitted claim batch cannot be reopened' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger trg_batch_immutable before update on claim_batch
  for each row execute function guard_submitted_batch();

-- ---------------------------------------------------------------- the running bill
-- Every encounter gets a draft invoice as soon as it opens (doc §4.2).
create or replace function ensure_draft_invoice()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_payer uuid;
begin
  select c.payer_id into v_payer from coverage c where c.id = new.coverage_id;
  insert into invoice (encounter_id, payer_id, coverage_id)
  values (new.id, v_payer, new.coverage_id)
  on conflict (encounter_id) do nothing;
  return new;
end
$$;
create trigger trg_encounter_invoice after insert on encounter
  for each row execute function ensure_draft_invoice();

create or replace function recompute_invoice(p_invoice_id uuid)
returns void
language sql security definer set search_path = public
as $$
  update invoice i
  set total = coalesce(s.total, 0),
      patient_share = coalesce(s.patient_share, 0),
      insurer_share = coalesce(s.insurer_share, 0)
  from (
    select invoice_id,
           sum(round(unit_price * quantity)) as total,
           sum(patient_share) as patient_share,
           sum(insurer_share) as insurer_share
    from invoice_line
    where invoice_id = p_invoice_id and deleted_at is null
    group by invoice_id
  ) s
  where i.id = p_invoice_id and i.status = 'draft'
$$;

-- Add a charge from any office: preset price from the payer's list, or a typed price if the
-- service allows it (doc §4.1). Stores office, performer, price origin on the line.
create or replace function add_charge(
  p_encounter_id uuid,
  p_office station,
  p_service_id uuid default null,
  p_item_id uuid default null,
  p_quantity numeric default 1,
  p_manual_price numeric default null,
  p_manual_reason text default null,
  p_performed_by uuid default null,
  p_entered_for uuid default null,
  p_source_type text default null,
  p_source_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice invoice%rowtype;
  v_plan uuid;
  v_group service_group;
  v_desc text;
  v_price numeric;
  v_fallback boolean;
  v_pct numeric := 0;
  v_origin price_origin := 'preset';
  v_line_total numeric;
  v_insurer numeric;
  v_line_id uuid;
  v_allow_manual boolean := false;
begin
  if not has_perm('charge.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if (p_service_id is null) = (p_item_id is null) then
    raise exception 'give a service or an item, not both' using errcode = '22023';
  end if;
  select * into v_invoice from invoice where encounter_id = p_encounter_id;
  if not found or v_invoice.status <> 'draft' then
    raise exception 'no open bill for this visit' using errcode = 'P0002';
  end if;

  if p_service_id is not null then
    select s.name_en, s.service_group, s.allow_manual_price into v_desc, v_group, v_allow_manual
    from service s where s.id = p_service_id and s.active;
  else
    select i.name_generic || coalesce(' ' || i.strength, ''), 'pharmacy'::service_group, false into v_desc, v_group, v_allow_manual
    from item i where i.id = p_item_id and i.active;
    v_origin := 'pharmacy';
  end if;
  if v_desc is null then
    raise exception 'unknown or inactive service/item' using errcode = '22023';
  end if;

  if p_manual_price is not null then
    if not (v_allow_manual or has_perm('charge.manual')) then
      raise exception 'a typed price is not allowed for this service' using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_manual_reason, '')), '') is null then
      raise exception 'a reason is required for a typed price' using errcode = '22023';
    end if;
    v_price := p_manual_price;
    v_origin := 'manual';
  else
    select pf.price, pf.fallback into v_price, v_fallback
    from price_for(p_service_id, p_item_id, v_invoice.payer_id) pf;
    if v_price is null then
      raise exception 'no price found for this service/item' using errcode = 'P0002';
    end if;
  end if;

  select c.plan_id into v_plan from coverage c where c.id = v_invoice.coverage_id;
  v_pct := coalesce(coverage_pct_for(v_plan, v_group), 0);
  v_line_total := round(v_price * p_quantity);
  v_insurer := round(v_line_total * v_pct / 100);

  insert into invoice_line (
    invoice_id, service_id, item_id, description, quantity, unit_price, coverage_pct,
    patient_share, insurer_share, office, performed_by, entered_for, source_type, source_id,
    price_origin, manual_reason
  ) values (
    v_invoice.id, p_service_id, p_item_id, v_desc, p_quantity, v_price, v_pct,
    v_line_total - v_insurer, v_insurer, p_office, coalesce(p_performed_by, auth.uid()), p_entered_for,
    p_source_type, p_source_id, v_origin, p_manual_reason
  ) returning id into v_line_id;

  perform recompute_invoice(v_invoice.id);
  return v_line_id;
end
$$;

-- Cashier: record a payment against the patient share (split payments allowed).
create or replace function record_payment(
  p_invoice_id uuid,
  p_method payment_method,
  p_amount numeric,
  p_reference text default null,
  p_payer_phone text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if not has_perm('billing.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_method in ('momo', 'airtel', 'card', 'bank') and nullif(trim(coalesce(p_reference, '')), '') is null then
    raise exception 'a transaction reference is required for %', p_method using errcode = '22023';
  end if;
  insert into payment (invoice_id, method, amount, reference, payer_phone)
  values (p_invoice_id, p_method, p_amount, p_reference, p_payer_phone)
  returning id into v_id;
  return v_id;
end
$$;

-- Post the invoice: hub-assigned number, immutable from now on, claim opened for the insurer share.
create or replace function post_invoice(p_invoice_id uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_inv invoice%rowtype;
  v_year integer := extract(year from now())::integer;
  v_number text;
  v_member text;
begin
  if not has_perm('billing.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform recompute_invoice(p_invoice_id);
  select * into v_inv from invoice where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if v_inv.status <> 'draft' then
    return v_inv.number;
  end if;
  if not exists (select 1 from invoice_line where invoice_id = p_invoice_id and deleted_at is null) then
    raise exception 'cannot post an empty invoice' using errcode = '23514';
  end if;
  v_number := 'INV-' || v_year || '-' || lpad(next_number('invoice', v_year)::text, 6, '0');
  update invoice set status = 'posted', number = v_number, posted_at = now(), posted_by = auth.uid()
  where id = p_invoice_id;
  if v_inv.insurer_share > 0 and v_inv.payer_id is not null then
    select member_number into v_member from coverage where id = v_inv.coverage_id;
    insert into claim (invoice_id, payer_id, member_number, amount)
    values (p_invoice_id, v_inv.payer_id, v_member, v_inv.insurer_share)
    on conflict (invoice_id) do nothing;
  end if;
  return v_number;
end
$$;

-- Balance due by the patient on an invoice.
create or replace function invoice_balance(p_invoice_id uuid)
returns numeric
language sql stable security definer set search_path = public
as $$
  select i.patient_share - coalesce((select sum(p.amount) from payment p where p.invoice_id = i.id and p.deleted_at is null), 0)
  from invoice i where i.id = p_invoice_id
$$;

-- Monthly claim batch per insurer: collects posted insured invoices of the period (doc §4.5).
create or replace function create_claim_batch(p_payer_id uuid, p_period_start date, p_period_end date)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_code text;
  v_total numeric;
begin
  if not has_perm('claims.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select code into v_code from payer where id = p_payer_id;
  insert into claim_batch (payer_id, period_start, period_end, number)
  values (p_payer_id, p_period_start, p_period_end,
          'CLM-' || v_code || '-' || to_char(p_period_start, 'YYYY-MM'))
  returning id into v_id;
  update claim c set status = 'batched', batch_id = v_id
  from invoice i
  where c.invoice_id = i.id and c.payer_id = p_payer_id and c.status = 'open'
    and i.status = 'posted' and i.posted_at::date between p_period_start and p_period_end;
  select coalesce(sum(amount), 0) into v_total from claim where batch_id = v_id;
  update claim_batch set total_claimed = v_total where id = v_id;
  return v_id;
end
$$;


-- ============================================================ 20261015180600_messaging.sql
-- Muhazi Medical Clinic System — 0007 communication, tasks, HMIS
-- Templates in three languages, the outbound message log, internal tasks, frozen monthly HMIS forms.
-- Privacy rule (doc §5.10): a message carries only the fact, never a diagnosis, result or drug name.

create table template (
  key text not null,
  language lang not null,
  body text not null,
  whatsapp_template_name text,
  primary key (key, language)
);

create table message (
  like mmc_base including all,
  patient_id uuid references patient (id),
  channel message_channel not null,
  to_address text,
  template_key text,
  body text not null,
  status message_status not null default 'queued',
  provider_ref text,
  cost numeric(10, 2),
  sent_at timestamptz,
  error text
);
create index message_status_idx on message (status, created_at);
create index message_patient_idx on message (patient_id, created_at desc);

create table internal_task (
  like mmc_base including all,
  encounter_id uuid references encounter (id),
  patient_id uuid references patient (id),
  assigned_role role_key,
  assigned_to uuid references profiles (id),
  due_at timestamptz,
  title text not null,
  detail text,
  done_at timestamptz,
  done_by uuid
);
create index internal_task_due_idx on internal_task (assigned_role, due_at) where done_at is null;

create table hmis_submission (
  like mmc_base including all,
  period date not null unique,
  data jsonb not null default '{}'::jsonb,
  frozen_at timestamptz,
  sent_by uuid
);

select install_common_triggers('message');
select install_common_triggers('internal_task');
select install_common_triggers('hmis_submission');

-- Queue a message in the patient's preferred channel, falling back to SMS (doc §5.10).
create or replace function queue_message(p_patient_id uuid, p_template_key text, p_body text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_patient patient%rowtype;
  v_channel message_channel;
  v_id uuid;
begin
  if not has_perm('messages.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_patient from patient where id = p_patient_id;
  if not found or not v_patient.consent_messages then
    raise exception 'patient has not consented to messages' using errcode = '42501';
  end if;
  v_channel := case v_patient.preferred_channel
    when 'whatsapp' then 'whatsapp'::message_channel
    when 'email' then 'email'::message_channel
    else 'sms'::message_channel end;
  insert into message (patient_id, channel, to_address, template_key, body)
  values (p_patient_id, v_channel, coalesce(v_patient.phone_1, ''), p_template_key, p_body)
  returning id into v_id;
  return v_id;
end
$$;


-- ============================================================ 20261015180700_security.sql
-- Muhazi Medical Clinic System — 0008 security
-- Permission keys per role (doc §1.4), row-level security on every table, grants for the
-- Supabase roles. The anonymous public site can only read the two public views and call
-- create_appointment_inquiry(); staff go through has_perm().

-- ---------------------------------------------------------------- role → permissions
insert into role_permissions (role, permission)
select r::role_key, p
from (values
  -- receptionist: register and find patients, queue tickets, inquiries and approval, print cards
  ('receptionist', 'patient.read'), ('receptionist', 'patient.write'),
  ('receptionist', 'appointment.read'), ('receptionist', 'appointment.write'), ('receptionist', 'appointment.approve'),
  ('receptionist', 'queue.read'), ('receptionist', 'queue.write'),
  ('receptionist', 'billing.read'),
  ('receptionist', 'messages.read'), ('receptionist', 'messages.write'),
  ('receptionist', 'catalogue.read'), ('receptionist', 'settings.read'), ('receptionist', 'staff.read'),
  -- cashier / finance: payments, receipts, day close, charge slips from stations without a screen
  ('cashier', 'patient.read'),
  ('cashier', 'billing.read'), ('cashier', 'billing.write'), ('cashier', 'charge.write'),
  ('cashier', 'claims.read'),
  ('cashier', 'queue.read'), ('cashier', 'queue.write'),
  ('cashier', 'catalogue.read'), ('cashier', 'settings.read'), ('cashier', 'staff.read'),
  -- nurse: vitals, triage, nursing acts, beds, vaccination, FP, HIV testing, charge nursing acts
  ('nurse', 'patient.read'), ('nurse', 'patient.write'),
  ('nurse', 'appointment.read'),
  ('nurse', 'queue.read'), ('nurse', 'queue.write'),
  ('nurse', 'clinical.read'), ('nurse', 'clinical.write'),
  ('nurse', 'sensitive.read'), ('nurse', 'sensitive.write'),
  ('nurse', 'orders.read'), ('nurse', 'prescription.read'),
  ('nurse', 'charge.write'), ('nurse', 'stock.read'),
  ('nurse', 'catalogue.read'), ('nurse', 'settings.read'), ('nurse', 'staff.read'),
  -- doctor / dentist: consult, diagnose, prescribe, order, procedures, accept appointments, charge acts
  ('doctor', 'patient.read'), ('doctor', 'patient.write'),
  ('doctor', 'appointment.read'), ('doctor', 'appointment.accept'),
  ('doctor', 'queue.read'), ('doctor', 'queue.write'),
  ('doctor', 'clinical.read'), ('doctor', 'clinical.write'),
  ('doctor', 'sensitive.read'), ('doctor', 'sensitive.write'),
  ('doctor', 'orders.read'), ('doctor', 'orders.write'), ('doctor', 'prescription.read'),
  ('doctor', 'charge.write'), ('doctor', 'charge.manual'),
  ('doctor', 'catalogue.read'), ('doctor', 'settings.read'), ('doctor', 'staff.read'),
  -- sonographer: imaging worklist, reports, charge for exams
  ('sonographer', 'patient.read'),
  ('sonographer', 'queue.read'), ('sonographer', 'queue.write'),
  ('sonographer', 'clinical.read'),
  ('sonographer', 'orders.read'), ('sonographer', 'orders.write'),
  ('sonographer', 'charge.write'),
  ('sonographer', 'catalogue.read'), ('sonographer', 'settings.read'), ('sonographer', 'staff.read'),
  -- lab technician: samples, results, verification, reports, reagent stock, charge for tests
  ('lab_tech', 'patient.read'),
  ('lab_tech', 'queue.read'), ('lab_tech', 'queue.write'),
  ('lab_tech', 'orders.read'), ('lab_tech', 'orders.write'),
  ('lab_tech', 'charge.write'),
  ('lab_tech', 'stock.read'), ('lab_tech', 'stock.write'),
  ('lab_tech', 'catalogue.read'), ('lab_tech', 'settings.read'), ('lab_tech', 'staff.read'),
  -- pharmacist: dispense, prices of medicines, stock, purchases, direct sales
  ('pharmacist', 'patient.read'),
  ('pharmacist', 'queue.read'), ('pharmacist', 'queue.write'),
  ('pharmacist', 'prescription.read'),
  ('pharmacist', 'stock.read'), ('pharmacist', 'stock.write'), ('pharmacist', 'stock.dispense'),
  ('pharmacist', 'charge.write'), ('pharmacist', 'item_price.write'),
  ('pharmacist', 'catalogue.read'), ('pharmacist', 'settings.read'), ('pharmacist', 'staff.read')
) as v(r, p);

-- manager / owner: everything (clinical notes read-only is enforced by the app and audit)
insert into role_permissions (role, permission)
select 'manager', p
from unnest(array[
  'patient.read', 'patient.write', 'appointment.read', 'appointment.write', 'appointment.approve', 'appointment.accept',
  'queue.read', 'queue.write', 'clinical.read', 'orders.read', 'prescription.read',
  'charge.write', 'charge.manual', 'billing.read', 'billing.write', 'claims.read', 'claims.write',
  'stock.read', 'stock.write', 'stock.dispense', 'item_price.write',
  'catalogue.read', 'catalogue.write', 'settings.read', 'settings.write',
  'messages.read', 'messages.write', 'staff.read', 'staff.write', 'audit.read', 'reports.read'
]) as p;

-- ---------------------------------------------------------------- policy helper
create or replace function apply_rls(p_table text, p_read text, p_write text)
returns void
language plpgsql
as $$
begin
  execute format('alter table %I enable row level security', p_table);
  execute format('drop policy if exists %I on %I', p_table || '_select', p_table);
  execute format('drop policy if exists %I on %I', p_table || '_insert', p_table);
  execute format('drop policy if exists %I on %I', p_table || '_update', p_table);
  execute format('drop policy if exists %I on %I', p_table || '_delete', p_table);
  execute format('create policy %I on %I for select to authenticated using (has_perm(%L))',
                 p_table || '_select', p_table, p_read);
  execute format('create policy %I on %I for insert to authenticated with check (has_perm(%L))',
                 p_table || '_insert', p_table, p_write);
  execute format('create policy %I on %I for update to authenticated using (has_perm(%L)) with check (has_perm(%L))',
                 p_table || '_update', p_table, p_write, p_write);
  -- Nothing is physically deleted during retention (doc §2.3); only the manager may hard-delete.
  execute format('create policy %I on %I for delete to authenticated using (is_manager())',
                 p_table || '_delete', p_table);
end
$$;

-- ---------------------------------------------------------------- tables
alter table mmc_base enable row level security;            -- template: no policies, no access
alter table number_series enable row level security;       -- functions only
alter table audit_event enable row level security;
create policy audit_event_select on audit_event for select to authenticated using (has_perm('audit.read'));

alter table profiles enable row level security;
create policy profiles_select on profiles for select to authenticated
  using (id = auth.uid() or has_perm('staff.read'));
create policy profiles_insert on profiles for insert to authenticated with check (has_perm('staff.write'));
create policy profiles_update on profiles for update to authenticated
  using (id = auth.uid() or has_perm('staff.write'))
  with check (id = auth.uid() or has_perm('staff.write'));

alter table role_permissions enable row level security;
create policy role_permissions_select on role_permissions for select to authenticated using (true);
create policy role_permissions_write on role_permissions for all to authenticated
  using (is_manager()) with check (is_manager());

select apply_rls('setting', 'settings.read', 'settings.write');
select apply_rls('translation', 'settings.read', 'settings.write');
select apply_rls('device', 'staff.read', 'staff.write');

select apply_rls('payer', 'catalogue.read', 'catalogue.write');
select apply_rls('plan', 'catalogue.read', 'catalogue.write');
select apply_rls('patient', 'patient.read', 'patient.write');
select apply_rls('patient_alias', 'patient.read', 'patient.write');
select apply_rls('coverage', 'patient.read', 'patient.write');

select apply_rls('service', 'catalogue.read', 'catalogue.write');
select apply_rls('item', 'catalogue.read', 'item_price.write');
select apply_rls('price_list', 'catalogue.read', 'catalogue.write');
select apply_rls('price_list_item', 'catalogue.read', 'catalogue.write');
select apply_rls('practitioner', 'catalogue.read', 'staff.write');

select apply_rls('appointment', 'appointment.read', 'appointment.write');
select apply_rls('encounter', 'queue.read', 'queue.write');
select apply_rls('queue_entry', 'queue.read', 'queue.write');
select apply_rls('observation', 'clinical.read', 'clinical.write');
select apply_rls('condition', 'clinical.read', 'clinical.write');
select apply_rls('service_request', 'orders.read', 'orders.write');
select apply_rls('diagnostic_report', 'orders.read', 'orders.write');
select apply_rls('procedure', 'clinical.read', 'clinical.write');
select apply_rls('medication_request', 'prescription.read', 'clinical.write');
select apply_rls('bed', 'queue.read', 'clinical.write');
select apply_rls('bed_stay', 'clinical.read', 'clinical.write');
select apply_rls('vaccination', 'clinical.read', 'clinical.write');
select apply_rls('fp_event', 'clinical.read', 'clinical.write');
select apply_rls('hiv_test', 'sensitive.read', 'sensitive.write');
select apply_rls('document', 'patient.read', 'patient.write');

select apply_rls('stock_location', 'stock.read', 'stock.write');
select apply_rls('supplier', 'stock.read', 'stock.write');
select apply_rls('batch', 'stock.read', 'stock.write');
select apply_rls('stock_movement', 'stock.read', 'stock.write');
select apply_rls('medication_dispense', 'prescription.read', 'stock.dispense');
select apply_rls('purchase_order', 'stock.read', 'stock.write');
select apply_rls('purchase_order_line', 'stock.read', 'stock.write');
select apply_rls('goods_receipt', 'stock.read', 'stock.write');

select apply_rls('invoice', 'billing.read', 'billing.write');
select apply_rls('invoice_line', 'billing.read', 'charge.write');
select apply_rls('payment', 'billing.read', 'billing.write');
select apply_rls('credit_note', 'billing.read', 'billing.write');
select apply_rls('claim', 'claims.read', 'claims.write');
select apply_rls('claim_batch', 'claims.read', 'claims.write');
select apply_rls('day_close', 'billing.read', 'billing.write');

select apply_rls('template', 'messages.read', 'settings.write');
select apply_rls('message', 'messages.read', 'messages.write');
select apply_rls('internal_task', 'queue.read', 'queue.write');
select apply_rls('hmis_submission', 'reports.read', 'reports.read');

-- Clinical staff may read the running bill of the visit they are working on (doc §4.2).
create policy invoice_select_clinical on invoice for select to authenticated using (has_perm('charge.write'));
create policy invoice_line_select_clinical on invoice_line for select to authenticated using (has_perm('charge.write'));

-- ---------------------------------------------------------------- grants (Supabase roles)
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke all on all tables in schema public from anon;
revoke all on mmc_base from anon, authenticated;
revoke all on number_series from anon, authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function create_appointment_inquiry(text, timestamptz, text, text, text, text, text, text) to anon;
grant select on public_practitioners, public_booked_slots to anon, authenticated;

alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public revoke execute on functions from anon;


-- ============================================================ 20261015180800_public_api.sql
-- Muhazi Medical Clinic System — 0009 public read surface
-- What the anonymous public site may read so that the landing and booking pages show live data:
-- service lines with real "from" prices, accepted insurers, clinic profile and hours, and an
-- aggregate "clinic now" status. No patient data, no staff contact details.

-- Each preset service maps to one public booking category (null = internal only).
alter table service add column booking_category text
  check (booking_category in ('consultation', 'dental', 'laboratory', 'ultrasound', 'nursing', 'surgery', 'fp', 'hiv', 'circ'));
create index service_booking_category_idx on service (booking_category) where booking_category is not null;

-- Cheapest cash price per category today ("From RWF 8,000"); free services flagged.
create view public_service_lines as
  select
    s.booking_category as category,
    min(case when pli.price > 0 then pli.price end)::numeric(12, 0) as price_from,
    bool_or(pli.price = 0) as has_free,
    count(*)::integer as services
  from service s
  join price_list pl
    on pl.payer_id is null and pl.deleted_at is null
   and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
  join price_list_item pli
    on pli.price_list_id = pl.id and pli.service_id = s.id and pli.deleted_at is null
  where s.active and s.deleted_at is null and s.booking_category is not null
  group by s.booking_category;

create view public_payers as
  select code, name, type
  from payer
  where active and deleted_at is null and type <> 'cash'
  order by name;

-- Clinic profile (name, address, phone, email) and opening hours from settings.
create or replace function public_clinic_info()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'profile', coalesce((select value from setting where key = 'clinic.profile'), '{}'::jsonb),
    'hours', coalesce((select value from setting where key = 'clinic.hours'), '{}'::jsonb)
  )
$$;

-- Aggregate "clinic now": people waiting, average wait today, open/closed. Never a name.
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
begin
  select count(*) into v_waiting
  from queue_entry
  where finished_at is null and deleted_at is null
    and (created_at at time zone 'Africa/Kigali')::date = v_local::date;
  select round(avg(extract(epoch from (called_at - created_at)) / 60)) into v_avg
  from queue_entry
  where called_at is not null and deleted_at is null
    and (created_at at time zone 'Africa/Kigali')::date = v_local::date;
  if v_span is not null and jsonb_array_length(v_span) = 2 then
    v_open := v_local::time >= (v_span ->> 0)::time and v_local::time < (v_span ->> 1)::time;
  end if;
  return jsonb_build_object(
    'waiting', coalesce(v_waiting, 0),
    'avg_wait_min', coalesce(v_avg, 0),
    'open', v_open,
    'opens_at', v_span ->> 0,
    'closes_at', v_span ->> 1,
    'as_of', now()
  );
end
$$;

grant select on public_service_lines, public_payers to anon, authenticated;
grant execute on function public_clinic_info(), public_clinic_status() to anon, authenticated;


-- ============================================================ 20261015180900_staff_management.sql
-- Muhazi Medical Clinic System — 0010 employee accounts and sign-in security
-- The clinic manager owns every staff account: creates it, hands over the username and a
-- first PIN, resets PINs, deactivates leavers. Accounts live in Supabase Auth; this file adds the
-- profile fields and the database side of those flows. The Auth side (create user, set
-- password, ban) runs in the `manage-staff` Edge Function with the service role.
-- Source: doc §1.4 (roles), §5.11 (users, roles, devices), §5.12 (security and audit).

alter table profiles
  add column must_change_pin boolean not null default true,
  add column pin_changed_at timestamptz,
  add column last_sign_in_at timestamptz,
  add column deactivated_at timestamptz,
  add column created_by uuid,
  add column phone text,
  add column notes text;

comment on column profiles.must_change_pin is 'True until the employee replaces the PIN the manager handed over.';

-- Profile from the Auth user's metadata (set by manage-staff or seed-staff).
create or replace function handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into profiles (id, username, full_name, role, station, dashboard, head_of, language,
                        must_change_pin, created_by, phone)
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
    new.raw_user_meta_data ->> 'phone'
  )
  on conflict (id) do nothing;
  return new;
end
$$;

-- ---------------------------------------------------------------- sign-in
-- Called by the app right after Supabase Auth accepted the PIN. Refuses deactivated accounts,
-- stamps the last sign-in and writes the login audit event (doc §5.12).
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
    'language', v.language, 'must_change_pin', v.must_change_pin
  );
end
$$;

-- After the employee replaced the handed-over PIN (auth.updateUser in the app).
create or replace function mark_pin_changed()
returns void
language sql security definer set search_path = public
as $$
  update profiles set must_change_pin = false, pin_changed_at = now() where id = auth.uid()
$$;

-- ---------------------------------------------------------------- manager actions (database side)
create or replace function set_profile_active(p_user uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_manager() then
    raise exception 'managers only' using errcode = '42501';
  end if;
  if p_user = auth.uid() and not p_active then
    raise exception 'you cannot deactivate your own account' using errcode = '22023';
  end if;
  update profiles
  set active = p_active, deactivated_at = case when p_active then null else now() end
  where id = p_user;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'profiles', p_user, jsonb_build_object('active', p_active));
end
$$;

create or replace function update_profile(
  p_user uuid,
  p_full_name text,
  p_role role_key,
  p_station text default null,
  p_dashboard text default null,
  p_head_of text default null,
  p_language lang default 'kin',
  p_phone text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_managers integer;
begin
  if not is_manager() then
    raise exception 'managers only' using errcode = '42501';
  end if;
  if p_dashboard is not null and p_dashboard not in ('manager', 'head') then
    raise exception 'dashboard must be manager, head or empty' using errcode = '22023';
  end if;
  -- never leave the clinic without an active manager
  if p_role <> 'manager' then
    select count(*) into v_managers from profiles where role = 'manager' and active and id <> p_user;
    if v_managers = 0 and exists (select 1 from profiles where id = p_user and role = 'manager') then
      raise exception 'the clinic must keep at least one active manager' using errcode = '22023';
    end if;
  end if;
  update profiles
  set full_name = p_full_name, role = p_role, station = p_station, dashboard = p_dashboard,
      head_of = p_head_of, language = p_language, phone = p_phone
  where id = p_user;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'profiles', p_user,
          jsonb_build_object('role', p_role, 'station', p_station, 'dashboard', p_dashboard));
end
$$;

-- Manager's directory (RLS of profiles applies through security_invoker).
create view staff_directory with (security_invoker = true) as
  select id, username, full_name, role, station, dashboard, head_of, language, phone,
         active, must_change_pin, last_sign_in_at, pin_changed_at, deactivated_at, created_at
  from profiles;

revoke all on staff_directory from anon;
grant select on staff_directory to authenticated;
grant execute on function record_sign_in(text), mark_pin_changed(), set_profile_active(uuid, boolean),
  update_profile(uuid, text, role_key, text, text, text, lang, text) to authenticated;
revoke execute on function record_sign_in(text), mark_pin_changed(), set_profile_active(uuid, boolean),
  update_profile(uuid, text, role_key, text, text, text, lang, text) from anon;


-- ============================================================ seed.sql
-- Muhazi Medical Clinic System — reference data and sample catalogue
-- Payers and plans, preset services with cash and RSSB tariffs, pharmacy items, practitioners,
-- stock locations, beds, templates and clinic settings. Prices are illustrative (doc §4.5 example).
-- Staff accounts are created by scripts/seed-staff.mjs (they live in Supabase Auth).

-- ---------------------------------------------------------------- payers and plans
insert into payer (code, name, type, cycle_day) values
  ('CASH',    'Cash',                    'cash',      null),
  ('RAMA',    'RSSB RAMA',               'rssb_rama', 5),
  ('CBHI',    'Mutuelle de Santé (CBHI)','cbhi',      5),
  ('MMI',     'MMI',                     'mmi',       10),
  ('RADIANT', 'Radiant',                 'private',   10),
  ('PRIME',   'Prime',                   'private',   10),
  ('BRITAM',  'Britam',                  'private',   10);

insert into plan (payer_id, name, coverage_pct, pct_by_group)
select id, 'Standard', pct, groups::jsonb
from (values
  ('CASH', 0, '{}'),
  ('RAMA', 85, '{}'),
  ('CBHI', 90, '{}'),
  ('MMI', 85, '{"dental": 50}'),
  ('RADIANT', 80, '{"dental": 50}'),
  ('PRIME', 80, '{}'),
  ('BRITAM', 80, '{}')
) as v(code, pct, groups)
join payer p on p.code = v.code;

-- ---------------------------------------------------------------- preset services (doc §1.1, §4.1)
insert into service (code, name_en, name_kin, name_fr, service_group, allow_manual_price, default_duration_min) values
  ('REG-CARD',  'Registration and patient card', null, 'Enregistrement et carte', 'registration', false, null),
  ('CONS-GEN',  'General consultation', 'Gusuzuma', 'Consultation générale', 'consultation', false, 20),
  ('CONS-FU',   'Follow-up consultation', null, 'Consultation de suivi', 'consultation', false, 15),
  ('CONS-FP',   'Family planning consultation', 'Kuboneza urubyaro', 'Consultation de planification familiale', 'consultation', false, 20),
  ('LAB-MRDT',  'Malaria RDT', null, 'TDR paludisme', 'lab', false, null),
  ('LAB-FBC',   'Full blood count', null, 'Hémogramme', 'lab', false, null),
  ('LAB-GLU',   'Glucose (fasting)', null, 'Glycémie à jeun', 'lab', false, null),
  ('LAB-URIN',  'Urinalysis', null, 'Analyse d''urine', 'lab', false, null),
  ('LAB-HIV',   'HIV rapid test', null, 'Test VIH rapide', 'lab', false, null),
  ('DEN-EXAM',  'Dental examination', 'Gusuzuma amenyo', 'Examen dentaire', 'dental', false, 20),
  ('DEN-FILL',  'Dental filling', null, 'Plombage', 'dental', false, 40),
  ('DEN-EXT',   'Tooth extraction', 'Gukura iryinyo', 'Extraction dentaire', 'dental', false, 30),
  ('DEN-SCAL',  'Scaling and cleaning', null, 'Détartrage', 'dental', false, 30),
  ('US-OB',     'Obstetric ultrasound', 'Guca mu cyuma', 'Échographie obstétricale', 'imaging', false, 30),
  ('US-ABD',    'Abdominal ultrasound', null, 'Échographie abdominale', 'imaging', false, 30),
  ('NUR-VIT',   'Vital signs', 'Ibipimo', 'Constantes', 'nursing', false, null),
  ('NUR-INJ',   'Injection', 'Urushinge', 'Injection', 'nursing', true, null),
  ('NUR-DRESS', 'Dressing', null, 'Pansement', 'nursing', true, null),
  ('SUR-SUT',   'Suturing', null, 'Suture', 'procedure', true, 30),
  ('SUR-ABSC',  'Abscess drainage', null, 'Drainage d''abcès', 'procedure', true, 30),
  ('SUR-CIRC',  'Circumcision', 'Gusiramura', 'Circoncision', 'procedure', false, 45),
  ('VAC-DOSE',  'Vaccination dose', 'Inkingo', 'Dose de vaccin', 'nursing', false, null),
  ('BED-HOUR',  'Observation bed (per hour)', null, 'Lit d''observation (heure)', 'bed', false, null),
  ('BED-DAY',   'Observation bed (per day)', null, 'Lit d''observation (jour)', 'bed', false, null);

-- Public booking category of each service (what the landing and booking pages show)
update service set booking_category = v.cat
from (values
  ('CONS-GEN', 'consultation'), ('CONS-FU', 'consultation'), ('CONS-FP', 'fp'),
  ('LAB-MRDT', 'laboratory'), ('LAB-FBC', 'laboratory'), ('LAB-GLU', 'laboratory'), ('LAB-URIN', 'laboratory'),
  ('LAB-HIV', 'hiv'), ('VAC-DOSE', 'hiv'),
  ('DEN-EXAM', 'dental'), ('DEN-FILL', 'dental'), ('DEN-EXT', 'dental'), ('DEN-SCAL', 'dental'),
  ('US-OB', 'ultrasound'), ('US-ABD', 'ultrasound'),
  ('NUR-VIT', 'nursing'), ('NUR-INJ', 'nursing'), ('NUR-DRESS', 'nursing'), ('BED-HOUR', 'nursing'), ('BED-DAY', 'nursing'),
  ('SUR-SUT', 'surgery'), ('SUR-ABSC', 'surgery'), ('SUR-CIRC', 'circ')
) as v(code, cat)
where service.code = v.code;

-- ---------------------------------------------------------------- pharmacy items
insert into item (code, name_generic, strength, form, unit, pack_size, selling_unit, reorder_level) values
  ('AMOX500',  'Amoxicillin', '500 mg', 'capsule', 'cap', 100, 'cap', 500),
  ('PARA500',  'Paracetamol', '500 mg', 'tablet', 'tab', 100, 'tab', 1000),
  ('AL20120',  'Artemether-lumefantrine', '20/120 mg', 'tablet', 'tab', 24, 'tab', 150),
  ('ORS',      'Oral rehydration salts', null, 'sachet', 'sachet', 100, 'sachet', 200),
  ('GLOVE-M',  'Examination gloves M', null, 'box', 'box', 1, 'box', 10),
  ('MRDT-KIT', 'Malaria RDT kit', null, 'test', 'test', 25, 'test', 100),
  ('CEFTRI1G', 'Ceftriaxone', '1 g', 'vial', 'vial', 10, 'vial', 50);

-- ---------------------------------------------------------------- price lists
insert into price_list (payer_id, name, effective_from) values (null, 'Cash prices 2026', date '2026-01-01');
insert into price_list (payer_id, name, effective_from)
select id, 'RSSB tariff 2026', date '2026-01-01' from payer where code = 'RAMA';

insert into price_list_item (price_list_id, service_id, price)
select pl.id, s.id, v.price
from (values
  ('REG-CARD', 500), ('CONS-GEN', 8000), ('CONS-FU', 5000), ('CONS-FP', 0),
  ('LAB-MRDT', 2500), ('LAB-FBC', 5000), ('LAB-GLU', 2500), ('LAB-URIN', 2500), ('LAB-HIV', 0),
  ('DEN-EXAM', 5000), ('DEN-FILL', 15000), ('DEN-EXT', 15000), ('DEN-SCAL', 20000),
  ('US-OB', 20000), ('US-ABD', 20000),
  ('NUR-VIT', 0), ('NUR-INJ', 1000), ('NUR-DRESS', 2000),
  ('SUR-SUT', 25000), ('SUR-ABSC', 25000), ('SUR-CIRC', 30000), ('VAC-DOSE', 0),
  ('BED-HOUR', 1000), ('BED-DAY', 10000)
) as v(code, price)
join service s on s.code = v.code
cross join price_list pl
where pl.payer_id is null;

-- RSSB tariff (doc §4.5 worked example: consultation 5,000, malaria RDT 2,000, FBC 4,000)
insert into price_list_item (price_list_id, service_id, price)
select pl.id, s.id, v.price
from (values
  ('REG-CARD', 500), ('CONS-GEN', 5000), ('CONS-FU', 3000), ('CONS-FP', 0),
  ('LAB-MRDT', 2000), ('LAB-FBC', 4000), ('LAB-GLU', 2000), ('LAB-URIN', 2000), ('LAB-HIV', 0),
  ('DEN-EXAM', 4000), ('DEN-FILL', 12000), ('DEN-EXT', 12000), ('DEN-SCAL', 15000),
  ('US-OB', 15000), ('US-ABD', 15000),
  ('NUR-VIT', 0), ('NUR-INJ', 1000), ('NUR-DRESS', 1500),
  ('SUR-SUT', 20000), ('SUR-ABSC', 20000), ('SUR-CIRC', 25000), ('VAC-DOSE', 0),
  ('BED-HOUR', 800), ('BED-DAY', 8000)
) as v(code, price)
join service s on s.code = v.code
join price_list pl on pl.name = 'RSSB tariff 2026';

-- Pharmacy prices per selling unit (cash list; insurers without their own list fall back here)
insert into price_list_item (price_list_id, item_id, price)
select pl.id, i.id, v.price
from (values
  ('AMOX500', 300), ('PARA500', 50), ('AL20120', 500), ('ORS', 300), ('GLOVE-M', 8000), ('MRDT-KIT', 0), ('CEFTRI1G', 2500)
) as v(code, price)
join item i on i.code = v.code
cross join price_list pl
where pl.payer_id is null;

-- ---------------------------------------------------------------- practitioners (public calendars)
insert into practitioner (code, names, title, specialty, slot_minutes, working_hours, categories, languages) values
  ('mb', 'Dr. Mukamana Béatrice', 'General practitioner', 'general', 60,
    '{"1":[["08:00","17:00"]],"2":[["08:00","17:00"]],"3":[["08:00","17:00"]],"4":[["08:00","17:00"]],"5":[["08:00","17:00"]],"6":[["08:00","17:00"]]}',
    '{consultation}', 'KIN · EN · FR'),
  ('hj', 'Dr. Habyarimana Jean Claude', 'General practitioner · minor surgery', 'general', 60,
    '{"0":[["09:00","18:00"]],"2":[["09:00","18:00"]],"3":[["09:00","18:00"]],"4":[["09:00","18:00"]],"5":[["09:00","18:00"]],"6":[["09:00","18:00"]]}',
    '{consultation,surgery,circ}', 'KIN · FR'),
  ('nf', 'Dr. Ndayisaba Félix', 'Dental officer', 'dental', 60,
    '{"1":[["08:00","16:00"]],"2":[["08:00","16:00"]],"3":[["08:00","16:00"]],"4":[["08:00","16:00"]],"5":[["08:00","16:00"]]}',
    '{dental}', 'KIN · EN · FR'),
  ('ua', 'Dr. Uwera Aline', 'Sonographer', 'imaging', 60,
    '{"1":[["08:00","15:00"]],"3":[["08:00","15:00"]],"5":[["08:00","15:00"]],"6":[["08:00","15:00"]]}',
    '{ultrasound}', 'KIN · EN'),
  ('ms', 'Mukarugwiza Solange', 'Midwife · family planning', 'midwifery', 60,
    '{"1":[["08:00","17:00"]],"2":[["08:00","17:00"]],"3":[["08:00","17:00"]],"4":[["08:00","17:00"]],"5":[["08:00","17:00"]],"6":[["08:00","17:00"]]}',
    '{fp,ultrasound}', 'KIN · FR'),
  ('nc', 'Nyirahabimana Chantal', 'Nurse · vaccination & HIV testing', 'nursing', 60,
    '{"0":[["07:00","19:00"]],"1":[["07:00","19:00"]],"2":[["07:00","19:00"]],"3":[["07:00","19:00"]],"4":[["07:00","19:00"]],"5":[["07:00","19:00"]],"6":[["07:00","19:00"]]}',
    '{nursing,hiv}', 'KIN · EN');

-- ---------------------------------------------------------------- stock, beds, supplier
insert into stock_location (name, type) values
  ('Main store', 'main_store'), ('Pharmacy', 'pharmacy'), ('Nursing', 'nursing'), ('Laboratory', 'lab');
insert into supplier (name, terms) values ('Kigali Pharma Wholesale Ltd', '30 days');
insert into bed (name, sort_order) select 'Bed ' || n, n from generate_series(1, 8) as n;

-- Opening stock: one batch of amoxicillin received into the pharmacy (ledger movement, never an edit)
insert into batch (item_id, batch_no, expiry, unit_cost, supplier_id)
select i.id, 'AMX-2605', date '2027-05-31', 180, s.id from item i, supplier s where i.code = 'AMOX500';
insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason)
select b.item_id, b.id, l.id, 1000, 'receipt', 'opening stock'
from batch b join stock_location l on l.name = 'Pharmacy' where b.batch_no = 'AMX-2605';

-- ---------------------------------------------------------------- settings and templates
insert into setting (key, value) values
  ('clinic.profile', '{"name":"Muhazi Medical Clinic","tagline":"Quality care, healthy life.","sector":"Kiramuruzi","district":"Gatsibo","province":"Eastern Province","country":"Rwanda","phone":"0799476752","whatsapp":"0799476752","email":"muhazimedicalclinicltd@gmail.com","tin":"","moh_licence":"","fda_licence":""}'),
  -- days keyed by JS weekday (0 = Sunday), clinic local time
  ('clinic.hours', '{"timezone":"Africa/Kigali","days":{"0":["00:00","24:00"],"1":["00:00","24:00"],"2":["00:00","24:00"],"3":["00:00","24:00"],"4":["00:00","24:00"],"5":["00:00","24:00"],"6":["00:00","24:00"]},"lab":["00:00","24:00"]}'),
  ('numbering', '{"patient_file":"MMC-{seq:6}","invoice":"INV-{year}-{seq:6}","inquiry":"MMC-{year}-{seq:4}","claim_batch":"CLM-{payer}-{year}-{month}"}'),
  ('booking', '{"inquiry_hold_hours":24,"max_weeks_ahead":3,"no_show_grace_min":30}'),
  ('compliance', '{"dpo_name":"","ncsa_registration":"","breach_notice_hours":48,"breach_report_hours":72}');

insert into template (key, language, body) values
  ('appointment.confirmed', 'kin', 'Muhazi Medical Clinic: gahunda yawe yemejwe ku wa {{date}} saa {{time}}. Zana indangamuntu n''ikarita y''ubwishingizi.'),
  ('appointment.confirmed', 'en', 'Muhazi Medical Clinic: your appointment is confirmed for {{date}} at {{time}}. Bring your ID and insurance card.'),
  ('appointment.confirmed', 'fr', 'Muhazi Medical Clinic : votre rendez-vous est confirmé le {{date}} à {{time}}. Apportez votre pièce d''identité et votre carte d''assurance.'),
  ('appointment.reminder', 'kin', 'Muhazi Medical Clinic: urakumbuzwa gahunda yawe ejo ku wa {{date}} saa {{time}}.'),
  ('appointment.reminder', 'en', 'Muhazi Medical Clinic: reminder of your appointment tomorrow {{date}} at {{time}}.'),
  ('appointment.reminder', 'fr', 'Muhazi Medical Clinic : rappel de votre rendez-vous demain {{date}} à {{time}}.'),
  ('results.ready', 'kin', 'Muhazi Medical Clinic: ibisubizo byawe byiteguye. Mwaza kubifata cyangwa mukavugana na muganga wanyu.'),
  ('results.ready', 'en', 'Muhazi Medical Clinic: your results are ready. Please come to collect them or speak to your doctor.'),
  ('results.ready', 'fr', 'Muhazi Medical Clinic : vos résultats sont prêts. Passez les retirer ou parlez à votre médecin.');

