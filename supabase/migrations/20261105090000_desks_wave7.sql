-- 0064 · The cashier, laboratory / ultrasound and pharmacy / stock desks (dashboard audit, wave 7).

-- ---------------------------------------------------------------- money given back
-- A charge removed after it was paid (a test the lab could not do, a medicine not given) leaves
-- the bill overpaid. The cashier gives the difference back, with the way and the reason; the
-- bill owes nothing again and the cash count expects that much less.
create table if not exists refund (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoice (id),
  amount numeric(12, 0) not null check (amount > 0),
  method payment_method not null check (method::text in ('cash', 'momo', 'airtel')),
  reference text,
  reason text not null,
  cashier_id uuid default auth.uid() references profiles (id) on delete set null,
  refunded_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists refund_invoice_idx on refund (invoice_id);
create index if not exists refund_day_idx on refund (refunded_at);
alter table refund enable row level security;
revoke all on refund from anon, authenticated;

create or replace function invoice_balance(p_invoice_id uuid)
returns numeric
language sql stable security definer set search_path = public
as $$
  select i.patient_share
         - coalesce((select sum(p.amount) from payment p where p.invoice_id = i.id and p.deleted_at is null), 0)
         + coalesce((select sum(r.amount) from refund r where r.invoice_id = i.id and r.deleted_at is null), 0)
  from invoice i where i.id = p_invoice_id
$$;

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
  if not (has_perm('billing.write') or has_perm('payment.take')) then
    raise exception 'not allowed' using errcode = '42501';
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

revoke all on function refund_payment(uuid, numeric, payment_method, text, text) from public, anon;
grant execute on function refund_payment(uuid, numeric, payment_method, text, text) to authenticated;

create or replace view visit_bill with (security_invoker = true) as
  select i.id as invoice_id, i.encounter_id, i.status, i.payer_id, py.name as payer_name,
         i.total, i.patient_share, i.insurer_share, i.number,
         invoice_balance(i.id) as balance,
         (select coalesce(sum(p.amount), 0) from payment p where p.invoice_id = i.id and p.deleted_at is null) as paid,
         lp.paid_at as settled_at,
         lp.cashier as settled_by,
         (select coalesce(sum(r.amount), 0) from refund r where r.invoice_id = i.id and r.deleted_at is null) as refunded
  from invoice i
  left join payer py on py.id = i.payer_id
  left join lateral (
    select p.paid_at, pr.full_name as cashier
    from payment p
    left join profiles pr on pr.id = p.cashier_id
    where p.invoice_id = i.id and p.deleted_at is null
    order by p.paid_at desc limit 1
  ) lp on true;


-- ---------------------------------------------------------------- the sonographer's bookings
-- Sonographers keep their own calendar: they see and answer the bookings made with them.
insert into role_permissions (role, permission) values
  ('sonographer', 'appointment.read'), ('sonographer', 'appointment.accept')
on conflict do nothing;


-- ---------------------------------------------------------------- stock counts and stores
-- A store's count is corrected to what is really on the shelf (the difference is kept with its
-- reason); a store no longer used is closed (its stock must be sent elsewhere first).
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
begin
  if not has_perm('stock.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_counted is null or p_counted < 0 then
    raise exception 'the count must be zero or more' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the count changes' using errcode = '22023';
  end if;
  if not exists (select 1 from stock_location where id = p_location_id and deleted_at is null) then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  select coalesce(sum(quantity), 0)::integer into v_on_hand
  from stock_on_hand where item_id = p_item_id and location_id = p_location_id;
  v_diff := p_counted - v_on_hand;
  if v_diff < 0 then
    -- fewer on the shelf: the oldest (and expired) batches go first
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
  elsif v_diff > 0 then
    -- more on the shelf: added to the latest batch of the medicine
    select id into v_batch from batch where item_id = p_item_id and deleted_at is null order by received_on desc limit 1;
    if v_batch is null then
      raise exception 'no batch of this item yet: receive it instead' using errcode = 'P0002';
    end if;
    insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason)
    values (p_item_id, v_batch, p_location_id, v_diff, 'adjustment', 'count: ' || trim(p_reason));
  end if;
  return v_diff;
end
$$;

create or replace function set_location_active(p_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('stock.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not p_active and exists (select 1 from stock_on_hand where location_id = p_id and quantity > 0) then
    raise exception 'this store still holds stock: send it to another store first' using errcode = '23514';
  end if;
  update stock_location set active = p_active, updated_at = now() where id = p_id and deleted_at is null;
  if not found then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
end
$$;

revoke all on function adjust_stock(uuid, uuid, integer, text), set_location_active(uuid, boolean) from public, anon;
grant execute on function adjust_stock(uuid, uuid, integer, text), set_location_active(uuid, boolean) to authenticated;


-- ---------------------------------------------------------------- a hand-over undone
-- The wrong medicine handed over, or brought back unopened the same day: the units go back to
-- the store they came from, the line leaves the bill (an overpaid bill is given back at the
-- cashier) and the medicine waits at the pharmacy again. The pharmacy, the same day; the manager
-- any time.
create or replace function return_medicine(p_medication_request_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_d medication_dispense%rowtype;
  v_mv record;
  v_back integer := 0;
begin
  if not (has_perm('stock.dispense') or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
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
  -- the units go back where they came from
  for v_mv in
    select item_id, batch_id, from_location_id, quantity from stock_movement
    where dispense_id = v_d.id and type = 'dispense' and deleted_at is null
  loop
    insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason, dispense_id)
    values (v_mv.item_id, v_mv.batch_id, v_mv.from_location_id, v_mv.quantity, 'return', trim(p_reason), v_d.id);
    v_back := v_back + v_mv.quantity;
  end loop;
  update medication_dispense set deleted_at = now() where id = v_d.id;
  -- the line leaves the bill
  update invoice_line set deleted_at = now(),
         manual_reason = coalesce(manual_reason || ' · ', '') || 'returned: ' || trim(p_reason)
  where source_type = 'medication_dispense' and source_id = v_d.id and deleted_at is null;
  perform recompute_invoice((select id from invoice where encounter_id = v_m.encounter_id));
  -- the medicine waits at the pharmacy again (if the visit is still open)
  update medication_request set given_at = null, given_by = null where id = v_m.id;
  if exists (select 1 from encounter where id = v_m.encounter_id and status = 'open')
     and not exists (select 1 from queue_entry where encounter_id = v_m.encounter_id and station = 'pharmacy'
                     and finished_at is null and deleted_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no)
    values (v_m.encounter_id, 'pharmacy',
            (select ticket_no from queue_entry where encounter_id = v_m.encounter_id order by created_at limit 1));
  end if;
  return jsonb_build_object('units', v_back,
                            'balance', invoice_balance((select id from invoice where encounter_id = v_m.encounter_id)));
end
$$;

revoke all on function return_medicine(uuid, text) from public, anon;
grant execute on function return_medicine(uuid, text) to authenticated;


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
  if not (has_perm('billing.write') or has_perm('payment.take')) then
    raise exception 'not allowed' using errcode = '42501';
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
    if v_key in ('cash', 'momo', 'airtel') and v_val ~ '^[0-9]+$' then
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

create or replace function cashier_summary(p_day date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_day date := coalesce(p_day, (now() at time zone 'Africa/Kigali')::date);
begin
  if not has_perm('billing.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'day', v_day,
    'total', (select coalesce(sum(amount), 0) from payment
              where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date = v_day),
    'count', (select count(*) from payment
              where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date = v_day),
    'previousTotal', (select coalesce(sum(amount), 0) from payment
                      where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date = v_day - 1
                        and (v_day <> (now() at time zone 'Africa/Kigali')::date or paid_at <= now() - interval '1 day')),
    -- patients the cashier desk finished with that day
    'served', (select count(distinct q.encounter_id) from queue_entry q
               where q.deleted_at is null and q.station = 'cashier' and q.finished_at is not null
                 and (q.finished_at at time zone 'Africa/Kigali')::date = v_day),
    -- money given back that day
    'refunded', (select coalesce(sum(amount), 0) from refund
                 where deleted_at is null and (refunded_at at time zone 'Africa/Kigali')::date = v_day),
    'refunds', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', r.id, 'at', r.refunded_at, 'method', r.method, 'amount', r.amount, 'reference', r.reference,
          'reason', r.reason, 'patient', p.surname || ' ' || p.given_names,
          'cashier', (select full_name from profiles where id = r.cashier_id), 'mine', r.cashier_id = auth.uid()
        ) order by r.refunded_at desc)
      from refund r
      join invoice i on i.id = r.invoice_id
      join encounter e on e.id = i.encounter_id
      join patient p on p.id = e.patient_id
      where r.deleted_at is null and (r.refunded_at at time zone 'Africa/Kigali')::date = v_day
    ), '[]'::jsonb),
    -- money still owed on visits already over
    'debts', (select count(*) from invoice i join encounter e on e.id = i.encounter_id
              where i.deleted_at is null and e.status <> 'open' and invoice_balance(i.id) > 0),
    'debtsDue', (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id
                 where i.deleted_at is null and e.status <> 'open' and invoice_balance(i.id) > 0),
    'mine', (select coalesce(sum(amount), 0) from payment
             where deleted_at is null and cashier_id = auth.uid()
               and (paid_at at time zone 'Africa/Kigali')::date = v_day),
    'byMethod', coalesce((
      select jsonb_agg(jsonb_build_object('method', m.method, 'amount', m.amount, 'count', m.n) order by m.amount desc)
      from (select method::text as method, sum(amount) as amount, count(*) as n from payment
            where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date = v_day
            group by method) m
    ), '[]'::jsonb),
    'byCashier', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.name, 'amount', c.amount, 'count', c.n) order by c.amount desc)
      from (select coalesce(pr.full_name, '—') as name, sum(pa.amount) as amount, count(*) as n
            from payment pa left join profiles pr on pr.id = pa.cashier_id
            where pa.deleted_at is null and (pa.paid_at at time zone 'Africa/Kigali')::date = v_day
            group by pr.full_name) c
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', pa.id, 'at', pa.paid_at, 'method', pa.method, 'amount', pa.amount, 'reference', pa.reference,
          'invoice', i.number, 'encounterId', i.encounter_id,
          'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
          'cashier', pr.full_name, 'receipt', pa.receipt_no,
          'mine', pa.cashier_id = auth.uid(), 'counted', pa.day_close_id is not null
        ) order by pa.paid_at desc)
      from payment pa
      join invoice i on i.id = pa.invoice_id
      join encounter e on e.id = i.encounter_id
      join patient p on p.id = e.patient_id
      left join profiles pr on pr.id = pa.cashier_id
      where pa.deleted_at is null and (pa.paid_at at time zone 'Africa/Kigali')::date = v_day
    ), '[]'::jsonb),
    -- payments cancelled that day, and why
    'voided', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', pa.id, 'at', pa.paid_at, 'method', pa.method, 'amount', pa.amount, 'receipt', pa.receipt_no,
          'patient', p.surname || ' ' || p.given_names, 'reason', pa.void_reason,
          'by', (select full_name from profiles where id = pa.voided_by), 'voidedAt', pa.voided_at
        ) order by pa.voided_at desc)
      from payment pa
      join invoice i on i.id = pa.invoice_id
      join encounter e on e.id = i.encounter_id
      join patient p on p.id = e.patient_id
      where pa.deleted_at is not null and pa.voided_at is not null
        and (pa.paid_at at time zone 'Africa/Kigali')::date = v_day
    ), '[]'::jsonb),
    -- the cash counted at the end of the day, per cashier
    'closes', coalesce((
      select jsonb_agg(jsonb_build_object(
          'cashier', pr.full_name, 'mine', d.cashier_id = auth.uid(), 'expected', d.expected,
          'counted', d.counted, 'variance', d.variance, 'note', d.note, 'at', d.updated_at
        ) order by pr.full_name)
      from day_close d left join profiles pr on pr.id = d.cashier_id
      where d.deleted_at is null and d.date = v_day
    ), '[]'::jsonb),
    -- what I should hold, per method
    'myExpected', coalesce((
      select jsonb_object_agg(n.method, n.amount) from (select m.method, sum(m.amount) as amount from (
          select method::text as method, amount from payment
          where deleted_at is null and cashier_id = auth.uid() and (paid_at at time zone 'Africa/Kigali')::date = v_day
          union all
          select method::text, -amount from refund
          where deleted_at is null and cashier_id = auth.uid() and (refunded_at at time zone 'Africa/Kigali')::date = v_day
        ) m group by m.method) n
    ), '{}'::jsonb),
    'openBills', (select count(*) from invoice i join encounter e on e.id = i.encounter_id
                  where i.deleted_at is null and i.status = 'draft' and e.status = 'open' and invoice_balance(i.id) > 0),
    'openDue', (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id
                where i.deleted_at is null and i.status = 'draft' and e.status = 'open' and invoice_balance(i.id) > 0)
  );
end
$$;

create or replace function answer_call(p_call_id uuid, p_queue_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_c staff_call%rowtype;
  v_q queue_entry%rowtype;
  v_me role_key := current_role_key();
  v_id uuid;
begin
  select * into v_c from staff_call where id = p_call_id and kind = 'next' for update;
  if not found or v_c.status <> 'open' then
    raise exception 'this call was already answered or cancelled' using errcode = '23505';
  end if;
  if not (v_me = 'manager'
          or (v_c.target = 'reception' and v_me = 'receptionist')
          or (v_c.target = 'nurse' and v_me = 'nurse')
          or (v_c.target = 'person' and v_c.to_user = auth.uid())) then
    raise exception 'this call is not for you' using errcode = '42501';
  end if;
  select * into v_q from queue_entry where id = p_queue_id and deleted_at is null and finished_at is null for update;
  if not found or not exists (select 1 from encounter where id = v_q.encounter_id and status = 'open') then
    raise exception 'that patient is no longer waiting' using errcode = 'P0002';
  end if;
  -- only a patient waiting for a doctor, at triage or reception: not one in the middle of a
  -- test, a treatment or the bill
  if v_c.station in ('laboratory', 'ultrasound', 'pharmacy', 'cashier', 'nursing', 'beds')
     and v_q.station <> v_c.station then
    raise exception 'only a patient already sent to % can be called there', initcap(v_c.station::text) using errcode = '22023';
  end if;
  if v_q.station <> coalesce(v_c.station, v_q.station)
     and v_q.station not in ('triage', 'reception', 'consultation', 'dental') then
    raise exception 'that patient is at % (not waiting for a doctor)', initcap(v_q.station::text) using errcode = '22023';
  end if;
  if v_q.taken_by is not null or (v_q.assigned_to is not null and v_q.assigned_to <> v_c.from_user) then
    raise exception 'that patient is already with %', coalesce(patient_holder(v_q.encounter_id), 'someone')
      using errcode = '23505';
  end if;
  if v_q.station = coalesce(v_c.station, v_q.station) then
    update queue_entry set assigned_to = v_c.from_user, department_id = null, referred_by = auth.uid()
    where id = v_q.id returning id into v_id;
  else
    -- waiting at another desk (e.g. triage done): they leave it for the caller's desk
    update queue_entry set finished_at = now() where id = v_q.id;
    update queue_entry set assigned_to = v_c.from_user, department_id = null, referred_by = auth.uid()
    where encounter_id = v_q.encounter_id and station = v_c.station and finished_at is null and deleted_at is null
    returning id into v_id;
    if v_id is null then
      insert into queue_entry (encounter_id, station, ticket_no, priority, assigned_to, referred_by)
      values (v_q.encounter_id, v_c.station, v_q.ticket_no, v_q.priority, v_c.from_user, auth.uid())
      returning id into v_id;
    end if;
  end if;
  -- a patient shared between several desks leaves the others
  if v_q.pool_id is not null then
    update queue_entry set finished_at = now()
    where pool_id = v_q.pool_id and id <> v_q.id and id <> v_id and finished_at is null;
  end if;
  update staff_call
  set status = 'answered', answered_by = auth.uid(), answered_at = now(), closed_at = now(),
      encounter_id = v_q.encounter_id
  where id = p_call_id;
  delete from notification where kind = 'call_next' and params ->> 'call' = p_call_id::text;
  return jsonb_build_object('encounterId', v_q.encounter_id, 'queueId', v_id);
end
$$;

create or replace function lab_summary()
returns jsonb
language sql stable security definer set search_path = public
as $$
  with today as (select (now() at time zone 'Africa/Kigali')::date as d),
  mine as (
    select r.*, d.verified_at, d.updated_at as result_at
    from service_request r
    join encounter e on e.id = r.encounter_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and r.category = any (my_test_categories())
      -- a finished visit's open test is no longer on the bench
      and (e.status = 'open' or r.status in ('resulted', 'verified', 'cancelled')) and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) in ('laboratory', 'ultrasound') and has_perm('orders.read')
  )
  select jsonb_build_object(
    'waiting', (select count(*) from mine where status = 'ordered'),
    'inProcess', (select count(*) from mine where status in ('collected', 'in_process')),
    'toVerify', (select count(*) from mine where status = 'resulted'),
    'doneToday', (select count(*) from mine, today
                  where status = 'verified' and (verified_at at time zone 'Africa/Kigali')::date = today.d),
    'urgent', (select count(*) from mine where status not in ('verified', 'cancelled') and priority <= 2),
    'orderedToday', (select count(*) from mine, today where (created_at at time zone 'Africa/Kigali')::date = today.d),
    'turnaroundMin', (select coalesce(round(avg(extract(epoch from verified_at - created_at) / 60)), 0)
                      from mine, today
                      where verified_at is not null and (verified_at at time zone 'Africa/Kigali')::date = today.d),
    'notDone', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', m.id, 'test', s.name_en, 'at', m.updated_at, 'encounterId', m.encounter_id,
          'patient', p.surname || ' ' || p.given_names,
          'reason', nullif(regexp_replace(coalesce(m.reason, ''), '^.*cancelled: ', ''), '')
        ) order by m.updated_at desc)
      from mine m
      join service s on s.id = m.service_id
      join encounter e on e.id = m.encounter_id
      join patient p on p.id = e.patient_id, today
      where m.status = 'cancelled' and (m.updated_at at time zone 'Africa/Kigali')::date = today.d
    ), '[]'::jsonb),
    'served', (select count(distinct q.encounter_id) from queue_entry q, today
               where q.deleted_at is null and q.station in ('laboratory', 'ultrasound') and q.finished_at is not null
                 and (q.finished_at at time zone 'Africa/Kigali')::date = today.d),
    'byTest', coalesce((
      select jsonb_agg(jsonb_build_object('test', t.name, 'count', t.n) order by t.n desc)
      from (select s.name_en as name, count(*) as n
            from mine m join service s on s.id = m.service_id, today
            where (m.created_at at time zone 'Africa/Kigali')::date = today.d
            group by s.name_en order by count(*) desc limit 8) t
    ), '[]'::jsonb)
  )
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
  v_loc uuid;
  v_taken boolean := false;
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
    select l.id into v_loc
    from stock_location l
    where l.deleted_at is null and l.active and l.type not in ('pharmacy', 'main_store')
      and exists (select 1 from stock_on_hand s where s.location_id = l.id and s.item_id = p_item_id
                  and s.quantity >= ceil(p_quantity))
    order by
      (l.type = case when p_station in ('nursing', 'beds', 'triage') then 'nursing'::stock_location_type
                     when p_station = 'theatre' then 'theatre'::stock_location_type end) desc nulls last,
      (l.department_id in (select department_id from staff_department where profile_id = auth.uid())) desc nulls last,
      l.created_at
    limit 1;
    if v_loc is not null then
      perform use_stock(p_item_id, v_loc, ceil(p_quantity)::integer, p_encounter_id, 'given in the room');
      v_taken := true;
    end if;
  elsif not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'pharmacy' and finished_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no)
    values (p_encounter_id, 'pharmacy', (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1));
  end if;
  return jsonb_build_object('id', v_id, 'supply', coalesce(p_supply, 'pharmacy'), 'charged', v_charged,
                            'stockTaken', v_taken);
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
  select * into v_m from medication_request where id = p_medication_request_id and deleted_at is null for update;
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
                       where s.item_id = m.item_id and l.type = 'pharmacy' and l.active and l.deleted_at is null
                         and (s.expiry is null or s.expiry >= current_date)),
    'expiredInPharmacy', (select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s
                          join stock_location l on l.id = s.location_id
                          where s.item_id = m.item_id and l.type = 'pharmacy' and s.expiry < current_date),
    'doctorHolds', exists (select 1 from queue_entry q where q.encounter_id = m.encounter_id and q.finished_at is null
                           and q.deleted_at is null and station_role(q.station) = 'doctor')
  ) order by m.created_at), '[]'::jsonb)
  from medication_request m
  join encounter e on e.id = m.encounter_id and e.status = 'open'
  join patient p on p.id = e.patient_id
  join item i on i.id = m.item_id
  left join profiles pr on pr.id = coalesce(m.prescriber_id, m.created_by)
  where has_perm('stock.read') and rx_pending(m)
$$;

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
  if p_expiry is null then
    raise exception 'give the expiry date written on the box' using errcode = '22023';
  end if;
  insert into batch (item_id, batch_no, expiry, unit_cost, supplier_id)
  values (p_item_id, v_no, p_expiry, p_unit_cost, v_supplier)
  on conflict (item_id, batch_no) do update set unit_cost = excluded.unit_cost, expiry = excluded.expiry
  returning id into v_batch;
  insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason)
  values (p_item_id, v_batch, p_location_id, p_quantity, 'receipt', nullif(trim(coalesce(p_supplier, '')), ''));
  return v_batch;
end
$$;

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
               sum(l.quantity) * coalesce((
                 select sum(b.unit_cost * m.quantity) / nullif(sum(m.quantity), 0)
                 from stock_movement m join batch b on b.id = m.batch_id
                 where m.item_id = i.id and m.type = 'receipt' and m.deleted_at is null and b.deleted_at is null), 0) as cost
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
