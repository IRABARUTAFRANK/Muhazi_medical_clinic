-- 0087 · Every switch of "Who may do what" decides, in the database too.
--
-- Frank: "I have allowed and disallowed some features for nurse but still nothing happened, they
-- are still there, fix it also." The manager switches a feature on or off for a role, or makes an
-- exception for one employee (Settings → Who may do what). Most functions already asked has_perm()
-- (the employee's exception wins, else the role); these did not, or asked the wrong thing:
--
--   * A  TAKE PAYMENTS (payment.take) decides every money act at the desk. record_payment,
--        post_invoice, refund_payment and void_payment accepted billing.write instead, so a cashier
--        switched off could still record, refund and cancel payments by calling them. Now
--        payment.take (the manager as before for refunds, cancellations and posting). The cash
--        count (close_cash_day) is for those who take payments, and for anyone switched off during
--        the day who still has payments of that day to count.
--   * B  SWITCHED ON, IT WORKS. Someone given "Take payments" whose role does not read the money
--        (a nurse, a pharmacist…) now reads what taking a payment needs: the bills, their lines,
--        the payments (paid, receipt), the credit notes (refunds due); cashier_summary shows the
--        cashier and reception the whole desk as before, and anyone else allowed to take payments
--        their own payments, refunds and cash count with the bills waiting to be paid.
--   * C  TEST RESULTS (orders.write). The laboratory and ultrasound desks come with the department
--        whatever the switch, so record_result, set_request_status and correct_result accepted the
--        desk alone: they now also need orders.write there.
--   * D  BOOKINGS (appointment.approve). Someone given "Approve bookings" whose role does not read
--        bookings now sees the requests and the day's bookings (inquiries_open, appointments_day,
--        appointment_detail, the appointment rows).
--   * E  STOCK (stock.write). The pharmacy's stock was managed by the pharmacy desk alone
--        (stock_admin), so the switch did nothing. stock_manager() = the manager, or the pharmacy
--        desk AND stock.write: receiving deliveries, sending to room stores and cancelling those
--        notes, confirming returns, declining refills, counts and write-offs of the pharmacy,
--        moving stock, pharmacy stores and room minimums. Dispensing, counter sales and reading
--        stay with the pharmacy desk (stock_admin); a room store's holders keep their own work.
--
--   * F  VITAL SIGNS (vitals.write) were already enforced (record_vitals, and the triage desk that
--        send_from_triage needs comes only with vitals.write); both now say why they refuse.
--
-- The desks still apply on top (a desk feature needs the desk and the switch); money never comes
-- from a desk. my_permissions() already returns the effective switches (exception, else role, or
-- the doctor being covered): unchanged.
--
-- A refusal by a switch: 42501 with hint 'not_permitted' ("… the manager has not allowed it").
-- Errcodes: 42501 not allowed, 22023 bad input, P0002 not found.

-- ---------------------------------------------------------------- E helpers
-- The pharmacy's stock is managed by the manager, or by the pharmacy desk with "Manage stock".
create or replace function stock_manager()
returns boolean
language sql stable security definer set search_path = public
as $$
  select is_manager() or (may_use_desk('pharmacy') and has_perm('stock.write'))
$$;

-- At the pharmacy desk without "Manage stock": say so (the callers raise their own words otherwise).
create or replace function assert_stock_write()
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if stock_admin() and not stock_manager() then
    raise exception 'you may not manage the stock (the manager has not allowed it)'
      using errcode = '42501', hint = 'not_permitted';
  end if;
end
$$;

-- ---------------------------------------------------------------- A take payments
-- record_payment (from 20261102120000_desks_connected): payment.take only (billing.write no longer takes money).
create or replace function record_payment(
  p_invoice_id uuid,
  p_method payment_method,
  p_amount numeric,
  p_reference text default null,
  p_payer_phone text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_year integer := extract(year from now())::integer;
begin
  -- the cashier, and anyone the manager allows to take payments (Settings → Who may do what)
  if not has_perm('payment.take') then
    raise exception 'you may not take payments (the manager has not allowed it)' using errcode = '42501', hint = 'not_permitted';
  end if;
  if p_method in ('momo', 'airtel', 'card', 'bank') and nullif(trim(coalesce(p_reference, '')), '') is null then
    raise exception 'a transaction reference is required for %', p_method using errcode = '22023';
  end if;
  insert into payment (invoice_id, method, amount, reference, payer_phone, receipt_no)
  values (p_invoice_id, p_method, p_amount, p_reference, p_payer_phone,
          'RCT-' || v_year || '-' || lpad(next_number('receipt', v_year)::text, 6, '0'))
  returning id into v_id;
  return v_id;
end
$$;

-- post_invoice (from 20261102120000_desks_connected): payment.take, or the manager.
create or replace function post_invoice(p_invoice_id uuid)
returns text
language plpgsql security definer set search_path = public
as $$
begin
  if not (is_manager() or has_perm('payment.take')) then
    raise exception 'you may not take payments (the manager has not allowed it)' using errcode = '42501', hint = 'not_permitted';
  end if;
  return post_invoice_now(p_invoice_id);
end
$$;

-- refund_payment (from 20261105090000_desks_wave7): giving money back is taking payments (payment.take), or the manager.
create or replace function refund_payment(
  p_encounter_id uuid,
  p_amount numeric,
  p_method payment_method,
  p_reason text,
  p_reference text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_inv invoice%rowtype;
  v_over numeric;
  v_id uuid;
begin
  if not (is_manager() or has_perm('payment.take')) then
    raise exception 'you may not take payments (the manager has not allowed it)' using errcode = '42501', hint = 'not_permitted';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the money is given back' using errcode = '22023';
  end if;
  if p_method::text not in ('cash', 'momo', 'airtel') then
    raise exception 'cash, MTN MoMo or Airtel Money only' using errcode = '22023';
  end if;
  if p_method::text <> 'cash' and nullif(trim(coalesce(p_reference, '')), '') is null then
    raise exception 'give the transaction reference' using errcode = '22023';
  end if;
  select * into v_inv from invoice where encounter_id = p_encounter_id and deleted_at is null for update;
  if not found then
    raise exception 'no bill for this visit' using errcode = 'P0002';
  end if;
  v_over := -invoice_balance(v_inv.id);
  if v_over <= 0 then
    raise exception 'nothing to give back: the bill is not overpaid' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > v_over + 0.5 then
    raise exception 'give back at most % RWF', v_over using errcode = '22023';
  end if;
  insert into refund (invoice_id, amount, method, reference, reason)
  values (v_inv.id, round(p_amount), p_method, nullif(trim(coalesce(p_reference, '')), ''), trim(p_reason))
  returning id into v_id;
  insert into audit_event (actor_id, action, entity, entity_id, reason)
  values (auth.uid(), 'update', 'refund', v_id, trim(p_reason));
  return jsonb_build_object('id', v_id, 'balance', invoice_balance(v_inv.id));
end
$$;

-- void_payment (from 20261124090000_stores_and_stock): the person who took it, while still allowed to take payments; the manager.
create or replace function void_payment(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_p payment%rowtype;
  v_enc uuid;
  v_sale counter_sale%rowtype;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the payment is cancelled' using errcode = '22023';
  end if;
  select * into v_p from payment where id = p_payment_id and deleted_at is null for update;
  if not found then
    raise exception 'payment not found or already cancelled' using errcode = 'P0002';
  end if;
  if not is_manager() then
    if not has_perm('payment.take') then
      raise exception 'you may not take payments (the manager has not allowed it): ask the manager to cancel it'
        using errcode = '42501', hint = 'not_permitted';
    end if;
    if v_p.cashier_id is distinct from auth.uid() then
      raise exception 'only the person who took the payment (or the manager) can cancel it' using errcode = '42501';
    end if;
    if (v_p.paid_at at time zone 'Africa/Kigali')::date <> (now() at time zone 'Africa/Kigali')::date then
      raise exception 'a payment of another day is cancelled by the manager' using errcode = '42501';
    end if;
    if v_p.day_close_id is not null then
      raise exception 'the cash of that day is already counted: ask the manager' using errcode = '42501';
    end if;
  end if;
  if v_p.counter_sale_id is not null then
    select * into v_sale from counter_sale where id = v_p.counter_sale_id for update;
    if v_sale.status = 'handed_over' then
      raise exception 'the medicines of this sale were already handed over' using errcode = '23514';
    end if;
  end if;
  update payment set deleted_at = now(), void_reason = trim(p_reason), voided_by = auth.uid(), voided_at = now()
  where id = p_payment_id;
  if v_p.counter_sale_id is not null then
    -- the units taken at payment go back on the shelf
    insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason, unit_cost, counter_sale_id)
    select h.item_id, h.batch_id, v_sale.location_id, h.quantity, 'return',
           'payment cancelled: ' || v_sale.number, h.unit_cost, v_sale.id
    from counter_sale_held(v_sale.id) h;
    update counter_sale set status = 'open', paid_at = null, payment_id = null where id = v_p.counter_sale_id;
    return jsonb_build_object('encounterId', null, 'counterSaleId', v_p.counter_sale_id, 'balance', v_sale.total);
  end if;
  select encounter_id into v_enc from invoice where id = v_p.invoice_id;
  return jsonb_build_object('encounterId', v_enc, 'balance', invoice_balance(v_p.invoice_id));
end
$$;

-- close_cash_day (from 20261124090000_stores_and_stock): those who take payments; someone switched off during the day still counts what they took.
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
  if not (is_manager() or has_perm('payment.take')
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

-- cashier_summary (from 20261124090000_stores_and_stock): the cashier and reception (billing.read)
-- see the whole desk as before; anyone else allowed to take payments, or who still has payments of
-- their own to count, sees their own payments, refunds and cash count (and, with "Take payments",
-- the bills and counter sales waiting to be paid).
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
begin
  if not (v_all or v_take
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
    'counterToPay', case when v_all or v_take then coalesce((
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

-- ---------------------------------------------------------------- vital signs: the refusal says why
-- record_vitals (from 20261126090000_departments_decide_desks): switched off: say that the manager has not allowed it.
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
    raise exception 'you may not record vital signs (the manager has not allowed it)' using errcode = '42501', hint = 'not_permitted';
  end if;
  select arrived_at into v_arrived from encounter where id = p_encounter_id and status = 'open';
  if not found then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  select exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'triage'
                 and finished_at is null and deleted_at is null) into v_at_triage;
  -- At triage: the people of a department that does triage (when none does, as before).
  if v_at_triage then
    perform assert_desk(array['triage'], 'triage');
  end if;
  -- Sending on from triage is for whoever may work on the patient (as with "Send on"): reception
  -- that sent the patient to triage, or a nurse other than the one named, records only.
  if v_at_triage and p_next_station is not null and not may_route(p_encounter_id) then
    if current_role_key() = 'receptionist' then
      raise exception 'this patient is with %: record the measurements without choosing where they go next; the nurse there sends them on',
        coalesce(patient_holder(p_encounter_id), 'triage') using errcode = '42501';
    end if;
    perform assert_may_work_on(p_encounter_id, true);
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

-- send_from_triage (from 20261126090000_departments_decide_desks): sending on from triage is triage work: vitals.write (the triage desk needs it too).
create or replace function send_from_triage(
  p_encounter_id uuid,
  p_triage triage_level,
  p_next_station station,
  p_reason text default null
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
begin
  if not (has_perm('clinical.write') or has_perm('vitals.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not has_perm('vitals.write') then
    raise exception 'you may not record vital signs (the manager has not allowed it)' using errcode = '42501', hint = 'not_permitted';
  end if;
  perform assert_desk(array['triage'], 'triage');
  perform assert_may_work_on(p_encounter_id, true);
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if not exists (select 1 from observation where encounter_id = p_encounter_id and deleted_at is null) then
    raise exception 'take the vitals first' using errcode = '22023';
  end if;
  update encounter set triage_level = p_triage, triage_reason = coalesce(nullif(trim(coalesce(p_reason, '')), ''), triage_reason)
  where id = p_encounter_id;
  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = 'triage' and finished_at is null and deleted_at is null;
  if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = p_next_station
                 and finished_at is null and deleted_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, p_next_station, v_ticket,
            case p_triage when 'red' then 1 when 'yellow' then 2 else 3 end);
  end if;
  return v_ticket;
end
$$;

-- ---------------------------------------------------------------- C test results
-- record_result (from 20261126090000_departments_decide_desks): at the laboratory or ultrasound desk, also orders.write.
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
  if not ((may_use_desk(request_desk(v_req.station, v_req.category))
               and (request_desk(v_req.station, v_req.category) not in ('laboratory', 'ultrasound')
                    or has_perm('orders.write')))
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound')
              and may_use_any_desk(station_desks(v_req.station)))
          -- the clinician's own test while no department gives that desk (as before 0085)
          or (has_perm('orders.write') and v_req.requester_id = auth.uid()
              and not desk_offered(request_desk(v_req.station, v_req.category)))) then
    if may_use_desk(request_desk(v_req.station, v_req.category)) and not has_perm('orders.write') then
      raise exception 'you may not work on tests (the manager has not allowed it)'
        using errcode = '42501', hint = 'not_permitted';
    end if;
    perform assert_desk(array[request_desk(v_req.station, v_req.category)]);
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_req.status = 'cancelled' then
    raise exception 'this test was marked "not done": order it again if it is done after all' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_findings, '')), '') is null and nullif(trim(coalesce(p_impression, '')), '') is null then
    raise exception 'write the findings or the conclusion' using errcode = '22023';
  end if;
  if exists (select 1 from diagnostic_report where service_request_id = p_request_id
             and deleted_at is null and verified_at is not null) then
    raise exception 'this result is verified: correct it, giving the reason' using errcode = '22023';
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

-- set_request_status (from 20261126090000_departments_decide_desks): at the laboratory or ultrasound desk, also orders.write.
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
  if not ((may_use_desk(request_desk(v_req.station, v_req.category))
               and (request_desk(v_req.station, v_req.category) not in ('laboratory', 'ultrasound')
                    or has_perm('orders.write')))
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound')
              and may_use_any_desk(station_desks(v_req.station)))
          -- the clinician's own test while no department gives that desk (as before 0085)
          or (has_perm('orders.write') and v_req.requester_id = auth.uid()
              and not desk_offered(request_desk(v_req.station, v_req.category)))) then
    if may_use_desk(request_desk(v_req.station, v_req.category)) and not has_perm('orders.write') then
      raise exception 'you may not work on tests (the manager has not allowed it)'
        using errcode = '42501', hint = 'not_permitted';
    end if;
    perform assert_desk(array[request_desk(v_req.station, v_req.category)]);
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
  -- sample taken / analysing: the patient is being seen at that desk
  if p_status in ('collected', 'in_process') then
    update queue_entry q set started_at = coalesce(q.started_at, now()), called_at = coalesce(q.called_at, now()),
                             taken_by = coalesce(q.taken_by, auth.uid())
    where q.encounter_id = v_req.encounter_id and q.finished_at is null and q.deleted_at is null
      and q.station = coalesce(v_req.station, case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end);
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

-- correct_result (from 20261126090000_departments_decide_desks): at the laboratory or ultrasound desk, also orders.write.
create or replace function correct_result(
  p_request_id uuid,
  p_findings text,
  p_impression text,
  p_reason text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req service_request%rowtype;
  v_rep diagnostic_report%rowtype;
  v_test text;
  v_name text;
begin
  select * into v_req from service_request where id = p_request_id and deleted_at is null;
  if not found then
    raise exception 'test order not found' using errcode = 'P0002';
  end if;
  if not (is_manager() or (may_use_desk(request_desk(v_req.station, v_req.category))
               and (request_desk(v_req.station, v_req.category) not in ('laboratory', 'ultrasound')
                    or has_perm('orders.write')))
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound')
              and may_use_any_desk(station_desks(v_req.station)))
          -- the clinician's own test while no department gives that desk (as before 0085)
          or (has_perm('orders.write') and v_req.requester_id = auth.uid()
              and not desk_offered(request_desk(v_req.station, v_req.category)))) then
    if may_use_desk(request_desk(v_req.station, v_req.category)) and not has_perm('orders.write') then
      raise exception 'you may not work on tests (the manager has not allowed it)'
        using errcode = '42501', hint = 'not_permitted';
    end if;
    perform assert_desk(array[request_desk(v_req.station, v_req.category)]);
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the result is corrected' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_findings, '')), '') is null and nullif(trim(coalesce(p_impression, '')), '') is null then
    raise exception 'write the findings or the conclusion' using errcode = '22023';
  end if;
  select * into v_rep from diagnostic_report where service_request_id = p_request_id and deleted_at is null for update;
  if not found or v_rep.verified_at is null then
    raise exception 'only a verified result is corrected; edit the result instead' using errcode = '22023';
  end if;
  insert into report_correction (report_id, old_findings, old_impression, old_verified_by, old_verified_at, reason)
  values (v_rep.id, v_rep.findings, v_rep.impression, v_rep.verified_by, v_rep.verified_at, trim(p_reason));
  perform set_config('mmc.correcting_report', v_rep.id::text, true);
  update diagnostic_report
  set findings = nullif(trim(coalesce(p_findings, '')), ''), impression = nullif(trim(coalesce(p_impression, '')), ''),
      verified_by = auth.uid(), verified_at = now(), corrected_at = now(), correction_reason = trim(p_reason),
      updated_at = now()
  where id = v_rep.id;
  perform set_config('mmc.correcting_report', '', true);
  -- The doctor who ordered the test is told the result changed.
  if v_req.requester_id is not null and v_req.requester_id is distinct from auth.uid() then
    select s.name_en into v_test from service s where s.id = v_req.service_id;
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_req.encounter_id;
    insert into notification (kind, params, link, recipient_user, urgent, created_by)
    values ('result',
            jsonb_build_object('test', v_test, 'name', v_name,
                               'impression', nullif(trim(coalesce(p_impression, '')), ''),
                               'verified', true, 'corrected', true, 'reason', trim(p_reason)),
            '/app/visit?encounter=' || v_req.encounter_id,
            v_req.requester_id, true, auth.uid());
  end if;
end
$$;

-- ---------------------------------------------------------------- D bookings
-- inquiries_open (from 20261106090000_desks_wave8): also for those allowed to approve bookings.
create or replace function inquiries_open()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'name', a.contact_name, 'phone', a.contact_phone, 'reference', a.reference,
    'category', a.category, 'channel', a.contact_channel, 'note', a.reason,
    'doctor', pr.names, 'doctorUserId', pr.user_id,
    'startsAt', a.starts_at, 'preferredAt', a.preferred_at, 'createdAt', a.created_at,
    'insurer', a.insurer_text,
    'patientId', m.id, 'patientFile', m.file_number,
    'patientName', case when m.id is null then null else m.surname || ' ' || m.given_names end,
    'matches', m.n
  ) order by a.created_at), '[]'::jsonb)
  from appointment a
  left join practitioner pr on pr.id = a.practitioner_id
  left join lateral (
    select count(*)::integer as n,
           case when count(*) = 1 then (array_agg(p.id))[1] end as id,
           case when count(*) = 1 then (array_agg(p.file_number))[1] end as file_number,
           case when count(*) = 1 then (array_agg(p.surname))[1] end as surname,
           case when count(*) = 1 then (array_agg(p.given_names))[1] end as given_names
    from patient p
    where p.deleted_at is null and p.merged_into is null
      and phone_key(p.phone_1) = phone_key(a.contact_phone) and phone_key(a.contact_phone) <> ''
  ) m on true
  where (has_perm('appointment.read') or has_perm('appointment.approve')) and a.deleted_at is null and a.status = 'inquiry'
$$;

-- appointments_day (from 20261106090000_desks_wave8): also for those allowed to approve bookings.
create or replace function appointments_day(p_day date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id,
      'time', to_char(a.starts_at at time zone 'Africa/Kigali', 'HH24:MI'),
      'startsAt', a.starts_at,
      'status', a.status,
      'patientId', a.patient_id,
      'fileNumber', p.file_number,
      'name', coalesce(p.surname || ' ' || p.given_names, a.contact_name),
      'phone', coalesce(p.phone_1, a.contact_phone),
      'doctor', pr.names,
      'reason', a.reason,
      'reference', a.reference,
      'source', a.source,
      'channel', a.contact_channel,
      'late', a.status in ('approved', 'confirmed') and a.starts_at < now() - interval '15 minutes',
      'doctorUserId', pr.user_id,
      'encounterId', (select e.id from encounter e where e.appointment_id = a.id order by e.arrived_at desc limit 1),
      'declineReason', case when a.status = 'declined' then a.cancel_reason end,
      -- a declined booking already booked again (a later booking of the same patient)
      'rebooked', a.status = 'declined' and exists (
        select 1 from appointment b
        where b.patient_id = a.patient_id and b.id <> a.id and b.deleted_at is null
          and b.created_at > a.updated_at
          and b.status not in ('declined', 'rejected', 'cancelled'))
    ) order by a.starts_at), '[]'::jsonb)
  from appointment a
  left join patient p on p.id = a.patient_id
  left join practitioner pr on pr.id = a.practitioner_id
  where (has_perm('appointment.read') or has_perm('appointment.approve')) and a.deleted_at is null
    and a.status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed', 'no_show', 'cancelled', 'declined')
    and (a.starts_at at time zone 'Africa/Kigali')::date = coalesce(p_day, (now() at time zone 'Africa/Kigali')::date)
$$;

-- appointment_detail (from 20261027090000_flow_payments_appointments): also for those allowed to approve bookings.
create or replace function appointment_detail(p_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', a.id, 'status', a.status, 'source', a.source, 'reference', a.reference,
    'startsAt', a.starts_at, 'endsAt', a.ends_at, 'preferredAt', a.preferred_at, 'createdAt', a.created_at,
    'reason', a.reason, 'cancelReason', a.cancel_reason, 'category', a.category, 'insurer', a.insurer_text,
    'channel', a.contact_channel, 'contactName', a.contact_name, 'contactPhone', a.contact_phone,
    'patientId', p.id, 'patientFile', p.file_number,
    'patientName', case when p.id is null then null else p.surname || ' ' || p.given_names end,
    'patientPhone', p.phone_1,
    'doctor', pr.names, 'doctorUserId', pr.user_id,
    'approvedBy', ap.full_name, 'approvedAt', a.approved_at,
    'acceptedBy', ac.full_name, 'acceptedAt', a.accepted_at,
    'encounterId', (select e.id from encounter e where e.appointment_id = a.id order by e.created_at desc limit 1),
    'late', a.status in ('approved', 'confirmed') and a.starts_at < now() - interval '15 minutes'
  )
  from appointment a
  left join patient p on p.id = a.patient_id
  left join practitioner pr on pr.id = a.practitioner_id
  left join profiles ap on ap.id = a.approved_by
  left join profiles ac on ac.id = a.accepted_by
  where (has_perm('appointment.read') or has_perm('appointment.approve')) and a.id = p_id and a.deleted_at is null
$$;

-- ---------------------------------------------------------------- E managing the stock
-- save_location (from 20261124090000_stores_and_stock): the pharmacy side needs stock_manager() (pharmacy desk and stock.write), not the desk alone.
create or replace function save_location(p_id uuid, p_name text, p_type stock_location_type, p_department_id uuid default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_old stock_location%rowtype;
begin
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'the store needs a name' using errcode = '22023';
  end if;
  if p_type::text = 'transit' then
    raise exception 'this store type is kept by the system' using errcode = '22023';
  end if;
  if v_id is not null then
    select * into v_old from stock_location where id = v_id and deleted_at is null;
    if not found then
      raise exception 'store not found' using errcode = 'P0002';
    end if;
    if v_old.type::text = 'transit' then
      raise exception 'this store is kept by the system' using errcode = '22023';
    end if;
  end if;
  if p_type = 'main_store' and (v_id is null or v_old.type <> 'main_store') then
    raise exception 'deliveries are received into the pharmacy: a new main store is not created'
      using errcode = '22023', hint = 'no_main_store';
  end if;
  -- who may: the pharmacy stores by the pharmacy or the manager, the room stores by the manager
  if is_room_type(p_type) or (v_id is not null and is_room_type(v_old.type)) then
    if not is_manager() then
      raise exception 'only the manager creates and changes room stores' using errcode = '42501';
    end if;
  elsif not stock_manager() then
    perform assert_stock_write();
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_id is null then
    insert into stock_location (name, type, department_id) values (trim(p_name), p_type, p_department_id)
    returning id into v_id;
  else
    if v_old.type <> p_type and (
         exists (select 1 from stock_on_hand where location_id = v_id and quantity <> 0)
         or exists (select 1 from stock_transfer t where t.status = 'in_transit'
                    and (t.from_location_id = v_id or t.to_location_id = v_id))) then
      raise exception 'a store that holds stock keeps its type' using errcode = '23514', hint = 'store_has_stock';
    end if;
    update stock_location set name = trim(p_name), type = p_type, department_id = p_department_id, updated_at = now()
    where id = v_id;
    if v_old.is_main and p_type <> 'pharmacy' then
      update stock_location set is_main = false where id = v_id;
    end if;
  end if;
  -- a room store given to a department: the department holds it
  if is_room_type(p_type) and p_department_id is not null
     and not exists (select 1 from stock_location_holder where location_id = v_id and department_id = p_department_id
                     and deleted_at is null) then
    insert into stock_location_holder (location_id, department_id) values (v_id, p_department_id);
  end if;
  return v_id;
end
$$;

-- set_location_active (from 20261124090000_stores_and_stock): the pharmacy side needs stock_manager() (pharmacy desk and stock.write), not the desk alone.
create or replace function set_location_active(p_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_l stock_location%rowtype;
begin
  select * into v_l from stock_location where id = p_id and deleted_at is null for update;
  if not found then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if v_l.type::text = 'transit' then
    raise exception 'this store is kept by the system' using errcode = '22023';
  end if;
  if is_room_type(v_l.type) then
    if not is_manager() then
      raise exception 'only the manager closes and reopens room stores' using errcode = '42501';
    end if;
  elsif not stock_manager() then
    perform assert_stock_write();
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not p_active then
    if exists (select 1 from stock_on_hand where location_id = p_id and quantity > 0) then
      raise exception 'this store still holds stock: return it to the pharmacy (or send it on) first'
        using errcode = '23514', hint = 'store_has_stock';
    end if;
    if exists (select 1 from stock_transfer t where t.status = 'in_transit'
               and (t.from_location_id = p_id or t.to_location_id = p_id)) then
      raise exception 'a transfer note to or from this store is still on the way: receive or cancel it first'
        using errcode = '23514', hint = 'notes_in_transit';
    end if;
    update store_request set status = 'cancelled', decided_at = now(), decided_by = auth.uid(),
           decline_reason = 'store closed'
    where location_id = p_id and status = 'open';
  end if;
  update stock_location set active = p_active, updated_at = now(),
         is_main = case when p_active then is_main else false end
  where id = p_id;
  -- the main pharmacy closed: the next open pharmacy store receives
  if not p_active and v_l.is_main then
    update stock_location set is_main = true
    where id = (select id from stock_location where type = 'pharmacy' and active and deleted_at is null
                order by created_at limit 1);
  end if;
end
$$;

-- set_store_min (from 20261124090000_stores_and_stock): the holders, or stock_manager().
create or replace function set_store_min(p_location_id uuid, p_item_id uuid, p_min integer)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from stock_location where id = p_location_id and deleted_at is null and is_room_type(type)) then
    raise exception 'choose a room store' using errcode = '22023', hint = 'not_room_store';
  end if;
  if not (stock_manager() or holds_store(auth.uid(), p_location_id)) then
    perform assert_stock_write();
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from item where id = p_item_id and deleted_at is null) then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  if p_min is not null and p_min < 0 then
    raise exception 'the minimum must be zero or more' using errcode = '22023';
  end if;
  if coalesce(p_min, 0) = 0 then
    delete from store_item_level where location_id = p_location_id and item_id = p_item_id;
    delete from low_stock_flag where item_id = p_item_id and scope = p_location_id::text;
  else
    insert into store_item_level (location_id, item_id, min_level) values (p_location_id, p_item_id, p_min)
    on conflict (location_id, item_id) do update set min_level = excluded.min_level, updated_at = now(),
                                                     updated_by = auth.uid();
    perform check_room_low(p_item_id, p_location_id);
  end if;
end
$$;

-- receive_stock (from 20261124090000_stores_and_stock): the pharmacy side needs stock_manager() (pharmacy desk and stock.write), not the desk alone.
create or replace function receive_stock(
  p_item_id uuid, p_location_id uuid, p_quantity integer, p_unit_cost numeric,
  p_batch_no text default null, p_expiry date default null, p_supplier text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_l stock_location%rowtype;
begin
  select * into v_l from stock_location where id = p_location_id and deleted_at is null;
  if not found then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if v_l.type = 'pharmacy' then
    if not stock_manager() then
      perform assert_stock_write();
      raise exception 'not allowed' using errcode = '42501';
    end if;
  elsif v_l.type = 'lab' then
    if not (is_manager() or (has_perm('stock.write') and holds_store(auth.uid(), p_location_id))) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  else
    raise exception 'deliveries are received into the pharmacy; room stores are supplied by the pharmacy with a transfer note'
      using errcode = '22023', hint = 'receive_into_pharmacy';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if p_unit_cost is null or p_unit_cost < 0 then
    raise exception 'the cost per unit must be zero or more' using errcode = '22023';
  end if;
  return receive_batch(p_item_id, p_location_id, p_quantity, p_unit_cost, p_batch_no, p_expiry,
                       supplier_for(p_supplier), nullif(trim(coalesce(p_supplier, '')), ''), null);
end
$$;

-- receive_delivery (from 20261124090000_stores_and_stock): the pharmacy side needs stock_manager() (pharmacy desk and stock.write), not the desk alone.
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
  if length(trim(coalesce(p_supplier, ''))) < 2 then
    raise exception 'name the supplier' using errcode = '22023', hint = 'supplier';
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
  values (v_sup, now(), nullif(trim(coalesce(p_note, '')), ''), v_number, v_ref, v_on, v_loc, trim(p_supplier))
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
                               trim(p_supplier) || coalesce(' · ' || v_ref, '') || ' · ' || v_number, v_id);
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

-- assert_store_work (from 20261124090000_stores_and_stock): the pharmacy side needs stock_manager() (pharmacy desk and stock.write), not the desk alone.
create or replace function assert_store_work(p_location_id uuid)
returns stock_location
language plpgsql stable security definer set search_path = public
as $$
declare
  v_l stock_location%rowtype;
begin
  select * into v_l from stock_location where id = p_location_id and deleted_at is null;
  if not found then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if v_l.type::text = 'transit' then
    raise exception 'the units on the way belong to their transfer note' using errcode = '22023';
  end if;
  if is_room_type(v_l.type) then
    if not (is_manager() or holds_store(auth.uid(), p_location_id)) then
      raise exception 'only the people who hold this store (or the manager) work its stock'
        using errcode = '42501', hint = 'not_holder';
    end if;
  elsif not stock_manager() then
    perform assert_stock_write();
    raise exception 'only the pharmacy (or the manager) works the pharmacy stock' using errcode = '42501';
  end if;
  return v_l;
end
$$;

-- adjust_stock (from 20261124090000_stores_and_stock): a room store counted up: stock_manager().
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
  return v_diff;
end
$$;

-- transfer_stock (from 20261124090000_stores_and_stock): the pharmacy side needs stock_manager() (pharmacy desk and stock.write), not the desk alone.
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
  v_from stock_location%rowtype;
  v_to stock_location%rowtype;
begin
  if not stock_manager() then
    perform assert_stock_write();
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'choose a different destination' using errcode = '22023';
  end if;
  select * into v_from from stock_location where id = p_from_location_id and deleted_at is null;
  select * into v_to from stock_location where id = p_to_location_id and deleted_at is null;
  if v_from.id is null or v_to.id is null then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if v_from.type not in ('pharmacy', 'main_store') or v_to.type <> 'pharmacy' then
    raise exception 'a room store is supplied with a transfer note, and sends back with a return note'
      using errcode = '22023', hint = 'use_transfer_note';
  end if;
  if not v_to.active then
    raise exception 'this store is closed: reopen it first' using errcode = '22023', hint = 'store_closed';
  end if;
  perform lock_stock(p_item_id, p_from_location_id);
  for v_row in
    select s.batch_id, s.quantity, b.unit_cost from stock_on_hand s left join batch b on b.id = s.batch_id
    where s.item_id = p_item_id and s.location_id = p_from_location_id and s.quantity > 0
      and (s.expiry is null or s.expiry >= current_date)   -- expired stock is not sent on
    order by s.expiry asc nulls last
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.quantity, v_remaining);
    insert into stock_movement (item_id, batch_id, from_location_id, to_location_id, quantity, type, reason, unit_cost)
    values (p_item_id, v_row.batch_id, p_from_location_id, p_to_location_id, v_take, 'transfer',
            nullif(trim(coalesce(p_reason, '')), ''), v_row.unit_cost);
    v_remaining := v_remaining - v_take;
  end loop;
  if v_remaining > 0 then
    raise exception 'not enough stock in that store: % unit(s) short', v_remaining using errcode = '23514', hint = 'short';
  end if;
  return p_quantity;
end
$$;

-- decline_refill (from 20261124090000_stores_and_stock): the pharmacy side needs stock_manager() (pharmacy desk and stock.write), not the desk alone.
create or replace function decline_refill(p_request_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_r store_request%rowtype;
begin
  if not stock_manager() then
    perform assert_stock_write();
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the request is declined' using errcode = '22023';
  end if;
  select * into v_r from store_request where id = p_request_id and deleted_at is null for update;
  if not found or v_r.status <> 'open' then
    raise exception 'this request is no longer open' using errcode = 'P0002';
  end if;
  update store_request set status = 'declined', decided_by = auth.uid(), decided_at = now(), decline_reason = trim(p_reason)
  where id = v_r.id;
  insert into notification (kind, params, link, recipient_user, created_by)
  values ('refill_declined', jsonb_build_object('number', v_r.number,
                                                'store', (select name from stock_location where id = v_r.location_id),
                                                'reason', trim(p_reason),
                                                'by', (select full_name from profiles where id = auth.uid())),
          '/app/stock?tab=mine&store=' || v_r.location_id, v_r.created_by, auth.uid());
end
$$;

-- send_to_room (from 20261124090000_stores_and_stock): the pharmacy side needs stock_manager() (pharmacy desk and stock.write), not the desk alone.
create or replace function send_to_room(
  p_location_id uuid, p_lines jsonb, p_request_id uuid default null, p_note text default null,
  p_from_location_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_to stock_location%rowtype;
  v_from uuid := coalesce(p_from_location_id, main_pharmacy());
  v_r store_request%rowtype;
  v_id uuid;
  v_number text;
  v_line record;
begin
  if not stock_manager() then
    perform assert_stock_write();
    raise exception 'only the pharmacy (or the manager) sends stock to a room store' using errcode = '42501';
  end if;
  select * into v_to from stock_location where id = p_location_id and deleted_at is null and active;
  if not found or not is_room_type(v_to.type) then
    raise exception 'choose an open room store' using errcode = '22023', hint = 'not_room_store';
  end if;
  -- nobody would be told or could confirm it: the manager assigns a holder first
  if not exists (select 1 from stock_location_holder where location_id = p_location_id and deleted_at is null) then
    raise exception 'this room store has no holder yet: the manager assigns one first'
      using errcode = '22023', hint = 'no_holder';
  end if;
  if v_from is null or not exists (select 1 from stock_location where id = v_from and type = 'pharmacy' and active
                                   and deleted_at is null) then
    raise exception 'room stores are supplied from an open pharmacy store' using errcode = '22023';
  end if;
  if p_request_id is not null then
    select * into v_r from store_request where id = p_request_id and deleted_at is null for update;
    if not found or v_r.status <> 'open' then
      raise exception 'this request is no longer open' using errcode = 'P0002';
    end if;
    if v_r.location_id <> p_location_id then
      raise exception 'this request is for another store' using errcode = '22023';
    end if;
  end if;
  v_number := day_number('T', 'transfer');
  insert into stock_transfer (number, direction, from_location_id, to_location_id, request_id, note)
  values (v_number, 'to_room', v_from, p_location_id, p_request_id, nullif(trim(coalesce(p_note, '')), ''))
  returning id into v_id;
  for v_line in select * from note_lines(p_lines) loop
    if not exists (select 1 from item where id = v_line.item_id and deleted_at is null) then
      raise exception 'medicine not found' using errcode = 'P0002';
    end if;
    perform transfer_out(v_id, v_from, v_line.item_id, v_line.quantity, false);
  end loop;
  if p_request_id is not null then
    update store_request set status = 'fulfilled', transfer_id = v_id, decided_by = auth.uid(), decided_at = now()
    where id = p_request_id;
  end if;
  perform notify_holders(p_location_id, 'transfer_sent',
                         jsonb_build_object('number', v_number, 'store', v_to.name, 'transferId', v_id,
                                            'lines', (select count(distinct item_id) from stock_transfer_line where transfer_id = v_id),
                                            'by', (select full_name from profiles where id = auth.uid())),
                         '/app/stock?tab=mine&store=' || p_location_id || '&note=' || v_id);
  return transfer_note_totals(v_id);
end
$$;

-- confirm_receipt (from 20261124090000_stores_and_stock): the pharmacy side needs stock_manager() (pharmacy desk and stock.write), not the desk alone.
create or replace function confirm_receipt(p_transfer_id uuid, p_lines jsonb default null, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_t stock_transfer%rowtype;
  v_transit uuid := transit_store();
  v_line stock_transfer_line%rowtype;
  v_given jsonb;
  v_recv integer;
  v_diff integer;
  v_reason text;
  v_action text;
  v_in integer := 0;
  v_back integer := 0;
  v_lost integer := 0;
  v_store text;
begin
  select * into v_t from stock_transfer where id = p_transfer_id and deleted_at is null for update;
  if not found then
    raise exception 'transfer note not found' using errcode = 'P0002';
  end if;
  if v_t.direction = 'to_room' then
    if not (is_manager() or holds_store(auth.uid(), v_t.to_location_id)) then
      raise exception 'only the people who hold this store confirm what arrived' using errcode = '42501', hint = 'not_holder';
    end if;
  elsif not stock_manager() then
    perform assert_stock_write();
    raise exception 'only the pharmacy confirms what came back' using errcode = '42501';
  end if;
  -- two people: the one who sent the note does not also confirm it (the manager excepted)
  if v_t.created_by = auth.uid() and not is_manager() then
    raise exception 'the person who sent this note does not confirm it: the receiver does'
      using errcode = '42501', hint = 'own_note';
  end if;
  if v_t.status <> 'in_transit' then
    raise exception 'this note was already %', case v_t.status when 'received' then 'received' else 'cancelled' end
      using errcode = '23505';
  end if;
  if not exists (select 1 from stock_location where id = v_t.to_location_id and active) then
    raise exception 'the receiving store is closed: reopen it first' using errcode = '22023', hint = 'store_closed';
  end if;
  if p_lines is not null and jsonb_typeof(p_lines) <> 'array' then
    raise exception 'the lines are a list' using errcode = '22023';
  end if;
  if p_lines is not null and exists (
       select 1 from jsonb_array_elements(p_lines) x
       where not exists (select 1 from stock_transfer_line l where l.transfer_id = v_t.id
                         and l.id = nullif(x ->> 'lineId', '')::uuid)) then
    raise exception 'a line is not on this note' using errcode = '22023';
  end if;
  for v_line in select * from stock_transfer_line where transfer_id = v_t.id and deleted_at is null order by created_at for update loop
    v_given := null;
    select x.v into v_given from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as x(v)
    where (x.v ->> 'lineId')::uuid = v_line.id limit 1;
    v_recv := coalesce(nullif(v_given ->> 'received', '')::numeric, v_line.quantity);
    if v_recv < 0 or v_recv > v_line.quantity or v_recv <> round(v_recv) then
      raise exception 'received: a whole number between 0 and % for %', v_line.quantity, item_label(v_line.item_id)
        using errcode = '22023';
    end if;
    v_diff := v_line.quantity - v_recv;
    v_reason := nullif(trim(coalesce(v_given ->> 'reason', '')), '');
    v_action := case coalesce(nullif(v_given ->> 'action', ''), 'returned') when 'return' then 'returned' when 'lost' then 'loss'
                     else coalesce(nullif(v_given ->> 'action', ''), 'returned') end;
    if v_diff > 0 and length(coalesce(v_reason, '')) < 3 then
      raise exception 'say why % of % did not arrive', v_diff, item_label(v_line.item_id)
        using errcode = '22023', hint = 'difference_reason';
    end if;
    if v_diff > 0 and v_action not in ('returned', 'loss') then
      raise exception 'a difference goes back (returned) or is a loss' using errcode = '22023';
    end if;
    if v_recv > 0 then
      insert into stock_movement (item_id, batch_id, from_location_id, to_location_id, quantity, type, reason, unit_cost, stock_transfer_id)
      values (v_line.item_id, v_line.batch_id, v_transit, v_t.to_location_id, v_recv, 'transfer', 'received: ' || v_t.number,
              v_line.unit_cost, v_t.id);
      v_in := v_in + v_recv;
    end if;
    if v_diff > 0 and v_action = 'returned' then
      insert into stock_movement (item_id, batch_id, from_location_id, to_location_id, quantity, type, reason, unit_cost, stock_transfer_id)
      values (v_line.item_id, v_line.batch_id, v_transit, v_t.from_location_id, v_diff, 'transfer',
              'not received (' || v_t.number || '): ' || v_reason, v_line.unit_cost, v_t.id);
      v_back := v_back + v_diff;
    elsif v_diff > 0 then
      insert into stock_movement (item_id, batch_id, from_location_id, quantity, type, reason, unit_cost, stock_transfer_id)
      values (v_line.item_id, v_line.batch_id, v_transit, v_diff, 'adjustment',
              'lost on the way (' || v_t.number || '): ' || v_reason, v_line.unit_cost, v_t.id);
      v_lost := v_lost + v_diff;
    end if;
    update stock_transfer_line
    set received_quantity = v_recv, difference_action = case when v_diff > 0 then v_action end,
        difference_reason = case when v_diff > 0 then v_reason end
    where id = v_line.id;
  end loop;
  update stock_transfer
  set status = 'received', received_by = auth.uid(), confirmed_at = now(),
      receive_note = nullif(trim(coalesce(p_note, '')), ''), has_difference = (v_back + v_lost) > 0
  where id = v_t.id;
  v_store := (select name from stock_location where id = case when v_t.direction = 'to_room' then v_t.to_location_id
                                                               else v_t.from_location_id end);
  -- the sender is told it arrived
  insert into notification (kind, params, link, recipient_user, created_by)
  values ('transfer_received', jsonb_build_object('number', v_t.number, 'store', v_store, 'transferId', v_t.id,
                                                  'by', (select full_name from profiles where id = auth.uid()),
                                                  'missing', v_back + v_lost),
          case when v_t.direction = 'to_room' then '/app/stock?tab=rooms&note=' || v_t.id
               else '/app/stock?tab=mine&store=' || v_t.from_location_id || '&note=' || v_t.id end,
          v_t.created_by, auth.uid());
  -- a difference: the manager and the pharmacy are told
  if v_back + v_lost > 0 then
    insert into notification (kind, params, link, recipient_role, created_by)
    values ('transfer_difference', jsonb_build_object('number', v_t.number, 'store', v_store, 'transferId', v_t.id,
                                                      'returned', v_back, 'lost', v_lost,
                                                      'by', (select full_name from profiles where id = auth.uid())),
            '/app/stock?tab=rooms&note=' || v_t.id, 'manager', auth.uid());
    insert into notification (kind, params, link, recipient_stations, created_by)
    values ('transfer_difference', jsonb_build_object('number', v_t.number, 'store', v_store, 'transferId', v_t.id,
                                                      'returned', v_back, 'lost', v_lost,
                                                      'by', (select full_name from profiles where id = auth.uid())),
            '/app/stock?tab=rooms&note=' || v_t.id, array['pharmacy'::station], auth.uid());
  end if;
  return jsonb_build_object('id', v_t.id, 'number', v_t.number, 'status', 'received',
                            'received', v_in, 'returned', v_back, 'lost', v_lost);
end
$$;

-- cancel_transfer (from 20261124090000_stores_and_stock): the pharmacy side needs stock_manager() (pharmacy desk and stock.write), not the desk alone.
create or replace function cancel_transfer(p_transfer_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_t stock_transfer%rowtype;
  v_transit uuid := transit_store();
  v_line stock_transfer_line%rowtype;
  v_units integer := 0;
  v_store text;
begin
  select * into v_t from stock_transfer where id = p_transfer_id and deleted_at is null for update;
  if not found then
    raise exception 'transfer note not found' using errcode = 'P0002';
  end if;
  if v_t.direction = 'to_room' then
    if not stock_manager() then
      perform assert_stock_write();
      raise exception 'only the pharmacy (or the manager) cancels a note it sent' using errcode = '42501';
    end if;
  elsif not (is_manager() or holds_store(auth.uid(), v_t.from_location_id)) then
    raise exception 'only the people who hold this store (or the manager) cancel its return note' using errcode = '42501', hint = 'not_holder';
  end if;
  if v_t.status <> 'in_transit' then
    raise exception 'this note was already %', case v_t.status when 'received' then 'received' else 'cancelled' end
      using errcode = '23505';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the note is cancelled' using errcode = '22023';
  end if;
  for v_line in select * from stock_transfer_line where transfer_id = v_t.id and deleted_at is null loop
    insert into stock_movement (item_id, batch_id, from_location_id, to_location_id, quantity, type, reason, unit_cost, stock_transfer_id)
    values (v_line.item_id, v_line.batch_id, v_transit, v_t.from_location_id, v_line.quantity, 'transfer',
            'cancelled (' || v_t.number || '): ' || trim(p_reason), v_line.unit_cost, v_t.id);
    v_units := v_units + v_line.quantity;
  end loop;
  update stock_transfer set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = trim(p_reason)
  where id = v_t.id;
  -- a refill request served by this note is open again
  update store_request set status = 'open', transfer_id = null, decided_by = null, decided_at = null
  where transfer_id = v_t.id and status = 'fulfilled';
  if v_t.direction = 'to_room' then
    v_store := (select name from stock_location where id = v_t.to_location_id);
    perform notify_holders(v_t.to_location_id, 'transfer_cancelled',
                           jsonb_build_object('number', v_t.number, 'store', v_store, 'reason', trim(p_reason),
                                              'by', (select full_name from profiles where id = auth.uid())));
  else
    v_store := (select name from stock_location where id = v_t.from_location_id);
    insert into notification (kind, params, link, recipient_stations, created_by)
    values ('transfer_cancelled', jsonb_build_object('number', v_t.number, 'store', v_store, 'reason', trim(p_reason),
                                                     'by', (select full_name from profiles where id = auth.uid())),
            '/app/stock?tab=rooms&note=' || v_t.id, array['pharmacy'::station], auth.uid());
  end if;
  return jsonb_build_object('id', v_t.id, 'number', v_t.number, 'status', 'cancelled', 'units', v_units);
end
$$;

-- transfer_notes (from 20261124090000_stores_and_stock): what the reader may do: stock_manager() on the pharmacy side.
create or replace function transfer_notes(
  p_status text default null, p_location_id uuid default null, p_from date default null, p_to date default null
)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.open desc, x.at desc), '[]'::jsonb)
  from (
    select t.status = 'in_transit' as open, t.sent_at as at, jsonb_build_object(
      'id', t.id, 'number', t.number, 'direction', t.direction, 'status', t.status,
      'fromId', t.from_location_id, 'from', lf.name, 'toId', t.to_location_id, 'to', lt.name,
      'sentAt', t.sent_at, 'sentBy', (select full_name from profiles where id = t.created_by),
      'receivedAt', t.confirmed_at, 'receivedBy', (select full_name from profiles where id = t.received_by),
      'cancelledAt', t.cancelled_at, 'cancelledBy', (select full_name from profiles where id = t.cancelled_by),
      'cancelReason', t.cancel_reason, 'note', t.note, 'receiveNote', t.receive_note,
      'requestId', t.request_id, 'requestNumber', (select r.number from store_request r where r.id = t.request_id),
      'hasDifference', t.has_difference,
      'lines', (select count(distinct x.item_id) from stock_transfer_line x where x.transfer_id = t.id)::integer,
      'units', (select coalesce(sum(x.quantity), 0) from stock_transfer_line x where x.transfer_id = t.id)::integer,
      'value', case when stock_admin() then (select coalesce(sum(x.quantity * x.unit_cost), 0)
                                             from stock_transfer_line x where x.transfer_id = t.id) end,
      -- what the reader may do with it now
      'canReceive', t.status = 'in_transit' and case when t.direction = 'to_room'
                      then is_manager() or holds_store(auth.uid(), t.to_location_id) else stock_manager() end,
      'canCancel', t.status = 'in_transit' and case when t.direction = 'to_room'
                      then stock_manager() else is_manager() or holds_store(auth.uid(), t.from_location_id) end
    ) as j
    from stock_transfer t
    join stock_location lf on lf.id = t.from_location_id
    join stock_location lt on lt.id = t.to_location_id
    where t.deleted_at is null
      and (p_status is null or t.status = p_status)
      and (p_location_id is null or t.from_location_id = p_location_id or t.to_location_id = p_location_id)
      and (p_from is null or (t.sent_at at time zone 'Africa/Kigali')::date >= p_from)
      and (p_to is null or (t.sent_at at time zone 'Africa/Kigali')::date <= p_to)
      and (stock_admin() or holds_store(auth.uid(), t.from_location_id) or holds_store(auth.uid(), t.to_location_id))
    order by t.sent_at desc
    limit 300
  ) x
$$;

-- store_stock (from 20261126090000_departments_decide_desks): canManage: stock_manager() for a pharmacy store.
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
           sum(s.quantity) filter (where s.expiry between current_date and current_date + 90)::integer as expiring,
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

-- ---------------------------------------------------------------- B reading what taking a payment needs
-- The visit's bill (visit_bill, visit_charges), the payments on it (paid, the receipt to reprint)
-- and the credit notes (refunds due) for anyone allowed to take payments; their own cash counts.
drop policy if exists invoice_select_taker on invoice;
create policy invoice_select_taker on invoice for select to authenticated
  using ((select has_perm('payment.take')));
drop policy if exists invoice_line_select_taker on invoice_line;
create policy invoice_line_select_taker on invoice_line for select to authenticated
  using ((select has_perm('payment.take')));
drop policy if exists payment_select_taker on payment;
create policy payment_select_taker on payment for select to authenticated
  using ((select has_perm('payment.take')));
drop policy if exists credit_note_select_taker on credit_note;
create policy credit_note_select_taker on credit_note for select to authenticated
  using ((select has_perm('payment.take')));
drop policy if exists day_close_select_own on day_close;
create policy day_close_select_own on day_close for select to authenticated
  using (cashier_id = (select auth.uid()));

-- ---------------------------------------------------------------- D the bookings to approve
drop policy if exists appointment_select_approver on appointment;
create policy appointment_select_approver on appointment for select to authenticated
  using ((select has_perm('appointment.approve')));

-- ---------------------------------------------------------------- rights
revoke all on function stock_manager() from public, anon;
grant execute on function stock_manager() to authenticated;
-- internal: only the checked functions call it
revoke all on function assert_stock_write() from public, anon, authenticated;
