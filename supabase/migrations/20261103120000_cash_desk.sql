-- 0062 · The cash desk.
-- A wrong payment (wrong amount, wrong patient, a MoMo that did not arrive) is cancelled with a
-- reason: by the cashier who took it, the same day, before counting the cash; by the manager at
-- any time. The bill owes it again. Each cashier counts the cash at the end of the day: what
-- they hold per method against what the payments say, the difference is kept (day_close).

alter table payment add column if not exists void_reason text;
alter table payment add column if not exists voided_by uuid references profiles (id) on delete set null;
alter table payment add column if not exists voided_at timestamptz;

create or replace function void_payment(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_p payment%rowtype;
  v_enc uuid;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the payment is cancelled' using errcode = '22023';
  end if;
  select * into v_p from payment where id = p_payment_id and deleted_at is null for update;
  if not found then
    raise exception 'payment not found or already cancelled' using errcode = 'P0002';
  end if;
  if not is_manager() then
    if not (has_perm('billing.write') or has_perm('payment.take')) or v_p.cashier_id is distinct from auth.uid() then
      raise exception 'only the person who took the payment (or the manager) can cancel it' using errcode = '42501';
    end if;
    if (v_p.paid_at at time zone 'Africa/Kigali')::date <> (now() at time zone 'Africa/Kigali')::date then
      raise exception 'a payment of another day is cancelled by the manager' using errcode = '42501';
    end if;
    if v_p.day_close_id is not null then
      raise exception 'the cash of that day is already counted: ask the manager' using errcode = '42501';
    end if;
  end if;
  update payment set deleted_at = now(), void_reason = trim(p_reason), voided_by = auth.uid(), voided_at = now()
  where id = p_payment_id;
  select encounter_id into v_enc from invoice where id = v_p.invoice_id;
  return jsonb_build_object('encounterId', v_enc, 'balance', invoice_balance(v_p.invoice_id));
end
$$;

-- The cashier counts what they hold at the end of the day (per method); the difference is kept.
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
  select coalesce(jsonb_object_agg(m.method, m.amount), '{}'::jsonb) into v_expected
  from (select method::text as method, sum(amount) as amount from payment
        where deleted_at is null and cashier_id = auth.uid()
          and (paid_at at time zone 'Africa/Kigali')::date = v_day
        group by method) m;
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
                      where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date = v_day - 1),
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
      select jsonb_object_agg(m.method, m.amount)
      from (select method::text as method, sum(amount) as amount from payment
            where deleted_at is null and cashier_id = auth.uid()
              and (paid_at at time zone 'Africa/Kigali')::date = v_day
            group by method) m
    ), '{}'::jsonb),
    'openBills', (select count(*) from invoice i join encounter e on e.id = i.encounter_id
                  where i.deleted_at is null and i.status = 'draft' and e.status = 'open' and invoice_balance(i.id) > 0),
    'openDue', (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id
                where i.deleted_at is null and i.status = 'draft' and e.status = 'open' and invoice_balance(i.id) > 0)
  );
end
$$;


revoke all on function void_payment(uuid, text), close_cash_day(date, jsonb, text) from public, anon;
grant execute on function void_payment(uuid, text), close_cash_day(date, jsonb, text) to authenticated;

