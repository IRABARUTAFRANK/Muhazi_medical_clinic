-- 0100 · Medicines bought at an outside pharmacy.
--
-- Frank (owner): the clinic pharmacy does not always hold every medicine. The doctor printed the
-- prescription and the patient bought the missing ones elsewhere, but the system still sent every
-- line to the pharmacy. Now the prescriber decides, medicine by medicine, who gives it:
--
--   * medication_request.supply gains 'outside': the patient buys it at an outside pharmacy. Such a
--     line is never charged, never waits at the pharmacy (rx_pending is supply = 'pharmacy' only),
--     never moves stock, and is printed on "the prescription for an outside pharmacy".
--   * An outside line may name a medicine the clinic does not hold: item_id is null only for
--     'outside', and medicine_name (always filled for outside lines, so the print never depends on
--     the catalogue) says it; reference_code keeps the official (RHIA) list code when picked there.
--   * supply_set_at / supply_set_by / supply_reason: who decided where it is given, and when.
--   * prescribe(..., p_medicine_name, p_reference_code): 'outside' accepted (a clinic medicine, or
--     one of the official list, or a name typed); same right, desk and visit checks as before, the
--     prescribing-rule warnings too (from the list's rule for a list medicine).
--   * rx_set_supply(request, 'pharmacy' | 'outside', reason?): the prescriber (the doctor treating
--     the patient, or the manager) changes the decision of a line not given and not cancelled;
--     e.g. after the pharmacy marked it "not given: out of stock". Back to the pharmacy only for a
--     clinic medicine on an open visit. The pharmacy is told when a waiting line leaves its list;
--     the patient moves on when nothing is left there (after_pharmacy). Pharmacists without the
--     prescribing right are refused.
--   * rx_not_given tells the prescriber whether the pharmacy had none (noStock) and whether the
--     line can go to an outside pharmacy (outside).
--   * cancel_prescription also cancels an outside line (wrong medicine written).
--   * rx_stock(): the usable (unexpired) units of each medicine at the main pharmacy, for the
--     prescription form.
--   * rx_bought_outside(from, to): "Prescribed but bought outside": each medicine sent outside in
--     the period, how many times and the total quantity (manager and pharmacy, to order).
--   * The readers of prescriptions (visit_clinical, visit_journey, my_prescriptions,
--     patient_safety_summary) read a line without a clinic medicine too (rx_label).

-- ---------------------------------------------------------------- the table
do $$
declare
  r record;
begin
  for r in select conname from pg_constraint
           where conrelid = 'medication_request'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%supply%' loop
    execute format('alter table medication_request drop constraint %I', r.conname);
  end loop;
end $$;
alter table medication_request add constraint medication_request_supply_check
  check (supply in ('pharmacy', 'room', 'outside'));
alter table medication_request alter column item_id drop not null;
alter table medication_request add column if not exists medicine_name text;
alter table medication_request add column if not exists reference_code text;
alter table medication_request add column if not exists supply_set_at timestamptz;
alter table medication_request add column if not exists supply_set_by uuid references profiles (id) on delete set null;
alter table medication_request add column if not exists supply_reason text;
alter table medication_request drop constraint if exists medication_request_item_ck;
alter table medication_request add constraint medication_request_item_ck
  check (item_id is not null or (supply = 'outside' and nullif(trim(coalesce(medicine_name, '')), '') is not null));
create index if not exists medication_request_outside_idx on medication_request (created_at) where supply = 'outside';

-- The name a prescription line prints: the name kept on the line (outside), else the medicine's.
create or replace function rx_label(m medication_request)
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce(nullif(trim(coalesce(m.medicine_name, '')), ''), item_label(m.item_id))
$$;

-- The official list's prescribing rule as warnings (rx_warnings reads the clinic's medicine).
create or replace function rx_rule_warnings(p_rule text, p_staff uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case
    when p_rule is null or trim(p_rule) = '' then '[]'::jsonb
    when upper(trim(p_rule)) = 'HU' then
      jsonb_build_array(jsonb_build_object('kind', 'hospitalOnly', 'rule', p_rule))
    when upper(trim(p_rule)) = 'M' then
      jsonb_build_array(jsonb_build_object('kind', 'needsNote', 'rule', p_rule))
    when rx_rule_ok(p_rule, (select specialty from profiles where id = p_staff)) is false then
      jsonb_build_array(jsonb_build_object('kind', 'prescribingRule', 'rule', p_rule,
                                           'specialty', (select specialty from profiles where id = p_staff)))
    else '[]'::jsonb
  end
$$;

-- guard_medication_request (from 20261207090000_pharmacy_simplified): the new columns change only
-- through prescribe and rx_set_supply.
create or replace function guard_medication_request()
returns trigger
language plpgsql
as $$
begin
  -- the checked (security definer) functions run as their owner, not as the API roles
  if current_user::text not in ('authenticated', 'anon') then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    raise exception 'prescriptions are written with the prescription form only' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'a prescription is not deleted: the doctor cancels it' using errcode = '42501';
  end if;
  if new.given_at is distinct from old.given_at or new.given_by is distinct from old.given_by
     or new.not_given_at is distinct from old.not_given_at or new.not_given_by is distinct from old.not_given_by
     or new.not_given_reason is distinct from old.not_given_reason
     or new.cancelled_at is distinct from old.cancelled_at or new.cancelled_by is distinct from old.cancelled_by
     or new.cancel_reason is distinct from old.cancel_reason
     or new.supply is distinct from old.supply or new.quantity is distinct from old.quantity
     or new.item_id is distinct from old.item_id or new.encounter_id is distinct from old.encounter_id
     or new.prescriber_id is distinct from old.prescriber_id or new.deleted_at is distinct from old.deleted_at
     or new.quantity_given is distinct from old.quantity_given
     or new.medicine_name is distinct from old.medicine_name or new.reference_code is distinct from old.reference_code
     or new.supply_set_at is distinct from old.supply_set_at or new.supply_set_by is distinct from old.supply_set_by
     or new.supply_reason is distinct from old.supply_reason
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'handing over, not given, cancelling and the medicine or quantity change only through the pharmacy and prescription screens'
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------- prescribe
-- From 20261126090000_departments_decide_desks: 'outside', and a medicine the clinic does not hold.
drop function if exists prescribe(uuid, uuid, numeric, text, text, text, integer, text, text, station, uuid);
create or replace function prescribe(
  p_encounter_id uuid, p_item_id uuid, p_quantity numeric, p_dose text default null, p_route text default null,
  p_frequency text default null, p_duration_days integer default null, p_instructions text default null,
  p_supply text default 'pharmacy', p_station station default null, p_location_id uuid default null,
  p_medicine_name text default null, p_reference_code text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_charged boolean := false;
  v_loc uuid;
  v_taken boolean := false;
  v_qty integer;
  v_supply text := coalesce(p_supply, 'pharmacy');
  v_code text := nullif(trim(coalesce(p_reference_code, '')), '');
  v_name text;
  v_generic text;
  v_rule text;
  v_warn jsonb := '[]'::jsonb;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if v_supply not in ('pharmacy', 'room', 'outside') then
    raise exception 'unknown supply' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if p_item_id is null then
    -- not a clinic medicine: only for an outside pharmacy, named (or taken from the official list)
    if v_supply <> 'outside' then
      raise exception 'this medicine is not sold at the clinic: it can only be bought outside' using errcode = '22023';
    end if;
    if v_code is not null then
      select r.generic, r.prescribing_rule into v_generic, v_rule from medicine_reference r where r.code = v_code;
      if not found then
        raise exception 'medicine not found' using errcode = 'P0002';
      end if;
      v_warn := coalesce(rx_rule_warnings(v_rule, auth.uid()), '[]'::jsonb);
    end if;
    v_name := coalesce(nullif(trim(coalesce(p_medicine_name, '')), ''), v_generic);
    if v_name is null then
      raise exception 'write the name of the medicine to buy outside' using errcode = '22023';
    end if;
  else
    if not exists (select 1 from item where id = p_item_id and deleted_at is null) then
      raise exception 'medicine not found' using errcode = 'P0002';
    end if;
    v_warn := coalesce(rx_warnings(p_item_id, auth.uid()), '[]'::jsonb);
    if v_supply = 'outside' then
      -- the print keeps its name even if the catalogue changes
      v_name := item_label(p_item_id);
      v_code := coalesce(v_code, (select i.code from item i where i.id = p_item_id
                                    and exists (select 1 from medicine_reference r where r.code = i.code)));
    else
      v_code := null;
    end if;
  end if;
  if v_supply = 'room' then
    -- Given here: only from a store that holds enough unexpired units; never given without stock.
    v_qty := ceil(p_quantity)::integer;
    v_loc := room_store_for(auth.uid(), p_item_id, v_qty, p_location_id, p_station);
    if v_loc is null then
      raise exception 'not enough of this medicine (not expired) in %: prescribe it for the pharmacy instead',
        case when p_location_id is null then 'a store you may give from' else 'that store' end
        using errcode = 'MS003', hint = 'room_short';
    end if;
  end if;
  insert into medication_request (encounter_id, item_id, dose, route, frequency, duration_days, quantity,
                                  instructions, supply, given_at, given_by, medicine_name, reference_code,
                                  supply_set_at, supply_set_by)
  values (p_encounter_id, p_item_id, nullif(trim(coalesce(p_dose, '')), ''), nullif(trim(coalesce(p_route, '')), ''),
          nullif(trim(coalesce(p_frequency, '')), ''), p_duration_days, p_quantity,
          nullif(trim(coalesce(p_instructions, '')), ''), v_supply,
          case when v_supply = 'room' then now() end, case when v_supply = 'room' then auth.uid() end,
          v_name, v_code, now(), auth.uid())
  returning id into v_id;
  if v_supply = 'room' then
    perform give_from_store(p_item_id, v_loc, v_qty, v_id, 'given in the room');
    v_taken := true;
    -- on the bill at the medicine's price (no price: given free); a closed bill refuses (MS001)
    begin
      perform add_charge_internal(p_encounter_id, coalesce(p_station, 'consultation'::station), null, p_item_id, p_quantity,
                         null, null, null, null, 'medication_request', v_id);
      v_charged := true;
    exception when sqlstate 'P0002' then
      v_charged := false;
    end;
  elsif v_supply = 'pharmacy'
        and not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'pharmacy'
                        and finished_at is null and deleted_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no)
    values (p_encounter_id, 'pharmacy', (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1));
  end if;
  -- 'outside': nothing charged, nothing taken, nothing queued
  return jsonb_build_object('id', v_id, 'supply', v_supply, 'charged', v_charged,
                            'stockTaken', v_taken, 'locationId', v_loc, 'medicineName', v_name,
                            'warnings', v_warn);
end
$$;

-- ---------------------------------------------------------------- the prescriber changes the decision
create or replace function rx_set_supply(p_request_id uuid, p_supply text, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_open boolean;
  v_was_waiting boolean;
  v_name text;
  v_left integer;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  if p_supply is null or p_supply not in ('pharmacy', 'outside') then
    raise exception 'unknown supply' using errcode = '22023';
  end if;
  select * into v_m from medication_request where id = p_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  select e.status = 'open' into v_open from encounter e where e.id = v_m.encounter_id;
  -- as prescribing: the doctor treating the patient (or the prescriber, or the manager)
  if not (is_manager() or coalesce(v_m.prescriber_id, v_m.created_by) = auth.uid()
          or (v_open and may_work_on(v_m.encounter_id))) then
    if v_open then
      perform assert_may_work_on(v_m.encounter_id);
    end if;
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_m.cancelled_at is not null or v_m.given_at is not null or v_m.supply = 'room' then
    raise exception 'this medicine was already given or cancelled: it stays as it is' using errcode = 'P0002';
  end if;
  if coalesce(v_m.quantity_given, 0) > 0
     or (coalesce(v_m.quantity_given, 0) = 0 and v_m.not_given_at is null and exists (
           select 1 from medication_dispense d where d.medication_request_id = v_m.id and d.deleted_at is null)) then
    raise exception 'part of this medicine was already given: prescribe what remains as a new medicine'
      using errcode = '22023';
  end if;
  if v_m.supply = p_supply then
    return jsonb_build_object('id', v_m.id, 'supply', v_m.supply, 'changed', false,
                              'pending', (select count(*)::integer from medication_request m
                                          where m.encounter_id = v_m.encounter_id and rx_pending(m)));
  end if;
  v_was_waiting := rx_pending(v_m);
  if p_supply = 'pharmacy' then
    if v_m.item_id is null then
      raise exception 'this medicine is not sold at the clinic: it can only be bought outside' using errcode = '22023';
    end if;
    if not v_open then
      raise exception 'visit not found or already closed' using errcode = 'P0002';
    end if;
    -- back to the pharmacy's list (a "not given" of before is cleared: the pharmacy tries again)
    update medication_request
    set supply = 'pharmacy', not_given_at = null, not_given_by = null, not_given_reason = null,
        supply_set_at = now(), supply_set_by = auth.uid(),
        supply_reason = nullif(trim(coalesce(p_reason, '')), '')
    where id = v_m.id;
    if not exists (select 1 from queue_entry where encounter_id = v_m.encounter_id and station = 'pharmacy'
                   and finished_at is null and deleted_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no)
      values (v_m.encounter_id, 'pharmacy',
              (select ticket_no from queue_entry where encounter_id = v_m.encounter_id order by created_at limit 1));
    end if;
  else
    update medication_request
    set supply = 'outside', medicine_name = coalesce(nullif(trim(coalesce(medicine_name, '')), ''), item_label(item_id)),
        reference_code = coalesce(reference_code, (select i.code from item i where i.id = v_m.item_id
                                                     and exists (select 1 from medicine_reference r where r.code = i.code))),
        supply_set_at = now(), supply_set_by = auth.uid(),
        supply_reason = nullif(trim(coalesce(p_reason, '')), '')
    where id = v_m.id;
    -- it was on the pharmacy's list: the pharmacy is told it left
    if v_was_waiting then
      select p.surname || ' ' || p.given_names into v_name
      from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
      insert into notification (kind, params, link, recipient_stations, created_by)
      values ('rx_outside',
              jsonb_build_object('item', rx_label(v_m), 'name', v_name,
                                 'by', (select full_name from profiles where id = auth.uid()),
                                 'reason', nullif(trim(coalesce(p_reason, '')), ''), 'requestId', v_m.id),
              '/app/visit?encounter=' || v_m.encounter_id, array['pharmacy'::station], auth.uid());
    end if;
    -- nothing left at the pharmacy: the patient goes on (back, cashier, or the visit closes)
    if v_open then
      perform after_pharmacy(v_m.encounter_id);
    end if;
  end if;
  select count(*)::integer into v_left from medication_request m
  where m.encounter_id = v_m.encounter_id and rx_pending(m);
  return jsonb_build_object('id', v_m.id, 'supply', p_supply, 'changed', true, 'pending', v_left);
end
$$;

-- ---------------------------------------------------------------- the pharmacy says "not given"
-- From 20261207090000_pharmacy_simplified: the prescriber is told whether the pharmacy had none and
-- whether the line may go to an outside pharmacy.
create or replace function rx_not_given(p_medication_request_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_item text;
  v_name text;
  v_left integer;
  v_main uuid := main_pharmacy();
begin
  perform assert_desk(array['pharmacy'], 'the pharmacy');
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
  v_item := rx_label(v_m);
  v_left := ceil(v_m.quantity)::integer - coalesce(v_m.quantity_given, 0);
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
  if coalesce(v_m.prescriber_id, v_m.created_by) is not null
     and coalesce(v_m.prescriber_id, v_m.created_by) is distinct from auth.uid() then
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('rx_not_given', jsonb_build_object('item', v_item, 'name', v_name, 'reason', trim(p_reason),
                                               'given', coalesce(v_m.quantity_given, 0),
                                               'remaining', v_left,
                                               'requestId', v_m.id,
                                               -- the pharmacy has not enough (unexpired) for what remains
                                               'noStock', v_main is null or usable_stock(v_m.item_id, v_main) < v_left,
                                               -- nothing given yet: the prescriber may send it outside
                                               'outside', coalesce(v_m.quantity_given, 0) = 0),
            '/app/visit?encounter=' || v_m.encounter_id, coalesce(v_m.prescriber_id, v_m.created_by), auth.uid());
  end if;
  perform after_pharmacy(v_m.encounter_id);
end
$$;

-- dispense_prescription (from 20261207090000_pharmacy_simplified): never a line bought outside.
create or replace function dispense_prescription(
  p_medication_request_id uuid, p_location_id uuid default null, p_quantity integer default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_loc uuid;
  v_dispense uuid;
  v_charged boolean := false;
  v_whole integer;
  v_left integer;
  v_give integer;
  v_charge numeric;
  v_done boolean;
  v_to uuid;
  v_name text;
begin
  perform assert_desk(array['pharmacy'], 'the pharmacy');
  select * into v_m from medication_request where id = p_medication_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  if v_m.supply = 'outside' then
    raise exception 'this medicine is bought at an outside pharmacy: the clinic does not give it' using errcode = '23505';
  end if;
  if v_m.cancelled_at is not null then
    raise exception 'the doctor cancelled this medicine' using errcode = '23505';
  end if;
  v_whole := ceil(v_m.quantity)::integer;
  v_left := v_whole - coalesce(v_m.quantity_given, 0);
  if v_m.given_at is not null or v_left <= 0
     or (coalesce(v_m.quantity_given, 0) = 0 and exists (
           select 1 from medication_dispense d where d.medication_request_id = v_m.id and d.deleted_at is null)) then
    raise exception 'already dispensed' using errcode = '23505';
  end if;
  if v_m.not_given_at is not null then
    raise exception 'this medicine was marked as not given' using errcode = '23505';
  end if;
  if p_quantity is not null and p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if p_quantity is not null and p_quantity > v_left then
    raise exception 'only % left to give of this medicine', v_left using errcode = '22023', hint = 'more_than_remaining';
  end if;
  -- The prescription is final once the doctor has finished (or sent the patient on). A sale written
  -- by the pharmacist themself is not held.
  if coalesce(v_m.prescriber_id, v_m.created_by) is distinct from auth.uid() and doctor_holds(v_m.encounter_id) then
    raise exception 'the doctor is still seeing this patient: hand the medicines over when the doctor has finished'
      using errcode = 'MS002', hint = 'doctor_holds';
  end if;
  if p_location_id is not null then
    if not exists (select 1 from stock_location where id = p_location_id and type = 'pharmacy'
                   and active and deleted_at is null) then
      raise exception 'choose an open pharmacy store' using errcode = '22023';
    end if;
    v_loc := p_location_id;
  else
    v_loc := main_pharmacy();
  end if;
  if v_loc is null then
    raise exception 'no pharmacy store yet: create one under Stock' using errcode = 'P0002';
  end if;
  v_give := coalesce(p_quantity, v_left);
  v_done := v_give = v_left;
  v_dispense := dispense_fefo(v_m.encounter_id, v_m.item_id, v_give, v_loc, v_m.id, null);
  -- the bill charges what is given; the last part charges what remains of the prescribed quantity
  v_charge := case when v_done then v_m.quantity - coalesce(v_m.quantity_given, 0) else v_give end;
  -- no price: handed over free (charged = false); no open bill: refused (MS001)
  begin
    perform add_charge_internal(v_m.encounter_id, 'pharmacy'::station, null, v_m.item_id, v_charge,
                       null, null, null, null, 'medication_dispense', v_dispense);
    v_charged := true;
  exception when sqlstate 'P0002' then
    v_charged := false;
  end;
  update medication_request
  set quantity_given = coalesce(quantity_given, 0) + v_give,
      given_at = case when v_done then now() end,
      given_by = case when v_done then auth.uid() end
  where id = v_m.id;
  -- part given: the prescriber is told what was given and what remains
  if not v_done then
    v_to := coalesce(v_m.prescriber_id, v_m.created_by);
    if v_to is not null and v_to is distinct from auth.uid() then
      select p.surname || ' ' || p.given_names into v_name
      from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
      insert into notification (kind, params, link, recipient_user, created_by)
      values ('rx_part_given',
              jsonb_build_object('item', item_label(v_m.item_id), 'name', v_name,
                                 'given', coalesce(v_m.quantity_given, 0) + v_give, 'remaining', v_left - v_give,
                                 'quantity', v_whole, 'requestId', v_m.id),
              '/app/visit?encounter=' || v_m.encounter_id, v_to, auth.uid());
    end if;
  end if;
  -- the last line handed over: on to the cashier (money due) or the visit closes
  perform after_pharmacy(v_m.encounter_id);
  perform stock_alert_run();
  return jsonb_build_object('dispenseId', v_dispense, 'charged', v_charged, 'locationId', v_loc,
                            'given', v_give, 'givenTotal', coalesce(v_m.quantity_given, 0) + v_give,
                            'remaining', v_left - v_give, 'quantity', v_whole);
end
$$;

-- ---------------------------------------------------------------- cancel
-- From 20261202090000_security_hardening: an outside line may be cancelled too (wrong medicine).
create or replace function cancel_prescription(p_request_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_item text;
  v_name text;
  v_left integer;
  v_waiting boolean;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the medicine is cancelled' using errcode = '22023';
  end if;
  select * into v_m from medication_request where id = p_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  if not (is_manager()
          or (has_perm('clinical.write')
              and (coalesce(v_m.prescriber_id, v_m.created_by) = auth.uid()
                   -- the patient was handed over: the colleague who took them now decides
                   or (may_work_on(v_m.encounter_id)
                       and result_recipient(v_m.encounter_id, coalesce(v_m.prescriber_id, v_m.created_by)) = auth.uid())))) then
    raise exception 'only the doctor treating the patient (or the manager) can cancel it' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  v_waiting := rx_pending(v_m);
  if not (v_waiting or (v_m.supply = 'outside' and v_m.cancelled_at is null)) then
    raise exception 'this medicine is no longer waiting at the pharmacy (handed over, not given or cancelled)'
      using errcode = 'P0002';
  end if;
  update medication_request
  set cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = trim(p_reason)
  where id = v_m.id;
  if v_waiting then
    -- the pharmacy is told the line left its list
    v_item := rx_label(v_m);
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
    insert into notification (kind, params, link, recipient_stations, created_by)
    values ('rx_cancelled',
            jsonb_build_object('item', v_item, 'name', v_name, 'reason', trim(p_reason),
                               'by', (select full_name from profiles where id = auth.uid())),
            '/app/visit?encounter=' || v_m.encounter_id, array['pharmacy'::station], auth.uid());
    -- nothing left at the pharmacy: the patient goes on (back, cashier, or the visit closes)
    perform after_pharmacy(v_m.encounter_id);
  end if;
  select count(*)::integer into v_left from medication_request m
  where m.encounter_id = v_m.encounter_id and rx_pending(m);
  return jsonb_build_object('id', v_m.id, 'pending', v_left,
                            'balance', invoice_balance((select id from invoice where encounter_id = v_m.encounter_id)));
end
$$;

-- ---------------------------------------------------------------- the stock the prescriber sees
-- { locationId, items: { itemId: usable units } } at the main pharmacy (not expired); an item
-- missing from `items` has none.
create or replace function rx_stock()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_loc uuid := main_pharmacy();
begin
  if not (has_perm('clinical.write') or has_perm('stock.read') or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'locationId', v_loc,
    'items', coalesce((
      select jsonb_object_agg(x.item_id, x.n)
      from (select s.item_id, sum(s.quantity)::integer as n from stock_on_hand s
            where s.location_id = v_loc and s.quantity > 0 and (s.expiry is null or s.expiry >= current_date)
            group by s.item_id) x), '{}'::jsonb));
end
$$;

-- ---------------------------------------------------------------- "Prescribed but bought outside"
create or replace function rx_bought_outside(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (has_perm('stock.read') and stock_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_to < p_from then
    raise exception 'the end of the period is before its start' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'name', x.name, 'itemId', x.item_id, 'referenceCode', x.code, 'inClinic', x.item_id is not null,
        'times', x.times, 'quantity', x.quantity, 'patients', x.patients, 'lastAt', x.last_at,
        'notGiven', x.not_given)
      order by x.times desc, x.quantity desc, x.name)
    from (
      select min(rx_label(m)) as name, m.item_id, min(m.reference_code) as code,
             count(*)::integer as times, sum(m.quantity) as quantity,
             count(distinct e.patient_id)::integer as patients, max(m.created_at) as last_at,
             -- sent outside after the pharmacy had none
             count(*) filter (where m.not_given_at is not null)::integer as not_given
      from medication_request m join encounter e on e.id = m.encounter_id
      where m.deleted_at is null and m.supply = 'outside' and m.cancelled_at is null
        and (m.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
      group by m.item_id, case when m.item_id is null then lower(coalesce(m.reference_code, rx_label(m))) end
    ) x), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- readers of prescriptions
-- visit_clinical (from 20261203090000_guide_fixes): a line without a clinic medicine, and the
-- decision (who, when, why).
create or replace function visit_clinical(p_encounter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_view text;
  v_patient uuid;
  v_closed boolean;
  v_safe boolean;
begin
  -- clinicians; the lab and the pharmacy read the record too (their orders and prescriptions)
  if not clinical_reader() then
    return null;
  end if;
  select e.patient_id, e.status = 'closed' into v_patient, v_closed
  from encounter e where e.id = p_encounter_id and e.deleted_at is null;
  if v_patient is null then
    return null;
  end if;
  v_view := visit_view(p_encounter_id);
  if v_view is null then
    v_safe := patient_level(v_patient) <> 'identity';
    return jsonb_build_object(
      'diagnoses', '[]'::jsonb, 'notes', '[]'::jsonb, 'prescriptions', '[]'::jsonb, 'orders', '[]'::jsonb,
      'patient', (select jsonb_build_object('id', p.id,
                    'allergies', case when v_safe then p.allergies end,
                    'bloodGroup', case when v_safe then p.blood_group end,
                    'notes', case when v_safe then p.notes end,
                    'flags', case when v_safe then p.flags else '{}'::jsonb end)
                  || case when v_safe then doc_patient(p.id, p_encounter_id)
                          else doc_patient(p.id, p_encounter_id) - 'allergies' - 'allergiesNone' - 'bloodGroup'
                               - 'weightKg' - 'weightAt' end
                  from patient p where p.id = v_patient),
      'visit', doc_visit(p_encounter_id),
      'private', true,
      'view', null,
      'access', patient_access(v_patient));
  end if;
  if v_closed then
    perform log_record_access(v_patient, p_encounter_id, v_view, 'visit');
  end if;
  return jsonb_build_object(
    'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by)) order by c.created_at)
      from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'))), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.value_text, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id)) order by o.effective_at)
      from observation o where o.encounter_id = p_encounter_id and o.code = 'note' and o.deleted_at is null), '[]'::jsonb),
    'prescriptions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by)), 'item', rx_label(m), 'dose', m.dose, 'route', m.route,
        'frequency', m.frequency, 'days', m.duration_days, 'quantity', m.quantity, 'instructions', m.instructions, 'at', m.created_at,
        'dispensed', m.supply = 'room' or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'supply', m.supply, 'givenAt', m.given_at, 'givenBy', (select full_name from profiles where id = m.given_by),
        'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason,
        'prescriberId', coalesce(m.prescriber_id, m.created_by), 'pending', rx_pending(m),
        'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
        'cancelledBy', (select full_name from profiles where id = m.cancelled_by),
        'itemId', m.item_id, 'referenceCode', m.reference_code, 'quantityGiven', coalesce(m.quantity_given, 0),
        'supplySetAt', m.supply_set_at, 'supplySetBy', (select full_name from profiles where id = m.supply_set_by),
        'supplyReason', m.supply_reason,
        'prescriber', doc_person(coalesce(m.prescriber_id, m.created_by))) order by m.created_at)
      from medication_request m where m.encounter_id = p_encounter_id and m.deleted_at is null), '[]'::jsonb),
    -- HIV tests (like the diagnoses above) only for the people allowed to see them
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end), 'status', r.status, 'reason', r.reason, 'at', r.created_at, 'mine', coalesce(r.requester_id = auth.uid(), false),
        'result', (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
          'corrected', d.corrected_at is not null, 'correctionReason', d.correction_reason,
          'at', coalesce(d.verified_at, d.updated_at), 'by', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
          'byPerson', doc_person(coalesce(d.verified_by, d.created_by)))
          from diagnostic_report d where d.service_request_id = r.id and d.deleted_at is null)) order by r.created_at)
      from service_request r join service s on s.id = r.service_id
      where r.encounter_id = p_encounter_id and r.deleted_at is null
        and (has_perm('sensitive.read') or not sensitive_service(s.id))), '[]'::jsonb),
    'patient', (select jsonb_build_object('id', p.id, 'allergies', p.allergies, 'bloodGroup', p.blood_group, 'notes', p.notes, 'flags', p.flags)
                       || doc_patient(p.id, e.id)
      from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id),
    'visit', doc_visit(p_encounter_id),
    'private', false,
    'view', v_view
  );
end
$$;

-- visit_journey (from 20261130090000_patient_privacy): every medicine, outside ones too.
create or replace function visit_journey(p_encounter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_steps jsonb;
  v_vitals jsonb := '[]'::jsonb;
  v_dx jsonb := '[]'::jsonb;
  v_meds jsonb := '[]'::jsonb;
  v_tests jsonb := '[]'::jsonb;
  v_charges jsonb;
  v_payments jsonb;
  v_bill jsonb;
  v_enc encounter%rowtype;
  v_view text;
  v_handovers jsonb;
begin
  if not has_perm('patient.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_enc from encounter where id = p_encounter_id and deleted_at is null;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002';
  end if;
  v_view := case when clinical_reader() then visit_view(p_encounter_id) end;

  select coalesce(jsonb_agg(jsonb_build_object(
      'station', q.station, 'queuedAt', q.created_at, 'calledAt', q.called_at, 'startedAt', q.started_at,
      'finishedAt', q.finished_at, 'takenBy', tb.full_name, 'assignedTo', asg.full_name,
      'referredBy', rb.full_name, 'note', case when v_view is not null then q.referral_note end,
      'enteredBy', eb.full_name,
      'service', q.service, 'department', (select d.name from department d where d.id = q.department_id)
    ) order by q.created_at), '[]'::jsonb) into v_steps
  from queue_entry q
  left join profiles tb on tb.id = q.taken_by
  left join profiles asg on asg.id = q.assigned_to
  left join profiles rb on rb.id = q.referred_by
  left join profiles eb on eb.id = q.entered_by
  where q.encounter_id = p_encounter_id and q.deleted_at is null;

  if v_view is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
        'code', o.code, 'value', o.value_num, 'unit', o.unit, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id)
      ) order by o.effective_at), '[]'::jsonb) into v_vitals
    from observation o where o.encounter_id = p_encounter_id and o.deleted_at is null and o.code <> 'note';

    select coalesce(jsonb_agg(jsonb_build_object(
        'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by)
      ) order by c.created_at), '[]'::jsonb) into v_dx
    from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'));

    select coalesce(jsonb_agg(jsonb_build_object(
        'item', rx_label(m), 'quantity', m.quantity, 'dose', m.dose,
        'frequency', m.frequency, 'days', m.duration_days, 'supply', m.supply, 'givenAt', m.given_at,
        'givenBy', (select full_name from profiles where id = m.given_by), 'at', m.created_at,
        'by', (select full_name from profiles where id = m.created_by),
        'dispensed', exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason,
        'notGivenBy', (select full_name from profiles where id = m.not_given_by),
        'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
        'cancelledBy', (select full_name from profiles where id = m.cancelled_by)
      ) order by m.created_at), '[]'::jsonb) into v_meds
    from medication_request m
    where m.encounter_id = p_encounter_id and m.deleted_at is null;

    select coalesce(jsonb_agg(jsonb_build_object(
        'test', s.name_en, 'status', r.status, 'priority', r.priority, 'at', r.created_at,
        'by', (select full_name from profiles where id = r.created_by),
        'result', (select coalesce(dr.impression, dr.findings) from diagnostic_report dr where dr.service_request_id = r.id and dr.deleted_at is null order by dr.created_at desc limit 1)
      ) order by r.created_at), '[]'::jsonb) into v_tests
    from service_request r left join service s on s.id = r.service_id
    where r.encounter_id = p_encounter_id and r.deleted_at is null;

    if v_enc.status = 'closed' then
      perform log_record_access(v_enc.patient_id, p_encounter_id, v_view, 'journey');
    end if;
  end if;

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

  -- who handed the patient over to whom (20261129090000_handover); the note and the reason are
  -- clinical: for the two colleagues and those who may see this visit's record
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', h.id, 'station', h.station, 'at', h.created_at, 'from', f.full_name, 'to', t.full_name,
      'note', case when v_view is not null or auth.uid() in (h.from_user, h.to_user) then h.note end,
      'status', h.status, 'answeredAt', h.answered_at,
      'answeredBy', (select full_name from profiles where id = h.answered_by),
      'reason', case when v_view is not null or auth.uid() in (h.from_user, h.to_user) then h.reason end
    ) order by h.created_at), '[]'::jsonb) into v_handovers
  from patient_handover h
  join profiles f on f.id = h.from_user
  join profiles t on t.id = h.to_user
  where h.encounter_id = p_encounter_id and h.deleted_at is null;

  return jsonb_build_object(
    'encounterId', v_enc.id, 'arrivedAt', v_enc.arrived_at, 'status', v_enc.status, 'closedAt', v_enc.closed_at,
    'triage', v_enc.triage_level,
    'triageReason', case when v_view is not null then v_enc.triage_reason end,
    'closedBy', (select full_name from profiles where id = v_enc.closed_by),
    -- the track: treatment finished, why the patient left, what they came for
    'treatmentDoneAt', v_enc.clinical_done_at, 'leftReason', v_enc.left_reason, 'service', v_enc.service,
    'steps', v_steps, 'vitals', v_vitals, 'diagnoses', v_dx, 'medicines', v_meds, 'tests', v_tests,
    'charges', v_charges, 'payments', v_payments, 'bill', v_bill, 'handovers', v_handovers,
    'private', v_view is null
  );
end
$$;

-- patient_safety_summary (from 20261130090000_patient_privacy): medicines bought outside count as
-- medicines the patient takes.
create or replace function patient_safety_summary(p_patient_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'allergies', p.allergies,
    'allergiesNone', coalesce(p.allergies_none, false) and p.allergies is null,
    'bloodGroup', p.blood_group,
    'alerts', p.notes,
    'flags', p.flags,
    -- long-lasting conditions: a chronic ICD-10 group, or the same diagnosis on two visits
    'chronic', coalesce((
      select jsonb_agg(jsonb_build_object('text', x.text, 'icd10', x.icd10_code, 'since', x.first_at, 'lastAt', x.created_at)
                       order by x.created_at desc)
      from (
        select distinct on (lower(c.text)) c.text, c.icd10_code, c.created_at,
               min(c.created_at) over (partition by lower(c.text)) as first_at
        from condition c join encounter e on e.id = c.encounter_id and e.deleted_at is null
        where e.patient_id = p.id and c.deleted_at is null
          and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'))
          and (coalesce(c.icd10_code, '') ~ '^(I1[0-5]|I25|I50|E0[3-5]|E1[0-4]|J4[45]|G40|N18|B18|B2[0-4]|F2[0-9]|F3[1-3])'
               or (select count(distinct c2.encounter_id) from condition c2
                   join encounter e2 on e2.id = c2.encounter_id and e2.deleted_at is null
                   where e2.patient_id = p.id and c2.deleted_at is null and lower(c2.text) = lower(c.text)) >= 2)
        order by lower(c.text), c.created_at desc
      ) x), '[]'::jsonb),
    -- medicines of the open visit, and those still running (prescribed days not over)
    'medications', coalesce((
      select jsonb_agg(jsonb_build_object(
          'item', rx_label(m), 'dose', m.dose, 'frequency', m.frequency,
          'days', m.duration_days, 'at', m.created_at, 'outside', m.supply = 'outside',
          'until', case when m.duration_days is not null then m.created_at + make_interval(days => m.duration_days) end,
          'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by)))
        order by m.created_at desc)
      from medication_request m
      join encounter e on e.id = m.encounter_id and e.deleted_at is null
      where e.patient_id = p.id and m.deleted_at is null and m.cancelled_at is null
        and (m.not_given_at is null or m.supply = 'outside')
        and m.created_at > now() - interval '180 days'
        and (e.status = 'open' or m.created_at + make_interval(days => coalesce(m.duration_days, 0)) >= now())), '[]'::jsonb),
    'lastVitals', coalesce((
      select jsonb_agg(jsonb_build_object('code', v.code, 'value', v.value_num, 'unit', v.unit, 'at', v.effective_at,
                                          'by', (select full_name from profiles where id = v.performer_id))
                       order by v.code)
      from (
        select distinct on (o.code) o.code, o.value_num, o.unit, o.effective_at, o.performer_id
        from observation o join encounter e on e.id = o.encounter_id and e.deleted_at is null
        where e.patient_id = p.id and o.deleted_at is null and o.code <> 'note' and o.value_num is not null
        order by o.code, o.effective_at desc
      ) v), '[]'::jsonb),
    'lastVisitAt', (select max(e.arrived_at) from encounter e where e.patient_id = p.id and e.deleted_at is null)
  )
  from patient p where p.id = p_patient_id
$$;

-- my_prescriptions (from 20261123090000_dispensing_fixes): outside lines, state 'outside'.
create or replace function my_prescriptions(p_days integer default 7, p_from date default null, p_to date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb)
  from (
    select m.created_at as at, jsonb_build_object(
      'id', m.id, 'encounterId', m.encounter_id, 'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'item', rx_label(m), 'quantity', m.quantity,
      'dose', m.dose, 'frequency', m.frequency, 'days', m.duration_days, 'instructions', m.instructions,
      'supply', m.supply, 'at', m.created_at,
      'state', case
                 when m.cancelled_at is not null then 'cancelled'
                 when m.supply = 'outside' then 'outside'
                 when m.not_given_at is not null then 'not_given'
                 when m.supply = 'room' then 'room'
                 when m.given_at is not null
                      or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null)
                   then 'given'
                 else 'waiting' end,
      'givenAt', m.given_at, 'notGivenReason', m.not_given_reason,
      'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
      'visitOpen', e.status = 'open') as j
    from medication_request m
    join encounter e on e.id = m.encounter_id
    join patient p on p.id = e.patient_id
    where m.deleted_at is null and coalesce(m.prescriber_id, m.created_by) = auth.uid()
      and case when p_from is not null
            then (m.created_at at time zone 'Africa/Kigali')::date between p_from and coalesce(p_to, p_from)
            else m.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90))) end
    order by m.created_at desc
    limit 500
  ) x
$$;

revoke all on function rx_label(medication_request), rx_rule_warnings(text, uuid) from public, anon;
grant execute on function rx_label(medication_request), rx_rule_warnings(text, uuid) to authenticated;
revoke all on function prescribe(uuid, uuid, numeric, text, text, text, integer, text, text, station, uuid, text, text),
  rx_set_supply(uuid, text, text), rx_stock(), rx_bought_outside(date, date) from public, anon;
grant execute on function prescribe(uuid, uuid, numeric, text, text, text, integer, text, text, station, uuid, text, text),
  rx_set_supply(uuid, text, text), rx_stock(), rx_bought_outside(date, date) to authenticated;

-- analytics_staff_events (from 20261127090000_analytics): a medicine bought outside that is not
-- in the clinic's list has no item; its typed name shows instead of an empty line.
create or replace function analytics_staff_events(p_start timestamptz, p_end timestamptz, p_money boolean)
returns table (user_id uuid, at timestamptz, kind text, encounter_id uuid, patient_id uuid, amount numeric, what text)
language sql stable security definer set search_path = public
as $$
  -- registered
  select x.created_by, x.created_at, 'registered', null::uuid, x.id, null::numeric, null::text
  from patient x
  where x.deleted_at is null and x.created_by is not null and x.created_at >= p_start and x.created_at < p_end
  union all
  -- vitals, one per visit
  select v.u, v.at, 'vitals', v.enc, e.patient_id, null, null
  from (select o.performer_id as u, o.encounter_id as enc, min(o.effective_at) as at
        from observation o
        where o.deleted_at is null and o.code <> 'note' and o.performer_id is not null
          and o.effective_at >= p_start and o.effective_at < p_end
        group by 1, 2) v
  join encounter e on e.id = v.enc
  union all
  -- patients seen: took the patient from a queue, or wrote on the visit
  select s.u, s.at, 'patientsSeen', s.enc, e.patient_id, null, e.reference
  from (select a.u, a.enc, min(a.at) as at
        from (
          select q.taken_by as u, q.encounter_id as enc, coalesce(q.started_at, q.finished_at, q.created_at) as at
          from queue_entry q where q.deleted_at is null and q.taken_by is not null
          union all
          select c.created_by, c.encounter_id, c.created_at from condition c where c.deleted_at is null
          union all
          select m.prescriber_id, m.encounter_id, m.created_at from medication_request m where m.deleted_at is null
          union all
          select r.requester_id, r.encounter_id, r.created_at from service_request r where r.deleted_at is null
          union all
          select o.performer_id, o.encounter_id, o.effective_at from observation o where o.deleted_at is null and o.code = 'note'
          union all
          select x.performer_id, x.encounter_id, coalesce(x.performed_at, x.created_at) from procedure x where x.deleted_at is null
        ) a
        where a.u is not null and a.enc is not null and a.at >= p_start and a.at < p_end
        group by 1, 2) s
  join encounter e on e.id = s.enc
  union all
  -- diagnoses
  select c.created_by, c.created_at, 'diagnoses', c.encounter_id, e.patient_id, null,
         trim(coalesce(c.icd10_code || ' ', '') || coalesce(c.text, ''))
  from condition c join encounter e on e.id = c.encounter_id
  where c.deleted_at is null and c.created_by is not null and c.created_at >= p_start and c.created_at < p_end
  union all
  -- prescriptions
  select m.prescriber_id, m.created_at, 'prescriptions', m.encounter_id, e.patient_id, null,
         coalesce(item_label(m.item_id), m.medicine_name) || coalesce(' · ' || nullif(m.dose, ''), '')
  from medication_request m join encounter e on e.id = m.encounter_id
  where m.deleted_at is null and m.prescriber_id is not null and m.created_at >= p_start and m.created_at < p_end
  union all
  -- test orders
  select r.requester_id, r.created_at, 'orders', r.encounter_id, e.patient_id, null, sv.name_en
  from service_request r join encounter e on e.id = r.encounter_id left join service sv on sv.id = r.service_id
  where r.deleted_at is null and r.requester_id is not null and r.created_at >= p_start and r.created_at < p_end
  union all
  -- results (verified, else typed)
  select coalesce(d.verified_by, d.created_by), coalesce(d.verified_at, d.created_at), 'results', r.encounter_id, e.patient_id, null, sv.name_en
  from diagnostic_report d
  join service_request r on r.id = d.service_request_id
  join encounter e on e.id = r.encounter_id
  left join service sv on sv.id = r.service_id
  where d.deleted_at is null and coalesce(d.verified_by, d.created_by) is not null
    and coalesce(d.verified_at, d.created_at) >= p_start and coalesce(d.verified_at, d.created_at) < p_end
  union all
  -- procedures
  select x.performer_id, coalesce(x.performed_at, x.created_at), 'procedures', x.encounter_id, e.patient_id, null, sv.name_en
  from procedure x join encounter e on e.id = x.encounter_id left join service sv on sv.id = x.service_id
  where x.deleted_at is null and x.performer_id is not null
    and coalesce(x.performed_at, x.created_at) >= p_start and coalesce(x.performed_at, x.created_at) < p_end
  union all
  -- medicines given: handed over at the pharmacy …
  select md.dispenser_id, md.created_at, 'medicinesGiven', md.encounter_id, e.patient_id, null,
         item_label(md.item_id) || ' × ' || trim_scale(md.quantity)::text
  from medication_dispense md left join encounter e on e.id = md.encounter_id
  where md.deleted_at is null and md.dispenser_id is not null and md.created_at >= p_start and md.created_at < p_end
  union all
  -- … and given from a room store (a pharmacy hand-over also sets given_by: it is counted above,
  -- through its medication_dispense row, so only requests without one come from here)
  select m.given_by, m.given_at, 'medicinesGiven', m.encounter_id, e.patient_id, null, coalesce(item_label(m.item_id), m.medicine_name)
  from medication_request m join encounter e on e.id = m.encounter_id
  where m.deleted_at is null and m.given_by is not null and m.given_at >= p_start and m.given_at < p_end
    and not exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null)
  union all
  -- charges
  select l.entered_by, l.created_at, 'charges', i.encounter_id, e.patient_id, round(l.unit_price * l.quantity), l.description
  from invoice_line l join invoice i on i.id = l.invoice_id left join encounter e on e.id = i.encounter_id
  where l.deleted_at is null and l.entered_by is not null and l.created_at >= p_start and l.created_at < p_end
  union all
  -- admissions
  select b.created_by, coalesce(b.admitted_at, b.created_at), 'admissions', b.encounter_id, e.patient_id, null, bd.name
  from bed_stay b join encounter e on e.id = b.encounter_id left join bed bd on bd.id = b.bed_id
  where b.deleted_at is null and b.created_by is not null
    and coalesce(b.admitted_at, b.created_at) >= p_start and coalesce(b.admitted_at, b.created_at) < p_end
  union all
  -- tasks done
  select k.done_by, k.done_at, 'tasksDone', k.encounter_id, k.patient_id, null, k.title
  from internal_task k
  where k.deleted_at is null and k.done_by is not null and k.done_at >= p_start and k.done_at < p_end
  union all
  select v.created_by, v.created_at, 'vaccinations', v.encounter_id, v.patient_id, null, v.vaccine
  from vaccination v
  where v.deleted_at is null and v.created_by is not null and v.created_at >= p_start and v.created_at < p_end
  union all
  -- an HIV test: never its result
  select h.created_by, coalesce(h.tested_at, h.created_at), 'hivTests', h.encounter_id, h.patient_id, null, null
  from hiv_test h
  where h.deleted_at is null and h.created_by is not null
    and coalesce(h.tested_at, h.created_at) >= p_start and coalesce(h.tested_at, h.created_at) < p_end
  union all
  select f.created_by, f.created_at, 'familyPlanning', f.encounter_id, f.patient_id, null, f.method
  from fp_event f
  where f.deleted_at is null and f.created_by is not null and f.created_at >= p_start and f.created_at < p_end
  union all
  -- money (the manager only)
  select y.cashier_id, y.paid_at, 'payments', i.encounter_id, e.patient_id, y.amount, y.method::text
  from payment y left join invoice i on i.id = y.invoice_id left join encounter e on e.id = i.encounter_id
  where p_money and y.deleted_at is null and y.cashier_id is not null and y.paid_at >= p_start and y.paid_at < p_end
  union all
  select rf.cashier_id, rf.refunded_at, 'refunds', i.encounter_id, e.patient_id, rf.amount, rf.reason
  from refund rf join invoice i on i.id = rf.invoice_id left join encounter e on e.id = i.encounter_id
  where p_money and rf.deleted_at is null and rf.cashier_id is not null and rf.refunded_at >= p_start and rf.refunded_at < p_end
  union all
  select y.voided_by, y.voided_at, 'voided', i.encounter_id, e.patient_id, y.amount, y.void_reason
  from payment y left join invoice i on i.id = y.invoice_id left join encounter e on e.id = i.encounter_id
  where p_money and y.voided_by is not null and y.voided_at >= p_start and y.voided_at < p_end
  union all
  select cs.handed_over_by, cs.handed_over_at, 'handovers', null, null, cs.total, cs.number
  from counter_sale cs
  where p_money and cs.deleted_at is null and cs.handed_over_by is not null
    and cs.handed_over_at >= p_start and cs.handed_over_at < p_end
$$;
revoke all on function analytics_staff_events(timestamptz, timestamptz, boolean) from public, anon, authenticated;
