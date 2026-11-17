-- 0184 · Taxes. The owner (2026-11-17): "a place where we may add the side for taxes paid; the
-- accountant must be able to set the amount of tax they pay; taxes in Rwanda are paid annually,
-- monthly or quarterly, or custom; also taxes they count themselves; when sent it must be counted
-- on the expense side". Built like the salaries (0179, 0180):
--   * tax: one row per tax the clinic pays (PAYE, VAT, trading licence, income tax…): the amount
--     when it is fixed — null when the accountant works it out each time and types it when
--     paying —, how often (the salary intervals, custom included), the date the periods count
--     from, a pay day of the month if wanted
--   * tax_period: a period paid or skipped (the others are worked out from the tax); unique among
--     the live rows, the undone ones kept underneath (0183)
--   * expense.kind gains 'tax': a tax paid is money out. A one-off tax with no schedule is
--     recorded on the Expenses tab as an expense of kind tax (add_expense's p_kind)
--   * tax_periods / tax_overview, set_tax / remove_tax, pay_tax / unpay_tax / skip_tax
--   * finance_summary: the taxes apart from the salaries and the other expenses, in the net
--   * tax_alert_check: the notices (tax_due within 3 days, tax_overdue); finance_alert_check runs
--     the salary and the tax checks in one call
-- Read and changed by the manager and the cashier only (finance_right).

-- ---------------------------------------------------------------- tables
create table if not exists tax (
  like mmc_base including all,
  name text not null check (length(name) between 1 and 120),
  amount numeric(12, 0) check (amount is null or amount >= 0),
  interval_kind text not null check (interval_kind in ('weekly', 'fortnightly', 'monthly', 'every2months', 'quarterly', 'halfyearly', 'yearly', 'custom')),
  custom_every smallint check (custom_every is null or custom_every between 1 and 365),
  custom_unit text check (custom_unit is null or custom_unit in ('days', 'weeks', 'months')),
  anchor_on date not null,
  pay_day smallint check (pay_day is null or (pay_day between 1 and 31)),
  note text check (note is null or length(note) <= 300),
  set_by uuid references profiles (id) on delete set null,
  set_at timestamptz not null default now()
);
comment on table tax is 'A tax the clinic pays: the amount when fixed (null: worked out each time), how often, the date the periods count from, a pay day if wanted (0184).';
alter table tax enable row level security;
revoke all on tax from anon, authenticated;

create table if not exists tax_period (
  like mmc_base including all,
  tax_id uuid not null references tax (id) on delete cascade,
  period_start date not null,
  period_end date not null,
  due_on date not null,
  amount numeric(12, 0),
  status text not null default 'paid' check (status in ('paid', 'skipped')),
  paid_on date,
  paid_amount numeric(12, 0),
  method payment_method,
  reference text,
  note text check (note is null or length(note) <= 300),
  paid_by uuid references profiles (id) on delete set null,
  expense_id uuid
);
create unique index if not exists tax_period_live_idx on tax_period (tax_id, period_start) where deleted_at is null;
comment on table tax_period is 'A tax period settled (paid) or skipped; the periods not here are still due (0184).';
alter table tax_period enable row level security;
revoke all on tax_period from anon, authenticated;

alter table expense drop constraint if exists expense_kind_check;
alter table expense add constraint expense_kind_check check (kind in ('salary', 'tax', 'other'));
alter table expense add column if not exists tax_period_id uuid references tax_period (id) on delete set null;

-- ---------------------------------------------------------------- the periods
-- every period of a year for one tax: computed from the tax, merged with the periods settled or
-- skipped; status due / overdue / paid / skipped; the amount is the tax's, or what was paid
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
      v_out := v_out || jsonb_build_object(
        'periodStart', v_start, 'periodEnd', v_next - 1, 'dueOn', v_due,
        'amount', coalesce(v_row.paid_amount, v_row.amount, v_t.amount),
        'status', case when v_row.id is not null then v_row.status when v_due < v_today then 'overdue' else 'due' end,
        'id', v_row.id, 'paidOn', v_row.paid_on, 'paidAmount', v_row.paid_amount, 'method', v_row.method,
        'reference', v_row.reference, 'note', v_row.note,
        'paidBy', (select full_name from profiles where id = v_row.paid_by));
    end if;
    v_k := v_k + 1;
  end loop;
  return v_out;
end
$$;
revoke all on function tax_periods(uuid, integer) from public, anon;
grant execute on function tax_periods(uuid, integer) to authenticated;

create or replace function tax_period_due(p_tax uuid, p_start date)
returns date
language plpgsql stable security definer set search_path = public
as $$
declare
  v_t tax%rowtype;
  v_step interval;
  v_k integer := 0;
  v_at date;
  v_kind text;
begin
  select * into v_t from tax where id = p_tax and deleted_at is null;
  if not found or p_start < v_t.anchor_on then
    return null;
  end if;
  v_step := salary_step(v_t.interval_kind, v_t.custom_every, v_t.custom_unit);
  if v_step is null or v_step <= interval '0' then
    return null;
  end if;
  v_kind := case when salary_monthly(v_t.interval_kind, v_t.custom_unit) then 'monthly' else 'weekly' end;
  loop
    v_at := (v_t.anchor_on + v_k * v_step)::date;
    if v_at = p_start then
      return salary_due_on((v_t.anchor_on + (v_k + 1) * v_step)::date, v_kind, v_t.pay_day);
    end if;
    exit when v_at > p_start or v_k > 2000;
    v_k := v_k + 1;
  end loop;
  return null;
end
$$;
revoke all on function tax_period_due(uuid, date) from public, anon, authenticated;

create or replace function tax_step_of(p_tax uuid)
returns interval
language sql stable security definer set search_path = public
as $$
  select salary_step(t.interval_kind, t.custom_every, t.custom_unit) from tax t
  where t.id = p_tax and t.deleted_at is null
$$;
revoke all on function tax_step_of(uuid) from public, anon, authenticated;

-- every tax with its periods of the year
create or replace function tax_overview(p_year integer default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_year integer := coalesce(p_year, extract(year from (now() at time zone 'Africa/Kigali'))::int);
  v_today date := (now() at time zone 'Africa/Kigali')::date;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'year', v_year,
    'taxes', coalesce((
      select jsonb_agg(x.o order by x.name)
      from (
        select t.name, jsonb_build_object(
          'id', t.id, 'name', t.name, 'amount', t.amount,
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
      ) x), '[]'::jsonb),
    'today', v_today);
end
$$;
revoke all on function tax_overview(integer) from public, anon;
grant execute on function tax_overview(integer) to authenticated;

-- ---------------------------------------------------------------- set / remove a tax
-- p_id null: a new tax; otherwise the tax changed. p_amount null: worked out each time.
create or replace function set_tax(
  p_id uuid, p_name text, p_amount numeric, p_interval text, p_anchor_on date,
  p_pay_day integer default null, p_note text default null,
  p_custom_every integer default null, p_custom_unit text default null
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
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_name = '' then
    raise exception 'say the name of the tax' using errcode = '22023';
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
    insert into tax (name, amount, interval_kind, anchor_on, pay_day, note, custom_every, custom_unit, set_by, set_at)
    values (v_name, round(p_amount), p_interval, p_anchor_on, p_pay_day, nullif(trim(coalesce(p_note, '')), ''), v_every, v_unit, auth.uid(), now())
    returning id into v_id;
  else
    select to_jsonb(t) - 'id' into v_before from tax t where t.id = v_id and t.deleted_at is null;
    if not found then
      raise exception 'tax not found' using errcode = 'P0002';
    end if;
    update tax
    set name = v_name, amount = round(p_amount), interval_kind = p_interval, anchor_on = p_anchor_on, pay_day = p_pay_day,
        note = nullif(trim(coalesce(p_note, '')), ''), custom_every = v_every, custom_unit = v_unit,
        set_by = auth.uid(), set_at = now(), updated_at = now()
    where id = v_id;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'settings', 'tax', v_id, v_before,
          jsonb_build_object('name', v_name, 'amount', round(p_amount), 'interval', p_interval, 'every', v_every, 'unit', v_unit,
                             'anchorOn', p_anchor_on, 'payDay', p_pay_day));
  return jsonb_build_object('id', v_id, 'name', v_name, 'amount', round(p_amount), 'interval', p_interval, 'every', v_every, 'unit', v_unit,
                            'anchorOn', p_anchor_on, 'payDay', p_pay_day);
end
$$;
revoke all on function set_tax(uuid, text, numeric, text, date, integer, text, integer, text) from public, anon;
grant execute on function set_tax(uuid, text, numeric, text, date, integer, text, integer, text) to authenticated;

create or replace function remove_tax(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_before jsonb;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select to_jsonb(t) - 'id' into v_before from tax t where t.id = p_id and t.deleted_at is null;
  if not found then
    raise exception 'tax not found' using errcode = 'P0002';
  end if;
  update tax set deleted_at = now(), updated_at = now() where id = p_id;
  insert into audit_event (actor_id, action, entity, entity_id, before)
  values (auth.uid(), 'delete', 'tax', p_id, v_before);
end
$$;
revoke all on function remove_tax(uuid) from public, anon;
grant execute on function remove_tax(uuid) to authenticated;

-- ---------------------------------------------------------------- pay, undo, skip a period
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
  insert into expense (kind, label, amount, method, reference, note, paid_on, paid_by)
  values ('tax', left(v_t.name || ' · ' || to_char(p_period_start, 'DD/MM/YYYY') || ' – ' || to_char((p_period_start + tax_step_of(p_tax))::date - 1, 'DD/MM/YYYY'), 160),
          v_amount, coalesce(p_method, 'cash'), nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
          v_paid, auth.uid())
  returning id into v_exp;
  insert into tax_period (tax_id, period_start, period_end, due_on, amount, status, paid_on, paid_amount, method, reference, note, paid_by, expense_id)
  values (p_tax, p_period_start, (p_period_start + tax_step_of(p_tax))::date - 1, v_due, v_t.amount, 'paid',
          v_paid, v_amount, coalesce(p_method, 'cash'), nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
          auth.uid(), v_exp)
  returning id into v_id;
  update expense set tax_period_id = v_id where id = v_exp;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'tax_period', v_id,
          jsonb_build_object('name', v_t.name, 'periodStart', p_period_start, 'dueOn', v_due, 'paidOn', v_paid,
                             'amount', v_amount, 'method', coalesce(p_method, 'cash')));
  return jsonb_build_object('id', v_id, 'expenseId', v_exp, 'amount', v_amount, 'paidOn', v_paid, 'dueOn', v_due);
end
$$;
revoke all on function pay_tax(uuid, date, date, numeric, payment_method, text, text) from public, anon;
grant execute on function pay_tax(uuid, date, date, numeric, payment_method, text, text) to authenticated;

create or replace function unpay_tax(p_period uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_row tax_period%rowtype;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'give the reason' using errcode = '22023';
  end if;
  select * into v_row from tax_period where id = p_period and deleted_at is null;
  if not found then
    raise exception 'pay period not found' using errcode = 'P0002';
  end if;
  update expense set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason), updated_at = now()
  where id = v_row.expense_id and voided_at is null;
  update tax_period set deleted_at = now(), updated_at = now() where id = p_period;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'delete', 'tax_period', p_period, to_jsonb(v_row) - 'id', jsonb_build_object('reason', trim(p_reason)));
end
$$;
revoke all on function unpay_tax(uuid, text) from public, anon;
grant execute on function unpay_tax(uuid, text) to authenticated;

create or replace function skip_tax(p_tax uuid, p_period_start date, p_reason text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_t tax%rowtype;
  v_due date;
  v_id uuid;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'give the reason' using errcode = '22023';
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
  insert into tax_period (tax_id, period_start, period_end, due_on, amount, status, note, paid_by)
  values (p_tax, p_period_start, (p_period_start + tax_step_of(p_tax))::date - 1, v_due, v_t.amount, 'skipped', trim(p_reason), auth.uid())
  returning id into v_id;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'tax_period', v_id,
          jsonb_build_object('name', v_t.name, 'periodStart', p_period_start, 'skipped', true, 'reason', trim(p_reason)));
  return v_id;
end
$$;
revoke all on function skip_tax(uuid, date, text) from public, anon;
grant execute on function skip_tax(uuid, date, text) to authenticated;

-- ---------------------------------------------------------------- expenses: the kind
-- add_expense (20270204090000_finance_accounts): + p_kind ('other', or 'tax' for a one-off tax)
drop function if exists add_expense(text, numeric, payment_method, text, date, text);
create or replace function add_expense(
  p_label text, p_amount numeric, p_method payment_method default 'cash', p_reference text default null,
  p_paid_on date default null, p_note text default null, p_kind text default 'other'
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_kind text := coalesce(p_kind, 'other');
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_label, '')), '') is null then
    raise exception 'say what the expense is for' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'the amount paid must be more than zero' using errcode = '22023';
  end if;
  if v_kind not in ('other', 'tax') then
    raise exception 'an expense is other or tax' using errcode = '22023';
  end if;
  insert into expense (kind, label, amount, method, reference, note, paid_on, paid_by)
  values (v_kind, left(trim(p_label), 160), round(p_amount), coalesce(p_method, 'cash'), nullif(trim(coalesce(p_reference, '')), ''),
          nullif(trim(coalesce(p_note, '')), ''), coalesce(p_paid_on, (now() at time zone 'Africa/Kigali')::date), auth.uid())
  returning id into v_id;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'expense', v_id, jsonb_build_object('kind', v_kind, 'label', left(trim(p_label), 160), 'amount', round(p_amount), 'method', coalesce(p_method, 'cash')));
  return v_id;
end
$$;
revoke all on function add_expense(text, numeric, payment_method, text, date, text, text) from public, anon;
grant execute on function add_expense(text, numeric, payment_method, text, date, text, text) to authenticated;

-- void_expense (20270204090000_finance_accounts): a tax paid on a period is undone on its period
create or replace function void_expense(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_e expense%rowtype;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'give the reason' using errcode = '22023';
  end if;
  select * into v_e from expense where id = p_id and voided_at is null;
  if not found then
    raise exception 'expense not found' using errcode = 'P0002';
  end if;
  if v_e.kind = 'salary' then
    raise exception 'a salary paid is undone on its pay period' using errcode = '22023';
  end if;
  if v_e.tax_period_id is not null then
    raise exception 'a tax paid is undone on its period' using errcode = '22023';
  end if;
  update expense set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason), updated_at = now() where id = p_id;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'delete', 'expense', p_id, to_jsonb(v_e) - 'id', jsonb_build_object('reason', trim(p_reason)));
end
$$;

-- expenses_list (20270204090000_finance_accounts): the period of a salary or a tax
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
    'id', e.id, 'kind', e.kind, 'label', e.label, 'amount', e.amount, 'method', e.method, 'reference', e.reference,
    'note', e.note, 'paidOn', e.paid_on, 'paidBy', (select pr.full_name from profiles pr where pr.id = e.paid_by),
    'voided', e.voided_at is not null, 'voidReason', e.void_reason, 'periodId', coalesce(e.salary_period_id, e.tax_period_id)
  ) order by e.paid_on desc, e.created_at desc), '[]'::jsonb)
  into v_out
  from expense e
  where e.paid_on between p_from and p_to;
  return v_out;
end
$$;

-- ---------------------------------------------------------------- the money, with the taxes
-- finance_summary (20270204090000_finance_accounts): taxes apart; net = revenue − refunds −
-- salaries − taxes − other expenses − stock bought; taxesDue like salariesDue
create or replace function finance_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_revenue numeric;
  v_refunds numeric;
  v_salaries numeric;
  v_taxes numeric;
  v_other numeric;
  v_stock numeric;
  v_year integer := extract(year from (now() at time zone 'Africa/Kigali'))::int;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(sum(amount), 0) into v_revenue from payment
  where deleted_at is null and voided_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to;
  select coalesce(sum(amount), 0) into v_refunds from refund
  where deleted_at is null and (refunded_at at time zone 'Africa/Kigali')::date between p_from and p_to;
  select coalesce(sum(amount) filter (where kind = 'salary'), 0), coalesce(sum(amount) filter (where kind = 'tax'), 0),
         coalesce(sum(amount) filter (where kind = 'other'), 0)
  into v_salaries, v_taxes, v_other
  from expense where voided_at is null and paid_on between p_from and p_to;
  select coalesce(sum(m.quantity * coalesce(m.unit_cost, b.unit_cost, 0)), 0) into v_stock
  from stock_movement m left join batch b on b.id = m.batch_id
  where m.deleted_at is null and m.type = 'receipt' and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to;
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'revenue', v_revenue, 'refunds', v_refunds, 'netRevenue', v_revenue - v_refunds,
    'salaries', v_salaries, 'taxes', v_taxes, 'otherExpenses', v_other, 'stockBought', v_stock,
    'expenses', v_salaries + v_taxes + v_other + v_stock,
    'net', v_revenue - v_refunds - v_salaries - v_taxes - v_other - v_stock,
    'byMethod', coalesce((
      select jsonb_agg(jsonb_build_object('method', x.method, 'count', x.n, 'amount', x.amount) order by x.amount desc)
      from (select p.method, count(*)::int as n, sum(p.amount) as amount from payment p
            where p.deleted_at is null and p.voided_at is null and (p.paid_at at time zone 'Africa/Kigali')::date between p_from and p_to
            group by p.method) x), '[]'::jsonb),
    'byMonth', coalesce((
      select jsonb_agg(jsonb_build_object(
        'month', to_char(m.d, 'YYYY-MM'),
        'revenue', (select coalesce(sum(amount), 0) from payment p where p.deleted_at is null and p.voided_at is null
                    and date_trunc('month', p.paid_at at time zone 'Africa/Kigali') = m.d),
        'refunds', (select coalesce(sum(amount), 0) from refund r where r.deleted_at is null
                    and date_trunc('month', r.refunded_at at time zone 'Africa/Kigali') = m.d),
        'salaries', (select coalesce(sum(amount), 0) from expense e where e.voided_at is null and e.kind = 'salary' and date_trunc('month', e.paid_on) = m.d),
        'taxes', (select coalesce(sum(amount), 0) from expense e where e.voided_at is null and e.kind = 'tax' and date_trunc('month', e.paid_on) = m.d),
        'other', (select coalesce(sum(amount), 0) from expense e where e.voided_at is null and e.kind = 'other' and date_trunc('month', e.paid_on) = m.d),
        'stock', (select coalesce(sum(mv.quantity * coalesce(mv.unit_cost, b.unit_cost, 0)), 0) from stock_movement mv left join batch b on b.id = mv.batch_id
                  where mv.deleted_at is null and mv.type = 'receipt' and date_trunc('month', mv.moved_at at time zone 'Africa/Kigali') = m.d)
      ) order by m.d)
      from generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') as m(d)
      where date_trunc('month', p_to::timestamp) - date_trunc('month', p_from::timestamp) <= interval '36 months'), '[]'::jsonb),
    'salariesDue', (select coalesce(sum((e ->> 'amount')::numeric), 0)
                    from staff_salary s join profiles p on p.id = s.profile_id and p.deleted_at is null and p.active,
                         jsonb_array_elements(salary_periods(p.id, v_year)) e
                    where s.deleted_at is null and e ->> 'status' in ('due', 'overdue') and (e ->> 'dueOn')::date between p_from and p_to),
    'taxesDue', (select coalesce(sum(coalesce((e ->> 'amount')::numeric, 0)), 0)
                 from tax t, jsonb_array_elements(tax_periods(t.id, v_year)) e
                 where t.deleted_at is null and e ->> 'status' in ('due', 'overdue') and (e ->> 'dueOn')::date between p_from and p_to)
  );
end
$$;

-- ---------------------------------------------------------------- the notices
-- once a day: a tax due within 3 days (tax_due), a pay date passed and unpaid (tax_overdue)
create or replace function tax_alert_check()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_day text := to_char((now() at time zone 'Africa/Kigali')::date, 'YYYY-MM-DD');
  v_due integer := 0;
  v_over integer := 0;
  v_created integer := 0;
  r record;
begin
  if not finance_right() then
    return jsonb_build_object('due', 0, 'overdue', 0, 'created', 0);
  end if;
  perform pg_advisory_xact_lock(hashtext('mmc.tax_alert_check'));
  for r in
    select t.id, t.name, (e ->> 'periodStart')::date as period_start, (e ->> 'dueOn')::date as due_on,
           (e ->> 'amount')::numeric as amount, e ->> 'status' as status
    from tax t
    cross join lateral jsonb_array_elements(tax_periods(t.id, extract(year from v_today)::int)
                                            || tax_periods(t.id, extract(year from v_today)::int - 1)) e
    where t.deleted_at is null and e ->> 'status' in ('due', 'overdue')
      and (e ->> 'dueOn')::date <= v_today + 3
  loop
    if r.status = 'overdue' then
      v_over := v_over + 1;
      v_created := v_created + finance_notice('tax_overdue', 'tax-overdue:' || r.id || ':' || r.period_start || ':' || v_day,
        jsonb_build_object('name', r.name, 'taxId', r.id, 'dueOn', r.due_on, 'amount', r.amount,
                           'days', v_today - r.due_on),
        '/app/finance?tab=taxes&year=' || extract(year from r.period_start)::int, true);
    else
      v_due := v_due + 1;
      v_created := v_created + finance_notice('tax_due', 'tax-due:' || r.id || ':' || r.period_start,
        jsonb_build_object('name', r.name, 'taxId', r.id, 'dueOn', r.due_on, 'amount', r.amount,
                           'days', r.due_on - v_today),
        '/app/finance?tab=taxes&year=' || extract(year from r.period_start)::int, false);
    end if;
  end loop;
  return jsonb_build_object('due', v_due, 'overdue', v_over, 'created', v_created);
end
$$;
revoke all on function tax_alert_check() from public, anon;
grant execute on function tax_alert_check() to authenticated;

-- the salaries and the taxes in one daily call
create or replace function finance_alert_check()
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  return jsonb_build_object('salaries', salary_alert_check(), 'taxes', tax_alert_check());
end
$$;
revoke all on function finance_alert_check() from public, anon;
grant execute on function finance_alert_check() to authenticated;
