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
