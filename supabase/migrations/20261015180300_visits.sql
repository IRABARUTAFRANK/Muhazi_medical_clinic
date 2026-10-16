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
