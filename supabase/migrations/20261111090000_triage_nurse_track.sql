-- 0070 · A named triage nurse; reception follows a patient it has sent on; the visit's track.
-- Triage is chosen like a service: anyone at triage or one nurse there (with what each does now),
-- so a patient is not sent to every nurse when one is meant. With "triage first", the nurse who
-- measures can be named too. Once the patient has left reception (triage, a doctor, the lab…),
-- reception follows the visit but no longer sends the patient elsewhere: the person who has the
-- patient does. The visit's track (start, each desk, treatment finished, payment, left) reads
-- from visit_journey, which now also says when the treatment finished and why a patient left.

create or replace function service_station(p_service text)
returns station
language sql immutable
as $$
  select case p_service
    when 'consultation' then 'consultation'
    when 'dental' then 'dental'
    when 'laboratory' then 'laboratory'
    when 'ultrasound' then 'ultrasound'
    when 'nursing' then 'nursing'
    when 'surgery' then 'theatre'
    when 'circ' then 'theatre'
    when 'fp' then 'nursing'
    when 'hiv' then 'nursing'
    when 'pharmacy' then 'pharmacy'
    when 'triage' then 'triage'
  end::station
$$;

create or replace function staff_serves(p_user uuid, p_service text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles p
    left join practitioner pr on pr.user_id = p.id and pr.deleted_at is null
    where p.id = p_user and p.active and (
      -- the services written in the person's calendar
      (coalesce(array_length(pr.categories, 1), 0) > 0 and p_service = any (pr.categories)
       and p.role in ('doctor', 'sonographer', 'nurse'))
      -- no service in the calendar: the person's desk
      or (coalesce(array_length(pr.categories, 1), 0) = 0 and p.role = 'doctor' and (
            (p_service = 'dental' and lower(coalesce(p.station, '')) ~ 'dent')
            or (p_service in ('surgery', 'circ') and lower(coalesce(p.station, '')) ~ '(theat|surg|circ)')
            or (p_service = 'ultrasound' and lower(coalesce(p.station, '')) ~ '(ultra|echo)')
            or (p_service = 'consultation' and lower(coalesce(p.station, '')) !~ '(dent|theat|surg|ultra|echo)')))
      or (p.role = 'sonographer' and p_service = 'ultrasound')
      or (p.role = 'nurse' and p_service in ('nursing', 'fp', 'hiv'))
      or (p.role = 'lab_tech' and p_service = 'laboratory')
      or (p.role = 'pharmacist' and p_service = 'pharmacy')
      or (p.role = 'nurse' and p_service = 'triage')
    )
  )
$$;

drop function if exists begin_visit(uuid, station, uuid, text, boolean, boolean, text, uuid);

create or replace function begin_visit(
  p_patient_id uuid,
  p_station station default 'consultation',
  p_department_id uuid default null,
  p_note text default null,
  p_myself boolean default false,
  p_emergency boolean default false,
  p_service text default null,
  p_assigned_to uuid default null,
  p_triage_to uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_role role_key := current_role_key();
  v_desk station := coalesce(case when not p_myself then service_station(p_service) end, p_station);
  v_station station;
  v_enc uuid;
  v_q queue_entry%rowtype;
begin
  if not has_perm('queue.write') or not has_perm('visit.start') then
    raise exception 'you may not start visits (the manager has not allowed it)' using errcode = '42501';
  end if;
  if p_emergency and v_role in ('receptionist', 'cashier') then
    raise exception 'only treating staff can register an emergency' using errcode = '42501';
  end if;
  if p_service is not null and service_station(p_service) is null then
    raise exception 'unknown service' using errcode = '22023';
  end if;
  if p_myself and not (
       v_role = 'manager'
       or (v_role = 'doctor' and v_desk in ('consultation', 'dental', 'theatre', 'ultrasound'))
       or (v_role = 'nurse' and v_desk in ('triage', 'nursing', 'beds'))
       or (v_role = 'lab_tech' and v_desk = 'laboratory')
       or (v_role = 'sonographer' and v_desk = 'ultrasound')
       or (v_role = 'pharmacist' and v_desk = 'pharmacy')) then
    raise exception 'you do not work at % : send the patient there instead', initcap(v_desk::text)
      using errcode = '42501';
  end if;
  if p_assigned_to is not null and (p_service is null or not staff_serves(p_assigned_to, p_service)) then
    raise exception 'that person does not give this service' using errcode = '22023';
  end if;
  if p_triage_to is not null and not staff_serves(p_triage_to, 'triage') then
    raise exception 'that person does not work at triage' using errcode = '22023';
  end if;
  if p_department_id is not null and not exists (
       select 1 from department d where d.id = p_department_id and d.deleted_at is null
         and station_role(v_desk) = any (d.roles)) then
    raise exception 'that department does not work at %', initcap(v_desk::text) using errcode = '22023';
  end if;
  if exists (select 1 from encounter where patient_id = p_patient_id and status = 'open') then
    raise exception 'this patient already has an open visit' using errcode = '23505';
  end if;

  v_station := case
    when p_myself or p_emergency then v_desk
    when triage_first() then 'triage'::station
    else v_desk end;
  v_enc := open_encounter(p_patient_id, 'opd', v_station);
  -- the service and the person chosen stay with the visit (used after triage)
  update encounter
  set service = p_service, intended_to = case when p_myself then auth.uid() else p_assigned_to end,
      practitioner_id = case
        when p_assigned_to is not null and exists (select 1 from profiles where id = p_assigned_to and role = 'doctor')
        then ensure_practitioner(p_assigned_to) else practitioner_id end
  where id = v_enc;

  if p_emergency then
    update encounter
    set triage_level = 'red', triage_reason = 'Emergency: registered directly at ' || v_station::text
    where id = v_enc;
    update queue_entry set priority = 1 where encounter_id = v_enc;
  end if;

  select * into v_q from queue_entry
  where encounter_id = v_enc and station = v_station and finished_at is null and deleted_at is null
  order by created_at limit 1;
  update queue_entry
  set referral_note = coalesce(nullif(trim(coalesce(p_note, '')), ''), referral_note),
      service = p_service,
      department_id = case when v_station = v_desk and p_assigned_to is null then coalesce(p_department_id, department_id) else department_id end,
      assigned_to = case
        when v_station = 'triage' and not p_myself then coalesce(p_triage_to, assigned_to)
        when v_station = v_desk and not p_myself then coalesce(p_assigned_to, assigned_to)
        else assigned_to end,
      referred_by = auth.uid()
  where id = v_q.id
  returning * into v_q;
  if p_myself then
    perform take_patient(v_q.id);
    delete from notification where kind = 'queue' and params ->> 'queue' = v_q.id::text;
  elsif v_q.assigned_to is not null then
    -- the person chosen is told (instead of everyone at the desk)
    perform notify_queue_entry_row(v_q);
  end if;

  return jsonb_build_object(
    'encounter_id', v_enc,
    'ticket_no', v_q.ticket_no,
    'station', v_station,
    'myself', p_myself,
    'assigned', (select full_name from profiles where id = v_q.assigned_to),
    'department', (select name from department where id = p_department_id));
end
$$;

revoke all on function begin_visit(uuid, station, uuid, text, boolean, boolean, text, uuid, uuid) from public, anon;
grant execute on function begin_visit(uuid, station, uuid, text, boolean, boolean, text, uuid, uuid) to authenticated;

-- Reception sends a patient on only while the patient is with reception (or waiting nowhere):
-- once sent to triage, a doctor, the lab or any desk, reception follows the visit.
create or replace function may_route(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select may_work_on(p_encounter_id)
    or (current_role_key() = 'receptionist'
        and not exists (select 1 from queue_entry q
                        where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
                          and q.station <> 'reception'))
$$;

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
      'referredBy', rb.full_name, 'note', q.referral_note, 'enteredBy', eb.full_name,
      'service', q.service, 'department', (select d.name from department d where d.id = q.department_id)
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
    -- the track: treatment finished, why the patient left, what they came for
    'treatmentDoneAt', v_enc.clinical_done_at, 'leftReason', v_enc.left_reason, 'service', v_enc.service,
    'steps', v_steps, 'vitals', v_vitals, 'diagnoses', v_dx, 'medicines', v_meds, 'tests', v_tests,
    'charges', v_charges, 'payments', v_payments, 'bill', v_bill
  );
end
$$;
