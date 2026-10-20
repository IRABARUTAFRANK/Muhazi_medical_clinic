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
