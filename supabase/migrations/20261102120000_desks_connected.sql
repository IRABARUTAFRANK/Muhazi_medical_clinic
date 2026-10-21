-- 0057 · The desks connected (dashboard audit, wave 1).
-- Payments: whoever may take payments can record them (receptionists too), every payment has
-- a receipt number, the bill stays open while the visit goes on (later tests and medicines can
-- still be charged) and the visit closes by itself when it is paid and nothing is left to do.
-- Queue: the triage colour travels from desk to desk, a booked patient waits for the doctor of
-- the booking, no new queue place for a finished visit; reception can send on a patient waiting
-- at another desk. Cover no longer moves patients away from the doctor. Pharmacy: back to the
-- doctor who asked, never an expired batch, sales without a prescription, pharmacists set
-- medicine prices. Laboratory: a patient who came straight to the lab goes on to the cashier.
-- The doctor's lists: tests ordered (my_orders) and prescriptions written (my_prescriptions).

alter table payment add column if not exists receipt_no text;


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
  v_year integer := extract(year from now())::integer;
begin
  -- the cashier, and anyone the manager allows to take payments (Settings → Who may do what)
  if not (has_perm('billing.write') or has_perm('payment.take')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_method in ('momo', 'airtel', 'card', 'bank') and nullif(trim(coalesce(p_reference, '')), '') is null then
    raise exception 'a transaction reference is required for %', p_method using errcode = '22023';
  end if;
  insert into payment (invoice_id, method, amount, reference, payer_phone, receipt_no)
  values (p_invoice_id, p_method, p_amount, p_reference, p_payer_phone,
          'RCT-' || v_year || '-' || lpad(next_number('receipt', v_year)::text, 6, '0'))
  returning id into v_id;
  return v_id;
end
$$;

-- Posting without the permission check: called when a visit ends (settle_visit).
create or replace function post_invoice_now(p_invoice_id uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_inv invoice%rowtype;
  v_year integer := extract(year from now())::integer;
  v_number text;
  v_member text;
begin
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

create or replace function post_invoice(p_invoice_id uuid)
returns text
language plpgsql security definer set search_path = public
as $$
begin
  if not (has_perm('billing.write') or has_perm('payment.take')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return post_invoice_now(p_invoice_id);
end
$$;


-- Something is still to be done for this visit: a desk holds or expects the patient (not the
-- cashier), a medicine waits at the pharmacy, a test is not finished, or a bed is occupied.
create or replace function visit_work_left(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from queue_entry q where q.encounter_id = p_encounter_id and q.finished_at is null
                   and q.deleted_at is null and q.station <> 'cashier')
      or exists (select 1 from medication_request m where m.encounter_id = p_encounter_id and rx_pending(m))
      or exists (select 1 from service_request r where r.encounter_id = p_encounter_id and r.deleted_at is null
                   and r.status in ('ordered', 'collected', 'in_process'))
      or exists (select 1 from bed_stay b where b.encounter_id = p_encounter_id and b.deleted_at is null
                   and b.discharged_at is null)
$$;

-- Nothing due and nothing left to do: the visit ends (off the cashier's queue, bill posted).
create or replace function settle_visit(p_encounter_id uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v_inv uuid;
  v_closed boolean := false;
begin
  select id into v_inv from invoice where encounter_id = p_encounter_id;
  if v_inv is not null and invoice_balance(v_inv) > 0 then
    return false;
  end if;
  if visit_work_left(p_encounter_id) then
    return false;
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = 'cashier' and finished_at is null;
  update encounter set status = 'closed', closed_at = now(), closed_by = auth.uid()
  where id = p_encounter_id and status = 'open';
  v_closed := found;
  if v_inv is not null and exists (select 1 from invoice where id = v_inv and status = 'draft')
     and exists (select 1 from invoice_line where invoice_id = v_inv and deleted_at is null) then
    perform post_invoice_now(v_inv);
  end if;
  return v_closed;
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
  v_pay uuid;
  v_receipt text;
begin
  if not has_perm('payment.take') then
    raise exception 'you may not take payments (the manager has not allowed it)' using errcode = '42501';
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
  v_pay := record_payment(v_invoice.id, p_method, p_amount, p_reference, p_payer_phone);
  select receipt_no into v_receipt from payment where id = v_pay;
  v_balance := invoice_balance(v_invoice.id);
  if v_balance <= 0 then
    -- Paid so far: off the cashier's queue. The bill stays open while the visit goes on (a
    -- test or a medicine may still be added); it is posted when the visit ends.
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = 'cashier' and finished_at is null;
    v_closed := settle_visit(p_encounter_id);
  end if;
  select number into v_number from invoice where id = v_invoice.id;
  return jsonb_build_object('balance', v_balance, 'number', v_number, 'closed', v_closed,
                            'status', (select status from invoice where id = v_invoice.id),
                            'receipt', v_receipt, 'paymentId', v_pay);
end
$$;


-- Every new queue place: never for a finished visit; the triage colour comes along (red first);
-- a patient who booked waits for the doctor of the booking at a doctors' desk.
create or replace function queue_entry_defaults()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_enc encounter%rowtype;
  v_doc uuid;
begin
  select * into v_enc from encounter where id = new.encounter_id;
  if not found or v_enc.status <> 'open' then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  new.priority := least(coalesce(new.priority, 3),
                        case v_enc.triage_level when 'red' then 1 when 'yellow' then 2 else 3 end);
  if new.assigned_to is null and new.pool_id is null and new.department_id is null
     and station_role(new.station) = 'doctor' and v_enc.appointment_id is not null then
    select pr.user_id into v_doc
    from appointment a
    join practitioner pr on pr.id = a.practitioner_id
    join profiles p on p.id = pr.user_id and p.active
    where a.id = v_enc.appointment_id;
    new.assigned_to := v_doc;
  end if;
  return new;
end
$$;
drop trigger if exists queue_entry_defaults_trg on queue_entry;
create trigger queue_entry_defaults_trg before insert on queue_entry
  for each row execute function queue_entry_defaults();

-- Leaving a desk: its queue place ends. Reception (or the manager) sending on a patient who waits
-- at another desk nobody has taken: that waiting place is given up for the new one.
create or replace function leave_desk(p_encounter_id uuid, p_station station)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = p_station and finished_at is null;
  if not found and current_role_key() in ('receptionist', 'manager') then
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and finished_at is null and deleted_at is null
      and assigned_to is null and taken_by is null and station not in ('cashier', 'pharmacy');
  end if;
end
$$;

-- A booked visit ends: the booking is completed.
create or replace function appointment_follows_visit()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'closed' and old.status is distinct from 'closed' and new.appointment_id is not null then
    update appointment set status = 'completed'
    where id = new.appointment_id and status in ('approved', 'confirmed', 'arrived', 'in_progress');
  end if;
  return new;
end
$$;
drop trigger if exists encounter_appointment_done on encounter;
create trigger encounter_appointment_done after update of status on encounter
  for each row execute function appointment_follows_visit();


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
  perform assert_may_work_on(p_encounter_id, true);
  perform leave_desk(p_encounter_id, p_station);
  if p_next = 'cashier'
     and coalesce((select invoice_balance(i.id) from invoice i where i.encounter_id = p_encounter_id), 0) <= 0 then
    -- nothing to pay: no queue at the cashier; the visit ends when nothing else is left
    perform settle_visit(p_encounter_id);
  elsif p_next is not null then
    select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
    if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = p_next and finished_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no) values (p_encounter_id, p_next, coalesce(v_ticket, 'A-000'));
    end if;
  end if;
end
$$;

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
  perform assert_may_work_on(p_encounter_id, true);
  if p_next is null or cardinality(p_next) = 0 then
    raise exception 'choose where the patient goes' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  perform leave_desk(p_encounter_id, p_station);
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

create or replace function refer_patient(
  p_encounter_id uuid,
  p_from station,
  p_to station,
  p_to_user uuid default null,
  p_note text default null,
  p_return boolean default false,
  p_department uuid default null
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
  perform assert_may_work_on(p_encounter_id, true);
  if p_department is not null and not exists (select 1 from department where id = p_department and deleted_at is null) then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  -- A covered doctor keeps the patient: the covering nurse may work on it meanwhile
  -- (queue_entry_for_me), and it is still the doctor's when the cover ends.
  if p_to_user is not null and not exists (select 1 from profiles where id = p_to_user and active) then
    raise exception 'that colleague is not an active employee' using errcode = '22023';
  end if;
  perform leave_desk(p_encounter_id, p_from);
  -- Already waiting at that desk: update the waiting entry instead of adding a second one.
  update queue_entry
  set assigned_to = p_to_user, department_id = p_department, referred_by = auth.uid(),
      referral_note = nullif(trim(coalesce(p_note, '')), ''),
      return_station = case when p_return then p_from end,
      return_to = case when p_return then auth.uid() end
  where encounter_id = p_encounter_id and station = p_to and finished_at is null and deleted_at is null
  returning id into v_id;
  if v_id is null then
    select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
    insert into queue_entry (encounter_id, station, ticket_no, assigned_to, department_id, referred_by, referral_note,
                             return_station, return_to)
    values (p_encounter_id, p_to, coalesce(v_ticket, 'A-000'), p_to_user, p_department, auth.uid(),
            nullif(trim(coalesce(p_note, '')), ''),
            case when p_return then p_from end,
            case when p_return then auth.uid() end)
    returning id into v_id;
  end if;
  return jsonb_build_object('queueId', v_id, 'station', p_to);
end
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
  -- The doctor's waiting patients stay theirs; the nurse may work on them during the cover.
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
  perform give_back_covered(p_id);
end
$$;

-- Patients an earlier version moved to the covering nurse, not taken by her: back to the doctor.
create or replace function give_back_covered(p_cover_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update queue_entry q
  set assigned_to = c.doctor_id,
      referral_note = nullif(replace(replace(q.referral_note, ' · covering for ' || d.full_name, ''),
                                     'covering for ' || d.full_name, ''), '')
  from clinician_cover c
  join profiles d on d.id = c.doctor_id
  where c.id = p_cover_id and q.assigned_to = c.nurse_id and q.taken_by is null
    and q.finished_at is null and q.deleted_at is null
    and q.referral_note like '%covering for ' || d.full_name || '%';
end
$$;

-- Covers already over: give their patients back now.
do $$
declare
  v_id uuid;
begin
  for v_id in select id from clinician_cover where ended_at is not null or ends_at <= now() loop
    perform give_back_covered(v_id);
  end loop;
end
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
  -- The visit belongs to the booking: the booked doctor gets the patient at their desk
  -- (queue_entry_defaults) and the booking completes when the visit ends.
  update encounter
  set appointment_id = coalesce(appointment_id, v_appt.id),
      practitioner_id = coalesce(practitioner_id, v_appt.practitioner_id)
  where id = (v_visit ->> 'encounter_id')::uuid;
  update appointment set status = 'arrived' where id = p_appointment_id;
  return v_visit;
end
$$;


-- Nothing left to hand over: back to the colleague who asked for the patient; otherwise, when no
-- desk holds the patient any more, on to the cashier if money is due, or the visit ends.
create or replace function after_pharmacy(p_encounter_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_q queue_entry%rowtype;
  v_ticket text;
begin
  if exists (select 1 from medication_request m where m.encounter_id = p_encounter_id and rx_pending(m)) then
    return;
  end if;
  select * into v_q from queue_entry
  where encounter_id = p_encounter_id and station = 'pharmacy' and finished_at is null and deleted_at is null
  order by created_at desc limit 1;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = 'pharmacy' and finished_at is null and deleted_at is null;
  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
  if v_q.return_station is not null then
    if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = v_q.return_station
                   and finished_at is null and deleted_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no, priority, assigned_to, referred_by, referral_note)
      values (p_encounter_id, v_q.return_station, coalesce(v_ticket, 'A-000'), v_q.priority, v_q.return_to,
              auth.uid(), 'Medicines handed over');
    end if;
    return;
  end if;
  -- a doctor, nurse or the lab still has the patient: they carry on
  if exists (select 1 from queue_entry q where q.encounter_id = p_encounter_id and q.finished_at is null
             and q.deleted_at is null and station_role(q.station) in ('doctor', 'nurse', 'lab_tech', 'sonographer')) then
    return;
  end if;
  if exists (select 1 from invoice i where i.encounter_id = p_encounter_id and invoice_balance(i.id) > 0) then
    if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'cashier'
                   and finished_at is null and deleted_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no, referred_by, referral_note)
      values (p_encounter_id, 'cashier', coalesce(v_ticket, 'A-000'), auth.uid(), 'Medicines handed over');
    end if;
  else
    perform settle_visit(p_encounter_id);
  end if;
end
$$;


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
      and (s.expiry is null or s.expiry >= current_date)   -- never an expired batch
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
    if exists (select 1 from stock_on_hand s where s.item_id = p_item_id and s.location_id = p_location_id
               and s.quantity > 0 and s.expiry < current_date) then
      raise exception 'not enough stock that is not expired: % unit(s) short (write the expired stock off)', v_remaining
        using errcode = '23514';
    end if;
    raise exception 'insufficient stock: % unit(s) short', v_remaining using errcode = '23514';
  end if;
  return v_dispense_id;
end
$$;

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
      and (s.expiry is null or s.expiry >= current_date)   -- expired stock is not sent on
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
                       where s.item_id = m.item_id and l.type = 'pharmacy'
                         and (s.expiry is null or s.expiry >= current_date)),
    'expiredInPharmacy', (select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s
                          join stock_location l on l.id = s.location_id
                          where s.item_id = m.item_id and l.type = 'pharmacy' and s.expiry < current_date),
    'doctorHolds', exists (select 1 from queue_entry q where q.encounter_id = m.encounter_id and q.finished_at is null
                           and q.deleted_at is null and station_role(q.station) = 'doctor')
  ) order by m.created_at), '[]'::jsonb)
  from medication_request m
  join encounter e on e.id = m.encounter_id and e.status = 'open'
  join patient p on p.id = e.patient_id
  join item i on i.id = m.item_id
  left join profiles pr on pr.id = coalesce(m.prescriber_id, m.created_by)
  where has_perm('stock.read') and rx_pending(m)
$$;

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
  -- the manager, and the pharmacy for its medicines and their prices
  if not (has_perm('catalogue.write') or has_perm('item_price.write')) then
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


-- The pharmacy sells a medicine to a patient in the clinic without a prescription (or adds one the
-- doctor forgot): written as a pharmacy line by the pharmacist, handed over and charged at once.
create or replace function sell_medicine(
  p_encounter_id uuid,
  p_item_id uuid,
  p_quantity numeric,
  p_instructions text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if not has_perm('stock.dispense') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'the quantity must be more than zero' using errcode = '22023';
  end if;
  if not exists (select 1 from item where id = p_item_id and deleted_at is null) then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  insert into medication_request (encounter_id, item_id, quantity, instructions, supply, prescriber_id)
  values (p_encounter_id, p_item_id, p_quantity,
          coalesce(nullif(trim(coalesce(p_instructions, '')), ''), 'Pharmacy sale'), 'pharmacy', auth.uid())
  returning id into v_id;
  return dispense_prescription(v_id, null) || jsonb_build_object('requestId', v_id);
end
$$;


create or replace function after_desk_tests(p_encounter_id uuid, p_station station, p_requester uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_q queue_entry%rowtype;
  v_back station;
  v_to uuid;
  v_tests text;
begin
  if exists (select 1 from service_request r
             where r.encounter_id = p_encounter_id and r.deleted_at is null
               and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) = p_station
               and r.status not in ('resulted', 'verified', 'cancelled')) then
    return;
  end if;
  select * into v_q from queue_entry
  where encounter_id = p_encounter_id and station = p_station and finished_at is null and deleted_at is null
  order by created_at desc limit 1;
  if not found then
    return;
  end if;
  v_back := v_q.return_station;
  v_to := v_q.return_to;
  if v_back is null and p_requester is not null then
    v_to := p_requester;
    select q.station into v_back from queue_entry q
    where q.encounter_id = p_encounter_id and q.station <> p_station
      and (q.taken_by = p_requester or q.assigned_to = p_requester)
    order by q.created_at desc limit 1;
    if v_back is null then
      select case p.role when 'doctor' then 'consultation'::station when 'nurse' then 'nursing'::station end
      into v_back from profiles p where p.id = p_requester;
    end if;
  end if;
  if v_back is null then
    -- nobody asked for the patient back (came straight to the lab): the lab's part is over;
    -- on to the cashier if money is due, otherwise the visit ends when nothing else is left
    update queue_entry set finished_at = now() where id = v_q.id;
    if exists (select 1 from queue_entry q where q.encounter_id = p_encounter_id and q.finished_at is null
               and q.deleted_at is null and station_role(q.station) in ('doctor', 'nurse', 'lab_tech', 'sonographer')) then
      return;
    end if;
    if exists (select 1 from invoice i where i.encounter_id = p_encounter_id and invoice_balance(i.id) > 0) then
      if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'cashier'
                     and finished_at is null and deleted_at is null) then
        insert into queue_entry (encounter_id, station, ticket_no, priority, referred_by, referral_note)
        values (p_encounter_id, 'cashier', v_q.ticket_no, v_q.priority, auth.uid(), 'Tests done');
      end if;
    else
      perform settle_visit(p_encounter_id);
    end if;
    return;
  end if;
  update queue_entry set finished_at = now() where id = v_q.id;
  if not exists (select 1 from queue_entry where encounter_id = p_encounter_id
                 and station = v_back and finished_at is null and deleted_at is null) then
    select string_agg(s.name_en || case when r.status = 'cancelled' then ' (not done)' else '' end, ', ' order by r.created_at)
    into v_tests
    from service_request r join service s on s.id = r.service_id
    where r.encounter_id = p_encounter_id and r.deleted_at is null
      and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) = p_station
      and (r.status in ('resulted', 'verified') or (r.status = 'cancelled' and r.updated_at > now() - interval '1 day'));
    insert into queue_entry (encounter_id, station, ticket_no, priority, assigned_to, referred_by, referral_note)
    values (p_encounter_id, v_back, v_q.ticket_no, v_q.priority, v_to, auth.uid(),
            'Results ready: ' || coalesce(v_tests, ''));
  end if;
end
$$;


-- Tests I ordered (the last p_days days), with their state and result.
create or replace function my_orders(p_days integer default 7)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb)
  from (
    select r.created_at as at, jsonb_build_object(
      'id', r.id, 'encounterId', r.encounter_id, 'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'test', s.name_en,
      'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end),
      'status', r.status, 'priority', r.priority, 'reason', r.reason, 'orderedAt', r.created_at,
      'findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
      'resultAt', coalesce(d.verified_at, d.updated_at),
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
      'visitOpen', e.status = 'open') as j
    from service_request r
    join encounter e on e.id = r.encounter_id
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and r.requester_id = auth.uid()
      and r.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90)))
  ) x
$$;

-- Prescriptions I wrote (the last p_days days), with what the pharmacy did.
create or replace function my_prescriptions(p_days integer default 7)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb)
  from (
    select m.created_at as at, jsonb_build_object(
      'id', m.id, 'encounterId', m.encounter_id, 'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'item', i.name_generic || coalesce(' ' || i.strength, ''), 'quantity', m.quantity,
      'dose', m.dose, 'frequency', m.frequency, 'days', m.duration_days, 'instructions', m.instructions,
      'supply', m.supply, 'at', m.created_at,
      'state', case
                 when m.not_given_at is not null then 'not_given'
                 when m.supply = 'room' then 'room'
                 when m.given_at is not null
                      or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null)
                   then 'given'
                 else 'waiting' end,
      'givenAt', m.given_at, 'notGivenReason', m.not_given_reason,
      'visitOpen', e.status = 'open') as j
    from medication_request m
    join encounter e on e.id = m.encounter_id
    join patient p on p.id = e.patient_id
    join item i on i.id = m.item_id
    where m.deleted_at is null and coalesce(m.prescriber_id, m.created_by) = auth.uid()
      and m.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90)))
  ) x
$$;


create or replace function visit_routing(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'queueId', q.id, 'station', q.station, 'since', q.created_at,
      'assignedTo', q.assigned_to, 'assignedName', a.full_name,
      'referredBy', q.referred_by, 'referredName', r.full_name, 'note', q.referral_note,
      'returnStation', q.return_station, 'returnTo', q.return_to, 'returnName', b.full_name,
      'takenBy', q.taken_by, 'takenName', t.full_name, 'canWork', queue_entry_for_me(q.id)
    ) order by q.created_at), '[]'::jsonb)
  from queue_entry q
  left join profiles a on a.id = q.assigned_to
  left join profiles r on r.id = q.referred_by
  left join profiles b on b.id = q.return_to
  left join profiles t on t.id = q.taken_by
  where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
    and has_perm('queue.read')
$$;


revoke all on function post_invoice_now(uuid), visit_work_left(uuid), settle_visit(uuid), leave_desk(uuid, station),
  give_back_covered(uuid), queue_entry_defaults(), appointment_follows_visit() from public, anon, authenticated;
revoke all on function sell_medicine(uuid, uuid, numeric, text), my_orders(integer), my_prescriptions(integer)
  from public, anon;
grant execute on function sell_medicine(uuid, uuid, numeric, text), my_orders(integer), my_prescriptions(integer)
  to authenticated;

