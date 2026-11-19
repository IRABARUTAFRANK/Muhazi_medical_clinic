-- 0187 · The taxes by kind. The owner (2026-11-19): the taxes the clinic pays are presented on
-- their own side, by how they are computed, never mixed into the other finance figures.
--   * tax.kind: 'profit' (income tax on the profit: CIT and its quarterly prepayments),
--     'turnover' (the flat tax on turnover), 'fixed' (a set amount: the trading licence),
--     'withheld' (retained at source by a payer: tax already paid, a credit on the annual
--     income tax), 'other'. The payroll remittances (0186) are the sixth group, worked out from
--     the salaries.
--   * pay_tax of a 'withheld' tax records no expense: the money never left the clinic; the
--     period is kept as a credit (tax_overview sums withheldThisYear).
--   * set_tax takes the kind; tax_overview returns it, and the year's tax base: the money in,
--     the expenses, the result before tax (finance_summary of the year) with the taxes paid by
--     kind, for the estimate the accountant reads before typing the declared amount.

alter table tax add column if not exists kind text not null default 'other'
  check (kind in ('profit', 'turnover', 'fixed', 'withheld', 'other'));

drop function if exists set_tax(uuid, text, numeric, text, date, integer, text, integer, text);
create or replace function set_tax(
  p_id uuid, p_name text, p_amount numeric, p_interval text, p_anchor_on date,
  p_pay_day integer default null, p_note text default null,
  p_custom_every integer default null, p_custom_unit text default null, p_kind text default 'other'
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_before jsonb;
  v_name text := left(trim(coalesce(p_name, '')), 120);
  v_every integer := case when p_interval = 'custom' then p_custom_every end;
  v_unit text := case when p_interval = 'custom' then p_custom_unit end;
  v_kind text := coalesce(p_kind, 'other');
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_name = '' then
    raise exception 'say the name of the tax' using errcode = '22023';
  end if;
  if v_kind not in ('profit', 'turnover', 'fixed', 'withheld', 'other') then
    raise exception 'a tax is on the profit, on the turnover, a fixed amount, withheld at source or other' using errcode = '22023';
  end if;
  if p_amount is not null and (p_amount < 0 or p_amount > 999999999) then
    raise exception 'the tax amount must be zero or more' using errcode = '22023';
  end if;
  if p_interval is null or (p_interval <> 'custom' and salary_step(p_interval) is null) then
    raise exception 'say how often the tax is paid' using errcode = '22023';
  end if;
  if p_interval = 'custom' and (v_every is null or v_every < 1 or v_every > 365 or v_unit not in ('days', 'weeks', 'months')) then
    raise exception 'a custom interval is every 1 to 365 days, weeks or months' using errcode = '22023';
  end if;
  if p_anchor_on is null then
    raise exception 'say the date the tax counts from' using errcode = '22023';
  end if;
  if p_pay_day is not null and (p_pay_day < 1 or p_pay_day > 31) then
    raise exception 'the pay day is a day of the month (1 to 31)' using errcode = '22023';
  end if;
  if v_id is null then
    insert into tax (name, kind, amount, interval_kind, anchor_on, pay_day, note, custom_every, custom_unit, set_by, set_at)
    values (v_name, v_kind, round(p_amount), p_interval, p_anchor_on, p_pay_day, nullif(trim(coalesce(p_note, '')), ''), v_every, v_unit, auth.uid(), now())
    returning id into v_id;
  else
    select to_jsonb(t) - 'id' into v_before from tax t where t.id = v_id and t.deleted_at is null;
    if not found then
      raise exception 'tax not found' using errcode = 'P0002';
    end if;
    update tax
    set name = v_name, kind = v_kind, amount = round(p_amount), interval_kind = p_interval, anchor_on = p_anchor_on, pay_day = p_pay_day,
        note = nullif(trim(coalesce(p_note, '')), ''), custom_every = v_every, custom_unit = v_unit,
        set_by = auth.uid(), set_at = now(), updated_at = now()
    where id = v_id;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'settings', 'tax', v_id, v_before,
          jsonb_build_object('name', v_name, 'kind', v_kind, 'amount', round(p_amount), 'interval', p_interval, 'every', v_every, 'unit', v_unit,
                             'anchorOn', p_anchor_on, 'payDay', p_pay_day));
  return jsonb_build_object('id', v_id, 'name', v_name, 'kind', v_kind, 'amount', round(p_amount), 'interval', p_interval, 'every', v_every, 'unit', v_unit,
                            'anchorOn', p_anchor_on, 'payDay', p_pay_day);
end
$$;
revoke all on function set_tax(uuid, text, numeric, text, date, integer, text, integer, text, text) from public, anon;
grant execute on function set_tax(uuid, text, numeric, text, date, integer, text, integer, text, text) to authenticated;

-- pay_tax (20270208090000_taxes): a tax withheld at source is a credit, not money out
create or replace function pay_tax(
  p_tax uuid, p_period_start date, p_paid_on date default null, p_amount numeric default null,
  p_method payment_method default 'cash', p_reference text default null, p_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_t tax%rowtype;
  v_due date;
  v_amount numeric;
  v_exp uuid;
  v_id uuid;
  v_paid date := coalesce(p_paid_on, (now() at time zone 'Africa/Kigali')::date);
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_t from tax where id = p_tax and deleted_at is null;
  if not found then
    raise exception 'tax not found' using errcode = 'P0002';
  end if;
  v_due := tax_period_due(p_tax, p_period_start);
  if v_due is null then
    raise exception 'this is not one of the pay periods' using errcode = '22023';
  end if;
  if exists (select 1 from tax_period where tax_id = p_tax and period_start = p_period_start and deleted_at is null) then
    raise exception 'this period is already settled' using errcode = '23505';
  end if;
  v_amount := round(coalesce(p_amount, v_t.amount));
  if v_amount is null then
    raise exception 'type the amount of tax paid' using errcode = '22023';
  end if;
  if v_amount <= 0 then
    raise exception 'the amount paid must be more than zero' using errcode = '22023';
  end if;
  if v_paid > (now() at time zone 'Africa/Kigali')::date then
    raise exception 'the pay date cannot be in the future' using errcode = '22023';
  end if;
  if v_t.kind <> 'withheld' then
    insert into expense (kind, label, amount, method, reference, note, paid_on, paid_by)
    values ('tax', left(v_t.name || ' · ' || to_char(p_period_start, 'DD/MM/YYYY') || ' – ' || to_char((p_period_start + tax_step_of(p_tax))::date - 1, 'DD/MM/YYYY'), 160),
            v_amount, coalesce(p_method, 'cash'), nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
            v_paid, auth.uid())
    returning id into v_exp;
  end if;
  insert into tax_period (tax_id, period_start, period_end, due_on, amount, status, paid_on, paid_amount, method, reference, note, paid_by, expense_id)
  values (p_tax, p_period_start, (p_period_start + tax_step_of(p_tax))::date - 1, v_due, v_t.amount, 'paid',
          v_paid, v_amount, coalesce(p_method, 'cash'), nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
          auth.uid(), v_exp)
  returning id into v_id;
  if v_exp is not null then
    update expense set tax_period_id = v_id where id = v_exp;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'tax_period', v_id,
          jsonb_build_object('name', v_t.name, 'kind', v_t.kind, 'periodStart', p_period_start, 'dueOn', v_due, 'paidOn', v_paid,
                             'amount', v_amount, 'method', coalesce(p_method, 'cash')));
  return jsonb_build_object('id', v_id, 'expenseId', v_exp, 'amount', v_amount, 'paidOn', v_paid, 'dueOn', v_due, 'kind', v_t.kind);
end
$$;

-- tax_overview (20270208090000_taxes): + the kind of each tax, and the year's tax base
create or replace function tax_overview(p_year integer default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_year integer := coalesce(p_year, extract(year from (now() at time zone 'Africa/Kigali'))::int);
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_taxes jsonb;
  v_money jsonb;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_taxes := coalesce((
    select jsonb_agg(x.o order by x.kind_order, x.name)
    from (
      select t.name, case t.kind when 'profit' then 1 when 'turnover' then 2 when 'fixed' then 3 when 'withheld' then 4 else 5 end as kind_order,
        jsonb_build_object(
          'id', t.id, 'name', t.name, 'kind', t.kind, 'amount', t.amount,
          'intervalKind', t.interval_kind, 'customEvery', t.custom_every, 'customUnit', t.custom_unit,
          'anchorOn', t.anchor_on, 'payDay', t.pay_day,
          'note', t.note, 'setAt', t.set_at, 'setBy', (select full_name from profiles where id = t.set_by),
          'periods', pr.list,
          'paidThisYear', (select coalesce(sum((e ->> 'paidAmount')::numeric), 0) from jsonb_array_elements(pr.list) e where e ->> 'status' = 'paid'),
          'overdue', (select count(*) from jsonb_array_elements(pr.list) e where e ->> 'status' = 'overdue'),
          'nextDue', (select min((e ->> 'dueOn')::date) from jsonb_array_elements(pr.list) e where e ->> 'status' in ('due', 'overdue'))
        ) as o
      from tax t
      cross join lateral (select tax_periods(t.id, v_year) as list) pr
      where t.deleted_at is null
    ) x), '[]'::jsonb);
  v_money := finance_summary(make_date(v_year, 1, 1), make_date(v_year, 12, 31));
  return jsonb_build_object(
    'year', v_year,
    'taxes', v_taxes,
    'base', jsonb_build_object(
      'moneyIn', v_money -> 'moneyIn', 'netRevenue', v_money -> 'netRevenue', 'otherIncome', v_money -> 'otherIncome',
      'salaries', v_money -> 'salaries', 'statutory', v_money -> 'statutory', 'remittances', v_money -> 'remittances',
      'otherExpenses', v_money -> 'otherExpenses', 'stockBought', v_money -> 'stockBought',
      'expenses', v_money -> 'expenses', 'resultBeforeTax', v_money -> 'net',
      'taxesPaid', v_money -> 'taxes',
      'paidByKind', coalesce((
        select jsonb_object_agg(k.kind, k.amount)
        from (select x ->> 'kind' as kind, sum((x ->> 'paidThisYear')::numeric) as amount
              from jsonb_array_elements(v_taxes) x group by 1) k), '{}'::jsonb)),
    'today', v_today);
end
$$;
