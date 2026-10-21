-- 0056 · The laboratory and the pharmacy linked to the rest of the visit.
-- Pharmacy: a prescription line can be marked "not given" (out of stock, bought elsewhere…) and
-- the doctor is told; when the last line is handed over (or not given) the patient goes to the
-- cashier if money is due, or the visit closes if the doctor already finished it. Finishing a
-- visit no longer drops medicines still to be handed over. pharmacy_summary() feeds the desk.
-- Laboratory: a test that cannot be done is cancelled with a reason, taken off the bill and the
-- doctor is told; after the last result (or cancellation) of a desk the patient goes back to the
-- doctor who ordered, even when no way back was asked.

alter table medication_request add column if not exists not_given_at timestamptz;
alter table medication_request add column if not exists not_given_by uuid references profiles (id) on delete set null;
alter table medication_request add column if not exists not_given_reason text;

-- A prescription line still to hand over at the pharmacy.
create or replace function rx_pending(m medication_request)
returns boolean
language sql stable security definer set search_path = public
as $$
  select m.deleted_at is null and m.supply = 'pharmacy' and m.given_at is null and m.not_given_at is null
    and not exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null)
$$;

-- Nothing left to hand over: the pharmacy desk lets the patient go — to the cashier if money is
-- due, otherwise the visit closes when the doctor has already finished it.
create or replace function after_pharmacy(p_encounter_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
begin
  if exists (select 1 from medication_request m where m.encounter_id = p_encounter_id and rx_pending(m)) then
    return;
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = 'pharmacy' and finished_at is null and deleted_at is null;
  if exists (select 1 from invoice i where i.encounter_id = p_encounter_id and invoice_balance(i.id) > 0) then
    if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'cashier'
                   and finished_at is null and deleted_at is null) then
      select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
      insert into queue_entry (encounter_id, station, ticket_no, referred_by, referral_note)
      values (p_encounter_id, 'cashier', coalesce(v_ticket, 'A-000'), auth.uid(), 'Medicines handed over');
    end if;
  elsif exists (select 1 from encounter where id = p_encounter_id and status = 'open' and clinical_done_at is not null)
        and not exists (select 1 from queue_entry where encounter_id = p_encounter_id and finished_at is null and deleted_at is null) then
    update encounter set status = 'closed', closed_at = now(), closed_by = auth.uid()
    where id = p_encounter_id and status = 'open';
  end if;
end
$$;


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
  if v_m.not_given_at is not null then
    raise exception 'this medicine was marked as not given' using errcode = '23505';
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
  -- the last line handed over: on to the cashier (money due) or the visit closes
  perform after_pharmacy(v_m.encounter_id);
  return jsonb_build_object('dispenseId', v_dispense, 'charged', v_charged);
end
$$;


-- The pharmacy cannot hand a medicine over (out of stock, the patient buys it elsewhere,
-- refuses it…): the line leaves the queue with the reason and the prescriber is told.
create or replace function rx_not_given(p_medication_request_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_item text;
  v_name text;
begin
  if not has_perm('stock.dispense') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 2 then
    raise exception 'say why the medicine is not given' using errcode = '22023';
  end if;
  select * into v_m from medication_request where id = p_medication_request_id for update;
  if not found or not rx_pending(v_m) then
    raise exception 'this medicine is no longer waiting at the pharmacy' using errcode = 'P0002';
  end if;
  update medication_request
  set not_given_at = now(), not_given_by = auth.uid(), not_given_reason = trim(p_reason)
  where id = v_m.id;
  select i.name_generic || coalesce(' ' || i.strength, '') into v_item from item i where i.id = v_m.item_id;
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
  if coalesce(v_m.prescriber_id, v_m.created_by) is not null
     and coalesce(v_m.prescriber_id, v_m.created_by) is distinct from auth.uid() then
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('rx_not_given', jsonb_build_object('item', v_item, 'name', v_name, 'reason', trim(p_reason)),
            '/app/visit?encounter=' || v_m.encounter_id, coalesce(v_m.prescriber_id, v_m.created_by), auth.uid());
  end if;
  perform after_pharmacy(v_m.encounter_id);
end
$$;

-- The pharmacy desk's figures: what waits, what was handed over and sold today.
create or replace function pharmacy_summary()
returns jsonb
language sql stable security definer set search_path = public
as $$
  with today as (select (now() at time zone 'Africa/Kigali')::date as d),
  pending as (
    select m.* from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open'
    where rx_pending(m)
  ),
  given as (
    select m.* from medication_request m, today
    where m.deleted_at is null and m.supply = 'pharmacy' and m.given_at is not null
      and (m.given_at at time zone 'Africa/Kigali')::date = today.d
  )
  select jsonb_build_object(
    'lines', (select count(*) from pending),
    'patients', (select count(distinct encounter_id) from pending),
    'dispensedToday', (select count(*) from given),
    'patientsServedToday', (select count(distinct encounter_id) from given),
    'notGivenToday', (select count(*) from medication_request m, today
                      where m.deleted_at is null and (m.not_given_at at time zone 'Africa/Kigali')::date = today.d),
    'salesToday', (select coalesce(sum(l.patient_share + l.insurer_share), 0) from invoice_line l, today
                   where l.deleted_at is null and l.source_type = 'medication_dispense'
                     and (l.created_at at time zone 'Africa/Kigali')::date = today.d),
    'topToday', coalesce((select jsonb_agg(x order by x.count desc, x.item) from (
                   select i.name_generic || coalesce(' ' || i.strength, '') as item, count(*)::int as count
                   from given g join item i on i.id = g.item_id group by 1 order by 2 desc limit 5) x), '[]'::jsonb),
    'notGiven', coalesce((select jsonb_agg(jsonb_build_object(
                   'item', i.name_generic || coalesce(' ' || i.strength, ''), 'patient', p.surname || ' ' || p.given_names,
                   'reason', m.not_given_reason, 'at', m.not_given_at) order by m.not_given_at desc)
                 from medication_request m, today, item i, encounter e, patient p
                 where m.deleted_at is null and i.id = m.item_id and e.id = m.encounter_id and p.id = e.patient_id
                   and (m.not_given_at at time zone 'Africa/Kigali')::date = today.d), '[]'::jsonb)
  )
  where has_perm('stock.read')
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
                       where s.item_id = m.item_id and l.type = 'pharmacy')
  ) order by m.created_at), '[]'::jsonb)
  from medication_request m
  join encounter e on e.id = m.encounter_id and e.status = 'open'
  join patient p on p.id = e.patient_id
  join item i on i.id = m.item_id
  left join profiles pr on pr.id = coalesce(m.prescriber_id, m.created_by)
  where has_perm('stock.read') and rx_pending(m)
$$;

create or replace function finish_visit(p_encounter_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_rx boolean;
  v_due boolean;
  v_ticket text;
begin
  perform assert_may_work_on(p_encounter_id);
  v_rx := exists (select 1 from medication_request m where m.encounter_id = p_encounter_id and rx_pending(m));
  perform close_encounter(p_encounter_id);
  v_due := exists (select 1 from invoice i where i.encounter_id = p_encounter_id and invoice_balance(i.id) > 0);
  if v_rx or v_due then
    -- Treatment is over; the visit stays open until the medicines are handed over and the bill is paid.
    update encounter set status = 'open', closed_at = null, closed_by = null, clinical_done_at = now()
    where id = p_encounter_id;
    select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
    -- medicines first (their price joins the bill), then the cashier
    if v_rx then
      insert into queue_entry (encounter_id, station, ticket_no, referred_by, referral_note)
      values (p_encounter_id, 'pharmacy', coalesce(v_ticket, 'A-000'), auth.uid(), 'Medicines to hand over');
    else
      insert into queue_entry (encounter_id, station, ticket_no)
      values (p_encounter_id, 'cashier', coalesce(v_ticket, 'A-000'));
    end if;
  end if;
end
$$;


-- After the last result (or cancellation) of a desk's tests, the patient goes back: to the way
-- back the doctor asked for, otherwise to the doctor who ordered them, at the desk where that
-- doctor saw the patient.
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


revoke all on function rx_pending(medication_request), after_pharmacy(uuid), after_desk_tests(uuid, station, uuid)
  from public, anon, authenticated;
revoke all on function rx_not_given(uuid, text), pharmacy_summary() from public, anon;
grant execute on function rx_not_given(uuid, text), pharmacy_summary() to authenticated;

