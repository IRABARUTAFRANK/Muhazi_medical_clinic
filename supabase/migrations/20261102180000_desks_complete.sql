-- 0059 · Desks complete (dashboard audit, wave 2).
-- Charging: the automatic charges (tests ordered, medicines handed over or given in the room,
-- bed nights) go through add_charge_internal; the public add_charge (Add a treatment) always
-- checks who holds the patient, refuses tests that must be ordered and the bed line, and a typed
-- price only where the treatment allows it (or the manager). "Bed stay" cannot be deleted,
-- hidden or moved out of the bed category (bed billing needs it). Orders done at a desk other
-- than the lab (Nursing, Dental…) can be marked "not done" by that desk and have a worklist
-- (desk_orders). The triage colour reorders the patient's waiting places. Doctors may work at
-- the ultrasound desk. unpaid_debts(): what finished visits still owe. book_appointment():
-- reception books a phone caller or a patient at the desk.


-- The charging itself, for the desks' automatic charges (no permission check: each caller has
-- checked its own). Not callable from the app.
create or replace function add_charge_internal(
  p_encounter_id uuid,
  p_office station,
  p_service_id uuid default null,
  p_item_id uuid default null,
  p_quantity numeric default 1,
  p_manual_price numeric default null,
  p_manual_reason text default null,
  p_performed_by uuid default null,
  p_entered_for uuid default null,
  p_source_type text default null,
  p_source_id uuid default null,
  p_discount_pct numeric default 0,
  p_discount_reason text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice invoice%rowtype;
  v_plan uuid;
  v_group service_group;
  v_desc text;
  v_price numeric;
  v_unit numeric;
  v_fallback boolean;
  v_pct numeric := 0;
  v_origin price_origin := 'preset';
  v_line_total numeric;
  v_insurer numeric;
  v_line_id uuid;
  v_allow_manual boolean := false;
  v_max_discount numeric := 0;
  v_discount numeric := coalesce(p_discount_pct, 0);
begin
  if (p_service_id is null) = (p_item_id is null) then
    raise exception 'give a service or an item, not both' using errcode = '22023';
  end if;
  select * into v_invoice from invoice where encounter_id = p_encounter_id;
  if not found or v_invoice.status <> 'draft' then
    raise exception 'no open bill for this visit' using errcode = 'P0002';
  end if;

  if p_service_id is not null then
    select s.name_en, s.service_group, s.allow_manual_price, s.max_discount_pct
    into v_desc, v_group, v_allow_manual, v_max_discount
    from service s where s.id = p_service_id and (s.active or p_source_type = 'bed_stay');
  else
    select i.name_generic || coalesce(' ' || i.strength, ''), 'pharmacy'::service_group, false, 0
    into v_desc, v_group, v_allow_manual, v_max_discount
    from item i where i.id = p_item_id and i.active;
    v_origin := 'pharmacy';
  end if;
  if v_desc is null then
    raise exception 'unknown or inactive service/item' using errcode = '22023';
  end if;

  if p_manual_price is not null then
    if not (v_allow_manual or p_source_type = 'bed_stay' or has_perm('charge.manual')) then
      raise exception 'a typed price is not allowed for this service' using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_manual_reason, '')), '') is null then
      raise exception 'a reason is required for a typed price' using errcode = '22023';
    end if;
    v_price := p_manual_price;
    v_origin := 'manual';
  else
    select pf.price, pf.fallback into v_price, v_fallback
    from price_for(p_service_id, p_item_id, v_invoice.payer_id) pf;
    if v_price is null then
      raise exception 'no price found for this service/item' using errcode = 'P0002';
    end if;
  end if;

  -- Discount: within the treatment's allowance, or the manager; always with a reason.
  if v_discount < 0 or v_discount > 100 then
    raise exception 'discount must be between 0 and 100 %%' using errcode = '22023';
  end if;
  if v_discount > 0 then
    if v_discount > v_max_discount and not is_manager() then
      raise exception 'the discount on this treatment may not exceed %%%', v_max_discount using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_discount_reason, '')), '') is null then
      raise exception 'a reason is required for a discount' using errcode = '22023';
    end if;
  end if;
  v_unit := round(v_price * (100 - v_discount) / 100);

  select c.plan_id into v_plan from coverage c where c.id = v_invoice.coverage_id;
  v_pct := coalesce(coverage_pct_for(v_plan, v_group), 0);
  v_line_total := round(v_unit * p_quantity);
  v_insurer := round(v_line_total * v_pct / 100);

  insert into invoice_line (
    invoice_id, service_id, item_id, description, quantity, unit_price, list_price, discount_pct,
    discount_reason, coverage_pct, patient_share, insurer_share, office, performed_by, entered_for,
    source_type, source_id, price_origin, manual_reason
  ) values (
    v_invoice.id, p_service_id, p_item_id, v_desc, p_quantity, v_unit, v_price, v_discount,
    nullif(trim(coalesce(p_discount_reason, '')), ''), v_pct, v_line_total - v_insurer, v_insurer,
    p_office, coalesce(p_performed_by, auth.uid()), p_entered_for, p_source_type, p_source_id,
    v_origin, p_manual_reason
  ) returning id into v_line_id;

  perform recompute_invoice(v_invoice.id);
  return v_line_id;
end
$$;


-- "Add a treatment": a person charges a treatment on the visit they are working on.
create or replace function add_charge(
  p_encounter_id uuid,
  p_office station,
  p_service_id uuid default null,
  p_item_id uuid default null,
  p_quantity numeric default 1,
  p_manual_price numeric default null,
  p_manual_reason text default null,
  p_performed_by uuid default null,
  p_entered_for uuid default null,
  p_source_type text default null,
  p_source_id uuid default null,
  p_discount_pct numeric default 0,
  p_discount_reason text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_code text;
  v_allow boolean;
  v_order station;
begin
  if not has_perm('charge.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_source_type is not null or p_source_id is not null then
    raise exception 'automatic charges are made by the desk that does the work' using errcode = '42501';
  end if;
  perform assert_may_work_on(p_encounter_id);
  if p_service_id is not null then
    select s.code, s.allow_manual_price, c.order_station into v_code, v_allow, v_order
    from service s left join service_category c on c.id = s.category_id
    where s.id = p_service_id;
    if v_code = 'BED-STAY' then
      raise exception 'bed stays are charged from the beds board (admit or extend the stay)' using errcode = '22023';
    end if;
    if v_order is not null then
      raise exception 'this is ordered, not added: use Orders so that % gets the patient', initcap(v_order::text)
        using errcode = '22023';
    end if;
    if p_manual_price is not null and not coalesce(v_allow, false) and not is_manager() then
      raise exception 'a typed price is not allowed for this treatment' using errcode = '42501';
    end if;
  end if;
  return add_charge_internal(p_encounter_id, p_office, p_service_id, p_item_id, p_quantity, p_manual_price,
                             p_manual_reason, p_performed_by, p_entered_for, null, null, p_discount_pct,
                             p_discount_reason);
end
$$;


create or replace function bill_bed_nights(
  p_stay_id uuid,
  p_nights integer,
  p_period_price numeric
)
returns numeric
language plpgsql security definer set search_path = public
as $$
declare
  v_stay bed_stay%rowtype;
  v_bed bed%rowtype;
  v_service uuid;
  v_total numeric;
  v_line uuid;
  v_agreed boolean := p_period_price is not null;
begin
  select * into v_stay from bed_stay where id = p_stay_id;
  select * into v_bed from bed where id = v_stay.bed_id;
  select id into v_service from service where code = 'BED-STAY';
  if p_nights is null or p_nights < 1 or p_nights > 365 then
    raise exception 'the number of nights must be between 1 and 365' using errcode = '22023';
  end if;
  if v_agreed and p_period_price < 0 then
    raise exception 'the price cannot be negative' using errcode = '22023';
  end if;
  v_total := case when v_agreed then p_period_price else v_bed.nightly_price * p_nights end;
  if v_total > 0 then
    v_line := add_charge_internal(
      p_encounter_id => v_stay.encounter_id,
      p_office => 'beds',
      p_service_id => v_service,
      p_quantity => 1,
      p_manual_price => v_total,
      p_manual_reason => case when v_agreed then 'price agreed for the period'
                              else p_nights || ' × ' || v_bed.nightly_price end,
      p_source_type => 'bed_stay',
      p_source_id => p_stay_id
    );
    update invoice_line
    set description = 'Bed stay · ' || v_bed.name || ' · ' || p_nights
                      || case when p_nights = 1 then ' night' else ' nights' end
    where id = v_line;
  end if;
  return v_total;
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
    perform add_charge_internal(v_m.encounter_id, 'pharmacy'::station, null, v_m.item_id, v_m.quantity,
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

create or replace function order_test(p_encounter_id uuid, p_service_id uuid, p_reason text default null, p_priority integer default 3)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_group service_group;
  v_cat request_category;
  v_station station;
begin
  if not has_perm('orders.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_may_work_on(p_encounter_id);
  select s.service_group,
         coalesce(c.order_station, case when s.service_group = 'imaging' then 'ultrasound'::station else 'laboratory'::station end)
  into v_group, v_station
  from service s left join service_category c on c.id = s.category_id
  where s.id = p_service_id and s.active and s.deleted_at is null;
  if v_group is null then
    raise exception 'unknown service' using errcode = '22023';
  end if;
  v_cat := case when v_station = 'ultrasound' then 'imaging'::request_category else 'lab'::request_category end;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into service_request (encounter_id, category, service_id, reason, priority, station)
  values (p_encounter_id, v_cat, p_service_id, nullif(trim(coalesce(p_reason, '')), ''), least(5, greatest(1, p_priority)), v_station)
  returning id into v_id;
  perform add_charge_internal(p_encounter_id, v_station, p_service_id, null, 1, null, null, null, null, 'service_request', v_id);
  if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = v_station and finished_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, v_station, (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1), least(5, greatest(1, p_priority)));
  end if;
  return v_id;
end
$$;

create or replace function prescribe(
  p_encounter_id uuid, p_item_id uuid, p_quantity numeric, p_dose text default null, p_route text default null,
  p_frequency text default null, p_duration_days integer default null, p_instructions text default null,
  p_supply text default 'pharmacy', p_station station default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_charged boolean := false;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_may_work_on(p_encounter_id);
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if coalesce(p_supply, 'pharmacy') not in ('pharmacy', 'room') then
    raise exception 'unknown supply' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into medication_request (encounter_id, item_id, dose, route, frequency, duration_days, quantity,
                                  instructions, supply, given_at, given_by)
  values (p_encounter_id, p_item_id, nullif(trim(coalesce(p_dose, '')), ''), nullif(trim(coalesce(p_route, '')), ''),
          nullif(trim(coalesce(p_frequency, '')), ''), p_duration_days, p_quantity,
          nullif(trim(coalesce(p_instructions, '')), ''), coalesce(p_supply, 'pharmacy'),
          case when p_supply = 'room' then now() end, case when p_supply = 'room' then auth.uid() end)
  returning id into v_id;
  if p_supply = 'room' then
    -- Given here: on the bill at the medicine's price (if it has one); no pharmacy queue.
    begin
      perform add_charge_internal(p_encounter_id, coalesce(p_station, 'consultation'::station), null, p_item_id, p_quantity,
                         null, null, null, null, 'medication_request', v_id);
      v_charged := true;
    exception when sqlstate 'P0002' then
      v_charged := false;
    end;
  elsif not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'pharmacy' and finished_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no)
    values (p_encounter_id, 'pharmacy', (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1));
  end if;
  return jsonb_build_object('id', v_id, 'supply', coalesce(p_supply, 'pharmacy'), 'charged', v_charged);
end
$$;


-- "Bed stay" is built in: bed nights are billed under it. It stays active, typed prices stay
-- allowed (the agreed price for a period) and it stays in a bed category.
create or replace function keep_bed_stay_line()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if old.code = 'BED-STAY' then
    new.code := 'BED-STAY';
    new.active := true;
    new.deleted_at := null;
    new.allow_manual_price := true;
    if new.category_id is distinct from old.category_id
       and not exists (select 1 from service_category c where c.id = new.category_id and c.kind = 'bed') then
      new.category_id := old.category_id;
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists trg_keep_bed_stay on service;
create trigger trg_keep_bed_stay before update on service
  for each row execute function keep_bed_stay_line();
-- repair it if it was already hidden or deleted
update service set active = true, deleted_at = null, allow_manual_price = true where code = 'BED-STAY';


create or replace function delete_service(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from service where id = p_id and code = 'BED-STAY') then
    raise exception 'Bed stay is built in: bed nights are billed under it (change its name or price instead)'
      using errcode = '22023';
  end if;
  update service set deleted_at = now(), active = false where id = p_id and deleted_at is null;
  if not found then
    raise exception 'treatment not found' using errcode = 'P0002';
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'delete', 'service', p_id, null);
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


-- Orders waiting at a desk other than the lab (Nursing, Dental, Minor surgery, Consultation): the
-- same shape as the lab worklist, for the desk's dashboard.
create or replace function desk_orders(p_station station)
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
    join encounter e on e.id = r.encounter_id and e.status = 'open'
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and r.station = p_station and p_station not in ('laboratory', 'ultrasound')
      and r.status not in ('verified', 'cancelled')
      and (has_perm('clinical.read') or has_perm('orders.read'))
  ) x
$$;


create or replace function record_vitals(
  p_encounter_id uuid,
  p_vitals jsonb,
  p_triage triage_level default null,
  p_next_station station default null,
  p_reason text default null,
  p_measured_by uuid default null,
  p_measured_at timestamptz default null
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_key text;
  v_val numeric;
  v_count integer := 0;
  v_by uuid := coalesce(p_measured_by, auth.uid());
  v_at timestamptz := coalesce(p_measured_at, now());
  v_arrived timestamptz;
  v_at_triage boolean;
  v_units jsonb := '{"bp_sys":"mmHg","bp_dia":"mmHg","pulse":"bpm","temp":"°C","resp":"/min","spo2":"%","weight":"kg","height":"cm","muac":"cm"}'::jsonb;
begin
  if not has_perm('vitals.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select arrived_at into v_arrived from encounter where id = p_encounter_id and status = 'open';
  if not found then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  -- Without clinical rights the person typing must name who measured.
  if not has_perm('clinical.write') and (p_measured_by is null or p_measured_by = auth.uid()) then
    raise exception 'choose the nurse who took the measurements' using errcode = '22023';
  end if;
  if not exists (select 1 from profiles where id = v_by and active) then
    raise exception 'unknown staff member for "measured by"' using errcode = '22023';
  end if;
  if v_at > now() + interval '5 minutes' then
    raise exception 'the measurement time is in the future' using errcode = '22023';
  end if;
  if v_at < v_arrived - interval '1 hour' then
    raise exception 'the measurement time is before the patient arrived' using errcode = '22023';
  end if;

  for v_key, v_val in
    select key, nullif(value, '')::numeric from jsonb_each_text(coalesce(p_vitals, '{}'::jsonb))
  loop
    if v_val is not null and v_units ? v_key then
      insert into observation (encounter_id, code, value_num, unit, performer_id, effective_at)
      values (p_encounter_id, v_key, v_val, v_units ->> v_key, v_by, v_at);
      v_count := v_count + 1;
    end if;
  end loop;
  if v_count = 0 then
    raise exception 'enter at least one measurement' using errcode = '22023';
  end if;

  if v_by <> auth.uid() then
    insert into audit_event (actor_id, action, entity, entity_id, after, reason)
    values (auth.uid(), 'create', 'observation', p_encounter_id,
            jsonb_build_object('measured_by', v_by, 'measured_at', v_at, 'count', v_count),
            'vitals entered on behalf of the person who measured');
  end if;

  if p_triage is not null then
    update encounter set triage_level = p_triage, triage_reason = coalesce(p_reason, triage_reason)
    where id = p_encounter_id;
    -- the colour reorders the places where the patient waits (red first)
    update queue_entry set priority = case p_triage when 'red' then 1 when 'yellow' then 2 else 3 end
    where encounter_id = p_encounter_id and finished_at is null and started_at is null and deleted_at is null;
  end if;

  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;

  -- At triage: close the triage turn and send the patient on. Later (e.g. the doctor typing
  -- the nurse's paper sheet): measurements only, the patient stays where they are.
  select exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'triage'
                 and finished_at is null and deleted_at is null) into v_at_triage;
  if v_at_triage and p_next_station is not null then
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = 'triage' and finished_at is null;
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, p_next_station, v_ticket,
            case coalesce(p_triage, 'green') when 'red' then 1 when 'yellow' then 2 else 3 end);
  end if;
  return v_ticket;
end
$$;

create or replace function queue_entry_for_me(p_queue_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from queue_entry q
    join profiles me on me.id = auth.uid() and me.active
    left join lateral (select covering_for(me.id) as doc) cv on true
    where q.id = p_queue_id and q.deleted_at is null
      and (
        me.role = 'manager'
        or me.id = q.assigned_to or me.id = q.taken_by or me.id = q.return_to
        or (cv.doc is not null and (cv.doc = q.assigned_to or cv.doc = q.taken_by))
        or (q.assigned_to is null and q.taken_by is null
            and (station_role(q.station) = me.role
                 or (cv.doc is not null and station_role(q.station) = 'doctor')
                 -- doctors also do ultrasounds
                 or (q.station = 'ultrasound' and me.role = 'doctor'))
            and (q.department_id is null
                 or me.department_id = q.department_id
                 or exists (select 1 from staff_department sd
                            where sd.profile_id = me.id and sd.department_id = q.department_id)))
      )
  )
$$;


-- What finished visits still owe (the patient left without paying, the manager allowed it).
create or replace function unpaid_debts()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb)
  from (
    select e.closed_at as at, jsonb_build_object(
      'encounterId', e.id, 'patientId', p.id, 'patient', p.surname || ' ' || p.given_names,
      'fileNumber', p.file_number, 'phone', p.phone_1, 'amount', invoice_balance(i.id),
      'closedAt', e.closed_at, 'reason', e.left_reason, 'closedBy', pr.full_name) as j
    from encounter e
    join invoice i on i.encounter_id = e.id
    join patient p on p.id = e.patient_id
    left join profiles pr on pr.id = e.closed_by
    where e.status = 'closed' and e.deleted_at is null and invoice_balance(i.id) > 0
  ) x
  where has_perm('billing.read') or has_perm('payment.take')
$$;

-- Reception books a phone caller or a patient at the desk with a doctor at a time: the same
-- checks as a website request (the doctor works then, the slot is free); the doctor is asked to
-- accept, as for every booking.
create or replace function book_appointment(
  p_patient_id uuid,
  p_practitioner_user uuid,
  p_starts_at timestamptz,
  p_reason text default null,
  p_source appointment_source default 'reception'
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_name text;
  v_phone text;
begin
  if not has_perm('appointment.approve') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select surname || ' ' || given_names, phone_1 into v_name, v_phone
  from patient where id = p_patient_id and deleted_at is null;
  if v_name is null then
    raise exception 'choose the patient file' using errcode = '22023';
  end if;
  insert into appointment (patient_id, status, source, reason, contact_name, contact_phone, starts_at)
  values (p_patient_id, 'inquiry', coalesce(p_source, 'reception'), nullif(trim(coalesce(p_reason, '')), ''),
          v_name, v_phone, p_starts_at)
  returning id into v_id;
  perform approve_inquiry(v_id, p_patient_id, p_practitioner_user, p_starts_at);
  return v_id;
end
$$;

revoke all on function add_charge_internal(uuid, station, uuid, uuid, numeric, numeric, text, uuid, uuid, text, uuid, numeric, text),
  keep_bed_stay_line() from public, anon, authenticated;
revoke all on function desk_orders(station), unpaid_debts(),
  book_appointment(uuid, uuid, timestamptz, text, appointment_source) from public, anon;
grant execute on function desk_orders(station), unpaid_debts(),
  book_appointment(uuid, uuid, timestamptz, text, appointment_source) to authenticated;

