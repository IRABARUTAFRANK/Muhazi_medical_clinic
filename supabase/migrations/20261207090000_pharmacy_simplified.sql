-- 0097 · The pharmacy, simplified (the owner's design, 27 October).
--
-- Frank: the clinic's pharmacy is a small pharmacy and the main store. It records stock, hands over
-- prescribed medicines, sells to walk-in buyers, supplies the room stores and alerts the manager.
--
--   * A  ADD STOCK. add_stock(lines, store?, note?): the item (one of the list, or a new one: a
--        medicine or a supply), batch number, expiry, quantity, cost per unit, selling price. No
--        supplier, no delivery note, no date (today). Into the main pharmacy (another store: the
--        manager). A new item takes the selling price; an existing one whose price differs takes it
--        when the person may set prices (item_price.write / catalogue.write), else the line says
--        price_ignored. The same batch number with another expiry, and an expiry already past, are
--        refused (hints batch_expiry, expired_date). Kept as a goods received note (GRN-…) without a
--        supplier, so the history and the movements read as before. receive_delivery keeps working;
--        its supplier is now optional.
--   * B  PART OF A PRESCRIPTION. dispense_prescription(request, store?, quantity?): null = what
--        remains (as before); less = part given (medication_request.quantity_given). The bill charges
--        what was given; the line stays at the pharmacy while something remains; the prescriber is
--        told (rx_part_given: given / remaining). rx_not_given closes what remains (its notice says
--        how much was given). pharmacy_queue lines carry quantity, given, remaining and price what
--        remains. A return (return_medicine) gives back the last hand-over and its quantity.
--   * C  THE PHARMACIST TAKES THE PAYMENT OF A WALK-IN SALE. take_counter_payment: also the
--        pharmacist (role) or the pharmacy desk, for counter sales only (take_payment on visits' bills
--        is unchanged). The payment records the pharmacist as the receiver; their cash count
--        (cashier_summary, scope 'mine'; close_cash_day) counts their own payments.
--   * D  ROOM STORES: unchanged (confirm_receipt without lines = everything arrived).
--   * E  ALERTS. stock_alert_check(): below the reorder level (stock_low, once per medicine per day),
--        expiring within stock.expiry_days (stock_expiring, once per batch), expired and still on a
--        shelf (stock_expired, urgent, once per batch per day) and one summary a day (stock_summary),
--        to the manager and the pharmacy. Run by add_stock, dispense_prescription and adjust_stock,
--        and by the web once a day. message_manager(text): a staff_message to the managers.
--   * F  TOTALS. stock_totals(store?): inventory cost, selling value, items, low, expiring, expired.
--        stock_sales gains revenue, cost and margin for the period.
--   * G  THE EXPIRY WINDOW. Setting stock.expiry_days (default 30) for every "expiring soon"
--        (stock_overview, stock_alerts, store_stock, my_stores, the alerts and the totals).
--
-- Errcodes: 42501 not allowed, 22023 bad input (hints batch_expiry, expired_date, store_closed,
-- more_than_remaining), 23505 already done, P0002 not found.

-- ---------------------------------------------------------------- columns and the setting
alter table item add column if not exists kind text not null default 'medicine';
alter table item drop constraint if exists item_kind_ck;
alter table item add constraint item_kind_ck check (kind in ('medicine', 'supply'));

alter table medication_request add column if not exists quantity_given integer not null default 0;
-- what was handed over before this migration: all of it
update medication_request set quantity_given = ceil(quantity)::integer
where given_at is not null and quantity_given = 0;

insert into setting (key, value) values ('stock.expiry_days', '30'::jsonb) on conflict (key) do nothing;

create index if not exists notification_kind_key_idx on notification (kind, (params ->> 'key')) where params ? 'key';

-- ---------------------------------------------------------------- helpers
-- The "expiring soon" window in days (setting stock.expiry_days, default 30).
create or replace function stock_expiry_days()
returns integer
language sql stable security definer set search_path = public
as $$
  select coalesce((
    select case jsonb_typeof(s.value)
             when 'number' then (s.value #>> '{}')::numeric
             when 'object' then nullif(s.value ->> 'days', '')::numeric
           end
    from setting s where s.key = 'stock.expiry_days')::integer, 30)
$$;

-- The pharmacist (role) or the pharmacy desk: takes the money of a walk-in (counter) sale.
create or replace function pharmacy_takes_money()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(may_use_desk('pharmacy'), false)
      or exists (select 1 from profiles p where p.id = auth.uid() and p.active and p.deleted_at is null
                 and p.role = 'pharmacist')
$$;

-- Internal: the cash price of an item (the current cash price list).
create or replace function set_cash_price(p_item_id uuid, p_price numeric)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_list uuid;
begin
  select id into v_list from price_list
  where payer_id is null and deleted_at is null and effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
  order by effective_from desc limit 1;
  if v_list is null then
    insert into price_list (payer_id, name, effective_from) values (null, 'Cash prices', current_date) returning id into v_list;
  end if;
  insert into price_list_item (price_list_id, item_id, price) values (v_list, p_item_id, round(p_price))
  on conflict (price_list_id, item_id) where item_id is not null
  do update set price = excluded.price, deleted_at = null;
end
$$;

-- Internal: a stock notice to the manager and to the pharmacy, once per key (a key carrying the day
-- makes it once a day). Returns how many notices were written.
create or replace function stock_notice(p_kind text, p_key text, p_params jsonb, p_link text, p_urgent boolean default false)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer := 0;
  r record;
begin
  for r in select * from (values ('manager'::role_key, null::station[]), (null::role_key, array['pharmacy'::station]))
           as x(role, stations) loop
    if not exists (select 1 from notification n
                   where n.kind = p_kind and n.params ->> 'key' = p_key
                     and n.recipient_role is not distinct from r.role
                     and n.recipient_stations is not distinct from r.stations) then
      insert into notification (kind, params, link, urgent, recipient_role, recipient_stations, created_by)
      values (p_kind, coalesce(p_params, '{}'::jsonb) || jsonb_build_object('key', p_key), p_link,
              coalesce(p_urgent, false), r.role, r.stations, auth.uid());
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end
$$;

-- ---------------------------------------------------------------- E  alerts
-- Internal: the stock alerts (idempotent). Low: unexpired pharmacy units at or below the reorder
-- level; expiring: a batch on a shelf expiring within the window; expired: a batch past its expiry
-- still on a shelf (every store but "In transit").
create or replace function stock_alert_run()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_days integer := stock_expiry_days();
  v_day text := to_char((now() at time zone 'Africa/Kigali')::date, 'YYYY-MM-DD');
  v_low integer := 0;
  v_expiring integer := 0;
  v_expired integer := 0;
  v_expired_units integer := 0;
  v_created integer := 0;
  r record;
begin
  perform pg_advisory_xact_lock(hashtext('mmc.stock_alert_check'));
  for r in select b.item_id, b.on_hand, b.reorder_level from items_below_reorder b order by b.name_generic loop
    v_low := v_low + 1;
    v_created := v_created + stock_notice('stock_low', 'low:' || r.item_id || ':' || v_day,
      jsonb_build_object('item', item_label(r.item_id), 'itemId', r.item_id, 'onHand', r.on_hand,
                         'level', r.reorder_level),
      '/app/stock?tab=stock&item=' || r.item_id);
  end loop;
  for r in
    select s.batch_id, s.item_id, b.batch_no, s.expiry, sum(s.quantity)::integer as quantity,
           sum(s.quantity * coalesce(b.unit_cost, 0)) as cost
    from stock_on_hand s
    join stock_location l on l.id = s.location_id and l.deleted_at is null and l.type::text <> 'transit'
    join batch b on b.id = s.batch_id
    where s.quantity > 0 and s.expiry is not null and s.expiry <= current_date + v_days
    group by s.batch_id, s.item_id, b.batch_no, s.expiry
    order by s.expiry
  loop
    if r.expiry < current_date then
      v_expired := v_expired + 1;
      v_expired_units := v_expired_units + r.quantity;
      v_created := v_created + stock_notice('stock_expired', 'expired:' || r.batch_id || ':' || v_day,
        jsonb_build_object('item', item_label(r.item_id), 'itemId', r.item_id, 'batchId', r.batch_id,
                           'batchNo', r.batch_no, 'expiry', r.expiry, 'quantity', r.quantity,
                           'value', round(r.cost, 2)),
        '/app/stock?tab=stock&item=' || r.item_id, true);
    else
      v_expiring := v_expiring + 1;
      v_created := v_created + stock_notice('stock_expiring', 'expiring:' || r.batch_id,
        jsonb_build_object('item', item_label(r.item_id), 'itemId', r.item_id, 'batchId', r.batch_id,
                           'batchNo', r.batch_no, 'expiry', r.expiry, 'quantity', r.quantity,
                           'days', r.expiry - current_date),
        '/app/stock?tab=stock&item=' || r.item_id);
    end if;
  end loop;
  if v_low + v_expiring + v_expired > 0 then
    v_created := v_created + stock_notice('stock_summary', 'summary:' || v_day,
      jsonb_build_object('low', v_low, 'expiring', v_expiring, 'expired', v_expired,
                         'expiredUnits', v_expired_units, 'days', v_days, 'day', v_day),
      '/app/stock?tab=stock', v_expired > 0);
  end if;
  return jsonb_build_object('low', v_low, 'expiring', v_expiring, 'expired', v_expired,
                            'expiredUnits', v_expired_units, 'expiryDays', v_days, 'created', v_created);
end
$$;

-- The web runs it once a day (pharmacy home, manager dashboard). Someone who does not see the stock
-- gets zeros (nothing written).
create or replace function stock_alert_check()
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if not (stock_admin() or has_perm('stock.read')) then
    return jsonb_build_object('low', 0, 'expiring', 0, 'expired', 0, 'expiredUnits', 0,
                              'expiryDays', stock_expiry_days(), 'created', 0, 'skipped', true);
  end if;
  return stock_alert_run();
end
$$;

-- A message to the managers (any staff member: 3 to 500 characters, 20 an hour at most).
create or replace function message_manager(p_text text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_me profiles%rowtype;
  v_text text := trim(coalesce(p_text, ''));
begin
  select * into v_me from profiles where id = auth.uid() and active and deleted_at is null;
  if not found then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if length(v_text) < 3 or length(v_text) > 500 then
    raise exception 'write a message of 3 to 500 characters' using errcode = '22023';
  end if;
  if (select count(*) from notification where kind = 'staff_message' and created_by = v_me.id
        and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'too many messages in the last hour: try again later' using errcode = '22023';
  end if;
  insert into notification (kind, params, body, link, recipient_role, created_by)
  values ('staff_message',
          jsonb_build_object('text', v_text, 'from', v_me.full_name, 'fromId', v_me.id, 'role', v_me.role),
          v_text, null, 'manager', v_me.id);
end
$$;

-- ---------------------------------------------------------------- F  totals
-- One store (whoever sees it), else every pharmacy store (the pharmacy) or every store (the
-- manager). Costs only for the pharmacy and the manager. inventory_cost and selling_value count
-- unexpired units; expired units apart.
create or replace function stock_totals(p_location_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_days integer := stock_expiry_days();
  v_admin boolean := stock_admin();
  v_stores uuid[];
  v_room boolean := false;
  v_low integer;
  v_r record;
begin
  if p_location_id is not null then
    if not exists (select 1 from stock_location where id = p_location_id and deleted_at is null
                   and type::text <> 'transit') then
      raise exception 'store not found' using errcode = 'P0002';
    end if;
    if not may_see_store(p_location_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    v_stores := array[p_location_id];
    v_room := is_room_type((select type from stock_location where id = p_location_id));
  elsif is_manager() then
    select coalesce(array_agg(id), '{}'::uuid[]) into v_stores
    from stock_location where deleted_at is null and type::text <> 'transit';
  elsif v_admin then
    select coalesce(array_agg(id), '{}'::uuid[]) into v_stores
    from stock_location where deleted_at is null and type = 'pharmacy';
  else
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_room then
    select count(*)::integer into v_low from store_item_level m
    where m.location_id = p_location_id and usable_stock(m.item_id, p_location_id) < m.min_level;
  else
    select count(*)::integer into v_low from items_below_reorder;
  end if;
  select
    round(coalesce(sum(x.quantity * x.cost) filter (where x.usable), 0), 2) as inventory_cost,
    coalesce(sum(x.quantity * coalesce(x.price, 0)) filter (where x.usable), 0) as selling_value,
    count(distinct x.item_id) filter (where x.usable)::integer as items,
    count(distinct x.batch_id) filter (where x.usable and x.expiry <= current_date + v_days)::integer as expiring,
    coalesce(sum(x.quantity) filter (where x.usable and x.expiry <= current_date + v_days), 0)::integer as expiring_units,
    coalesce(sum(x.quantity) filter (where not x.usable), 0)::integer as expired_units,
    round(coalesce(sum(x.quantity * x.cost) filter (where not x.usable), 0), 2) as expired_cost
  into v_r
  from (
    select s.item_id, s.batch_id, s.quantity, s.expiry, coalesce(b.unit_cost, 0) as cost,
           (s.expiry is null or s.expiry >= current_date) as usable,
           (select pf.price from price_for(null, s.item_id, null) pf) as price
    from stock_on_hand s left join batch b on b.id = s.batch_id
    where s.location_id = any (v_stores) and s.quantity > 0
  ) x;
  return jsonb_build_object(
    'inventory_cost', case when v_admin then v_r.inventory_cost end,
    'selling_value', v_r.selling_value,
    'items', v_r.items,
    'low', v_low,
    'expiring_30', v_r.expiring,
    'expiring_units', v_r.expiring_units,
    'expired_units', v_r.expired_units,
    'expired_cost', case when v_admin then v_r.expired_cost end,
    'expiry_days', v_days,
    'location_id', p_location_id
  );
end
$$;

-- stock_sales (from 20261124090000_stores_and_stock): the same, with the period's revenue, cost of
-- what was sold and margin.
create or replace function stock_sales(p_from date, p_to date)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with sold as (
    select l.item_id, l.quantity::numeric as units, round(l.quantity * l.unit_price) as revenue
    from invoice_line l
    join invoice inv on inv.id = l.invoice_id and inv.status <> 'credited'
    where l.deleted_at is null and l.item_id is not null
      and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    union all
    select x.item_id, x.quantity, x.line_total
    from counter_sale_line x join counter_sale s on s.id = x.sale_id
    where x.deleted_at is null and s.deleted_at is null and s.status = 'handed_over'
      and (s.handed_over_at at time zone 'Africa/Kigali')::date between p_from and p_to
  ), per_item as (
    select i.name_generic || coalesce(' ' || i.strength, '') as name,
           sum(s.units) as units,
           sum(s.revenue) as revenue,
           round(sum(s.units) * coalesce((
             select sum(coalesce(m.unit_cost, b.unit_cost) * m.quantity) / nullif(sum(m.quantity), 0)
             from stock_movement m join batch b on b.id = m.batch_id
             where m.item_id = i.id and m.type = 'receipt' and m.deleted_at is null and b.deleted_at is null), 0), 2) as cost
    from sold s join item i on i.id = s.item_id
    group by i.id, i.name_generic, i.strength
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'item', x.name, 'units', x.units, 'revenue', x.revenue, 'cost', x.cost, 'margin', x.revenue - x.cost
      ) order by x.revenue desc) from per_item x), '[]'::jsonb),
    'revenue', (select coalesce(sum(revenue), 0) from per_item),
    'cost', (select coalesce(sum(cost), 0) from per_item),
    'margin', (select coalesce(sum(revenue - cost), 0) from per_item),
    'counterRevenue', (select coalesce(sum(s.total), 0) from counter_sale s
                       where s.deleted_at is null and s.status = 'handed_over'
                         and (s.handed_over_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'received', (select coalesce(sum(m.quantity * coalesce(m.unit_cost, b.unit_cost, 0)), 0)
                 from stock_movement m left join batch b on b.id = m.batch_id
                 where m.deleted_at is null and m.type = 'receipt' and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'consumed', (select coalesce(sum(m.quantity * coalesce(b.unit_cost, 0)), 0) from stock_movement m left join batch b on b.id = m.batch_id
                 where m.deleted_at is null and m.type = 'consumption' and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    -- everything held, in every store and on the way
    'stockValue', (select coalesce(sum(s.quantity * coalesce(b.unit_cost, 0)), 0) from stock_on_hand s
                   left join batch b on b.id = s.batch_id where s.quantity > 0)
  )
  where has_perm('stock.read') and stock_admin()
$$;

-- ---------------------------------------------------------------- A  add stock
create or replace function add_stock(p_lines jsonb, p_location_id uuid default null, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_main uuid := main_pharmacy();
  v_loc uuid;
  v_id uuid;
  v_number text;
  v_line jsonb;
  v_n integer;
  v_item uuid;
  v_new jsonb;
  v_kind text;
  v_name text;
  v_strength text;
  v_created boolean;
  v_qty numeric;
  v_units integer;
  v_cost numeric;
  v_sell numeric;
  v_price numeric;
  v_expiry date;
  v_batch uuid;
  v_line_cost numeric;
  v_updated boolean;
  v_ignored boolean;
  v_price_right boolean := has_perm('item_price.write') or has_perm('catalogue.write');
  v_out jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_state text;
  v_msg text;
  v_hint text;
begin
  if not stock_manager() then
    perform assert_stock_write();
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_loc := coalesce(p_location_id, v_main);
  if v_loc is null then
    raise exception 'no pharmacy store yet: create one under Stock' using errcode = 'P0002';
  end if;
  if v_loc is distinct from v_main and not is_manager() then
    raise exception 'stock is added into the main pharmacy (another store: the manager)' using errcode = '42501';
  end if;
  if not exists (select 1 from stock_location where id = v_loc and deleted_at is null and type::text <> 'transit') then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'add at least one medicine' using errcode = '22023';
  end if;
  v_number := day_number('GRN', 'goods-receipt');
  insert into goods_receipt (supplier_id, received_on, note, number, reference, delivered_on, location_id, supplier_name)
  values (null, now(), nullif(trim(coalesce(p_note, '')), ''), v_number, null,
          (now() at time zone 'Africa/Kigali')::date, v_loc, null)
  returning id into v_id;

  for v_line, v_n in select x.value, x.ordinality from jsonb_array_elements(p_lines) with ordinality as x loop
    begin
      v_created := false;
      v_updated := false;
      v_ignored := false;
      v_item := nullif(v_line ->> 'item_id', '')::uuid;
      v_new := case when jsonb_typeof(v_line -> 'new_item') = 'object' then v_line -> 'new_item' end;
      v_sell := nullif(v_line ->> 'sell_price', '')::numeric;
      if v_sell is not null and v_sell < 0 then
        raise exception 'the price must be zero or more' using errcode = '22023';
      end if;
      if v_item is null and v_new is not null then
        v_kind := coalesce(nullif(v_new ->> 'kind', ''), 'medicine');
        if v_kind not in ('medicine', 'supply') then
          raise exception 'a new item is a medicine or a supply' using errcode = '22023';
        end if;
        v_name := trim(coalesce(v_new ->> 'name', ''));
        v_strength := nullif(trim(coalesce(v_new ->> 'strength', '')), '');
        if length(v_name) < 2 then
          raise exception 'the medicine needs a name' using errcode = '22023';
        end if;
        -- the same name (and strength) already on the list: that item
        select id into v_item from item
        where deleted_at is null and lower(name_generic) = lower(v_name)
          and lower(coalesce(strength, '')) = lower(coalesce(v_strength, ''))
        order by active desc, created_at
        limit 1;
        if v_item is null then
          insert into item (code, name_generic, strength, form, unit, selling_unit, active, kind)
          values (case when v_kind = 'supply' then 'SUP-' else 'MED-' end
                    || lpad(next_number('item_code', 0)::text, 4, '0'),
                  v_name, v_strength, nullif(trim(coalesce(v_new ->> 'form', '')), ''),
                  nullif(trim(coalesce(v_new ->> 'unit', '')), ''), nullif(trim(coalesce(v_new ->> 'unit', '')), ''),
                  true, v_kind)
          returning id into v_item;
          v_created := true;
        end if;
      end if;
      if v_item is null then
        raise exception 'choose the medicine' using errcode = '22023';
      end if;
      if not exists (select 1 from item where id = v_item and deleted_at is null) then
        raise exception 'medicine not found' using errcode = 'P0002';
      end if;
      v_qty := nullif(v_line ->> 'quantity', '')::numeric;
      if v_qty is null or v_qty <= 0 then
        raise exception 'quantity must be more than zero' using errcode = '22023';
      end if;
      if v_qty <> round(v_qty) then
        raise exception 'the quantity must come to whole units' using errcode = '22023';
      end if;
      v_units := v_qty::integer;
      v_cost := nullif(v_line ->> 'unit_cost', '')::numeric;
      if v_cost is null or v_cost < 0 then
        raise exception 'the cost per unit must be zero or more' using errcode = '22023';
      end if;
      v_expiry := nullif(v_line ->> 'expiry', '')::date;
      -- the selling price: a new item (or one without a price) takes it; a different price needs the right
      if v_sell is not null then
        select pf.price into v_price from price_for(null, v_item, null) pf;
        if v_price is null or v_created then
          perform set_cash_price(v_item, v_sell);
          v_updated := true;
        elsif round(v_sell) <> v_price then
          if v_price_right then
            perform set_cash_price(v_item, v_sell);
            v_updated := true;
          else
            v_ignored := true;
          end if;
        end if;
      end if;
      v_batch := receive_batch(v_item, v_loc, v_units, v_cost, v_line ->> 'batch_no', v_expiry, null, null, v_id);
      v_line_cost := round(round(v_cost, 2) * v_units, 2);
      insert into goods_receipt_line (receipt_id, item_id, batch_id, batch_no, expiry, unit, packs, pack_size, units,
                                      unit_cost, pack_cost, line_cost)
      select v_id, v_item, b.id, b.batch_no, b.expiry, 'unit', v_units, 1, v_units, round(v_cost, 2), null, v_line_cost
      from batch b where b.id = v_batch;
      v_total := v_total + v_line_cost;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'item_id', v_item, 'batch_id', v_batch, 'quantity', v_units, 'line_cost', v_line_cost,
        'created', v_created, 'price_updated', v_updated, 'price_ignored', v_ignored));
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
      raise exception 'line %: %', v_n, v_msg using errcode = v_state, hint = coalesce(nullif(v_hint, ''), 'line');
    end;
  end loop;
  update goods_receipt set total_cost = v_total where id = v_id;
  perform stock_alert_run();
  return jsonb_build_object('lines', v_out, 'total_cost', v_total, 'id', v_id, 'number', v_number, 'location_id', v_loc);
end
$$;

-- receive_delivery (from 20261128090000_switches_enforced): the supplier is optional.
create or replace function receive_delivery(
  p_supplier text, p_reference text, p_lines jsonb, p_delivered_on date default null,
  p_location_id uuid default null, p_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_loc uuid;
  v_sup uuid;
  v_ref text := nullif(trim(coalesce(p_reference, '')), '');
  v_on date := coalesce(p_delivered_on, (now() at time zone 'Africa/Kigali')::date);
  v_id uuid;
  v_number text;
  v_line jsonb;
  v_n integer;
  v_item uuid;
  v_code text;
  v_r medicine_reference%rowtype;
  v_unit text;
  v_qty numeric;
  v_pack integer;
  v_units integer;
  v_cost numeric;
  v_unit_cost numeric;
  v_line_cost numeric;
  v_expiry date;
  v_batch uuid;
  v_total numeric := 0;
  v_all_units integer := 0;
  v_state text;
  v_msg text;
  v_hint text;
begin
  if not stock_manager() then
    perform assert_stock_write();
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_loc := coalesce(p_location_id, main_pharmacy());
  if v_loc is null or not exists (select 1 from stock_location where id = v_loc and type = 'pharmacy' and active
                                  and deleted_at is null) then
    raise exception 'deliveries are received into an open pharmacy store' using errcode = '22023', hint = 'receive_into_pharmacy';
  end if;
  if v_on > (now() at time zone 'Africa/Kigali')::date then
    raise exception 'the delivery date is in the future' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'add at least one medicine' using errcode = '22023';
  end if;
  v_sup := supplier_for(p_supplier);
  if v_ref is not null and exists (select 1 from goods_receipt g where g.supplier_id = v_sup and lower(g.reference) = lower(v_ref)
                                   and g.deleted_at is null) then
    raise exception 'delivery note % of this supplier was already received', v_ref using errcode = '23505', hint = 'duplicate_delivery';
  end if;
  v_number := day_number('GRN', 'goods-receipt');
  insert into goods_receipt (supplier_id, received_on, note, number, reference, delivered_on, location_id, supplier_name)
  values (v_sup, now(), nullif(trim(coalesce(p_note, '')), ''), v_number, v_ref, v_on, v_loc,
          nullif(trim(coalesce(p_supplier, '')), ''))
  returning id into v_id;

  for v_line, v_n in select x.value, x.ordinality from jsonb_array_elements(p_lines) with ordinality as x loop
    begin
      v_item := nullif(v_line ->> 'itemId', '')::uuid;
      v_code := nullif(upper(trim(coalesce(v_line ->> 'refCode', ''))), '');
      if v_item is null and v_code is not null then
        select id into v_item from item where code = v_code and deleted_at is null;
        if v_item is null then
          -- a medicine new at the clinic, from the reference list (RHIA): added with its selling price
          select * into v_r from medicine_reference where code = v_code;
          if not found then
            raise exception 'this medicine is not on the reference list' using errcode = 'P0002';
          end if;
          v_item := upsert_item(null, v_r.generic,
                                coalesce(nullif(v_line ->> 'sellingPrice', '')::numeric, v_r.price),
                                v_r.presentation, null, v_r.unit, true, v_r.code);
        end if;
      end if;
      if v_item is null or not exists (select 1 from item where id = v_item and deleted_at is null) then
        raise exception 'choose the medicine' using errcode = '22023';
      end if;
      v_unit := coalesce(nullif(v_line ->> 'unit', ''), 'unit');
      if v_unit not in ('box', 'unit') then
        raise exception 'count in boxes or in units' using errcode = '22023';
      end if;
      v_qty := nullif(v_line ->> 'quantity', '')::numeric;
      if v_qty is null or v_qty <= 0 then
        raise exception 'quantity must be more than zero' using errcode = '22023';
      end if;
      if v_unit = 'box' then
        v_pack := coalesce(nullif(v_line ->> 'packSize', '')::integer, (select pack_size from item where id = v_item));
        if v_pack is null or v_pack < 1 then
          raise exception 'say how many units are in one box' using errcode = '22023', hint = 'pack_size';
        end if;
        update item set pack_size = v_pack where id = v_item and pack_size is null;
      else
        v_pack := 1;
      end if;
      v_units := round(v_qty * v_pack)::integer;
      if v_units <> v_qty * v_pack or v_units <= 0 then
        raise exception 'the quantity must come to whole units' using errcode = '22023';
      end if;
      v_cost := nullif(v_line ->> 'cost', '')::numeric;
      if v_cost is null or v_cost < 0 then
        raise exception 'the cost must be zero or more' using errcode = '22023';
      end if;
      v_unit_cost := round(v_cost / v_pack, 2);
      v_line_cost := round(v_cost * v_qty, 2);
      v_expiry := nullif(v_line ->> 'expiry', '')::date;
      perform set_cash_price_if_none(v_item, nullif(v_line ->> 'sellingPrice', '')::numeric);
      v_batch := receive_batch(v_item, v_loc, v_units, v_unit_cost, v_line ->> 'batchNo', v_expiry, v_sup,
                               concat_ws(' · ', nullif(trim(coalesce(p_supplier, '')), ''), v_ref, v_number), v_id);
      insert into goods_receipt_line (receipt_id, item_id, batch_id, batch_no, expiry, unit, packs, pack_size, units,
                                      unit_cost, pack_cost, line_cost)
      values (v_id, v_item, v_batch, (select batch_no from batch where id = v_batch), v_expiry, v_unit, v_qty, v_pack,
              v_units, v_unit_cost, case when v_unit = 'box' then v_cost end, v_line_cost);
      v_total := v_total + v_line_cost;
      v_all_units := v_all_units + v_units;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
      raise exception 'line %: %', v_n, v_msg using errcode = v_state, hint = coalesce(nullif(v_hint, ''), 'line');
    end;
  end loop;
  update goods_receipt set total_cost = v_total where id = v_id;
  return jsonb_build_object('id', v_id, 'number', v_number, 'locationId', v_loc,
                            'lines', jsonb_array_length(p_lines), 'units', v_all_units, 'totalCost', v_total);
end
$$;

-- ---------------------------------------------------------------- B  part of a prescription
-- rx_pending (from 20261123090000_dispensing_fixes): waiting while something remains to give.
create or replace function rx_pending(m medication_request)
returns boolean
language sql stable security definer set search_path = public
as $$
  select m.deleted_at is null and m.supply = 'pharmacy' and m.given_at is null and m.not_given_at is null
    and m.cancelled_at is null
    and coalesce(m.quantity_given, 0) < ceil(m.quantity)
    and (coalesce(m.quantity_given, 0) > 0
         or not exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null))
$$;

-- guard_medication_request (from 20261202090000_security_hardening): the quantity given too.
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
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'handing over, not given, cancelling and the medicine or quantity change only through the pharmacy and prescription screens'
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- dispense_prescription (from 20261126090000_departments_decide_desks): a quantity (part given).
drop function if exists dispense_prescription(uuid, uuid);
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

-- rx_not_given (from 20261126090000_departments_decide_desks): closes what remains; the notice says what was given.
create or replace function rx_not_given(p_medication_request_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_item text;
  v_name text;
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
  select i.name_generic || coalesce(' ' || i.strength, '') into v_item from item i where i.id = v_m.item_id;
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
  if coalesce(v_m.prescriber_id, v_m.created_by) is not null
     and coalesce(v_m.prescriber_id, v_m.created_by) is distinct from auth.uid() then
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('rx_not_given', jsonb_build_object('item', v_item, 'name', v_name, 'reason', trim(p_reason),
                                               'given', coalesce(v_m.quantity_given, 0),
                                               'remaining', ceil(v_m.quantity)::integer - coalesce(v_m.quantity_given, 0),
                                               'requestId', v_m.id),
            '/app/visit?encounter=' || v_m.encounter_id, coalesce(v_m.prescriber_id, v_m.created_by), auth.uid());
  end if;
  perform after_pharmacy(v_m.encounter_id);
end
$$;

-- return_medicine (from 20261202090000_security_hardening): the quantity of the hand-over taken back.
create or replace function return_medicine(p_medication_request_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_d medication_dispense%rowtype;
  v_inv invoice%rowtype;
  v_mv record;
  v_back integer := 0;
  v_patient numeric := 0;
  v_insurer numeric := 0;
  v_total numeric := 0;
  v_lines jsonb;
  v_cn uuid;
  v_year integer := extract(year from now())::integer;
  v_balance numeric;
  v_name text;
  v_item text;
begin
  perform assert_desk(array['pharmacy'], 'the pharmacy');
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the medicine comes back' using errcode = '22023';
  end if;
  select * into v_m from medication_request where id = p_medication_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  select * into v_d from medication_dispense
  where medication_request_id = v_m.id and deleted_at is null order by created_at desc limit 1;
  if not found then
    raise exception 'this medicine was not handed over by the pharmacy' using errcode = 'P0002';
  end if;
  if not is_manager()
     and (v_d.created_at at time zone 'Africa/Kigali')::date <> (now() at time zone 'Africa/Kigali')::date then
    raise exception 'a hand-over of another day is undone by the manager' using errcode = '42501';
  end if;
  select * into v_inv from invoice where encounter_id = v_m.encounter_id;
  -- On a posted bill the return is money (a credit note, a smaller insurer claim): the person's
  -- own right, which a department or cover never gives.
  if v_inv.id is not null and v_inv.status <> 'draft'
     and not (is_manager() or staff_perm(auth.uid(), 'stock.dispense') or has_perm('billing.write')) then
    raise exception 'a medicine on a posted bill is taken back by the pharmacist or the manager'
      using errcode = '42501';
  end if;
  -- the units go back where they came from
  for v_mv in
    select item_id, batch_id, from_location_id, quantity from stock_movement
    where dispense_id = v_d.id and type = 'dispense' and deleted_at is null
  loop
    insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason, dispense_id, medication_request_id)
    values (v_mv.item_id, v_mv.batch_id, v_mv.from_location_id, v_mv.quantity, 'return', trim(p_reason), v_d.id, v_m.id);
    v_back := v_back + v_mv.quantity;
  end loop;
  update medication_dispense set deleted_at = now() where id = v_d.id;

  if v_inv.id is null or v_inv.status = 'draft' then
    -- the bill is still open: the line leaves it, and the medicine waits at the pharmacy again
    update invoice_line set deleted_at = now(),
           manual_reason = coalesce(manual_reason || ' · ', '') || 'returned: ' || trim(p_reason)
    where source_type = 'medication_dispense' and source_id = v_d.id and deleted_at is null;
    if v_inv.id is not null then
      perform recompute_invoice(v_inv.id);
    end if;
    update medication_request
    set given_at = null, given_by = null, quantity_given = greatest(0, coalesce(quantity_given, 0) - v_d.quantity)
    where id = v_m.id;
    if exists (select 1 from encounter where id = v_m.encounter_id and status = 'open')
       and not exists (select 1 from queue_entry where encounter_id = v_m.encounter_id and station = 'pharmacy'
                       and finished_at is null and deleted_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no)
      values (v_m.encounter_id, 'pharmacy',
              (select ticket_no from queue_entry where encounter_id = v_m.encounter_id order by created_at limit 1));
    end if;
    v_balance := case when v_inv.id is not null then invoice_balance(v_inv.id) else 0 end;
    if v_balance < 0 then
      -- the bill was already paid: money to give back, the cashier is told
      select p.surname || ' ' || p.given_names into v_name
      from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
      select i.name_generic || coalesce(' ' || i.strength, '') into v_item from item i where i.id = v_m.item_id;
      insert into notification (kind, params, link, recipient_stations, created_by)
      values ('refund_due', jsonb_build_object('name', v_name, 'item', v_item, 'amount', -v_balance,
                                               'reason', trim(p_reason)),
              '/app/visit?encounter=' || v_m.encounter_id, array['cashier'::station], auth.uid());
    end if;
    return jsonb_build_object('units', v_back, 'mode', 'bill', 'creditNoteId', null, 'credit', 0,
                              'balance', v_balance);
  end if;

  -- The bill is posted: its lines never change. A credit note gives the line back: the patient's
  -- share lowers what they owe (or is money to give back at the cashier); the insurer's share
  -- leaves an open claim.
  select coalesce(sum(l.patient_share), 0), coalesce(sum(l.insurer_share), 0),
         coalesce(sum(round(l.unit_price * l.quantity)), 0),
         coalesce(jsonb_agg(jsonb_build_object('lineId', l.id, 'description', l.description, 'quantity', l.quantity,
                                               'unitPrice', l.unit_price, 'patientShare', l.patient_share,
                                               'insurerShare', l.insurer_share)), '[]'::jsonb)
  into v_patient, v_insurer, v_total, v_lines
  from invoice_line l
  where l.invoice_id = v_inv.id and l.source_type = 'medication_dispense' and l.source_id = v_d.id
    and l.deleted_at is null;
  if v_total > 0 then
    insert into credit_note (invoice_id, number, lines, total, reason, approver_id, patient_amount, insurer_amount,
                             source_type, source_id)
    values (v_inv.id, 'CN-' || v_year || '-' || lpad(next_number('credit_note', v_year)::text, 6, '0'),
            v_lines, v_total, 'returned: ' || trim(p_reason), auth.uid(), v_patient, v_insurer,
            'medication_dispense', v_d.id)
    returning id into v_cn;
    if v_insurer > 0 then
      update claim set amount = greatest(0, amount - v_insurer)
      where invoice_id = v_inv.id and status = 'open' and batch_id is null;
    end if;
  end if;
  -- the line is done: returned (it does not wait at the pharmacy again)
  update medication_request
  set given_at = null, given_by = null, quantity_given = greatest(0, coalesce(quantity_given, 0) - v_d.quantity),
      not_given_at = now(), not_given_by = auth.uid(),
      not_given_reason = 'returned: ' || trim(p_reason)
  where id = v_m.id;
  v_balance := invoice_balance(v_inv.id);
  if v_balance < 0 then
    -- money to give back: the cashier is told
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
    select i.name_generic || coalesce(' ' || i.strength, '') into v_item from item i where i.id = v_m.item_id;
    insert into notification (kind, params, link, recipient_stations, created_by)
    values ('refund_due', jsonb_build_object('name', v_name, 'item', v_item, 'amount', -v_balance,
                                             'reason', trim(p_reason)),
            '/app/visit?encounter=' || v_m.encounter_id, array['cashier'::station], auth.uid());
  end if;
  return jsonb_build_object('units', v_back, 'mode', 'credit', 'creditNoteId', v_cn, 'credit', v_patient,
                            'balance', v_balance);
end
$$;

-- pharmacy_queue (from 20261126090000_departments_decide_desks): quantity, given, remaining; priced on what remains.
create or replace function pharmacy_queue(p_location_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_loc uuid;
  v_stores jsonb;
  v_lines jsonb;
  v_patients jsonb;
begin
  -- the pharmacy and the manager only: the list carries allergies, prescriptions and bill amounts
  if not (may_use_desk('pharmacy') or is_manager()) then
    return jsonb_build_object('locationId', null, 'stores', '[]'::jsonb, 'lines', '[]'::jsonb, 'patients', '[]'::jsonb);
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

  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'isMain', l.id = main_pharmacy())
                            order by (l.id = main_pharmacy()) desc, l.created_at), '[]'::jsonb)
  into v_stores
  from stock_location l where l.type = 'pharmacy' and l.active and l.deleted_at is null;

  with lines as (
    select m.id, m.encounter_id, m.created_at, p.id as patient_id,
           p.surname || ' ' || p.given_names as patient, p.file_number, p.sex, p.birth_date, p.allergies,
           (select q.ticket_no from queue_entry q where q.encounter_id = m.encounter_id order by q.created_at limit 1) as ticket,
           m.item_id, i.name_generic || coalesce(' ' || i.strength, '') as item, i.selling_unit,
           i.prescribing_rule, m.quantity, m.quantity_given, m.dose, m.frequency, m.duration_days, m.instructions,
           pr.id as prescriber_id, pr.full_name as prescriber, pr.specialty,
           py.name as payer, cp.price as cash_price, pp.price as payer_price, pp.fallback,
           cov.pct,
           round(round(pp.price) * greatest(m.quantity - m.quantity_given, 0)) as line_total,
           doctor_holds(m.encounter_id) as holds
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open'
    join patient p on p.id = e.patient_id
    join item i on i.id = m.item_id
    left join invoice inv on inv.encounter_id = e.id
    left join payer py on py.id = inv.payer_id
    left join profiles pr on pr.id = coalesce(m.prescriber_id, m.created_by)
    left join lateral (select pf.price from price_for(null, m.item_id, null) pf) cp on true
    left join lateral (select pf.price, pf.fallback from price_for(null, m.item_id, inv.payer_id) pf) pp on true
    left join lateral (select coalesce(coverage_pct_for((select c.plan_id from coverage c where c.id = inv.coverage_id),
                                                        'pharmacy'::service_group), 0) as pct) cov on true
    where rx_pending(m)
  ), priced as (
    select l.*, round(coalesce(l.line_total, 0) * l.pct / 100) as insurer_share
    from lines l
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'requestId', x.id, 'encounterId', x.encounter_id, 'patientId', x.patient_id, 'patient', x.patient,
      'file', x.file_number, 'ticket', x.ticket,
      'itemId', x.item_id, 'item', x.item, 'unit', x.selling_unit,
      'quantity', x.quantity, 'given', x.quantity_given,
      'remaining', ceil(x.quantity)::integer - x.quantity_given, 'dose', x.dose, 'frequency', x.frequency, 'days', x.duration_days,
      'instructions', x.instructions, 'prescriber', x.prescriber, 'prescriberId', x.prescriber_id, 'at', x.created_at,
      -- the cash price (as before) and what the bill will say
      'price', x.cash_price, 'cashPrice', x.cash_price, 'payerPrice', x.payer_price,
      'priced', x.payer_price is not null, 'payer', x.payer, 'coveragePct', x.pct,
      'lineTotal', coalesce(x.line_total, 0), 'insurerShare', x.insurer_share,
      'patientShare', coalesce(x.line_total, 0) - x.insurer_share,
      -- the stock of the store chosen at the desk
      'locationId', v_loc, 'pharmacyLocationId', v_loc,
      'onHandPharmacy', case when v_loc is null then 0 else usable_stock(x.item_id, v_loc) end,
      'expiredInPharmacy', (select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s
                            where s.item_id = x.item_id and s.location_id = v_loc and s.quantity > 0
                              and s.expiry < current_date),
      'onHandElsewhere', (select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s
                          join stock_location l on l.id = s.location_id
                          where s.item_id = x.item_id and l.id is distinct from v_loc and l.active and l.deleted_at is null
                            and s.quantity > 0 and (s.expiry is null or s.expiry >= current_date)),
      'doctorHolds', x.holds,
      -- the pharmacist's check
      'sex', x.sex, 'birthDate', x.birth_date,
      'ageYears', case when x.birth_date is not null then extract(year from age(current_date, x.birth_date))::integer end,
      'allergies', x.allergies,
      'prescribingRule', x.prescribing_rule, 'prescriberSpecialty', x.specialty,
      'ruleOk', rx_rule_ok(x.prescribing_rule, x.specialty)
    ) order by x.created_at), '[]'::jsonb)
  into v_lines
  from priced x;

  with lines as (
    select m.encounter_id, min(m.created_at) as first_at, count(*)::integer as n,
           sum(round(round(coalesce(pp.price, 0)) * greatest(m.quantity - m.quantity_given, 0))) as total,
           sum(round(round(round(coalesce(pp.price, 0)) * greatest(m.quantity - m.quantity_given, 0)) * cov.pct / 100)) as insurer
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open'
    left join invoice inv on inv.encounter_id = e.id
    left join lateral (select pf.price from price_for(null, m.item_id, inv.payer_id) pf) pp on true
    left join lateral (select coalesce(coverage_pct_for((select c.plan_id from coverage c where c.id = inv.coverage_id),
                                                        'pharmacy'::service_group), 0) as pct) cov on true
    where rx_pending(m)
    group by m.encounter_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'encounterId', l.encounter_id, 'patientId', p.id, 'patient', p.surname || ' ' || p.given_names,
      'file', p.file_number,
      'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = l.encounter_id order by q.created_at limit 1),
      'sex', p.sex, 'birthDate', p.birth_date,
      'ageYears', case when p.birth_date is not null then extract(year from age(current_date, p.birth_date))::integer end,
      'ageMonths', case when p.birth_date is not null
                        then (extract(year from age(current_date, p.birth_date)) * 12
                              + extract(month from age(current_date, p.birth_date)))::integer end,
      'allergies', p.allergies, 'payer', py.name,
      'lines', l.n, 'total', l.total, 'insurerShare', l.insurer, 'patientShare', l.total - l.insurer,
      'balance', invoice_balance(inv.id),
      'doctorHolds', doctor_holds(l.encounter_id)
    ) order by l.first_at), '[]'::jsonb)
  into v_patients
  from lines l
  join encounter e on e.id = l.encounter_id
  join patient p on p.id = e.patient_id
  left join invoice inv on inv.encounter_id = e.id
  left join payer py on py.id = inv.payer_id;

  return jsonb_build_object('locationId', v_loc, 'stores', v_stores, 'lines', v_lines, 'patients', v_patients);
end
$$;

-- ---------------------------------------------------------------- C  the pharmacist takes walk-in payments
-- take_counter_payment (from 20261124090000_stores_and_stock): also the pharmacist (role) or the pharmacy desk, for counter sales; taken at the pharmacy, no notice to it.
create or replace function take_counter_payment(
  p_sale_id uuid, p_method payment_method, p_reference text default null, p_payer_phone text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_s counter_sale%rowtype;
  v_year integer := extract(year from now())::integer;
  v_pay uuid;
  v_receipt text;
  v_short text;
begin
  if not (has_perm('payment.take') or pharmacy_takes_money()) then
    raise exception 'you may not take payments (the manager has not allowed it)' using errcode = '42501';
  end if;
  select * into v_s from counter_sale where id = p_sale_id and deleted_at is null for update;
  if not found then
    raise exception 'sale not found' using errcode = 'P0002';
  end if;
  if v_s.status = 'cancelled' then
    raise exception 'this sale was cancelled' using errcode = 'P0002';
  end if;
  if v_s.status <> 'open' then
    raise exception 'this sale is already paid' using errcode = '23505';
  end if;
  if p_method not in ('cash', 'momo', 'airtel', 'card', 'bank') then
    raise exception 'a counter sale is paid in cash, mobile money, card or bank' using errcode = '22023';
  end if;
  if p_method in ('momo', 'airtel', 'card', 'bank') and nullif(trim(coalesce(p_reference, '')), '') is null then
    raise exception 'a transaction reference is required for %', p_method using errcode = '22023';
  end if;
  -- no money for medicines no longer on the shelf
  select string_agg(item_label(l.item_id), ', ') into v_short
  from counter_sale_line l
  where l.sale_id = v_s.id and l.deleted_at is null and usable_stock(l.item_id, v_s.location_id) < l.quantity;
  if v_short is not null then
    raise exception 'no longer enough in the pharmacy: %', v_short using errcode = '23514', hint = 'short';
  end if;
  if v_s.total > 0 then
    insert into payment (invoice_id, counter_sale_id, method, amount, reference, payer_phone, receipt_no)
    values (null, v_s.id, p_method, v_s.total, nullif(trim(coalesce(p_reference, '')), ''),
            nullif(trim(coalesce(p_payer_phone, '')), ''),
            'RCT-' || v_year || '-' || lpad(next_number('receipt', v_year)::text, 6, '0'))
    returning id, receipt_no into v_pay, v_receipt;
  end if;
  -- the units are the buyer's from now on: they leave the shelf's balance at once, so a hand-over,
  -- another sale or a transfer note cannot take them before the buyer collects
  perform counter_sale_take(v_s.id);
  update counter_sale set status = 'paid', paid_at = now(), payment_id = v_pay where id = v_s.id;
  if not pharmacy_takes_money() then
  insert into notification (kind, params, link, recipient_stations, created_by)
  values ('counter_sale_paid', jsonb_build_object('number', v_s.number, 'amount', v_s.total, 'buyer', v_s.buyer_name,
                                                  'saleId', v_s.id),
          '/app/stock?tab=pharmacy&sale=' || v_s.id, array['pharmacy'::station], auth.uid());
  end if;
  return jsonb_build_object('id', v_s.id, 'number', v_s.number, 'status', 'paid', 'amount', v_s.total,
                            'receipt', v_receipt, 'paymentId', v_pay);
end
$$;

-- close_cash_day (from 20261128090000_switches_enforced): the pharmacist counts the walk-in payments they took.
create or replace function close_cash_day(p_day date, p_counted jsonb, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_day date := coalesce(p_day, (now() at time zone 'Africa/Kigali')::date);
  v_expected jsonb;
  v_counted jsonb := '{}'::jsonb;
  v_variance numeric;
  v_id uuid;
  v_key text;
  v_val text;
begin
  if not (is_manager() or has_perm('payment.take') or pharmacy_takes_money()
          or exists (select 1 from payment where cashier_id = auth.uid() and deleted_at is null
                     and (paid_at at time zone 'Africa/Kigali')::date = v_day)
          or exists (select 1 from refund where cashier_id = auth.uid() and deleted_at is null
                     and (refunded_at at time zone 'Africa/Kigali')::date = v_day)) then
    raise exception 'you may not take payments (the manager has not allowed it)' using errcode = '42501', hint = 'not_permitted';
  end if;
  select coalesce(jsonb_object_agg(n.method, n.amount), '{}'::jsonb) into v_expected
  from (select m.method, sum(m.amount) as amount from (
          select method::text as method, amount from payment
          where deleted_at is null and cashier_id = auth.uid() and (paid_at at time zone 'Africa/Kigali')::date = v_day
          union all
          select method::text, -amount from refund
          where deleted_at is null and cashier_id = auth.uid() and (refunded_at at time zone 'Africa/Kigali')::date = v_day
        ) m group by m.method) n;
  for v_key, v_val in select key, value from jsonb_each_text(coalesce(p_counted, '{}'::jsonb)) loop
    if v_key in ('cash', 'momo', 'airtel', 'card', 'bank') and v_val ~ '^[0-9]+$' then
      v_counted := v_counted || jsonb_build_object(v_key, v_val::numeric);
    end if;
  end loop;
  v_variance := coalesce((select sum(value::numeric) from jsonb_each_text(v_counted)), 0)
              - coalesce((select sum(value::numeric) from jsonb_each_text(v_expected)), 0);
  insert into day_close (date, cashier_id, expected, counted, variance, note)
  values (v_day, auth.uid(), v_expected, v_counted, v_variance, nullif(trim(coalesce(p_note, '')), ''))
  on conflict (date, cashier_id) do update
  set expected = excluded.expected, counted = excluded.counted, variance = excluded.variance,
      note = excluded.note, updated_at = now()
  returning id into v_id;
  update payment set day_close_id = v_id
  where deleted_at is null and cashier_id = auth.uid() and (paid_at at time zone 'Africa/Kigali')::date = v_day;
  return jsonb_build_object('id', v_id, 'expected', v_expected, 'counted', v_counted, 'variance', v_variance);
end
$$;

-- cashier_summary (from 20261128090000_switches_enforced): the pharmacist sees their own payments and cash count, and the walk-in sales waiting to be paid.
create or replace function cashier_summary(p_day date default null, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, p_day, v_today);
  v_to date := coalesce(p_to, p_day, p_from, v_today);
  v_day date;
  v_len integer;
  v_me uuid := auth.uid();
  v_all boolean := has_perm('billing.read');
  v_take boolean := has_perm('payment.take');
  v_pharm boolean := pharmacy_takes_money();
begin
  if not (v_all or v_take or v_pharm
          or exists (select 1 from payment where cashier_id = v_me and deleted_at is null and day_close_id is null)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  v_day := coalesce(p_day, v_to);
  v_len := v_to - v_from + 1;
  return jsonb_build_object(
    'day', v_day,
    'from', v_from,
    'to', v_to,
    'scope', case when v_all then 'desk' else 'mine' end,
    'total', (select coalesce(sum(amount), 0) from payment
              where deleted_at is null and (v_all or cashier_id = v_me)
                and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'count', (select count(*) from payment
              where deleted_at is null and (v_all or cashier_id = v_me)
                and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'previousTotal', (select coalesce(sum(amount), 0) from payment
                      where deleted_at is null and (v_all or cashier_id = v_me)
                        and (paid_at at time zone 'Africa/Kigali')::date between v_from - v_len and v_from - 1
                        and (v_to <> v_today or paid_at <= now() - make_interval(days => v_len))),
    'served', case when v_all then
                (select count(distinct q.encounter_id) from queue_entry q
                 where q.deleted_at is null and q.station = 'cashier' and q.finished_at is not null
                   and (q.finished_at at time zone 'Africa/Kigali')::date between v_from and v_to)
              else
                (select count(distinct coalesce(i.encounter_id, pa.counter_sale_id)) from payment pa
                 left join invoice i on i.id = pa.invoice_id
                 where pa.deleted_at is null and pa.cashier_id = v_me
                   and (pa.paid_at at time zone 'Africa/Kigali')::date between v_from and v_to)
              end,
    'refunded', (select coalesce(sum(amount), 0) from refund
                 where deleted_at is null and (v_all or cashier_id = v_me)
                   and (refunded_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'refunds', coalesce((
      select jsonb_agg(x.j order by x.at desc) from (
        select r.refunded_at as at, jsonb_build_object(
            'id', r.id, 'at', r.refunded_at, 'method', r.method, 'amount', r.amount, 'reference', r.reference,
            'reason', r.reason, 'patient', p.surname || ' ' || p.given_names,
            'cashier', (select full_name from profiles where id = r.cashier_id), 'mine', r.cashier_id = v_me
          ) as j
        from refund r
        join invoice i on i.id = r.invoice_id
        join encounter e on e.id = i.encounter_id
        join patient p on p.id = e.patient_id
        where r.deleted_at is null and (v_all or r.cashier_id = v_me)
          and (r.refunded_at at time zone 'Africa/Kigali')::date between v_from and v_to
        order by r.refunded_at desc limit 500) x
    ), '[]'::jsonb),
    'debts', case when v_all or v_take then
               (select count(*) from invoice i join encounter e on e.id = i.encounter_id
                where i.deleted_at is null and e.status <> 'open' and invoice_balance(i.id) > 0)
             else 0 end,
    'debtsDue', case when v_all or v_take then
                  (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id
                   where i.deleted_at is null and e.status <> 'open' and invoice_balance(i.id) > 0)
                else 0 end,
    'mine', (select coalesce(sum(amount), 0) from payment
             where deleted_at is null and cashier_id = v_me
               and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'byMethod', coalesce((
      select jsonb_agg(jsonb_build_object('method', m.method, 'amount', m.amount, 'count', m.n) order by m.amount desc)
      from (select method::text as method, sum(amount) as amount, count(*) as n from payment
            where deleted_at is null and (v_all or cashier_id = v_me)
              and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
            group by method) m
    ), '[]'::jsonb),
    'byCashier', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.name, 'amount', c.amount, 'count', c.n) order by c.amount desc)
      from (select coalesce(pr.full_name, '—') as name, sum(pa.amount) as amount, count(*) as n
            from payment pa left join profiles pr on pr.id = pa.cashier_id
            where pa.deleted_at is null and (v_all or pa.cashier_id = v_me)
              and (pa.paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
            group by pr.full_name) c
    ), '[]'::jsonb),
    -- the payments of the period: visits' bills and counter sales
    'payments', coalesce((
      select jsonb_agg(x.j order by x.at desc) from (
        select pa.paid_at as at, jsonb_build_object(
            'id', pa.id, 'at', pa.paid_at, 'method', pa.method, 'amount', pa.amount, 'reference', pa.reference,
            'invoice', i.number, 'encounterId', i.encounter_id,
            'patient', coalesce(p.surname || ' ' || p.given_names, cs.buyer_name),
            'fileNumber', p.file_number,
            'counterSaleId', cs.id, 'counterSale', cs.number,
            'cashier', pr.full_name, 'receipt', pa.receipt_no,
            'mine', pa.cashier_id = v_me, 'counted', pa.day_close_id is not null
          ) as j
        from payment pa
        left join invoice i on i.id = pa.invoice_id
        left join encounter e on e.id = i.encounter_id
        left join patient p on p.id = e.patient_id
        left join counter_sale cs on cs.id = pa.counter_sale_id
        left join profiles pr on pr.id = pa.cashier_id
        where pa.deleted_at is null and (v_all or pa.cashier_id = v_me)
          and (pa.paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
        order by pa.paid_at desc limit 500) x
    ), '[]'::jsonb),
    'voided', coalesce((
      select jsonb_agg(x.j order by x.at desc) from (
        select pa.voided_at as at, jsonb_build_object(
            'id', pa.id, 'at', pa.paid_at, 'method', pa.method, 'amount', pa.amount, 'receipt', pa.receipt_no,
            'patient', coalesce(p.surname || ' ' || p.given_names, cs.buyer_name),
            'counterSale', cs.number, 'reason', pa.void_reason,
            'by', (select full_name from profiles where id = pa.voided_by), 'voidedAt', pa.voided_at
          ) as j
        from payment pa
        left join invoice i on i.id = pa.invoice_id
        left join encounter e on e.id = i.encounter_id
        left join patient p on p.id = e.patient_id
        left join counter_sale cs on cs.id = pa.counter_sale_id
        where pa.deleted_at is not null and pa.voided_at is not null and (v_all or pa.cashier_id = v_me)
          and (pa.paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
        order by pa.voided_at desc limit 500) x
    ), '[]'::jsonb),
    'closes', coalesce((
      select jsonb_agg(jsonb_build_object(
          'cashier', pr.full_name, 'mine', d.cashier_id = v_me, 'expected', d.expected,
          'counted', d.counted, 'variance', d.variance, 'note', d.note, 'at', d.updated_at
        ) order by pr.full_name)
      from day_close d left join profiles pr on pr.id = d.cashier_id
      where d.deleted_at is null and d.date = v_day and (v_all or d.cashier_id = v_me)
    ), '[]'::jsonb),
    'myExpected', coalesce((
      select jsonb_object_agg(n.method, n.amount) from (select m.method, sum(m.amount) as amount from (
          select method::text as method, amount from payment
          where deleted_at is null and cashier_id = v_me and (paid_at at time zone 'Africa/Kigali')::date = v_day
          union all
          select method::text, -amount from refund
          where deleted_at is null and cashier_id = v_me and (refunded_at at time zone 'Africa/Kigali')::date = v_day
        ) m group by m.method) n
    ), '{}'::jsonb),
    'openBills', case when v_all or v_take then
                   (select count(*) from invoice i join encounter e on e.id = i.encounter_id
                    where i.deleted_at is null and i.status = 'draft' and e.status = 'open' and invoice_balance(i.id) > 0)
                 else 0 end,
    'openDue', case when v_all or v_take then
                 (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id
                  where i.deleted_at is null and i.status = 'draft' and e.status = 'open' and invoice_balance(i.id) > 0)
               else 0 end,
    -- counter sales (walk-in buyers): paid in the period, and those waiting to pay now
    'counterSales', jsonb_build_object(
      'count', (select count(*) from payment where deleted_at is null and counter_sale_id is not null
                and (v_all or cashier_id = v_me)
                and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to),
      'total', (select coalesce(sum(amount), 0) from payment where deleted_at is null and counter_sale_id is not null
                and (v_all or cashier_id = v_me)
                and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to)),
    'counterToPay', case when v_all or v_take or v_pharm then coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', s.id, 'number', s.number, 'buyer', s.buyer_name, 'phone', s.buyer_phone, 'total', s.total,
          'at', s.created_at, 'by', (select full_name from profiles where id = s.created_by),
          'lines', (select count(*) from counter_sale_line x where x.sale_id = s.id and x.deleted_at is null)
        ) order by s.created_at)
      from counter_sale s where s.deleted_at is null and s.status = 'open'
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end
$$;

-- ---------------------------------------------------------------- E  write-offs run the alerts
-- adjust_stock (from 20261128090000_switches_enforced): a count or a write-off runs the stock alerts.
create or replace function adjust_stock(p_item_id uuid, p_location_id uuid, p_counted integer, p_reason text)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_on_hand integer;
  v_diff integer;
  v_remaining integer;
  v_row record;
  v_take integer;
  v_batch uuid;
  v_l stock_location%rowtype;
begin
  v_l := assert_store_work(p_location_id);
  if p_counted is null or p_counted < 0 then
    raise exception 'the count must be zero or more' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the count changes' using errcode = '22023';
  end if;
  perform lock_stock(p_item_id, p_location_id);
  select coalesce(sum(quantity), 0)::integer into v_on_hand
  from stock_on_hand where item_id = p_item_id and location_id = p_location_id;
  v_diff := p_counted - v_on_hand;
  -- a room store is supplied only by the pharmacy's transfer notes: its holders do not count it up
  if is_room_type(v_l.type) and v_diff > 0 and not stock_manager() then
    raise exception 'more on the shelf than the system says: ask the pharmacy to send it with a transfer note'
      using errcode = '22023', hint = 'use_transfer_note';
  end if;
  if v_diff < 0 then
    v_remaining := -v_diff;
    for v_row in
      select s.batch_id, s.quantity from stock_on_hand s
      where s.item_id = p_item_id and s.location_id = p_location_id and s.quantity > 0
      order by s.expiry asc nulls last
    loop
      exit when v_remaining <= 0;
      v_take := least(v_row.quantity, v_remaining);
      insert into stock_movement (item_id, batch_id, from_location_id, quantity, type, reason)
      values (p_item_id, v_row.batch_id, p_location_id, v_take, 'adjustment', 'count: ' || trim(p_reason));
      v_remaining := v_remaining - v_take;
    end loop;
    if is_room_type(v_l.type) then
      perform notify_room_loss(p_item_id, v_l, -v_diff, 'count: ' || trim(p_reason));
    end if;
  elsif v_diff > 0 then
    -- more on the shelf: the latest batch this store has held, else the medicine's latest batch
    select b.id into v_batch from batch b
    where b.item_id = p_item_id and b.deleted_at is null
    order by exists (select 1 from stock_movement m where m.batch_id = b.id and m.to_location_id = p_location_id
                     and m.deleted_at is null) desc,
             b.received_on desc
    limit 1;
    if v_batch is null then
      raise exception 'no batch of this item yet: receive it instead' using errcode = 'P0002';
    end if;
    insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason)
    values (p_item_id, v_batch, p_location_id, v_diff, 'adjustment', 'count: ' || trim(p_reason));
  end if;
  perform stock_alert_run();
  return v_diff;
end
$$;

-- ---------------------------------------------------------------- G  the expiry window
-- stock_overview (from 20261124090000_stores_and_stock): expiring within stock.expiry_days; the item kind.
create or replace function stock_overview()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_admin boolean := stock_admin();
  v_vis uuid[] := visible_stores();
  v_main uuid := main_pharmacy();
  v_transit uuid := (select id from stock_location where type::text = 'transit' and deleted_at is null limit 1);
  v_locations jsonb;
  v_days integer := stock_expiry_days();
  v_items jsonb;
begin
  if not (v_admin or has_perm('stock.read') or cardinality(v_vis) > 0) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.name, 'type', l.type, 'department', d.name, 'active', l.active,
      'isMain', l.id = v_main, 'isRoom', is_room_type(l.type), 'held', holds_store(auth.uid(), l.id),
      'holders', store_holders(l.id)
    ) order by l.active desc, l.type, l.name), '[]'::jsonb)
  into v_locations
  from stock_location l left join department d on d.id = l.department_id
  where l.deleted_at is null and l.type::text <> 'transit' and (v_vis is null or l.id = any (v_vis));

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'code', i.code, 'name', i.name_generic, 'strength', i.strength, 'unit', i.selling_unit,
      'packSize', i.pack_size,
      'sellingPrice', (select pf.price from price_for(null, i.id, null) pf),
      'reorderLevel', i.reorder_level, 'maxLevel', i.max_level,
      'onHand', coalesce(t.on_hand, 0),
      'usable', coalesce(t.usable, 0),
      'costValue', case when v_admin then coalesce(t.cost_value, 0) end,
      'avgCost', case when v_admin and coalesce(t.on_hand, 0) > 0 then round(t.cost_value / t.on_hand, 2) end,
      'byLocation', coalesce(t.by_location, '{}'::jsonb),
      'byLocationUsable', coalesce(t.by_location_usable, '{}'::jsonb),
      'earliestExpiry', t.earliest_expiry,
      'nextExpiry', t.next_expiry,
      'expiredUnits', coalesce(t.expired, 0),
      'expiringUnits', coalesce(t.expiring, 0),
      'inTransit', case when v_admin then coalesce(t.in_transit, 0) end,
      'pharmacyUsable', case when v_admin then coalesce(t.pharmacy_usable, 0) end,
      'low', i.reorder_level > 0 and coalesce(t.pharmacy_usable, 0) <= i.reorder_level,
      'active', i.active, 'kind', i.kind
    ) order by i.name_generic), '[]'::jsonb)
  into v_items
  from item i
  left join lateral (
    select sum(s.quantity)::integer as on_hand,
           sum(s.quantity) filter (where s.expiry is null or s.expiry >= current_date)::integer as usable,
           sum(s.quantity * coalesce(b.unit_cost, 0)) as cost_value,
           min(s.expiry) filter (where s.quantity > 0) as earliest_expiry,
           min(s.expiry) filter (where s.quantity > 0 and s.expiry >= current_date) as next_expiry,
           sum(s.quantity) filter (where s.quantity > 0 and s.expiry < current_date)::integer as expired,
           sum(s.quantity) filter (where s.quantity > 0 and s.expiry between current_date and current_date + v_days)::integer as expiring,
           (select jsonb_object_agg(x.location_id::text, x.q) from (
              select s2.location_id, sum(s2.quantity)::integer as q from stock_on_hand s2
              where s2.item_id = i.id and s2.location_id is distinct from v_transit
                and (v_vis is null or s2.location_id = any (v_vis))
              group by s2.location_id having sum(s2.quantity) <> 0) x) as by_location,
           (select jsonb_object_agg(x.location_id::text, x.q) from (
              select s2.location_id, sum(s2.quantity)::integer as q from stock_on_hand s2
              where s2.item_id = i.id and s2.location_id is distinct from v_transit
                and (v_vis is null or s2.location_id = any (v_vis))
                and (s2.expiry is null or s2.expiry >= current_date)
              group by s2.location_id having sum(s2.quantity) <> 0) x) as by_location_usable,
           (select coalesce(sum(s3.quantity), 0)::integer from stock_on_hand s3
             where s3.item_id = i.id and s3.location_id = v_transit) as in_transit,
           (select coalesce(sum(s4.quantity), 0)::integer from stock_on_hand s4
              join stock_location l4 on l4.id = s4.location_id
             where s4.item_id = i.id and l4.type = 'pharmacy' and l4.active and l4.deleted_at is null
               and s4.quantity > 0 and (s4.expiry is null or s4.expiry >= current_date)) as pharmacy_usable
    from stock_on_hand s left join batch b on b.id = s.batch_id
    where s.item_id = i.id and s.location_id is distinct from v_transit
      and (v_vis is null or s.location_id = any (v_vis))
  ) t on true
  where i.deleted_at is null;

  return jsonb_build_object('locations', v_locations, 'items', v_items, 'admin', v_admin, 'mainPharmacyId', v_main, 'expiryDays', v_days,
                            'transit', case when v_admin then jsonb_build_object(
                              'units', (select coalesce(sum(s.quantity), 0) from stock_on_hand s where s.location_id = v_transit),
                              'value', (select coalesce(sum(s.quantity * coalesce(b.unit_cost, 0)), 0) from stock_on_hand s
                                        left join batch b on b.id = s.batch_id where s.location_id = v_transit),
                              'notes', (select count(*) from stock_transfer where status = 'in_transit')) end);
end
$$;

-- stock_alerts (from 20261124090000_stores_and_stock): expiring within stock.expiry_days.
create or replace function stock_alerts()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_admin boolean := stock_admin();
  v_vis uuid[] := visible_stores();
  v_days integer := stock_expiry_days();
begin
  return jsonb_build_object(
    'expiryDays', v_days,
    -- the pharmacy: unexpired units at or below the reorder level
    'low', case when v_admin then coalesce((
      select jsonb_agg(jsonb_build_object('itemId', r.item_id, 'item', item_label(r.item_id), 'code', r.code,
                                          'onHand', r.on_hand, 'level', r.reorder_level,
                                          'maxLevel', (select max_level from item where id = r.item_id))
                       order by r.on_hand::numeric / greatest(r.reorder_level, 1), r.name_generic)
      from items_below_reorder r), '[]'::jsonb) else '[]'::jsonb end,
    -- a room store below the minimum set for it
    'roomLow', coalesce((
      select jsonb_agg(jsonb_build_object('storeId', l.id, 'store', l.name, 'itemId', m.item_id, 'item', item_label(m.item_id),
                                          'onHand', usable_stock(m.item_id, l.id), 'min', m.min_level)
                       order by l.name)
      from store_item_level m join stock_location l on l.id = m.location_id and l.active and l.deleted_at is null
      where (v_vis is null or l.id = any (v_vis)) and usable_stock(m.item_id, l.id) < m.min_level), '[]'::jsonb),
    -- expiring within the window (stock.expiry_days) (not expired yet), batch by batch
    'expiring', coalesce((
      select jsonb_agg(jsonb_build_object('storeId', l.id, 'store', l.name, 'itemId', s.item_id, 'item', item_label(s.item_id),
                                          'batchNo', b.batch_no, 'expiry', s.expiry, 'quantity', s.quantity,
                                          'days', s.expiry - current_date)
                       order by s.expiry, l.name)
      from stock_on_hand s join stock_location l on l.id = s.location_id and l.deleted_at is null and l.type::text <> 'transit'
      left join batch b on b.id = s.batch_id
      where s.quantity > 0 and s.expiry between current_date and current_date + v_days
        and (v_vis is null or l.id = any (v_vis))), '[]'::jsonb),
    -- already expired: to write off (or send back to the pharmacy)
    'expired', coalesce((
      select jsonb_agg(jsonb_build_object('storeId', l.id, 'store', l.name, 'itemId', s.item_id, 'item', item_label(s.item_id),
                                          'batchNo', b.batch_no, 'expiry', s.expiry, 'quantity', s.quantity)
                       order by s.expiry, l.name)
      from stock_on_hand s join stock_location l on l.id = s.location_id and l.deleted_at is null and l.type::text <> 'transit'
      left join batch b on b.id = s.batch_id
      where s.quantity > 0 and s.expiry < current_date
        and (v_vis is null or l.id = any (v_vis))), '[]'::jsonb)
  );
end
$$;

-- my_stores (from 20261124090000_stores_and_stock): expiring within stock.expiry_days.
create or replace function my_stores()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.name, 'type', l.type, 'active', l.active,
      'personal', exists (select 1 from stock_location_holder h where h.location_id = l.id and h.deleted_at is null
                          and h.profile_id = auth.uid()),
      'departments', coalesce((select jsonb_agg(d.name order by d.name) from stock_location_holder h
                               join department d on d.id = h.department_id
                               join staff_department sd on sd.department_id = h.department_id and sd.profile_id = auth.uid()
                               where h.location_id = l.id and h.deleted_at is null), '[]'::jsonb),
      'items', (select count(distinct s.item_id) from stock_on_hand s where s.location_id = l.id and s.quantity > 0)::integer,
      'units', (select coalesce(sum(s.quantity), 0) from stock_on_hand s where s.location_id = l.id and s.quantity > 0)::integer,
      'expiredUnits', (select coalesce(sum(s.quantity), 0) from stock_on_hand s where s.location_id = l.id
                       and s.quantity > 0 and s.expiry < current_date)::integer,
      'expiringUnits', (select coalesce(sum(s.quantity), 0) from stock_on_hand s where s.location_id = l.id
                        and s.quantity > 0 and s.expiry between current_date and current_date + stock_expiry_days())::integer,
      'low', (select count(*) from store_item_level m where m.location_id = l.id
              and usable_stock(m.item_id, l.id) < m.min_level)::integer,
      'incoming', (select count(*) from stock_transfer t where t.to_location_id = l.id and t.status = 'in_transit')::integer,
      'returnsOnTheWay', (select count(*) from stock_transfer t where t.from_location_id = l.id
                          and t.direction = 'to_pharmacy' and t.status = 'in_transit')::integer,
      'openRequests', (select count(*) from store_request r where r.location_id = l.id and r.status = 'open')::integer
    ) order by l.name), '[]'::jsonb)
  from stock_location l
  where l.deleted_at is null and l.active and is_room_type(l.type) and holds_store(auth.uid(), l.id)
$$;

-- store_stock (from 20261128090000_switches_enforced): expiring within stock.expiry_days.
create or replace function store_stock(p_location_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_l stock_location%rowtype;
  v_admin boolean := stock_admin();
  v_items jsonb;
  v_incoming jsonb;
begin
  select * into v_l from stock_location where id = p_location_id and deleted_at is null;
  if not found or v_l.type::text = 'transit' then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if not may_see_store(p_location_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'itemId', i.id, 'item', i.name_generic || coalesce(' ' || i.strength, ''), 'code', i.code,
      'unit', i.selling_unit, 'packSize', i.pack_size,
      'onHand', coalesce(t.on_hand, 0), 'usable', coalesce(t.usable, 0), 'expired', coalesce(t.expired, 0),
      'expiringSoon', coalesce(t.expiring, 0), 'earliestExpiry', t.next_expiry,
      'minLevel', m.min_level, 'low', m.min_level is not null and coalesce(t.usable, 0) < m.min_level,
      'price', (select pf.price from price_for(null, i.id, null) pf),
      'value', case when v_admin then coalesce(t.value, 0) end,
      'batches', coalesce(t.batches, '[]'::jsonb)
    ) order by i.name_generic), '[]'::jsonb)
  into v_items
  from item i
  left join store_item_level m on m.location_id = p_location_id and m.item_id = i.id
  left join lateral (
    select sum(s.quantity)::integer as on_hand,
           sum(s.quantity) filter (where s.expiry is null or s.expiry >= current_date)::integer as usable,
           sum(s.quantity) filter (where s.expiry < current_date)::integer as expired,
           sum(s.quantity) filter (where s.expiry between current_date and current_date + stock_expiry_days())::integer as expiring,
           min(s.expiry) filter (where s.expiry >= current_date) as next_expiry,
           sum(s.quantity * coalesce(b.unit_cost, 0)) as value,
           jsonb_agg(jsonb_build_object('batchId', s.batch_id, 'batchNo', b.batch_no, 'expiry', s.expiry,
                                        'quantity', s.quantity, 'expired', s.expiry < current_date,
                                        'unitCost', case when v_admin then b.unit_cost end)
                     order by s.expiry nulls last) as batches
    from stock_on_hand s left join batch b on b.id = s.batch_id
    where s.item_id = i.id and s.location_id = p_location_id and s.quantity > 0
  ) t on true
  where i.deleted_at is null and (t.on_hand is not null or m.min_level is not null);

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'number', t.number, 'direction', t.direction, 'sentAt', t.sent_at,
      'from', lf.name, 'to', lt.name,
      'lines', (select count(*) from stock_transfer_line x where x.transfer_id = t.id)::integer,
      'units', (select coalesce(sum(x.quantity), 0) from stock_transfer_line x where x.transfer_id = t.id)::integer
    ) order by t.sent_at), '[]'::jsonb)
  into v_incoming
  from stock_transfer t
  join stock_location lf on lf.id = t.from_location_id
  join stock_location lt on lt.id = t.to_location_id
  where t.status = 'in_transit' and (t.to_location_id = p_location_id or t.from_location_id = p_location_id);

  return jsonb_build_object(
    'store', jsonb_build_object('id', v_l.id, 'name', v_l.name, 'type', v_l.type, 'active', v_l.active,
                                'isMain', v_l.is_main, 'isRoom', is_room_type(v_l.type),
                                'holders', store_holders(v_l.id)),
    'held', holds_store(auth.uid(), v_l.id),
    -- count and write off: the holders (room store) or the pharmacy (pharmacy and main stores); the manager
    'canManage', is_manager() or case when is_room_type(v_l.type) then holds_store(auth.uid(), v_l.id)
                                       else stock_manager() end,
    'items', v_items,
    'onTheWay', v_incoming,
    'value', case when v_admin then (select coalesce(sum(s.quantity * coalesce(b.unit_cost, 0)), 0)
                                     from stock_on_hand s left join batch b on b.id = s.batch_id
                                     where s.location_id = p_location_id and s.quantity > 0) end
  );
end
$$;

-- save_setting (from 20261120090000_session_hours): the expiry window (stock.expiry_days, 1 to 365 days).
create or replace function save_setting(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_hours numeric;
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_key not in ('clinic.profile', 'clinic.hours', 'clinic.features', 'patient.fields', 'security.lock', 'security.otp', 'security.session', 'flow', 'stock.expiry_days') then
    raise exception 'unknown setting %', p_key using errcode = '22023';
  end if;
  if p_key = 'security.session' then
    if not is_manager() then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if jsonb_typeof(p_value -> 'hours') is distinct from 'number' then
      raise exception 'hours must be a whole number between 1 and 12' using errcode = '22023';
    end if;
    v_hours := (p_value ->> 'hours')::numeric;
    if v_hours <> trunc(v_hours) or v_hours < 1 or v_hours > 12 then
      raise exception 'hours must be a whole number between 1 and 12' using errcode = '22023';
    end if;
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
  if p_key = 'stock.expiry_days' then
    if jsonb_typeof(p_value) is distinct from 'number' then
      raise exception 'the expiry window is a whole number of days between 1 and 365' using errcode = '22023';
    end if;
    if (p_value #>> '{}')::numeric <> trunc((p_value #>> '{}')::numeric)
       or (p_value #>> '{}')::numeric < 1 or (p_value #>> '{}')::numeric > 365 then
      raise exception 'the expiry window is a whole number of days between 1 and 365' using errcode = '22023';
    end if;
  end if;
  insert into setting (key, value, changed_by, changed_at)
  values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, changed_by = auth.uid(), changed_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'setting', null, jsonb_build_object('key', p_key));
end
$$;

-- ---------------------------------------------------------------- grants
-- (functions replaced with the same arguments keep their grants)
revoke all on function add_stock(jsonb, uuid, text), dispense_prescription(uuid, uuid, integer), stock_alert_check(),
  stock_totals(uuid), message_manager(text), stock_expiry_days()
  from public, anon;
grant execute on function add_stock(jsonb, uuid, text), dispense_prescription(uuid, uuid, integer), stock_alert_check(),
  stock_totals(uuid), message_manager(text), stock_expiry_days()
  to authenticated;
-- internal: only the checked functions call them
revoke all on function pharmacy_takes_money(), set_cash_price(uuid, numeric),
  stock_notice(text, text, jsonb, text, boolean), stock_alert_run()
  from public, anon, authenticated;
