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
