-- Muhazi Medical Clinic System — all migrations + seed, generated 2026-10-21T09:39:37.108Z
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


-- ============================================================ 20261017120000_staff_identity_triage.sql
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


-- ============================================================ 20261017150000_login_requests.sql
-- Muhazi Medical Clinic System — 0012 PIN-gated sign-in codes
-- The `staff-otp` Edge Function verifies the PIN on the server and records a login request;
-- the `send-auth-email` hook only e-mails a code when a fresh, unconsumed request exists for
-- that user. Service role only: no policies, so neither anon nor authenticated can read it.

create table login_request (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  email text not null,
  requested_at timestamptz not null default now(),
  consumed_at timestamptz,
  client text
);
create index login_request_user_idx on login_request (user_id, requested_at desc);
comment on table login_request is 'PIN verified → code may be sent. Written and read by Edge Functions with the service role only.';

alter table login_request enable row level security;
revoke all on login_request from anon, authenticated;


-- ============================================================ 20261017160000_manager_all_permissions.sql
-- Muhazi Medical Clinic System — 0013 the manager can do everything
-- The clinic manager runs the whole clinic: registration, triage, consultation, orders,
-- prescriptions, dispensing, billing, stock, settings. Every permission any role holds is
-- granted to the manager, except `sensitive.*` (HIV testing, doc §2.3): that stays with the
-- nurses and doctors who perform the test, and the manager may be given it explicitly later.

insert into role_permissions (role, permission)
select 'manager', p.permission
from (select distinct permission from role_permissions) p
where p.permission not like 'sensitive.%'
on conflict do nothing;

-- Settings the manager edits from the Clinic settings screen (profile, opening hours).
-- `setting` already has RLS: settings.read / settings.write (manager only for writes).
create or replace function save_setting(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_key not in ('clinic.profile', 'clinic.hours', 'clinic.features') then
    raise exception 'unknown setting %', p_key using errcode = '22023';
  end if;
  insert into setting (key, value, changed_by, changed_at)
  values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, changed_by = auth.uid(), changed_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'setting', null, jsonb_build_object('key', p_key));
end
$$;
grant execute on function save_setting(text, jsonb) to authenticated;
revoke execute on function save_setting(text, jsonb) from anon;


-- ============================================================ 20261017180000_treatments_discounts_coverage.sql
-- Muhazi Medical Clinic System — 0014 treatments, discounts, insurers and coverage
-- The manager maintains the treatment catalogue (what the clinic treats and the price), the
-- discount a clinician may give per treatment, the insurers the clinic works with and what
-- each one covers. A clinician adds a treatment to the visit with an optional discount and
-- sees the patient / insurer split at once.

-- ---------------------------------------------------------------- catalogue columns
alter table service
  add column max_discount_pct numeric(5, 2) not null default 0 check (max_discount_pct between 0 and 100);
comment on column service.max_discount_pct is 'Largest discount a clinician may give on this treatment without the manager.';

alter table invoice_line
  add column list_price numeric(12, 0),
  add column discount_pct numeric(5, 2) not null default 0 check (discount_pct between 0 and 100),
  add column discount_reason text;
update invoice_line set list_price = unit_price where list_price is null;

-- ---------------------------------------------------------------- add_charge with a discount
drop function if exists add_charge(uuid, station, uuid, uuid, numeric, numeric, text, uuid, uuid, text, uuid);
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
  p_source_id uuid default null,
  p_discount_pct numeric default 0,
  p_discount_reason text default null
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
  v_unit numeric;
  v_fallback boolean;
  v_pct numeric := 0;
  v_origin price_origin := 'preset';
  v_line_total numeric;
  v_insurer numeric;
  v_line_id uuid;
  v_allow_manual boolean := false;
  v_max_discount numeric := 0;
  v_discount numeric := coalesce(p_discount_pct, 0);
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
    select s.name_en, s.service_group, s.allow_manual_price, s.max_discount_pct
    into v_desc, v_group, v_allow_manual, v_max_discount
    from service s where s.id = p_service_id and s.active;
  else
    select i.name_generic || coalesce(' ' || i.strength, ''), 'pharmacy'::service_group, false, 0
    into v_desc, v_group, v_allow_manual, v_max_discount
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

  -- Discount: within the treatment's allowance, or the manager; always with a reason.
  if v_discount < 0 or v_discount > 100 then
    raise exception 'discount must be between 0 and 100 %%' using errcode = '22023';
  end if;
  if v_discount > 0 then
    if v_discount > v_max_discount and not is_manager() then
      raise exception 'the discount on this treatment may not exceed %%%', v_max_discount using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_discount_reason, '')), '') is null then
      raise exception 'a reason is required for a discount' using errcode = '22023';
    end if;
  end if;
  v_unit := round(v_price * (100 - v_discount) / 100);

  select c.plan_id into v_plan from coverage c where c.id = v_invoice.coverage_id;
  v_pct := coalesce(coverage_pct_for(v_plan, v_group), 0);
  v_line_total := round(v_unit * p_quantity);
  v_insurer := round(v_line_total * v_pct / 100);

  insert into invoice_line (
    invoice_id, service_id, item_id, description, quantity, unit_price, list_price, discount_pct,
    discount_reason, coverage_pct, patient_share, insurer_share, office, performed_by, entered_for,
    source_type, source_id, price_origin, manual_reason
  ) values (
    v_invoice.id, p_service_id, p_item_id, v_desc, p_quantity, v_unit, v_price, v_discount,
    nullif(trim(coalesce(p_discount_reason, '')), ''), v_pct, v_line_total - v_insurer, v_insurer,
    p_office, coalesce(p_performed_by, auth.uid()), p_entered_for, p_source_type, p_source_id,
    v_origin, p_manual_reason
  ) returning id into v_line_id;

  perform recompute_invoice(v_invoice.id);
  return v_line_id;
end
$$;

-- Remove a charge from a draft bill (kept as a soft delete for the audit trail).
create or replace function void_charge(p_line_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice uuid;
begin
  if not has_perm('charge.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  update invoice_line l set deleted_at = now(), manual_reason = coalesce(l.manual_reason || ' · ', '') || 'removed: ' || trim(p_reason)
  from invoice i
  where l.id = p_line_id and i.id = l.invoice_id and i.status = 'draft' and l.deleted_at is null
  returning l.invoice_id into v_invoice;
  if v_invoice is null then
    raise exception 'charge not found or bill already posted' using errcode = 'P0002';
  end if;
  perform recompute_invoice(v_invoice);
end
$$;

-- ---------------------------------------------------------------- who pays for this visit
-- Cash, or one of the insurers the clinic works with; re-splits every charge already on the bill.
create or replace function set_visit_payer(p_encounter_id uuid, p_payer_id uuid, p_member_number text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice invoice%rowtype;
  v_patient uuid;
  v_plan uuid;
  v_coverage uuid;
  v_type payer_type;
begin
  if not (has_perm('charge.write') or has_perm('billing.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_invoice from invoice where encounter_id = p_encounter_id;
  if not found or v_invoice.status <> 'draft' then
    raise exception 'no open bill for this visit' using errcode = 'P0002';
  end if;
  select patient_id into v_patient from encounter where id = p_encounter_id;

  if p_payer_id is not null then
    select type into v_type from payer where id = p_payer_id and active and deleted_at is null;
    if v_type is null then
      raise exception 'unknown or inactive insurer' using errcode = '22023';
    end if;
  end if;

  if p_payer_id is null or v_type = 'cash' then
    update encounter set coverage_id = null where id = p_encounter_id;
    update invoice set payer_id = null, coverage_id = null where id = v_invoice.id;
    update invoice_line set coverage_pct = 0, insurer_share = 0, patient_share = round(unit_price * quantity)
    where invoice_id = v_invoice.id and deleted_at is null;
  else
    select id into v_plan from plan where payer_id = p_payer_id and active and deleted_at is null
    order by created_at limit 1;
    select id into v_coverage from coverage
    where patient_id = v_patient and payer_id = p_payer_id and active and deleted_at is null
    order by created_at desc limit 1;
    if v_coverage is null then
      insert into coverage (patient_id, payer_id, plan_id, member_number)
      values (v_patient, p_payer_id, v_plan, nullif(trim(coalesce(p_member_number, '')), ''))
      returning id into v_coverage;
    elsif p_member_number is not null then
      update coverage set member_number = nullif(trim(p_member_number), ''), plan_id = coalesce(plan_id, v_plan) where id = v_coverage;
    end if;
    select plan_id into v_plan from coverage where id = v_coverage;
    update encounter set coverage_id = v_coverage where id = p_encounter_id;
    update invoice set payer_id = p_payer_id, coverage_id = v_coverage where id = v_invoice.id;
    update invoice_line l
    set coverage_pct = g.pct,
        insurer_share = round(round(l.unit_price * l.quantity) * g.pct / 100),
        patient_share = round(l.unit_price * l.quantity) - round(round(l.unit_price * l.quantity) * g.pct / 100)
    from (
      select l2.id, coalesce(coverage_pct_for(v_plan, coalesce(s.service_group, 'pharmacy'::service_group)), 0) as pct
      from invoice_line l2 left join service s on s.id = l2.service_id
      where l2.invoice_id = v_invoice.id and l2.deleted_at is null
    ) g
    where l.id = g.id;
  end if;
  perform recompute_invoice(v_invoice.id);
end
$$;

-- Station done: close this station's queue entry and send the patient on (cashier by default).
create or replace function finish_station(p_encounter_id uuid, p_station station, p_next station default 'cashier')
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = p_station and finished_at is null;
  if p_next is not null then
    select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
    if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = p_next and finished_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no) values (p_encounter_id, p_next, coalesce(v_ticket, 'A-000'));
    end if;
  end if;
end
$$;

-- ---------------------------------------------------------------- manager: treatments and prices
-- Create or update a treatment and its cash price in one call.
create or replace function upsert_service(
  p_id uuid,
  p_name_en text,
  p_group service_group,
  p_cash_price numeric,
  p_name_kin text default null,
  p_name_fr text default null,
  p_max_discount_pct numeric default 0,
  p_allow_manual boolean default false,
  p_active boolean default true,
  p_code text default null,
  p_booking_category text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_list uuid;
  v_code text := nullif(upper(trim(coalesce(p_code, ''))), '');
  v_cat text := nullif(trim(coalesce(p_booking_category, '')), '');
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name_en, ''))) < 2 then
    raise exception 'the treatment needs a name' using errcode = '22023';
  end if;
  if p_cash_price is null or p_cash_price < 0 then
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  if v_id is null then
    if v_code is null then
      v_code := 'TRT-' || lpad(next_number('service_code', 0)::text, 4, '0');
    end if;
    insert into service (code, name_en, name_kin, name_fr, service_group, allow_manual_price, max_discount_pct, active, booking_category)
    values (v_code, trim(p_name_en), nullif(trim(coalesce(p_name_kin, '')), ''), nullif(trim(coalesce(p_name_fr, '')), ''),
            p_group, p_allow_manual, coalesce(p_max_discount_pct, 0), p_active, v_cat)
    returning id into v_id;
  else
    update service
    set name_en = trim(p_name_en), name_kin = nullif(trim(coalesce(p_name_kin, '')), ''),
        name_fr = nullif(trim(coalesce(p_name_fr, '')), ''), service_group = p_group,
        allow_manual_price = p_allow_manual, max_discount_pct = coalesce(p_max_discount_pct, 0), active = p_active,
        code = coalesce(v_code, code), booking_category = v_cat
    where id = v_id;
    if not found then
      raise exception 'treatment not found' using errcode = 'P0002';
    end if;
  end if;

  select id into v_list from price_list
  where payer_id is null and deleted_at is null and effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
  order by effective_from desc limit 1;
  if v_list is null then
    insert into price_list (payer_id, name, effective_from) values (null, 'Cash prices', current_date) returning id into v_list;
  end if;
  insert into price_list_item (price_list_id, service_id, price) values (v_list, v_id, round(p_cash_price))
  on conflict (price_list_id, service_id) where service_id is not null
  do update set price = excluded.price, deleted_at = null;
  return v_id;
end
$$;

-- Insurer-specific price for a treatment (empty price = fall back to the cash price).
create or replace function set_service_price(p_service_id uuid, p_payer_id uuid, p_price numeric)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_list uuid;
  v_name text;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select id into v_list from price_list
  where payer_id = p_payer_id and deleted_at is null and effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
  order by effective_from desc limit 1;
  if v_list is null then
    select name into v_name from payer where id = p_payer_id;
    insert into price_list (payer_id, name, effective_from) values (p_payer_id, coalesce(v_name, 'Insurer') || ' tariff', current_date)
    returning id into v_list;
  end if;
  if p_price is null then
    update price_list_item set deleted_at = now() where price_list_id = v_list and service_id = p_service_id and deleted_at is null;
  else
    insert into price_list_item (price_list_id, service_id, price) values (v_list, p_service_id, round(p_price))
    on conflict (price_list_id, service_id) where service_id is not null
    do update set price = excluded.price, deleted_at = null;
  end if;
end
$$;

-- ---------------------------------------------------------------- manager: insurers and coverage
-- Create or update an insurer and its standard plan (overall % and per-group overrides such as
-- {"dental": 50}). Activating an insurer makes it selectable on a visit.
create or replace function upsert_payer(
  p_id uuid,
  p_name text,
  p_type payer_type,
  p_coverage_pct numeric,
  p_pct_by_group jsonb default '{}'::jsonb,
  p_active boolean default true,
  p_code text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_code text := nullif(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), '');
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_type = 'cash' then
    raise exception 'cash is not an insurer' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'the insurer needs a name' using errcode = '22023';
  end if;
  if p_coverage_pct is null or p_coverage_pct < 0 or p_coverage_pct > 100 then
    raise exception 'coverage must be between 0 and 100 %%' using errcode = '22023';
  end if;
  if v_id is null then
    if v_code is null then
      v_code := upper(regexp_replace(p_name, '[^A-Za-z0-9]', '', 'g'));
    end if;
    insert into payer (code, name, type, active) values (v_code, trim(p_name), p_type, p_active) returning id into v_id;
    insert into plan (payer_id, name, coverage_pct, pct_by_group) values (v_id, 'Standard', p_coverage_pct, coalesce(p_pct_by_group, '{}'::jsonb));
  else
    update payer set name = trim(p_name), type = p_type, active = p_active, code = coalesce(v_code, code) where id = v_id;
    if not found then
      raise exception 'insurer not found' using errcode = 'P0002';
    end if;
    update plan set coverage_pct = p_coverage_pct, pct_by_group = coalesce(p_pct_by_group, '{}'::jsonb)
    where payer_id = v_id and active and deleted_at is null;
    if not found then
      insert into plan (payer_id, name, coverage_pct, pct_by_group) values (v_id, 'Standard', p_coverage_pct, coalesce(p_pct_by_group, '{}'::jsonb));
    end if;
  end if;
  return v_id;
end
$$;

-- ---------------------------------------------------------------- read models
create or replace view catalogue_services with (security_invoker = true) as
  select s.id, s.code, s.name_en, s.name_kin, s.name_fr, s.service_group, s.allow_manual_price,
         s.max_discount_pct, s.active, s.default_duration_min, s.booking_category,
         (select pf.price from price_for(s.id, null, null) pf) as cash_price,
         coalesce((
           select jsonb_object_agg(pl.payer_id::text, pli.price)
           from price_list pl
           join price_list_item pli on pli.price_list_id = pl.id
           where pl.payer_id is not null and pli.service_id = s.id
             and pl.deleted_at is null and pli.deleted_at is null
             and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
         ), '{}'::jsonb) as payer_prices
  from service s
  where s.deleted_at is null;

create or replace view insurer_plans with (security_invoker = true) as
  select p.id, p.code, p.name, p.type, p.active, pl.id as plan_id, pl.coverage_pct, pl.pct_by_group
  from payer p
  left join plan pl on pl.payer_id = p.id and pl.active and pl.deleted_at is null
  where p.deleted_at is null and p.type <> 'cash';

create or replace view visit_bill with (security_invoker = true) as
  select i.id as invoice_id, i.encounter_id, i.status, i.payer_id, py.name as payer_name,
         i.total, i.patient_share, i.insurer_share, i.number
  from invoice i
  left join payer py on py.id = i.payer_id;

create or replace view visit_charges with (security_invoker = true) as
  select l.id, l.invoice_id, i.encounter_id, l.description, l.quantity, l.unit_price, l.list_price,
         l.discount_pct, l.discount_reason, l.coverage_pct, l.patient_share, l.insurer_share,
         l.office, l.price_origin, l.created_at, l.entered_by, p.full_name as entered_by_name
  from invoice_line l
  join invoice i on i.id = l.invoice_id
  left join profiles p on p.id = l.entered_by
  where l.deleted_at is null;

revoke all on catalogue_services, insurer_plans, visit_bill, visit_charges from anon;
grant select on catalogue_services, insurer_plans, visit_bill, visit_charges to authenticated;
grant execute on function
  add_charge(uuid, station, uuid, uuid, numeric, numeric, text, uuid, uuid, text, uuid, numeric, text),
  void_charge(uuid, text), set_visit_payer(uuid, uuid, text), finish_station(uuid, station, station),
  upsert_service(uuid, text, service_group, numeric, text, text, numeric, boolean, boolean, text, text),
  set_service_price(uuid, uuid, numeric),
  upsert_payer(uuid, text, payer_type, numeric, jsonb, boolean, text) to authenticated;
revoke execute on function
  add_charge(uuid, station, uuid, uuid, numeric, numeric, text, uuid, uuid, text, uuid, numeric, text),
  void_charge(uuid, text), set_visit_payer(uuid, uuid, text), finish_station(uuid, station, station),
  upsert_service(uuid, text, service_group, numeric, text, text, numeric, boolean, boolean, text, text),
  set_service_price(uuid, uuid, numeric),
  upsert_payer(uuid, text, payer_type, numeric, jsonb, boolean, text) from anon;


-- ============================================================ 20261017200000_dashboard_home_payments.sql
-- Muhazi Medical Clinic System — 0015 live dashboard, live home panels, cashier payments
-- Every number on the manager dashboard and on the role home screens comes from the database.
-- Money is only returned to managers; heads of station get the same JSON with money nulled.

-- ---------------------------------------------------------------- cashier: take a payment
-- Records a payment against the visit's bill and posts the bill once the patient share is paid.
create or replace function take_payment(
  p_encounter_id uuid,
  p_method payment_method,
  p_amount numeric,
  p_reference text default null,
  p_payer_phone text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice invoice%rowtype;
  v_balance numeric;
  v_number text;
begin
  if not has_perm('billing.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'the amount must be more than zero' using errcode = '22023';
  end if;
  perform recompute_invoice((select id from invoice where encounter_id = p_encounter_id));
  select * into v_invoice from invoice where encounter_id = p_encounter_id;
  if not found then
    raise exception 'no bill for this visit' using errcode = 'P0002';
  end if;
  if v_invoice.status = 'credited' then
    raise exception 'this bill was credited' using errcode = '23514';
  end if;
  v_balance := invoice_balance(v_invoice.id);
  if p_amount > v_balance + 0.5 then
    raise exception 'the amount exceeds the balance due (%)', v_balance using errcode = '22023';
  end if;
  perform record_payment(v_invoice.id, p_method, p_amount, p_reference, p_payer_phone);
  v_balance := invoice_balance(v_invoice.id);
  if v_balance <= 0 and v_invoice.status = 'draft' then
    v_number := post_invoice(v_invoice.id);
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = 'cashier' and finished_at is null;
  else
    select number into v_number from invoice where id = v_invoice.id;
  end if;
  return jsonb_build_object('balance', v_balance, 'number', v_number,
                            'status', (select status from invoice where id = v_invoice.id));
end
$$;

-- The visit bill now carries the balance the patient still owes.
create or replace view visit_bill with (security_invoker = true) as
  select i.id as invoice_id, i.encounter_id, i.status, i.payer_id, py.name as payer_name,
         i.total, i.patient_share, i.insurer_share, i.number,
         invoice_balance(i.id) as balance,
         (select coalesce(sum(p.amount), 0) from payment p where p.invoice_id = i.id and p.deleted_at is null) as paid
  from invoice i
  left join payer py on py.id = i.payer_id;

-- Approve a public inquiry: with the patient file, or by matching the phone to one file.
create or replace function approve_inquiry_auto(p_appointment_id uuid, p_patient_id uuid default null)
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
    select count(*), min(id) into v_matches, v_patient from patient
    where deleted_at is null and merged_into is null
      and regexp_replace(coalesce(phone_1, ''), '[^0-9]', '', 'g') = regexp_replace(v_phone, '[^0-9]', '', 'g');
    if v_matches <> 1 then
      raise exception 'register the patient first (no single file matches phone %)', v_phone using errcode = 'P0002';
    end if;
  end if;
  perform approve_inquiry(p_appointment_id, v_patient);
  return v_patient;
end
$$;

-- ---------------------------------------------------------------- role home panels
create or replace function home_summary()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_role role_key := current_role_key();
  v_practitioner uuid := (select id from practitioner where user_id = auth.uid() and active limit 1);
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_appts jsonb;
  v_inquiries jsonb;
  v_mine jsonb;
  v_to_accept jsonb;
  v_bills jsonb;
  v_paid jsonb;
  v_beds jsonb;
  v_tasks jsonb;
  v_results jsonb;
begin
  if v_role is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- today's booked patients (reception, doctors)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'time', to_char(a.starts_at at time zone 'Africa/Kigali', 'HH24:MI'),
      'name', coalesce(p.surname || ' ' || p.given_names, a.contact_name),
      'doctor', coalesce(pr.names, ''), 'station', coalesce(a.category, ''),
      'status', case when a.status in ('arrived', 'in_progress', 'completed') then 'arrived'
                     when a.starts_at < now() then 'late' else 'due' end,
      'mine', (a.practitioner_id = v_practitioner)
    ) order by a.starts_at), '[]'::jsonb) into v_appts
  from appointment a
  left join patient p on p.id = a.patient_id
  left join practitioner pr on pr.id = a.practitioner_id
  where a.deleted_at is null and a.status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed')
    and (a.starts_at at time zone 'Africa/Kigali')::date = v_today;

  -- public inquiries waiting for reception
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'name', a.contact_name, 'phone', a.contact_phone, 'reference', a.reference,
      'category', a.category, 'doctor', pr.names, 'channel', a.contact_channel,
      'when', case when a.starts_at is null then null else to_char(a.starts_at at time zone 'Africa/Kigali', 'DD/MM HH24:MI') end,
      'note', a.reason
    ) order by a.created_at), '[]'::jsonb) into v_inquiries
  from appointment a
  left join practitioner pr on pr.id = a.practitioner_id
  where a.deleted_at is null and a.status = 'inquiry';

  -- approved bookings this practitioner still has to accept
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'name', coalesce(p.surname || ' ' || p.given_names, a.contact_name),
      'when', to_char(a.starts_at at time zone 'Africa/Kigali', 'DD/MM HH24:MI'), 'note', a.reason
    ) order by a.starts_at), '[]'::jsonb) into v_to_accept
  from appointment a
  left join patient p on p.id = a.patient_id
  where a.deleted_at is null and a.status = 'approved' and a.practitioner_id = v_practitioner;

  -- open bills: visits with something charged and a patient balance (cashier)
  select coalesce(jsonb_agg(jsonb_build_object(
      'encounterId', i.encounter_id, 'name', p.surname || ' ' || p.given_names, 'file', p.file_number,
      'ticket', (select ticket_no from queue_entry q where q.encounter_id = i.encounter_id order by q.created_at limit 1),
      'station', (select station from queue_entry q where q.encounter_id = i.encounter_id and q.finished_at is null order by q.created_at desc limit 1),
      'amount', i.patient_share, 'balance', invoice_balance(i.id), 'status', i.status
    ) order by i.updated_at desc), '[]'::jsonb) into v_bills
  from invoice i
  join encounter e on e.id = i.encounter_id
  join patient p on p.id = e.patient_id
  where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0;

  select jsonb_build_object('count', count(*), 'amount', coalesce(sum(amount), 0)) into v_paid
  from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date = v_today;

  -- beds
  select coalesce(jsonb_agg(jsonb_build_object(
      'n', b.sort_order, 'name', b.name, 'state', b.status,
      'who', (select p.surname || ' ' || left(p.given_names, 1) || '.' from bed_stay s join encounter e on e.id = s.encounter_id join patient p on p.id = e.patient_id
              where s.bed_id = b.id and s.discharged_at is null limit 1)
    ) order by b.sort_order, b.name), '[]'::jsonb) into v_beds
  from bed b where b.deleted_at is null;

  -- tasks for my role or me
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', k.id, 'time', to_char(k.due_at at time zone 'Africa/Kigali', 'HH24:MI'), 'title', k.title,
      'detail', coalesce(k.detail, ''), 'overdue', (k.due_at < now()),
      'patient', (select p.surname || ' ' || p.given_names from patient p where p.id = k.patient_id)
    ) order by k.due_at), '[]'::jsonb) into v_tasks
  from internal_task k
  where k.deleted_at is null and k.done_at is null and (k.assigned_to = auth.uid() or k.assigned_role = v_role);

  -- lab / imaging results of the last two days (doctors)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'encounterId', sr.encounter_id, 'test', s.name_en,
      'name', p.surname || ' ' || p.given_names, 'impression', coalesce(r.impression, r.findings, ''),
      'verified', (r.verified_at is not null), 'at', to_char(r.updated_at at time zone 'Africa/Kigali', 'HH24:MI')
    ) order by r.updated_at desc), '[]'::jsonb) into v_results
  from diagnostic_report r
  join service_request sr on sr.id = r.service_request_id
  join service s on s.id = sr.service_id
  join encounter e on e.id = sr.encounter_id
  join patient p on p.id = e.patient_id
  where r.deleted_at is null and r.updated_at > now() - interval '2 days'
    and (v_practitioner is null or e.practitioner_id = v_practitioner or e.practitioner_id is null);

  return jsonb_build_object(
    'role', v_role,
    'appointments', v_appts,
    'inquiries', v_inquiries,
    'toAccept', v_to_accept,
    'openBills', v_bills,
    'paidToday', v_paid,
    'beds', v_beds,
    'tasks', v_tasks,
    'results', v_results
  );
end
$$;

-- ---------------------------------------------------------------- manager dashboard
create or replace function dashboard_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := is_manager();
  v_days integer := greatest(1, p_to - p_from + 1);
  v_prev_from date := p_from - v_days;
  v_prev_to date := p_from - 1;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_tiles jsonb;
  v_rev30 jsonb;
  v_collections jsonb;
  v_receivables jsonb;
  v_visits jsonb;
  v_wait jsonb;
  v_queue jsonb;
  v_top jsonb;
  v_staff jsonb;
  v_reorder jsonb;
  v_expiring jsonb;
  v_noshow jsonb;
  v_messages jsonb;
  v_claims jsonb;
  v_logins jsonb;
  v_services jsonb;
begin
  if not (v_manager or exists (select 1 from profiles where id = auth.uid() and active and dashboard is not null)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  -- headline tiles
  select jsonb_build_object(
    'registered', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'registeredPrev', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'visits', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'visitsPrev', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'waitingNow', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'),
    'avgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at, now()) - q.created_at) / 60)), 0)
                   from queue_entry q where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'revenue', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to) end,
    'revenuePrev', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to) end,
    'openBills', case when v_manager then (select count(*) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'openBillsDue', case when v_manager then (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'bedsOccupied', (select count(*) from bed where deleted_at is null and status = 'occupied'),
    'bedsTotal', (select count(*) from bed where deleted_at is null and status <> 'out_of_service')
  ) into v_tiles;

  -- revenue per day, last 30 days ending today
  select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'amount', coalesce(s.amount, 0)) order by d), '[]'::jsonb) into v_rev30
  from generate_series(v_today - 29, v_today, interval '1 day') d
  left join (
    select (paid_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
    from payment where deleted_at is null and paid_at >= (v_today - 29)::timestamp
    group by 1
  ) s on s.day = d::date;

  select coalesce(jsonb_agg(jsonb_build_object('method', m, 'amount', coalesce(s.amount, 0)) order by s.amount desc nulls last), '[]'::jsonb) into v_collections
  from unnest(array['cash', 'momo', 'airtel', 'card', 'bank']::payment_method[]) m
  left join (
    select method, sum(amount) as amount from payment
    where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by method
  ) s on s.method = m;

  select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'count', c.n, 'amount', c.amount) order by c.amount desc), '[]'::jsonb) into v_receivables
  from (
    select payer_id, count(*) as n, sum(amount) as amount from claim
    where deleted_at is null and status in ('open', 'batched', 'submitted', 'rejected', 'resubmitted')
    group by payer_id
  ) c join payer py on py.id = c.payer_id;

  -- visits by service group (charged lines in the range)
  select coalesce(jsonb_agg(jsonb_build_object('group', g.grp, 'count', g.n) order by g.n desc), '[]'::jsonb) into v_visits
  from (
    select coalesce(s.service_group::text, 'pharmacy') as grp, count(distinct i.encounter_id) as n
    from invoice_line l
    join invoice i on i.id = l.invoice_id
    left join service s on s.id = l.service_id
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by 1
  ) g;

  -- waiting time and queue by station (today)
  select coalesce(jsonb_agg(jsonb_build_object('station', w.station, 'minutes', w.minutes, 'waiting', w.waiting) order by w.station), '[]'::jsonb) into v_wait
  from (
    select q.station::text as station,
           round(avg(extract(epoch from coalesce(q.started_at, q.finished_at, now()) - q.created_at) / 60)) as minutes,
           count(*) filter (where q.finished_at is null and q.started_at is null) as waiting
    from queue_entry q
    where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date = v_today
    group by q.station
  ) w;

  -- top treatments in the range
  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'count', x.n, 'amount', case when v_manager then x.amount end) order by x.n desc), '[]'::jsonb) into v_top
  from (
    select l.description as name, count(*) as n, sum(round(l.unit_price * l.quantity)) as amount
    from invoice_line l
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by l.description
    order by count(*) desc
    limit 10
  ) x;

  -- who did what (accountability)
  select coalesce(jsonb_agg(jsonb_build_object(
      'name', p.full_name, 'role', p.role, 'staffId', p.staff_id,
      'registrations', coalesce(r.n, 0), 'vitals', coalesce(v.n, 0), 'charges', coalesce(c.n, 0),
      'payments', case when v_manager then coalesce(pm.n, 0) end,
      'collected', case when v_manager then coalesce(pm.amount, 0) end,
      'lastSignIn', p.last_sign_in_at
    ) order by (coalesce(r.n, 0) + coalesce(v.n, 0) + coalesce(c.n, 0) + coalesce(pm.n, 0)) desc, p.full_name), '[]'::jsonb) into v_staff
  from profiles p
  left join (select created_by as id, count(*) as n from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) r on r.id = p.id
  left join (select performer_id as id, count(distinct encounter_id) as n from observation where deleted_at is null and (effective_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) v on v.id = p.id
  left join (select entered_by as id, count(*) as n from invoice_line where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) c on c.id = p.id
  left join (select cashier_id as id, count(*) as n, sum(amount) as amount from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) pm on pm.id = p.id
  where p.active;

  -- stock
  select coalesce(jsonb_agg(jsonb_build_object('name', name_generic, 'onHand', on_hand, 'min', reorder_level) order by (on_hand::numeric / greatest(reorder_level, 1))), '[]'::jsonb) into v_reorder
  from items_below_reorder where on_hand < reorder_level;

  select jsonb_build_object(
    'd30', count(*) filter (where s.expiry <= v_today + 30),
    'd60', count(*) filter (where s.expiry > v_today + 30 and s.expiry <= v_today + 60),
    'd90', count(*) filter (where s.expiry > v_today + 60 and s.expiry <= v_today + 90)
  ) into v_expiring
  from (select batch_id, expiry, sum(quantity) as q from stock_on_hand where expiry is not null group by batch_id, expiry) s
  where s.q > 0;

  -- bookings
  select jsonb_build_object(
    'booked', count(*) filter (where status in ('confirmed', 'arrived', 'in_progress', 'completed', 'no_show')),
    'missed', count(*) filter (where status = 'no_show'),
    'pending', count(*) filter (where status = 'inquiry')
  ) into v_noshow
  from appointment where deleted_at is null and (coalesce(starts_at, created_at) at time zone 'Africa/Kigali')::date between p_from and p_to;

  select coalesce(jsonb_agg(jsonb_build_object('channel', ch, 'sent', coalesce(s.sent, 0), 'failed', coalesce(s.failed, 0)) order by ch), '[]'::jsonb) into v_messages
  from unnest(array['whatsapp', 'sms', 'email']::message_channel[]) ch
  left join (
    select channel, count(*) filter (where status in ('sent', 'delivered')) as sent, count(*) filter (where status = 'failed') as failed
    from message where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by channel
  ) s on s.channel = ch;

  select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'count', c.n, 'amount', case when v_manager then c.amount end) order by c.amount desc), '[]'::jsonb) into v_claims
  from (select payer_id, count(*) as n, sum(amount) as amount from claim where deleted_at is null and status = 'open' group by payer_id) c
  join payer py on py.id = c.payer_id;

  select coalesce(jsonb_agg(jsonb_build_object('name', p.full_name, 'role', p.role, 'at', a.at, 'reason', a.reason) order by a.at desc), '[]'::jsonb) into v_logins
  from (select actor_id, at, reason from audit_event where action = 'login' and at > now() - interval '1 day' order by at desc limit 12) a
  join profiles p on p.id = a.actor_id;

  select jsonb_build_object('active', count(*) filter (where active), 'total', count(*)) into v_services from service where deleted_at is null;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'manager', v_manager, 'generatedAt', now(),
    'tiles', v_tiles, 'revenue30d', v_rev30, 'collections', v_collections, 'receivables', v_receivables,
    'visitsByGroup', v_visits, 'waitByStation', v_wait, 'topTreatments', v_top, 'staff', v_staff,
    'reorder', v_reorder, 'expiring', v_expiring, 'bookings', v_noshow, 'messages', v_messages,
    'claims', v_claims, 'logins', v_logins, 'services', v_services
  );
end
$$;

grant execute on function take_payment(uuid, payment_method, numeric, text, text), approve_inquiry_auto(uuid, uuid),
  home_summary(), dashboard_summary(date, date) to authenticated;
revoke execute on function take_payment(uuid, payment_method, numeric, text, text), approve_inquiry_auto(uuid, uuid),
  home_summary(), dashboard_summary(date, date) from anon;


-- ============================================================ 20261017220000_patient_file_clinical.sql
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


-- ============================================================ 20261018090000_patient_custom_fields.sql
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


-- ============================================================ 20261019090000_catalogue_ops_security.sql
-- 0018 · Catalogue operations, screen-lock setting, settings allowlist.
--
-- * save_setting accepts `patient.fields` (customizable patient file, 0017) and
--   `security.lock` ({ idle_minutes }), the inactivity time before a staff screen locks.
-- * staff_settings(): the non-secret settings every signed-in staff member needs, readable
--   without settings.read (the lock time is enforced in every browser).
-- * delete_service / delete_payer: soft delete (deleted_at + inactive). Old bills keep their
--   lines and history; the treatment or insurer disappears from every list.
-- * adjust_prices: raise or lower the cash price of every treatment (or one group) at once —
--   by a multiplier (× 1.1), a percentage (+10 %) or an amount (+500 RWF), rounded.

create or replace function save_setting(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_key not in ('clinic.profile', 'clinic.hours', 'clinic.features', 'patient.fields', 'security.lock') then
    raise exception 'unknown setting %', p_key using errcode = '22023';
  end if;
  if p_key = 'security.lock' then
    if jsonb_typeof(p_value -> 'idle_minutes') <> 'number'
       or (p_value ->> 'idle_minutes')::numeric < 1
       or (p_value ->> 'idle_minutes')::numeric > 480 then
      raise exception 'idle_minutes must be between 1 and 480' using errcode = '22023';
    end if;
  end if;
  if p_key = 'patient.fields' and jsonb_typeof(p_value) <> 'array' then
    raise exception 'patient.fields must be a list' using errcode = '22023';
  end if;
  insert into setting (key, value, changed_by, changed_at)
  values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, changed_by = auth.uid(), changed_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'setting', null, jsonb_build_object('key', p_key));
end
$$;

create or replace function staff_settings()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'idle_minutes', coalesce(((select value from setting where key = 'security.lock') ->> 'idle_minutes')::int, 15)
  )
$$;

-- ---------------------------------------------------------------- delete (soft)
create or replace function delete_service(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update service set deleted_at = now(), active = false where id = p_id and deleted_at is null;
  if not found then
    raise exception 'treatment not found' using errcode = 'P0002';
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'delete', 'service', p_id, null);
end
$$;

create or replace function delete_payer(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from payer where id = p_id and type = 'cash') then
    raise exception 'cash cannot be deleted' using errcode = '22023';
  end if;
  if exists (select 1 from invoice where payer_id = p_id and status = 'draft' and deleted_at is null) then
    raise exception 'this insurer is on an open bill; finish or change those visits first' using errcode = '23503';
  end if;
  update payer set deleted_at = now(), active = false where id = p_id and deleted_at is null;
  if not found then
    raise exception 'insurer not found' using errcode = 'P0002';
  end if;
  update plan set active = false where payer_id = p_id;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'delete', 'payer', p_id, null);
end
$$;

-- ---------------------------------------------------------------- bulk price change
-- p_mode: 'multiply' (p_value = 1.1), 'percent' (p_value = 10 or -5), 'amount' (p_value = 500).
-- p_round: round the new price to this many RWF (1 = no rounding). Returns how many changed.
create or replace function adjust_prices(
  p_group service_group default null,
  p_mode text default 'multiply',
  p_value numeric default 1,
  p_round integer default 100
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_list uuid;
  v_count integer := 0;
  v_step integer := greatest(coalesce(p_round, 1), 1);
  r record;
  v_new numeric;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_mode not in ('multiply', 'percent', 'amount') or p_value is null then
    raise exception 'unknown adjustment' using errcode = '22023';
  end if;
  if p_mode = 'multiply' and (p_value <= 0 or p_value > 10) then
    raise exception 'the multiplier must be above 0 and at most 10' using errcode = '22023';
  end if;
  if p_mode = 'percent' and (p_value <= -100 or p_value > 900) then
    raise exception 'the percentage must be above -100 and at most 900' using errcode = '22023';
  end if;

  select id into v_list from price_list
  where payer_id is null and deleted_at is null and effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
  order by effective_from desc limit 1;
  if v_list is null then
    return 0;
  end if;

  for r in
    select pli.id, pli.price
    from price_list_item pli
    join service s on s.id = pli.service_id
    where pli.price_list_id = v_list and pli.deleted_at is null and s.deleted_at is null
      and (p_group is null or s.service_group = p_group)
      and pli.price > 0
  loop
    v_new := case p_mode
      when 'multiply' then r.price * p_value
      when 'percent' then r.price * (100 + p_value) / 100
      else r.price + p_value
    end;
    v_new := greatest(round(v_new / v_step) * v_step, 0);
    if v_new <> r.price then
      update price_list_item set price = v_new where id = r.id;
      v_count := v_count + 1;
    end if;
  end loop;

  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'update', 'price_list', v_list,
          jsonb_build_object('group', p_group, 'mode', p_mode, 'value', p_value, 'round', v_step, 'changed', v_count));
  return v_count;
end
$$;

grant execute on function staff_settings(), delete_service(uuid), delete_payer(uuid),
  adjust_prices(service_group, text, numeric, integer) to authenticated;
revoke execute on function staff_settings(), delete_service(uuid), delete_payer(uuid),
  adjust_prices(service_group, text, numeric, integer) from anon;


-- ============================================================ 20261019120000_desk_summary.sql
-- 0019 · Front-desk and nursing dashboards.
--
-- desk_summary(): today's figures every signed-in staff member may see (no money): patients
-- registered, visits, who is waiting where and for how long, the triage queue by colour,
-- vitals taken, appointments and inquiries, beds, arrivals per hour and the caller's own work.
-- The receptionist and nurse home dashboards are built from it; dashboard_summary() stays for
-- managers and heads of station.

create or replace function desk_summary()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_tiles jsonb;
  v_stations jsonb;
  v_hours jsonb;
  v_mine jsonb;
begin
  if not exists (select 1 from profiles where id = v_me and active) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'registeredToday', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date = v_today),
    'registeredYesterday', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date = v_today - 1),
    'visitsToday', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date = v_today),
    'visitsYesterday', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date = v_today - 1),
    'inClinic', (select count(*) from encounter where deleted_at is null and status = 'open'),
    'waitingNow', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                   where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'),
    'avgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at, now()) - q.created_at) / 60)), 0)
                   from queue_entry q where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'triageWaiting', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                      where q.deleted_at is null and q.station = 'triage' and q.finished_at is null and e.status = 'open'),
    'triageRed', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                  where q.deleted_at is null and q.finished_at is null and e.status = 'open' and e.triage_level = 'red'),
    'triageYellow', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                     where q.deleted_at is null and q.finished_at is null and e.status = 'open' and e.triage_level = 'yellow'),
    'triageAvgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at, now()) - q.created_at) / 60)), 0)
                         from queue_entry q where q.deleted_at is null and q.station = 'triage'
                           and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'vitalsToday', (select count(distinct encounter_id) from observation where deleted_at is null and (effective_at at time zone 'Africa/Kigali')::date = v_today),
    'vitalsYesterday', (select count(distinct encounter_id) from observation where deleted_at is null and (effective_at at time zone 'Africa/Kigali')::date = v_today - 1),
    'apptsToday', (select count(*) from appointment where deleted_at is null
                   and status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed')
                   and (starts_at at time zone 'Africa/Kigali')::date = v_today),
    'inquiriesPending', (select count(*) from appointment where deleted_at is null and status = 'inquiry'),
    'bedsOccupied', (select count(*) from bed where deleted_at is null and status = 'occupied'),
    'bedsTotal', (select count(*) from bed where deleted_at is null and status <> 'out_of_service')
  ) into v_tiles;

  -- Where patients are right now: waiting / being seen per station, average wait today.
  select coalesce(jsonb_agg(jsonb_build_object('station', s.station, 'waiting', s.waiting, 'busy', s.busy, 'minutes', s.minutes)
                            order by s.station), '[]'::jsonb) into v_stations
  from (
    select q.station::text as station,
           count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open') as waiting,
           count(*) filter (where q.finished_at is null and q.started_at is not null and e.status = 'open') as busy,
           round(avg(extract(epoch from coalesce(q.started_at, q.finished_at, now()) - q.created_at) / 60)) as minutes
    from queue_entry q
    join encounter e on e.id = q.encounter_id
    where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date = v_today
    group by q.station
  ) s;

  -- Arrivals per hour today (06:00–21:00, plus any hour outside that had arrivals).
  select coalesce(jsonb_agg(jsonb_build_object('hour', h.hour, 'count', coalesce(a.n, 0)) order by h.hour), '[]'::jsonb) into v_hours
  from (
    select generate_series(6, 21) as hour
    union
    select extract(hour from arrived_at at time zone 'Africa/Kigali')::int
    from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date = v_today
  ) h
  left join (
    select extract(hour from arrived_at at time zone 'Africa/Kigali')::int as hour, count(*) as n
    from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date = v_today
    group by 1
  ) a on a.hour = h.hour;

  -- The caller's own work today (accountability, and a little motivation).
  select jsonb_build_object(
    'registrations', (select count(*) from patient where deleted_at is null and created_by = v_me and (created_at at time zone 'Africa/Kigali')::date = v_today),
    'visitsStarted', (select count(*) from encounter where deleted_at is null and created_by = v_me and (arrived_at at time zone 'Africa/Kigali')::date = v_today),
    'vitals', (select count(distinct encounter_id) from observation where deleted_at is null and performer_id = v_me and (effective_at at time zone 'Africa/Kigali')::date = v_today),
    'charges', (select count(*) from invoice_line where deleted_at is null and entered_by = v_me and (created_at at time zone 'Africa/Kigali')::date = v_today)
  ) into v_mine;

  return jsonb_build_object('tiles', v_tiles, 'stations', v_stations, 'arrivals', v_hours, 'mine', v_mine);
end
$$;

grant execute on function desk_summary() to authenticated;
revoke execute on function desk_summary() from anon;


-- ============================================================ 20261019150000_vitals_on_behalf.sql
-- 0020 · First measurements, taken by the nurse, entered by whoever has the device.
--
-- Clinic practice: a patient arriving goes first to the nurse, who takes blood pressure,
-- temperature, weight… When the nurse has no device at hand, she writes the figures on paper
-- and the receptionist or the doctor types them in later. So a measurement now records:
--   * performer_id  — who measured (the nurse), chosen on the form;
--   * effective_at  — when it was measured (from the paper), not when it was typed;
--   * created_by    — who typed it (automatic).
-- Receptionists get the narrow permission `vitals.write` (vital signs only, no other clinical
-- record). Entering vitals for a visit already past triage (the doctor, later) only adds the
-- measurements; it does not move the patient in the queue.

insert into role_permissions (role, permission)
values ('receptionist', 'vitals.write'), ('nurse', 'vitals.write'), ('doctor', 'vitals.write'),
       ('manager', 'vitals.write')
on conflict do nothing;

-- Staff who take measurements, for the "Measured by" list (readable by anyone who enters vitals).
create or replace function vitals_takers()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'staffId', p.staff_id, 'role', p.role)
                            order by (p.role <> 'nurse'), p.full_name), '[]'::jsonb)
  from profiles p
  where p.active and p.role in ('nurse', 'doctor', 'manager')
    and (has_perm('vitals.write') or has_perm('clinical.write'))
$$;

drop function if exists record_vitals(uuid, jsonb, triage_level, station, text);

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
  v_val numeric;
  v_count integer := 0;
  v_by uuid := coalesce(p_measured_by, auth.uid());
  v_at timestamptz := coalesce(p_measured_at, now());
  v_arrived timestamptz;
  v_at_triage boolean;
  v_units jsonb := '{"bp_sys":"mmHg","bp_dia":"mmHg","pulse":"bpm","temp":"°C","resp":"/min","spo2":"%","weight":"kg","height":"cm","muac":"cm"}'::jsonb;
begin
  if not (has_perm('clinical.write') or has_perm('vitals.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select arrived_at into v_arrived from encounter where id = p_encounter_id and status = 'open';
  if not found then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  -- Without clinical rights the person typing must name who measured.
  if not has_perm('clinical.write') and (p_measured_by is null or p_measured_by = auth.uid()) then
    raise exception 'choose the nurse who took the measurements' using errcode = '22023';
  end if;
  if not exists (select 1 from profiles where id = v_by and active) then
    raise exception 'unknown staff member for "measured by"' using errcode = '22023';
  end if;
  if v_at > now() + interval '5 minutes' then
    raise exception 'the measurement time is in the future' using errcode = '22023';
  end if;
  if v_at < v_arrived - interval '1 hour' then
    raise exception 'the measurement time is before the patient arrived' using errcode = '22023';
  end if;

  for v_key, v_val in
    select key, nullif(value, '')::numeric from jsonb_each_text(coalesce(p_vitals, '{}'::jsonb))
  loop
    if v_val is not null and v_units ? v_key then
      insert into observation (encounter_id, code, value_num, unit, performer_id, effective_at)
      values (p_encounter_id, v_key, v_val, v_units ->> v_key, v_by, v_at);
      v_count := v_count + 1;
    end if;
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

  if p_triage is not null then
    update encounter set triage_level = p_triage, triage_reason = coalesce(p_reason, triage_reason)
    where id = p_encounter_id;
  end if;

  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;

  -- At triage: close the triage turn and send the patient on. Later (e.g. the doctor typing
  -- the nurse's paper sheet): measurements only, the patient stays where they are.
  select exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'triage'
                 and finished_at is null and deleted_at is null) into v_at_triage;
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

-- Who measured and who typed it, next to each value on the visit screen.
create or replace view visit_vitals with (security_invoker = true) as
  select distinct on (o.encounter_id, o.code)
         o.encounter_id, o.code, o.value_num, o.unit, o.effective_at,
         pm.full_name as measured_by, pe.full_name as entered_by
  from observation o
  left join profiles pm on pm.id = o.performer_id
  left join profiles pe on pe.id = o.created_by
  where o.deleted_at is null
  order by o.encounter_id, o.code, o.effective_at desc;

grant execute on function vitals_takers(),
  record_vitals(uuid, jsonb, triage_level, station, text, uuid, timestamptz) to authenticated;
revoke execute on function vitals_takers(),
  record_vitals(uuid, jsonb, triage_level, station, text, uuid, timestamptz) from anon;


-- ============================================================ 20261019180000_lock_two_hours.sql
-- 0021 · Screen lock after two hours without activity (clinic request, 2026-10-19).
-- The manager can still change it in Settings → Screen lock.

insert into setting (key, value, changed_at)
values ('security.lock', '{"idle_minutes": 120}'::jsonb, now())
on conflict (key) do update set value = excluded.value, changed_at = now();

create or replace function staff_settings()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'idle_minutes', coalesce(((select value from setting where key = 'security.lock') ->> 'idle_minutes')::int, 120)
  )
$$;


-- ============================================================ 20261019190000_desk_operations.sql
-- 0022 · Front-desk and nursing operations that link the stations together.
--
-- Reception → nurse → doctor, as the clinic works today:
--   * appointments_day(): the day's booked patients with what reception needs to act on them;
--   * appointment_arrived(): the booked patient is here → a visit opens and the patient is
--     queued at triage (the nurse sees them at once); no_show / cancel with a reason;
--   * create_task() / complete_task(): a doctor (or the manager) leaves the nurse a task on a
--     visit ("injection at 14:00"); the nurse ticks it off on her dashboard;
--   * admit_to_bed() / discharge_bed() / bed_ready(): the short-stay bed board.

-- ---------------------------------------------------------------- appointments
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
      'late', a.status in ('approved', 'confirmed') and a.starts_at < now() - interval '15 minutes'
    ) order by a.starts_at), '[]'::jsonb)
  from appointment a
  left join patient p on p.id = a.patient_id
  left join practitioner pr on pr.id = a.practitioner_id
  where has_perm('appointment.read') and a.deleted_at is null
    and a.status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed', 'no_show', 'cancelled')
    and (a.starts_at at time zone 'Africa/Kigali')::date = coalesce(p_day, (now() at time zone 'Africa/Kigali')::date)
$$;

create or replace function appointment_arrived(p_appointment_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_appt appointment%rowtype;
  v_visit jsonb;
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
  -- Already in the clinic (walked in earlier): keep that visit. Otherwise, MoH workflow:
  -- every arrival starts at triage with the nurse.
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
    v_visit := start_visit(v_appt.patient_id, false, 'triage');
  end if;
  update appointment set status = 'arrived' where id = p_appointment_id;
  return v_visit;
end
$$;

create or replace function set_appointment_outcome(p_appointment_id uuid, p_status appointment_status, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('appointment.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_status not in ('no_show', 'cancelled') then
    raise exception 'only no-show or cancelled here' using errcode = '22023';
  end if;
  if p_status = 'cancelled' and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'give the reason for the cancellation' using errcode = '22023';
  end if;
  update appointment set status = p_status, cancel_reason = coalesce(nullif(trim(p_reason), ''), cancel_reason)
  where id = p_appointment_id and deleted_at is null and status in ('approved', 'confirmed');
  if not found then
    raise exception 'this appointment can no longer be changed' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------- tasks
create or replace function create_task(
  p_encounter_id uuid,
  p_title text,
  p_due_at timestamptz default null,
  p_detail text default null,
  p_assigned_role role_key default 'nurse'
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_patient uuid;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_title, ''))) < 2 then
    raise exception 'say what must be done' using errcode = '22023';
  end if;
  select patient_id into v_patient from encounter where id = p_encounter_id and status = 'open';
  if not found then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into internal_task (encounter_id, patient_id, assigned_role, due_at, title, detail)
  values (p_encounter_id, v_patient, p_assigned_role, p_due_at, trim(p_title), nullif(trim(coalesce(p_detail, '')), ''))
  returning id into v_id;
  return v_id;
end
$$;

create or replace function complete_task(p_task_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update internal_task set done_at = now(), done_by = auth.uid()
  where id = p_task_id and deleted_at is null and done_at is null;
  if not found then
    raise exception 'task not found or already done' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------- beds
create or replace function admit_to_bed(p_encounter_id uuid, p_bed_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if exists (select 1 from bed_stay where encounter_id = p_encounter_id and discharged_at is null and deleted_at is null) then
    raise exception 'this patient is already in a bed' using errcode = '23505';
  end if;
  update bed set status = 'occupied' where id = p_bed_id and status = 'free' and deleted_at is null;
  if not found then
    raise exception 'this bed is not free' using errcode = 'P0002';
  end if;
  insert into bed_stay (encounter_id, bed_id) values (p_encounter_id, p_bed_id);
end
$$;

create or replace function discharge_bed(p_bed_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update bed_stay set discharged_at = now() where bed_id = p_bed_id and discharged_at is null and deleted_at is null;
  if not found then
    raise exception 'nobody is in this bed' using errcode = 'P0002';
  end if;
  update bed set status = 'cleaning' where id = p_bed_id;
end
$$;

create or replace function bed_ready(p_bed_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update bed set status = 'free' where id = p_bed_id and status in ('cleaning', 'out_of_service') and deleted_at is null;
  if not found then
    raise exception 'this bed cannot be marked ready' using errcode = 'P0002';
  end if;
end
$$;

-- Beds with ids (the home summary only carries names), for the board's actions.
create or replace function bed_board()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'state', b.status,
      'encounterId', s.encounter_id,
      'patient', case when s.id is not null then p.surname || ' ' || p.given_names end,
      'since', s.admitted_at
    ) order by b.sort_order, b.name), '[]'::jsonb)
  from bed b
  left join bed_stay s on s.bed_id = b.id and s.discharged_at is null and s.deleted_at is null
  left join encounter e on e.id = s.encounter_id
  left join patient p on p.id = e.patient_id
  where b.deleted_at is null and has_perm('queue.read')
$$;

-- Tasks with the patient and the visit, for the nurse's list (open ones, today and overdue).
create or replace function open_tasks()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', k.id, 'title', k.title, 'detail', k.detail, 'dueAt', k.due_at,
      'overdue', k.due_at is not null and k.due_at < now(),
      'encounterId', k.encounter_id,
      'patient', p.surname || ' ' || p.given_names,
      'by', pr.full_name
    ) order by k.due_at nulls last, k.created_at), '[]'::jsonb)
  from internal_task k
  left join patient p on p.id = k.patient_id
  left join profiles pr on pr.id = k.created_by
  where k.deleted_at is null and k.done_at is null
    and (k.assigned_to = auth.uid() or k.assigned_role = current_role_key() or is_manager())
$$;

grant execute on function appointments_day(date), appointment_arrived(uuid),
  set_appointment_outcome(uuid, appointment_status, text), create_task(uuid, text, timestamptz, text, role_key),
  complete_task(uuid), admit_to_bed(uuid, uuid), discharge_bed(uuid), bed_ready(uuid), bed_board(), open_tasks()
  to authenticated;
revoke execute on function appointments_day(date), appointment_arrived(uuid),
  set_appointment_outcome(uuid, appointment_status, text), create_task(uuid, text, timestamptz, text, role_key),
  complete_task(uuid), admit_to_bed(uuid, uuid), discharge_bed(uuid), bed_ready(uuid), bed_board(), open_tasks()
  from anon;


-- ============================================================ 20261019210000_files_to_complete.sql
-- 0023 · Nurse first, reception completes the file.
--
-- Clinic practice: the patient meets the nurse first; she registers what she can (name, sex,
-- age) and takes the measurements; reception then completes what the nurse cannot (phone,
-- national ID, address) before the patient sees the doctor. Either one can register.
--   * patient_missing(): which administrative details a file still lacks;
--   * files_to_complete(): patients in the clinic now (or registered in the last two days)
--     whose file is incomplete, with where they are, for reception's list.

create or replace function patient_missing(p patient)
returns text[]
language sql stable
as $$
  select array_remove(array[
    case when nullif(trim(coalesce(p.phone_1, '')), '') is null then 'phone' end,
    -- National ID from 16 years (or when the age is unknown).
    case when p.national_id is null
          and (p.birth_date is null or p.birth_date <= current_date - interval '16 years') then 'national_id' end,
    case when nullif(trim(coalesce(p.sector, '')), '') is null then 'address' end,
    case when p.birth_date is null then 'age' end
  ], null)
$$;

create or replace function files_to_complete()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.in_clinic desc, x.at desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
             'patientId', p.id,
             'fileNumber', p.file_number,
             'name', p.surname || ' ' || p.given_names,
             'sex', p.sex,
             'birthDate', p.birth_date,
             'missing', to_jsonb(patient_missing(p)),
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
    left join encounter e on e.patient_id = p.id and e.status = 'open' and e.deleted_at is null
    left join profiles rb on rb.id = p.created_by
    where has_perm('patient.read') and p.deleted_at is null and p.merged_into is null
      and cardinality(patient_missing(p)) > 0
      and (e.id is not null or p.created_at > now() - interval '2 days')
  ) x
$$;

grant execute on function patient_missing(patient), files_to_complete() to authenticated;
revoke execute on function patient_missing(patient), files_to_complete() from anon;


-- ============================================================ 20261019230000_vitals_visible_to_reception.sql
-- 0024 · Reception sees the vitals it may enter.
--
-- Found in live testing (2026-10-19): the receptionist opened a visit whose vitals the nurse
-- had just recorded and saw "No vitals yet" — visit_vitals ran with the caller's rights and
-- observation is readable only with clinical.read. A receptionist holds vitals.write (to type
-- the nurse's paper sheet) and must see what is already there to avoid entering it twice.
-- The view now runs with its owner's rights and filters explicitly: vital-sign codes only,
-- for staff with clinical.read or vitals.write. Diagnoses and notes stay clinical-only.

create or replace view visit_vitals with (security_invoker = false) as
  select distinct on (o.encounter_id, o.code)
         o.encounter_id, o.code, o.value_num, o.unit, o.effective_at,
         pm.full_name as measured_by, pe.full_name as entered_by
  from observation o
  left join profiles pm on pm.id = o.performer_id
  left join profiles pe on pe.id = o.created_by
  where o.deleted_at is null
    and o.code in ('bp_sys', 'bp_dia', 'pulse', 'temp', 'resp', 'spo2', 'weight', 'height', 'muac')
    and (has_perm('clinical.read') or has_perm('vitals.write'))
  order by o.encounter_id, o.code, o.effective_at desc;

revoke all on visit_vitals from anon;
grant select on visit_vitals to authenticated;


-- ============================================================ 20261020090000_trusted_devices.sql
-- 0025 · Trusted devices: the e-mailed code once per device, not at every sign-in.
--
-- The clinic's mail goes through a Gmail account (≈ 500 messages per rolling 24 h, and our
-- own cap of 60 per hour). A code at every sign-in wastes that budget and staff time. After a
-- correct code the person may trust the browser: it keeps a random key; the database keeps
-- only its SHA-256 fingerprint. Next time staff ID + username + PIN are enough on that device
-- until the trust expires. The manager sets how long (setting `security.otp`, trust_days:
-- 0 = a code at every sign-in) and can make every device ask for a code again.

create table if not exists trusted_device (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  token_hash text not null unique,
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists trusted_device_user_idx on trusted_device (user_id) where revoked_at is null;
alter table trusted_device enable row level security;
-- No policies: only the functions below (security definer) touch this table.

create or replace function trust_days()
returns integer
language sql stable security definer set search_path = public
as $$
  select coalesce(((select value from setting where key = 'security.otp') ->> 'trust_days')::int, 30)
$$;

-- Called right after a correct e-mailed code. Returns when the trust ends (null = not trusted).
create or replace function trust_this_device(p_token text, p_label text default null)
returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare
  v_days integer := trust_days();
  v_until timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_days <= 0 or length(coalesce(p_token, '')) < 32 then
    return null;
  end if;
  v_until := now() + make_interval(days => v_days);
  insert into trusted_device (user_id, token_hash, label, expires_at, last_used_at)
  values (auth.uid(), encode(sha256(convert_to(p_token, 'UTF8')), 'hex'), left(p_label, 120), v_until, now());
  return v_until;
end
$$;

-- Called after the PIN on a device that holds a key. True = no code needed this time.
create or replace function use_trusted_device(p_token text)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null or trust_days() <= 0 then
    return false;
  end if;
  select id into v_id from trusted_device
  where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
    and user_id = auth.uid() and revoked_at is null and expires_at > now();
  if v_id is null then
    return false;
  end if;
  update trusted_device set last_used_at = now() where id = v_id;
  return true;
end
$$;

-- Everyone (manager) or yourself: every trusted device asks for a code again.
create or replace function revoke_trusted_devices(p_all boolean default false)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_all and not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update trusted_device set revoked_at = now()
  where revoked_at is null and (p_all or user_id = auth.uid());
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- Settings: allow security.otp ({ trust_days: 0..90 }); expose trust_days to staff screens.
create or replace function save_setting(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_key not in ('clinic.profile', 'clinic.hours', 'clinic.features', 'patient.fields', 'security.lock', 'security.otp') then
    raise exception 'unknown setting %', p_key using errcode = '22023';
  end if;
  if p_key = 'security.lock' then
    if jsonb_typeof(p_value -> 'idle_minutes') <> 'number'
       or (p_value ->> 'idle_minutes')::numeric < 1
       or (p_value ->> 'idle_minutes')::numeric > 480 then
      raise exception 'idle_minutes must be between 1 and 480' using errcode = '22023';
    end if;
  end if;
  if p_key = 'security.otp' then
    if jsonb_typeof(p_value -> 'trust_days') <> 'number'
       or (p_value ->> 'trust_days')::numeric < 0
       or (p_value ->> 'trust_days')::numeric > 90 then
      raise exception 'trust_days must be between 0 and 90' using errcode = '22023';
    end if;
  end if;
  if p_key = 'patient.fields' and jsonb_typeof(p_value) <> 'array' then
    raise exception 'patient.fields must be a list' using errcode = '22023';
  end if;
  insert into setting (key, value, changed_by, changed_at)
  values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, changed_by = auth.uid(), changed_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'setting', null, jsonb_build_object('key', p_key));
end
$$;

create or replace function staff_settings()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'idle_minutes', coalesce(((select value from setting where key = 'security.lock') ->> 'idle_minutes')::int, 120),
    'trust_days', trust_days()
  )
$$;

grant execute on function trust_days(), trust_this_device(text, text), use_trusted_device(text),
  revoke_trusted_devices(boolean) to authenticated;
revoke execute on function trust_days(), trust_this_device(text, text), use_trusted_device(text),
  revoke_trusted_devices(boolean) from anon;


-- ============================================================ 20261020120000_departments_notifications.sql
-- 0026 · Departments, positions, and notifications.
--
-- Departments: the manager creates them (name, description, which roles belong) and places
-- each employee in one with a position: head, assistant head or member. A head gets the head
-- dashboard of that department. Nothing is pre-filled: the clinic defines its own departments.
--
-- Notifications: one row per message, addressed to a person, a role, a department (optionally
-- its heads only) or everyone. Automatic ones are written by triggers as a kind + params so each
-- reader sees them in their own language; manager / head messages carry their own text.
-- Read state is per person.

-- ---------------------------------------------------------------- departments
create table if not exists department (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  roles role_key[] not null default '{}',
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  deleted_at timestamptz
);
create unique index if not exists department_name_uq on department (lower(name)) where deleted_at is null;
alter table department enable row level security;
drop policy if exists department_read on department;
create policy department_read on department for select to authenticated using (deleted_at is null);

alter table profiles add column if not exists department_id uuid references department (id);
alter table profiles add column if not exists position text not null default 'member'
  check (position in ('head', 'assistant', 'member'));

create or replace view staff_directory with (security_invoker = true) as
  select p.id, p.username, p.full_name, p.role, p.station, p.dashboard, p.head_of, p.language, p.phone,
         p.active, p.must_change_pin, p.last_sign_in_at, p.pin_changed_at, p.deactivated_at, p.created_at,
         p.staff_id, p.email, p.department_id, d.name as department_name, p.position
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null;

create or replace function upsert_department(p_id uuid, p_name text, p_description text, p_roles role_key[])
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'the department needs a name' using errcode = '22023';
  end if;
  if v_id is null then
    insert into department (name, description, roles)
    values (trim(p_name), nullif(trim(coalesce(p_description, '')), ''), coalesce(p_roles, '{}'))
    returning id into v_id;
  else
    update department set name = trim(p_name), description = nullif(trim(coalesce(p_description, '')), ''),
                          roles = coalesce(p_roles, '{}')
    where id = v_id and deleted_at is null;
    if not found then
      raise exception 'department not found' using errcode = 'P0002';
    end if;
    -- Heads follow the department's name on their dashboard.
    update profiles set head_of = trim(p_name) where department_id = v_id and position = 'head';
  end if;
  return v_id;
end
$$;

create or replace function delete_department(p_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update department set deleted_at = now(), active = false where id = p_id and deleted_at is null;
  if not found then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  -- Its staff stay employed, without a department; heads lose the head dashboard.
  update profiles set department_id = null, position = 'member',
         dashboard = case when dashboard = 'head' then null else dashboard end,
         head_of = case when dashboard = 'head' then null else head_of end
  where department_id = p_id;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- ---------------------------------------------------------------- notifications
create table if not exists notification (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  kind text not null,                     -- queue, task, inquiry, to_accept, message
  params jsonb not null default '{}',     -- for automatic kinds (rendered in the reader's language)
  title text,                             -- for messages written by a person
  body text,
  link text,                              -- in-app path, e.g. /app/visit?encounter=…
  urgent boolean not null default false,
  recipient_user uuid references profiles (id) on delete cascade,
  recipient_role role_key,
  recipient_department uuid references department (id) on delete cascade,
  heads_only boolean not null default false,
  to_all boolean not null default false
);
create index if not exists notification_created_idx on notification (created_at desc);
alter table notification enable row level security;

create table if not exists notification_read (
  notification_id uuid not null references notification (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);
alter table notification_read enable row level security;

-- Is this notification for the signed-in person? (Managers also see role/department messages.)
create or replace function notification_is_mine(n notification, p_me uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles p
    where p.id = p_me and p.active and (
      n.to_all
      or n.recipient_user = p_me
      or (n.recipient_role is not null and n.recipient_role = p.role and n.recipient_department is null)
      or (n.recipient_department is not null and n.recipient_department = p.department_id
          and (not n.heads_only or p.position in ('head', 'assistant')))
    )
  )
$$;

create or replace function my_notifications(p_limit integer default 30)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with mine as (
    select n.*, (r.user_id is not null) as is_read, sender.full_name as sender
    from notification n
    left join notification_read r on r.notification_id = n.id and r.user_id = auth.uid()
    left join profiles sender on sender.id = n.created_by
    where n.created_at > now() - interval '14 days' and notification_is_mine(n, auth.uid())
  )
  select jsonb_build_object(
    'unread', (select count(*) from mine where not is_read),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'at', created_at, 'kind', kind, 'params', params, 'title', title, 'body', body,
        'link', link, 'urgent', urgent, 'read', is_read, 'sender', sender
      ) order by created_at desc)
      from (select * from mine order by created_at desc limit greatest(1, least(p_limit, 100))) x
    ), '[]'::jsonb)
  )
$$;

create or replace function mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  insert into notification_read (notification_id, user_id)
  select n.id, auth.uid() from notification n
  where (p_ids is null or n.id = any (p_ids))
    and n.created_at > now() - interval '14 days'
    and notification_is_mine(n, auth.uid())
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- Manager: to anyone. Department head / assistant: to their own department.
create or replace function send_notification(
  p_to text,              -- all | role | department | user
  p_target text,          -- role key, department id or user id (null for all)
  p_title text,
  p_body text,
  p_heads_only boolean default false,
  p_urgent boolean default false
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_me profiles%rowtype;
  v_id uuid;
begin
  select * into v_me from profiles where id = auth.uid() and active;
  if not found then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_title, ''))) < 2 then
    raise exception 'write a title' using errcode = '22023';
  end if;
  if not is_manager() then
    if not (v_me.position in ('head', 'assistant') and p_to = 'department'
            and p_target::uuid = v_me.department_id) then
      raise exception 'only the manager, or a head for their own department, can send messages' using errcode = '42501';
    end if;
  end if;
  insert into notification (kind, title, body, urgent, to_all, recipient_role, recipient_department,
                            recipient_user, heads_only, link)
  values ('message', trim(p_title), nullif(trim(coalesce(p_body, '')), ''), coalesce(p_urgent, false),
          p_to = 'all',
          case when p_to = 'role' then p_target::role_key end,
          case when p_to = 'department' then p_target::uuid end,
          case when p_to = 'user' then p_target::uuid end,
          p_to = 'department' and coalesce(p_heads_only, false), null)
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------- automatic notifications
-- Which role works at a station.
create or replace function station_role(p_station station)
returns role_key
language sql immutable
as $$
  select case p_station
    when 'reception' then 'receptionist'
    when 'triage' then 'nurse'
    when 'nursing' then 'nurse'
    when 'beds' then 'nurse'
    when 'consultation' then 'doctor'
    when 'dental' then 'doctor'
    when 'theatre' then 'doctor'
    when 'laboratory' then 'lab_tech'
    when 'ultrasound' then 'sonographer'
    when 'pharmacy' then 'pharmacist'
    when 'cashier' then 'cashier'
  end::role_key
$$;

create or replace function notify_queue_entry()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_triage text;
begin
  select p.surname || ' ' || p.given_names, e.triage_level::text into v_name, v_triage
  from encounter e join patient p on p.id = e.patient_id where e.id = new.encounter_id;
  insert into notification (kind, params, link, urgent, recipient_role, created_by)
  values ('queue',
          jsonb_build_object('ticket', new.ticket_no, 'name', v_name, 'station', new.station, 'triage', v_triage),
          '/app/visit?encounter=' || new.encounter_id,
          coalesce(v_triage, '') = 'red' or new.priority = 1,
          station_role(new.station),
          auth.uid());
  return new;
end
$$;
drop trigger if exists queue_entry_notify on queue_entry;
create trigger queue_entry_notify after insert on queue_entry
  for each row execute function notify_queue_entry();

create or replace function notify_task()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
begin
  select p.surname || ' ' || p.given_names into v_name from patient p where p.id = new.patient_id;
  insert into notification (kind, params, link, recipient_role, recipient_user, created_by)
  values ('task',
          jsonb_build_object('title', new.title, 'name', v_name, 'due', new.due_at),
          case when new.encounter_id is not null then '/app/visit?encounter=' || new.encounter_id end,
          case when new.assigned_to is null then new.assigned_role end,
          new.assigned_to,
          auth.uid());
  return new;
end
$$;
drop trigger if exists internal_task_notify on internal_task;
create trigger internal_task_notify after insert on internal_task
  for each row execute function notify_task();

create or replace function notify_appointment()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_doctor uuid;
begin
  v_name := coalesce((select p.surname || ' ' || p.given_names from patient p where p.id = new.patient_id), new.contact_name);
  if tg_op = 'INSERT' and new.status = 'inquiry' then
    insert into notification (kind, params, link, recipient_role, created_by)
    values ('inquiry', jsonb_build_object('name', v_name, 'when', new.starts_at), '/app/appointments',
            'receptionist', auth.uid());
  elsif tg_op = 'UPDATE' and new.status = 'approved' and old.status is distinct from 'approved' then
    select user_id into v_doctor from practitioner where id = new.practitioner_id;
    if v_doctor is not null then
      insert into notification (kind, params, link, recipient_user, created_by)
      values ('to_accept', jsonb_build_object('name', v_name, 'when', new.starts_at), '/app',
              v_doctor, auth.uid());
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists appointment_notify on appointment;
create trigger appointment_notify after insert or update of status on appointment
  for each row execute function notify_appointment();

grant execute on function upsert_department(uuid, text, text, role_key[]), delete_department(uuid),
  my_notifications(integer), mark_notifications_read(uuid[]),
  send_notification(text, text, text, text, boolean, boolean) to authenticated;
revoke execute on function upsert_department(uuid, text, text, role_key[]), delete_department(uuid),
  my_notifications(integer), mark_notifications_read(uuid[]),
  send_notification(text, text, text, text, boolean, boolean) from anon;
revoke execute on function notification_is_mine(notification, uuid) from anon, authenticated;


-- ============================================================ 20261021090000_payment_methods.sql
-- 0027 — Accepted payment methods: the clinic takes cash, MTN MoMo and Airtel Money only.
-- Card and bank transfer stay in the payment_method enum so older rows remain readable, but no
-- new payment may use them. NOT VALID: existing rows are not re-checked.
alter table payment drop constraint if exists payment_method_accepted;
alter table payment
  add constraint payment_method_accepted
  check (method not in ('card', 'bank')) not valid;


-- ============================================================ 20261021120000_beds_pricing.sql
-- 0028 — Beds: how many, the price of a night, and priced stays.
-- The manager decides how many beds the clinic has and what one night costs (one price for all,
-- or per bed). When a nurse or doctor puts a patient in a bed they say for how many nights; the
-- stay goes on the patient's bill at once: nights × the bed's price, or a price agreed for that
-- period (typed, with the reason recorded). "Extend" adds more nights the same way.

alter table bed add column if not exists nightly_price numeric(12, 0) not null default 0
  check (nightly_price >= 0);

alter table bed_stay add column if not exists planned_nights integer
  check (planned_nights is null or planned_nights between 1 and 365);
alter table bed_stay add column if not exists planned_until timestamptz;
alter table bed_stay add column if not exists nightly_price numeric(12, 0);
alter table bed_stay add column if not exists period_price numeric(12, 0);

-- The catalogue line a bed stay is billed under (price typed per stay, so allow_manual_price).
insert into service (code, name_en, name_kin, name_fr, service_group, allow_manual_price)
values ('BED-STAY', 'Bed stay', 'Kurara ku buriri', 'Séjour au lit', 'bed', true)
on conflict (code) do update set allow_manual_price = true, active = true;

-- ---------------------------------------------------------------- manager: beds and prices

-- Sets the number of beds: adds "Bed n" up to p_count, or removes free beds from the end.
-- p_nightly_price (optional) becomes the price of every bed.
create or replace function set_bed_count(p_count integer, p_nightly_price numeric default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_have integer;
  v_next integer;
  v_bed record;
begin
  if not is_manager() then
    raise exception 'only the manager can change the beds' using errcode = '42501';
  end if;
  if p_count is null or p_count < 0 or p_count > 200 then
    raise exception 'the number of beds must be between 0 and 200' using errcode = '22023';
  end if;
  if p_nightly_price is not null and p_nightly_price < 0 then
    raise exception 'the price of a night cannot be negative' using errcode = '22023';
  end if;
  select count(*) into v_have from bed where deleted_at is null;
  -- Fewer beds: remove the last ones, never an occupied bed.
  for v_bed in
    select id, status from bed where deleted_at is null
    order by sort_order desc, name desc limit greatest(v_have - p_count, 0)
  loop
    if v_bed.status = 'occupied' then
      raise exception 'a bed that would be removed is occupied; discharge the patient first'
        using errcode = '23514';
    end if;
    update bed set deleted_at = now(), name = name || ' · removed ' || left(id::text, 8)
    where id = v_bed.id;
  end loop;
  -- More beds: "Bed n" with the next free number.
  while (select count(*) from bed where deleted_at is null) < p_count loop
    select coalesce(max(sort_order), 0) + 1 into v_next from bed where deleted_at is null;
    while exists (select 1 from bed where name = 'Bed ' || v_next) loop
      v_next := v_next + 1;
    end loop;
    insert into bed (name, sort_order, nightly_price)
    values ('Bed ' || v_next, v_next, coalesce(p_nightly_price, 0));
  end loop;
  if p_nightly_price is not null then
    update bed set nightly_price = p_nightly_price where deleted_at is null;
  end if;
  return jsonb_build_object(
    'beds', (select count(*) from bed where deleted_at is null),
    'occupied', (select count(*) from bed where deleted_at is null and status = 'occupied')
  );
end
$$;

-- Renames one bed and/or sets its own price of a night.
create or replace function save_bed(p_id uuid, p_name text, p_nightly_price numeric)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_manager() then
    raise exception 'only the manager can change the beds' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'a bed needs a name' using errcode = '22023';
  end if;
  if p_nightly_price is null or p_nightly_price < 0 then
    raise exception 'the price of a night cannot be negative' using errcode = '22023';
  end if;
  if exists (select 1 from bed where lower(name) = lower(trim(p_name)) and id <> p_id) then
    raise exception 'another bed already has this name' using errcode = '23505';
  end if;
  update bed set name = trim(p_name), nightly_price = p_nightly_price
  where id = p_id and deleted_at is null;
  if not found then
    raise exception 'bed not found' using errcode = 'P0002';
  end if;
end
$$;

create or replace function remove_bed(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_manager() then
    raise exception 'only the manager can change the beds' using errcode = '42501';
  end if;
  if exists (select 1 from bed where id = p_id and status = 'occupied') then
    raise exception 'this bed is occupied; discharge the patient first' using errcode = '23514';
  end if;
  update bed set deleted_at = now(), name = name || ' · removed ' || left(id::text, 8)
  where id = p_id and deleted_at is null;
  if not found then
    raise exception 'bed not found' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------- staff: priced stays

-- Bills p_nights on the visit: nights × the bed's price, or p_period_price agreed for the period.
create or replace function bill_bed_nights(
  p_stay_id uuid,
  p_nights integer,
  p_period_price numeric
)
returns numeric
language plpgsql security definer set search_path = public
as $$
declare
  v_stay bed_stay%rowtype;
  v_bed bed%rowtype;
  v_service uuid;
  v_total numeric;
  v_line uuid;
  v_agreed boolean := p_period_price is not null;
begin
  select * into v_stay from bed_stay where id = p_stay_id;
  select * into v_bed from bed where id = v_stay.bed_id;
  select id into v_service from service where code = 'BED-STAY';
  if p_nights is null or p_nights < 1 or p_nights > 365 then
    raise exception 'the number of nights must be between 1 and 365' using errcode = '22023';
  end if;
  if v_agreed and p_period_price < 0 then
    raise exception 'the price cannot be negative' using errcode = '22023';
  end if;
  v_total := case when v_agreed then p_period_price else v_bed.nightly_price * p_nights end;
  if v_total > 0 then
    v_line := add_charge(
      p_encounter_id => v_stay.encounter_id,
      p_office => 'beds',
      p_service_id => v_service,
      p_quantity => 1,
      p_manual_price => v_total,
      p_manual_reason => case when v_agreed then 'price agreed for the period'
                              else p_nights || ' × ' || v_bed.nightly_price end,
      p_source_type => 'bed_stay',
      p_source_id => p_stay_id
    );
    update invoice_line
    set description = 'Bed stay · ' || v_bed.name || ' · ' || p_nights
                      || case when p_nights = 1 then ' night' else ' nights' end
    where id = v_line;
  end if;
  return v_total;
end
$$;

drop function if exists admit_to_bed(uuid, uuid);
create or replace function admit_to_bed(
  p_encounter_id uuid,
  p_bed_id uuid,
  p_nights integer default 1,
  p_period_price numeric default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_stay uuid;
  v_total numeric;
  v_price numeric;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if exists (select 1 from bed_stay where encounter_id = p_encounter_id and discharged_at is null and deleted_at is null) then
    raise exception 'this patient is already in a bed' using errcode = '23505';
  end if;
  update bed set status = 'occupied' where id = p_bed_id and status = 'free' and deleted_at is null
  returning nightly_price into v_price;
  if not found then
    raise exception 'this bed is not free' using errcode = 'P0002';
  end if;
  insert into bed_stay (encounter_id, bed_id, charge_mode, planned_nights, planned_until,
                        nightly_price, period_price)
  values (p_encounter_id, p_bed_id, 'day', p_nights, now() + make_interval(days => p_nights),
          v_price, p_period_price)
  returning id into v_stay;
  v_total := bill_bed_nights(v_stay, p_nights, p_period_price);
  return jsonb_build_object('stayId', v_stay, 'nights', p_nights, 'total', v_total);
end
$$;

-- More nights for the patient in this bed, billed the same way.
create or replace function extend_bed_stay(
  p_bed_id uuid,
  p_nights integer,
  p_period_price numeric default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_stay bed_stay%rowtype;
  v_total numeric;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_stay from bed_stay
  where bed_id = p_bed_id and discharged_at is null and deleted_at is null;
  if not found then
    raise exception 'nobody is in this bed' using errcode = 'P0002';
  end if;
  v_total := bill_bed_nights(v_stay.id, p_nights, p_period_price);
  update bed_stay
  set planned_nights = coalesce(planned_nights, 0) + p_nights,
      planned_until = coalesce(planned_until, now()) + make_interval(days => p_nights),
      period_price = case when p_period_price is null then period_price
                          else coalesce(period_price, 0) + p_period_price end
  where id = v_stay.id;
  return jsonb_build_object('nights', p_nights, 'total', v_total);
end
$$;

-- Beds with ids, price and the stay's period, for the board's actions and the manager.
create or replace function bed_board()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'state', b.status,
      'nightlyPrice', b.nightly_price,
      'encounterId', s.encounter_id,
      'patient', case when s.id is not null then p.surname || ' ' || p.given_names end,
      'since', s.admitted_at,
      'nights', s.planned_nights,
      'until', s.planned_until
    ) order by b.sort_order, b.name), '[]'::jsonb)
  from bed b
  left join bed_stay s on s.bed_id = b.id and s.discharged_at is null and s.deleted_at is null
  left join encounter e on e.id = s.encounter_id
  left join patient p on p.id = e.patient_id
  where b.deleted_at is null and has_perm('queue.read')
$$;

grant execute on function set_bed_count(integer, numeric), save_bed(uuid, text, numeric),
  remove_bed(uuid), admit_to_bed(uuid, uuid, integer, numeric),
  extend_bed_stay(uuid, integer, numeric), bed_board() to authenticated;
revoke execute on function set_bed_count(integer, numeric), save_bed(uuid, text, numeric),
  remove_bed(uuid), admit_to_bed(uuid, uuid, integer, numeric),
  extend_bed_stay(uuid, integer, numeric), bed_board(), bill_bed_nights(uuid, integer, numeric)
  from anon, public;


-- ============================================================ 20261021150000_children_pool_notices.sql
-- 0029 — Patients without a national ID, "first free doctor" queues, notification management.

-- ---------------------------------------------------------------- patients without a national ID
-- A child, someone whose ID is not issued yet, or a foreign national: the file says why, and the
-- "files to complete" list stops asking for the number.
alter table patient add column if not exists no_national_id text
  check (no_national_id is null or no_national_id in ('child', 'not_issued', 'foreigner'));

create or replace function set_no_national_id(p_patient_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('patient.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_reason is not null and p_reason not in ('child', 'not_issued', 'foreigner') then
    raise exception 'unknown reason' using errcode = '22023';
  end if;
  update patient
  set no_national_id = p_reason,
      national_id = case when p_reason is null then national_id else null end
  where id = p_patient_id and deleted_at is null;
  if not found then
    raise exception 'patient not found' using errcode = 'P0002';
  end if;
end
$$;

create or replace function patient_missing(p patient)
returns text[]
language sql stable
as $$
  select array_remove(array[
    case when nullif(trim(coalesce(p.phone_1, '')), '') is null then 'phone' end,
    -- National ID from 16 years (or when the age is unknown), unless the file says why there is none.
    case when p.national_id is null and p.no_national_id is null
          and (p.birth_date is null or p.birth_date <= current_date - interval '16 years') then 'national_id' end,
    case when nullif(trim(coalesce(p.sector, '')), '') is null then 'address' end,
    case when p.birth_date is null then 'age' end
  ], null)
$$;

-- ---------------------------------------------------------------- first free doctor
-- Reception (or anyone sending a patient on) may put the patient in several desks' queues at once.
-- The entries share a pool; the first doctor who takes the patient removes the others.
alter table queue_entry add column if not exists pool_id uuid;
alter table queue_entry add column if not exists taken_by uuid references profiles (id) on delete set null;
create index if not exists queue_pool_idx on queue_entry (pool_id) where pool_id is not null;

create or replace function send_to_stations(
  p_encounter_id uuid,
  p_station station,
  p_next station[]
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_pool uuid;
  v_next station;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_next is null or cardinality(p_next) = 0 then
    raise exception 'choose where the patient goes' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = p_station and finished_at is null;
  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
  v_pool := case when cardinality(p_next) > 1 then gen_random_uuid() end;
  foreach v_next in array p_next loop
    if exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = v_next
               and finished_at is null and deleted_at is null) then
      update queue_entry set pool_id = coalesce(v_pool, pool_id)
      where encounter_id = p_encounter_id and station = v_next and finished_at is null;
    else
      insert into queue_entry (encounter_id, station, ticket_no, pool_id)
      values (p_encounter_id, v_next, coalesce(v_ticket, 'A-000'), v_pool);
    end if;
  end loop;
  return jsonb_build_object('pool', v_pool, 'stations', to_jsonb(p_next));
end
$$;

-- "I take this patient": starts the patient at this desk and, for a shared entry, takes the
-- patient out of the other desks' queues. Refused if another doctor was faster.
create or replace function take_patient(p_queue_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_q queue_entry%rowtype;
  v_by text;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_q from queue_entry where id = p_queue_id and deleted_at is null;
  if not found then
    raise exception 'queue entry not found' using errcode = 'P0002';
  end if;
  -- Lock the whole pool so two doctors cannot take the same patient at the same moment.
  perform 1 from queue_entry
  where (pool_id is not null and pool_id = v_q.pool_id) or id = v_q.id
  for update;
  select * into v_q from queue_entry where id = p_queue_id;
  if v_q.finished_at is not null then
    select pr.full_name into v_by from queue_entry q join profiles pr on pr.id = q.taken_by
    where q.pool_id = v_q.pool_id and q.taken_by is not null limit 1;
    raise exception 'already taken by %', coalesce(v_by, 'another desk') using errcode = '23505';
  end if;
  if v_q.taken_by is not null and v_q.taken_by <> auth.uid() then
    select full_name into v_by from profiles where id = v_q.taken_by;
    raise exception 'already taken by %', coalesce(v_by, 'another doctor') using errcode = '23505';
  end if;
  update queue_entry
  set called_at = coalesce(called_at, now()), started_at = coalesce(started_at, now()),
      taken_by = auth.uid()
  where id = p_queue_id;
  if v_q.pool_id is not null then
    update queue_entry set finished_at = now()
    where pool_id = v_q.pool_id and id <> p_queue_id and finished_at is null;
  end if;
  return jsonb_build_object('encounterId', v_q.encounter_id, 'station', v_q.station);
end
$$;

create or replace view queue_board with (security_invoker = true) as
  select q.id as queue_id, q.encounter_id, q.station, q.ticket_no, q.priority,
         q.created_at as queued_at, q.called_at, q.started_at, q.finished_at,
         e.patient_id, e.triage_level, e.arrived_at, e.type as encounter_type,
         p.file_number, p.surname, p.given_names, p.sex, p.birth_date, p.phone_1,
         q.pool_id, tb.full_name as taken_by_name
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  join patient p on p.id = e.patient_id
  left join profiles tb on tb.id = q.taken_by
  where q.deleted_at is null and e.status = 'open';

-- ---------------------------------------------------------------- notification management
-- Each person may remove a notice from their own list (it stays for everyone else), see what
-- they sent with how many have read it, and the sender or the manager may delete a message.
alter table notification_read add column if not exists hidden_at timestamptz;

create or replace function my_notifications(p_limit integer default 30)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with mine as (
    select n.*, (r.user_id is not null) as is_read, sender.full_name as sender
    from notification n
    left join notification_read r on r.notification_id = n.id and r.user_id = auth.uid()
    left join profiles sender on sender.id = n.created_by
    where n.created_at > now() - interval '30 days' and notification_is_mine(n, auth.uid())
      and r.hidden_at is null
  )
  select jsonb_build_object(
    'unread', (select count(*) from mine where not is_read),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'at', created_at, 'kind', kind, 'params', params, 'title', title, 'body', body,
        'link', link, 'urgent', urgent, 'read', is_read, 'sender', sender
      ) order by created_at desc)
      from (select * from mine order by created_at desc limit greatest(1, least(p_limit, 200))) x
    ), '[]'::jsonb)
  )
$$;

create or replace function mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  insert into notification_read (notification_id, user_id)
  select n.id, auth.uid() from notification n
  where (p_ids is null or n.id = any (p_ids))
    and n.created_at > now() - interval '30 days'
    and notification_is_mine(n, auth.uid())
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- Unread → read when needed, then hidden from this person's list.
create or replace function hide_notifications(p_ids uuid[])
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  insert into notification_read (notification_id, user_id, hidden_at)
  select n.id, auth.uid(), now() from notification n
  where n.id = any (p_ids) and notification_is_mine(n, auth.uid())
  on conflict (notification_id, user_id) do update set hidden_at = now();
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

create or replace function my_sent_notifications(p_limit integer default 50)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb)
  from (
    select n.created_at as at, jsonb_build_object(
      'id', n.id, 'at', n.created_at, 'title', n.title, 'body', n.body, 'urgent', n.urgent,
      'to', case when n.to_all then 'all'
                 when n.recipient_user is not null then 'user'
                 when n.recipient_department is not null then 'department'
                 else 'role' end,
      'target', coalesce(ru.full_name, d.name, n.recipient_role::text),
      'headsOnly', n.heads_only,
      'readBy', (select count(*) from notification_read r where r.notification_id = n.id)
    ) as j
    from notification n
    left join profiles ru on ru.id = n.recipient_user
    left join department d on d.id = n.recipient_department
    where n.kind = 'message' and (n.created_by = auth.uid() or is_manager())
      and n.created_at > now() - interval '90 days'
    order by n.created_at desc
    limit greatest(1, least(p_limit, 200))
  ) x
$$;

create or replace function delete_notification(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  delete from notification
  where id = p_id and kind = 'message' and (created_by = auth.uid() or is_manager());
  if not found then
    raise exception 'message not found or not yours' using errcode = 'P0002';
  end if;
end
$$;

grant execute on function set_no_national_id(uuid, text), send_to_stations(uuid, station, station[]),
  take_patient(uuid), my_notifications(integer), mark_notifications_read(uuid[]),
  hide_notifications(uuid[]), my_sent_notifications(integer), delete_notification(uuid)
  to authenticated;
revoke execute on function set_no_national_id(uuid, text), send_to_stations(uuid, station, station[]),
  take_patient(uuid), my_notifications(integer), mark_notifications_read(uuid[]),
  hide_notifications(uuid[]), my_sent_notifications(integer), delete_notification(uuid)
  from anon, public;


-- ============================================================ 20261021180000_overnight_queue.sql
-- 0030 — Patients waiting overnight no longer vanish at midnight.
-- The queue counts only looked at entries created today, so a visit still open from yesterday
-- (e.g. sent to "any available doctor" in the evening) disappeared from "In the clinic", the
-- station tiles and the waiting counts. Waiting / being-seen now means: an unfinished entry of an
-- open visit, whatever day it started; averages stay "today". A patient shared between several
-- desks (first free doctor) counts once in the totals.

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
  -- Patients still waiting, whatever day they arrived; one patient shared by several desks counts once.
  select count(distinct q.encounter_id) into v_waiting
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  where q.finished_at is null and q.deleted_at is null and e.status = 'open';
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

create or replace function desk_summary()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_tiles jsonb;
  v_stations jsonb;
  v_hours jsonb;
  v_mine jsonb;
begin
  if not exists (select 1 from profiles where id = v_me and active) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'registeredToday', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date = v_today),
    'registeredYesterday', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date = v_today - 1),
    'visitsToday', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date = v_today),
    'visitsYesterday', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date = v_today - 1),
    'inClinic', (select count(*) from encounter where deleted_at is null and status = 'open'),
    'waitingNow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
                   where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'),
    'avgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at, now()) - q.created_at) / 60)), 0)
                   from queue_entry q where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'triageWaiting', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                      where q.deleted_at is null and q.station = 'triage' and q.finished_at is null and e.status = 'open'),
    'triageRed', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
                  where q.deleted_at is null and q.finished_at is null and e.status = 'open' and e.triage_level = 'red'),
    'triageYellow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
                     where q.deleted_at is null and q.finished_at is null and e.status = 'open' and e.triage_level = 'yellow'),
    'triageAvgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at, now()) - q.created_at) / 60)), 0)
                         from queue_entry q where q.deleted_at is null and q.station = 'triage'
                           and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'vitalsToday', (select count(distinct encounter_id) from observation where deleted_at is null and (effective_at at time zone 'Africa/Kigali')::date = v_today),
    'vitalsYesterday', (select count(distinct encounter_id) from observation where deleted_at is null and (effective_at at time zone 'Africa/Kigali')::date = v_today - 1),
    'apptsToday', (select count(*) from appointment where deleted_at is null
                   and status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed')
                   and (starts_at at time zone 'Africa/Kigali')::date = v_today),
    'inquiriesPending', (select count(*) from appointment where deleted_at is null and status = 'inquiry'),
    'bedsOccupied', (select count(*) from bed where deleted_at is null and status = 'occupied'),
    'bedsTotal', (select count(*) from bed where deleted_at is null and status <> 'out_of_service')
  ) into v_tiles;

  -- Where patients are right now: waiting / being seen per station, average wait today.
  select coalesce(jsonb_agg(jsonb_build_object('station', s.station, 'waiting', s.waiting, 'busy', s.busy, 'minutes', s.minutes)
                            order by s.station), '[]'::jsonb) into v_stations
  from (
    select q.station::text as station,
           count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open') as waiting,
           count(*) filter (where q.finished_at is null and q.started_at is not null and e.status = 'open') as busy,
           round(avg(extract(epoch from coalesce(q.started_at, q.finished_at, now()) - q.created_at) / 60)) as minutes
    from queue_entry q
    join encounter e on e.id = q.encounter_id
    where q.deleted_at is null
      and ((q.finished_at is null and e.status = 'open') or (q.created_at at time zone 'Africa/Kigali')::date = v_today)
    group by q.station
  ) s;

  -- Arrivals per hour today (06:00–21:00, plus any hour outside that had arrivals).
  select coalesce(jsonb_agg(jsonb_build_object('hour', h.hour, 'count', coalesce(a.n, 0)) order by h.hour), '[]'::jsonb) into v_hours
  from (
    select generate_series(6, 21) as hour
    union
    select extract(hour from arrived_at at time zone 'Africa/Kigali')::int
    from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date = v_today
  ) h
  left join (
    select extract(hour from arrived_at at time zone 'Africa/Kigali')::int as hour, count(*) as n
    from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date = v_today
    group by 1
  ) a on a.hour = h.hour;

  -- The caller's own work today (accountability, and a little motivation).
  select jsonb_build_object(
    'registrations', (select count(*) from patient where deleted_at is null and created_by = v_me and (created_at at time zone 'Africa/Kigali')::date = v_today),
    'visitsStarted', (select count(*) from encounter where deleted_at is null and created_by = v_me and (arrived_at at time zone 'Africa/Kigali')::date = v_today),
    'vitals', (select count(distinct encounter_id) from observation where deleted_at is null and performer_id = v_me and (effective_at at time zone 'Africa/Kigali')::date = v_today),
    'charges', (select count(*) from invoice_line where deleted_at is null and entered_by = v_me and (created_at at time zone 'Africa/Kigali')::date = v_today)
  ) into v_mine;

  return jsonb_build_object('tiles', v_tiles, 'stations', v_stations, 'arrivals', v_hours, 'mine', v_mine);
end
$$;

create or replace function dashboard_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := is_manager();
  v_days integer := greatest(1, p_to - p_from + 1);
  v_prev_from date := p_from - v_days;
  v_prev_to date := p_from - 1;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_tiles jsonb;
  v_rev30 jsonb;
  v_collections jsonb;
  v_receivables jsonb;
  v_visits jsonb;
  v_wait jsonb;
  v_queue jsonb;
  v_top jsonb;
  v_staff jsonb;
  v_reorder jsonb;
  v_expiring jsonb;
  v_noshow jsonb;
  v_messages jsonb;
  v_claims jsonb;
  v_logins jsonb;
  v_services jsonb;
begin
  if not (v_manager or exists (select 1 from profiles where id = auth.uid() and active and dashboard is not null)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  -- headline tiles
  select jsonb_build_object(
    'registered', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'registeredPrev', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'visits', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'visitsPrev', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'waitingNow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'),
    'avgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at, now()) - q.created_at) / 60)), 0)
                   from queue_entry q where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'revenue', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to) end,
    'revenuePrev', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to) end,
    'openBills', case when v_manager then (select count(*) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'openBillsDue', case when v_manager then (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'bedsOccupied', (select count(*) from bed where deleted_at is null and status = 'occupied'),
    'bedsTotal', (select count(*) from bed where deleted_at is null and status <> 'out_of_service')
  ) into v_tiles;

  -- revenue per day, last 30 days ending today
  select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'amount', coalesce(s.amount, 0)) order by d), '[]'::jsonb) into v_rev30
  from generate_series(v_today - 29, v_today, interval '1 day') d
  left join (
    select (paid_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
    from payment where deleted_at is null and paid_at >= (v_today - 29)::timestamp
    group by 1
  ) s on s.day = d::date;

  select coalesce(jsonb_agg(jsonb_build_object('method', m, 'amount', coalesce(s.amount, 0)) order by s.amount desc nulls last), '[]'::jsonb) into v_collections
  from unnest(array['cash', 'momo', 'airtel', 'card', 'bank']::payment_method[]) m
  left join (
    select method, sum(amount) as amount from payment
    where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by method
  ) s on s.method = m;

  select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'count', c.n, 'amount', c.amount) order by c.amount desc), '[]'::jsonb) into v_receivables
  from (
    select payer_id, count(*) as n, sum(amount) as amount from claim
    where deleted_at is null and status in ('open', 'batched', 'submitted', 'rejected', 'resubmitted')
    group by payer_id
  ) c join payer py on py.id = c.payer_id;

  -- visits by service group (charged lines in the range)
  select coalesce(jsonb_agg(jsonb_build_object('group', g.grp, 'count', g.n) order by g.n desc), '[]'::jsonb) into v_visits
  from (
    select coalesce(s.service_group::text, 'pharmacy') as grp, count(distinct i.encounter_id) as n
    from invoice_line l
    join invoice i on i.id = l.invoice_id
    left join service s on s.id = l.service_id
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by 1
  ) g;

  -- waiting time and queue by station (today)
  select coalesce(jsonb_agg(jsonb_build_object('station', w.station, 'minutes', w.minutes, 'waiting', w.waiting) order by w.station), '[]'::jsonb) into v_wait
  from (
    select q.station::text as station,
           round(avg(extract(epoch from coalesce(q.started_at, q.finished_at, now()) - q.created_at) / 60)) as minutes,
           count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open') as waiting
    from queue_entry q
    join encounter e on e.id = q.encounter_id
    where q.deleted_at is null
      and ((q.finished_at is null and e.status = 'open') or (q.created_at at time zone 'Africa/Kigali')::date = v_today)
    group by q.station
  ) w;

  -- top treatments in the range
  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'count', x.n, 'amount', case when v_manager then x.amount end) order by x.n desc), '[]'::jsonb) into v_top
  from (
    select l.description as name, count(*) as n, sum(round(l.unit_price * l.quantity)) as amount
    from invoice_line l
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by l.description
    order by count(*) desc
    limit 10
  ) x;

  -- who did what (accountability)
  select coalesce(jsonb_agg(jsonb_build_object(
      'name', p.full_name, 'role', p.role, 'staffId', p.staff_id,
      'registrations', coalesce(r.n, 0), 'vitals', coalesce(v.n, 0), 'charges', coalesce(c.n, 0),
      'payments', case when v_manager then coalesce(pm.n, 0) end,
      'collected', case when v_manager then coalesce(pm.amount, 0) end,
      'lastSignIn', p.last_sign_in_at
    ) order by (coalesce(r.n, 0) + coalesce(v.n, 0) + coalesce(c.n, 0) + coalesce(pm.n, 0)) desc, p.full_name), '[]'::jsonb) into v_staff
  from profiles p
  left join (select created_by as id, count(*) as n from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) r on r.id = p.id
  left join (select performer_id as id, count(distinct encounter_id) as n from observation where deleted_at is null and (effective_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) v on v.id = p.id
  left join (select entered_by as id, count(*) as n from invoice_line where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) c on c.id = p.id
  left join (select cashier_id as id, count(*) as n, sum(amount) as amount from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) pm on pm.id = p.id
  where p.active;

  -- stock
  select coalesce(jsonb_agg(jsonb_build_object('name', name_generic, 'onHand', on_hand, 'min', reorder_level) order by (on_hand::numeric / greatest(reorder_level, 1))), '[]'::jsonb) into v_reorder
  from items_below_reorder where on_hand < reorder_level;

  select jsonb_build_object(
    'd30', count(*) filter (where s.expiry <= v_today + 30),
    'd60', count(*) filter (where s.expiry > v_today + 30 and s.expiry <= v_today + 60),
    'd90', count(*) filter (where s.expiry > v_today + 60 and s.expiry <= v_today + 90)
  ) into v_expiring
  from (select batch_id, expiry, sum(quantity) as q from stock_on_hand where expiry is not null group by batch_id, expiry) s
  where s.q > 0;

  -- bookings
  select jsonb_build_object(
    'booked', count(*) filter (where status in ('confirmed', 'arrived', 'in_progress', 'completed', 'no_show')),
    'missed', count(*) filter (where status = 'no_show'),
    'pending', count(*) filter (where status = 'inquiry')
  ) into v_noshow
  from appointment where deleted_at is null and (coalesce(starts_at, created_at) at time zone 'Africa/Kigali')::date between p_from and p_to;

  select coalesce(jsonb_agg(jsonb_build_object('channel', ch, 'sent', coalesce(s.sent, 0), 'failed', coalesce(s.failed, 0)) order by ch), '[]'::jsonb) into v_messages
  from unnest(array['whatsapp', 'sms', 'email']::message_channel[]) ch
  left join (
    select channel, count(*) filter (where status in ('sent', 'delivered')) as sent, count(*) filter (where status = 'failed') as failed
    from message where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by channel
  ) s on s.channel = ch;

  select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'count', c.n, 'amount', case when v_manager then c.amount end) order by c.amount desc), '[]'::jsonb) into v_claims
  from (select payer_id, count(*) as n, sum(amount) as amount from claim where deleted_at is null and status = 'open' group by payer_id) c
  join payer py on py.id = c.payer_id;

  select coalesce(jsonb_agg(jsonb_build_object('name', p.full_name, 'role', p.role, 'at', a.at, 'reason', a.reason) order by a.at desc), '[]'::jsonb) into v_logins
  from (select actor_id, at, reason from audit_event where action = 'login' and at > now() - interval '1 day' order by at desc limit 12) a
  join profiles p on p.id = a.actor_id;

  select jsonb_build_object('active', count(*) filter (where active), 'total', count(*)) into v_services from service where deleted_at is null;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'manager', v_manager, 'generatedAt', now(),
    'tiles', v_tiles, 'revenue30d', v_rev30, 'collections', v_collections, 'receivables', v_receivables,
    'visitsByGroup', v_visits, 'waitByStation', v_wait, 'topTreatments', v_top, 'staff', v_staff,
    'reorder', v_reorder, 'expiring', v_expiring, 'bookings', v_noshow, 'messages', v_messages,
    'claims', v_claims, 'logins', v_logins, 'services', v_services
  );
end
$$;


-- ============================================================ 20261022090000_history_pins_prefs.sql
-- 0031 — Activity history, visible temporary PINs, preferences on every device, tidy queue notices.

-- ---------------------------------------------------------------- temporary PIN, visible to the manager
-- The first PIN the manager hands over (or a reset PIN) stays readable by managers until the
-- employee replaces it; then it is deleted. Only managers can read it; only the server writes it.
create table if not exists staff_temp_pin (
  user_id uuid primary key references profiles (id) on delete cascade,
  pin text not null check (pin ~ '^[0-9]{6}$'),
  set_at timestamptz not null default now(),
  set_by uuid references profiles (id) on delete set null
);
alter table staff_temp_pin enable row level security;
drop policy if exists staff_temp_pin_read on staff_temp_pin;
create policy staff_temp_pin_read on staff_temp_pin for select to authenticated using (is_manager());
revoke insert, update, delete on staff_temp_pin from authenticated, anon;

create or replace function mark_pin_changed()
returns void
language sql security definer set search_path = public
as $$
  update profiles set must_change_pin = false, pin_changed_at = now() where id = auth.uid();
  delete from staff_temp_pin where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------- preferences that follow the person
-- Text size, theme and language are saved on the profile, so every device the person signs in on
-- looks the same.
alter table profiles add column if not exists prefs jsonb not null default '{}'::jsonb;

create or replace function my_prefs()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(prefs, '{}'::jsonb) from profiles where id = auth.uid()
$$;

create or replace function save_my_prefs(p_prefs jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if jsonb_typeof(p_prefs) <> 'object' or length(p_prefs::text) > 2000 then
    raise exception 'invalid preferences' using errcode = '22023';
  end if;
  update profiles set prefs = coalesce(prefs, '{}'::jsonb) || p_prefs where id = auth.uid();
end
$$;

-- ---------------------------------------------------------------- queue notices: one per pool, removed when done
create or replace function notify_queue_entry()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_triage text;
begin
  -- A patient sent to several desks at once is announced once by send_to_stations().
  if new.pool_id is not null then
    return new;
  end if;
  select p.surname || ' ' || p.given_names, e.triage_level::text into v_name, v_triage
  from encounter e join patient p on p.id = e.patient_id where e.id = new.encounter_id;
  insert into notification (kind, params, link, urgent, recipient_role, created_by)
  values ('queue',
          jsonb_build_object('ticket', new.ticket_no, 'name', v_name, 'station', new.station,
                             'triage', v_triage, 'queue', new.id),
          '/app/visit?encounter=' || new.encounter_id,
          coalesce(v_triage, '') = 'red' or new.priority = 1,
          station_role(new.station),
          auth.uid());
  return new;
end
$$;

-- When the patient leaves a desk (or a doctor takes a shared patient), the "waiting" notice is
-- no longer news: it is removed from everyone's list.
create or replace function clear_queue_notice()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.finished_at is not null and old.finished_at is null then
    delete from notification where kind = 'queue' and params ->> 'queue' = new.id::text;
  end if;
  if new.pool_id is not null and new.started_at is not null and old.started_at is null then
    delete from notification where kind = 'queue_pool' and params ->> 'pool' = new.pool_id::text;
  end if;
  return new;
end
$$;
drop trigger if exists trg_clear_queue_notice on queue_entry;
create trigger trg_clear_queue_notice after update on queue_entry
  for each row execute function clear_queue_notice();

create or replace function send_to_stations(
  p_encounter_id uuid,
  p_station station,
  p_next station[]
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_pool uuid;
  v_next station;
  v_name text;
  v_triage text;
  v_role role_key;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_next is null or cardinality(p_next) = 0 then
    raise exception 'choose where the patient goes' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = p_station and finished_at is null;
  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
  v_pool := case when cardinality(p_next) > 1 then gen_random_uuid() end;
  foreach v_next in array p_next loop
    if exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = v_next
               and finished_at is null and deleted_at is null) then
      update queue_entry set pool_id = coalesce(v_pool, pool_id)
      where encounter_id = p_encounter_id and station = v_next and finished_at is null;
    else
      insert into queue_entry (encounter_id, station, ticket_no, pool_id)
      values (p_encounter_id, v_next, coalesce(v_ticket, 'A-000'), v_pool);
    end if;
  end loop;
  -- One notice per role for the whole pool ("waiting for the first free doctor: …").
  if v_pool is not null then
    select p.surname || ' ' || p.given_names, e.triage_level::text into v_name, v_triage
    from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id;
    for v_role in select distinct station_role(s) from unnest(p_next) as s loop
      insert into notification (kind, params, link, urgent, recipient_role, created_by)
      values ('queue_pool',
              jsonb_build_object('ticket', coalesce(v_ticket, 'A-000'), 'name', v_name,
                                 'stations', to_jsonb(p_next), 'triage', v_triage, 'pool', v_pool),
              '/app/visit?encounter=' || p_encounter_id,
              coalesce(v_triage, '') = 'red',
              v_role,
              auth.uid());
    end loop;
  end if;
  return jsonb_build_object('pool', v_pool, 'stations', to_jsonb(p_next));
end
$$;

-- ---------------------------------------------------------------- activity history
-- Every change to the clinic's records is already written to audit_event by a trigger (who, when,
-- what, before / after), plus sign-ins and staff / settings changes. This reads it for the
-- manager, newest first, with the person, a group for filtering and a short readable detail.
create or replace function activity_group(p_entity text, p_action audit_action)
returns text
language sql immutable
as $$
  select case
    when p_action = 'login' then 'signin'
    when p_entity in ('patient', 'encounter', 'appointment', 'coverage') then 'patients'
    when p_entity = 'observation' then 'vitals'
    when p_entity = 'queue_entry' then 'queue'
    when p_entity in ('invoice', 'invoice_line', 'payment', 'credit_note', 'day_close', 'claim') then 'billing'
    when p_entity in ('condition', 'medication_request', 'service_request', 'procedure',
                      'diagnostic_report', 'internal_task', 'vaccination', 'medication_dispense',
                      'hiv_test', 'fp_event') then 'clinical'
    when p_entity in ('bed', 'bed_stay') then 'beds'
    when p_entity in ('profiles', 'setting', 'department', 'service', 'payer', 'plan', 'price_list',
                      'price_list_item', 'practitioner') or p_action = 'settings' then 'admin'
    else 'other'
  end
$$;

create or replace function activity_history(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_actor uuid default null,
  p_group text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '7 days');
  v_to timestamptz := coalesce(p_to, now());
  v_total integer;
  v_items jsonb;
begin
  if not is_manager() then
    raise exception 'only the manager can read the activity history' using errcode = '42501';
  end if;
  with ev as (
    select a.*, activity_group(a.entity, a.action) as grp, coalesce(a.after, a.before) as row
    from audit_event a
    where a.at >= v_from and a.at < v_to and a.action <> 'read'
      and (p_actor is null or a.actor_id = p_actor)
      and (p_group is null or activity_group(a.entity, a.action) = p_group)
  )
  select count(*) into v_total from ev;

  with ev as (
    select a.*, activity_group(a.entity, a.action) as grp, coalesce(a.after, a.before) as row
    from audit_event a
    where a.at >= v_from and a.at < v_to and a.action <> 'read'
      and (p_actor is null or a.actor_id = p_actor)
      and (p_group is null or activity_group(a.entity, a.action) = p_group)
    order by a.at desc
    limit greatest(1, least(p_limit, 500)) offset greatest(p_offset, 0)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', ev.id,
      'at', ev.at,
      'action', ev.action,
      'entity', ev.entity,
      'group', ev.grp,
      'actor', pr.full_name,
      'actorRole', pr.role,
      'actorStaffId', pr.staff_id,
      'patient', coalesce(
        case when ev.entity = 'patient' then (ev.row ->> 'surname') || ' ' || (ev.row ->> 'given_names') end,
        pe.surname || ' ' || pe.given_names,
        pp.surname || ' ' || pp.given_names),
      'detail', case ev.entity
        when 'observation' then (ev.row ->> 'code') || ' ' || coalesce(ev.row ->> 'value_num', ev.row ->> 'value_text', '')
        when 'invoice_line' then (ev.row ->> 'description') || ' · ' ||
             round(coalesce((ev.row ->> 'unit_price')::numeric, 0) * coalesce((ev.row ->> 'quantity')::numeric, 1))
        when 'payment' then (ev.row ->> 'method') || ' · ' || (ev.row ->> 'amount')
        when 'queue_entry' then (ev.row ->> 'ticket_no') || ' · ' || (ev.row ->> 'station') ||
             case when ev.action = 'update' and ev.after ->> 'finished_at' is not null
                       and ev.before ->> 'finished_at' is null then ' · done'
                  when ev.action = 'update' and ev.after ->> 'started_at' is not null
                       and ev.before ->> 'started_at' is null then ' · taken'
                  else '' end
        when 'encounter' then coalesce(ev.row ->> 'status', '')
        when 'bed_stay' then coalesce(ev.row ->> 'planned_nights', '') || ' night(s)'
        when 'profiles' then coalesce(ev.after ->> 'manage_staff', ev.row ->> 'username', '')
        else coalesce(ev.row ->> 'name', ev.row ->> 'title', ev.row ->> 'description',
                      ev.row ->> 'name_en', ev.row ->> 'code', ev.reason, '')
      end,
      'reason', ev.reason
    ) order by ev.at desc), '[]'::jsonb)
  into v_items
  from ev
  left join profiles pr on pr.id = ev.actor_id
  left join encounter en on en.id = case when ev.entity = 'encounter' then ev.entity_id
                                         else nullif(ev.row ->> 'encounter_id', '')::uuid end
  left join patient pe on pe.id = en.patient_id
  left join patient pp on pp.id = nullif(ev.row ->> 'patient_id', '')::uuid and en.id is null;

  return jsonb_build_object('total', v_total, 'items', v_items, 'from', v_from, 'to', v_to);
end
$$;

grant execute on function my_prefs(), save_my_prefs(jsonb), activity_history(timestamptz, timestamptz, uuid, text, integer, integer),
  send_to_stations(uuid, station, station[]) to authenticated;
revoke execute on function my_prefs(), save_my_prefs(jsonb), activity_history(timestamptz, timestamptz, uuid, text, integer, integer),
  send_to_stations(uuid, station, station[]), clear_queue_notice(), activity_group(text, audit_action) from anon, public;
grant execute on function activity_group(text, audit_action) to authenticated;


-- ============================================================ 20261022093000_old_queue_notices.sql
-- 0032 — Remove "waiting at …" notices created before 0031 that are no longer true.
-- From 0031 on, a queue notice is deleted when the patient leaves the desk, and a patient sent to
-- several desks gets one shared notice. Older notices carry no queue id, so they are tidied here:
-- a notice stays only while that patient still waits, alone (not shared), at that desk.
delete from notification n
where n.kind = 'queue'
  and not (n.params ? 'queue')
  and not exists (
    select 1
    from queue_entry q
    where q.encounter_id::text = substring(n.link from 'encounter=([0-9a-f-]{36})')
      and q.station::text = n.params ->> 'station'
      and q.finished_at is null
      and q.deleted_at is null
      and q.pool_id is null
  );


-- ============================================================ 20261022110000_history_for_everyone.sql
-- 0033 — Activity history on every dashboard: each person sees what they did themselves; the
-- manager still sees everyone's (and can filter by person).

create or replace function activity_history(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_actor uuid default null,
  p_group text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '7 days');
  v_to timestamptz := coalesce(p_to, now());
  v_total integer;
  v_items jsonb;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- Everyone sees their own activity; only the manager sees everybody's (and may pick a person).
  if not is_manager() then
    p_actor := auth.uid();
  end if;
  with ev as (
    select a.*, activity_group(a.entity, a.action) as grp, coalesce(a.after, a.before) as row
    from audit_event a
    where a.at >= v_from and a.at < v_to and a.action <> 'read'
      and (p_actor is null or a.actor_id = p_actor)
      and (p_group is null or activity_group(a.entity, a.action) = p_group)
  )
  select count(*) into v_total from ev;

  with ev as (
    select a.*, activity_group(a.entity, a.action) as grp, coalesce(a.after, a.before) as row
    from audit_event a
    where a.at >= v_from and a.at < v_to and a.action <> 'read'
      and (p_actor is null or a.actor_id = p_actor)
      and (p_group is null or activity_group(a.entity, a.action) = p_group)
    order by a.at desc
    limit greatest(1, least(p_limit, 500)) offset greatest(p_offset, 0)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', ev.id,
      'at', ev.at,
      'action', ev.action,
      'entity', ev.entity,
      'group', ev.grp,
      'actor', pr.full_name,
      'actorRole', pr.role,
      'actorStaffId', pr.staff_id,
      'patient', coalesce(
        case when ev.entity = 'patient' then (ev.row ->> 'surname') || ' ' || (ev.row ->> 'given_names') end,
        pe.surname || ' ' || pe.given_names,
        pp.surname || ' ' || pp.given_names),
      'detail', case ev.entity
        when 'observation' then (ev.row ->> 'code') || ' ' || coalesce(ev.row ->> 'value_num', ev.row ->> 'value_text', '')
        when 'invoice_line' then (ev.row ->> 'description') || ' · ' ||
             round(coalesce((ev.row ->> 'unit_price')::numeric, 0) * coalesce((ev.row ->> 'quantity')::numeric, 1))
        when 'payment' then (ev.row ->> 'method') || ' · ' || (ev.row ->> 'amount')
        when 'queue_entry' then (ev.row ->> 'ticket_no') || ' · ' || (ev.row ->> 'station') ||
             case when ev.action = 'update' and ev.after ->> 'finished_at' is not null
                       and ev.before ->> 'finished_at' is null then ' · done'
                  when ev.action = 'update' and ev.after ->> 'started_at' is not null
                       and ev.before ->> 'started_at' is null then ' · taken'
                  else '' end
        when 'encounter' then coalesce(ev.row ->> 'status', '')
        when 'bed_stay' then coalesce(ev.row ->> 'planned_nights', '') || ' night(s)'
        when 'profiles' then coalesce(ev.after ->> 'manage_staff', ev.row ->> 'username', '')
        else coalesce(ev.row ->> 'name', ev.row ->> 'title', ev.row ->> 'description',
                      ev.row ->> 'name_en', ev.row ->> 'code', ev.reason, '')
      end,
      'reason', ev.reason
    ) order by ev.at desc), '[]'::jsonb)
  into v_items
  from ev
  left join profiles pr on pr.id = ev.actor_id
  left join encounter en on en.id = case when ev.entity = 'encounter' then ev.entity_id
                                         else nullif(ev.row ->> 'encounter_id', '')::uuid end
  left join patient pe on pe.id = en.patient_id
  left join patient pp on pp.id = nullif(ev.row ->> 'patient_id', '')::uuid and en.id is null;

  return jsonb_build_object('total', v_total, 'items', v_items, 'from', v_from, 'to', v_to);
end
$$;


-- ============================================================ 20261022140000_referrals.sql
-- 0034 — Referrals between doctors, departments and the laboratory.
-- A doctor (or anyone who sends patients on) can hand a patient to another desk, optionally to a
-- named colleague, with a reason, and ask for the patient to come back afterwards (e.g. to the
-- lab for a test, then back to the same doctor with the result). The receiver is told why, sees
-- who referred, and sends the patient back with one action.

alter table queue_entry add column if not exists assigned_to uuid references profiles (id) on delete set null;
alter table queue_entry add column if not exists referred_by uuid references profiles (id) on delete set null;
alter table queue_entry add column if not exists referral_note text;
alter table queue_entry add column if not exists return_station station;
alter table queue_entry add column if not exists return_to uuid references profiles (id) on delete set null;

-- Colleagues a patient can be handed to (active staff; no contact details).
create or replace function colleagues()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.full_name, 'role', p.role, 'station', p.station,
      'department', d.name, 'staffId', p.staff_id
    ) order by p.full_name), '[]'::jsonb)
  from profiles p
  left join department d on d.id = p.department_id
  where p.active and has_perm('queue.read')
$$;

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

-- Where the patient is now, who referred them and whether they must go back (for the visit screen).
create or replace function visit_routing(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'queueId', q.id, 'station', q.station, 'since', q.created_at,
      'assignedTo', q.assigned_to, 'assignedName', a.full_name,
      'referredBy', q.referred_by, 'referredName', r.full_name, 'note', q.referral_note,
      'returnStation', q.return_station, 'returnTo', q.return_to, 'returnName', b.full_name
    ) order by q.created_at), '[]'::jsonb)
  from queue_entry q
  left join profiles a on a.id = q.assigned_to
  left join profiles r on r.id = q.referred_by
  left join profiles b on b.id = q.return_to
  where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
    and has_perm('queue.read')
$$;

-- Queue notices: a referral tells the colleague (or the desk's role) who referred and why.
create or replace function notify_queue_entry()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_triage text;
  v_by text;
begin
  if new.pool_id is not null then
    return new;
  end if;
  select p.surname || ' ' || p.given_names, e.triage_level::text into v_name, v_triage
  from encounter e join patient p on p.id = e.patient_id where e.id = new.encounter_id;
  if new.referred_by is not null then
    select full_name into v_by from profiles where id = new.referred_by;
    insert into notification (kind, params, link, urgent, recipient_user, recipient_role, created_by)
    values ('referral',
            jsonb_build_object('ticket', new.ticket_no, 'name', v_name, 'station', new.station,
                               'by', v_by, 'note', new.referral_note, 'queue', new.id,
                               'back', new.return_station is not null),
            '/app/visit?encounter=' || new.encounter_id,
            coalesce(v_triage, '') = 'red' or new.priority = 1,
            new.assigned_to,
            case when new.assigned_to is null then station_role(new.station) end,
            auth.uid());
    return new;
  end if;
  insert into notification (kind, params, link, urgent, recipient_role, created_by)
  values ('queue',
          jsonb_build_object('ticket', new.ticket_no, 'name', v_name, 'station', new.station,
                             'triage', v_triage, 'queue', new.id),
          '/app/visit?encounter=' || new.encounter_id,
          coalesce(v_triage, '') = 'red' or new.priority = 1,
          station_role(new.station),
          auth.uid());
  return new;
end
$$;

-- An existing waiting entry turned into a referral (update) also tells the receiver.
create or replace function notify_referral_update()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.referred_by is not null and new.finished_at is null
     and (old.referred_by is distinct from new.referred_by or old.assigned_to is distinct from new.assigned_to
          or old.referral_note is distinct from new.referral_note) then
    perform notify_queue_entry_row(new);
  end if;
  return new;
end
$$;

create or replace function notify_queue_entry_row(q queue_entry)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_by text;
begin
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = q.encounter_id;
  select full_name into v_by from profiles where id = q.referred_by;
  delete from notification where kind in ('queue', 'referral') and params ->> 'queue' = q.id::text;
  insert into notification (kind, params, link, recipient_user, recipient_role, created_by)
  values ('referral',
          jsonb_build_object('ticket', q.ticket_no, 'name', v_name, 'station', q.station, 'by', v_by,
                             'note', q.referral_note, 'queue', q.id, 'back', q.return_station is not null),
          '/app/visit?encounter=' || q.encounter_id,
          q.assigned_to,
          case when q.assigned_to is null then station_role(q.station) end,
          auth.uid());
end
$$;
drop trigger if exists trg_notify_referral_update on queue_entry;
create trigger trg_notify_referral_update after update on queue_entry
  for each row execute function notify_referral_update();

create or replace function clear_queue_notice()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.finished_at is not null and old.finished_at is null then
    delete from notification where kind in ('queue', 'referral') and params ->> 'queue' = new.id::text;
  end if;
  if new.pool_id is not null and new.started_at is not null and old.started_at is null then
    delete from notification where kind = 'queue_pool' and params ->> 'pool' = new.pool_id::text;
  end if;
  return new;
end
$$;

create or replace view queue_board with (security_invoker = true) as
  select q.id as queue_id, q.encounter_id, q.station, q.ticket_no, q.priority,
         q.created_at as queued_at, q.called_at, q.started_at, q.finished_at,
         e.patient_id, e.triage_level, e.arrived_at, e.type as encounter_type,
         p.file_number, p.surname, p.given_names, p.sex, p.birth_date, p.phone_1,
         q.pool_id, tb.full_name as taken_by_name,
         q.assigned_to, asg.full_name as assigned_name, rb.full_name as referred_by_name,
         q.referral_note, q.return_station
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  join patient p on p.id = e.patient_id
  left join profiles tb on tb.id = q.taken_by
  left join profiles asg on asg.id = q.assigned_to
  left join profiles rb on rb.id = q.referred_by
  where q.deleted_at is null and e.status = 'open';

grant execute on function colleagues(), refer_patient(uuid, station, station, uuid, text, boolean),
  visit_routing(uuid) to authenticated;
revoke execute on function colleagues(), refer_patient(uuid, station, station, uuid, text, boolean),
  visit_routing(uuid), notify_referral_update(), notify_queue_entry_row(queue_entry) from anon, public;


-- ============================================================ 20261022170000_results_room_cover.sql
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


-- ============================================================ 20261023090000_lab_finance.sql
-- 0036 — Laboratory and finance dashboards.
-- Laboratory: the worklist of tests ordered (lab for lab technicians, imaging for sonographers,
-- both for the manager), sample taken / in process, the day's figures.
-- Finance: what the cashier collected (by method, by person), the payments of a day, open bills.

-- Which test categories this person works on.
create or replace function my_test_categories()
returns request_category[]
language sql stable security definer set search_path = public
as $$
  select case current_role_key()
    when 'lab_tech' then array['lab']::request_category[]
    when 'sonographer' then array['imaging']::request_category[]
    else array['lab', 'imaging']::request_category[]
  end
$$;

-- p_scope: 'open' (not verified, not cancelled) or 'done' (resulted or verified today).
create or replace function lab_worklist(p_scope text default 'open')
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.prio, x.at), '[]'::jsonb)
  from (
    select r.priority as prio, r.created_at as at, jsonb_build_object(
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
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by))
    ) as j
    from service_request r
    join encounter e on e.id = r.encounter_id
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and has_perm('orders.read')
      and r.category = any (my_test_categories())
      and case when p_scope = 'done'
            then r.status in ('resulted', 'verified')
                 and (coalesce(d.verified_at, d.updated_at) at time zone 'Africa/Kigali')::date
                     = (now() at time zone 'Africa/Kigali')::date
            else r.status not in ('verified', 'cancelled') end
  ) x
$$;

-- Sample taken / in process (or cancelled with a reason).
create or replace function set_request_status(p_id uuid, p_status request_status, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('orders.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_status not in ('collected', 'in_process', 'cancelled') then
    raise exception 'use record_result for results' using errcode = '22023';
  end if;
  if p_status = 'cancelled' and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'a reason is required to cancel a test' using errcode = '22023';
  end if;
  update service_request
  set status = p_status,
      reason = case when p_status = 'cancelled' then coalesce(reason || ' · ', '') || 'cancelled: ' || trim(p_reason) else reason end
  where id = p_id and deleted_at is null and status not in ('verified', 'cancelled');
  if not found then
    raise exception 'test not found or already finished' using errcode = 'P0002';
  end if;
end
$$;

create or replace function lab_summary()
returns jsonb
language sql stable security definer set search_path = public
as $$
  with today as (select (now() at time zone 'Africa/Kigali')::date as d),
  mine as (
    select r.*, d.verified_at, d.updated_at as result_at
    from service_request r
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and r.category = any (my_test_categories()) and has_perm('orders.read')
  )
  select jsonb_build_object(
    'waiting', (select count(*) from mine where status = 'ordered'),
    'inProcess', (select count(*) from mine where status in ('collected', 'in_process')),
    'toVerify', (select count(*) from mine where status = 'resulted'),
    'doneToday', (select count(*) from mine, today
                  where status = 'verified' and (verified_at at time zone 'Africa/Kigali')::date = today.d),
    'urgent', (select count(*) from mine where status not in ('verified', 'cancelled') and priority <= 2),
    'orderedToday', (select count(*) from mine, today where (created_at at time zone 'Africa/Kigali')::date = today.d),
    'turnaroundMin', (select coalesce(round(avg(extract(epoch from verified_at - created_at) / 60)), 0)
                      from mine, today
                      where verified_at is not null and (verified_at at time zone 'Africa/Kigali')::date = today.d),
    'byTest', coalesce((
      select jsonb_agg(jsonb_build_object('test', t.name, 'count', t.n) order by t.n desc)
      from (select s.name_en as name, count(*) as n
            from mine m join service s on s.id = m.service_id, today
            where (m.created_at at time zone 'Africa/Kigali')::date = today.d
            group by s.name_en order by count(*) desc limit 8) t
    ), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------- finance
-- One day of money: totals by method, by cashier, the payments, open bills (p_day: Kigali date).
create or replace function cashier_summary(p_day date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_day date := coalesce(p_day, (now() at time zone 'Africa/Kigali')::date);
begin
  if not has_perm('billing.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'day', v_day,
    'total', (select coalesce(sum(amount), 0) from payment
              where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date = v_day),
    'count', (select count(*) from payment
              where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date = v_day),
    'previousTotal', (select coalesce(sum(amount), 0) from payment
                      where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date = v_day - 1),
    'mine', (select coalesce(sum(amount), 0) from payment
             where deleted_at is null and cashier_id = auth.uid()
               and (paid_at at time zone 'Africa/Kigali')::date = v_day),
    'byMethod', coalesce((
      select jsonb_agg(jsonb_build_object('method', m.method, 'amount', m.amount, 'count', m.n) order by m.amount desc)
      from (select method::text as method, sum(amount) as amount, count(*) as n from payment
            where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date = v_day
            group by method) m
    ), '[]'::jsonb),
    'byCashier', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.name, 'amount', c.amount, 'count', c.n) order by c.amount desc)
      from (select coalesce(pr.full_name, '—') as name, sum(pa.amount) as amount, count(*) as n
            from payment pa left join profiles pr on pr.id = pa.cashier_id
            where pa.deleted_at is null and (pa.paid_at at time zone 'Africa/Kigali')::date = v_day
            group by pr.full_name) c
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', pa.id, 'at', pa.paid_at, 'method', pa.method, 'amount', pa.amount, 'reference', pa.reference,
          'invoice', i.number, 'encounterId', i.encounter_id,
          'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
          'cashier', pr.full_name
        ) order by pa.paid_at desc)
      from payment pa
      join invoice i on i.id = pa.invoice_id
      join encounter e on e.id = i.encounter_id
      join patient p on p.id = e.patient_id
      left join profiles pr on pr.id = pa.cashier_id
      where pa.deleted_at is null and (pa.paid_at at time zone 'Africa/Kigali')::date = v_day
    ), '[]'::jsonb),
    'openBills', (select count(*) from invoice i join encounter e on e.id = i.encounter_id
                  where i.deleted_at is null and i.status = 'draft' and e.status = 'open' and invoice_balance(i.id) > 0),
    'openDue', (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id
                where i.deleted_at is null and i.status = 'draft' and e.status = 'open' and invoice_balance(i.id) > 0)
  );
end
$$;

grant execute on function my_test_categories(), lab_worklist(text), set_request_status(uuid, request_status, text),
  lab_summary(), cashier_summary(date) to authenticated;
revoke execute on function my_test_categories(), lab_worklist(text), set_request_status(uuid, request_status, text),
  lab_summary(), cashier_summary(date) from anon, public;


-- ============================================================ 20261024090000_calendars_departments.sql
-- 0037 · Doctors' own calendars (and who may see them) and treatments by department.
--
-- Calendars: each doctor (or sonographer) keeps one calendar, linked to their account: the
-- working hours of each weekday, the length of a booking slot, days off, a short note, and who
-- may see it: only themselves ('private'), the staff ('staff'), or the staff and the public
-- ('public'). The public site lists only public calendars of real, active accounts; the staff
-- home pages list staff and public ones. The manager may keep any doctor's calendar.
--
-- Departments: every treatment may belong to one department, so the manager adds the
-- services of each department with their price and follows what each department bills.

-- ---------------------------------------------------------------- calendars
alter table practitioner add column if not exists calendar_visibility text not null default 'public'
  check (calendar_visibility in ('private', 'staff', 'public'));
alter table practitioner add column if not exists days_off date[] not null default '{}';
alter table practitioner add column if not exists calendar_note text;
alter table practitioner add column if not exists department_id uuid references department (id);
create unique index if not exists practitioner_user_uq on practitioner (user_id)
  where user_id is not null and deleted_at is null;

-- Public calendars of real, active accounts only (sample practitioners stay off the site).
create or replace view public_practitioners as
  select pr.id, pr.code, pr.names, pr.title, pr.specialty, pr.categories, pr.languages,
         pr.working_hours, pr.slot_minutes, pr.days_off, pr.calendar_note
  from practitioner pr
  where pr.active and pr.deleted_at is null and pr.calendar_visibility = 'public'
    and pr.user_id is not null
    and exists (select 1 from profiles p where p.id = pr.user_id and p.active);
grant select on public_practitioners to anon, authenticated;

-- Working at this moment: the weekday's hours, unless that date is a day off.
create or replace function practitioner_is_working(p_practitioner_id uuid, p_at timestamptz)
returns boolean
language plpgsql stable
as $$
declare
  v_hours jsonb;
  v_off date[];
  v_day text;
  v_span jsonb;
  v_time time;
begin
  select working_hours, days_off into v_hours, v_off
  from practitioner where id = p_practitioner_id and active and deleted_at is null;
  if v_hours is null then
    return false;
  end if;
  if (p_at at time zone 'Africa/Kigali')::date = any (coalesce(v_off, '{}')) then
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

create or replace function calendar_json(pr practitioner)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', pr.id, 'userId', pr.user_id, 'code', pr.code, 'name', pr.names, 'title', pr.title,
    'specialty', pr.specialty, 'categories', to_jsonb(pr.categories), 'languages', pr.languages,
    'hours', pr.working_hours, 'slotMinutes', pr.slot_minutes, 'daysOff', to_jsonb(pr.days_off),
    'note', pr.calendar_note, 'visibility', pr.calendar_visibility,
    'department', (select d.name from department d
                   where d.deleted_at is null
                     and d.id = coalesce(pr.department_id, (select p.department_id from profiles p where p.id = pr.user_id))),
    'mine', pr.user_id = auth.uid(),
    'workingNow', practitioner_is_working(pr.id, now())
  )
$$;

-- Staff home pages: the calendars shared with the staff (or the public), plus one's own.
create or replace function staff_doctor_calendars()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(calendar_json(pr) order by pr.names), '[]'::jsonb)
  from practitioner pr
  join profiles p on p.id = pr.user_id and p.active
  where auth.uid() is not null and pr.active and pr.deleted_at is null
    and (pr.calendar_visibility in ('staff', 'public') or pr.user_id = auth.uid())
$$;

-- Who may keep a calendar: doctors and sonographers.
create or replace function calendar_role_ok(p_user uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from profiles where id = p_user and active and role in ('doctor', 'sonographer'))
$$;

-- The calendar of a person (default: me). Empty skeleton when none is saved yet.
create or replace function my_calendar(p_user uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_user uuid := coalesce(p_user, auth.uid());
  v_pr practitioner%rowtype;
  v_name text;
begin
  if auth.uid() is null or (v_user <> auth.uid() and not is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_pr from practitioner where user_id = v_user and deleted_at is null limit 1;
  if found then
    return calendar_json(v_pr) || jsonb_build_object('saved', true, 'canKeep', calendar_role_ok(v_user));
  end if;
  select full_name into v_name from profiles where id = v_user;
  return jsonb_build_object(
    'id', null, 'userId', v_user, 'name', v_name, 'title', null, 'categories', '[]'::jsonb,
    'languages', null, 'hours', '{}'::jsonb, 'slotMinutes', 30, 'daysOff', '[]'::jsonb,
    'note', null, 'visibility', 'staff', 'mine', v_user = auth.uid(), 'saved', false,
    'canKeep', calendar_role_ok(v_user)
  );
end
$$;

-- Manager: the doctors and sonographers who may have a calendar, with whether one is saved.
create or replace function calendar_people()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', p.id, 'name', p.full_name, 'role', p.role, 'staffId', p.staff_id,
    'visibility', pr.calendar_visibility, 'saved', pr.id is not null
  ) order by p.full_name), '[]'::jsonb)
  from profiles p
  left join practitioner pr on pr.user_id = p.id and pr.deleted_at is null
  where is_manager() and p.active and p.role in ('doctor', 'sonographer')
$$;

create or replace function save_calendar(
  p_user uuid,
  p_hours jsonb,
  p_slot_minutes integer,
  p_visibility text,
  p_days_off date[] default '{}',
  p_note text default null,
  p_title text default null,
  p_categories text[] default '{}',
  p_languages text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_user uuid := coalesce(p_user, auth.uid());
  v_id uuid;
  v_name text;
  v_staff text;
  v_key text;
  v_span jsonb;
  v_hours jsonb := coalesce(p_hours, '{}'::jsonb);
begin
  if auth.uid() is null or (v_user <> auth.uid() and not is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not calendar_role_ok(v_user) then
    raise exception 'only doctors and sonographers keep a calendar' using errcode = '22023';
  end if;
  if coalesce(p_visibility, '') not in ('private', 'staff', 'public') then
    raise exception 'choose who may see the calendar' using errcode = '22023';
  end if;
  if p_slot_minutes is null or p_slot_minutes not between 5 and 240 then
    raise exception 'the booking slot must be between 5 and 240 minutes' using errcode = '22023';
  end if;
  if jsonb_typeof(v_hours) <> 'object' then
    raise exception 'working hours are not valid' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(v_hours) loop
    if v_key not in ('0', '1', '2', '3', '4', '5', '6') or jsonb_typeof(v_hours -> v_key) <> 'array' then
      raise exception 'working hours are not valid' using errcode = '22023';
    end if;
    for v_span in select * from jsonb_array_elements(v_hours -> v_key) loop
      if (v_span ->> 0) !~ '^[0-2][0-9]:[0-5][0-9]$' or (v_span ->> 1) !~ '^[0-2][0-9]:[0-5][0-9]$'
         or (v_span ->> 0)::time >= (v_span ->> 1)::time then
        raise exception 'each working period must start before it ends' using errcode = '22023';
      end if;
    end loop;
  end loop;

  select full_name, staff_id into v_name, v_staff from profiles where id = v_user;
  select id into v_id from practitioner where user_id = v_user and deleted_at is null limit 1;
  if v_id is null then
    insert into practitioner (code, user_id, names, title, slot_minutes, working_hours, categories,
                              languages, calendar_visibility, days_off, calendar_note, active)
    values (lower(coalesce(v_staff, 'dr-' || left(v_user::text, 8))), v_user, v_name,
            nullif(trim(coalesce(p_title, '')), ''), p_slot_minutes, v_hours, coalesce(p_categories, '{}'),
            nullif(trim(coalesce(p_languages, '')), ''), p_visibility, coalesce(p_days_off, '{}'),
            nullif(trim(coalesce(p_note, '')), ''), true)
    returning id into v_id;
  else
    update practitioner
    set names = coalesce(v_name, names), title = nullif(trim(coalesce(p_title, '')), ''),
        slot_minutes = p_slot_minutes, working_hours = v_hours, categories = coalesce(p_categories, '{}'),
        languages = nullif(trim(coalesce(p_languages, '')), ''), calendar_visibility = p_visibility,
        days_off = coalesce(p_days_off, '{}'), calendar_note = nullif(trim(coalesce(p_note, '')), ''),
        active = true
    where id = v_id;
  end if;
  return v_id;
end
$$;

revoke all on function calendar_json(practitioner), staff_doctor_calendars(), calendar_role_ok(uuid),
  my_calendar(uuid), calendar_people(),
  save_calendar(uuid, jsonb, integer, text, date[], text, text, text[], text) from public, anon;
grant execute on function staff_doctor_calendars(), my_calendar(uuid), calendar_people(),
  save_calendar(uuid, jsonb, integer, text, date[], text, text, text[], text) to authenticated;

-- ---------------------------------------------------------------- treatments by department
alter table service add column if not exists department_id uuid references department (id);
create index if not exists service_department_idx on service (department_id) where deleted_at is null;

create or replace view catalogue_services with (security_invoker = true) as
  select s.id, s.code, s.name_en, s.name_kin, s.name_fr, s.service_group, s.allow_manual_price,
         s.max_discount_pct, s.active, s.default_duration_min, s.booking_category,
         (select pf.price from price_for(s.id, null, null) pf) as cash_price,
         coalesce((
           select jsonb_object_agg(pl.payer_id::text, pli.price)
           from price_list pl
           join price_list_item pli on pli.price_list_id = pl.id
           where pl.payer_id is not null and pli.service_id = s.id
             and pl.deleted_at is null and pli.deleted_at is null
             and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
         ), '{}'::jsonb) as payer_prices,
         d.id as department_id,
         d.name as department_name
  from service s
  left join department d on d.id = s.department_id and d.deleted_at is null
  where s.deleted_at is null;
revoke all on catalogue_services from anon;
grant select on catalogue_services to authenticated;

create or replace function set_service_department(p_service_id uuid, p_department_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_department_id is not null
     and not exists (select 1 from department where id = p_department_id and deleted_at is null) then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  update service set department_id = p_department_id where id = p_service_id and deleted_at is null;
  if not found then
    raise exception 'treatment not found' using errcode = 'P0002';
  end if;
end
$$;

-- What each treatment was billed between two days (count and amount), for the department view.
create or replace function service_billing(p_from date, p_to date)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_object_agg(x.service_id::text, jsonb_build_object('count', x.n, 'amount', x.amount)), '{}'::jsonb)
  from (
    select l.service_id, count(*)::integer as n, sum(round(l.quantity * l.unit_price))::numeric as amount
    from invoice_line l
    join invoice i on i.id = l.invoice_id and i.status <> 'credited'
    where has_perm('catalogue.write') and l.deleted_at is null and l.service_id is not null
      and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by l.service_id
  ) x
$$;

revoke all on function set_service_department(uuid, uuid), service_billing(date, date) from public, anon;
grant execute on function set_service_department(uuid, uuid), service_billing(date, date) to authenticated;


-- ============================================================ 20261025090000_history_explained.sql
-- 0038 · History that explains what happened.
--
-- Each history item now also carries the record as it was saved (without secrets and without
-- bookkeeping columns), the fields that changed with their old and new values, and the names
-- behind the ids (patient and file, treatment, medicine, employee, doctor, bed, bill number), so
-- the screen can write a full sentence: "Charged Uwase Claudine RWF 5,000 for Consultation".

-- The record without secrets (PIN, password, keys, tokens) and without bookkeeping columns.
create or replace function audit_clean(p jsonb)
returns jsonb
language sql immutable
as $$
  select coalesce(jsonb_object_agg(e.k, e.v), '{}'::jsonb)
  from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) as e(k, v)
  where e.k !~* '((^|_)pin($|_)|password|hash|token|secret|api_key|photo_blob|signature)'
    and e.k not in ('id', 'created_at', 'created_by', 'device_id', 'received_at', 'updated_at',
                    'updated_by', 'version')
$$;

-- Fields that changed between two versions: [{f, from, to}], same filtering as audit_clean.
create or replace function audit_changes(p_before jsonb, p_after jsonb)
returns jsonb
language sql immutable
as $$
  select coalesce(jsonb_agg(jsonb_build_object('f', k, 'from', b -> k, 'to', a -> k) order by k), '[]'::jsonb)
  from (select audit_clean(p_before) as b, audit_clean(p_after) as a) x,
       lateral (select jsonb_object_keys(x.a) as k union select jsonb_object_keys(x.b)) keys
  where (x.b -> k) is distinct from (x.a -> k)
    and p_before is not null and p_after is not null
$$;

create or replace function activity_history(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_actor uuid default null,
  p_group text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '7 days');
  v_to timestamptz := coalesce(p_to, now());
  v_total integer;
  v_items jsonb;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- Everyone sees their own activity; only the manager sees everybody's (and may pick a person).
  if not is_manager() then
    p_actor := auth.uid();
  end if;

  select count(*) into v_total
  from audit_event a
  where a.at >= v_from and a.at < v_to and a.action <> 'read'
    and (p_actor is null or a.actor_id = p_actor)
    and (p_group is null or activity_group(a.entity, a.action) = p_group);

  with ev as (
    select a.*, activity_group(a.entity, a.action) as grp, coalesce(a.after, a.before) as row
    from audit_event a
    where a.at >= v_from and a.at < v_to and a.action <> 'read'
      and (p_actor is null or a.actor_id = p_actor)
      and (p_group is null or activity_group(a.entity, a.action) = p_group)
    order by a.at desc
    limit greatest(1, least(p_limit, 500)) offset greatest(p_offset, 0)
  ),
  -- The visit behind the record: directly, through its bill, or through its test order.
  ev2 as (
    select ev.*,
      case when ev.entity = 'encounter' then ev.entity_id
        else coalesce(
          nullif(ev.row ->> 'encounter_id', '')::uuid,
          (select i.encounter_id from invoice i where i.id = nullif(ev.row ->> 'invoice_id', '')::uuid),
          (select i.encounter_id from invoice i where ev.entity = 'invoice' and i.id = ev.entity_id),
          (select sr.encounter_id from service_request sr where sr.id = nullif(ev.row ->> 'service_request_id', '')::uuid),
          (select md.encounter_id from medication_request md where md.id = nullif(ev.row ->> 'medication_request_id', '')::uuid))
      end as enc_id
    from ev
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', ev2.id,
      'at', ev2.at,
      'action', ev2.action,
      'entity', ev2.entity,
      'group', ev2.grp,
      'actor', pr.full_name,
      'actorRole', pr.role,
      'actorStaffId', pr.staff_id,
      'patient', coalesce(
        case when ev2.entity = 'patient' then (ev2.row ->> 'surname') || ' ' || (ev2.row ->> 'given_names') end,
        pe.surname || ' ' || pe.given_names,
        pp.surname || ' ' || pp.given_names,
        case when ev2.entity = 'appointment' then ev2.row ->> 'contact_name' end),
      'detail', null,
      'reason', ev2.reason,
      'row', audit_clean(ev2.row),
      'changes', case when ev2.action = 'update' then audit_changes(ev2.before, ev2.after) else '[]'::jsonb end,
      'names', jsonb_strip_nulls(jsonb_build_object(
        'file', coalesce(case when ev2.entity = 'patient' then ev2.row ->> 'file_number' end,
                         pe.file_number, pp.file_number),
        'target', case ev2.entity
          when 'profiles' then (select p.full_name || coalesce(' (' || p.staff_id || ')', '') from profiles p where p.id = ev2.entity_id)
          when 'practitioner' then ev2.row ->> 'names'
          when 'service' then coalesce(ev2.row ->> 'name_en', (select s.name_en from service s where s.id = ev2.entity_id))
          when 'payer' then coalesce(ev2.row ->> 'name', (select y.name from payer y where y.id = ev2.entity_id))
          when 'bed' then ev2.row ->> 'name'
          when 'item' then ev2.row ->> 'name_generic'
        end,
        'service', (select s.name_en from service s where s.id = coalesce(
          nullif(ev2.row ->> 'service_id', '')::uuid,
          (select sr.service_id from service_request sr where sr.id = nullif(ev2.row ->> 'service_request_id', '')::uuid))),
        'item', (select it.name_generic || coalesce(' ' || it.strength, '') from item it
                 where it.id = coalesce(nullif(ev2.row ->> 'item_id', '')::uuid,
                   (select md.item_id from medication_request md where md.id = nullif(ev2.row ->> 'medication_request_id', '')::uuid))),
        'staff', (select p.full_name from profiles p
                  where p.id = nullif(coalesce(ev2.after ->> 'assigned_to', ev2.after ->> 'taken_by',
                                               ev2.row ->> 'assigned_to', ev2.row ->> 'given_by'), '')::uuid),
        'referredBy', (select p.full_name from profiles p where p.id = nullif(ev2.row ->> 'referred_by', '')::uuid),
        'returnTo', (select p.full_name from profiles p where p.id = nullif(ev2.row ->> 'return_to', '')::uuid),
        'performer', (select p.full_name from profiles p where p.id = nullif(ev2.row ->> 'performer_id', '')::uuid),
        'practitioner', (select x.names from practitioner x where x.id = nullif(ev2.row ->> 'practitioner_id', '')::uuid),
        'bed', (select b.name from bed b where b.id = nullif(ev2.row ->> 'bed_id', '')::uuid),
        'invoice', coalesce(case when ev2.entity = 'invoice' then ev2.row ->> 'number' end,
                            (select i.number from invoice i where i.id = nullif(ev2.row ->> 'invoice_id', '')::uuid)),
        'department', (select d.name from department d where d.id = nullif(ev2.row ->> 'department_id', '')::uuid)
      ))
    ) order by ev2.at desc), '[]'::jsonb)
  into v_items
  from ev2
  left join profiles pr on pr.id = ev2.actor_id
  left join encounter en on en.id = ev2.enc_id
  left join patient pe on pe.id = en.patient_id
  left join patient pp on pp.id = nullif(ev2.row ->> 'patient_id', '')::uuid and en.id is null;

  return jsonb_build_object('total', v_total, 'items', v_items, 'from', v_from, 'to', v_to);
end
$$;

revoke all on function audit_clean(jsonb), audit_changes(jsonb, jsonb) from public, anon;


-- ============================================================ 20261026090000_appointments_meds_vitals.sql
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


-- ============================================================ 20261027090000_flow_payments_appointments.sql
-- 0040 · Appointments the doctor really receives, payments in colour, vitals in the file.
--
-- Appointments: bookings that were approved for a sample doctor (no account behind the
-- calendar) go back to "request" so reception books them with a real doctor; the day list and
-- a detail view carry the reason, the reference, where the request came from and who handled it.
-- Payments: only the cashier (or reception) records payments; the bill says who settled it
-- and when. Patient flow: patients go to the chosen desk at registration (triage first is a
-- clinic setting); every queue notice says whether the vitals were taken.

-- ---------------------------------------------------------------- appointments
update appointment a
set status = 'inquiry', practitioner_id = null, preferred_at = coalesce(a.preferred_at, a.starts_at),
    starts_at = null, ends_at = null, hold_until = null, approved_by = null, approved_at = null
where a.deleted_at is null and a.status in ('approved', 'confirmed')
  and a.practitioner_id in (select id from practitioner where user_id is null);

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
      'late', a.status in ('approved', 'confirmed') and a.starts_at < now() - interval '15 minutes'
    ) order by a.starts_at), '[]'::jsonb)
  from appointment a
  left join patient p on p.id = a.patient_id
  left join practitioner pr on pr.id = a.practitioner_id
  where has_perm('appointment.read') and a.deleted_at is null
    and a.status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed', 'no_show', 'cancelled')
    and (a.starts_at at time zone 'Africa/Kigali')::date = coalesce(p_day, (now() at time zone 'Africa/Kigali')::date)
$$;

-- Everything about one booking, for the detail view.
create or replace function appointment_detail(p_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', a.id, 'status', a.status, 'source', a.source, 'reference', a.reference,
    'startsAt', a.starts_at, 'endsAt', a.ends_at, 'preferredAt', a.preferred_at, 'createdAt', a.created_at,
    'reason', a.reason, 'cancelReason', a.cancel_reason, 'category', a.category, 'insurer', a.insurer_text,
    'channel', a.contact_channel, 'contactName', a.contact_name, 'contactPhone', a.contact_phone,
    'patientId', p.id, 'patientFile', p.file_number,
    'patientName', case when p.id is null then null else p.surname || ' ' || p.given_names end,
    'patientPhone', p.phone_1,
    'doctor', pr.names, 'doctorUserId', pr.user_id,
    'approvedBy', ap.full_name, 'approvedAt', a.approved_at,
    'acceptedBy', ac.full_name, 'acceptedAt', a.accepted_at,
    'encounterId', (select e.id from encounter e where e.appointment_id = a.id order by e.created_at desc limit 1),
    'late', a.status in ('approved', 'confirmed') and a.starts_at < now() - interval '15 minutes'
  )
  from appointment a
  left join patient p on p.id = a.patient_id
  left join practitioner pr on pr.id = a.practitioner_id
  left join profiles ap on ap.id = a.approved_by
  left join profiles ac on ac.id = a.accepted_by
  where has_perm('appointment.read') and a.id = p_id and a.deleted_at is null
$$;
revoke all on function appointment_detail(uuid) from public, anon;
grant execute on function appointment_detail(uuid) to authenticated;

-- ---------------------------------------------------------------- payments: the cashier records them
create or replace function take_payment(
  p_encounter_id uuid,
  p_method payment_method,
  p_amount numeric,
  p_reference text default null,
  p_payer_phone text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice invoice%rowtype;
  v_balance numeric;
  v_number text;
begin
  if not has_perm('billing.write') or current_role_key() not in ('cashier', 'receptionist') then
    raise exception 'only the cashier (or reception) records payments' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'the amount must be more than zero' using errcode = '22023';
  end if;
  perform recompute_invoice((select id from invoice where encounter_id = p_encounter_id));
  select * into v_invoice from invoice where encounter_id = p_encounter_id;
  if not found then
    raise exception 'no bill for this visit' using errcode = 'P0002';
  end if;
  if v_invoice.status = 'credited' then
    raise exception 'this bill was credited' using errcode = '23514';
  end if;
  v_balance := invoice_balance(v_invoice.id);
  if p_amount > v_balance + 0.5 then
    raise exception 'the amount exceeds the balance due (%)', v_balance using errcode = '22023';
  end if;
  perform record_payment(v_invoice.id, p_method, p_amount, p_reference, p_payer_phone);
  v_balance := invoice_balance(v_invoice.id);
  if v_balance <= 0 and v_invoice.status = 'draft' then
    v_number := post_invoice(v_invoice.id);
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = 'cashier' and finished_at is null;
  else
    select number into v_number from invoice where id = v_invoice.id;
  end if;
  return jsonb_build_object('balance', v_balance, 'number', v_number,
                            'status', (select status from invoice where id = v_invoice.id));
end
$$;

-- The bill says who settled it and when (last payment), for the green "paid" mark.
create or replace view visit_bill with (security_invoker = true) as
  select i.id as invoice_id, i.encounter_id, i.status, i.payer_id, py.name as payer_name,
         i.total, i.patient_share, i.insurer_share, i.number,
         invoice_balance(i.id) as balance,
         (select coalesce(sum(p.amount), 0) from payment p where p.invoice_id = i.id and p.deleted_at is null) as paid,
         lp.paid_at as settled_at,
         lp.cashier as settled_by
  from invoice i
  left join payer py on py.id = i.payer_id
  left join lateral (
    select p.paid_at, pr.full_name as cashier
    from payment p
    left join profiles pr on pr.id = p.cashier_id
    where p.invoice_id = i.id and p.deleted_at is null
    order by p.paid_at desc limit 1
  ) lp on true;

-- ---------------------------------------------------------------- patient flow: triage first is a setting
create or replace function save_setting(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_key not in ('clinic.profile', 'clinic.hours', 'clinic.features', 'patient.fields', 'security.lock', 'security.otp', 'flow') then
    raise exception 'unknown setting %', p_key using errcode = '22023';
  end if;
  if p_key = 'security.lock' then
    if jsonb_typeof(p_value -> 'idle_minutes') <> 'number'
       or (p_value ->> 'idle_minutes')::numeric < 1
       or (p_value ->> 'idle_minutes')::numeric > 480 then
      raise exception 'idle_minutes must be between 1 and 480' using errcode = '22023';
    end if;
  end if;
  if p_key = 'security.otp' then
    if jsonb_typeof(p_value -> 'trust_days') <> 'number'
       or (p_value ->> 'trust_days')::numeric < 0
       or (p_value ->> 'trust_days')::numeric > 90 then
      raise exception 'trust_days must be between 0 and 90' using errcode = '22023';
    end if;
  end if;
  if p_key = 'flow' and jsonb_typeof(p_value -> 'triage_first') <> 'boolean' then
    raise exception 'flow.triage_first must be true or false' using errcode = '22023';
  end if;
  if p_key = 'patient.fields' and jsonb_typeof(p_value) <> 'array' then
    raise exception 'patient.fields must be a list' using errcode = '22023';
  end if;
  insert into setting (key, value, changed_by, changed_at)
  values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, changed_by = auth.uid(), changed_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'setting', null, jsonb_build_object('key', p_key));
end
$$;

create or replace function triage_first()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(((select value from setting where key = 'flow') ->> 'triage_first')::boolean, false)
$$;

create or replace function staff_settings()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'idle_minutes', coalesce(((select value from setting where key = 'security.lock') ->> 'idle_minutes')::int, 120),
    'trust_days', trust_days(),
    'triage_first', triage_first()
  )
$$;

-- The patient goes to the chosen desk; to triage first only when the clinic wants that.
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
  v_station station := case when p_emergency then p_station when triage_first() then 'triage'::station else p_station end;
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

-- Every queue notice says whether the vitals were taken (referrals keep their own wording).
create or replace function notify_queue_entry()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_triage text;
  v_by text;
  v_vitals boolean;
begin
  if new.pool_id is not null then
    return new;
  end if;
  select p.surname || ' ' || p.given_names, e.triage_level::text into v_name, v_triage
  from encounter e join patient p on p.id = e.patient_id where e.id = new.encounter_id;
  select exists (select 1 from observation o where o.encounter_id = new.encounter_id and o.deleted_at is null
                 and o.code in ('bp_sys', 'bp_dia', 'pulse', 'temp', 'resp', 'spo2', 'weight', 'height', 'muac'))
  into v_vitals;
  if new.referred_by is not null then
    select full_name into v_by from profiles where id = new.referred_by;
    insert into notification (kind, params, link, urgent, recipient_user, recipient_role, created_by)
    values ('referral',
            jsonb_build_object('ticket', new.ticket_no, 'name', v_name, 'station', new.station,
                               'by', v_by, 'note', new.referral_note, 'queue', new.id,
                               'back', new.return_station is not null, 'vitals', v_vitals),
            '/app/visit?encounter=' || new.encounter_id,
            coalesce(v_triage, '') = 'red' or new.priority = 1,
            new.assigned_to,
            case when new.assigned_to is null then station_role(new.station) end,
            auth.uid());
    return new;
  end if;
  insert into notification (kind, params, link, urgent, recipient_role, created_by)
  values ('queue',
          jsonb_build_object('ticket', new.ticket_no, 'name', v_name, 'station', new.station,
                             'triage', v_triage, 'queue', new.id, 'vitals', v_vitals),
          '/app/visit?encounter=' || new.encounter_id,
          coalesce(v_triage, '') = 'red' or new.priority = 1,
          station_role(new.station),
          auth.uid());
  return new;
end
$$;

revoke all on function triage_first() from public, anon;
grant execute on function triage_first() to authenticated;


-- ============================================================ 20261028090000_specialty_journey_catalogue.sql
-- 0041 · Specialties on employees, the patient's journey through a visit, catalogue tools.
--
-- Specialty: each employee may carry a specialty or title ("Minor surgery", "Paediatrics",
-- "Midwife"); it shows on their dashboard, in the staff list and on the doctor's calendar.
-- Journey: one call gives every step of a visit in order (desks, who took the patient, vitals,
-- diagnoses, medicines, tests, charges, payments), so the file explains what was done.
-- Catalogue: the manager can start over (delete every treatment), add many treatments to a
-- department at once, and move all treatments of a type into a department.

-- ---------------------------------------------------------------- specialty
alter table profiles add column if not exists specialty text;

create or replace view staff_directory with (security_invoker = true) as
  select p.id, p.username, p.full_name, p.role, p.station, p.dashboard, p.head_of, p.language, p.phone,
         p.active, p.must_change_pin, p.last_sign_in_at, p.pin_changed_at, p.deactivated_at, p.created_at,
         p.staff_id, p.email, p.department_id, d.name as department_name, p.position, p.specialty
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null;

-- The calendar shows the same title as the employee's specialty.
create or replace function sync_practitioner_title()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  update practitioner
  set title = coalesce(new.specialty, title), names = new.full_name
  where user_id = new.id and deleted_at is null;
  return new;
end
$$;
drop trigger if exists trg_sync_practitioner_title on profiles;
create trigger trg_sync_practitioner_title
  after update of specialty, full_name on profiles
  for each row execute function sync_practitioner_title();

-- The signed-in person's own placement, specialty included (identity banner).
create or replace function my_placement()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'position', p.position, 'department', d.name, 'specialty', p.specialty, 'station', p.station
  )
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null
  where p.id = auth.uid()
$$;
revoke all on function my_placement() from public, anon;
grant execute on function my_placement() to authenticated;

-- ---------------------------------------------------------------- the journey of a visit
create or replace function visit_journey(p_encounter_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_steps jsonb;
  v_vitals jsonb;
  v_dx jsonb;
  v_meds jsonb;
  v_tests jsonb;
  v_charges jsonb;
  v_payments jsonb;
  v_bill jsonb;
  v_enc encounter%rowtype;
begin
  if not has_perm('patient.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_enc from encounter where id = p_encounter_id and deleted_at is null;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'station', q.station, 'queuedAt', q.created_at, 'calledAt', q.called_at, 'startedAt', q.started_at,
      'finishedAt', q.finished_at, 'takenBy', tb.full_name, 'assignedTo', asg.full_name,
      'referredBy', rb.full_name, 'note', q.referral_note, 'enteredBy', eb.full_name
    ) order by q.created_at), '[]'::jsonb) into v_steps
  from queue_entry q
  left join profiles tb on tb.id = q.taken_by
  left join profiles asg on asg.id = q.assigned_to
  left join profiles rb on rb.id = q.referred_by
  left join profiles eb on eb.id = q.entered_by
  where q.encounter_id = p_encounter_id and q.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'code', o.code, 'value', o.value_num, 'unit', o.unit, 'at', o.effective_at,
      'by', (select full_name from profiles where id = o.performer_id)
    ) order by o.effective_at), '[]'::jsonb) into v_vitals
  from observation o where o.encounter_id = p_encounter_id and o.deleted_at is null and o.code <> 'note';

  select coalesce(jsonb_agg(jsonb_build_object(
      'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
      'by', (select full_name from profiles where id = c.created_by)
    ) order by c.created_at), '[]'::jsonb) into v_dx
  from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'item', i.name_generic || coalesce(' ' || i.strength, ''), 'quantity', m.quantity, 'dose', m.dose,
      'frequency', m.frequency, 'days', m.duration_days, 'supply', m.supply, 'givenAt', m.given_at,
      'givenBy', (select full_name from profiles where id = m.given_by), 'at', m.created_at,
      'by', (select full_name from profiles where id = m.created_by),
      'dispensed', exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null)
    ) order by m.created_at), '[]'::jsonb) into v_meds
  from medication_request m join item i on i.id = m.item_id
  where m.encounter_id = p_encounter_id and m.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'test', s.name_en, 'status', r.status, 'priority', r.priority, 'at', r.created_at,
      'by', (select full_name from profiles where id = r.created_by),
      'result', (select coalesce(dr.impression, dr.findings) from diagnostic_report dr where dr.service_request_id = r.id and dr.deleted_at is null order by dr.created_at desc limit 1)
    ) order by r.created_at), '[]'::jsonb) into v_tests
  from service_request r left join service s on s.id = r.service_id
  where r.encounter_id = p_encounter_id and r.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'description', l.description, 'quantity', l.quantity, 'unitPrice', l.unit_price,
      'total', round(l.quantity * l.unit_price), 'office', l.office, 'at', l.created_at,
      'by', (select full_name from profiles where id = l.entered_by)
    ) order by l.created_at), '[]'::jsonb) into v_charges
  from invoice_line l join invoice i on i.id = l.invoice_id
  where i.encounter_id = p_encounter_id and l.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'amount', p.amount, 'method', p.method, 'reference', p.reference, 'at', p.paid_at,
      'by', (select full_name from profiles where id = p.cashier_id)
    ) order by p.paid_at), '[]'::jsonb) into v_payments
  from payment p join invoice i on i.id = p.invoice_id
  where i.encounter_id = p_encounter_id and p.deleted_at is null;

  select jsonb_build_object('status', b.status, 'total', b.total, 'balance', b.balance, 'paid', b.paid,
                            'number', b.number, 'settledBy', b.settled_by, 'settledAt', b.settled_at)
  into v_bill from visit_bill b where b.encounter_id = p_encounter_id;

  return jsonb_build_object(
    'encounterId', v_enc.id, 'arrivedAt', v_enc.arrived_at, 'status', v_enc.status, 'closedAt', v_enc.closed_at,
    'triage', v_enc.triage_level, 'triageReason', v_enc.triage_reason,
    'closedBy', (select full_name from profiles where id = v_enc.closed_by),
    'steps', v_steps, 'vitals', v_vitals, 'diagnoses', v_dx, 'medicines', v_meds, 'tests', v_tests,
    'charges', v_charges, 'payments', v_payments, 'bill', v_bill
  );
end
$$;
revoke all on function visit_journey(uuid) from public, anon;
grant execute on function visit_journey(uuid) to authenticated;

-- ---------------------------------------------------------------- catalogue tools (manager)
-- Start over: every treatment and its prices are removed (bills already made keep their lines).
create or replace function delete_all_services()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update price_list_item set deleted_at = now()
  where deleted_at is null and service_id in (select id from service where deleted_at is null);
  update service set deleted_at = now(), active = false where deleted_at is null;
  get diagnostics v_n = row_count;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'delete', 'service', null, jsonb_build_object('all', true, 'count', v_n));
  return v_n;
end
$$;

-- Many treatments at once into one department: [{name_en, name_kin, name_fr, price, group}].
create or replace function bulk_add_services(p_department_id uuid, p_items jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_item jsonb;
  v_id uuid;
  v_n integer := 0;
  v_group service_group;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_department_id is not null and not exists (select 1 from department where id = p_department_id and deleted_at is null) then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'give a list of treatments' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    if length(trim(coalesce(v_item ->> 'name_en', ''))) < 2 then
      continue;
    end if;
    begin
      v_group := coalesce(nullif(v_item ->> 'group', ''), 'consultation')::service_group;
    exception when others then
      v_group := 'other';
    end;
    v_id := upsert_service(null, v_item ->> 'name_en', v_group, coalesce((v_item ->> 'price')::numeric, 0),
                           v_item ->> 'name_kin', v_item ->> 'name_fr', 0, false, true, null, null);
    update service set department_id = p_department_id where id = v_id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- Every treatment of one type (consultation, lab, dental…) into a department.
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
  return v_n;
end
$$;

revoke all on function delete_all_services(), bulk_add_services(uuid, jsonb), move_group_to_department(service_group, uuid) from public, anon;
grant execute on function delete_all_services(), bulk_add_services(uuid, jsonb), move_group_to_department(service_group, uuid) to authenticated;


-- ============================================================ 20261029090000_stock_pharmacy.sql
-- 0042 · Medicine stock: what is on hand and where, cost and selling price, stock value,
-- receiving, sending a quantity to a department or a doctor's office, dispensing at the
-- pharmacy, and what was sold. Stock on hand is always the sum of the ledger (stock_movement).

alter table stock_location add column if not exists department_id uuid references department (id);
alter table stock_location add column if not exists active boolean not null default true;

-- ---------------------------------------------------------------- locations (stores)
create or replace function save_location(p_id uuid, p_name text, p_type stock_location_type, p_department_id uuid default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
begin
  if not has_perm('stock.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'the store needs a name' using errcode = '22023';
  end if;
  if v_id is null then
    insert into stock_location (name, type, department_id) values (trim(p_name), p_type, p_department_id)
    returning id into v_id;
  else
    update stock_location set name = trim(p_name), type = p_type, department_id = p_department_id
    where id = v_id and deleted_at is null;
    if not found then
      raise exception 'store not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end
$$;

-- ---------------------------------------------------------------- overview
create or replace function stock_overview()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_locations jsonb;
  v_items jsonb;
begin
  if not has_perm('stock.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'type', l.type,
                                               'department', d.name) order by l.type, l.name), '[]'::jsonb)
  into v_locations
  from stock_location l left join department d on d.id = l.department_id
  where l.deleted_at is null and l.active;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'code', i.code, 'name', i.name_generic, 'strength', i.strength, 'unit', i.selling_unit,
      'sellingPrice', (select pf.price from price_for(null, i.id, null) pf),
      'reorderLevel', i.reorder_level,
      'onHand', coalesce(t.on_hand, 0),
      'costValue', coalesce(t.cost_value, 0),
      'avgCost', case when coalesce(t.on_hand, 0) > 0 then round(t.cost_value / t.on_hand, 2) else null end,
      'byLocation', coalesce(t.by_location, '{}'::jsonb),
      'earliestExpiry', t.earliest_expiry,
      'expiredUnits', coalesce(t.expired, 0),
      'active', i.active
    ) order by i.name_generic), '[]'::jsonb)
  into v_items
  from item i
  left join lateral (
    select sum(s.quantity)::integer as on_hand,
           sum(s.quantity * coalesce(b.unit_cost, 0)) as cost_value,
           (select jsonb_object_agg(x.location_id::text, x.q) from (
              select s2.location_id, sum(s2.quantity)::integer as q from stock_on_hand s2
              where s2.item_id = i.id group by s2.location_id having sum(s2.quantity) <> 0) x) as by_location,
           min(s.expiry) filter (where s.quantity > 0) as earliest_expiry,
           sum(s.quantity) filter (where s.quantity > 0 and s.expiry < current_date)::integer as expired
    from stock_on_hand s left join batch b on b.id = s.batch_id
    where s.item_id = i.id
  ) t on true
  where i.deleted_at is null;

  return jsonb_build_object('locations', v_locations, 'items', v_items);
end
$$;

-- ---------------------------------------------------------------- receiving
create or replace function receive_stock(
  p_item_id uuid, p_location_id uuid, p_quantity integer, p_unit_cost numeric,
  p_batch_no text default null, p_expiry date default null, p_supplier text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_batch uuid;
  v_supplier uuid;
  v_no text := nullif(trim(coalesce(p_batch_no, '')), '');
begin
  if not has_perm('stock.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if p_unit_cost is null or p_unit_cost < 0 then
    raise exception 'the cost per unit must be zero or more' using errcode = '22023';
  end if;
  if not exists (select 1 from item where id = p_item_id and deleted_at is null) then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from stock_location where id = p_location_id and deleted_at is null) then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if nullif(trim(coalesce(p_supplier, '')), '') is not null then
    select id into v_supplier from supplier where lower(name) = lower(trim(p_supplier)) and deleted_at is null;
    if v_supplier is null then
      insert into supplier (name) values (trim(p_supplier)) returning id into v_supplier;
    end if;
  end if;
  if v_no is null then
    v_no := 'B' || to_char(now(), 'YYMMDD') || '-' || lpad(next_number('batch', extract(year from now())::integer)::text, 3, '0');
  end if;
  insert into batch (item_id, batch_no, expiry, unit_cost, supplier_id)
  values (p_item_id, v_no, coalesce(p_expiry, (current_date + interval '2 years')::date), p_unit_cost, v_supplier)
  on conflict (item_id, batch_no) do update set unit_cost = excluded.unit_cost, expiry = excluded.expiry
  returning id into v_batch;
  insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason)
  values (p_item_id, v_batch, p_location_id, p_quantity, 'receipt', nullif(trim(coalesce(p_supplier, '')), ''));
  return v_batch;
end
$$;

-- Oldest expiry first, from one store to another (a department, a doctor's office, the pharmacy).
create or replace function transfer_stock(
  p_item_id uuid, p_from_location_id uuid, p_to_location_id uuid, p_quantity integer, p_reason text default null
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_remaining integer := p_quantity;
  v_row record;
  v_take integer;
begin
  if not has_perm('stock.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'choose a different destination' using errcode = '22023';
  end if;
  for v_row in
    select s.batch_id, s.quantity from stock_on_hand s
    where s.item_id = p_item_id and s.location_id = p_from_location_id and s.quantity > 0
    order by s.expiry asc nulls last
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.quantity, v_remaining);
    insert into stock_movement (item_id, batch_id, from_location_id, to_location_id, quantity, type, reason)
    values (p_item_id, v_row.batch_id, p_from_location_id, p_to_location_id, v_take, 'transfer', nullif(trim(coalesce(p_reason, '')), ''));
    v_remaining := v_remaining - v_take;
  end loop;
  if v_remaining > 0 then
    raise exception 'not enough stock in that store: % unit(s) short', v_remaining using errcode = '23514';
  end if;
  return p_quantity;
end
$$;

-- Used from a store without a sale (given in the room, consumed, wasted, expired).
create or replace function use_stock(
  p_item_id uuid, p_location_id uuid, p_quantity integer, p_encounter_id uuid default null, p_reason text default null
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_remaining integer := p_quantity;
  v_row record;
  v_take integer;
begin
  if not (has_perm('stock.write') or has_perm('stock.dispense') or has_perm('clinical.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  for v_row in
    select s.batch_id, s.quantity from stock_on_hand s
    where s.item_id = p_item_id and s.location_id = p_location_id and s.quantity > 0
    order by s.expiry asc nulls last
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.quantity, v_remaining);
    insert into stock_movement (item_id, batch_id, from_location_id, quantity, type, reason)
    values (p_item_id, v_row.batch_id, p_location_id, v_take, 'consumption',
            coalesce(nullif(trim(coalesce(p_reason, '')), ''), case when p_encounter_id is not null then 'visit ' || p_encounter_id::text end));
    v_remaining := v_remaining - v_take;
  end loop;
  if v_remaining > 0 then
    raise exception 'not enough stock in that store: % unit(s) short', v_remaining using errcode = '23514';
  end if;
  return p_quantity;
end
$$;

-- ---------------------------------------------------------------- the pharmacy desk
-- Prescriptions to hand over: open visits, supply "pharmacy", not dispensed yet.
create or replace function pharmacy_queue()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'requestId', m.id, 'encounterId', m.encounter_id, 'patientId', p.id, 'patient', p.surname || ' ' || p.given_names,
    'file', p.file_number,
    'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = m.encounter_id order by q.created_at limit 1),
    'itemId', m.item_id, 'item', i.name_generic || coalesce(' ' || i.strength, ''), 'unit', i.selling_unit,
    'quantity', m.quantity, 'dose', m.dose, 'frequency', m.frequency, 'days', m.duration_days,
    'instructions', m.instructions, 'prescriber', pr.full_name, 'at', m.created_at,
    'price', (select pf.price from price_for(null, m.item_id, null) pf),
    'onHandPharmacy', (select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s
                       join stock_location l on l.id = s.location_id
                       where s.item_id = m.item_id and l.type = 'pharmacy')
  ) order by m.created_at), '[]'::jsonb)
  from medication_request m
  join encounter e on e.id = m.encounter_id and e.status = 'open'
  join patient p on p.id = e.patient_id
  join item i on i.id = m.item_id
  left join profiles pr on pr.id = m.created_by
  where has_perm('stock.read') and m.deleted_at is null and m.supply = 'pharmacy' and m.given_at is null
    and not exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null)
$$;

-- Hand over one prescription: stock leaves the pharmacy (oldest expiry first), the medicine
-- goes on the bill at its price, and the pharmacy queue entry closes when nothing is left.
create or replace function dispense_prescription(p_medication_request_id uuid, p_location_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_loc uuid := p_location_id;
  v_dispense uuid;
  v_charged boolean := false;
begin
  if not has_perm('stock.dispense') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_m from medication_request where id = p_medication_request_id and deleted_at is null;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  if v_m.given_at is not null or exists (select 1 from medication_dispense d where d.medication_request_id = v_m.id and d.deleted_at is null) then
    raise exception 'already dispensed' using errcode = '23505';
  end if;
  if v_loc is null then
    select id into v_loc from stock_location where type = 'pharmacy' and deleted_at is null and active order by created_at limit 1;
  end if;
  if v_loc is null then
    raise exception 'no pharmacy store yet: create one under Stock' using errcode = 'P0002';
  end if;
  v_dispense := dispense_fefo(v_m.encounter_id, v_m.item_id, ceil(v_m.quantity)::integer, v_loc, v_m.id, null);
  begin
    perform add_charge(v_m.encounter_id, 'pharmacy'::station, null, v_m.item_id, v_m.quantity,
                       null, null, null, null, 'medication_dispense', v_dispense);
    v_charged := true;
  exception when sqlstate 'P0002' then
    v_charged := false;
  end;
  update medication_request set given_at = now(), given_by = auth.uid() where id = v_m.id;
  if not exists (select 1 from medication_request x where x.encounter_id = v_m.encounter_id and x.deleted_at is null
                 and x.supply = 'pharmacy' and x.given_at is null and x.id <> v_m.id) then
    update queue_entry set finished_at = now()
    where encounter_id = v_m.encounter_id and station = 'pharmacy' and finished_at is null and deleted_at is null;
  end if;
  return jsonb_build_object('dispenseId', v_dispense, 'charged', v_charged);
end
$$;

-- ---------------------------------------------------------------- ledger and sales
create or replace function stock_movements(p_from date, p_to date, p_item_id uuid default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'at', m.moved_at, 'type', m.type, 'item', i.name_generic || coalesce(' ' || i.strength, ''),
    'quantity', m.quantity, 'from', lf.name, 'to', lt.name, 'batch', b.batch_no, 'expiry', b.expiry,
    'unitCost', b.unit_cost, 'reason', m.reason, 'by', pr.full_name
  ) order by m.moved_at desc), '[]'::jsonb)
  from stock_movement m
  join item i on i.id = m.item_id
  left join batch b on b.id = m.batch_id
  left join stock_location lf on lf.id = m.from_location_id
  left join stock_location lt on lt.id = m.to_location_id
  left join profiles pr on pr.id = m.created_by
  where has_perm('stock.read') and m.deleted_at is null
    and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to
    and (p_item_id is null or m.item_id = p_item_id)
$$;

-- What was sold (charged) per medicine in a period, with the cost of those units.
create or replace function stock_sales(p_from date, p_to date)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'item', x.name, 'units', x.units, 'revenue', x.revenue, 'cost', x.cost, 'margin', x.revenue - x.cost
      ) order by x.revenue desc)
      from (
        select i.name_generic || coalesce(' ' || i.strength, '') as name,
               sum(l.quantity) as units,
               sum(round(l.quantity * l.unit_price)) as revenue,
               sum(l.quantity) * coalesce((select avg(b.unit_cost) from batch b where b.item_id = i.id and b.deleted_at is null), 0) as cost
        from invoice_line l
        join invoice inv on inv.id = l.invoice_id and inv.status <> 'credited'
        join item i on i.id = l.item_id
        where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
        group by i.id, i.name_generic, i.strength
      ) x), '[]'::jsonb),
    'received', (select coalesce(sum(m.quantity * coalesce(b.unit_cost, 0)), 0) from stock_movement m left join batch b on b.id = m.batch_id
                 where m.deleted_at is null and m.type = 'receipt' and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'consumed', (select coalesce(sum(m.quantity * coalesce(b.unit_cost, 0)), 0) from stock_movement m left join batch b on b.id = m.batch_id
                 where m.deleted_at is null and m.type = 'consumption' and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'stockValue', (select coalesce(sum(s.quantity * coalesce(b.unit_cost, 0)), 0) from stock_on_hand s left join batch b on b.id = s.batch_id where s.quantity > 0)
  )
  where has_perm('stock.read')
$$;

revoke all on function save_location(uuid, text, stock_location_type, uuid), stock_overview(),
  receive_stock(uuid, uuid, integer, numeric, text, date, text), transfer_stock(uuid, uuid, uuid, integer, text),
  use_stock(uuid, uuid, integer, uuid, text), pharmacy_queue(), dispense_prescription(uuid, uuid),
  stock_movements(date, date, uuid), stock_sales(date, date) from public, anon;
grant execute on function save_location(uuid, text, stock_location_type, uuid), stock_overview(),
  receive_stock(uuid, uuid, integer, numeric, text, date, text), transfer_stock(uuid, uuid, uuid, integer, text),
  use_stock(uuid, uuid, integer, uuid, text), pharmacy_queue(), dispense_prescription(uuid, uuid),
  stock_movements(date, date, uuid), stock_sales(date, date) to authenticated;


-- ============================================================ 20261030090000_wait_time_notices.sql
-- 0043 · Waiting time that means something; booking notices that go away once handled.
--
-- Waiting time = from the moment a patient joins a desk's queue until a staff member takes them
-- ("Take", or the desk finishes with them). The average counts only patients who joined today
-- and have already been taken; patients still waiting are shown separately as "longest waiting
-- now". Before, still-waiting patients were counted up to the present minute (and leftovers from
-- earlier days), which inflated the average to many hours.
--
-- Booking notices: the "new booking request" notice disappears once reception books or rejects
-- the request; every request notice now carries the appointment id.
--
-- Emergency: registering a patient as an emergency queues them straight at a treating desk with
-- red priority. Reception and the cashier do not treat, so they may no longer do it.

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
  -- Patients still waiting, whatever day they arrived; one patient shared by several desks counts once.
  select count(distinct q.encounter_id) into v_waiting
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  where q.finished_at is null and q.deleted_at is null and e.status = 'open';
  select round(avg(extract(epoch from coalesce(started_at, finished_at) - created_at) / 60)) into v_avg
  from queue_entry
  where coalesce(started_at, finished_at) is not null and deleted_at is null
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

create or replace function desk_summary()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_tiles jsonb;
  v_stations jsonb;
  v_hours jsonb;
  v_mine jsonb;
begin
  if not exists (select 1 from profiles where id = v_me and active) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'registeredToday', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date = v_today),
    'registeredYesterday', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date = v_today - 1),
    'visitsToday', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date = v_today),
    'visitsYesterday', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date = v_today - 1),
    'inClinic', (select count(*) from encounter where deleted_at is null and status = 'open'),
    'waitingNow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
                   where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'),
    'avgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date = v_today)), 0)
                   from queue_entry q where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'triageWaiting', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                      where q.deleted_at is null and q.station = 'triage' and q.finished_at is null and e.status = 'open'),
    'triageRed', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
                  where q.deleted_at is null and q.finished_at is null and e.status = 'open' and e.triage_level = 'red'),
    'triageYellow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
                     where q.deleted_at is null and q.finished_at is null and e.status = 'open' and e.triage_level = 'yellow'),
    'triageAvgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date = v_today)), 0)
                         from queue_entry q where q.deleted_at is null and q.station = 'triage'
                           and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'vitalsToday', (select count(distinct encounter_id) from observation where deleted_at is null and (effective_at at time zone 'Africa/Kigali')::date = v_today),
    'vitalsYesterday', (select count(distinct encounter_id) from observation where deleted_at is null and (effective_at at time zone 'Africa/Kigali')::date = v_today - 1),
    'apptsToday', (select count(*) from appointment where deleted_at is null
                   and status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed')
                   and (starts_at at time zone 'Africa/Kigali')::date = v_today),
    'inquiriesPending', (select count(*) from appointment where deleted_at is null and status = 'inquiry'),
    'bedsOccupied', (select count(*) from bed where deleted_at is null and status = 'occupied'),
    'bedsTotal', (select count(*) from bed where deleted_at is null and status <> 'out_of_service')
  ) into v_tiles;

  -- Where patients are right now: waiting / being seen per station, average wait today.
  select coalesce(jsonb_agg(jsonb_build_object('station', s.station, 'waiting', s.waiting, 'busy', s.busy, 'minutes', s.minutes, 'longest', s.longest)
                            order by s.station), '[]'::jsonb) into v_stations
  from (
    select q.station::text as station,
           count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open') as waiting,
           count(*) filter (where q.finished_at is null and q.started_at is not null and e.status = 'open') as busy,
           round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date = v_today)) as minutes,
           round(max(extract(epoch from now() - q.created_at) / 60) filter (where q.finished_at is null and q.started_at is null and e.status = 'open')) as longest
    from queue_entry q
    join encounter e on e.id = q.encounter_id
    where q.deleted_at is null
      and ((q.finished_at is null and e.status = 'open') or (q.created_at at time zone 'Africa/Kigali')::date = v_today)
    group by q.station
  ) s;

  -- Arrivals per hour today (06:00–21:00, plus any hour outside that had arrivals).
  select coalesce(jsonb_agg(jsonb_build_object('hour', h.hour, 'count', coalesce(a.n, 0)) order by h.hour), '[]'::jsonb) into v_hours
  from (
    select generate_series(6, 21) as hour
    union
    select extract(hour from arrived_at at time zone 'Africa/Kigali')::int
    from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date = v_today
  ) h
  left join (
    select extract(hour from arrived_at at time zone 'Africa/Kigali')::int as hour, count(*) as n
    from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date = v_today
    group by 1
  ) a on a.hour = h.hour;

  -- The caller's own work today (accountability, and a little motivation).
  select jsonb_build_object(
    'registrations', (select count(*) from patient where deleted_at is null and created_by = v_me and (created_at at time zone 'Africa/Kigali')::date = v_today),
    'visitsStarted', (select count(*) from encounter where deleted_at is null and created_by = v_me and (arrived_at at time zone 'Africa/Kigali')::date = v_today),
    'vitals', (select count(distinct encounter_id) from observation where deleted_at is null and performer_id = v_me and (effective_at at time zone 'Africa/Kigali')::date = v_today),
    'charges', (select count(*) from invoice_line where deleted_at is null and entered_by = v_me and (created_at at time zone 'Africa/Kigali')::date = v_today)
  ) into v_mine;

  return jsonb_build_object('tiles', v_tiles, 'stations', v_stations, 'arrivals', v_hours, 'mine', v_mine);
end
$$;

create or replace function dashboard_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := is_manager();
  v_days integer := greatest(1, p_to - p_from + 1);
  v_prev_from date := p_from - v_days;
  v_prev_to date := p_from - 1;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_tiles jsonb;
  v_rev30 jsonb;
  v_collections jsonb;
  v_receivables jsonb;
  v_visits jsonb;
  v_wait jsonb;
  v_queue jsonb;
  v_top jsonb;
  v_staff jsonb;
  v_reorder jsonb;
  v_expiring jsonb;
  v_noshow jsonb;
  v_messages jsonb;
  v_claims jsonb;
  v_logins jsonb;
  v_services jsonb;
begin
  if not (v_manager or exists (select 1 from profiles where id = auth.uid() and active and dashboard is not null)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  -- headline tiles
  select jsonb_build_object(
    'registered', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'registeredPrev', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'visits', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'visitsPrev', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'waitingNow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'),
    'avgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date = v_today)), 0)
                   from queue_entry q where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'revenue', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to) end,
    'revenuePrev', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to) end,
    'openBills', case when v_manager then (select count(*) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'openBillsDue', case when v_manager then (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'bedsOccupied', (select count(*) from bed where deleted_at is null and status = 'occupied'),
    'bedsTotal', (select count(*) from bed where deleted_at is null and status <> 'out_of_service')
  ) into v_tiles;

  -- revenue per day, last 30 days ending today
  select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'amount', coalesce(s.amount, 0)) order by d), '[]'::jsonb) into v_rev30
  from generate_series(v_today - 29, v_today, interval '1 day') d
  left join (
    select (paid_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
    from payment where deleted_at is null and paid_at >= (v_today - 29)::timestamp
    group by 1
  ) s on s.day = d::date;

  select coalesce(jsonb_agg(jsonb_build_object('method', m, 'amount', coalesce(s.amount, 0)) order by s.amount desc nulls last), '[]'::jsonb) into v_collections
  from unnest(array['cash', 'momo', 'airtel', 'card', 'bank']::payment_method[]) m
  left join (
    select method, sum(amount) as amount from payment
    where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by method
  ) s on s.method = m;

  select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'count', c.n, 'amount', c.amount) order by c.amount desc), '[]'::jsonb) into v_receivables
  from (
    select payer_id, count(*) as n, sum(amount) as amount from claim
    where deleted_at is null and status in ('open', 'batched', 'submitted', 'rejected', 'resubmitted')
    group by payer_id
  ) c join payer py on py.id = c.payer_id;

  -- visits by service group (charged lines in the range)
  select coalesce(jsonb_agg(jsonb_build_object('group', g.grp, 'count', g.n) order by g.n desc), '[]'::jsonb) into v_visits
  from (
    select coalesce(s.service_group::text, 'pharmacy') as grp, count(distinct i.encounter_id) as n
    from invoice_line l
    join invoice i on i.id = l.invoice_id
    left join service s on s.id = l.service_id
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by 1
  ) g;

  -- waiting time and queue by station (today)
  select coalesce(jsonb_agg(jsonb_build_object('station', w.station, 'minutes', w.minutes, 'waiting', w.waiting, 'longest', w.longest) order by w.station), '[]'::jsonb) into v_wait
  from (
    select q.station::text as station,
           round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date = v_today)) as minutes,
           count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open') as waiting,
           round(max(extract(epoch from now() - q.created_at) / 60) filter (where q.finished_at is null and q.started_at is null and e.status = 'open')) as longest
    from queue_entry q
    join encounter e on e.id = q.encounter_id
    where q.deleted_at is null
      and ((q.finished_at is null and e.status = 'open') or (q.created_at at time zone 'Africa/Kigali')::date = v_today)
    group by q.station
  ) w;

  -- top treatments in the range
  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'count', x.n, 'amount', case when v_manager then x.amount end) order by x.n desc), '[]'::jsonb) into v_top
  from (
    select l.description as name, count(*) as n, sum(round(l.unit_price * l.quantity)) as amount
    from invoice_line l
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by l.description
    order by count(*) desc
    limit 10
  ) x;

  -- who did what (accountability)
  select coalesce(jsonb_agg(jsonb_build_object(
      'name', p.full_name, 'role', p.role, 'staffId', p.staff_id,
      'registrations', coalesce(r.n, 0), 'vitals', coalesce(v.n, 0), 'charges', coalesce(c.n, 0),
      'payments', case when v_manager then coalesce(pm.n, 0) end,
      'collected', case when v_manager then coalesce(pm.amount, 0) end,
      'lastSignIn', p.last_sign_in_at
    ) order by (coalesce(r.n, 0) + coalesce(v.n, 0) + coalesce(c.n, 0) + coalesce(pm.n, 0)) desc, p.full_name), '[]'::jsonb) into v_staff
  from profiles p
  left join (select created_by as id, count(*) as n from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) r on r.id = p.id
  left join (select performer_id as id, count(distinct encounter_id) as n from observation where deleted_at is null and (effective_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) v on v.id = p.id
  left join (select entered_by as id, count(*) as n from invoice_line where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) c on c.id = p.id
  left join (select cashier_id as id, count(*) as n, sum(amount) as amount from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) pm on pm.id = p.id
  where p.active;

  -- stock
  select coalesce(jsonb_agg(jsonb_build_object('name', name_generic, 'onHand', on_hand, 'min', reorder_level) order by (on_hand::numeric / greatest(reorder_level, 1))), '[]'::jsonb) into v_reorder
  from items_below_reorder where on_hand < reorder_level;

  select jsonb_build_object(
    'd30', count(*) filter (where s.expiry <= v_today + 30),
    'd60', count(*) filter (where s.expiry > v_today + 30 and s.expiry <= v_today + 60),
    'd90', count(*) filter (where s.expiry > v_today + 60 and s.expiry <= v_today + 90)
  ) into v_expiring
  from (select batch_id, expiry, sum(quantity) as q from stock_on_hand where expiry is not null group by batch_id, expiry) s
  where s.q > 0;

  -- bookings
  select jsonb_build_object(
    'booked', count(*) filter (where status in ('confirmed', 'arrived', 'in_progress', 'completed', 'no_show')),
    'missed', count(*) filter (where status = 'no_show'),
    'pending', count(*) filter (where status = 'inquiry')
  ) into v_noshow
  from appointment where deleted_at is null and (coalesce(starts_at, created_at) at time zone 'Africa/Kigali')::date between p_from and p_to;

  select coalesce(jsonb_agg(jsonb_build_object('channel', ch, 'sent', coalesce(s.sent, 0), 'failed', coalesce(s.failed, 0)) order by ch), '[]'::jsonb) into v_messages
  from unnest(array['whatsapp', 'sms', 'email']::message_channel[]) ch
  left join (
    select channel, count(*) filter (where status in ('sent', 'delivered')) as sent, count(*) filter (where status = 'failed') as failed
    from message where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by channel
  ) s on s.channel = ch;

  select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'count', c.n, 'amount', case when v_manager then c.amount end) order by c.amount desc), '[]'::jsonb) into v_claims
  from (select payer_id, count(*) as n, sum(amount) as amount from claim where deleted_at is null and status = 'open' group by payer_id) c
  join payer py on py.id = c.payer_id;

  select coalesce(jsonb_agg(jsonb_build_object('name', p.full_name, 'role', p.role, 'at', a.at, 'reason', a.reason) order by a.at desc), '[]'::jsonb) into v_logins
  from (select actor_id, at, reason from audit_event where action = 'login' and at > now() - interval '1 day' order by at desc limit 12) a
  join profiles p on p.id = a.actor_id;

  select jsonb_build_object('active', count(*) filter (where active), 'total', count(*)) into v_services from service where deleted_at is null;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'manager', v_manager, 'generatedAt', now(),
    'tiles', v_tiles, 'revenue30d', v_rev30, 'collections', v_collections, 'receivables', v_receivables,
    'visitsByGroup', v_visits, 'waitByStation', v_wait, 'topTreatments', v_top, 'staff', v_staff,
    'reorder', v_reorder, 'expiring', v_expiring, 'bookings', v_noshow, 'messages', v_messages,
    'claims', v_claims, 'logins', v_logins, 'services', v_services
  );
end
$$;

-- ---------------------------------------------------------------- booking notices
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
    values ('inquiry', jsonb_build_object('name', v_name, 'when', coalesce(new.starts_at, new.preferred_at), 'appointment', new.id),
            '/app/appointments', 'receptionist', auth.uid());
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
              '/app/appointments', 'receptionist', true, auth.uid());
    end if;
  end if;
  return new;
end
$$;

-- Old request notices (written before they carried the appointment id): remove those whose
-- person no longer has any request waiting.
delete from notification n
where n.kind = 'inquiry' and n.params ->> 'appointment' is null
  and not exists (select 1 from appointment a where a.status = 'inquiry' and a.deleted_at is null
                  and a.contact_name = n.params ->> 'name');

-- ---------------------------------------------------------------- emergency by treating staff only
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
  v_station station := case when p_emergency then p_station when triage_first() then 'triage'::station else p_station end;
  v_enc uuid;
  v_ticket text;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- An emergency is treated on the spot, so only staff who treat may register one.
  if p_emergency and current_role_key() in ('receptionist', 'cashier') then
    raise exception 'only treating staff can register an emergency' using errcode = '42501';
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


-- ============================================================ 20261030120000_cashier_tests_tasks.sql
-- 0044 · Three payment methods; the cashier takes money, never adds treatments; tests that bring
-- the patient back; the doctor hears when the nurse has done the task.
--
-- Payments: only cash, MTN MoMo and Airtel Money are accepted from now on (card, bank, insurer,
-- credit and deposit stay in the enum so older rows remain readable).
--
-- Cashier: no longer holds charge.write. Treatments, medicines and tests are added by those who
-- treat (doctors, nurses, lab, pharmacy); the cashier only takes the payment.
--
-- Tests: a doctor who has not found the disease yet orders one or several tests at once (no
-- diagnosis needed) and sends the patient to the laboratory / ultrasound. When the last result of
-- that desk is written, the patient is put back in the ordering doctor's queue automatically,
-- with "Results ready" so the doctor can give the final treatment.

-- ---------------------------------------------------------------- payment methods
alter table payment drop constraint if exists payment_method_accepted;
alter table payment
  add constraint payment_method_accepted
  check (method in ('cash', 'momo', 'airtel')) not valid;

-- ---------------------------------------------------------------- cashier: payments only
delete from role_permissions where role = 'cashier' and permission = 'charge.write';

-- ---------------------------------------------------------------- several tests, patient comes back
create or replace function order_tests(
  p_encounter_id uuid,
  p_service_ids uuid[],
  p_reason text default null,
  p_from station default null
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_service uuid;
  v_n integer := 0;
begin
  if not has_perm('orders.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if coalesce(array_length(p_service_ids, 1), 0) = 0 then
    raise exception 'choose at least one test' using errcode = '22023';
  end if;
  foreach v_service in array p_service_ids loop
    perform order_test(p_encounter_id, v_service, p_reason, 3);
    v_n := v_n + 1;
  end loop;
  -- Send the patient now: off the doctor's queue, onto the test desks, back to this doctor after.
  if p_from is not null and p_from not in ('laboratory', 'ultrasound') then
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = p_from and finished_at is null;
    update queue_entry
    set referred_by = auth.uid(),
        referral_note = coalesce(nullif(trim(coalesce(p_reason, '')), ''), referral_note),
        return_station = p_from,
        return_to = auth.uid()
    where encounter_id = p_encounter_id and station in ('laboratory', 'ultrasound')
      and finished_at is null and deleted_at is null;
  end if;
  return v_n;
end
$$;

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
  v_station station;
  v_q queue_entry%rowtype;
  v_tests text;
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
  -- Last result of this desk written: the patient goes back to the doctor who sent them.
  v_station := case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end;
  if not exists (select 1 from service_request r
                 where r.encounter_id = v_req.encounter_id and r.category = v_req.category
                   and r.deleted_at is null and r.status not in ('resulted', 'verified', 'cancelled')) then
    select * into v_q from queue_entry
    where encounter_id = v_req.encounter_id and station = v_station and finished_at is null and deleted_at is null
    order by created_at desc limit 1;
    if found and v_q.return_station is not null then
      update queue_entry set finished_at = now() where id = v_q.id;
      if not exists (select 1 from queue_entry where encounter_id = v_req.encounter_id
                     and station = v_q.return_station and finished_at is null and deleted_at is null) then
        select string_agg(s.name_en, ', ' order by r.created_at) into v_tests
        from service_request r join service s on s.id = r.service_id
        where r.encounter_id = v_req.encounter_id and r.category = v_req.category and r.deleted_at is null
          and r.status in ('resulted', 'verified');
        insert into queue_entry (encounter_id, station, ticket_no, priority, assigned_to, referred_by, referral_note)
        values (v_req.encounter_id, v_q.return_station, v_q.ticket_no, v_q.priority, v_q.return_to, auth.uid(),
                'Results ready: ' || coalesce(v_tests, v_test, ''));
      end if;
    end if;
  end if;
end
$$;

-- ---------------------------------------------------------------- task done → the doctor is told
create or replace function complete_task(p_task_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_task internal_task%rowtype;
  v_name text;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update internal_task set done_at = now(), done_by = auth.uid()
  where id = p_task_id and deleted_at is null and done_at is null
  returning * into v_task;
  if not found then
    raise exception 'task not found or already done' using errcode = 'P0002';
  end if;
  if v_task.created_by is not null and v_task.created_by is distinct from auth.uid() then
    select p.surname || ' ' || p.given_names into v_name from patient p where p.id = v_task.patient_id;
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('task_done',
            jsonb_build_object('title', v_task.title, 'name', v_name,
                               'by', (select full_name from profiles where id = auth.uid())),
            case when v_task.encounter_id is not null then '/app/visit?encounter=' || v_task.encounter_id end,
            v_task.created_by, auth.uid());
  end if;
end
$$;

grant execute on function order_tests(uuid, uuid[], text, station) to authenticated;
revoke execute on function order_tests(uuid, uuid[], text, station) from anon, public;


-- ============================================================ 20261030150000_visit_done_left.sql
-- 0045 · A paid patient leaves "In the clinic"; staff can say a patient has left.
--
-- Before: when the doctor finished a visit with money still due, the visit was reopened and the
-- patient queued at the cashier; paying closed the cashier queue entry only when the bill was
-- still a draft, and the visit itself stayed open for ever. A patient sent to the cashier after
-- paying (nothing due) also stayed there, with no way to remove them.
--
-- Now: finish_visit marks the clinical work as done (clinical_done_at); once the bill is settled
-- the cashier entry closes in every case and, if the doctor had finished, the visit closes too.
-- end_visit(): "the patient has left" from any desk — closes the visit and every queue entry; if
-- money is still due only the manager may do it, with a reason (kept on the visit).

alter table encounter add column if not exists clinical_done_at timestamptz;
alter table encounter add column if not exists left_reason text;

create or replace function finish_visit(p_encounter_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform close_encounter(p_encounter_id);
  if exists (select 1 from invoice i where i.encounter_id = p_encounter_id and invoice_balance(i.id) > 0) then
    -- Treatment is over; the visit stays open only until the bill is paid.
    update encounter set status = 'open', closed_at = null, closed_by = null, clinical_done_at = now()
    where id = p_encounter_id;
    update queue_entry set finished_at = now() where encounter_id = p_encounter_id and station <> 'cashier' and finished_at is null;
    if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'cashier' and finished_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no)
      values (p_encounter_id, 'cashier', (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1));
    end if;
  end if;
end
$$;

create or replace function take_payment(
  p_encounter_id uuid,
  p_method payment_method,
  p_amount numeric,
  p_reference text default null,
  p_payer_phone text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice invoice%rowtype;
  v_balance numeric;
  v_number text;
  v_closed boolean := false;
begin
  if not has_perm('billing.write') or current_role_key() not in ('cashier', 'receptionist') then
    raise exception 'only the cashier (or reception) records payments' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'the amount must be more than zero' using errcode = '22023';
  end if;
  perform recompute_invoice((select id from invoice where encounter_id = p_encounter_id));
  select * into v_invoice from invoice where encounter_id = p_encounter_id;
  if not found then
    raise exception 'no bill for this visit' using errcode = 'P0002';
  end if;
  if v_invoice.status = 'credited' then
    raise exception 'this bill was credited' using errcode = '23514';
  end if;
  v_balance := invoice_balance(v_invoice.id);
  if p_amount > v_balance + 0.5 then
    raise exception 'the amount exceeds the balance due (%)', v_balance using errcode = '22023';
  end if;
  perform record_payment(v_invoice.id, p_method, p_amount, p_reference, p_payer_phone);
  v_balance := invoice_balance(v_invoice.id);
  if v_balance <= 0 then
    if v_invoice.status = 'draft' then
      v_number := post_invoice(v_invoice.id);
    else
      select number into v_number from invoice where id = v_invoice.id;
    end if;
    -- Paid: off the cashier's queue in every case.
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = 'cashier' and finished_at is null;
    -- The doctor had finished and nothing else is waiting: the visit is over.
    update encounter set status = 'closed', closed_at = now(), closed_by = auth.uid()
    where id = p_encounter_id and status = 'open' and clinical_done_at is not null
      and not exists (select 1 from queue_entry q where q.encounter_id = p_encounter_id
                      and q.finished_at is null and q.deleted_at is null);
    v_closed := found;
  else
    select number into v_number from invoice where id = v_invoice.id;
  end if;
  return jsonb_build_object('balance', v_balance, 'number', v_number, 'closed', v_closed,
                            'status', (select status from invoice where id = v_invoice.id));
end
$$;

-- "The patient has left": close the visit from any desk.
create or replace function end_visit(p_encounter_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_due numeric;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  select coalesce(sum(invoice_balance(i.id)), 0) into v_due from invoice i
  where i.encounter_id = p_encounter_id and i.status <> 'credited';
  if v_due > 0 then
    if current_role_key() <> 'manager' then
      raise exception 'money is still due (% RWF): take the payment first, or ask the manager', round(v_due)
        using errcode = '23514';
    end if;
    if nullif(trim(coalesce(p_reason, '')), '') is null then
      raise exception 'say why the patient left without paying' using errcode = '22023';
    end if;
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and finished_at is null;
  update encounter
  set status = 'closed', closed_at = now(), closed_by = auth.uid(),
      left_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = p_encounter_id;
  return jsonb_build_object('due', v_due);
end
$$;

grant execute on function end_visit(uuid, text) to authenticated;
revoke execute on function end_visit(uuid, text) from anon, public;

-- Leftovers: visits already paid in full whose patient only waits at the cashier leave the
-- cashier, and paid visits no longer waiting anywhere are closed (they blocked a new visit).
update queue_entry q set finished_at = now()
where q.station = 'cashier' and q.finished_at is null and q.deleted_at is null
  and exists (select 1 from invoice i where i.encounter_id = q.encounter_id and i.status = 'posted'
              and invoice_balance(i.id) <= 0);
update encounter e set status = 'closed', closed_at = now()
where e.status = 'open'
  and exists (select 1 from invoice i where i.encounter_id = e.id and i.status = 'posted'
              and invoice_balance(i.id) <= 0)
  and not exists (select 1 from queue_entry q where q.encounter_id = e.id
                  and q.finished_at is null and q.deleted_at is null);


-- ============================================================ 20261030180000_no_vitals_notice.sql
-- 0046 · Nurses are told about every new patient whose vitals are not taken yet.
--
-- When reception (or any desk) starts a visit and sends the patient straight to a doctor, the
-- nurses had no notice: only a patient queued at triage reached them. Now the first queue entry
-- of a visit without vitals sends the nurses a "vitals not taken yet" notice, linked to the
-- vitals screen. It disappears as soon as anyone records the vitals, or when the visit closes.
-- Skipped when the patient is queued at triage / nursing (the nurses' own queue notice says it)
-- and when a nurse registered the patient (she goes straight to the measurements).

create or replace function notify_no_vitals()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
begin
  if exists (select 1 from queue_entry q where q.encounter_id = new.encounter_id and q.id <> new.id) then
    return new;
  end if;
  if new.station in ('triage', 'nursing', 'beds') or coalesce(current_role_key()::text, '') = 'nurse' then
    return new;
  end if;
  if exists (select 1 from observation o where o.encounter_id = new.encounter_id and o.deleted_at is null
             and o.code in ('bp_sys', 'bp_dia', 'pulse', 'temp', 'resp', 'spo2', 'weight', 'height', 'muac')) then
    return new;
  end if;
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = new.encounter_id;
  insert into notification (kind, params, link, recipient_role, created_by)
  values ('no_vitals',
          jsonb_build_object('ticket', new.ticket_no, 'name', v_name, 'station', new.station,
                             'encounter', new.encounter_id),
          '/app/vitals?encounter=' || new.encounter_id,
          'nurse', auth.uid());
  return new;
end
$$;
drop trigger if exists queue_entry_no_vitals on queue_entry;
create trigger queue_entry_no_vitals after insert on queue_entry
  for each row execute function notify_no_vitals();

-- Vitals recorded by anyone, or the visit closed: the notice is no longer needed.
create or replace function clear_no_vitals()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_table_name = 'observation' then
    if new.code in ('bp_sys', 'bp_dia', 'pulse', 'temp', 'resp', 'spo2', 'weight', 'height', 'muac') then
      delete from notification where kind = 'no_vitals' and params ->> 'encounter' = new.encounter_id::text;
    end if;
  elsif new.status = 'closed' then
    delete from notification where kind = 'no_vitals' and params ->> 'encounter' = new.id::text;
  end if;
  return new;
end
$$;
drop trigger if exists observation_clear_no_vitals on observation;
create trigger observation_clear_no_vitals after insert on observation
  for each row execute function clear_no_vitals();
drop trigger if exists encounter_clear_no_vitals on encounter;
create trigger encounter_clear_no_vitals after update of status on encounter
  for each row execute function clear_no_vitals();


-- ============================================================ 20261031090000_keep_bed_stay.sql
-- 0047 · "Delete all treatments" keeps the built-in Bed stay line.
--
-- Bed billing (admit_to_bed / extend_bed_stay) charges every stay under the service BED-STAY;
-- deleting it made bed admissions fail ("unknown or inactive service"). The catalogue reset now
-- spares it, and it comes back if it was deleted.

create or replace function delete_all_services()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update price_list_item set deleted_at = now()
  where deleted_at is null
    and service_id in (select id from service where deleted_at is null and code <> 'BED-STAY');
  update service set deleted_at = now(), active = false where deleted_at is null and code <> 'BED-STAY';
  get diagnostics v_n = row_count;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'delete', 'service', null, jsonb_build_object('all', true, 'count', v_n));
  return v_n;
end
$$;

update service set deleted_at = null, active = true where code = 'BED-STAY';


-- ============================================================ 20261031120000_service_departments.sql
-- 0048 · A treatment can be given by several departments; staff see their department's own.
--
-- The departments are the ones of the Employees page (one list for the clinic): a department
-- holds its employees and the treatments they give. service_department links a treatment to
-- every department that gives it; service.department_id stays as its first ("main") department
-- so older functions (bulk add, move a type) keep working — a trigger keeps the link in step.
-- my_placement() now also returns the employee's department id, so the visit screen can show
-- each employee the treatments of their own department first.

create table if not exists service_department (
  service_id uuid not null references service (id),
  department_id uuid not null references department (id),
  created_at timestamptz not null default now(),
  primary key (service_id, department_id)
);
create index if not exists service_department_dept_idx on service_department (department_id);
alter table service_department enable row level security;
drop policy if exists service_department_select on service_department;
create policy service_department_select on service_department for select to authenticated using (true);
revoke all on service_department from anon;
grant select on service_department to authenticated;

insert into service_department (service_id, department_id)
select id, department_id from service where department_id is not null
on conflict do nothing;

-- The main department moves (bulk add, "move a type", set_service_department): the link follows.
create or replace function sync_service_department()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.department_id is not null
     and old.department_id is distinct from new.department_id then
    delete from service_department where service_id = new.id and department_id = old.department_id;
  end if;
  if new.department_id is not null then
    insert into service_department (service_id, department_id)
    values (new.id, new.department_id) on conflict do nothing;
  end if;
  return new;
end
$$;
drop trigger if exists service_department_sync on service;
create trigger service_department_sync after insert or update of department_id on service
  for each row execute function sync_service_department();

-- Every department that gives this treatment (empty = none yet). The first is the main one.
create or replace function set_service_departments(p_service_id uuid, p_department_ids uuid[])
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_ids uuid[] := coalesce(p_department_ids, '{}');
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(v_ids) x(id)
             where not exists (select 1 from department d where d.id = x.id and d.deleted_at is null)) then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  update service set department_id = v_ids[1] where id = p_service_id and deleted_at is null;
  if not found then
    raise exception 'treatment not found' using errcode = 'P0002';
  end if;
  delete from service_department where service_id = p_service_id and department_id <> all (v_ids);
  insert into service_department (service_id, department_id)
  select p_service_id, x.id from unnest(v_ids) x(id) on conflict do nothing;
end
$$;
revoke all on function set_service_departments(uuid, uuid[]) from public, anon;
grant execute on function set_service_departments(uuid, uuid[]) to authenticated;

-- The catalogue with every department of each treatment (new columns at the end).
create or replace view catalogue_services with (security_invoker = true) as
  select s.id, s.code, s.name_en, s.name_kin, s.name_fr, s.service_group, s.allow_manual_price,
         s.max_discount_pct, s.active, s.default_duration_min, s.booking_category,
         (select pf.price from price_for(s.id, null, null) pf) as cash_price,
         coalesce((
           select jsonb_object_agg(pl.payer_id::text, pli.price)
           from price_list pl
           join price_list_item pli on pli.price_list_id = pl.id
           where pl.payer_id is not null and pli.service_id = s.id
             and pl.deleted_at is null and pli.deleted_at is null
             and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
         ), '{}'::jsonb) as payer_prices,
         d.id as department_id,
         d.name as department_name,
         coalesce((select array_agg(sd.department_id order by (sd.department_id = s.department_id) desc, dd.name)
                   from service_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.service_id = s.id), '{}') as department_ids,
         coalesce((select array_agg(dd.name order by (sd.department_id = s.department_id) desc, dd.name)
                   from service_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.service_id = s.id), '{}') as department_names
  from service s
  left join department d on d.id = s.department_id and d.deleted_at is null
  where s.deleted_at is null;
revoke all on catalogue_services from anon;
grant select on catalogue_services to authenticated;

create or replace function my_placement()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'position', p.position, 'department', d.name, 'departmentId', d.id,
    'specialty', p.specialty, 'station', p.station
  )
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null
  where p.id = auth.uid()
$$;


-- ============================================================ 20261031150000_service_categories.sql
-- 0049 · The clinic manages its own treatment categories.
--
-- Before: every treatment had one of ten fixed groups built into the code; a clinic could not
-- add one. Now the manager creates, renames and deletes categories (Prices → Categories). Each
-- category has a *kind* that tells the system how its treatments behave:
--   treatment — charged on the visit;
--   lab       — orderable test, goes to the Laboratory, has a result;
--   imaging   — orderable test, goes to Ultrasound, has a result;
--   bed       — bed stays (built in, cannot be changed or deleted).
-- The ten former groups become the first categories (renamable). service.service_group stays as
-- an internal field derived from the category, so tests, beds, insurers and older functions keep
-- working unchanged; a trigger keeps the two in step.

create type category_kind as enum ('treatment', 'lab', 'imaging', 'bed');

create table if not exists service_category (
  id uuid primary key default gen_random_uuid(),
  name_en text not null,
  name_kin text,
  name_fr text,
  kind category_kind not null default 'treatment',
  -- the former fixed group this category started as (null for the clinic's own)
  base_group service_group,
  sort integer not null default 100,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  deleted_at timestamptz
);
create unique index if not exists service_category_name_idx on service_category (lower(name_en)) where deleted_at is null;
alter table service_category enable row level security;
drop policy if exists service_category_select on service_category;
create policy service_category_select on service_category for select to authenticated using (true);
revoke all on service_category from anon;
grant select on service_category to authenticated;

insert into service_category (base_group, name_en, name_kin, name_fr, kind, sort) values
  ('consultation', 'Consultation & treatments', 'Gusuzuma no kuvura', 'Consultation et traitements', 'treatment', 1),
  ('dental', 'Dental', 'Amenyo', 'Dentaire', 'treatment', 2),
  ('lab', 'Laboratory', 'Ibizamini', 'Laboratoire', 'lab', 3),
  ('imaging', 'Ultrasound / imaging', 'Ekografi / amafoto', 'Échographie / imagerie', 'imaging', 4),
  ('procedure', 'Minor surgery & procedures', 'Kubaga byoroheje n''ibindi bikorwa', 'Petite chirurgie et actes', 'treatment', 5),
  ('nursing', 'Nursing care', 'Kwita ku barwayi', 'Soins infirmiers', 'treatment', 6),
  ('bed', 'Beds & observation', 'Ibitanda no gukurikiranwa', 'Lits et observation', 'bed', 7),
  ('registration', 'Registration', 'Kwandikwa', 'Enregistrement', 'treatment', 8),
  ('pharmacy', 'Pharmacy', 'Farumasi', 'Pharmacie', 'treatment', 9),
  ('other', 'Other', 'Ibindi', 'Autre', 'treatment', 10);

alter table service add column if not exists category_id uuid references service_category (id);
update service s set category_id = c.id from service_category c
where c.base_group = s.service_group and s.category_id is null;

-- The internal group follows the category (and the category follows a group set directly by
-- older functions such as bulk add with a "group").
create or replace function service_category_sync()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_kind category_kind;
  v_base service_group;
begin
  if new.category_id is null
     or (tg_op = 'UPDATE' and new.service_group is distinct from old.service_group
         and new.category_id is not distinct from old.category_id) then
    select id into new.category_id from service_category
    where base_group = new.service_group and deleted_at is null order by sort limit 1;
    return new;
  end if;
  select kind, base_group into v_kind, v_base from service_category where id = new.category_id;
  new.service_group := case v_kind
    when 'lab' then 'lab'::service_group
    when 'imaging' then 'imaging'::service_group
    when 'bed' then 'bed'::service_group
    else case when v_base in ('lab', 'imaging', 'bed') or v_base is null then 'other'::service_group else v_base end
  end;
  return new;
end
$$;
drop trigger if exists service_category_sync on service;
create trigger service_category_sync before insert or update of category_id, service_group on service
  for each row execute function service_category_sync();

-- ---------------------------------------------------------------- manager: categories
create or replace function save_category(
  p_id uuid,
  p_name_en text,
  p_name_kin text default null,
  p_name_fr text default null,
  p_kind category_kind default 'treatment'
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_old category_kind;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name_en, ''))) < 2 then
    raise exception 'give the category a name' using errcode = '22023';
  end if;
  if exists (select 1 from service_category where lower(name_en) = lower(trim(p_name_en))
             and deleted_at is null and id is distinct from p_id) then
    raise exception 'a category with this name already exists' using errcode = '23505';
  end if;
  if v_id is null then
    if p_kind = 'bed' then
      raise exception 'bed stays have their own built-in category' using errcode = '22023';
    end if;
    insert into service_category (name_en, name_kin, name_fr, kind)
    values (trim(p_name_en), nullif(trim(coalesce(p_name_kin, '')), ''), nullif(trim(coalesce(p_name_fr, '')), ''), p_kind)
    returning id into v_id;
  else
    select kind into v_old from service_category where id = v_id and deleted_at is null;
    if not found then
      raise exception 'category not found' using errcode = 'P0002';
    end if;
    if (v_old = 'bed') <> (p_kind = 'bed') then
      raise exception 'the bed category keeps its kind' using errcode = '22023';
    end if;
    update service_category
    set name_en = trim(p_name_en), name_kin = nullif(trim(coalesce(p_name_kin, '')), ''),
        name_fr = nullif(trim(coalesce(p_name_fr, '')), ''), kind = p_kind
    where id = v_id;
    -- a new kind: its treatments behave accordingly (tests become orderable, or stop being)
    if v_old <> p_kind then
      update service set category_id = category_id where category_id = v_id;
    end if;
  end if;
  return v_id;
end
$$;

create or replace function delete_category(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from service_category where id = p_id and kind = 'bed') then
    raise exception 'the bed category cannot be deleted' using errcode = '22023';
  end if;
  select count(*) into v_n from service where category_id = p_id and deleted_at is null;
  if v_n > 0 then
    raise exception 'this category still has % treatment(s): move them to another category first', v_n
      using errcode = '23503';
  end if;
  update service_category set deleted_at = now() where id = p_id and deleted_at is null;
  if not found then
    raise exception 'category not found' using errcode = 'P0002';
  end if;
end
$$;

create or replace function set_service_category(p_service_id uuid, p_category_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from service_category where id = p_category_id and deleted_at is null) then
    raise exception 'category not found' using errcode = 'P0002';
  end if;
  update service set category_id = p_category_id where id = p_service_id and deleted_at is null;
  if not found then
    raise exception 'treatment not found' using errcode = 'P0002';
  end if;
end
$$;

-- Every treatment of one category into a department (Catalogue tools).
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
  return v_n;
end
$$;

-- Bulk add: an item may name its category (id) instead of a group.
create or replace function bulk_add_services(p_department_id uuid, p_items jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_item jsonb;
  v_id uuid;
  v_n integer := 0;
  v_group service_group;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_department_id is not null and not exists (select 1 from department where id = p_department_id and deleted_at is null) then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'give a list of treatments' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    if length(trim(coalesce(v_item ->> 'name_en', ''))) < 2 then
      continue;
    end if;
    begin
      v_group := coalesce(nullif(v_item ->> 'group', ''), 'consultation')::service_group;
    exception when others then
      v_group := 'other';
    end;
    v_id := upsert_service(null, v_item ->> 'name_en', v_group, coalesce((v_item ->> 'price')::numeric, 0),
                           v_item ->> 'name_kin', v_item ->> 'name_fr', 0, false, true, null, null);
    update service set department_id = p_department_id where id = v_id;
    if nullif(v_item ->> 'category', '') is not null then
      update service set category_id = (v_item ->> 'category')::uuid where id = v_id
        and exists (select 1 from service_category c where c.id = (v_item ->> 'category')::uuid and c.deleted_at is null);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- Adjust prices: one category (new p_category_id), or a former group, or everything.
drop function if exists adjust_prices(service_group, text, numeric, integer);
create or replace function adjust_prices(
  p_group service_group default null,
  p_mode text default 'multiply',
  p_value numeric default 1,
  p_round integer default 100,
  p_category_id uuid default null
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_list uuid;
  v_count integer := 0;
  v_step integer := greatest(coalesce(p_round, 1), 1);
  r record;
  v_new numeric;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_mode not in ('multiply', 'percent', 'amount') or p_value is null then
    raise exception 'unknown adjustment' using errcode = '22023';
  end if;
  if p_mode = 'multiply' and (p_value <= 0 or p_value > 10) then
    raise exception 'the multiplier must be above 0 and at most 10' using errcode = '22023';
  end if;
  if p_mode = 'percent' and (p_value <= -100 or p_value > 900) then
    raise exception 'the percentage must be above -100 and at most 900' using errcode = '22023';
  end if;

  select id into v_list from price_list
  where payer_id is null and deleted_at is null and effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
  order by effective_from desc limit 1;
  if v_list is null then
    return 0;
  end if;

  for r in
    select pli.id, pli.price
    from price_list_item pli
    join service s on s.id = pli.service_id
    where pli.price_list_id = v_list and pli.deleted_at is null and s.deleted_at is null
      and (p_group is null or s.service_group = p_group)
      and (p_category_id is null or s.category_id = p_category_id)
      and pli.price > 0
  loop
    v_new := case p_mode
      when 'multiply' then r.price * p_value
      when 'percent' then r.price * (100 + p_value) / 100
      else r.price + p_value
    end;
    v_new := greatest(round(v_new / v_step) * v_step, 0);
    if v_new <> r.price then
      update price_list_item set price = v_new where id = r.id;
      v_count := v_count + 1;
    end if;
  end loop;

  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'update', 'price_list', v_list,
          jsonb_build_object('group', p_group, 'category', p_category_id, 'mode', p_mode, 'value', p_value,
                             'round', v_step, 'changed', v_count));
  return v_count;
end
$$;

revoke all on function save_category(uuid, text, text, text, category_kind), delete_category(uuid),
  set_service_category(uuid, uuid), move_category_to_department(uuid, uuid),
  adjust_prices(service_group, text, numeric, integer, uuid) from public, anon;
grant execute on function save_category(uuid, text, text, text, category_kind), delete_category(uuid),
  set_service_category(uuid, uuid), move_category_to_department(uuid, uuid),
  adjust_prices(service_group, text, numeric, integer, uuid) to authenticated;

-- ---------------------------------------------------------------- the catalogue with its category
create or replace view catalogue_services with (security_invoker = true) as
  select s.id, s.code, s.name_en, s.name_kin, s.name_fr, s.service_group, s.allow_manual_price,
         s.max_discount_pct, s.active, s.default_duration_min, s.booking_category,
         (select pf.price from price_for(s.id, null, null) pf) as cash_price,
         coalesce((
           select jsonb_object_agg(pl.payer_id::text, pli.price)
           from price_list pl
           join price_list_item pli on pli.price_list_id = pl.id
           where pl.payer_id is not null and pli.service_id = s.id
             and pl.deleted_at is null and pli.deleted_at is null
             and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
         ), '{}'::jsonb) as payer_prices,
         d.id as department_id,
         d.name as department_name,
         coalesce((select array_agg(sd.department_id order by (sd.department_id = s.department_id) desc, dd.name)
                   from service_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.service_id = s.id), '{}') as department_ids,
         coalesce((select array_agg(dd.name order by (sd.department_id = s.department_id) desc, dd.name)
                   from service_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.service_id = s.id), '{}') as department_names,
         s.category_id
  from service s
  left join department d on d.id = s.department_id and d.deleted_at is null
  where s.deleted_at is null;
revoke all on catalogue_services from anon;
grant select on catalogue_services to authenticated;

-- ---------------------------------------------------------------- dashboard: visits by category
create or replace function dashboard_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := is_manager();
  v_days integer := greatest(1, p_to - p_from + 1);
  v_prev_from date := p_from - v_days;
  v_prev_to date := p_from - 1;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_tiles jsonb;
  v_rev30 jsonb;
  v_collections jsonb;
  v_receivables jsonb;
  v_visits jsonb;
  v_wait jsonb;
  v_queue jsonb;
  v_top jsonb;
  v_staff jsonb;
  v_reorder jsonb;
  v_expiring jsonb;
  v_noshow jsonb;
  v_messages jsonb;
  v_claims jsonb;
  v_logins jsonb;
  v_services jsonb;
begin
  if not (v_manager or exists (select 1 from profiles where id = auth.uid() and active and dashboard is not null)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  -- headline tiles
  select jsonb_build_object(
    'registered', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'registeredPrev', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'visits', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'visitsPrev', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'waitingNow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'),
    'avgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date = v_today)), 0)
                   from queue_entry q where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'revenue', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to) end,
    'revenuePrev', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to) end,
    'openBills', case when v_manager then (select count(*) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'openBillsDue', case when v_manager then (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'bedsOccupied', (select count(*) from bed where deleted_at is null and status = 'occupied'),
    'bedsTotal', (select count(*) from bed where deleted_at is null and status <> 'out_of_service')
  ) into v_tiles;

  -- revenue per day, last 30 days ending today
  select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'amount', coalesce(s.amount, 0)) order by d), '[]'::jsonb) into v_rev30
  from generate_series(v_today - 29, v_today, interval '1 day') d
  left join (
    select (paid_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
    from payment where deleted_at is null and paid_at >= (v_today - 29)::timestamp
    group by 1
  ) s on s.day = d::date;

  select coalesce(jsonb_agg(jsonb_build_object('method', m, 'amount', coalesce(s.amount, 0)) order by s.amount desc nulls last), '[]'::jsonb) into v_collections
  from unnest(array['cash', 'momo', 'airtel', 'card', 'bank']::payment_method[]) m
  left join (
    select method, sum(amount) as amount from payment
    where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by method
  ) s on s.method = m;

  select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'count', c.n, 'amount', c.amount) order by c.amount desc), '[]'::jsonb) into v_receivables
  from (
    select payer_id, count(*) as n, sum(amount) as amount from claim
    where deleted_at is null and status in ('open', 'batched', 'submitted', 'rejected', 'resubmitted')
    group by payer_id
  ) c join payer py on py.id = c.payer_id;

  -- visits by service group (charged lines in the range)
  select coalesce(jsonb_agg(jsonb_build_object('group', g.grp, 'name', g.name, 'nameKin', g.kin, 'nameFr', g.fr,
                                                'count', g.n) order by g.n desc), '[]'::jsonb) into v_visits
  from (
    -- by the clinic's own categories; medicines (no service) count as pharmacy
    select coalesce(c.base_group::text, case when s.id is null then 'pharmacy' else 'other' end) as grp,
           c.name_en as name, c.name_kin as kin, c.name_fr as fr, count(distinct i.encounter_id) as n
    from invoice_line l
    join invoice i on i.id = l.invoice_id
    left join service s on s.id = l.service_id
    left join service_category c on c.id = s.category_id
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by c.id, 1, 2, 3, 4
  ) g;

  -- waiting time and queue by station (today)
  select coalesce(jsonb_agg(jsonb_build_object('station', w.station, 'minutes', w.minutes, 'waiting', w.waiting, 'longest', w.longest) order by w.station), '[]'::jsonb) into v_wait
  from (
    select q.station::text as station,
           round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date = v_today)) as minutes,
           count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open') as waiting,
           round(max(extract(epoch from now() - q.created_at) / 60) filter (where q.finished_at is null and q.started_at is null and e.status = 'open')) as longest
    from queue_entry q
    join encounter e on e.id = q.encounter_id
    where q.deleted_at is null
      and ((q.finished_at is null and e.status = 'open') or (q.created_at at time zone 'Africa/Kigali')::date = v_today)
    group by q.station
  ) w;

  -- top treatments in the range
  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'count', x.n, 'amount', case when v_manager then x.amount end) order by x.n desc), '[]'::jsonb) into v_top
  from (
    select l.description as name, count(*) as n, sum(round(l.unit_price * l.quantity)) as amount
    from invoice_line l
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by l.description
    order by count(*) desc
    limit 10
  ) x;

  -- who did what (accountability)
  select coalesce(jsonb_agg(jsonb_build_object(
      'name', p.full_name, 'role', p.role, 'staffId', p.staff_id,
      'registrations', coalesce(r.n, 0), 'vitals', coalesce(v.n, 0), 'charges', coalesce(c.n, 0),
      'payments', case when v_manager then coalesce(pm.n, 0) end,
      'collected', case when v_manager then coalesce(pm.amount, 0) end,
      'lastSignIn', p.last_sign_in_at
    ) order by (coalesce(r.n, 0) + coalesce(v.n, 0) + coalesce(c.n, 0) + coalesce(pm.n, 0)) desc, p.full_name), '[]'::jsonb) into v_staff
  from profiles p
  left join (select created_by as id, count(*) as n from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) r on r.id = p.id
  left join (select performer_id as id, count(distinct encounter_id) as n from observation where deleted_at is null and (effective_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) v on v.id = p.id
  left join (select entered_by as id, count(*) as n from invoice_line where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) c on c.id = p.id
  left join (select cashier_id as id, count(*) as n, sum(amount) as amount from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) pm on pm.id = p.id
  where p.active;

  -- stock
  select coalesce(jsonb_agg(jsonb_build_object('name', name_generic, 'onHand', on_hand, 'min', reorder_level) order by (on_hand::numeric / greatest(reorder_level, 1))), '[]'::jsonb) into v_reorder
  from items_below_reorder where on_hand < reorder_level;

  select jsonb_build_object(
    'd30', count(*) filter (where s.expiry <= v_today + 30),
    'd60', count(*) filter (where s.expiry > v_today + 30 and s.expiry <= v_today + 60),
    'd90', count(*) filter (where s.expiry > v_today + 60 and s.expiry <= v_today + 90)
  ) into v_expiring
  from (select batch_id, expiry, sum(quantity) as q from stock_on_hand where expiry is not null group by batch_id, expiry) s
  where s.q > 0;

  -- bookings
  select jsonb_build_object(
    'booked', count(*) filter (where status in ('confirmed', 'arrived', 'in_progress', 'completed', 'no_show')),
    'missed', count(*) filter (where status = 'no_show'),
    'pending', count(*) filter (where status = 'inquiry')
  ) into v_noshow
  from appointment where deleted_at is null and (coalesce(starts_at, created_at) at time zone 'Africa/Kigali')::date between p_from and p_to;

  select coalesce(jsonb_agg(jsonb_build_object('channel', ch, 'sent', coalesce(s.sent, 0), 'failed', coalesce(s.failed, 0)) order by ch), '[]'::jsonb) into v_messages
  from unnest(array['whatsapp', 'sms', 'email']::message_channel[]) ch
  left join (
    select channel, count(*) filter (where status in ('sent', 'delivered')) as sent, count(*) filter (where status = 'failed') as failed
    from message where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by channel
  ) s on s.channel = ch;

  select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'count', c.n, 'amount', case when v_manager then c.amount end) order by c.amount desc), '[]'::jsonb) into v_claims
  from (select payer_id, count(*) as n, sum(amount) as amount from claim where deleted_at is null and status = 'open' group by payer_id) c
  join payer py on py.id = c.payer_id;

  select coalesce(jsonb_agg(jsonb_build_object('name', p.full_name, 'role', p.role, 'at', a.at, 'reason', a.reason) order by a.at desc), '[]'::jsonb) into v_logins
  from (select actor_id, at, reason from audit_event where action = 'login' and at > now() - interval '1 day' order by at desc limit 12) a
  join profiles p on p.id = a.actor_id;

  select jsonb_build_object('active', count(*) filter (where active), 'total', count(*)) into v_services from service where deleted_at is null;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'manager', v_manager, 'generatedAt', now(),
    'tiles', v_tiles, 'revenue30d', v_rev30, 'collections', v_collections, 'receivables', v_receivables,
    'visitsByGroup', v_visits, 'waitByStation', v_wait, 'topTreatments', v_top, 'staff', v_staff,
    'reorder', v_reorder, 'expiring', v_expiring, 'bookings', v_noshow, 'messages', v_messages,
    'claims', v_claims, 'logins', v_logins, 'services', v_services
  );
end
$$;


-- ============================================================ 20261031180000_audit_departments.sql
-- 0050 · Departments and categories appear in the activity history.
--
-- Creating, renaming or deleting a department (or a treatment category) wrote nothing to
-- audit_event, so the History page never showed it. Both tables now carry the audit trigger
-- (not the updated_at trigger: they have no updated_at column), and categories belong to the
-- "settings and staff" group of the history like departments.

drop trigger if exists trg_audit on department;
create trigger trg_audit after insert or update or delete on department
  for each row execute function audit_row();
drop trigger if exists trg_audit on service_category;
create trigger trg_audit after insert or update or delete on service_category
  for each row execute function audit_row();

create or replace function activity_group(p_entity text, p_action audit_action)
returns text
language sql immutable
as $$
  select case
    when p_action = 'login' then 'signin'
    when p_entity in ('patient', 'encounter', 'appointment', 'coverage') then 'patients'
    when p_entity = 'observation' then 'vitals'
    when p_entity = 'queue_entry' then 'queue'
    when p_entity in ('invoice', 'invoice_line', 'payment', 'credit_note', 'day_close', 'claim') then 'billing'
    when p_entity in ('condition', 'medication_request', 'service_request', 'procedure',
                      'diagnostic_report', 'internal_task', 'vaccination', 'medication_dispense',
                      'hiv_test', 'fp_event') then 'clinical'
    when p_entity in ('bed', 'bed_stay') then 'beds'
    when p_entity in ('profiles', 'setting', 'department', 'service', 'service_category', 'payer', 'plan',
                      'price_list', 'price_list_item', 'practitioner') or p_action = 'settings' then 'admin'
    else 'other'
  end
$$;


-- ============================================================ seed.sql
-- Muhazi Medical Clinic System — reference data and sample catalogue
-- Payers and plans, preset services with cash and RSSB tariffs, pharmacy items, practitioners,
-- stock locations, beds, templates and clinic settings. Prices are illustrative (doc §4.5 example).
-- Staff accounts are created by scripts/seed-staff.mjs (they live in Supabase Auth).

-- ---------------------------------------------------------------- payers and plans
-- The clinic has no insurance partners yet: insurers are seeded inactive so billing can be set up
-- later without re-seeding. `public_payers` (and therefore the public site) lists active ones only.
insert into payer (code, name, type, cycle_day, active) values
  ('CASH',    'Cash',                    'cash',      null, true),
  ('RAMA',    'RSSB RAMA',               'rssb_rama', 5,    false),
  ('CBHI',    'Mutuelle de Santé (CBHI)','cbhi',      5,    false),
  ('MMI',     'MMI',                     'mmi',       10,   false),
  ('RADIANT', 'Radiant',                 'private',   10,   false),
  ('PRIME',   'Prime',                   'private',   10,   false),
  ('BRITAM',  'Britam',                  'private',   10,   false);

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

