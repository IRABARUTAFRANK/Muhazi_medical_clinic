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
