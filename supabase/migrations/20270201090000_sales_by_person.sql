-- 0174: the sales report answers whoever holds the Pharmacy desk, and says who sold or gave
-- each medicine.
--
-- The owner (2026-11-16): the person he marked keeper (a doctor) saw zeros on Stock › Reports
-- while the manager saw figures: stock_sales asked for the role permission stock.read as well
-- as the desk, and a doctor's role has no stock.read. Now the desk (stock_admin) is enough, as
-- for the stock page itself. And the report must show who did each transaction: every sale and
-- hand-out of the period is listed (the patient or buyer, the item, the quantity, the amount,
-- who sold or gave it) and summed per person.

create or replace function stock_sales(p_from date, p_to date)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with sold as (
    select l.item_id, (l.quantity * coalesce(l.pack_size, 1))::numeric as units, round(l.quantity * l.unit_price) as revenue
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
  ),
  -- 0174: every line, with who it was for and who sold or gave it
  lines as (
    select l.created_at as at, 'visit'::text as kind,
           i.name_generic || coalesce(' ' || i.strength, '') as item,
           (l.quantity * coalesce(l.pack_size, 1))::numeric as units,
           round(l.quantity * l.unit_price) as amount,
           trim(coalesce(pt.surname, '') || ' ' || coalesce(pt.given_names, '')) as who,
           coalesce(l.performed_by, l.created_by) as by_id,
           inv.number as ref
    from invoice_line l
    join invoice inv on inv.id = l.invoice_id and inv.status <> 'credited'
    join item i on i.id = l.item_id
    left join encounter e on e.id = inv.encounter_id
    left join patient pt on pt.id = e.patient_id
    where l.deleted_at is null and l.item_id is not null
      and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    union all
    select s.handed_over_at, 'walkin', i.name_generic || coalesce(' ' || i.strength, ''),
           x.quantity, x.line_total, s.buyer_name,
           coalesce(s.handed_over_by, s.created_by), s.number
    from counter_sale_line x
    join counter_sale s on s.id = x.sale_id
    join item i on i.id = x.item_id
    where x.deleted_at is null and s.deleted_at is null and s.status = 'handed_over'
      and (s.handed_over_at at time zone 'Africa/Kigali')::date between p_from and p_to
  ),
  named as (
    select ln.*, pr.full_name as by_name from lines ln left join profiles pr on pr.id = ln.by_id
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
                   left join batch b on b.id = s.batch_id where s.quantity > 0),
    -- 0174: who sold or gave, and every line (the latest first, at most 2,000)
    'byPerson', coalesce((select jsonb_agg(jsonb_build_object(
        'id', n.by_id, 'name', coalesce(n.by_name, '—'), 'lines', n.lines, 'units', n.units, 'amount', n.amount,
        'given', n.given, 'sold', n.sold
      ) order by n.amount desc, n.by_name)
      from (select by_id, by_name, count(*)::int as lines, sum(units) as units, sum(amount) as amount,
                   sum(amount) filter (where kind = 'visit') as given, sum(amount) filter (where kind = 'walkin') as sold
            from named group by by_id, by_name) n), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
        'at', n.at, 'kind', n.kind, 'item', n.item, 'units', n.units, 'amount', n.amount,
        'who', n.who, 'by', coalesce(n.by_name, '—'), 'ref', n.ref
      ) order by n.at desc)
      from (select * from named order by at desc limit 2000) n), '[]'::jsonb)
  )
  -- 0174: the desk is enough (the role permission stock.read as well)
  where stock_admin() or has_perm('stock.read')
$$;
