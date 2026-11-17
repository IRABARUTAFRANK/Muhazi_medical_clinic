-- 0179: the clinic's accounts — salaries, expenses and the money summary — for the cashier
-- (the accountant) and the manager.
--
-- The owner (2026-11-17): the cashier is the clinic's accountant. Beyond taking payments they
-- manage the employees' salaries (amount, how often, the contract date it counts from, a pay day
-- if wanted), the system works out every pay date of the year and marks each period paid or not;
-- a paid salary is money out (an expense) compared with the revenue; a notice goes out before a
-- pay date and while one is overdue; the reports keep the clinic's report template.
--   * staff_salary: one row per employee (amount, interval, anchor, pay day); set_salary
--   * salary_period: a period paid or skipped (the others are worked out from the salary)
--   * expense: money out — a salary paid, or any other expense the accountant records
--   * salary_periods / salary_overview: the periods of a year per employee, with their status
--   * pay_salary / unpay_salary / skip_salary, add_expense / void_expense, expenses_list
--   * finance_summary: money in by method, money out by kind, stock bought, the net, by month
--   * salary_alert_check: the notices (once a day per period)
-- Salaries are read by the manager and the cashier only (finance_right).

-- ---------------------------------------------------------------- tables
create table if not exists staff_salary (
  like mmc_base including all,
  profile_id uuid not null unique references profiles (id) on delete cascade,
  amount numeric(12, 0) not null check (amount >= 0),
  interval_kind text not null check (interval_kind in ('weekly', 'fortnightly', 'monthly', 'every2months', 'quarterly', 'halfyearly', 'yearly')),
  anchor_on date not null,
  pay_day smallint check (pay_day is null or (pay_day between 1 and 31)),
  note text check (note is null or length(note) <= 300),
  set_by uuid references profiles (id) on delete set null,
  set_at timestamptz not null default now()
);
comment on table staff_salary is 'An employee''s salary: the amount, how often it is paid, the contract date the periods count from, a pay day in the month if wanted (0179).';
alter table staff_salary enable row level security;
revoke all on staff_salary from anon, authenticated;

create table if not exists salary_period (
  like mmc_base including all,
  profile_id uuid not null references profiles (id) on delete cascade,
  period_start date not null,
  period_end date not null,
  due_on date not null,
  amount numeric(12, 0) not null,
  status text not null default 'paid' check (status in ('paid', 'skipped')),
  paid_on date,
  paid_amount numeric(12, 0),
  method payment_method,
  reference text,
  note text check (note is null or length(note) <= 300),
  paid_by uuid references profiles (id) on delete set null,
  expense_id uuid,
  unique (profile_id, period_start)
);
comment on table salary_period is 'A pay period settled (paid) or skipped; the periods not here are still due (0179).';
alter table salary_period enable row level security;
revoke all on salary_period from anon, authenticated;

create table if not exists expense (
  like mmc_base including all,
  kind text not null check (kind in ('salary', 'other')),
  label text not null check (length(label) between 1 and 160),
  amount numeric(12, 0) not null check (amount > 0),
  method payment_method not null default 'cash',
  reference text check (reference is null or length(reference) <= 80),
  note text check (note is null or length(note) <= 300),
  paid_on date not null default current_date,
  paid_by uuid references profiles (id) on delete set null,
  salary_period_id uuid references salary_period (id) on delete set null,
  voided_at timestamptz,
  voided_by uuid references profiles (id) on delete set null,
  void_reason text
);
create index if not exists expense_day_idx on expense (paid_on, kind);
comment on table expense is 'Money out: a salary paid, or any other expense of the clinic (0179).';
alter table expense enable row level security;
revoke all on expense from anon, authenticated;

-- ---------------------------------------------------------------- the right
create or replace function finance_right()
returns boolean
language sql stable security definer set search_path = public
as $$
  select is_manager() or current_role_key() = 'cashier'
$$;
revoke all on function finance_right() from public, anon;
grant execute on function finance_right() to authenticated;

-- ---------------------------------------------------------------- the periods
-- the step of an interval
create or replace function salary_step(p_kind text)
returns interval
language sql immutable
as $$
  select case p_kind
    when 'weekly' then interval '7 days'
    when 'fortnightly' then interval '14 days'
    when 'monthly' then interval '1 month'
    when 'every2months' then interval '2 months'
    when 'quarterly' then interval '3 months'
    when 'halfyearly' then interval '6 months'
    when 'yearly' then interval '1 year'
  end
$$;

-- the pay date of a period: the next start, or the pay day of that month when one is set
create or replace function salary_due_on(p_next_start date, p_kind text, p_pay_day smallint)
returns date
language sql immutable
as $$
  select case
    when p_pay_day is null or p_kind in ('weekly', 'fortnightly') then p_next_start
    else make_date(extract(year from p_next_start)::int, extract(month from p_next_start)::int,
                   least(p_pay_day::int, extract(day from (date_trunc('month', p_next_start) + interval '1 month - 1 day'))::int))
  end
$$;

-- every period of a year for one employee: computed from the salary, merged with the periods
-- settled or skipped; status due / overdue / paid / skipped
create or replace function salary_periods(p_profile uuid, p_year integer)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_s staff_salary%rowtype;
  v_end date;
  v_step interval;
  v_k integer := 0;
  v_start date;
  v_next date;
  v_due date;
  v_row salary_period%rowtype;
  v_out jsonb := '[]'::jsonb;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_s from staff_salary where profile_id = p_profile and deleted_at is null;
  if not found then
    return '[]'::jsonb;
  end if;
  select h.contract_end into v_end from staff_hr h where h.profile_id = p_profile;
  v_step := salary_step(v_s.interval_kind);
  loop
    v_start := (v_s.anchor_on + v_k * v_step)::date;
    exit when v_start > make_date(p_year, 12, 31) or v_k > 400;
    exit when v_end is not null and v_start > v_end;
    v_next := (v_s.anchor_on + (v_k + 1) * v_step)::date;
    if extract(year from v_start) = p_year then
      v_due := salary_due_on(v_next, v_s.interval_kind, v_s.pay_day);
      select * into v_row from salary_period where profile_id = p_profile and period_start = v_start and deleted_at is null;
      v_out := v_out || jsonb_build_object(
        'periodStart', v_start, 'periodEnd', v_next - 1, 'dueOn', v_due, 'amount', v_s.amount,
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
revoke all on function salary_periods(uuid, integer) from public, anon;
grant execute on function salary_periods(uuid, integer) to authenticated;

-- is p_start the start of one of the employee's periods? (its pay date, else null)
create or replace function salary_period_due(p_profile uuid, p_start date)
returns date
language plpgsql stable security definer set search_path = public
as $$
declare
  v_s staff_salary%rowtype;
  v_step interval;
  v_k integer := 0;
  v_at date;
begin
  select * into v_s from staff_salary where profile_id = p_profile and deleted_at is null;
  if not found or p_start < v_s.anchor_on then
    return null;
  end if;
  v_step := salary_step(v_s.interval_kind);
  loop
    v_at := (v_s.anchor_on + v_k * v_step)::date;
    if v_at = p_start then
      return salary_due_on((v_s.anchor_on + (v_k + 1) * v_step)::date, v_s.interval_kind, v_s.pay_day);
    end if;
    exit when v_at > p_start or v_k > 2000;
    v_k := v_k + 1;
  end loop;
  return null;
end
$$;
revoke all on function salary_period_due(uuid, date) from public, anon, authenticated;

-- every employee with a salary, for a year: the periods and the figures
create or replace function salary_overview(p_year integer default null)
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
    'people', coalesce((
      select jsonb_agg(x.o order by x.name)
      from (
        select p.full_name as name, jsonb_build_object(
          'id', p.id, 'name', p.full_name, 'role', p.role, 'staffId', p.staff_id, 'active', p.active,
          'amount', s.amount, 'intervalKind', s.interval_kind, 'anchorOn', s.anchor_on, 'payDay', s.pay_day,
          'note', s.note, 'setAt', s.set_at, 'setBy', (select full_name from profiles where id = s.set_by),
          'contractEnd', (select h.contract_end from staff_hr h where h.profile_id = p.id),
          'periods', pr.list,
          'paidThisYear', (select coalesce(sum((e ->> 'paidAmount')::numeric), 0) from jsonb_array_elements(pr.list) e where e ->> 'status' = 'paid'),
          'overdue', (select count(*) from jsonb_array_elements(pr.list) e where e ->> 'status' = 'overdue'),
          'nextDue', (select min((e ->> 'dueOn')::date) from jsonb_array_elements(pr.list) e where e ->> 'status' in ('due', 'overdue'))
        ) as o
        from staff_salary s
        join profiles p on p.id = s.profile_id and p.deleted_at is null
        cross join lateral (select salary_periods(p.id, v_year) as list) pr
        where s.deleted_at is null
      ) x), '[]'::jsonb),
    'withoutSalary', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'role', p.role) order by p.full_name)
      from profiles p
      where p.deleted_at is null and p.active
        and not exists (select 1 from staff_salary s where s.profile_id = p.id and s.deleted_at is null)), '[]'::jsonb),
    'today', v_today);
end
$$;
revoke all on function salary_overview(integer) from public, anon;
grant execute on function salary_overview(integer) to authenticated;

-- ---------------------------------------------------------------- setting a salary
create or replace function set_salary(
  p_profile uuid, p_amount numeric, p_interval text, p_anchor_on date, p_pay_day integer default null, p_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_before jsonb;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_amount is null or p_amount < 0 or p_amount > 999999999 then
    raise exception 'the salary must be zero or more' using errcode = '22023';
  end if;
  if p_interval is null or salary_step(p_interval) is null then
    raise exception 'say how often the salary is paid' using errcode = '22023';
  end if;
  if p_anchor_on is null then
    raise exception 'say the date the salary counts from' using errcode = '22023';
  end if;
  if p_pay_day is not null and (p_pay_day < 1 or p_pay_day > 31) then
    raise exception 'the pay day is a day of the month (1 to 31)' using errcode = '22023';
  end if;
  if not exists (select 1 from profiles where id = p_profile and deleted_at is null) then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  select to_jsonb(s) - 'id' into v_before from staff_salary s where s.profile_id = p_profile;
  insert into staff_salary (profile_id, amount, interval_kind, anchor_on, pay_day, note, set_by, set_at)
  values (p_profile, round(p_amount), p_interval, p_anchor_on, p_pay_day, nullif(trim(coalesce(p_note, '')), ''), auth.uid(), now())
  on conflict (profile_id) do update
    set amount = excluded.amount, interval_kind = excluded.interval_kind, anchor_on = excluded.anchor_on,
        pay_day = excluded.pay_day, note = excluded.note, set_by = excluded.set_by, set_at = now(),
        deleted_at = null, updated_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'settings', 'staff_salary', p_profile, v_before,
          jsonb_build_object('name', (select full_name from profiles where id = p_profile), 'amount', round(p_amount),
                             'interval', p_interval, 'anchorOn', p_anchor_on, 'payDay', p_pay_day));
  return jsonb_build_object('profileId', p_profile, 'amount', round(p_amount), 'interval', p_interval, 'anchorOn', p_anchor_on, 'payDay', p_pay_day);
end
$$;
revoke all on function set_salary(uuid, numeric, text, date, integer, text) from public, anon;
grant execute on function set_salary(uuid, numeric, text, date, integer, text) to authenticated;

-- the salary taken away (no more periods from now; what was paid stays)
create or replace function remove_salary(p_profile uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update staff_salary set deleted_at = now(), updated_at = now() where profile_id = p_profile and deleted_at is null;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'staff_salary', p_profile, jsonb_build_object('removed', true));
end
$$;
revoke all on function remove_salary(uuid) from public, anon;
grant execute on function remove_salary(uuid) to authenticated;

-- ---------------------------------------------------------------- paying
create or replace function pay_salary(
  p_profile uuid, p_period_start date, p_paid_on date default null, p_amount numeric default null,
  p_method payment_method default 'cash', p_reference text default null, p_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_s staff_salary%rowtype;
  v_due date;
  v_amount numeric;
  v_exp uuid;
  v_id uuid;
  v_name text;
  v_paid date := coalesce(p_paid_on, (now() at time zone 'Africa/Kigali')::date);
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_s from staff_salary where profile_id = p_profile and deleted_at is null;
  if not found then
    raise exception 'this employee has no salary set' using errcode = 'P0002';
  end if;
  v_due := salary_period_due(p_profile, p_period_start);
  if v_due is null then
    raise exception 'this is not one of the pay periods' using errcode = '22023';
  end if;
  if exists (select 1 from salary_period where profile_id = p_profile and period_start = p_period_start and deleted_at is null) then
    raise exception 'this period is already settled' using errcode = '23505';
  end if;
  v_amount := round(coalesce(p_amount, v_s.amount));
  if v_amount <= 0 then
    raise exception 'the amount paid must be more than zero' using errcode = '22023';
  end if;
  if v_paid > (now() at time zone 'Africa/Kigali')::date then
    raise exception 'the pay date cannot be in the future' using errcode = '22023';
  end if;
  select full_name into v_name from profiles where id = p_profile;
  insert into expense (kind, label, amount, method, reference, note, paid_on, paid_by)
  values ('salary', left(v_name || ' · ' || to_char(p_period_start, 'DD/MM/YYYY') || ' – ' || to_char(v_due - 1, 'DD/MM/YYYY'), 160),
          v_amount, coalesce(p_method, 'cash'), nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
          v_paid, auth.uid())
  returning id into v_exp;
  insert into salary_period (profile_id, period_start, period_end, due_on, amount, status, paid_on, paid_amount, method, reference, note, paid_by, expense_id)
  values (p_profile, p_period_start, (p_period_start + salary_step(v_s.interval_kind))::date - 1, v_due, v_s.amount, 'paid',
          v_paid, v_amount, coalesce(p_method, 'cash'), nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
          auth.uid(), v_exp)
  returning id into v_id;
  update expense set salary_period_id = v_id where id = v_exp;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'salary_period', v_id,
          jsonb_build_object('name', v_name, 'periodStart', p_period_start, 'dueOn', v_due, 'paidOn', v_paid,
                             'amount', v_amount, 'method', coalesce(p_method, 'cash')));
  return jsonb_build_object('id', v_id, 'expenseId', v_exp, 'amount', v_amount, 'paidOn', v_paid, 'dueOn', v_due);
end
$$;
revoke all on function pay_salary(uuid, date, date, numeric, payment_method, text, text) from public, anon;
grant execute on function pay_salary(uuid, date, date, numeric, payment_method, text, text) to authenticated;

-- a period marked by mistake: the payment and its expense are undone, the period is due again
create or replace function unpay_salary(p_period uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_row salary_period%rowtype;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'give the reason' using errcode = '22023';
  end if;
  select * into v_row from salary_period where id = p_period and deleted_at is null;
  if not found then
    raise exception 'pay period not found' using errcode = 'P0002';
  end if;
  update expense set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason), updated_at = now()
  where id = v_row.expense_id and voided_at is null;
  update salary_period set deleted_at = now(), updated_at = now() where id = p_period;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'delete', 'salary_period', p_period, to_jsonb(v_row) - 'id', jsonb_build_object('reason', trim(p_reason)));
end
$$;
revoke all on function unpay_salary(uuid, text) from public, anon;
grant execute on function unpay_salary(uuid, text) to authenticated;

-- a period not to be paid (unpaid leave, the contract paused): skipped, with the reason
create or replace function skip_salary(p_profile uuid, p_period_start date, p_reason text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_s staff_salary%rowtype;
  v_due date;
  v_id uuid;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'give the reason' using errcode = '22023';
  end if;
  select * into v_s from staff_salary where profile_id = p_profile and deleted_at is null;
  if not found then
    raise exception 'this employee has no salary set' using errcode = 'P0002';
  end if;
  v_due := salary_period_due(p_profile, p_period_start);
  if v_due is null then
    raise exception 'this is not one of the pay periods' using errcode = '22023';
  end if;
  if exists (select 1 from salary_period where profile_id = p_profile and period_start = p_period_start and deleted_at is null) then
    raise exception 'this period is already settled' using errcode = '23505';
  end if;
  insert into salary_period (profile_id, period_start, period_end, due_on, amount, status, note, paid_by)
  values (p_profile, p_period_start, (p_period_start + salary_step(v_s.interval_kind))::date - 1, v_due, v_s.amount, 'skipped', trim(p_reason), auth.uid())
  returning id into v_id;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'salary_period', v_id,
          jsonb_build_object('name', (select full_name from profiles where id = p_profile), 'periodStart', p_period_start, 'skipped', true, 'reason', trim(p_reason)));
  return v_id;
end
$$;
revoke all on function skip_salary(uuid, date, text) from public, anon;
grant execute on function skip_salary(uuid, date, text) to authenticated;

-- ---------------------------------------------------------------- other expenses
create or replace function add_expense(
  p_label text, p_amount numeric, p_method payment_method default 'cash', p_reference text default null,
  p_paid_on date default null, p_note text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
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
  insert into expense (kind, label, amount, method, reference, note, paid_on, paid_by)
  values ('other', left(trim(p_label), 160), round(p_amount), coalesce(p_method, 'cash'), nullif(trim(coalesce(p_reference, '')), ''),
          nullif(trim(coalesce(p_note, '')), ''), coalesce(p_paid_on, (now() at time zone 'Africa/Kigali')::date), auth.uid())
  returning id into v_id;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'expense', v_id, jsonb_build_object('label', left(trim(p_label), 160), 'amount', round(p_amount), 'method', coalesce(p_method, 'cash')));
  return v_id;
end
$$;
revoke all on function add_expense(text, numeric, payment_method, text, date, text) from public, anon;
grant execute on function add_expense(text, numeric, payment_method, text, date, text) to authenticated;

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
  update expense set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason), updated_at = now() where id = p_id;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'delete', 'expense', p_id, to_jsonb(v_e) - 'id', jsonb_build_object('reason', trim(p_reason)));
end
$$;
revoke all on function void_expense(uuid, text) from public, anon;
grant execute on function void_expense(uuid, text) to authenticated;

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
    'voided', e.voided_at is not null, 'voidReason', e.void_reason, 'periodId', e.salary_period_id
  ) order by e.paid_on desc, e.created_at desc), '[]'::jsonb)
  into v_out
  from expense e
  where e.paid_on between p_from and p_to;
  return v_out;
end
$$;
revoke all on function expenses_list(date, date) from public, anon;
grant execute on function expenses_list(date, date) to authenticated;

-- ---------------------------------------------------------------- the money
create or replace function finance_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_revenue numeric;
  v_refunds numeric;
  v_salaries numeric;
  v_other numeric;
  v_stock numeric;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(sum(amount), 0) into v_revenue from payment
  where deleted_at is null and voided_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to;
  select coalesce(sum(amount), 0) into v_refunds from refund
  where deleted_at is null and (refunded_at at time zone 'Africa/Kigali')::date between p_from and p_to;
  select coalesce(sum(amount) filter (where kind = 'salary'), 0), coalesce(sum(amount) filter (where kind = 'other'), 0)
  into v_salaries, v_other
  from expense where voided_at is null and paid_on between p_from and p_to;
  select coalesce(sum(m.quantity * coalesce(m.unit_cost, b.unit_cost, 0)), 0) into v_stock
  from stock_movement m left join batch b on b.id = m.batch_id
  where m.deleted_at is null and m.type = 'receipt' and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to;
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'revenue', v_revenue, 'refunds', v_refunds, 'netRevenue', v_revenue - v_refunds,
    'salaries', v_salaries, 'otherExpenses', v_other, 'stockBought', v_stock,
    'expenses', v_salaries + v_other + v_stock,
    'net', v_revenue - v_refunds - v_salaries - v_other - v_stock,
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
        'other', (select coalesce(sum(amount), 0) from expense e where e.voided_at is null and e.kind = 'other' and date_trunc('month', e.paid_on) = m.d),
        'stock', (select coalesce(sum(mv.quantity * coalesce(mv.unit_cost, b.unit_cost, 0)), 0) from stock_movement mv left join batch b on b.id = mv.batch_id
                  where mv.deleted_at is null and mv.type = 'receipt' and date_trunc('month', mv.moved_at at time zone 'Africa/Kigali') = m.d)
      ) order by m.d)
      from generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') as m(d)
      where date_trunc('month', p_to::timestamp) - date_trunc('month', p_from::timestamp) <= interval '36 months'), '[]'::jsonb),
    'salariesDue', (select coalesce(sum((e ->> 'amount')::numeric), 0)
                    from staff_salary s join profiles p on p.id = s.profile_id and p.deleted_at is null and p.active,
                         jsonb_array_elements(salary_periods(p.id, extract(year from (now() at time zone 'Africa/Kigali'))::int)) e
                    where s.deleted_at is null and e ->> 'status' in ('due', 'overdue') and (e ->> 'dueOn')::date between p_from and p_to)
  );
end
$$;
revoke all on function finance_summary(date, date) from public, anon;
grant execute on function finance_summary(date, date) to authenticated;

-- ---------------------------------------------------------------- the notices
create or replace function finance_notice(p_kind text, p_key text, p_params jsonb, p_link text, p_urgent boolean default false)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer := 0;
  r record;
begin
  for r in select * from (values ('manager'::role_key), ('cashier'::role_key)) as x(role) loop
    if not exists (select 1 from notification n where n.kind = p_kind and n.params ->> 'key' = p_key and n.recipient_role = r.role) then
      insert into notification (kind, params, link, urgent, recipient_role, created_by)
      values (p_kind, coalesce(p_params, '{}'::jsonb) || jsonb_build_object('key', p_key), p_link, coalesce(p_urgent, false), r.role, auth.uid());
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end
$$;
revoke all on function finance_notice(text, text, jsonb, text, boolean) from public, anon, authenticated;

-- once a day: a pay date within 3 days (salary_due), a pay date passed and unpaid (salary_overdue)
create or replace function salary_alert_check()
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
  perform pg_advisory_xact_lock(hashtext('mmc.salary_alert_check'));
  for r in
    select p.id, p.full_name, (e ->> 'periodStart')::date as period_start, (e ->> 'dueOn')::date as due_on,
           (e ->> 'amount')::numeric as amount, e ->> 'status' as status
    from staff_salary s
    join profiles p on p.id = s.profile_id and p.deleted_at is null and p.active
    cross join lateral jsonb_array_elements(salary_periods(p.id, extract(year from v_today)::int)
                                            || salary_periods(p.id, extract(year from v_today)::int - 1)) e
    where s.deleted_at is null and e ->> 'status' in ('due', 'overdue')
      and (e ->> 'dueOn')::date <= v_today + 3
  loop
    if r.status = 'overdue' then
      v_over := v_over + 1;
      v_created := v_created + finance_notice('salary_overdue', 'overdue:' || r.id || ':' || r.period_start || ':' || v_day,
        jsonb_build_object('name', r.full_name, 'profileId', r.id, 'dueOn', r.due_on, 'amount', r.amount,
                           'days', v_today - r.due_on),
        '/app/finance?tab=salaries&year=' || extract(year from r.period_start)::int, true);
    else
      v_due := v_due + 1;
      v_created := v_created + finance_notice('salary_due', 'due:' || r.id || ':' || r.period_start,
        jsonb_build_object('name', r.full_name, 'profileId', r.id, 'dueOn', r.due_on, 'amount', r.amount,
                           'days', r.due_on - v_today),
        '/app/finance?tab=salaries&year=' || extract(year from r.period_start)::int, false);
    end if;
  end loop;
  return jsonb_build_object('due', v_due, 'overdue', v_over, 'created', v_created);
end
$$;
revoke all on function salary_alert_check() from public, anon;
grant execute on function salary_alert_check() to authenticated;
