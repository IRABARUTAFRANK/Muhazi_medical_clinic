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
