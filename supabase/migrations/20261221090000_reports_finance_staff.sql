-- 0111 · The report centre: the finance and staff reports.
--
-- Frank: every report is a table the person filters, whose columns they choose, with totals, groups
-- and subtotals, printed (PDF) and exported (Excel); each role prints its own reports. The report
-- centre (/app/reports) runs one function per report below; the web filters the rows further
-- (method, kind, insurer, search…) and adds the totals. Each function checks the rights again: a
-- report never shows more than the person may see on the screens.
--
--   report_payments      Revenue: one row per payment received (bills, debts, walk-in sales), with
--                        what was later given back from it (refunds are spread over the bill's
--                        payments, the latest payment first).
--   report_charges       Revenue by service: one row per charge line of the final bills and of the
--                        walk-in sales (optionally the bills of visits still open).
--   report_bills         One row per bill: shares, paid, given back, credited, balance, status.
--   report_debts         Visits that ended (or an earlier day's visit with nothing left to do) with
--                        money still due, as on the cash desk's "Unpaid bills".
--   report_refunds       Money given back.
--   report_counter_sales Walk-in sales (pharmacy and room stores).
--   report_cash_counts   The day closes, one row per cashier, day and payment method.
--   report_claims        What each insurer owes, per visit (final bills with an insurer share).
--   report_employees     The employees.
--   report_filter_options  The choices of the report filters (cashiers, staff, departments,
--                        insurers, stores, categories), within the person's rights.
--   Staff activity runs the existing staff_activity() (0086): the manager, or a head for their
--   department; money only for the manager.
--
-- Rights (money): the manager and anyone who reads the bills (billing.read: the cashier, reception)
-- see everything. Someone who only takes payments (payment.take), and the pharmacy that takes the
-- money of its walk-in sales, see their own payments, refunds and cash counts. Walk-in sales: the
-- pharmacy desk sees the pharmacy's sales; a room-store holder with "Sell to walk-in buyers from my
-- store" the sales of the stores they hold. A head (or assistant head) of a department sees the
-- charges of their department. Employees: the manager, every column; a head, the people of their
-- department without phone and e-mail. Anyone else: 42501.
--
-- Dates are Kigali days. Errcodes: 42501 not allowed.

-- ---------------------------------------------------------------- who may read the money
-- 'all' (the manager, billing.read), 'mine' (payment.take, the pharmacy taking walk-in payments:
-- their own rows), null (nobody). Internal.
create or replace function report_money_reach()
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when auth.uid() is null then null
    when is_manager() or has_perm('billing.read') then 'all'
    when has_perm('payment.take') or pharmacy_takes_money() then 'mine'
    else null
  end
$$;
revoke all on function report_money_reach() from public, anon, authenticated;

-- The departments the signed-in person heads or assists (active departments and person). Internal.
create or replace function report_my_head_departments()
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(sd.department_id order by d.sort_order, d.name), '{}')
  from staff_department sd
  join department d on d.id = sd.department_id and d.deleted_at is null
  join profiles me on me.id = sd.profile_id and me.active and me.deleted_at is null
  where sd.profile_id = auth.uid() and sd.position in ('head', 'assistant')
$$;
revoke all on function report_my_head_departments() from public, anon, authenticated;

-- The department a charge line counts for (as revenue_analysis, 0086): the service's department;
-- a medicine or supply, the pharmacy's. Internal.
create or replace function report_pharmacy_department()
returns uuid
language sql stable security definer set search_path = public
as $$
  select d.id from department d
  where d.active and d.deleted_at is null and 'pharmacy' = any (d.services)
  order by d.sort_order, d.name limit 1
$$;
revoke all on function report_pharmacy_department() from public, anon, authenticated;

-- ---------------------------------------------------------------- 1 revenue: the payments
-- One row per payment taken in the period (not cancelled). kind: 'visit' (a visit's bill), 'debt'
-- (paid after the visit was closed), 'pharmacy' (a walk-in sale of a pharmacy store), 'walkin' (a
-- walk-in sale of a room store). refunded: what was given back from this payment (the bill's
-- refunds, taken from its latest payments first), so net = amount − refunded.
create or replace function report_payments(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_me uuid := auth.uid();
  v_reach text := report_money_reach();
  v_rows jsonb;
begin
  if v_reach is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  select coalesce(jsonb_agg(x.j order by x.at, x.id), '[]'::jsonb) into v_rows
  from (
    select pa.paid_at as at, pa.id, jsonb_build_object(
        'id', pa.id,
        'at', pa.paid_at,
        'receiptNo', pa.receipt_no,
        'billNo', coalesce(i.number, i.provisional_no, cs.number),
        'visitNo', e.reference,
        'encounterId', e.id,
        'counterSaleId', cs.id,
        'patient', coalesce(p.surname || ' ' || p.given_names, cs.buyer_name),
        'fileNumber', p.file_number,
        'kind', case
                  when cs.id is not null then case when is_room_type(l.type) then 'walkin' else 'pharmacy' end
                  when e.closed_at is not null and pa.paid_at > e.closed_at then 'debt'
                  else 'visit'
                end,
        'method', pa.method::text,
        'reference', pa.reference,
        'amount', pa.amount,
        'refunded', case when pa.invoice_id is null then 0 else greatest(0, least(pa.amount,
          coalesce((select sum(r.amount) from refund r where r.invoice_id = pa.invoice_id and r.deleted_at is null), 0)
          - coalesce((select sum(p2.amount) from payment p2
                      where p2.invoice_id = pa.invoice_id and p2.deleted_at is null
                        and (p2.paid_at > pa.paid_at or (p2.paid_at = pa.paid_at and p2.id > pa.id))), 0))) end,
        'cashierId', pa.cashier_id,
        'cashier', pr.full_name,
        'insurerId', py.id,
        'insurer', py.name,
        'store', l.name,
        'counted', pa.day_close_id is not null
      ) as j
    from payment pa
    left join invoice i on i.id = pa.invoice_id
    left join encounter e on e.id = i.encounter_id
    left join patient p on p.id = e.patient_id
    left join payer py on py.id = i.payer_id and py.type <> 'cash'
    left join counter_sale cs on cs.id = pa.counter_sale_id
    left join stock_location l on l.id = cs.location_id
    left join profiles pr on pr.id = pa.cashier_id
    where pa.deleted_at is null
      and (pa.paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
      and (v_reach = 'all' or pa.cashier_id = v_me)
    order by pa.paid_at, pa.id
    limit 20000
  ) x;
  return jsonb_build_object('from', v_from, 'to', v_to, 'scope', v_reach, 'rows', v_rows);
end
$$;
revoke all on function report_payments(date, date) from public, anon;
grant execute on function report_payments(date, date) to authenticated;

-- ---------------------------------------------------------------- 2 revenue by service: the charges
-- One row per charge line: the lines of the final bills (posted or credited, dated when the bill
-- was posted) and of the paid walk-in sales (dated when paid); with p_open also the bills of visits
-- still open and the walk-in sales not yet paid (dated when charged). quantity is as charged (a bill
-- line by the pack: packs; a walk-in sale line: pieces), units always the pieces; total is the
-- line's amount (a walk-in line: its line_total, packs at the pack price). The manager and
-- billing.read: every department (or p_department); a head or assistant head: their departments only.
create or replace function report_charges(
  p_from date default null,
  p_to date default null,
  p_department uuid default null,
  p_open boolean default false
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_all boolean := auth.uid() is not null and (is_manager() or has_perm('billing.read'));
  v_heads uuid[] := report_my_head_departments();
  v_scope uuid[];
  v_pharmacy uuid := report_pharmacy_department();
  v_open boolean := coalesce(p_open, false);
  v_rows jsonb;
begin
  if auth.uid() is null or not (v_all or cardinality(v_heads) > 0) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not v_all and p_department is not null and not (p_department = any (v_heads)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- null = every department (and the lines of none)
  v_scope := case when p_department is not null then array[p_department]
                  when v_all then null
                  else v_heads end;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;

  with lines as (
    select l.id, 'bill' as source,
           case when i.status = 'draft' then l.created_at else coalesce(i.posted_at, l.created_at) end as at,
           l.created_at as charged_at,
           coalesce(i.number, i.provisional_no) as bill_no, i.status::text as bill_status,
           e.reference as visit_no, e.id as encounter_id,
           p.surname || ' ' || p.given_names as patient, p.file_number,
           l.description, l.service_id, l.item_id, coalesce(sv.code, it.code) as code,
           c.id as category_id,
           case when l.item_id is not null then case when it.kind = 'supply' then 'supply' else 'medicine' end
                else coalesce(c.base_group::text, 'other') end as category_key,
           c.name_en as category_en, c.name_kin as category_kin, c.name_fr as category_fr,
           case when l.item_id is not null then v_pharmacy else sv.department_id end as department_id,
           l.office::text as desk, null::text as store,
           l.quantity::numeric as quantity, l.pack_size, l.quantity * coalesce(l.pack_size, 1) as units,
           l.unit_price, coalesce(l.list_price, l.unit_price) as list_price,
           case when coalesce(l.list_price, l.unit_price) > l.unit_price
                then round((l.list_price - l.unit_price) * l.quantity) else 0 end as discount,
           l.discount_pct, l.discount_reason,
           round(l.unit_price * l.quantity) as total, l.insurer_share, l.patient_share,
           py.id as insurer_id, py.name as insurer,
           l.entered_by as entered_by_id
    from invoice_line l
    join invoice i on i.id = l.invoice_id and i.deleted_at is null
    join encounter e on e.id = i.encounter_id
    join patient p on p.id = e.patient_id
    left join service sv on sv.id = l.service_id
    left join service_category c on c.id = sv.category_id
    left join item it on it.id = l.item_id
    left join payer py on py.id = i.payer_id and py.type <> 'cash'
    where l.deleted_at is null
      and (i.status in ('posted', 'credited') or (v_open and i.status = 'draft'))
    union all
    select x.id, 'sale',
           case when s.status = 'open' then x.created_at else coalesce(s.paid_at, x.created_at) end,
           x.created_at,
           s.number, s.status, null, null,
           s.buyer_name, null,
           item_label(x.item_id), null, x.item_id, it.code,
           null, case when it.kind = 'supply' then 'supply' else 'medicine' end,
           null, null, null,
           case when is_room_type(st.type) then st.department_id else v_pharmacy end,
           case when is_room_type(st.type) then null else 'pharmacy' end, st.name,
           x.quantity::numeric, x.pack_size, x.quantity::numeric,
           x.unit_price, x.unit_price, 0, 0, null,
           x.line_total, 0, x.line_total,
           null, null,
           s.created_by
    from counter_sale_line x
    join counter_sale s on s.id = x.sale_id and s.deleted_at is null
    join stock_location st on st.id = s.location_id
    left join item it on it.id = x.item_id
    where x.deleted_at is null
      and (s.status in ('paid', 'handed_over') or (v_open and s.status = 'open'))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', k.id, 'source', k.source, 'at', k.at, 'chargedAt', k.charged_at,
      'billNo', k.bill_no, 'billStatus', k.bill_status, 'visitNo', k.visit_no, 'encounterId', k.encounter_id,
      'patient', k.patient, 'fileNumber', k.file_number,
      'description', k.description, 'serviceId', k.service_id, 'itemId', k.item_id, 'code', k.code,
      'categoryId', k.category_id, 'categoryKey', k.category_key,
      'categoryEn', k.category_en, 'categoryKin', k.category_kin, 'categoryFr', k.category_fr,
      'departmentId', k.department_id, 'department', d.name, 'desk', k.desk, 'store', k.store,
      'quantity', k.quantity, 'packSize', k.pack_size, 'units', k.units,
      'unitPrice', k.unit_price, 'listPrice', k.list_price,
      'discount', k.discount, 'discountPct', k.discount_pct, 'discountReason', k.discount_reason,
      'total', k.total, 'insurerShare', k.insurer_share, 'patientShare', k.patient_share,
      'insurerId', k.insurer_id, 'insurer', k.insurer,
      'enteredById', k.entered_by_id, 'enteredBy', pr.full_name
    ) order by k.at, k.id), '[]'::jsonb)
  into v_rows
  from (
    select * from lines
    where (lines.at at time zone 'Africa/Kigali')::date between v_from and v_to
      and (v_scope is null or lines.department_id = any (v_scope))
    order by lines.at, lines.id
    limit 20000
  ) k
  left join department d on d.id = k.department_id
  left join profiles pr on pr.id = k.entered_by_id;
  return jsonb_build_object('from', v_from, 'to', v_to,
                            'scope', case when v_scope is null then 'all' else 'department' end,
                            'departments', to_jsonb(coalesce(v_scope, '{}')), 'rows', v_rows);
end
$$;
revoke all on function report_charges(date, date, uuid, boolean) from public, anon;
grant execute on function report_charges(date, date, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------- 3 bills
-- One row per bill with charges, dated when posted (a bill of a visit still open: when the visit
-- began). status: open (visit still open), paid (nothing left to pay), part (part paid), unpaid,
-- credited. The manager and billing.read.
create or replace function report_bills(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_rows jsonb;
begin
  if auth.uid() is null or not (is_manager() or has_perm('billing.read')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'billNo', b.bill_no, 'at', b.at, 'visitAt', b.visit_at, 'postedAt', b.posted_at,
      'visitNo', b.visit_no, 'encounterId', b.encounter_id, 'visitOpen', b.visit_open,
      'patient', b.patient, 'fileNumber', b.file_number,
      'insurerId', b.insurer_id, 'insurer', b.insurer, 'memberNo', b.member_no,
      'total', b.total, 'insurerShare', b.insurer_share, 'patientShare', b.patient_share,
      'paid', b.paid, 'refunded', b.refunded, 'credited', b.credited, 'balance', b.balance,
      'lines', b.lines,
      'status', case when b.invoice_status = 'credited' then 'credited'
                     when b.balance <= 0 then 'paid'
                     when b.invoice_status = 'draft' and b.visit_open then 'open'
                     when b.paid - b.refunded > 0 then 'part'
                     else 'unpaid' end
    ) order by b.at, b.id), '[]'::jsonb)
  into v_rows
  from (
    select i.id, coalesce(i.number, i.provisional_no) as bill_no, i.status::text as invoice_status,
           coalesce(i.posted_at, e.arrived_at) as at, e.arrived_at as visit_at, i.posted_at,
           e.reference as visit_no, e.id as encounter_id, e.status = 'open' as visit_open,
           p.surname || ' ' || p.given_names as patient, p.file_number,
           py.id as insurer_id, py.name as insurer, cv.member_number as member_no,
           i.total, i.insurer_share, i.patient_share,
           coalesce((select sum(y.amount) from payment y where y.invoice_id = i.id and y.deleted_at is null), 0) as paid,
           coalesce((select sum(r.amount) from refund r where r.invoice_id = i.id and r.deleted_at is null), 0) as refunded,
           coalesce((select sum(c.patient_amount) from credit_note c where c.invoice_id = i.id and c.deleted_at is null), 0) as credited,
           invoice_balance(i.id) as balance,
           (select count(*) from invoice_line l where l.invoice_id = i.id and l.deleted_at is null) as lines
    from invoice i
    join encounter e on e.id = i.encounter_id and e.deleted_at is null
    join patient p on p.id = e.patient_id
    left join payer py on py.id = i.payer_id and py.type <> 'cash'
    left join coverage cv on cv.id = i.coverage_id
    where i.deleted_at is null and i.total > 0
      and (coalesce(i.posted_at, e.arrived_at) at time zone 'Africa/Kigali')::date between v_from and v_to
    order by coalesce(i.posted_at, e.arrived_at), i.id
    limit 20000
  ) b;
  return jsonb_build_object('from', v_from, 'to', v_to, 'rows', v_rows);
end
$$;
revoke all on function report_bills(date, date) from public, anon;
grant execute on function report_bills(date, date) to authenticated;

-- ---------------------------------------------------------------- 4 unpaid bills (debts)
-- The visits of the period (by the day they began) that ended with money due, and the visits of
-- earlier days still open with money due and nothing left to do (the rule of unpaid_debts). The
-- manager and billing.read.
create or replace function report_debts(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_rows jsonb;
begin
  if auth.uid() is null or not (is_manager() or has_perm('billing.read')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  select coalesce(jsonb_agg(x.j order by x.at desc, x.id), '[]'::jsonb) into v_rows
  from (
    select coalesce(e.arrived_at, e.created_at) as at, e.id, jsonb_build_object(
        'id', e.id, 'encounterId', e.id, 'patientId', p.id,
        'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
        'phone', coalesce(p.phone_1, p.phone_2),
        'visitNo', e.reference, 'visitAt', coalesce(e.arrived_at, e.created_at), 'closedAt', e.closed_at,
        'billNo', coalesce(i.number, i.provisional_no),
        'insurerId', py.id, 'insurer', py.name,
        'total', i.patient_share,
        'paid', (select coalesce(sum(y.amount), 0) from payment y where y.invoice_id = i.id and y.deleted_at is null),
        'due', invoice_balance(i.id),
        'days', v_today - (coalesce(e.closed_at, e.arrived_at, e.created_at) at time zone 'Africa/Kigali')::date,
        'status', case when e.status = 'open' then 'open' when e.left_reason is not null then 'left' else 'closed' end,
        'reason', e.left_reason,
        'closedBy', pr.full_name
      ) as j
    from encounter e
    join invoice i on i.encounter_id = e.id and i.deleted_at is null and i.status <> 'credited'
    join patient p on p.id = e.patient_id
    left join payer py on py.id = i.payer_id and py.type <> 'cash'
    left join profiles pr on pr.id = e.closed_by
    where e.deleted_at is null and invoice_balance(i.id) > 0
      and (coalesce(e.arrived_at, e.created_at) at time zone 'Africa/Kigali')::date between v_from and v_to
      and (e.status = 'closed'
           or (e.status = 'open'
               and (coalesce(e.arrived_at, e.created_at) at time zone 'Africa/Kigali')::date < v_today
               and not visit_work_left(e.id)))
    order by coalesce(e.arrived_at, e.created_at) desc, e.id
    limit 20000
  ) x;
  return jsonb_build_object('from', v_from, 'to', v_to, 'rows', v_rows);
end
$$;
revoke all on function report_debts(date, date) from public, anon;
grant execute on function report_debts(date, date) to authenticated;

-- ---------------------------------------------------------------- 5 refunds
-- Money given back in the period. The manager and billing.read: every refund; payment.take: their own.
create or replace function report_refunds(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_me uuid := auth.uid();
  v_reach text := report_money_reach();
  v_rows jsonb;
begin
  if v_reach is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  select coalesce(jsonb_agg(x.j order by x.at, x.id), '[]'::jsonb) into v_rows
  from (
    select r.refunded_at as at, r.id, jsonb_build_object(
        'id', r.id, 'at', r.refunded_at, 'amount', r.amount, 'method', r.method::text,
        'reference', r.reference, 'reason', r.reason,
        'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
        'visitNo', e.reference, 'encounterId', e.id, 'billNo', coalesce(i.number, i.provisional_no),
        'cashierId', r.cashier_id, 'cashier', pr.full_name
      ) as j
    from refund r
    join invoice i on i.id = r.invoice_id
    join encounter e on e.id = i.encounter_id
    join patient p on p.id = e.patient_id
    left join profiles pr on pr.id = r.cashier_id
    where r.deleted_at is null
      and (r.refunded_at at time zone 'Africa/Kigali')::date between v_from and v_to
      and (v_reach = 'all' or r.cashier_id = v_me)
    order by r.refunded_at, r.id
    limit 20000
  ) x;
  return jsonb_build_object('from', v_from, 'to', v_to, 'scope', v_reach, 'rows', v_rows);
end
$$;
revoke all on function report_refunds(date, date) from public, anon;
grant execute on function report_refunds(date, date) to authenticated;

-- ---------------------------------------------------------------- 6 walk-in sales
-- The counter sales written in the period. The manager and billing.read: every store; the
-- pharmacy desk and the pharmacist: the pharmacy's sales; a holder with stock.sell_walkin: the
-- sales of the stores they hold.
create or replace function report_counter_sales(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_me uuid := auth.uid();
  v_all boolean := v_me is not null and (is_manager() or has_perm('billing.read'));
  v_pharm boolean := v_me is not null and (stock_admin() or pharmacy_takes_money());
  v_rooms boolean := v_me is not null and has_perm('stock.sell_walkin');
  v_rows jsonb;
begin
  if not (v_all or v_pharm or v_rooms) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  select coalesce(jsonb_agg(x.j order by x.at, x.id), '[]'::jsonb) into v_rows
  from (
    select s.created_at as at, s.id, jsonb_build_object(
        'id', s.id, 'number', s.number, 'at', s.created_at, 'status', s.status,
        'buyer', s.buyer_name, 'phone', s.buyer_phone,
        'storeId', l.id, 'store', l.name, 'roomStore', is_room_type(l.type),
        'total', s.total, 'note', s.note,
        'lines', (select count(*) from counter_sale_line x where x.sale_id = s.id and x.deleted_at is null),
        'units', (select coalesce(sum(x.quantity), 0) from counter_sale_line x where x.sale_id = s.id and x.deleted_at is null),
        'items', (select string_agg(item_label(x.item_id) || ' × ' || x.quantity, '; ' order by x.created_at, x.id)
                  from counter_sale_line x where x.sale_id = s.id and x.deleted_at is null),
        'paidAt', s.paid_at, 'method', pa.method::text, 'receiptNo', pa.receipt_no, 'reference', pa.reference,
        'cashierId', pa.cashier_id, 'cashier', pc.full_name,
        'sellerId', s.created_by, 'seller', ps.full_name,
        'handedOverAt', s.handed_over_at, 'handedOverBy', ph.full_name,
        'cancelledAt', s.cancelled_at, 'cancelReason', s.cancel_reason
      ) as j
    from counter_sale s
    join stock_location l on l.id = s.location_id
    left join payment pa on pa.id = s.payment_id and pa.deleted_at is null
    left join profiles pc on pc.id = pa.cashier_id
    left join profiles ps on ps.id = s.created_by
    left join profiles ph on ph.id = s.handed_over_by
    where s.deleted_at is null
      and (s.created_at at time zone 'Africa/Kigali')::date between v_from and v_to
      and (v_all
           or (v_pharm and not is_room_type(l.type))
           or (v_rooms and is_room_type(l.type) and holds_store(v_me, l.id)))
    order by s.created_at, s.id
    limit 20000
  ) x;
  return jsonb_build_object('from', v_from, 'to', v_to,
                            'scope', case when v_all then 'all' else 'stores' end, 'rows', v_rows);
end
$$;
revoke all on function report_counter_sales(date, date) from public, anon;
grant execute on function report_counter_sales(date, date) to authenticated;

-- ---------------------------------------------------------------- 7 cash counts
-- The day closes of the period, one row per cashier, day and payment method: expected (payments
-- less refunds), counted, difference (counted − expected). The manager and billing.read: everyone;
-- payment.take and the pharmacy: their own.
create or replace function report_cash_counts(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_me uuid := auth.uid();
  v_reach text := report_money_reach();
  v_rows jsonb;
begin
  if v_reach is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id::text || ':' || c.method, 'closeId', c.id, 'day', c.date, 'at', c.updated_at,
      'cashierId', c.cashier_id, 'cashier', c.cashier, 'method', c.method,
      'expected', c.expected, 'counted', c.counted, 'difference', c.counted - c.expected,
      'variance', c.variance, 'note', c.note
    ) order by c.date, c.cashier, c.method), '[]'::jsonb)
  into v_rows
  from (
    select d.id, d.date, d.updated_at, d.cashier_id, pr.full_name as cashier, d.variance, d.note, m.method,
           coalesce(nullif(d.expected ->> m.method, '')::numeric, 0) as expected,
           coalesce(nullif(d.counted ->> m.method, '')::numeric, 0) as counted
    from day_close d
    left join profiles pr on pr.id = d.cashier_id
    cross join lateral (
      select k as method from jsonb_object_keys(case when jsonb_typeof(d.expected) = 'object' then d.expected else '{}'::jsonb end) k
      union
      select k from jsonb_object_keys(case when jsonb_typeof(d.counted) = 'object' then d.counted else '{}'::jsonb end) k
    ) m
    where d.deleted_at is null and d.date between v_from and v_to
      and (v_reach = 'all' or d.cashier_id = v_me)
    order by d.date, pr.full_name, m.method
    limit 20000
  ) c;
  return jsonb_build_object('from', v_from, 'to', v_to, 'scope', v_reach, 'rows', v_rows);
end
$$;
revoke all on function report_cash_counts(date, date) from public, anon;
grant execute on function report_cash_counts(date, date) to authenticated;

-- ---------------------------------------------------------------- 8 insurer claims
-- The final bills of the period (dated when posted) with an insurer share: what each insurer owes,
-- per visit, and where its claim stands. The manager and billing.read.
create or replace function report_claims(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_rows jsonb;
begin
  if auth.uid() is null or not (is_manager() or has_perm('billing.read')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  select coalesce(jsonb_agg(x.j order by x.insurer, x.at, x.id), '[]'::jsonb) into v_rows
  from (
    select py.name as insurer, i.posted_at as at, i.id, jsonb_build_object(
        'id', i.id, 'insurerId', py.id, 'insurer', py.name,
        'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
        'memberNo', coalesce(cl.member_number, cv.member_number),
        'visitNo', e.reference, 'encounterId', e.id, 'visitAt', e.arrived_at,
        'billNo', i.number, 'postedAt', i.posted_at, 'billStatus', i.status::text,
        'total', i.total, 'insurerShare', i.insurer_share, 'patientShare', i.patient_share,
        'coveragePct', pl.coverage_pct,
        'claimed', coalesce(cl.amount, i.insurer_share),
        'status', coalesce(cl.status::text, 'open'),
        'batchNo', cb.number, 'rejection', cl.rejection_reason
      ) as j
    from invoice i
    join payer py on py.id = i.payer_id and py.type <> 'cash'
    join encounter e on e.id = i.encounter_id
    join patient p on p.id = e.patient_id
    left join coverage cv on cv.id = i.coverage_id
    left join plan pl on pl.id = cv.plan_id
    left join claim cl on cl.invoice_id = i.id and cl.deleted_at is null
    left join claim_batch cb on cb.id = cl.batch_id
    where i.deleted_at is null and i.status in ('posted', 'credited') and i.insurer_share > 0
      and (i.posted_at at time zone 'Africa/Kigali')::date between v_from and v_to
    order by py.name, i.posted_at, i.id
    limit 20000
  ) x;
  return jsonb_build_object('from', v_from, 'to', v_to, 'rows', v_rows);
end
$$;
revoke all on function report_claims(date, date) from public, anon;
grant execute on function report_claims(date, date) to authenticated;

-- ---------------------------------------------------------------- 9 employees
-- The employees (former ones, deleted, are left out as on the Employees page). The manager: every
-- employee and column (or one department's people). A head or assistant head: the people of their
-- departments, without phone, e-mail and username.
create or replace function report_employees(p_department uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := auth.uid() is not null and is_manager();
  v_heads uuid[] := report_my_head_departments();
  v_scope uuid[];
  v_rows jsonb;
begin
  if auth.uid() is null or not (v_manager or cardinality(v_heads) > 0) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not v_manager and p_department is not null and not (p_department = any (v_heads)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_scope := case when p_department is not null then array[p_department]
                  when v_manager then null
                  else v_heads end;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'staffId', p.staff_id, 'fullName', p.full_name,
      'username', case when v_manager then p.username end,
      'role', p.role::text, 'specialty', p.specialty,
      'departments', coalesce((
        select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'position', sd.position)
                         order by (sd.department_id = p.department_id) desc, d.sort_order, d.name)
        from staff_department sd join department d on d.id = sd.department_id and d.deleted_at is null
        where sd.profile_id = p.id), '[]'::jsonb),
      'desks', to_jsonb(desks_of(p.id)),
      'phone', case when v_manager then p.phone end,
      'email', case when v_manager then p.email end,
      'registrationNo', p.registration_no, 'registrationBody', p.registration_body,
      'active', p.active, 'deactivatedAt', p.deactivated_at, 'createdAt', p.created_at,
      'lastSignInAt', p.last_sign_in_at, 'mustChangePin', p.must_change_pin
    ) order by p.active desc, p.full_name), '[]'::jsonb)
  into v_rows
  from profiles p
  where p.deleted_at is null
    and (v_scope is null or exists (select 1 from staff_department sd
                                    where sd.profile_id = p.id and sd.department_id = any (v_scope)));
  return jsonb_build_object('scope', case when v_manager then 'all' else 'department' end,
                            'departments', to_jsonb(coalesce(v_scope, '{}')), 'rows', v_rows);
end
$$;
revoke all on function report_employees(uuid) from public, anon;
grant execute on function report_employees(uuid) to authenticated;

-- ---------------------------------------------------------------- the filters' choices
-- What the report filters offer, within the person's rights: the cashiers (who took a payment,
-- gave money back or counted cash; only themselves for payment.take), the staff (everyone for the
-- manager and billing.read, a head's departments, else themselves), the departments, the insurers,
-- the stores of walk-in sales and the service categories.
create or replace function report_filter_options()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_manager boolean := v_me is not null and is_manager();
  v_all boolean := v_me is not null and (is_manager() or has_perm('billing.read'));
  v_heads uuid[] := report_my_head_departments();
  v_pharm boolean := v_me is not null and (stock_admin() or pharmacy_takes_money());
  v_rooms boolean := v_me is not null and has_perm('stock.sell_walkin');
begin
  if v_me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'cashiers', coalesce((
      select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.full_name) order by pr.full_name)
      from profiles pr
      where (v_all or pr.id = v_me)
        and (exists (select 1 from payment y where y.cashier_id = pr.id)
             or exists (select 1 from refund r where r.cashier_id = pr.id)
             or exists (select 1 from day_close d where d.cashier_id = pr.id))), '[]'::jsonb),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.full_name, 'role', pr.role::text,
                                          'active', pr.active and pr.deleted_at is null)
                       order by pr.full_name)
      from profiles pr
      where v_all or pr.id = v_me
         or exists (select 1 from staff_department sd where sd.profile_id = pr.id and sd.department_id = any (v_heads))),
      '[]'::jsonb),
    'departments', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) order by d.sort_order, d.name)
      from department d
      where d.deleted_at is null and ((v_all and d.active) or d.id = any (v_heads))), '[]'::jsonb),
    'insurers', coalesce((
      select jsonb_agg(jsonb_build_object('id', py.id, 'name', py.name) order by py.name)
      from payer py where py.deleted_at is null and py.type <> 'cash'), '[]'::jsonb),
    'stores', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'roomStore', is_room_type(l.type))
                       order by is_room_type(l.type), l.name)
      from stock_location l
      where l.deleted_at is null and (l.type = 'pharmacy' or is_room_type(l.type))
        and (v_all
             or (v_pharm and not is_room_type(l.type))
             or (v_rooms and is_room_type(l.type) and holds_store(v_me, l.id)))), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'key', coalesce(c.base_group::text, 'other'),
                                          'nameEn', c.name_en, 'nameKin', c.name_kin, 'nameFr', c.name_fr)
                       order by c.sort, c.name_en)
      from service_category c where c.deleted_at is null), '[]'::jsonb)
  );
end
$$;
revoke all on function report_filter_options() from public, anon;
grant execute on function report_filter_options() to authenticated;
