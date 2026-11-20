-- 0194 · A tax: a fixed amount or a percentage, chosen by the accountant. The owner (2026-11-20):
-- "some times there is an established amount which is deducted from a certain amount and
-- sometimes you find that it's a percentage which is calculated on that amount, like that 28
-- which is calculated on the income … I want also the system be customizable so that I may be
-- able to choose between the two … when I am creating or adding a tax in its window, or
-- deductions, or any other part of that feature".
--
-- What this file does, in plain words:
--   * A tax (Finance → Taxes) is now one of three: a fixed amount each period (as before), a
--     percentage, or typed when paying (as before, "worked out each time"). A percentage is taken
--     from the result before tax of the period, from all the money in during the period, or from
--     an amount typed when paying (what a payer paid on a tender). tax.rate and tax.rate_base hold
--     it, beside tax.amount; never an amount and a percentage together.
--   * Each period of a percentage tax that has started and is not settled is worked out from its
--     own figures (money_figure: the same sums as the Money tab), "so far" while it runs; a loss
--     gives 0. When a period is paid, the percentage, the figure used and the amount worked out
--     stay on it (tax_period.rate, rate_base, base_amount, amount); later entries never change
--     it, Undo lets it follow the figures again.
--   * A one-off tax on Other expenses can be a percentage of an amount typed there:
--     add_expense works the amount out and keeps both numbers (expense.rate, base_amount).
--   * The salary deductions already were a percentage or a fixed amount per share (0186); their
--     safer inputs are on the web only.
-- set_tax, pay_tax and add_expense gain parameters at the end (their old signatures are dropped
-- first, so a call is never ambiguous); tax_periods, tax_overview and expenses_list return the
-- new fields. No old row is rewritten: an old tax with an amount is a fixed amount, one without
-- is typed when paying.

-- ---------------------------------------------------------------- columns
alter table tax add column if not exists rate numeric(7, 4) check (rate is null or (rate > 0 and rate <= 100));
alter table tax add column if not exists rate_base text
  check (rate_base is null or rate_base in ('result', 'money_in', 'typed'));
alter table tax drop constraint if exists tax_amount_or_rate;
alter table tax add constraint tax_amount_or_rate
  check ((amount is null or rate is null) and ((rate is null) = (rate_base is null)));
comment on column tax.rate is 'A percentage tax (0194): the percentage (more than 0, at most 100); null for a fixed amount or an amount typed when paying.';
comment on column tax.rate_base is 'What the percentage is taken from (0194): result (the result before tax of the period), money_in (all money in during the period) or typed (an amount typed when paying).';

alter table tax_period add column if not exists rate numeric(7, 4);
alter table tax_period add column if not exists rate_base text;
alter table tax_period add column if not exists base_amount numeric(14, 0);
comment on column tax_period.base_amount is 'A percentage period settled (0194): the figure the percentage was taken from; amount holds the amount worked out, paid_amount what was paid.';

alter table expense add column if not exists rate numeric(7, 4) check (rate is null or (rate > 0 and rate <= 100));
alter table expense add column if not exists base_amount numeric(14, 0) check (base_amount is null or base_amount >= 0);
comment on column expense.rate is 'A one-off tax recorded as a percentage (0194): the percentage; base_amount is the amount it was taken from.';

-- the stock bought in a period, for money_figure (payments, refunds, other money in and the
-- expenses already have their day indexes)
create index if not exists stock_movement_receipt_day_idx on stock_movement (moved_at)
  where type = 'receipt' and deleted_at is null;

-- ---------------------------------------------------------------- the figure of a period
-- The money in, or the result before tax, of the days p_from..p_to: the same sums as
-- finance_summary's moneyIn and net (20270209090000_money_kinds). It reads tables only: it must
-- never call finance_summary, tax_overview, tax_periods or salary_periods (they call this through
-- tax_periods, which would loop). Internal: not callable by the screens.
create or replace function money_figure(p_base text, p_from date, p_to date)
returns numeric
language plpgsql stable security definer set search_path = public
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_in numeric;
  v_out numeric;
  v_stock numeric;
begin
  if p_base is null or p_base not in ('result', 'money_in') or p_from is null or p_to is null or p_from > p_to then
    return null;
  end if;
  v_start := p_from::timestamp at time zone 'Africa/Kigali';
  v_end := (p_to + 1)::timestamp at time zone 'Africa/Kigali';
  select coalesce(sum(amount), 0) into v_in from payment
  where deleted_at is null and voided_at is null and paid_at >= v_start and paid_at < v_end;
  v_in := v_in - (select coalesce(sum(amount), 0) from refund
                  where deleted_at is null and refunded_at >= v_start and refunded_at < v_end);
  v_in := v_in + (select coalesce(sum(amount), 0) from other_income
                  where voided_at is null and received_on between p_from and p_to);
  if p_base = 'money_in' then
    return v_in;
  end if;
  -- the salaries, the clinic's RSSB share, PAYE and RSSB handed over, the other expenses: every
  -- expense but the taxes, as finance_summary counts them
  select coalesce(sum(e.amount) filter (where e.kind = 'salary'), 0)
       + coalesce(sum(e.amount) filter (where k.code = 'statutory'), 0)
       + coalesce(sum(e.amount) filter (where k.code = 'remittance'), 0)
       + coalesce(sum(e.amount) filter (where e.kind = 'other' and coalesce(k.code, '') not in ('statutory', 'remittance')), 0)
  into v_out
  from expense e left join money_kind k on k.id = e.kind_id
  where e.voided_at is null and e.paid_on between p_from and p_to;
  select coalesce(sum(m.quantity * coalesce(m.unit_cost, b.unit_cost, 0)), 0) into v_stock
  from stock_movement m left join batch b on b.id = m.batch_id
  where m.deleted_at is null and m.type = 'receipt' and m.moved_at >= v_start and m.moved_at < v_end;
  return v_in - v_out - v_stock;
end
$$;
comment on function money_figure(text, date, date) is 'Reads tables only; never call finance_summary, tax_overview, tax_periods or salary_periods (they call this through tax_periods). 0194.';
revoke all on function money_figure(text, date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------- the periods
-- tax_periods (20270208090000_taxes): + a percentage tax's period worked out from its own figures
-- (rate, rateBase, baseAmount, workedOut, running); a settled period keeps what it was worked
-- out on. A fixed or typed tax gives the same amounts as before.
create or replace function tax_periods(p_tax uuid, p_year integer)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_t tax%rowtype;
  v_step interval;
  v_k integer := 0;
  v_start date;
  v_next date;
  v_due date;
  v_row tax_period%rowtype;
  v_out jsonb := '[]'::jsonb;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_kind text;
  v_base numeric;
  v_calc numeric;
  v_running boolean;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_t from tax where id = p_tax and deleted_at is null;
  if not found then
    return '[]'::jsonb;
  end if;
  v_step := salary_step(v_t.interval_kind, v_t.custom_every, v_t.custom_unit);
  if v_step is null or v_step <= interval '0' then
    return '[]'::jsonb;
  end if;
  v_kind := case when salary_monthly(v_t.interval_kind, v_t.custom_unit) then 'monthly' else 'weekly' end;
  loop
    v_start := (v_t.anchor_on + v_k * v_step)::date;
    exit when v_start > make_date(p_year, 12, 31) or v_k > 400;
    v_next := (v_t.anchor_on + (v_k + 1) * v_step)::date;
    if extract(year from v_start) = p_year then
      v_due := salary_due_on(v_next, v_kind, v_t.pay_day);
      select * into v_row from tax_period where tax_id = p_tax and period_start = v_start and deleted_at is null;
      v_base := null;
      v_calc := null;
      v_running := v_row.id is null and v_start <= v_today and v_today <= v_next - 1;
      if v_row.id is null and v_t.rate is not null and v_t.rate_base in ('result', 'money_in') and v_start <= v_today then
        v_base := money_figure(v_t.rate_base, v_start, v_next - 1);
        v_calc := round(greatest(v_base, 0) * v_t.rate / 100);
      end if;
      v_out := v_out || jsonb_build_object(
        'periodStart', v_start, 'periodEnd', v_next - 1, 'dueOn', v_due,
        'amount', case when v_row.id is not null then coalesce(v_row.paid_amount, v_row.amount, v_t.amount)
                       when v_t.rate is not null then v_calc
                       else v_t.amount end,
        'status', case when v_row.id is not null then v_row.status when v_due < v_today then 'overdue' else 'due' end,
        'id', v_row.id, 'paidOn', v_row.paid_on, 'paidAmount', v_row.paid_amount, 'method', v_row.method,
        'reference', v_row.reference, 'note', v_row.note,
        'paidBy', (select full_name from profiles where id = v_row.paid_by),
        'rate', case when v_row.id is not null then v_row.rate else v_t.rate end,
        'rateBase', case when v_row.id is not null then v_row.rate_base else v_t.rate_base end,
        'baseAmount', case when v_row.id is not null then v_row.base_amount else v_base end,
        'workedOut', case when v_row.id is not null then v_row.amount
                          when v_t.rate is not null then v_calc
                          else v_t.amount end,
        'running', v_running);
    end if;
    v_k := v_k + 1;
  end loop;
  return v_out;
end
$$;
revoke all on function tax_periods(uuid, integer) from public, anon;
grant execute on function tax_periods(uuid, integer) to authenticated;

-- ---------------------------------------------------------------- set a tax
-- set_tax (20270211090000_tax_kinds): + p_rate and p_rate_base. A fixed amount (p_amount), a
-- percentage (p_rate of p_rate_base), or neither (typed when paying); never both.
drop function if exists set_tax(uuid, text, numeric, text, date, integer, text, integer, text, text);
create or replace function set_tax(
  p_id uuid, p_name text, p_amount numeric, p_interval text, p_anchor_on date,
  p_pay_day integer default null, p_note text default null,
  p_custom_every integer default null, p_custom_unit text default null, p_kind text default 'other',
  p_rate numeric default null, p_rate_base text default null
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
  v_rate numeric := round(p_rate, 4);
  v_base text := case when p_rate is not null then p_rate_base end;
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
  if p_amount is not null and p_rate is not null then
    raise exception 'give a fixed amount or a percentage, not both' using errcode = '22023';
  end if;
  if p_rate is not null and (v_rate <= 0 or v_rate > 100) then
    raise exception 'the percentage must be more than 0 and at most 100' using errcode = '22023';
  end if;
  if p_rate is not null and coalesce(p_rate_base, '') not in ('result', 'money_in', 'typed') then
    raise exception 'a percentage is of the money in, of the result before tax, or of an amount typed when paying' using errcode = '22023';
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
    insert into tax (name, kind, amount, rate, rate_base, interval_kind, anchor_on, pay_day, note, custom_every, custom_unit, set_by, set_at)
    values (v_name, v_kind, round(p_amount), v_rate, v_base, p_interval, p_anchor_on, p_pay_day, nullif(trim(coalesce(p_note, '')), ''), v_every, v_unit, auth.uid(), now())
    returning id into v_id;
  else
    select to_jsonb(t) - 'id' into v_before from tax t where t.id = v_id and t.deleted_at is null;
    if not found then
      raise exception 'tax not found' using errcode = 'P0002';
    end if;
    update tax
    set name = v_name, kind = v_kind, amount = round(p_amount), rate = v_rate, rate_base = v_base,
        interval_kind = p_interval, anchor_on = p_anchor_on, pay_day = p_pay_day,
        note = nullif(trim(coalesce(p_note, '')), ''), custom_every = v_every, custom_unit = v_unit,
        set_by = auth.uid(), set_at = now(), updated_at = now()
    where id = v_id;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'settings', 'tax', v_id, v_before,
          jsonb_build_object('name', v_name, 'kind', v_kind, 'amount', round(p_amount), 'rate', v_rate, 'rateBase', v_base,
                             'interval', p_interval, 'every', v_every, 'unit', v_unit,
                             'anchorOn', p_anchor_on, 'payDay', p_pay_day));
  return jsonb_build_object('id', v_id, 'name', v_name, 'kind', v_kind, 'amount', round(p_amount), 'rate', v_rate, 'rateBase', v_base,
                            'interval', p_interval, 'every', v_every, 'unit', v_unit,
                            'anchorOn', p_anchor_on, 'payDay', p_pay_day);
end
$$;
revoke all on function set_tax(uuid, text, numeric, text, date, integer, text, integer, text, text, numeric, text) from public, anon;
grant execute on function set_tax(uuid, text, numeric, text, date, integer, text, integer, text, text, numeric, text) to authenticated;

-- ---------------------------------------------------------------- pay a tax
-- pay_tax (20270211090000_tax_kinds): + p_base_amount, the figure a percentage is taken from
-- (the period's own figure when not given; required for a percentage of an amount typed when
-- paying unless the amount paid is typed). The amount typed always wins; the period keeps the
-- percentage, the figure used and the amount worked out. A tax withheld at source is still a
-- credit, not money out.
drop function if exists pay_tax(uuid, date, date, numeric, payment_method, text, text);
create or replace function pay_tax(
  p_tax uuid, p_period_start date, p_paid_on date default null, p_amount numeric default null,
  p_method payment_method default 'cash', p_reference text default null, p_note text default null,
  p_base_amount numeric default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_t tax%rowtype;
  v_due date;
  v_end date;
  v_figure numeric;
  v_base numeric;
  v_calc numeric;
  v_amount numeric;
  v_exp uuid;
  v_id uuid;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
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
  if p_base_amount is not null and (p_base_amount < 0 or p_base_amount > 999999999999) then
    raise exception 'the amount the percentage is calculated on must be zero or more' using errcode = '22023';
  end if;
  v_end := (p_period_start + tax_step_of(p_tax))::date - 1;
  if v_t.rate is not null then
    v_figure := case when v_t.rate_base in ('result', 'money_in') and p_period_start <= v_today
                     then money_figure(v_t.rate_base, p_period_start, v_end) end;
    v_base := coalesce(round(p_base_amount), v_figure);
    if v_base is null and p_amount is null then
      raise exception 'type the amount the percentage is calculated on' using errcode = '22023';
    end if;
    v_calc := round(greatest(v_base, 0) * v_t.rate / 100);
  else
    v_calc := v_t.amount;
  end if;
  v_amount := round(coalesce(p_amount, v_calc));
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
    values ('tax', left(v_t.name || ' · ' || to_char(p_period_start, 'DD/MM/YYYY') || ' – ' || to_char(v_end, 'DD/MM/YYYY'), 160),
            v_amount, coalesce(p_method, 'cash'), nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
            v_paid, auth.uid())
    returning id into v_exp;
  end if;
  insert into tax_period (tax_id, period_start, period_end, due_on, amount, rate, rate_base, base_amount, status,
                          paid_on, paid_amount, method, reference, note, paid_by, expense_id)
  values (p_tax, p_period_start, v_end, v_due,
          case when v_t.rate is not null then v_calc else v_t.amount end,
          v_t.rate, v_t.rate_base, case when v_t.rate is not null then v_base end, 'paid',
          v_paid, v_amount, coalesce(p_method, 'cash'), nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
          auth.uid(), v_exp)
  returning id into v_id;
  if v_exp is not null then
    update expense set tax_period_id = v_id where id = v_exp;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'tax_period', v_id,
          jsonb_build_object('name', v_t.name, 'kind', v_t.kind, 'periodStart', p_period_start, 'dueOn', v_due, 'paidOn', v_paid,
                             'amount', v_amount, 'method', coalesce(p_method, 'cash'),
                             'rate', v_t.rate, 'baseAmount', case when v_t.rate is not null then v_base end,
                             'figure', v_figure, 'workedOut', case when v_t.rate is not null then v_calc else v_t.amount end));
  return jsonb_build_object('id', v_id, 'expenseId', v_exp, 'amount', v_amount, 'paidOn', v_paid, 'dueOn', v_due, 'kind', v_t.kind,
                            'rate', v_t.rate, 'baseAmount', case when v_t.rate is not null then v_base end,
                            'workedOut', case when v_t.rate is not null then v_calc else v_t.amount end);
end
$$;
revoke all on function pay_tax(uuid, date, date, numeric, payment_method, text, text, numeric) from public, anon;
grant execute on function pay_tax(uuid, date, date, numeric, payment_method, text, text, numeric) to authenticated;

-- ---------------------------------------------------------------- a one-off tax as a percentage
-- add_expense (20270209090000_money_kinds): + p_rate and p_base_amount. Given instead of an
-- amount, the amount is worked out here (round(base × rate / 100)) and both numbers are kept.
drop function if exists add_expense(text, numeric, payment_method, text, date, text, text, uuid);
create or replace function add_expense(
  p_label text, p_amount numeric, p_method payment_method default 'cash', p_reference text default null,
  p_paid_on date default null, p_note text default null, p_kind text default 'other', p_kind_id uuid default null,
  p_rate numeric default null, p_base_amount numeric default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_k money_kind%rowtype;
  v_kind text;
  v_amount numeric := p_amount;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_kind_id is not null then
    select * into v_k from money_kind where id = p_kind_id and deleted_at is null and side = 'out';
    if not found then
      raise exception 'kind not found' using errcode = 'P0002';
    end if;
    if v_k.code in ('salary', 'statutory', 'remittance', 'stock') then
      raise exception 'this kind is recorded by the system' using errcode = '22023';
    end if;
  else
    if coalesce(p_kind, 'other') not in ('other', 'tax') then
      raise exception 'an expense is other or tax' using errcode = '22023';
    end if;
    select * into v_k from money_kind where code = coalesce(p_kind, 'other');
  end if;
  v_kind := case when v_k.code = 'tax' then 'tax' else 'other' end;
  if nullif(trim(coalesce(p_label, '')), '') is null then
    raise exception 'say what the expense is for' using errcode = '22023';
  end if;
  if p_rate is not null or p_base_amount is not null then
    if p_amount is not null then
      raise exception 'give a fixed amount or a percentage, not both' using errcode = '22023';
    end if;
    if p_rate is null or round(p_rate, 4) <= 0 or p_rate > 100 then
      raise exception 'the percentage must be more than 0 and at most 100' using errcode = '22023';
    end if;
    if p_base_amount is null or p_base_amount <= 0 or p_base_amount > 999999999999 then
      raise exception 'type the amount the percentage is calculated on' using errcode = '22023';
    end if;
    v_amount := round(p_base_amount * p_rate / 100);
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'the amount paid must be more than zero' using errcode = '22023';
  end if;
  insert into expense (kind, kind_id, label, amount, rate, base_amount, method, reference, note, paid_on, paid_by)
  values (v_kind, v_k.id, left(trim(p_label), 160), round(v_amount), round(p_rate, 4), round(p_base_amount),
          coalesce(p_method, 'cash'), nullif(trim(coalesce(p_reference, '')), ''),
          nullif(trim(coalesce(p_note, '')), ''), coalesce(p_paid_on, (now() at time zone 'Africa/Kigali')::date), auth.uid())
  returning id into v_id;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'expense', v_id, jsonb_build_object('kind', v_k.name, 'label', left(trim(p_label), 160), 'amount', round(v_amount),
                                                                    'method', coalesce(p_method, 'cash'),
                                                                    'rate', round(p_rate, 4), 'baseAmount', round(p_base_amount)));
  return v_id;
end
$$;
revoke all on function add_expense(text, numeric, payment_method, text, date, text, text, uuid, numeric, numeric) from public, anon;
grant execute on function add_expense(text, numeric, payment_method, text, date, text, text, uuid, numeric, numeric) to authenticated;

-- expenses_list (20270209090000_money_kinds): + the percentage and the amount it was taken from
create or replace function expenses_list(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_out jsonb;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id, 'kind', e.kind, 'kindId', e.kind_id, 'kindCode', k.code, 'kindName', k.name,
    'label', e.label, 'amount', e.amount, 'method', e.method, 'reference', e.reference,
    'note', e.note, 'paidOn', e.paid_on, 'paidBy', (select pr.full_name from profiles pr where pr.id = e.paid_by),
    'voided', e.voided_at is not null, 'voidReason', e.void_reason, 'periodId', coalesce(e.salary_period_id, e.tax_period_id),
    'rate', e.rate, 'baseAmount', e.base_amount
  ) order by e.paid_on desc, e.created_at desc), '[]'::jsonb)
  into v_out
  from expense e left join money_kind k on k.id = e.kind_id
  where e.paid_on between p_from and p_to;
  return v_out;
end
$$;
revoke all on function expenses_list(date, date) from public, anon;
grant execute on function expenses_list(date, date) to authenticated;

-- tax_overview (20270211090000_tax_kinds): + each tax's percentage and what it is taken from
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
          'id', t.id, 'name', t.name, 'kind', t.kind, 'amount', t.amount, 'rate', t.rate, 'rateBase', t.rate_base,
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
revoke all on function tax_overview(integer) from public, anon;
grant execute on function tax_overview(integer) to authenticated;
