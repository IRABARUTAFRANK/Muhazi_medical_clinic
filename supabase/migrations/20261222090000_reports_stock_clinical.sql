-- 0112 · The report centre: the stock / pharmacy and clinical reports.
--
-- Frank (owner): "all stock that we have, those that were sold in the past three months or any
-- other timeframe, and all other kinds of reports that may be made." Every report of the report
-- centre (/app/reports) is a table the person filters; these functions give its rows (one jsonb
-- array, camelCase keys) and check the rights again: a report never shows more than the screens.
--
-- STOCK / PHARMACY (stock is in pieces everywhere; the web shows the packs beside them)
--   report_stock_options()                     the stores the caller may report on
--   report_stock_on_hand(store, by store, days) 1 · one row per medicine (per store when asked)
--   report_stock_sold(from, to, store, channel, split)
--                                              2 · medicines handed over to visits, given here,
--                                                  sold to walk-in buyers: pieces, revenue at the
--                                                  prices charged, cost of goods, margin
--   report_stock_movements(from, to, store, type) 3 · the ledger: every movement of the period
--   report_stock_deliveries(from, to, store)   4 · delivery lines received (GRN), single receipts
--   report_stock_transfers(from, to, store, status) 5 · transfer and return note lines
--   report_stock_expiry(store, within, expired only) 6 · batch by batch: expired and expiring
--   report_stock_to_order(store)               7 · low stock: what to order (pharmacy), to refill
--                                                  (room stores)
--   report_stock_write_offs(from, to, store)   8 · write-offs, count differences, lost on the way
--   report_stock_outside(from, to)             9 · prescribed but bought outside
-- Rights (as the stock screens): the manager and the pharmacy desk (stock_admin) see every store
-- and the money at cost (cost value, cost of goods, margin, unit cost); a store holder sees the
-- stores they hold (1, 2, 3, 6, 8; 4 for the stores they receive into with stock.write), never the
-- costs. 5, 7 and 9: the manager and the pharmacy desk.
--
-- CLINICAL (0088 privacy: a report gives what its reader may see on the screens)
--   report_clinical_options()                  the clinicians, departments and practitioners the
--                                                  caller may filter by (and their scope)
--   report_patients_seen(from, to, clinician, department) 10 · one row per visit and clinician
--   report_diagnoses(from, to, department, doctor) 11 · cases per diagnosis (ICD-10), new and
--                                                  follow-up, by sex and age band
--   report_prescriptions(from, to, supply, prescriber) 12 · one row per prescribed medicine
--   report_tests(from, to, desk, status, requester) 13 · one row per test (laboratory, ultrasound)
--   report_vitals(from, to, taker)             14 · one row per set of vital signs
--   report_bookings(from, to, status, practitioner, source) 15 · bookings and arrivals
-- Rights: the manager — everything; the HEAD of a department (not the assistant, 0088) — the
-- visits of their departments (visit_departments); a clinician — their own work (the patients they
-- saw, the diagnoses they wrote, their prescriptions, the tests they asked for, the vital signs
-- they took or typed); the laboratory / ultrasound desk — the tests of their desk; the pharmacy
-- desk — the prescriptions; reception — the bookings; a practitioner — their own bookings.
--
-- Errcodes: 42501 not allowed, 22023 the end of the period is before its start.

-- ---------------------------------------------------------------- helpers
-- The departments the caller is the HEAD of (assistant heads do not see full records, 0088).
create or replace function report_head_departments()
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(sd.department_id), '{}'::uuid[])
  from staff_department sd
  join profiles me on me.id = sd.profile_id and me.active
  join department d on d.id = sd.department_id and d.deleted_at is null
  where sd.profile_id = auth.uid() and sd.position = 'head'
$$;

-- A period is checked the same way everywhere.
create or replace function report_assert_period(p_from date, p_to date)
returns void
language plpgsql immutable
as $$
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'the end of the period is before its start' using errcode = '22023';
  end if;
end
$$;

-- The reader of a stock report: the manager or the pharmacy desk, or a store holder.
create or replace function report_assert_stock(p_location_id uuid default null)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (stock_admin() or coalesce(cardinality(visible_stores()), 0) > 0) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_location_id is not null and not may_see_store(p_location_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
end
$$;

-- ---------------------------------------------------------------- stock: the stores
create or replace function report_stock_options()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_vis uuid[] := visible_stores();
begin
  perform report_assert_stock();
  return jsonb_build_object(
    'admin', stock_admin(),
    'mainPharmacyId', main_pharmacy(),
    'stores', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'type', l.type, 'active', l.active,
                                          'isRoom', is_room_type(l.type), 'isMain', l.is_main)
                       order by l.active desc, (l.type::text = 'pharmacy') desc, l.name)
      from stock_location l
      where l.deleted_at is null and l.type::text <> 'transit' and (v_vis is null or l.id = any (v_vis))
    ), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------- 1 · stock on hand
-- One row per medicine (all the caller's stores together), or per medicine and store (p_by_store,
-- a chosen store, or a store holder). A medicine with a reorder level and nothing left still shows
-- (it is to order). p_days: the "expiring soon" window (default: the setting stock.expiry_days).
create or replace function report_stock_on_hand(
  p_location_id uuid default null, p_by_store boolean default false, p_days integer default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_admin boolean := stock_admin();
  v_vis uuid[] := visible_stores();
  v_days integer := greatest(coalesce(p_days, stock_expiry_days()), 0);
  v_split boolean := coalesce(p_by_store, false) or p_location_id is not null or not stock_admin();
  v_main uuid := main_pharmacy();
  v_stores uuid[];
begin
  perform report_assert_stock(p_location_id);
  select coalesce(array_agg(l.id), '{}'::uuid[]) into v_stores
  from stock_location l
  where l.deleted_at is null and l.type::text <> 'transit'
    and (v_vis is null or l.id = any (v_vis))
    and (p_location_id is null or l.id = p_location_id);
  return coalesce((
    with s as (
      select s.item_id, s.location_id, s.quantity, s.expiry, coalesce(b.unit_cost, 0) as cost
      from stock_on_hand s left join batch b on b.id = s.batch_id
      where s.location_id = any (v_stores) and s.quantity <> 0
    ), per as (
      select s.item_id, case when v_split then s.location_id end as location_id,
             sum(s.quantity)::integer as on_hand,
             coalesce(sum(s.quantity) filter (where s.expiry is null or s.expiry >= current_date), 0)::integer as usable,
             coalesce(sum(s.quantity) filter (where s.expiry < current_date), 0)::integer as expired,
             coalesce(sum(s.quantity) filter (where s.expiry between current_date and current_date + v_days), 0)::integer
               as expiring,
             min(s.expiry) filter (where s.quantity > 0 and s.expiry >= current_date) as next_expiry,
             min(s.expiry) filter (where s.quantity > 0) as earliest_expiry,
             sum(s.quantity * s.cost) as cost_value
      from s group by 1, 2
    ), keys as (
      select p.item_id, p.location_id from per p
      union
      select i.id, case when v_split then v_main end
      from item i
      where v_admin and i.active and i.deleted_at is null and i.reorder_level > 0
        and (not v_split or v_main = any (v_stores))
      union
      select m.item_id, case when v_split then m.location_id end
      from store_item_level m join item i on i.id = m.item_id and i.deleted_at is null
      where m.location_id = any (v_stores)
    )
    select jsonb_agg(jsonb_build_object(
        'itemId', i.id, 'code', i.code, 'name', i.name_generic || coalesce(' ' || i.strength, ''),
        'generic', i.name_generic, 'brand', i.name_brand, 'strength', i.strength, 'form', i.form,
        'unit', i.selling_unit, 'packSize', case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end,
        'packUnit', i.pack_unit, 'saleMode', i.sale_mode, 'kind', i.kind, 'group', i.atc_group,
        'active', i.active,
        'storeId', k.location_id, 'store', l.name, 'storeType', l.type,
        'onHand', coalesce(p.on_hand, 0), 'usable', coalesce(p.usable, 0), 'expired', coalesce(p.expired, 0),
        'expiring', coalesce(p.expiring, 0), 'nextExpiry', p.next_expiry, 'earliestExpiry', p.earliest_expiry,
        'level', x.level, 'low', x.low,
        'price', pr.price, 'packPrice', case when i.sale_mode <> 'piece' then i.pack_price end,
        'costValue', case when v_admin then round(coalesce(p.cost_value, 0), 2) end,
        'sellValue', round(sell_value(coalesce(p.usable, 0), pr.price, i.pack_price, i.pack_size, i.sale_mode))
      ) order by i.name_generic, i.strength, l.name)
    from keys k
    join item i on i.id = k.item_id and i.deleted_at is null
    left join per p on p.item_id = k.item_id and p.location_id is not distinct from k.location_id
    left join stock_location l on l.id = k.location_id
    left join store_item_level m on m.location_id = k.location_id and m.item_id = k.item_id
    left join lateral (select pf.price from price_for(null, i.id, null) pf) pr on true
    cross join lateral (
      select case
               when not v_split then nullif(i.reorder_level, 0)
               when l.type::text = 'pharmacy' then nullif(i.reorder_level, 0)
               when is_room_type(l.type) then m.min_level
             end as level,
             case
               when not v_split then exists (select 1 from items_below_reorder r where r.item_id = i.id)
               when l.type::text = 'pharmacy' then i.reorder_level > 0 and coalesce(p.usable, 0) <= i.reorder_level
               when is_room_type(l.type) then m.min_level is not null and coalesce(p.usable, 0) < m.min_level
               else false
             end as low
    ) x
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- 2 · medicines sold and given
-- What left the stock to patients in the period, by channel:
--   handover  the pharmacy handed it over to a visit (medication_dispense still standing: a medicine
--             returned leaves the list); revenue = its bill lines (source medication_dispense)
--   here      given in a room from a room store (consumption of a prescription line, not put back);
--             revenue = its bill lines (source medication_request)
--   walkin    a walk-in sale handed over (counter_sale); revenue = the sale lines
-- Revenue is at the prices charged (patient and insurer shares together); a bill credited in full
-- counts nothing. Cost of goods = the pieces at the cost of the batches they came from.
-- p_split: one row per medicine, channel and store (else one row per medicine).
create or replace function report_stock_sold(
  p_from date, p_to date, p_location_id uuid default null, p_channel text default null, p_split boolean default false
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_admin boolean := stock_admin();
  v_vis uuid[] := visible_stores();
  v_split boolean := coalesce(p_split, false);
begin
  perform report_assert_stock(p_location_id);
  perform report_assert_period(p_from, p_to);
  return coalesce((
    with ev as (
      select d.item_id,
             (select m.from_location_id from stock_movement m
              where m.dispense_id = d.id and m.type = 'dispense' and m.deleted_at is null limit 1) as location_id,
             'handover'::text as channel, d.quantity::numeric as pieces,
             (select coalesce(sum(m.quantity * coalesce(m.unit_cost, b.unit_cost, 0)), 0)
              from stock_movement m left join batch b on b.id = m.batch_id
              where m.dispense_id = d.id and m.type = 'dispense' and m.deleted_at is null) as cost,
             (select coalesce(sum(round(l.quantity * l.unit_price)), 0)
              from invoice_line l join invoice inv on inv.id = l.invoice_id and inv.status <> 'credited'
              where l.source_type = 'medication_dispense' and l.source_id = d.id and l.deleted_at is null) as revenue
      from medication_dispense d
      where d.deleted_at is null and (d.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
      union all
      select g.item_id, g.location_id, 'here', g.pieces, g.cost,
             (select coalesce(sum(round(l.quantity * l.unit_price)), 0)
              from invoice_line l join invoice inv on inv.id = l.invoice_id and inv.status <> 'credited'
              where l.source_type = 'medication_request' and l.source_id = g.request_id and l.deleted_at is null)
      from (
        select m.medication_request_id as request_id, m.item_id, m.from_location_id as location_id,
               sum(m.quantity)::numeric as pieces, sum(m.quantity * coalesce(m.unit_cost, b.unit_cost, 0)) as cost
        from stock_movement m left join batch b on b.id = m.batch_id
        where m.deleted_at is null and m.type = 'consumption' and m.medication_request_id is not null
          and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to
          and not exists (select 1 from stock_movement r
                          where r.medication_request_id = m.medication_request_id and r.type = 'return'
                            and r.dispense_id is null and r.deleted_at is null)
        group by 1, 2, 3
      ) g
      union all
      select x.item_id, s.location_id, 'walkin', x.pieces,
             (select coalesce(sum(h.quantity * coalesce(h.unit_cost, 0)), 0)
              from counter_sale_held(s.id) h where h.item_id = x.item_id),
             x.revenue
      from counter_sale s
      join (select sale_id, item_id, sum(quantity)::numeric as pieces, sum(line_total) as revenue
            from counter_sale_line where deleted_at is null group by 1, 2) x on x.sale_id = s.id
      where s.deleted_at is null and s.status = 'handed_over'
        and (s.handed_over_at at time zone 'Africa/Kigali')::date between p_from and p_to
    ), seen as (
      select * from ev
      where (v_vis is null or ev.location_id = any (v_vis))
        and (p_location_id is null or ev.location_id = p_location_id)
        and (p_channel is null or p_channel = '' or ev.channel = p_channel)
    ), agg as (
      select item_id, case when v_split then channel end as channel,
             case when v_split then location_id end as location_id,
             case when count(distinct location_id) = 1 then min(location_id::text)::uuid end as only_store,
             sum(pieces) as pieces,
             coalesce(sum(pieces) filter (where channel = 'handover'), 0) as handover,
             coalesce(sum(pieces) filter (where channel = 'here'), 0) as here,
             coalesce(sum(pieces) filter (where channel = 'walkin'), 0) as walkin,
             count(*)::integer as times,
             sum(revenue) as revenue, sum(cost) as cost
      from seen group by 1, 2, 3
    )
    select jsonb_agg(jsonb_build_object(
        'itemId', i.id, 'code', i.code, 'name', i.name_generic || coalesce(' ' || i.strength, ''),
        'unit', i.selling_unit, 'packSize', case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end,
        'packUnit', i.pack_unit, 'kind', i.kind, 'group', i.atc_group,
        'channel', a.channel, 'storeId', coalesce(a.location_id, a.only_store), 'store', l.name,
        'pieces', a.pieces, 'handover', a.handover, 'here', a.here, 'walkin', a.walkin, 'times', a.times,
        'revenue', round(a.revenue),
        'cost', case when v_admin then round(a.cost, 2) end,
        'margin', case when v_admin then round(a.revenue - a.cost, 2) end
      ) order by a.revenue desc, i.name_generic, l.name)
    from agg a
    join item i on i.id = a.item_id
    left join stock_location l on l.id = coalesce(a.location_id, a.only_store)
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- 3 · stock movements (the ledger)
-- Every movement of the period in the caller's stores, with its kind:
--   received (a delivery), transfer, dispensed (handed over to a visit), sold (a walk-in sale),
--   returned (back into a store), given_here, written_off (a write-off, or lost on the way),
--   count (a count correction, up or down).
-- With a store chosen, change = + what came in, − what went out (the net change of the store).
create or replace function report_stock_movements(
  p_from date, p_to date, p_location_id uuid default null, p_type text default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_admin boolean := stock_admin();
begin
  perform report_assert_stock(p_location_id);
  perform report_assert_period(p_from, p_to);
  return coalesce((
    select jsonb_agg(x.j order by x.at desc) from (
      select m.moved_at as at, jsonb_build_object(
          'id', m.id, 'at', m.moved_at, 'kind', k.kind, 'type', m.type,
          'itemId', m.item_id, 'name', i.name_generic || coalesce(' ' || i.strength, ''), 'code', i.code,
          'unit', i.selling_unit, 'packSize', case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end,
          'packUnit', i.pack_unit,
          'batch', b.batch_no, 'expiry', b.expiry,
          'fromId', m.from_location_id, 'from', lf.name, 'toId', m.to_location_id, 'to', lt.name,
          'quantity', m.quantity,
          'change', case when p_location_id is null then null
                         when m.to_location_id = p_location_id then m.quantity else -m.quantity end,
          'reason', nullif(regexp_replace(coalesce(m.reason, ''), '^count: ', ''), ''),
          'document', coalesce((select t.number from stock_transfer t where t.id = m.stock_transfer_id),
                               (select g.number from goods_receipt g where g.id = m.goods_receipt_id),
                               (select cs.number from counter_sale cs where cs.id = m.counter_sale_id)),
          'by', pr.full_name,
          'unitCost', case when v_admin then coalesce(m.unit_cost, b.unit_cost) end,
          'value', case when v_admin then round(m.quantity * coalesce(m.unit_cost, b.unit_cost, 0), 2) end
        ) as j
      from stock_movement m
      join item i on i.id = m.item_id
      left join batch b on b.id = m.batch_id
      left join stock_location lf on lf.id = m.from_location_id
      left join stock_location lt on lt.id = m.to_location_id
      left join profiles pr on pr.id = m.created_by
      cross join lateral (
        select case
                 when m.type = 'receipt' then 'received'
                 when m.type = 'transfer' then 'transfer'
                 when m.type = 'dispense' and m.counter_sale_id is not null then 'sold'
                 when m.type = 'dispense' then 'dispensed'
                 when m.type = 'return' then 'returned'
                 when m.type = 'consumption' and m.medication_request_id is not null then 'given_here'
                 when m.type = 'consumption' then 'written_off'
                 when m.type = 'adjustment' and coalesce(m.reason, '') like 'count:%' then 'count'
                 else 'written_off'
               end as kind
      ) k
      where m.deleted_at is null
        and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to
        and (p_location_id is null or m.from_location_id = p_location_id or m.to_location_id = p_location_id)
        and (p_type is null or p_type = '' or k.kind = p_type)
        and (v_admin or holds_store(auth.uid(), m.from_location_id) or holds_store(auth.uid(), m.to_location_id))
      order by m.moved_at desc
      limit 5000
    ) x
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- 4 · deliveries received
-- One row per delivery line (GRN), and per single receipt made without a delivery note. The
-- manager and the pharmacy desk: every store, with the costs; a store holder who receives
-- (stock.write, e.g. the laboratory's reagents): their stores, without the costs.
create or replace function report_stock_deliveries(p_from date, p_to date, p_location_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_admin boolean := stock_admin();
begin
  perform report_assert_stock(p_location_id);
  if not (v_admin or has_perm('stock.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform report_assert_period(p_from, p_to);
  return coalesce((
    select jsonb_agg(x.j order by x.at desc, x.name) from (
      select g.received_on as at, i.name_generic as name, jsonb_build_object(
          'id', gl.id, 'at', g.received_on, 'deliveredOn', g.delivered_on, 'number', g.number,
          'reference', g.reference, 'supplier', coalesce(g.supplier_name, s.name),
          'storeId', g.location_id, 'store', l.name,
          'itemId', i.id, 'code', i.code, 'name', i.name_generic || coalesce(' ' || i.strength, ''),
          'unit', i.selling_unit, 'packUnit', i.pack_unit,
          'packSize', case when gl.pack_size >= 2 then gl.pack_size
                           when coalesce(i.pack_size, 1) >= 2 then i.pack_size end,
          'packs', case when gl.unit = 'box' then gl.packs end,
          'batch', gl.batch_no, 'expiry', gl.expiry, 'pieces', gl.units,
          'unitCost', case when v_admin then gl.unit_cost end,
          'packCost', case when v_admin then gl.pack_cost end,
          'lineCost', case when v_admin then gl.line_cost end,
          'by', pr.full_name, 'note', g.note
        ) as j
      from goods_receipt g
      join goods_receipt_line gl on gl.receipt_id = g.id and gl.deleted_at is null
      join item i on i.id = gl.item_id
      left join supplier s on s.id = g.supplier_id
      left join stock_location l on l.id = g.location_id
      left join profiles pr on pr.id = g.created_by
      where g.deleted_at is null
        and (g.received_on at time zone 'Africa/Kigali')::date between p_from and p_to
        and (p_location_id is null or g.location_id = p_location_id)
        and (v_admin or holds_store(auth.uid(), g.location_id))
      union all
      select m.moved_at, i.name_generic, jsonb_build_object(
          'id', m.id, 'at', m.moved_at, 'deliveredOn', null, 'number', null, 'reference', null,
          'supplier', coalesce(s.name, nullif(m.reason, '')),
          'storeId', m.to_location_id, 'store', l.name,
          'itemId', i.id, 'code', i.code, 'name', i.name_generic || coalesce(' ' || i.strength, ''),
          'unit', i.selling_unit, 'packUnit', i.pack_unit,
          'packSize', case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end, 'packs', null,
          'batch', b.batch_no, 'expiry', b.expiry, 'pieces', m.quantity,
          'unitCost', case when v_admin then coalesce(m.unit_cost, b.unit_cost) end,
          'packCost', null,
          'lineCost', case when v_admin then round(m.quantity * coalesce(m.unit_cost, b.unit_cost, 0), 2) end,
          'by', pr.full_name, 'note', null
        )
      from stock_movement m
      join item i on i.id = m.item_id
      left join batch b on b.id = m.batch_id
      left join supplier s on s.id = b.supplier_id
      left join stock_location l on l.id = m.to_location_id
      left join profiles pr on pr.id = m.created_by
      where m.deleted_at is null and m.type = 'receipt' and m.goods_receipt_id is null
        and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to
        and (p_location_id is null or m.to_location_id = p_location_id)
        and (v_admin or holds_store(auth.uid(), m.to_location_id))
    ) x
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- 5 · transfers to stores
-- One row per line of a transfer note (pharmacy → room store) or return note (room store →
-- pharmacy) sent in the period, with the prices of the day it was written (0107): the manager and
-- the pharmacy desk.
create or replace function report_stock_transfers(
  p_from date, p_to date, p_location_id uuid default null, p_status text default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if not stock_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform report_assert_period(p_from, p_to);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', x.id, 'number', t.number, 'direction', t.direction, 'status', t.status, 'at', t.sent_at,
        'fromId', t.from_location_id, 'from', lf.name, 'toId', t.to_location_id, 'to', lt.name,
        'itemId', i.id, 'code', i.code, 'name', i.name_generic || coalesce(' ' || i.strength, ''),
        'unit', i.selling_unit, 'packUnit', i.pack_unit,
        'packSize', case when coalesce(x.pack_size, i.pack_size, 1) >= 2 then coalesce(x.pack_size, i.pack_size) end,
        'inPacks', x.in_packs, 'batch', b.batch_no, 'expiry', b.expiry,
        'pieces', x.quantity, 'received', x.received_quantity,
        'costValue', round(x.quantity * x.unit_cost, 2),
        'sellValue', round(sell_value(x.quantity, x.unit_price, x.pack_price, x.pack_size, x.sale_mode)),
        'sentBy', (select full_name from profiles where id = t.created_by),
        'receivedBy', (select full_name from profiles where id = t.received_by), 'receivedAt', t.confirmed_at,
        'difference', x.difference_action, 'differenceReason', x.difference_reason,
        'cancelReason', t.cancel_reason
      ) order by t.sent_at desc, t.number, i.name_generic)
    from stock_transfer t
    join stock_transfer_line x on x.transfer_id = t.id and x.deleted_at is null
    join item i on i.id = x.item_id
    left join batch b on b.id = x.batch_id
    join stock_location lf on lf.id = t.from_location_id
    join stock_location lt on lt.id = t.to_location_id
    where t.deleted_at is null
      and (t.sent_at at time zone 'Africa/Kigali')::date between p_from and p_to
      and (p_location_id is null or t.from_location_id = p_location_id or t.to_location_id = p_location_id)
      and (p_status is null or p_status = '' or t.status = p_status)
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- 6 · expiring and expired
-- Batch by batch in the caller's stores: p_within = expiring within so many days (the expired
-- included), p_expired_only = only what has expired. status: expired / soon (within the setting
-- stock.expiry_days) / ok.
create or replace function report_stock_expiry(
  p_location_id uuid default null, p_within integer default null, p_expired_only boolean default false
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_admin boolean := stock_admin();
  v_vis uuid[] := visible_stores();
  v_days integer := stock_expiry_days();
begin
  perform report_assert_stock(p_location_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'itemId', i.id, 'code', i.code, 'name', i.name_generic || coalesce(' ' || i.strength, ''),
        'unit', i.selling_unit, 'packSize', case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end,
        'packUnit', i.pack_unit, 'kind', i.kind,
        'batch', b.batch_no, 'storeId', s.location_id, 'store', l.name, 'storeType', l.type,
        'expiry', s.expiry, 'daysLeft', s.expiry - current_date,
        'status', case when s.expiry < current_date then 'expired'
                       when s.expiry <= current_date + v_days then 'soon' else 'ok' end,
        'pieces', s.quantity,
        'costValue', case when v_admin then round(s.quantity * coalesce(b.unit_cost, 0), 2) end,
        'sellValue', round(sell_value(s.quantity, pr.price, i.pack_price, i.pack_size, i.sale_mode))
      ) order by s.expiry nulls last, i.name_generic, l.name)
    from stock_on_hand s
    join item i on i.id = s.item_id
    join stock_location l on l.id = s.location_id and l.deleted_at is null and l.type::text <> 'transit'
    left join batch b on b.id = s.batch_id
    left join lateral (select pf.price from price_for(null, i.id, null) pf) pr on true
    where s.quantity > 0 and s.expiry is not null
      and (v_vis is null or s.location_id = any (v_vis))
      and (p_location_id is null or s.location_id = p_location_id)
      and (not coalesce(p_expired_only, false) or s.expiry < current_date)
      and (p_within is null or s.expiry <= current_date + greatest(p_within, 0))
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- 7 · low stock: what to order
-- The pharmacy (all open pharmacy stores together): the medicines at or below their reorder level,
-- with what to order (reorder_suggestions: up to the maximum level, else twice the level or two
-- months of use), the last supplier and cost. Each room store: the medicines under the store's
-- minimum, with a refill up to twice the minimum. The manager and the pharmacy desk.
create or replace function report_stock_to_order(p_location_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_type text;
begin
  if not stock_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_location_id is not null then
    select l.type::text into v_type from stock_location l where l.id = p_location_id and l.deleted_at is null;
  end if;
  return coalesce((
    select jsonb_agg(z.j order by z.scope, z.ratio, z.name) from (
      select 'a'::text as scope, (x ->> 'onHand')::numeric / greatest((x ->> 'level')::numeric, 1) as ratio,
             i.name_generic as name,
             x || jsonb_build_object('name', x ->> 'item', 'packUnit', i.pack_unit, 'kind', i.kind,
                                     'storeId', null, 'store', null, 'scope', 'pharmacy',
                                     'packSize', case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end) as j
      from jsonb_array_elements(reorder_suggestions()) x
      join item i on i.id = (x ->> 'itemId')::uuid
      where p_location_id is null or v_type = 'pharmacy'
      union all
      select 'b', u.q::numeric / greatest(m.min_level, 1), i.name_generic,
             jsonb_build_object(
               'itemId', i.id, 'name', i.name_generic || coalesce(' ' || i.strength, ''), 'code', i.code,
               'unit', i.selling_unit, 'packUnit', i.pack_unit, 'kind', i.kind,
               'packSize', case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end,
               'storeId', l.id, 'store', l.name, 'scope', 'room',
               'onHand', u.q, 'level', m.min_level, 'maxLevel', null, 'inRooms', null, 'monthlyUse', null,
               'suggested', greatest(0, 2 * m.min_level - u.q),
               'lastSupplier', null,
               'lastCost', (select coalesce(mv.unit_cost, b.unit_cost) from stock_movement mv
                            left join batch b on b.id = mv.batch_id
                            where mv.item_id = i.id and mv.type = 'receipt' and mv.deleted_at is null
                            order by mv.moved_at desc limit 1),
               'lastReceivedAt', null, 'estimatedCost', null)
      from store_item_level m
      join stock_location l on l.id = m.location_id and l.active and l.deleted_at is null
      join item i on i.id = m.item_id and i.active and i.deleted_at is null
      cross join lateral (select usable_stock(m.item_id, m.location_id) as q) u
      where u.q < m.min_level and (p_location_id is null or m.location_id = p_location_id)
    ) z
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- 8 · write-offs and count differences
-- What left (or came back into) a store other than by being given or sold: written off with a
-- reason (expired, damaged…), a count correction (up or down), lost on the way (a transfer note
-- received with less). quantity: − out of the store, + into it.
create or replace function report_stock_write_offs(p_from date, p_to date, p_location_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_admin boolean := stock_admin();
begin
  perform report_assert_stock(p_location_id);
  perform report_assert_period(p_from, p_to);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', m.id, 'at', m.moved_at,
        'kind', case when m.type = 'consumption' then 'written_off'
                     when coalesce(m.reason, '') like 'count:%' then 'count' else 'lost' end,
        'itemId', i.id, 'code', i.code, 'name', i.name_generic || coalesce(' ' || i.strength, ''),
        'unit', i.selling_unit, 'packSize', case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end,
        'packUnit', i.pack_unit, 'itemKind', i.kind,
        'batch', b.batch_no, 'expiry', b.expiry,
        'storeId', coalesce(m.from_location_id, m.to_location_id), 'store', l.name,
        'quantity', case when m.to_location_id is not null then m.quantity else -m.quantity end,
        'reason', nullif(regexp_replace(coalesce(m.reason, ''), '^count: ', ''), ''),
        'costValue', case when v_admin then round(case when m.to_location_id is not null then 1 else -1 end
                                                  * m.quantity * coalesce(m.unit_cost, b.unit_cost, 0), 2) end,
        'by', pr.full_name
      ) order by m.moved_at desc)
    from stock_movement m
    join item i on i.id = m.item_id
    left join batch b on b.id = m.batch_id
    left join stock_location l on l.id = coalesce(m.from_location_id, m.to_location_id)
    left join profiles pr on pr.id = m.created_by
    where m.deleted_at is null
      and ((m.type = 'consumption' and m.medication_request_id is null) or m.type = 'adjustment')
      and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to
      and (p_location_id is null or coalesce(m.from_location_id, m.to_location_id) = p_location_id)
      and (v_admin or holds_store(auth.uid(), coalesce(m.from_location_id, m.to_location_id)))
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- 9 · bought outside
-- The medicines prescribed to be bought outside (supply 'outside', not cancelled) in the period:
-- how many times, how much, for how many patients, by whom, and how often the pharmacy had none.
-- The manager and the pharmacy desk.
create or replace function report_stock_outside(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if not stock_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform report_assert_period(p_from, p_to);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'name', x.name, 'itemId', x.item_id, 'code', x.code, 'inClinic', x.item_id is not null,
        'unit', x.unit, 'times', x.times, 'quantity', x.quantity, 'patients', x.patients,
        'prescribers', x.prescribers, 'lastAt', x.last_at, 'notGiven', x.not_given
      ) order by x.times desc, x.quantity desc, x.name)
    from (
      select min(rx_label(m)) as name, m.item_id, coalesce(min(i.code), min(m.reference_code)) as code,
             min(i.selling_unit) as unit,
             count(*)::integer as times, sum(m.quantity) as quantity,
             count(distinct e.patient_id)::integer as patients,
             string_agg(distinct pr.full_name, ', ') as prescribers,
             max(m.created_at) as last_at,
             count(*) filter (where m.not_given_at is not null or m.split_from is not null)::integer as not_given
      from medication_request m
      join encounter e on e.id = m.encounter_id
      left join item i on i.id = m.item_id
      left join profiles pr on pr.id = coalesce(m.prescriber_id, m.created_by)
      where m.deleted_at is null and m.supply = 'outside' and m.cancelled_at is null
        and (m.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
      group by m.item_id, case when m.item_id is null then lower(coalesce(m.reference_code, rx_label(m))) end
    ) x
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- clinical: who the caller may filter by
-- scope: all (the manager), departments (a head: their departments' visits, and their own work),
-- own (a clinician, reception, a practitioner: their own). clinicians: the staff (names only, as on
-- every screen: the rows stay within the scope); departments: all (manager) or the ones they head;
-- practitioners: the bookable calendars the caller may read (manager and reception: all; a
-- practitioner: their own).
create or replace function report_clinical_options()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_mgr boolean := is_manager();
  v_heads uuid[] := report_head_departments();
  v_rec boolean := may_use_desk('reception');
begin
  if v_me is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'scope', case when v_mgr then 'all' when cardinality(v_heads) > 0 then 'departments' else 'own' end,
    'me', v_me,
    'clinicians', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'role', p.role) order by p.full_name)
      from profiles p
      where p.active and p.deleted_at is null and p.role::text <> 'cashier'
    ), '[]'::jsonb),
    'departments', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) order by d.name)
      from department d
      where d.deleted_at is null and d.active and (v_mgr or d.id = any (v_heads))
    ), '[]'::jsonb),
    'practitioners', coalesce((
      select jsonb_agg(jsonb_build_object('id', pr.id, 'name', coalesce(pr.title || ' ', '') || pr.names,
                                          'userId', pr.user_id) order by pr.names)
      from practitioner pr
      where pr.deleted_at is null and pr.active and (v_mgr or v_rec or pr.user_id = v_me)
    ), '[]'::jsonb));
end
$$;

-- The reader of a clinical report: the manager, a head, or a clinical reader (their own work).
create or replace function report_assert_clinical()
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null
     or not (is_manager() or cardinality(report_head_departments()) > 0 or clinical_reader()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
end
$$;

-- ---------------------------------------------------------------- 10 · patients seen
-- One row per visit (arrived in the period) and clinician who saw the patient: took them at a
-- treating desk (consultation, dental, theatre, nursing, beds) or the ultrasound desk, or wrote a
-- diagnosis. prescriptions / tests: what that clinician prescribed and asked for in the visit.
-- outcome: referred (that clinician handed the patient on to another treating desk or colleague),
-- open (still in the clinic), left (closed before the clinical work was finished: no primary
-- diagnosis, or the visit says why the patient left), finished.
-- Rows: the manager all; a head the visits of their departments; everyone their own.
create or replace function report_patients_seen(
  p_from date, p_to date, p_clinician uuid default null, p_department uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_mgr boolean := is_manager();
  v_heads uuid[] := report_head_departments();
begin
  perform report_assert_clinical();
  perform report_assert_period(p_from, p_to);
  return coalesce((
    with enc as (
      select e.id, e.patient_id, e.arrived_at, e.reference, e.status, e.clinical_done_at, e.left_reason
      from encounter e
      where e.deleted_at is null and (e.arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to
    ), seen as (
      select q.encounter_id, q.taken_by as clinician_id, min(coalesce(q.started_at, q.created_at)) as seen_at,
             (array_agg(q.station::text order by q.created_at))[1] as station
      from queue_entry q join enc on enc.id = q.encounter_id
      where q.deleted_at is null and q.taken_by is not null
        and q.station in ('consultation', 'dental', 'theatre', 'nursing', 'beds', 'ultrasound')
      group by 1, 2
      union all
      select c.encounter_id, c.created_by, min(c.created_at), null
      from condition c join enc on enc.id = c.encounter_id
      where c.deleted_at is null and c.created_by is not null
        and not exists (select 1 from queue_entry q
                        where q.encounter_id = c.encounter_id and q.deleted_at is null and q.taken_by = c.created_by
                          and q.station in ('consultation', 'dental', 'theatre', 'nursing', 'beds', 'ultrasound'))
      group by 1, 2
    ), r as (
      select s.*, e.patient_id, e.arrived_at, e.reference, e.status, e.clinical_done_at, e.left_reason,
             visit_departments(e.id) as depts
      from seen s join enc e on e.id = s.encounter_id
    )
    select jsonb_agg(jsonb_build_object(
        'encounterId', r.encounter_id, 'visitAt', r.arrived_at, 'seenAt', r.seen_at, 'reference', r.reference,
        'patientId', p.id, 'patient', p.surname || ' ' || p.given_names, 'fileNo', p.file_number, 'sex', p.sex,
        'age', case when p.birth_date is not null
                    then extract(year from age((r.arrived_at at time zone 'Africa/Kigali')::date, p.birth_date))::integer end,
        'clinicianId', r.clinician_id, 'clinician', pr.full_name, 'clinicianRole', pr.role, 'desk', r.station,
        'department', (select string_agg(d.name, ', ' order by d.name) from department d where d.id = any (r.depts)),
        'diagnosis', (select string_agg(coalesce(c.icd10_code || ' ', '') || c.text, '; '
                                        order by (c.type = 'primary') desc, c.created_at)
                      from condition c where c.encounter_id = r.encounter_id and c.deleted_at is null),
        'prescriptions', (select count(*) from medication_request m
                          where m.encounter_id = r.encounter_id and m.deleted_at is null and m.cancelled_at is null
                            and coalesce(m.prescriber_id, m.created_by) = r.clinician_id)::integer,
        'tests', (select count(*) from service_request x
                  where x.encounter_id = r.encounter_id and x.deleted_at is null
                    and x.requester_id = r.clinician_id)::integer,
        'outcome', case
            when exists (select 1 from queue_entry q2
                         where q2.encounter_id = r.encounter_id and q2.deleted_at is null
                           and q2.referred_by = r.clinician_id and q2.taken_by is distinct from r.clinician_id
                           and q2.station in ('consultation', 'dental', 'theatre', 'nursing', 'beds')) then 'referred'
            when r.status = 'open' and r.clinical_done_at is null then 'open'
            when r.left_reason is not null
                 or (r.clinical_done_at is null
                     and not exists (select 1 from condition c where c.encounter_id = r.encounter_id
                                     and c.deleted_at is null and c.type = 'primary')) then 'left'
            else 'finished' end
      ) order by r.arrived_at desc, p.surname, pr.full_name)
    from r
    join patient p on p.id = r.patient_id
    join profiles pr on pr.id = r.clinician_id
    where (v_mgr or r.clinician_id = v_me or r.depts && v_heads)
      and (p_clinician is null or r.clinician_id = p_clinician)
      and (p_department is null or p_department = any (r.depts))
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- 11 · diagnoses (ICD-10)
-- Cases per diagnosis (its ICD-10 code, else its words) in the visits that arrived in the period:
-- a case = a visit with that diagnosis; new = the patient had not had it in an earlier visit,
-- follow-up = they had; by sex and age band (age on the day of the visit). The manager all; a
-- head their departments' visits; a doctor the diagnoses they wrote.
create or replace function report_diagnoses(
  p_from date, p_to date, p_department uuid default null, p_doctor uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_mgr boolean := is_manager();
  v_heads uuid[] := report_head_departments();
begin
  perform report_assert_clinical();
  perform report_assert_period(p_from, p_to);
  return coalesce((
    with c as (
      select c.encounter_id, upper(nullif(trim(c.icd10_code), '')) as code, trim(c.text) as text, c.type,
             c.created_by, e.patient_id, e.arrived_at, p.sex::text as sex,
             case when p.birth_date is not null
                  then extract(year from age((e.arrived_at at time zone 'Africa/Kigali')::date, p.birth_date))::integer end
               as age,
             visit_departments(e.id) as depts
      from condition c
      join encounter e on e.id = c.encounter_id and e.deleted_at is null
      join patient p on p.id = e.patient_id
      where c.deleted_at is null and (e.arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to
    ), v as (
      select c.*, coalesce(c.code, lower(c.text)) as k,
             exists (select 1 from condition c2 join encounter e2 on e2.id = c2.encounter_id and e2.deleted_at is null
                     where e2.patient_id = c.patient_id and e2.arrived_at < c.arrived_at and c2.deleted_at is null
                       and coalesce(upper(nullif(trim(c2.icd10_code), '')), lower(trim(c2.text)))
                           = coalesce(c.code, lower(c.text))) as follow_up
      from c
      where (v_mgr or c.created_by = v_me or c.depts && v_heads)
        and (p_doctor is null or c.created_by = p_doctor)
        and (p_department is null or p_department = any (c.depts))
    )
    select jsonb_agg(jsonb_build_object(
        'code', x.code, 'diagnosis', x.text, 'cases', x.cases, 'patients', x.patients,
        'newCases', x.new_cases, 'followUp', x.follow_up, 'primary', x.prim,
        'female', x.female, 'male', x.male, 'otherSex', x.cases - x.female - x.male,
        'age0to4', x.a0, 'age5to14', x.a5, 'age15to24', x.a15, 'age25to49', x.a25, 'age50plus', x.a50,
        'ageUnknown', x.au
      ) order by x.cases desc, x.text)
    from (
      select v.k, min(v.code) as code, mode() within group (order by v.text) as text,
             count(distinct v.encounter_id)::integer as cases,
             count(distinct v.patient_id)::integer as patients,
             count(distinct v.encounter_id) filter (where not v.follow_up)::integer as new_cases,
             count(distinct v.encounter_id) filter (where v.follow_up)::integer as follow_up,
             count(distinct v.encounter_id) filter (where v.type = 'primary')::integer as prim,
             count(distinct v.encounter_id) filter (where v.sex = 'female')::integer as female,
             count(distinct v.encounter_id) filter (where v.sex = 'male')::integer as male,
             count(distinct v.encounter_id) filter (where v.age < 5)::integer as a0,
             count(distinct v.encounter_id) filter (where v.age between 5 and 14)::integer as a5,
             count(distinct v.encounter_id) filter (where v.age between 15 and 24)::integer as a15,
             count(distinct v.encounter_id) filter (where v.age between 25 and 49)::integer as a25,
             count(distinct v.encounter_id) filter (where v.age >= 50)::integer as a50,
             count(distinct v.encounter_id) filter (where v.age is null)::integer as au
      from v group by v.k
    ) x
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- 12 · prescriptions
-- One row per prescribed medicine (prescription line) written in the period: how it is supplied
-- (the clinic's pharmacy, given here from a room store, bought outside) and where it stands
-- (given, part given, waiting, not given: the pharmacy had none, bought outside, cancelled). The
-- manager all; a head their departments' visits; the pharmacy desk all; a prescriber their own.
create or replace function report_prescriptions(
  p_from date, p_to date, p_supply text default null, p_prescriber uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_mgr boolean := is_manager();
  v_heads uuid[] := report_head_departments();
  v_rx boolean := may_use_desk('pharmacy');
begin
  if not v_rx then
    perform report_assert_clinical();
  end if;
  perform report_assert_period(p_from, p_to);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', m.id, 'at', m.created_at, 'encounterId', e.id, 'reference', e.reference,
        'patientId', p.id, 'patient', p.surname || ' ' || p.given_names, 'fileNo', p.file_number,
        'itemId', m.item_id, 'medicine', rx_label(m), 'code', coalesce(i.code, m.reference_code),
        'unit', i.selling_unit, 'packSize', case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end,
        'packUnit', i.pack_unit,
        'quantity', m.quantity,
        'given', case when m.supply = 'room' then case when m.given_at is not null then m.quantity else 0 end
                      when m.supply = 'pharmacy' then coalesce(m.quantity_given, 0) end,
        'supply', m.supply, 'status', st.status,
        'prescriberId', coalesce(m.prescriber_id, m.created_by), 'prescriber', pr.full_name,
        'dose', nullif(concat_ws(' · ', nullif(m.dose, ''), nullif(m.frequency, ''),
                                 case when m.duration_days is not null then m.duration_days || ' d' end,
                                 nullif(m.route, '')), ''),
        'instructions', m.instructions,
        'reason', coalesce(m.cancel_reason, m.not_given_reason, m.supply_reason)
      ) order by m.created_at desc, p.surname)
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.deleted_at is null
    join patient p on p.id = e.patient_id
    left join item i on i.id = m.item_id
    left join profiles pr on pr.id = coalesce(m.prescriber_id, m.created_by)
    cross join lateral (
      select case
               when m.cancelled_at is not null then 'cancelled'
               when m.supply = 'outside' then 'outside'
               when m.supply = 'room' then case when m.given_at is not null then 'given' else 'waiting' end
               when m.not_given_at is not null then 'not_given'
               when m.given_at is not null or coalesce(m.quantity_given, 0) >= ceil(m.quantity) then 'given'
               when coalesce(m.quantity_given, 0) > 0 then 'part'
               else 'waiting'
             end as status
    ) st
    where m.deleted_at is null
      and (m.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
      and (v_mgr or v_rx or coalesce(m.prescriber_id, m.created_by) = v_me
           or (cardinality(v_heads) > 0 and visit_departments(e.id) && v_heads))
      and (p_supply is null or p_supply = '' or m.supply = p_supply)
      and (p_prescriber is null or coalesce(m.prescriber_id, m.created_by) = p_prescriber)
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- 13 · tests and exams
-- One row per test asked in the period: its desk (laboratory, ultrasound, or the desk it is done
-- at), when the sample was taken (the first move past "ordered"), the result written and
-- validated, the turnaround (asked → validated, else → written, in minutes) and the result (its
-- conclusion, else its findings: only for the manager, a head in charge, the clinician who asked
-- for it and the desk that did it). Rows: the manager all; a head their departments' visits; the
-- laboratory / ultrasound desk the tests of their desk; a clinician the tests they asked for.
create or replace function report_tests(
  p_from date, p_to date, p_desk text default null, p_status text default null, p_requester uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_mgr boolean := is_manager();
  v_heads uuid[] := report_head_departments();
  v_lab boolean := may_use_desk('laboratory') and has_perm('orders.read');
  v_us boolean := may_use_desk('ultrasound') and has_perm('orders.read');
begin
  if not (v_lab or v_us) then
    perform report_assert_clinical();
  end if;
  perform report_assert_period(p_from, p_to);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', r.id, 'at', r.created_at, 'encounterId', e.id, 'reference', e.reference,
        'test', s.name_en, 'testFr', s.name_fr, 'testRw', s.name_kin, 'category', r.category, 'desk', k.desk,
        'urgent', r.priority <= 2, 'sampleId', r.sample_id,
        'patientId', p.id, 'patient', p.surname || ' ' || p.given_names, 'fileNo', p.file_number,
        'requesterId', r.requester_id, 'requester', rq.full_name, 'status', r.status,
        'sampleAt', (select min(a.at) from audit_event a
                     where a.entity = 'service_request' and a.entity_id = r.id
                       and a.after ->> 'status' in ('collected', 'in_process', 'resulted', 'verified')),
        'resultAt', d.created_at, 'verifiedAt', d.verified_at,
        'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
        'turnaround', case when d.id is not null
                           then round(extract(epoch from coalesce(d.verified_at, d.created_at) - r.created_at) / 60) end,
        'corrected', d.corrected_at is not null,
        'result', case when v.ok then coalesce(nullif(trim(d.impression), ''), nullif(trim(d.findings), '')) end
      ) order by r.created_at desc)
    from service_request r
    join encounter e on e.id = r.encounter_id and e.deleted_at is null
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    left join profiles rq on rq.id = r.requester_id
    cross join lateral (
      select case when r.station is not null then r.station::text
                  when r.category = 'imaging' then 'ultrasound' else 'laboratory' end as desk
    ) k
    cross join lateral (
      select v_mgr or r.requester_id = v_me
             or (k.desk = 'laboratory' and v_lab) or (k.desk = 'ultrasound' and v_us)
             or (cardinality(v_heads) > 0 and visit_departments(e.id) && v_heads) as ok
    ) v
    where r.deleted_at is null and v.ok
      and (r.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
      and (p_desk is null or p_desk = '' or k.desk = p_desk)
      and (p_status is null or p_status = '' or r.status::text = p_status)
      and (p_requester is null or r.requester_id = p_requester)
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- 14 · vital signs taken
-- One row per set of vital signs measured in the period (the measurements saved together: visit,
-- time, who measured, who typed them). flags: the measurements outside the usual adult limits
-- (temperature ≥ 37.5 or < 35.5 °C, SpO2 < 94 %, blood pressure ≥ 140/90 or systolic < 90 mmHg;
-- from 12 years: pulse > 100 or < 50, breathing > 24 or < 10 a minute). The values and flags are
-- clinical (the web offers them to clinical readers). Rows: the manager all; a head their
-- departments' visits; everyone the sets they measured or typed.
create or replace function report_vitals(p_from date, p_to date, p_taker uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_mgr boolean := is_manager();
  v_heads uuid[] := report_head_departments();
begin
  if not has_perm('vitals.write') then
    perform report_assert_clinical();
  end if;
  perform report_assert_period(p_from, p_to);
  return coalesce((
    with sets as (
      select o.encounter_id, o.effective_at, o.performer_id, o.created_by,
             count(*)::integer as n, jsonb_object_agg(o.code, o.value_num) as vals
      from observation o
      where o.deleted_at is null and o.removed_by is null and o.value_num is not null
        and (o.code in (select vt.code from vital_type vt) or o.code like 'custom\_%')
        and (o.effective_at at time zone 'Africa/Kigali')::date between p_from and p_to
      group by 1, 2, 3, 4
    ), r as (
      select s.*, e.patient_id, e.reference,
             (select case when p.birth_date is not null
                          then extract(year from age((s.effective_at at time zone 'Africa/Kigali')::date, p.birth_date))::integer end
              from patient p where p.id = e.patient_id) as age
      from sets s join encounter e on e.id = s.encounter_id and e.deleted_at is null
      where (v_mgr or s.performer_id = v_me or s.created_by = v_me
             or (cardinality(v_heads) > 0 and visit_departments(e.id) && v_heads))
        and (p_taker is null or s.performer_id = p_taker)
    )
    select jsonb_agg(jsonb_build_object(
        'encounterId', r.encounter_id, 'at', r.effective_at, 'reference', r.reference,
        'patientId', p.id, 'patient', p.surname || ' ' || p.given_names, 'fileNo', p.file_number,
        'sex', p.sex, 'age', r.age,
        'measuredById', r.performer_id, 'measuredBy', mb.full_name,
        'enteredById', r.created_by, 'enteredBy', eb.full_name,
        'onBehalf', r.created_by is distinct from r.performer_id,
        'count', r.n, 'values', r.vals, 'flags', f.flags
      ) order by r.effective_at desc)
    from r
    join patient p on p.id = r.patient_id
    left join profiles mb on mb.id = r.performer_id
    left join profiles eb on eb.id = r.created_by
    cross join lateral (
      select coalesce(jsonb_agg(x.flag), '[]'::jsonb) as flags from (
        select 'temp_high' as flag where (r.vals ->> 'temp')::numeric >= 37.5
        union all select 'temp_low' where (r.vals ->> 'temp')::numeric < 35.5
        union all select 'spo2_low' where (r.vals ->> 'spo2')::numeric < 94
        union all select 'bp_high' where (r.vals ->> 'bp_sys')::numeric >= 140 or (r.vals ->> 'bp_dia')::numeric >= 90
        union all select 'bp_low' where (r.vals ->> 'bp_sys')::numeric < 90
        union all select 'pulse_high' where coalesce(r.age, 99) >= 12 and (r.vals ->> 'pulse')::numeric > 100
        union all select 'pulse_low' where coalesce(r.age, 99) >= 12 and (r.vals ->> 'pulse')::numeric < 50
        union all select 'resp_high' where coalesce(r.age, 99) >= 12 and (r.vals ->> 'resp')::numeric > 24
        union all select 'resp_low' where coalesce(r.age, 99) >= 12 and (r.vals ->> 'resp')::numeric < 10
      ) x
    ) f
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- 15 · bookings and arrivals
-- One row per booking of the period (its time, else the preferred time, else when it was asked):
-- the patient or the contact, the phone, the practitioner, the service, the status as reception
-- says it (requested, approved, confirmed, arrived, with_clinician, seen, left_unseen, no_show,
-- cancelled, declined), where it came from (online = the website, reception, phone) and when the
-- patient arrived. The manager and reception: all; a practitioner: their own bookings.
create or replace function report_bookings(
  p_from date, p_to date, p_status text default null, p_practitioner uuid default null, p_source text default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_mgr boolean := is_manager();
  v_rec boolean := may_use_desk('reception');
  v_mine uuid[] := coalesce((select array_agg(pr.id) from practitioner pr
                             where pr.user_id = auth.uid() and pr.deleted_at is null), '{}'::uuid[]);
begin
  if auth.uid() is null or not (v_mgr or v_rec or cardinality(v_mine) > 0) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform report_assert_period(p_from, p_to);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', a.id, 'at', coalesce(a.starts_at, a.preferred_at), 'createdAt', a.created_at,
        'reference', a.reference,
        'patientId', p.id, 'patient', coalesce(p.surname || ' ' || p.given_names, a.contact_name),
        'fileNo', p.file_number, 'phone', coalesce(p.phone_1, a.contact_phone),
        'practitionerId', a.practitioner_id, 'bookedWith', coalesce(pr.title || ' ', '') || pr.names,
        'service', a.category, 'status', st.status, 'source', a.source,
        'arrivedAt', e.arrived_at, 'encounterId', e.id,
        'reason', a.reason,
        'cancelReason', case when a.cancel_reason like 'left_unseen%'
                             then nullif(regexp_replace(a.cancel_reason, '^left_unseen:?\s*', ''), '')
                             else a.cancel_reason end
      ) order by coalesce(a.starts_at, a.preferred_at, a.created_at))
    from appointment a
    left join patient p on p.id = a.patient_id
    left join practitioner pr on pr.id = a.practitioner_id
    left join lateral (select e.id, e.arrived_at from encounter e
                       where e.appointment_id = a.id and e.deleted_at is null
                       order by e.arrived_at limit 1) e on true
    cross join lateral (
      select case a.status::text
               when 'inquiry' then 'requested'
               when 'in_progress' then 'with_clinician'
               when 'completed' then 'seen'
               when 'rejected' then 'declined'
               when 'cancelled' then case when coalesce(a.cancel_reason, '') like 'left_unseen%'
                                          then 'left_unseen' else 'cancelled' end
               else a.status::text
             end as status
    ) st
    where a.deleted_at is null
      and (coalesce(a.starts_at, a.preferred_at, a.created_at) at time zone 'Africa/Kigali')::date between p_from and p_to
      and (v_mgr or v_rec or a.practitioner_id = any (v_mine))
      and (p_status is null or p_status = '' or st.status = p_status)
      and (p_practitioner is null or a.practitioner_id = p_practitioner)
      and (p_source is null or p_source = '' or a.source::text = p_source)
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- who may call what
revoke all on function report_head_departments(), report_assert_period(date, date), report_assert_stock(uuid),
  report_assert_clinical()
  from public, anon, authenticated;
revoke all on function report_stock_options(), report_stock_on_hand(uuid, boolean, integer),
  report_stock_sold(date, date, uuid, text, boolean), report_stock_movements(date, date, uuid, text),
  report_stock_deliveries(date, date, uuid), report_stock_transfers(date, date, uuid, text),
  report_stock_expiry(uuid, integer, boolean), report_stock_to_order(uuid),
  report_stock_write_offs(date, date, uuid), report_stock_outside(date, date),
  report_clinical_options(), report_patients_seen(date, date, uuid, uuid), report_diagnoses(date, date, uuid, uuid),
  report_prescriptions(date, date, text, uuid), report_tests(date, date, text, text, uuid),
  report_vitals(date, date, uuid), report_bookings(date, date, text, uuid, text)
  from public, anon;
grant execute on function report_stock_options(), report_stock_on_hand(uuid, boolean, integer),
  report_stock_sold(date, date, uuid, text, boolean), report_stock_movements(date, date, uuid, text),
  report_stock_deliveries(date, date, uuid), report_stock_transfers(date, date, uuid, text),
  report_stock_expiry(uuid, integer, boolean), report_stock_to_order(uuid),
  report_stock_write_offs(date, date, uuid), report_stock_outside(date, date),
  report_clinical_options(), report_patients_seen(date, date, uuid, uuid), report_diagnoses(date, date, uuid, uuid),
  report_prescriptions(date, date, text, uuid), report_tests(date, date, text, text, uuid),
  report_vitals(date, date, uuid), report_bookings(date, date, text, uuid, text)
  to authenticated;
