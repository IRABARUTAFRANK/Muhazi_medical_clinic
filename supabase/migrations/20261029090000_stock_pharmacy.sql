-- 0042 · Medicine stock: what is on hand and where, cost and selling price, stock value,
-- receiving, sending a quantity to a department or a doctor's office, dispensing at the
-- pharmacy, and what was sold. Stock on hand is always the sum of the ledger (stock_movement).

alter table stock_location add column if not exists department_id uuid references department (id);
alter table stock_location add column if not exists active boolean not null default true;

-- ---------------------------------------------------------------- locations (stores)
create or replace function save_location(p_id uuid, p_name text, p_type stock_location_type, p_department_id uuid default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
begin
  if not has_perm('stock.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'the store needs a name' using errcode = '22023';
  end if;
  if v_id is null then
    insert into stock_location (name, type, department_id) values (trim(p_name), p_type, p_department_id)
    returning id into v_id;
  else
    update stock_location set name = trim(p_name), type = p_type, department_id = p_department_id
    where id = v_id and deleted_at is null;
    if not found then
      raise exception 'store not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end
$$;

-- ---------------------------------------------------------------- overview
create or replace function stock_overview()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_locations jsonb;
  v_items jsonb;
begin
  if not has_perm('stock.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'type', l.type,
                                               'department', d.name) order by l.type, l.name), '[]'::jsonb)
  into v_locations
  from stock_location l left join department d on d.id = l.department_id
  where l.deleted_at is null and l.active;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'code', i.code, 'name', i.name_generic, 'strength', i.strength, 'unit', i.selling_unit,
      'sellingPrice', (select pf.price from price_for(null, i.id, null) pf),
      'reorderLevel', i.reorder_level,
      'onHand', coalesce(t.on_hand, 0),
      'costValue', coalesce(t.cost_value, 0),
      'avgCost', case when coalesce(t.on_hand, 0) > 0 then round(t.cost_value / t.on_hand, 2) else null end,
      'byLocation', coalesce(t.by_location, '{}'::jsonb),
      'earliestExpiry', t.earliest_expiry,
      'expiredUnits', coalesce(t.expired, 0),
      'active', i.active
    ) order by i.name_generic), '[]'::jsonb)
  into v_items
  from item i
  left join lateral (
    select sum(s.quantity)::integer as on_hand,
           sum(s.quantity * coalesce(b.unit_cost, 0)) as cost_value,
           (select jsonb_object_agg(x.location_id::text, x.q) from (
              select s2.location_id, sum(s2.quantity)::integer as q from stock_on_hand s2
              where s2.item_id = i.id group by s2.location_id having sum(s2.quantity) <> 0) x) as by_location,
           min(s.expiry) filter (where s.quantity > 0) as earliest_expiry,
           sum(s.quantity) filter (where s.quantity > 0 and s.expiry < current_date)::integer as expired
    from stock_on_hand s left join batch b on b.id = s.batch_id
    where s.item_id = i.id
  ) t on true
  where i.deleted_at is null;

  return jsonb_build_object('locations', v_locations, 'items', v_items);
end
$$;

-- ---------------------------------------------------------------- receiving
create or replace function receive_stock(
  p_item_id uuid, p_location_id uuid, p_quantity integer, p_unit_cost numeric,
  p_batch_no text default null, p_expiry date default null, p_supplier text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_batch uuid;
  v_supplier uuid;
  v_no text := nullif(trim(coalesce(p_batch_no, '')), '');
begin
  if not has_perm('stock.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if p_unit_cost is null or p_unit_cost < 0 then
    raise exception 'the cost per unit must be zero or more' using errcode = '22023';
  end if;
  if not exists (select 1 from item where id = p_item_id and deleted_at is null) then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from stock_location where id = p_location_id and deleted_at is null) then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if nullif(trim(coalesce(p_supplier, '')), '') is not null then
    select id into v_supplier from supplier where lower(name) = lower(trim(p_supplier)) and deleted_at is null;
    if v_supplier is null then
      insert into supplier (name) values (trim(p_supplier)) returning id into v_supplier;
    end if;
  end if;
  if v_no is null then
    v_no := 'B' || to_char(now(), 'YYMMDD') || '-' || lpad(next_number('batch', extract(year from now())::integer)::text, 3, '0');
  end if;
  insert into batch (item_id, batch_no, expiry, unit_cost, supplier_id)
  values (p_item_id, v_no, coalesce(p_expiry, (current_date + interval '2 years')::date), p_unit_cost, v_supplier)
  on conflict (item_id, batch_no) do update set unit_cost = excluded.unit_cost, expiry = excluded.expiry
  returning id into v_batch;
  insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason)
  values (p_item_id, v_batch, p_location_id, p_quantity, 'receipt', nullif(trim(coalesce(p_supplier, '')), ''));
  return v_batch;
end
$$;

-- Oldest expiry first, from one store to another (a department, a doctor's office, the pharmacy).
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

-- Used from a store without a sale (given in the room, consumed, wasted, expired).
create or replace function use_stock(
  p_item_id uuid, p_location_id uuid, p_quantity integer, p_encounter_id uuid default null, p_reason text default null
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_remaining integer := p_quantity;
  v_row record;
  v_take integer;
begin
  if not (has_perm('stock.write') or has_perm('stock.dispense') or has_perm('clinical.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  for v_row in
    select s.batch_id, s.quantity from stock_on_hand s
    where s.item_id = p_item_id and s.location_id = p_location_id and s.quantity > 0
    order by s.expiry asc nulls last
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.quantity, v_remaining);
    insert into stock_movement (item_id, batch_id, from_location_id, quantity, type, reason)
    values (p_item_id, v_row.batch_id, p_location_id, v_take, 'consumption',
            coalesce(nullif(trim(coalesce(p_reason, '')), ''), case when p_encounter_id is not null then 'visit ' || p_encounter_id::text end));
    v_remaining := v_remaining - v_take;
  end loop;
  if v_remaining > 0 then
    raise exception 'not enough stock in that store: % unit(s) short', v_remaining using errcode = '23514';
  end if;
  return p_quantity;
end
$$;

-- ---------------------------------------------------------------- the pharmacy desk
-- Prescriptions to hand over: open visits, supply "pharmacy", not dispensed yet.
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
  left join profiles pr on pr.id = m.created_by
  where has_perm('stock.read') and m.deleted_at is null and m.supply = 'pharmacy' and m.given_at is null
    and not exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null)
$$;

-- Hand over one prescription: stock leaves the pharmacy (oldest expiry first), the medicine
-- goes on the bill at its price, and the pharmacy queue entry closes when nothing is left.
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
  if not exists (select 1 from medication_request x where x.encounter_id = v_m.encounter_id and x.deleted_at is null
                 and x.supply = 'pharmacy' and x.given_at is null and x.id <> v_m.id) then
    update queue_entry set finished_at = now()
    where encounter_id = v_m.encounter_id and station = 'pharmacy' and finished_at is null and deleted_at is null;
  end if;
  return jsonb_build_object('dispenseId', v_dispense, 'charged', v_charged);
end
$$;

-- ---------------------------------------------------------------- ledger and sales
create or replace function stock_movements(p_from date, p_to date, p_item_id uuid default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'at', m.moved_at, 'type', m.type, 'item', i.name_generic || coalesce(' ' || i.strength, ''),
    'quantity', m.quantity, 'from', lf.name, 'to', lt.name, 'batch', b.batch_no, 'expiry', b.expiry,
    'unitCost', b.unit_cost, 'reason', m.reason, 'by', pr.full_name
  ) order by m.moved_at desc), '[]'::jsonb)
  from stock_movement m
  join item i on i.id = m.item_id
  left join batch b on b.id = m.batch_id
  left join stock_location lf on lf.id = m.from_location_id
  left join stock_location lt on lt.id = m.to_location_id
  left join profiles pr on pr.id = m.created_by
  where has_perm('stock.read') and m.deleted_at is null
    and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to
    and (p_item_id is null or m.item_id = p_item_id)
$$;

-- What was sold (charged) per medicine in a period, with the cost of those units.
create or replace function stock_sales(p_from date, p_to date)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'item', x.name, 'units', x.units, 'revenue', x.revenue, 'cost', x.cost, 'margin', x.revenue - x.cost
      ) order by x.revenue desc)
      from (
        select i.name_generic || coalesce(' ' || i.strength, '') as name,
               sum(l.quantity) as units,
               sum(round(l.quantity * l.unit_price)) as revenue,
               sum(l.quantity) * coalesce((select avg(b.unit_cost) from batch b where b.item_id = i.id and b.deleted_at is null), 0) as cost
        from invoice_line l
        join invoice inv on inv.id = l.invoice_id and inv.status <> 'credited'
        join item i on i.id = l.item_id
        where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
        group by i.id, i.name_generic, i.strength
      ) x), '[]'::jsonb),
    'received', (select coalesce(sum(m.quantity * coalesce(b.unit_cost, 0)), 0) from stock_movement m left join batch b on b.id = m.batch_id
                 where m.deleted_at is null and m.type = 'receipt' and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'consumed', (select coalesce(sum(m.quantity * coalesce(b.unit_cost, 0)), 0) from stock_movement m left join batch b on b.id = m.batch_id
                 where m.deleted_at is null and m.type = 'consumption' and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'stockValue', (select coalesce(sum(s.quantity * coalesce(b.unit_cost, 0)), 0) from stock_on_hand s left join batch b on b.id = s.batch_id where s.quantity > 0)
  )
  where has_perm('stock.read')
$$;

revoke all on function save_location(uuid, text, stock_location_type, uuid), stock_overview(),
  receive_stock(uuid, uuid, integer, numeric, text, date, text), transfer_stock(uuid, uuid, uuid, integer, text),
  use_stock(uuid, uuid, integer, uuid, text), pharmacy_queue(), dispense_prescription(uuid, uuid),
  stock_movements(date, date, uuid), stock_sales(date, date) from public, anon;
grant execute on function save_location(uuid, text, stock_location_type, uuid), stock_overview(),
  receive_stock(uuid, uuid, integer, numeric, text, date, text), transfer_stock(uuid, uuid, uuid, integer, text),
  use_stock(uuid, uuid, integer, uuid, text), pharmacy_queue(), dispense_prescription(uuid, uuid),
  stock_movements(date, date, uuid), stock_sales(date, date) to authenticated;
