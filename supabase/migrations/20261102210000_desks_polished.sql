-- 0060 · Desks polished (dashboard audit, wave 3).
-- The lab bench and its figures leave tests of finished visits; a doctor's results are the
-- tests they ordered; bookings to accept leave once past. A bill line can be removed only by
-- someone working on the patient, and lines made by an order, a hand-over or a bed stay only by
-- the manager (the desk cancels the order instead). Taking a patient records the treating doctor
-- on the visit and starts the booking. "Call next" sends only patients waiting for a doctor,
-- at triage or reception. The lab and the pharmacy can read the visit's record. A result cannot
-- be written on a test marked "not done". Starting a sample starts the patient at the lab.
-- Orders can be urgent (priority).


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
    join encounter e on e.id = r.encounter_id and (p_scope = 'done' or e.status = 'open')
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and has_perm('orders.read')
      and r.category = any (my_test_categories()) and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) in ('laboratory', 'ultrasound')
      and case when p_scope = 'done'
            then r.status in ('resulted', 'verified')
                 and (coalesce(d.verified_at, d.updated_at) at time zone 'Africa/Kigali')::date
                     = (now() at time zone 'Africa/Kigali')::date
            else r.status not in ('verified', 'cancelled') end
  ) x
$$;

create or replace function lab_summary()
returns jsonb
language sql stable security definer set search_path = public
as $$
  with today as (select (now() at time zone 'Africa/Kigali')::date as d),
  mine as (
    select r.*, d.verified_at, d.updated_at as result_at
    from service_request r
    join encounter e on e.id = r.encounter_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and r.category = any (my_test_categories())
      -- a finished visit's open test is no longer on the bench
      and (e.status = 'open' or r.status in ('resulted', 'verified', 'cancelled')) and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) in ('laboratory', 'ultrasound') and has_perm('orders.read')
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
  where a.deleted_at is null and a.status = 'approved' and a.practitioner_id = v_practitioner
    and a.starts_at > now() - interval '1 day';

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
    -- a doctor's results are the tests they ordered
    and (v_role is distinct from 'doctor' or sr.requester_id = auth.uid());

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

create or replace function void_charge(p_line_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice uuid;
  v_line invoice_line%rowtype;
  v_enc uuid;
begin
  if not has_perm('charge.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select l.* into v_line from invoice_line l where l.id = p_line_id;
  select i.encounter_id into v_enc from invoice i where i.id = v_line.invoice_id;
  if not is_manager() then
    -- only someone working on the patient (the cashier works on the bill)
    if current_role_key() <> 'cashier' then
      perform assert_may_work_on(v_enc);
    end if;
    -- a line made by an order, a hand-over or a bed stay goes with it: cancel the order
    if v_line.source_type is not null then
      raise exception 'this line comes from % : undo it there (the manager can remove it)',
        case v_line.source_type when 'service_request' then 'a test or order ("Cannot do")'
                                when 'medication_dispense' then 'a medicine handed over'
                                when 'medication_request' then 'a medicine given here'
                                when 'bed_stay' then 'a bed stay'
                                else v_line.source_type end
        using errcode = '42501';
    end if;
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
  if not queue_entry_for_me(p_queue_id) then
    raise exception 'this patient was sent to %', coalesce(patient_holder(v_q.encounter_id), 'another desk')
      using errcode = '42501';
  end if;
  update queue_entry
  set called_at = coalesce(called_at, now()), started_at = coalesce(started_at, now()),
      taken_by = auth.uid()
  where id = p_queue_id;
  if v_q.pool_id is not null then
    update queue_entry set finished_at = now()
    where pool_id = v_q.pool_id and id <> p_queue_id and finished_at is null;
  end if;
  -- the doctor who takes the patient is the visit's treating doctor; a booking is now in progress
  if current_role_key() = 'doctor' then
    update encounter set practitioner_id = coalesce(practitioner_id, ensure_practitioner(auth.uid()))
    where id = v_q.encounter_id;
  end if;
  update appointment set status = 'in_progress'
  where id = (select appointment_id from encounter where id = v_q.encounter_id) and status = 'arrived';
  return jsonb_build_object('encounterId', v_q.encounter_id, 'station', v_q.station);
end
$$;

create or replace function answer_call(p_call_id uuid, p_queue_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_c staff_call%rowtype;
  v_q queue_entry%rowtype;
  v_me role_key := current_role_key();
  v_id uuid;
begin
  select * into v_c from staff_call where id = p_call_id and kind = 'next' for update;
  if not found or v_c.status <> 'open' then
    raise exception 'this call was already answered or cancelled' using errcode = '23505';
  end if;
  if not (v_me = 'manager'
          or (v_c.target = 'reception' and v_me = 'receptionist')
          or (v_c.target = 'nurse' and v_me = 'nurse')
          or (v_c.target = 'person' and v_c.to_user = auth.uid())) then
    raise exception 'this call is not for you' using errcode = '42501';
  end if;
  select * into v_q from queue_entry where id = p_queue_id and deleted_at is null and finished_at is null for update;
  if not found or not exists (select 1 from encounter where id = v_q.encounter_id and status = 'open') then
    raise exception 'that patient is no longer waiting' using errcode = 'P0002';
  end if;
  -- only a patient waiting for a doctor, at triage or reception: not one in the middle of a
  -- test, a treatment or the bill
  if v_q.station <> coalesce(v_c.station, v_q.station)
     and v_q.station not in ('triage', 'reception', 'consultation', 'dental') then
    raise exception 'that patient is at % (not waiting for a doctor)', initcap(v_q.station::text) using errcode = '22023';
  end if;
  if v_q.taken_by is not null or (v_q.assigned_to is not null and v_q.assigned_to <> v_c.from_user) then
    raise exception 'that patient is already with %', coalesce(patient_holder(v_q.encounter_id), 'someone')
      using errcode = '23505';
  end if;
  if v_q.station = coalesce(v_c.station, v_q.station) then
    update queue_entry set assigned_to = v_c.from_user, department_id = null, referred_by = auth.uid()
    where id = v_q.id returning id into v_id;
  else
    -- waiting at another desk (e.g. triage done): they leave it for the caller's desk
    update queue_entry set finished_at = now() where id = v_q.id;
    update queue_entry set assigned_to = v_c.from_user, department_id = null, referred_by = auth.uid()
    where encounter_id = v_q.encounter_id and station = v_c.station and finished_at is null and deleted_at is null
    returning id into v_id;
    if v_id is null then
      insert into queue_entry (encounter_id, station, ticket_no, priority, assigned_to, referred_by)
      values (v_q.encounter_id, v_c.station, v_q.ticket_no, v_q.priority, v_c.from_user, auth.uid())
      returning id into v_id;
    end if;
  end if;
  -- a patient shared between several desks leaves the others
  if v_q.pool_id is not null then
    update queue_entry set finished_at = now()
    where pool_id = v_q.pool_id and id <> v_q.id and id <> v_id and finished_at is null;
  end if;
  update staff_call
  set status = 'answered', answered_by = auth.uid(), answered_at = now(), closed_at = now(),
      encounter_id = v_q.encounter_id
  where id = p_call_id;
  delete from notification where kind = 'call_next' and params ->> 'call' = p_call_id::text;
  return jsonb_build_object('encounterId', v_q.encounter_id, 'queueId', v_id);
end
$$;

create or replace function visit_clinical(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  -- clinicians; the lab and the pharmacy read the record too (their orders and prescriptions)
  select case when has_perm('clinical.read') or has_perm('orders.read') or has_perm('prescription.read')
              then jsonb_build_object(
    'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by)) order by c.created_at)
      from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.value_text, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id)) order by o.effective_at)
      from observation o where o.encounter_id = p_encounter_id and o.code = 'note' and o.deleted_at is null), '[]'::jsonb),
    'prescriptions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by)), 'item', i.name_generic || coalesce(' ' || i.strength, ''), 'dose', m.dose, 'route', m.route,
        'frequency', m.frequency, 'days', m.duration_days, 'quantity', m.quantity, 'instructions', m.instructions, 'at', m.created_at,
        'dispensed', m.supply = 'room' or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'supply', m.supply, 'givenAt', m.given_at, 'givenBy', (select full_name from profiles where id = m.given_by),
        'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason) order by m.created_at)
      from medication_request m join item i on i.id = m.item_id where m.encounter_id = p_encounter_id and m.deleted_at is null), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end), 'status', r.status, 'reason', r.reason, 'at', r.created_at,
        'result', (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
          'at', coalesce(d.verified_at, d.updated_at), 'by', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)))
          from diagnostic_report d where d.service_request_id = r.id and d.deleted_at is null)) order by r.created_at)
      from service_request r join service s on s.id = r.service_id where r.encounter_id = p_encounter_id and r.deleted_at is null), '[]'::jsonb),
    'patient', (select jsonb_build_object('id', p.id, 'allergies', p.allergies, 'bloodGroup', p.blood_group, 'notes', p.notes, 'flags', p.flags)
      from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id)
  ) else null end
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
  select * into v_req from service_request where id = p_request_id and deleted_at is null;
  if not found then
    raise exception 'test order not found' using errcode = 'P0002';
  end if;
  -- Lab / ultrasound results: lab staff and clinicians who order; an order done at another desk
  -- (Nursing, Dental…): the clinical staff of that desk too.
  if not (has_perm('orders.write')
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound'))) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_req.status = 'cancelled' then
    raise exception 'this test was marked "not done": order it again if it is done after all' using errcode = '22023';
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
  -- Last result of this desk written: the patient goes back to the doctor.
  v_station := coalesce(v_req.station, case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end);
  perform after_desk_tests(v_req.encounter_id, v_station, v_req.requester_id);
end
$$;

create or replace function set_request_status(p_id uuid, p_status request_status, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req service_request%rowtype;
  v_test text;
  v_name text;
  v_line uuid;
  v_invoice uuid;
begin
  select * into v_req from service_request where id = p_id;
  -- the lab and imaging (orders.write); an order done at another desk (Nursing, Dental…): the
  -- clinical staff of that desk too
  if not (has_perm('orders.write')
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound'))) then
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
  -- sample taken / analysing: the patient is being seen at that desk
  if p_status in ('collected', 'in_process') then
    update queue_entry q set started_at = coalesce(q.started_at, now()), called_at = coalesce(q.called_at, now()),
                             taken_by = coalesce(q.taken_by, auth.uid())
    where q.encounter_id = v_req.encounter_id and q.finished_at is null and q.deleted_at is null
      and q.station = coalesce(v_req.station, case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end);
  end if;
  if p_status = 'cancelled' then
    select * into v_req from service_request where id = p_id;
    -- not done, not paid: its charge leaves the bill while the bill is open
    update invoice_line l
    set deleted_at = now(), manual_reason = coalesce(l.manual_reason || ' · ', '') || 'removed: test not done: ' || trim(p_reason)
    from invoice i
    where l.source_type = 'service_request' and l.source_id = p_id and l.deleted_at is null
      and i.id = l.invoice_id and i.status = 'draft'
    returning l.id, l.invoice_id into v_line, v_invoice;
    if v_invoice is not null then
      perform recompute_invoice(v_invoice);
    end if;
    -- the doctor who ordered it is told
    if v_req.requester_id is not null and v_req.requester_id is distinct from auth.uid() then
      select s.name_en into v_test from service s where s.id = v_req.service_id;
      select p.surname || ' ' || p.given_names into v_name
      from encounter e join patient p on p.id = e.patient_id where e.id = v_req.encounter_id;
      insert into notification (kind, params, link, recipient_user, created_by)
      values ('test_cancelled', jsonb_build_object('test', v_test, 'name', v_name, 'reason', trim(p_reason)),
              '/app/visit?encounter=' || v_req.encounter_id, v_req.requester_id, auth.uid());
    end if;
    perform after_desk_tests(v_req.encounter_id,
      coalesce(v_req.station, case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end),
      v_req.requester_id);
  end if;
end
$$;

drop function if exists order_tests(uuid, uuid[], text, station);
create or replace function order_tests(
  p_encounter_id uuid,
  p_service_ids uuid[],
  p_reason text default null,
  p_from station default null,
  p_priority integer default 3
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_service uuid;
  v_ids uuid[] := '{}';
begin
  if not has_perm('orders.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_may_work_on(p_encounter_id);
  if coalesce(array_length(p_service_ids, 1), 0) = 0 then
    raise exception 'choose at least one test' using errcode = '22023';
  end if;
  foreach v_service in array p_service_ids loop
    -- urgent orders (1–2) go to the top of the lab's list
    v_ids := v_ids || order_test(p_encounter_id, v_service, p_reason, greatest(1, least(coalesce(p_priority, 3), 5)));
  end loop;
  -- Send the patient now: off the doctor's queue, onto the desks that do the orders, back after.
  if p_from is not null then
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = p_from and finished_at is null
      and p_from not in (select r.station from service_request r where r.id = any (v_ids));
    update queue_entry
    set referred_by = auth.uid(),
        referral_note = coalesce(nullif(trim(coalesce(p_reason, '')), ''), referral_note),
        return_station = p_from,
        return_to = auth.uid()
    where encounter_id = p_encounter_id and finished_at is null and deleted_at is null
      and station <> p_from
      and station in (select r.station from service_request r where r.id = any (v_ids));
  end if;
  return coalesce(array_length(v_ids, 1), 0);
end
$$;


-- The open tasks of one visit (the doctor sees what they asked the nurses for).
create or replace function visit_tasks(p_encounter_id uuid)
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
  where k.encounter_id = p_encounter_id and k.deleted_at is null and k.done_at is null
    and (has_perm('clinical.read') or has_perm('vitals.write'))
$$;
revoke all on function visit_tasks(uuid) from public, anon;
grant execute on function visit_tasks(uuid) to authenticated;



revoke all on function order_tests(uuid, uuid[], text, station, integer) from public, anon;
grant execute on function order_tests(uuid, uuid[], text, station, integer) to authenticated;

