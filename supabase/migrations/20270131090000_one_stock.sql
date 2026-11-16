-- 0173: one clinic stock. Prescriptions are for an outside pharmacy; what the clinic gives
-- is given here, from its one stock (the main pharmacy), by the doctor or nurse at the visit.
--
-- The owner (2026-11-16): the room stores go; one controlled stock and pharmacy feature, whoever
-- the manager lets in is in charge; when medicines or products are given, the quantity is said
-- and taken off the stock. The pharmacy dashboard stays for a later pharmacist, without the
-- hand-over queue.
--   * prescribe: p_supply 'pharmacy' is read as 'outside' (old screens); 'room' comes from the
--     clinic's stock whoever gives (no store to hold); no pharmacy queue entry is made.
--   * room_store_for: the clinic's stock when it holds enough (the nurse orders use it too).
--   * data: prescriptions still waiting at the pharmacy become "to buy outside" (a part already
--     handed over stays as given); open pharmacy queue entries finish; every room store's stock
--     goes back to the main pharmacy as transfers (history kept); the room stores close and
--     their holders are released.

-- ---------------------------------------------------------------- room_store_for (from 20270108090000_profession_manager)
create or replace function room_store_for(
  p_staff uuid, p_item_id uuid, p_quantity integer, p_location uuid default null, p_station station default null
)
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare
  v_qty integer := greatest(coalesce(p_quantity, 1), 1);
  v_id uuid;
begin
  -- 0173: one stock: the main pharmacy (an open store named explicitly is honoured)
  if p_location is not null and exists (select 1 from stock_location where id = p_location and deleted_at is null and active) then
    v_id := p_location;
  else
    v_id := main_pharmacy();
  end if;
  if v_id is null then
    return null;
  end if;
  return case when usable_stock(p_item_id, v_id) >= v_qty then v_id end;
end
$$;

-- ---------------------------------------------------------------- prescribe (from 20270130090000_lists_as_one)
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
  v_supply text := coalesce(p_supply, 'outside');
  v_code text := nullif(trim(coalesce(p_reference_code, '')), '');
  v_name text;
  v_generic text;
  v_rule text;
  v_warn jsonb := '[]'::jsonb;
  v_closed boolean;
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
  -- 0173: nothing is handed over at the clinic pharmacy any more: a prescription is for an
  -- outside pharmacy; what the clinic gives is given here, from its one stock
  if v_supply = 'pharmacy' then
    v_supply := 'outside';
  end if;
  if not visit_open_or_editing(p_encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  select e.status = 'closed' into v_closed from encounter e where e.id = p_encounter_id;
  if v_closed and v_supply <> 'outside' then
    raise exception 'the visit is finished: a medicine added now can only be bought outside' using errcode = '22023';
  end if;
  if p_item_id is null then
    -- not a clinic medicine: only for an outside pharmacy, named (or taken from the official list)
    if v_supply <> 'outside' then
      raise exception 'this medicine is not sold at the clinic: it can only be bought outside' using errcode = '22023';
    end if;
    if v_code is not null then
      select r.generic, r.prescribing_rule into v_generic, v_rule from medicine_reference r where r.code = v_code;
      if not found then
        -- 0172: a line of an uploaded medicines list
        select l.name || coalesce(' ' || l.detail, '') into v_generic
        from tariff_book b
        join tariff_version v on v.id = tariff_version_at(b.id, current_date)
        join tariff_line l on l.version_id = v.id and l.removed_at is null and l.code = tariff_code_norm(v_code)
        where b.kind = 'medicines' and b.deleted_at is null
        order by b.priority, b.created_at
        limit 1;
        if not found then
          raise exception 'medicine not found' using errcode = 'P0002';
        end if;
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
      raise exception 'not enough of this medicine (not expired) in the clinic''s stock'
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
  end if;
  -- 'outside': nothing charged, nothing taken, nothing queued
  perform note_visit_edit(p_encounter_id, 'create', 'medication_request', v_id,
                          jsonb_build_object('item', v_name, 'itemId', p_item_id, 'quantity', p_quantity, 'supply', v_supply));
  return jsonb_build_object('id', v_id, 'supply', v_supply, 'charged', v_charged,
                            'stockTaken', v_taken, 'locationId', v_loc, 'medicineName', v_name,
                            'warnings', v_warn);
end
$$;

-- ---------------------------------------------------------------- the data
-- prescriptions waiting at the pharmacy: the patient buys them outside (nothing was handed over)
update medication_request
set supply = 'outside', supply_set_at = now()
where deleted_at is null and supply = 'pharmacy' and given_at is null and not_given_at is null
  and cancelled_at is null and coalesce(quantity_given, 0) = 0;
-- a part already handed over: that part stands as given; the rest is bought outside
update medication_request
set quantity = quantity_given, given_at = coalesce(given_at, now())
where deleted_at is null and supply = 'pharmacy' and given_at is null and not_given_at is null
  and cancelled_at is null and coalesce(quantity_given, 0) > 0;
-- the pharmacy's open queue entries finish
update queue_entry set finished_at = now()
where station = 'pharmacy' and finished_at is null and deleted_at is null;
-- every room store's stock goes back to the clinic's stock, as transfers
insert into stock_movement (item_id, batch_id, from_location_id, to_location_id, quantity, type, reason, unit_cost)
select s.item_id, s.batch_id, s.location_id, main_pharmacy(), s.quantity, 'transfer',
       'room stores closed: back to the clinic''s stock', b.unit_cost
from stock_on_hand s
join stock_location l on l.id = s.location_id
left join batch b on b.id = s.batch_id
where is_room_type(l.type) and s.quantity > 0 and main_pharmacy() is not null
  and s.location_id <> main_pharmacy();
-- the room stores close; their holders are released
update stock_location set active = false
where is_room_type(type) and deleted_at is null and active;
update stock_location_holder set deleted_at = now() where deleted_at is null;
