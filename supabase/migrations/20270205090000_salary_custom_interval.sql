-- 0180: a custom pay interval — every N days, weeks or months (the owner, 2026-11-17).
--
-- staff_salary.interval_kind gains 'custom', with custom_every and custom_unit; the periods and
-- the pay dates follow it. set_salary takes the two more values (its old signature goes, so a
-- call with six values still reaches it through the defaults).

alter table staff_salary add column if not exists custom_every smallint check (custom_every is null or custom_every between 1 and 365);
alter table staff_salary add column if not exists custom_unit text check (custom_unit is null or custom_unit in ('days', 'weeks', 'months'));
alter table staff_salary drop constraint if exists staff_salary_interval_kind_check;
alter table staff_salary add constraint staff_salary_interval_kind_check
  check (interval_kind in ('weekly', 'fortnightly', 'monthly', 'every2months', 'quarterly', 'halfyearly', 'yearly', 'custom'));

-- the step of an interval, the custom one from its two values
create or replace function salary_step(p_kind text, p_every integer, p_unit text)
returns interval
language sql immutable
as $$
  select case
    when p_kind = 'custom' then case p_unit
      when 'days' then make_interval(days => coalesce(p_every, 0))
      when 'weeks' then make_interval(weeks => coalesce(p_every, 0))
      when 'months' then make_interval(months => coalesce(p_every, 0))
    end
    else salary_step(p_kind)
  end
$$;

-- a pay day of the month applies to intervals counted in months (never to days or weeks)
create or replace function salary_monthly(p_kind text, p_unit text)
returns boolean
language sql immutable
as $$
  select case
    when p_kind in ('weekly', 'fortnightly') then false
    when p_kind = 'custom' then p_unit = 'months'
    else true
  end
$$;

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
  v_kind text;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_s from staff_salary where profile_id = p_profile and deleted_at is null;
  if not found then
    return '[]'::jsonb;
  end if;
  select h.contract_end into v_end from staff_hr h where h.profile_id = p_profile;
  v_step := salary_step(v_s.interval_kind, v_s.custom_every, v_s.custom_unit);
  if v_step is null or v_step <= interval '0' then
    return '[]'::jsonb;
  end if;
  v_kind := case when salary_monthly(v_s.interval_kind, v_s.custom_unit) then 'monthly' else 'weekly' end;
  loop
    v_start := (v_s.anchor_on + v_k * v_step)::date;
    exit when v_start > make_date(p_year, 12, 31) or v_k > 400;
    exit when v_end is not null and v_start > v_end;
    v_next := (v_s.anchor_on + (v_k + 1) * v_step)::date;
    if extract(year from v_start) = p_year then
      v_due := salary_due_on(v_next, v_kind, v_s.pay_day);
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

create or replace function salary_period_due(p_profile uuid, p_start date)
returns date
language plpgsql stable security definer set search_path = public
as $$
declare
  v_s staff_salary%rowtype;
  v_step interval;
  v_k integer := 0;
  v_at date;
  v_kind text;
begin
  select * into v_s from staff_salary where profile_id = p_profile and deleted_at is null;
  if not found or p_start < v_s.anchor_on then
    return null;
  end if;
  v_step := salary_step(v_s.interval_kind, v_s.custom_every, v_s.custom_unit);
  if v_step is null or v_step <= interval '0' then
    return null;
  end if;
  v_kind := case when salary_monthly(v_s.interval_kind, v_s.custom_unit) then 'monthly' else 'weekly' end;
  loop
    v_at := (v_s.anchor_on + v_k * v_step)::date;
    if v_at = p_start then
      return salary_due_on((v_s.anchor_on + (v_k + 1) * v_step)::date, v_kind, v_s.pay_day);
    end if;
    exit when v_at > p_start or v_k > 2000;
    v_k := v_k + 1;
  end loop;
  return null;
end
$$;

-- pay_salary and skip_salary end a period with the salary's step: the custom one too
create or replace function salary_step_of(p_profile uuid)
returns interval
language sql stable security definer set search_path = public
as $$
  select salary_step(s.interval_kind, s.custom_every, s.custom_unit) from staff_salary s
  where s.profile_id = p_profile and s.deleted_at is null
$$;
revoke all on function salary_step_of(uuid) from public, anon, authenticated;

drop function if exists set_salary(uuid, numeric, text, date, integer, text);
create or replace function set_salary(
  p_profile uuid, p_amount numeric, p_interval text, p_anchor_on date, p_pay_day integer default null, p_note text default null,
  p_custom_every integer default null, p_custom_unit text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_before jsonb;
  v_every integer := case when p_interval = 'custom' then p_custom_every end;
  v_unit text := case when p_interval = 'custom' then p_custom_unit end;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_amount is null or p_amount < 0 or p_amount > 999999999 then
    raise exception 'the salary must be zero or more' using errcode = '22023';
  end if;
  if p_interval is null or (p_interval <> 'custom' and salary_step(p_interval) is null) then
    raise exception 'say how often the salary is paid' using errcode = '22023';
  end if;
  if p_interval = 'custom' and (v_every is null or v_every < 1 or v_every > 365 or v_unit not in ('days', 'weeks', 'months')) then
    raise exception 'a custom interval is every 1 to 365 days, weeks or months' using errcode = '22023';
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
  insert into staff_salary (profile_id, amount, interval_kind, anchor_on, pay_day, note, custom_every, custom_unit, set_by, set_at)
  values (p_profile, round(p_amount), p_interval, p_anchor_on, p_pay_day, nullif(trim(coalesce(p_note, '')), ''), v_every, v_unit, auth.uid(), now())
  on conflict (profile_id) do update
    set amount = excluded.amount, interval_kind = excluded.interval_kind, anchor_on = excluded.anchor_on,
        pay_day = excluded.pay_day, note = excluded.note, custom_every = excluded.custom_every, custom_unit = excluded.custom_unit,
        set_by = excluded.set_by, set_at = now(), deleted_at = null, updated_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'settings', 'staff_salary', p_profile, v_before,
          jsonb_build_object('name', (select full_name from profiles where id = p_profile), 'amount', round(p_amount),
                             'interval', p_interval, 'every', v_every, 'unit', v_unit, 'anchorOn', p_anchor_on, 'payDay', p_pay_day));
  return jsonb_build_object('profileId', p_profile, 'amount', round(p_amount), 'interval', p_interval, 'every', v_every, 'unit', v_unit,
                            'anchorOn', p_anchor_on, 'payDay', p_pay_day);
end
$$;
revoke all on function set_salary(uuid, numeric, text, date, integer, text, integer, text) from public, anon;
grant execute on function set_salary(uuid, numeric, text, date, integer, text, integer, text) to authenticated;

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
          'amount', s.amount, 'intervalKind', s.interval_kind, 'customEvery', s.custom_every, 'customUnit', s.custom_unit,
          'anchorOn', s.anchor_on, 'payDay', s.pay_day,
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

-- ---------------------------------------------------------------- pay_salary, skip_salary (from 20270204090000_finance_accounts): the salary's own step
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
  values (p_profile, p_period_start, (p_period_start + salary_step_of(p_profile))::date - 1, v_due, v_s.amount, 'paid',
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
  values (p_profile, p_period_start, (p_period_start + salary_step_of(p_profile))::date - 1, v_due, v_s.amount, 'skipped', trim(p_reason), auth.uid())
  returning id into v_id;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'salary_period', v_id,
          jsonb_build_object('name', (select full_name from profiles where id = p_profile), 'periodStart', p_period_start, 'skipped', true, 'reason', trim(p_reason)));
  return v_id;
end
$$;
