-- 0186 · Deductions on salaries. The owner (2026-11-19): PAYE and the other deductions (RSSB
-- pension, maternity, Mutuelle, occupational hazards, RAMA, a loan…) are rules saved once, by
-- percentage or fixed amount, with the employee's share and the employer's share; when setting
-- an employee's salary the accountant ticks which apply; the system works out the pay slip of
-- every period; a salary paid records the net to the employee, the employer's share as statutory
-- contributions, and what was withheld as owed to RRA / RSSB, handed over monthly on the Taxes
-- tab (the payroll remittances).
--   * deduction_rule + deduction_rate: the rules with their rates by "valid from" date (a rate
--     changed from 1 January 2027 leaves the earlier periods as they were)
--   * paye_band: the PAYE bands by "valid from"; paye_of() the tax of a gross pay (normal bands,
--     or the casual worker's flat 15% above the free band); staff_salary.paye_mode
--   * staff_deduction: per employee, a rule switched on or off, with an optional "until"
--   * payslip_of(): gross → PAYE → the gross-based lines → the net-based lines → net to pay, the
--     employer's lines apart; salary_periods() carries it; pay_salary() stores it and records the
--     three amounts; unpay_salary() voids both expenses
--   * remittance_period, remittances_due(), pay_remittance(), unpay_remittance(): the month's
--     withheld amounts per agency, due on the 15th of the next month
--   * remittance_alert_check(): the notices (tax_due / tax_overdue kinds, so the words exist);
--     finance_alert_check runs it too
-- Rates on day one (Rwanda, 2025–2026): pension 6% + 6%, maternity 0.3% + 0.3%, Mutuelle 0.5% of
-- the net (employee only), occupational hazards 2% employer only, RAMA 7.5% + 7.5% off by
-- default; PAYE 0% to 60,000, 10% to 100,000, 20% to 200,000, 30% above.

-- ---------------------------------------------------------------- tables
create table if not exists deduction_rule (
  like mmc_base including all,
  code text unique,
  name text not null check (length(name) between 1 and 80),
  agency text not null default 'other' check (agency in ('rra', 'rssb', 'other')),
  base text not null default 'gross' check (base in ('gross', 'net')),
  default_on boolean not null default true,
  active boolean not null default true,
  note text check (note is null or length(note) <= 300),
  sort_order integer not null default 100
);
comment on table deduction_rule is 'A deduction on salaries: PAYE, pension, maternity, Mutuelle…; its rates live in deduction_rate by valid-from date (0186).';
alter table deduction_rule enable row level security;
revoke all on deduction_rule from anon, authenticated;

create table if not exists deduction_rate (
  like mmc_base including all,
  rule_id uuid not null references deduction_rule (id) on delete cascade,
  valid_from date not null,
  employee_rate numeric(7, 4) check (employee_rate is null or employee_rate between 0 and 100),
  employee_amount numeric(12, 0) check (employee_amount is null or employee_amount >= 0),
  employer_rate numeric(7, 4) check (employer_rate is null or employer_rate between 0 and 100),
  employer_amount numeric(12, 0) check (employer_amount is null or employer_amount >= 0),
  set_by uuid references profiles (id) on delete set null,
  unique (rule_id, valid_from)
);
alter table deduction_rate enable row level security;
revoke all on deduction_rate from anon, authenticated;

create table if not exists paye_band (
  like mmc_base including all,
  valid_from date not null,
  lower_bound numeric(12, 0) not null check (lower_bound >= 0),
  rate numeric(5, 2) not null check (rate between 0 and 100),
  unique (valid_from, lower_bound)
);
alter table paye_band enable row level security;
revoke all on paye_band from anon, authenticated;

create table if not exists staff_deduction (
  like mmc_base including all,
  profile_id uuid not null references profiles (id) on delete cascade,
  rule_id uuid not null references deduction_rule (id) on delete cascade,
  applies boolean not null default true,
  until_on date,
  unique (profile_id, rule_id)
);
alter table staff_deduction enable row level security;
revoke all on staff_deduction from anon, authenticated;

alter table staff_salary add column if not exists paye_mode text not null default 'normal'
  check (paye_mode in ('normal', 'none', 'casual'));
alter table salary_period add column if not exists gross numeric(12, 0);
alter table salary_period add column if not exists net numeric(12, 0);
alter table salary_period add column if not exists employer_total numeric(12, 0);
alter table salary_period add column if not exists deductions jsonb;

create table if not exists remittance_period (
  like mmc_base including all,
  agency text not null check (agency in ('rra', 'rssb', 'other')),
  month date not null,
  status text not null default 'paid' check (status in ('paid', 'skipped')),
  employee_total numeric(12, 0),
  employer_total numeric(12, 0),
  paid_on date,
  paid_amount numeric(12, 0),
  method payment_method,
  reference text,
  note text check (note is null or length(note) <= 300),
  paid_by uuid references profiles (id) on delete set null,
  expense_id uuid
);
create unique index if not exists remittance_period_live_idx on remittance_period (agency, month) where deleted_at is null;
alter table remittance_period enable row level security;
revoke all on remittance_period from anon, authenticated;

-- the rules of day one
insert into deduction_rule (code, name, agency, base, default_on, sort_order, note)
select v.code, v.name, v.agency, v.base, v.default_on, v.sort_order, v.note
from (values
  ('paye', 'PAYE (income tax)', 'rra', 'gross', true, 10, 'By bands on the gross pay; a casual worker pays a flat 15% above the free band'),
  ('pension', 'RSSB pension', 'rssb', 'gross', true, 20, '6% + 6% in 2025–2026; 7% + 7% from 1 January 2027'),
  ('maternity', 'Maternity leave fund', 'rssb', 'gross', true, 30, null),
  ('cbhi', 'Mutuelle de santé (CBHI)', 'rssb', 'net', true, 40, '0.5% of the net pay after PAYE, pension and maternity'),
  ('hazard', 'Occupational hazards', 'rssb', 'gross', true, 50, 'Employer only'),
  ('rama', 'RSSB medical (RAMA)', 'rssb', 'gross', false, 60, 'Optional for a private employer')
) as v(code, name, agency, base, default_on, sort_order, note)
where not exists (select 1 from deduction_rule r where r.code = v.code);

insert into deduction_rate (rule_id, valid_from, employee_rate, employee_amount, employer_rate, employer_amount)
select r.id, v.valid_from::date, v.er, null, v.yr, null
from (values
  ('pension', '2025-01-01', 6.0, 6.0),
  ('pension', '2027-01-01', 7.0, 7.0),
  ('maternity', '2025-01-01', 0.3, 0.3),
  ('cbhi', '2025-01-01', 0.5, null),
  ('hazard', '2025-01-01', null, 2.0),
  ('rama', '2025-01-01', 7.5, 7.5)
) as v(code, valid_from, er, yr)
join deduction_rule r on r.code = v.code
where not exists (select 1 from deduction_rate x where x.rule_id = r.id and x.valid_from = v.valid_from::date);

insert into paye_band (valid_from, lower_bound, rate)
select '2024-01-01'::date, v.lower_bound, v.rate
from (values (0, 0), (60000, 10), (100000, 20), (200000, 30)) as v(lower_bound, rate)
where not exists (select 1 from paye_band b where b.valid_from = '2024-01-01'::date);

-- ---------------------------------------------------------------- PAYE
-- the tax on a monthly gross pay on a date: by bands (each band taxes what falls in it), or the
-- casual worker's flat 15% above the free band; 'none' pays nothing
create or replace function paye_of(p_gross numeric, p_on date default null, p_mode text default 'normal')
returns numeric
language plpgsql stable security definer set search_path = public
as $$
declare
  v_on date := coalesce(p_on, (now() at time zone 'Africa/Kigali')::date);
  v_from date;
  v_tax numeric := 0;
  v_free numeric := 0;
  r record;
  v_prev_lower numeric;
  v_prev_rate numeric;
begin
  if p_gross is null or p_gross <= 0 or coalesce(p_mode, 'normal') = 'none' then
    return 0;
  end if;
  select max(valid_from) into v_from from paye_band where deleted_at is null and valid_from <= v_on;
  if v_from is null then
    return 0;
  end if;
  if p_mode = 'casual' then
    select min(lower_bound) into v_free from paye_band where deleted_at is null and valid_from = v_from and rate > 0;
    return round(greatest(p_gross - coalesce(v_free, 0), 0) * 0.15);
  end if;
  v_prev_lower := null;
  for r in select lower_bound, rate from paye_band where deleted_at is null and valid_from = v_from order by lower_bound loop
    if v_prev_lower is not null then
      v_tax := v_tax + greatest(least(p_gross, r.lower_bound) - v_prev_lower, 0) * v_prev_rate / 100;
    end if;
    v_prev_lower := r.lower_bound;
    v_prev_rate := r.rate;
  end loop;
  if v_prev_lower is not null then
    v_tax := v_tax + greatest(p_gross - v_prev_lower, 0) * v_prev_rate / 100;
  end if;
  return round(v_tax);
end
$$;
revoke all on function paye_of(numeric, date, text) from public, anon;
grant execute on function paye_of(numeric, date, text) to authenticated;

-- the bands valid from a date, replaced as a set: [{"lower": 0, "rate": 0}, {"lower": 60000, "rate": 10}…]
create or replace function set_paye_bands(p_valid_from date, p_bands jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  b jsonb;
  v_n integer := 0;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_valid_from is null or jsonb_typeof(p_bands) <> 'array' or jsonb_array_length(p_bands) = 0 then
    raise exception 'give the bands and the date they apply from' using errcode = '22023';
  end if;
  delete from paye_band where valid_from = p_valid_from;
  for b in select * from jsonb_array_elements(p_bands) loop
    if (b ->> 'lower') is null or (b ->> 'rate') is null or (b ->> 'lower')::numeric < 0 or (b ->> 'rate')::numeric < 0 or (b ->> 'rate')::numeric > 100 then
      raise exception 'a band is a lower bound and a rate between 0 and 100' using errcode = '22023';
    end if;
    insert into paye_band (valid_from, lower_bound, rate) values (p_valid_from, round((b ->> 'lower')::numeric), (b ->> 'rate')::numeric);
    v_n := v_n + 1;
  end loop;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'paye_band', null, jsonb_build_object('validFrom', p_valid_from, 'bands', p_bands));
end
$$;
revoke all on function set_paye_bands(date, jsonb) from public, anon;
grant execute on function set_paye_bands(date, jsonb) to authenticated;

-- ---------------------------------------------------------------- the rules
create or replace function deductions_list()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'code', r.code, 'name', r.name, 'agency', r.agency, 'base', r.base,
        'defaultOn', r.default_on, 'active', r.active, 'note', r.note, 'sortOrder', r.sort_order,
        'current', (select jsonb_build_object('validFrom', x.valid_from, 'employeeRate', x.employee_rate, 'employeeAmount', x.employee_amount,
                                              'employerRate', x.employer_rate, 'employerAmount', x.employer_amount)
                    from deduction_rate x where x.rule_id = r.id and x.deleted_at is null and x.valid_from <= v_today
                    order by x.valid_from desc limit 1),
        'rates', coalesce((select jsonb_agg(jsonb_build_object('validFrom', x.valid_from, 'employeeRate', x.employee_rate, 'employeeAmount', x.employee_amount,
                                                               'employerRate', x.employer_rate, 'employerAmount', x.employer_amount) order by x.valid_from)
                           from deduction_rate x where x.rule_id = r.id and x.deleted_at is null), '[]'::jsonb),
        'people', (select count(*) from staff_deduction d where d.rule_id = r.id and d.applies and d.deleted_at is null)
      ) order by r.sort_order, r.name)
      from deduction_rule r where r.deleted_at is null), '[]'::jsonb),
    'payeBands', coalesce((
      select jsonb_agg(jsonb_build_object('validFrom', b.valid_from, 'lower', b.lower_bound, 'rate', b.rate) order by b.valid_from, b.lower_bound)
      from paye_band b where b.deleted_at is null), '[]'::jsonb),
    'today', v_today);
end
$$;
revoke all on function deductions_list() from public, anon;
grant execute on function deductions_list() to authenticated;

-- p_id null: a new rule. The rates given apply from p_valid_from (a row of that date is replaced;
-- earlier dates stay for the past periods). PAYE has no rates here: its bands.
create or replace function set_deduction(
  p_id uuid, p_name text, p_agency text, p_base text, p_default_on boolean,
  p_employee_rate numeric, p_employee_amount numeric, p_employer_rate numeric, p_employer_amount numeric,
  p_valid_from date, p_note text default null, p_active boolean default true
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_name text := left(trim(coalesce(p_name, '')), 80);
  v_r deduction_rule%rowtype;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_name = '' then
    raise exception 'say the name of the deduction' using errcode = '22023';
  end if;
  if coalesce(p_agency, 'other') not in ('rra', 'rssb', 'other') or coalesce(p_base, 'gross') not in ('gross', 'net') then
    raise exception 'a deduction goes to RRA, RSSB or another, on the gross or the net' using errcode = '22023';
  end if;
  if p_employee_rate is not null and p_employee_amount is not null then
    raise exception 'a deduction is a percentage or a fixed amount, not both' using errcode = '22023';
  end if;
  if p_employer_rate is not null and p_employer_amount is not null then
    raise exception 'a deduction is a percentage or a fixed amount, not both' using errcode = '22023';
  end if;
  if v_id is null then
    insert into deduction_rule (name, agency, base, default_on, active, note, sort_order)
    values (v_name, coalesce(p_agency, 'other'), coalesce(p_base, 'gross'), coalesce(p_default_on, false), coalesce(p_active, true),
            nullif(trim(coalesce(p_note, '')), ''), 70)
    returning id into v_id;
  else
    select * into v_r from deduction_rule where id = v_id and deleted_at is null;
    if not found then
      raise exception 'deduction not found' using errcode = 'P0002';
    end if;
    update deduction_rule
    set name = case when v_r.code is null then v_name else v_r.name end,
        agency = case when v_r.code is null then coalesce(p_agency, 'other') else v_r.agency end,
        base = case when v_r.code is null then coalesce(p_base, 'gross') else v_r.base end,
        default_on = coalesce(p_default_on, v_r.default_on), active = coalesce(p_active, true),
        note = nullif(trim(coalesce(p_note, '')), ''), updated_at = now()
    where id = v_id;
  end if;
  if coalesce(v_r.code, '') <> 'paye' then
    if p_valid_from is null then
      raise exception 'say the date the rates apply from' using errcode = '22023';
    end if;
    delete from deduction_rate where rule_id = v_id and valid_from = p_valid_from;
    insert into deduction_rate (rule_id, valid_from, employee_rate, employee_amount, employer_rate, employer_amount, set_by)
    values (v_id, p_valid_from, p_employee_rate, case when p_employee_amount is null then null else round(p_employee_amount) end,
            p_employer_rate, case when p_employer_amount is null then null else round(p_employer_amount) end, auth.uid());
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'deduction_rule', v_id,
          jsonb_build_object('name', v_name, 'agency', p_agency, 'base', p_base, 'defaultOn', p_default_on, 'validFrom', p_valid_from,
                             'employeeRate', p_employee_rate, 'employeeAmount', p_employee_amount,
                             'employerRate', p_employer_rate, 'employerAmount', p_employer_amount, 'active', p_active));
  return v_id;
end
$$;
revoke all on function set_deduction(uuid, text, text, text, boolean, numeric, numeric, numeric, numeric, date, text, boolean) from public, anon;
grant execute on function set_deduction(uuid, text, text, text, boolean, numeric, numeric, numeric, numeric, date, text, boolean) to authenticated;

-- a built-in rule is switched off (active false), the accountant's own is removed
create or replace function remove_deduction(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_r deduction_rule%rowtype;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_r from deduction_rule where id = p_id and deleted_at is null;
  if not found then
    raise exception 'deduction not found' using errcode = 'P0002';
  end if;
  if v_r.code is not null then
    update deduction_rule set active = false, updated_at = now() where id = p_id;
  else
    update deduction_rule set deleted_at = now(), updated_at = now() where id = p_id;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, before)
  values (auth.uid(), 'delete', 'deduction_rule', p_id, to_jsonb(v_r) - 'id');
end
$$;
revoke all on function remove_deduction(uuid) from public, anon;
grant execute on function remove_deduction(uuid) to authenticated;

-- per employee: a rule switched on or off, until a date if wanted (a loan over months)
create or replace function set_staff_deduction(p_profile uuid, p_rule uuid, p_applies boolean, p_until date default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from deduction_rule where id = p_rule and deleted_at is null) then
    raise exception 'deduction not found' using errcode = 'P0002';
  end if;
  insert into staff_deduction (profile_id, rule_id, applies, until_on)
  values (p_profile, p_rule, coalesce(p_applies, true), p_until)
  on conflict (profile_id, rule_id) do update
    set applies = excluded.applies, until_on = excluded.until_on, deleted_at = null, updated_at = now();
end
$$;
revoke all on function set_staff_deduction(uuid, uuid, boolean, date) from public, anon;
grant execute on function set_staff_deduction(uuid, uuid, boolean, date) to authenticated;

-- ---------------------------------------------------------------- the pay slip
-- does the rule apply to this employee on this date: switched on for them, or on by default and
-- not switched off; never after their "until"
create or replace function deduction_applies(p_profile uuid, p_rule uuid, p_on date)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    when d.id is not null then d.applies and (d.until_on is null or d.until_on >= p_on)
    else r.default_on
  end
  from deduction_rule r
  left join staff_deduction d on d.profile_id = p_profile and d.rule_id = r.id and d.deleted_at is null
  where r.id = p_rule
$$;
revoke all on function deduction_applies(uuid, uuid, date) from public, anon, authenticated;

create or replace function payslip_of(p_profile uuid, p_gross numeric, p_on date, p_paye_mode text default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_mode text := coalesce(p_paye_mode, (select s.paye_mode from staff_salary s where s.profile_id = p_profile and s.deleted_at is null), 'normal');
  v_gross numeric := round(coalesce(p_gross, 0));
  v_paye numeric := 0;
  v_lines jsonb := '[]'::jsonb;
  v_emp numeric := 0;
  v_er numeric := 0;
  v_stat numeric := 0;
  v_net_base numeric;
  r record;
  v_e numeric;
  v_y numeric;
begin
  -- PAYE first
  if exists (select 1 from deduction_rule where code = 'paye' and active and deleted_at is null) and v_mode <> 'none' then
    v_paye := paye_of(v_gross, p_on, v_mode);
    v_emp := v_paye;
    v_lines := v_lines || jsonb_build_object('code', 'paye', 'ruleId', (select id from deduction_rule where code = 'paye'),
                                             'name', (select name from deduction_rule where code = 'paye'), 'agency', 'rra', 'base', 'gross',
                                             'employee', v_paye, 'employer', 0);
  end if;
  -- the lines on the gross, then on the net (after PAYE and the gross lines)
  for r in
    select rr.id, rr.code, rr.name, rr.agency, rr.base, x.employee_rate, x.employee_amount, x.employer_rate, x.employer_amount
    from deduction_rule rr
    join lateral (
      select * from deduction_rate d where d.rule_id = rr.id and d.deleted_at is null and d.valid_from <= p_on
      order by d.valid_from desc limit 1
    ) x on true
    where rr.deleted_at is null and rr.active and coalesce(rr.code, '') <> 'paye'
      and deduction_applies(p_profile, rr.id, p_on)
    order by case rr.base when 'gross' then 0 else 1 end, rr.sort_order, rr.name
  loop
    -- the net the Mutuelle is counted on: after PAYE and the statutory lines on the gross (a loan
    -- or another deduction of the clinic's own does not lower it)
    if r.base = 'net' and v_net_base is null then
      v_net_base := v_gross - v_paye - v_stat;
    end if;
    v_e := case when r.employee_amount is not null then r.employee_amount
                when r.employee_rate is not null then round((case when r.base = 'net' then v_net_base else v_gross end) * r.employee_rate / 100)
                else 0 end;
    v_y := case when r.employer_amount is not null then r.employer_amount
                when r.employer_rate is not null then round((case when r.base = 'net' then v_net_base else v_gross end) * r.employer_rate / 100)
                else 0 end;
    v_emp := v_emp + v_e;
    v_er := v_er + v_y;
    if r.base = 'gross' and r.agency in ('rra', 'rssb') then
      v_stat := v_stat + v_e;
    end if;
    v_lines := v_lines || jsonb_build_object('code', r.code, 'ruleId', r.id, 'name', r.name, 'agency', r.agency, 'base', r.base,
                                             'employee', v_e, 'employer', v_y);
  end loop;
  return jsonb_build_object('gross', v_gross, 'paye', v_paye, 'payeMode', v_mode, 'lines', v_lines,
                            'employeeTotal', v_emp, 'net', v_gross - v_emp, 'employerTotal', v_er);
end
$$;
revoke all on function payslip_of(uuid, numeric, date, text) from public, anon;
grant execute on function payslip_of(uuid, numeric, date, text) to authenticated;

-- ---------------------------------------------------------------- the salary: PAYE mode, the periods with their slip
drop function if exists set_salary(uuid, numeric, text, date, integer, text, integer, text);
create or replace function set_salary(
  p_profile uuid, p_amount numeric, p_interval text, p_anchor_on date, p_pay_day integer default null, p_note text default null,
  p_custom_every integer default null, p_custom_unit text default null, p_paye_mode text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_before jsonb;
  v_every integer := case when p_interval = 'custom' then p_custom_every end;
  v_unit text := case when p_interval = 'custom' then p_custom_unit end;
  v_mode text := coalesce(p_paye_mode, 'normal');
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
  if v_mode not in ('normal', 'none', 'casual') then
    raise exception 'PAYE is paid, not paid, or at the casual rate' using errcode = '22023';
  end if;
  if not exists (select 1 from profiles where id = p_profile and deleted_at is null) then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  select to_jsonb(s) - 'id' into v_before from staff_salary s where s.profile_id = p_profile;
  insert into staff_salary (profile_id, amount, interval_kind, anchor_on, pay_day, note, custom_every, custom_unit, paye_mode, set_by, set_at)
  values (p_profile, round(p_amount), p_interval, p_anchor_on, p_pay_day, nullif(trim(coalesce(p_note, '')), ''), v_every, v_unit, v_mode, auth.uid(), now())
  on conflict (profile_id) do update
    set amount = excluded.amount, interval_kind = excluded.interval_kind, anchor_on = excluded.anchor_on,
        pay_day = excluded.pay_day, note = excluded.note, custom_every = excluded.custom_every, custom_unit = excluded.custom_unit,
        paye_mode = excluded.paye_mode, set_by = excluded.set_by, set_at = now(), deleted_at = null, updated_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'settings', 'staff_salary', p_profile, v_before,
          jsonb_build_object('name', (select full_name from profiles where id = p_profile), 'amount', round(p_amount),
                             'interval', p_interval, 'every', v_every, 'unit', v_unit, 'anchorOn', p_anchor_on, 'payDay', p_pay_day, 'payeMode', v_mode));
  return jsonb_build_object('profileId', p_profile, 'amount', round(p_amount), 'interval', p_interval, 'every', v_every, 'unit', v_unit,
                            'anchorOn', p_anchor_on, 'payDay', p_pay_day, 'payeMode', v_mode);
end
$$;
revoke all on function set_salary(uuid, numeric, text, date, integer, text, integer, text, text) from public, anon;
grant execute on function set_salary(uuid, numeric, text, date, integer, text, integer, text, text) to authenticated;

-- salary_periods (20270205090000_salary_custom_interval): + the slip of each period (stored when
-- paid, worked out for the others on their pay date)
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
  v_slip jsonb;
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
      if v_row.id is not null and v_row.deductions is not null then
        v_slip := jsonb_build_object('gross', v_row.gross, 'net', v_row.net, 'employerTotal', v_row.employer_total, 'lines', v_row.deductions);
      elsif v_row.id is not null then
        -- paid before 0186: the amount was the whole salary, nothing withheld
        v_slip := jsonb_build_object('gross', v_row.amount, 'net', coalesce(v_row.paid_amount, v_row.amount), 'employerTotal', 0, 'lines', '[]'::jsonb);
      else
        v_slip := payslip_of(p_profile, v_s.amount, v_due, v_s.paye_mode);
      end if;
      v_out := v_out || jsonb_build_object(
        'periodStart', v_start, 'periodEnd', v_next - 1, 'dueOn', v_due, 'amount', v_s.amount,
        'status', case when v_row.id is not null then v_row.status when v_due < v_today then 'overdue' else 'due' end,
        'id', v_row.id, 'paidOn', v_row.paid_on, 'paidAmount', v_row.paid_amount, 'method', v_row.method,
        'reference', v_row.reference, 'note', v_row.note,
        'paidBy', (select full_name from profiles where id = v_row.paid_by),
        'gross', v_slip -> 'gross', 'net', v_slip -> 'net', 'employerTotal', v_slip -> 'employerTotal', 'deductions', v_slip -> 'lines');
    end if;
    v_k := v_k + 1;
  end loop;
  return v_out;
end
$$;

-- salary_overview (20270205090000_salary_custom_interval): + payeMode and the employee's switches
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
          'anchorOn', s.anchor_on, 'payDay', s.pay_day, 'payeMode', s.paye_mode,
          'note', s.note, 'setAt', s.set_at, 'setBy', (select full_name from profiles where id = s.set_by),
          'contractEnd', (select h.contract_end from staff_hr h where h.profile_id = p.id),
          'deductions', coalesce((select jsonb_agg(jsonb_build_object('ruleId', d.rule_id, 'applies', d.applies, 'until', d.until_on))
                                  from staff_deduction d where d.profile_id = p.id and d.deleted_at is null), '[]'::jsonb),
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

-- pay_salary (20270205090000_salary_custom_interval): the slip is worked out on the pay date and
-- stored; p_amount is the NET paid (default the slip's net); the employer's contributions are a
-- second expense (statutory); what was withheld waits for the month's remittance
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
  v_exp2 uuid;
  v_id uuid;
  v_name text;
  v_paid date := coalesce(p_paid_on, (now() at time zone 'Africa/Kigali')::date);
  v_slip jsonb;
  v_label text;
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
  if v_paid > (now() at time zone 'Africa/Kigali')::date then
    raise exception 'the pay date cannot be in the future' using errcode = '22023';
  end if;
  v_slip := payslip_of(p_profile, v_s.amount, v_due, v_s.paye_mode);
  v_amount := round(coalesce(p_amount, (v_slip ->> 'net')::numeric));
  if v_amount <= 0 then
    raise exception 'the amount paid must be more than zero' using errcode = '22023';
  end if;
  select full_name into v_name from profiles where id = p_profile;
  v_label := left(v_name || ' · ' || to_char(p_period_start, 'DD/MM/YYYY') || ' – ' || to_char(v_due - 1, 'DD/MM/YYYY'), 160);
  insert into expense (kind, label, amount, method, reference, note, paid_on, paid_by)
  values ('salary', v_label, v_amount, coalesce(p_method, 'cash'), nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
          v_paid, auth.uid())
  returning id into v_exp;
  insert into salary_period (profile_id, period_start, period_end, due_on, amount, status, paid_on, paid_amount, method, reference, note, paid_by, expense_id,
                             gross, net, employer_total, deductions)
  values (p_profile, p_period_start, (p_period_start + salary_step_of(p_profile))::date - 1, v_due, v_s.amount, 'paid',
          v_paid, v_amount, coalesce(p_method, 'cash'), nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
          auth.uid(), v_exp, (v_slip ->> 'gross')::numeric, (v_slip ->> 'net')::numeric, (v_slip ->> 'employerTotal')::numeric, v_slip -> 'lines')
  returning id into v_id;
  update expense set salary_period_id = v_id where id = v_exp;
  if (v_slip ->> 'employerTotal')::numeric > 0 then
    insert into expense (kind, kind_id, label, amount, method, reference, note, paid_on, paid_by, salary_period_id)
    values ('other', (select id from money_kind where code = 'statutory'), left('RSSB · ' || v_label, 160), (v_slip ->> 'employerTotal')::numeric,
            coalesce(p_method, 'cash'), null, null, v_paid, auth.uid(), v_id)
    returning id into v_exp2;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'salary_period', v_id,
          jsonb_build_object('name', v_name, 'periodStart', p_period_start, 'dueOn', v_due, 'paidOn', v_paid,
                             'amount', v_amount, 'gross', v_slip -> 'gross', 'employerTotal', v_slip -> 'employerTotal', 'method', coalesce(p_method, 'cash')));
  return jsonb_build_object('id', v_id, 'expenseId', v_exp, 'statutoryExpenseId', v_exp2, 'amount', v_amount, 'paidOn', v_paid, 'dueOn', v_due,
                            'gross', v_slip -> 'gross', 'net', v_slip -> 'net', 'employerTotal', v_slip -> 'employerTotal', 'deductions', v_slip -> 'lines');
end
$$;

-- unpay_salary (20270204090000_finance_accounts): both expenses of the period are cancelled
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
  if exists (select 1 from remittance_period rp where rp.deleted_at is null and rp.status = 'paid'
             and v_row.paid_on is not null and rp.month = date_trunc('month', v_row.paid_on)::date
             and exists (select 1 from jsonb_array_elements(coalesce(v_row.deductions, '[]'::jsonb)) l where l ->> 'agency' = rp.agency and (l ->> 'employee')::numeric > 0)) then
    raise exception 'the month’s remittance was already paid: undo it first' using errcode = '22023';
  end if;
  update expense set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason), updated_at = now()
  where (id = v_row.expense_id or salary_period_id = p_period) and voided_at is null;
  update salary_period set deleted_at = now(), updated_at = now() where id = p_period;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'delete', 'salary_period', p_period, to_jsonb(v_row) - 'id', jsonb_build_object('reason', trim(p_reason)));
end
$$;

-- ---------------------------------------------------------------- the remittances
-- the months of a year: per agency what was withheld from the salaries paid in the month and the
-- employer's share, due on the 15th of the next month; paid or skipped from remittance_period
create or replace function remittances_due(p_year integer default null)
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
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'month', to_char(x.month, 'YYYY-MM'), 'agency', x.agency, 'dueOn', x.due_on,
      'employeeTotal', x.employee_total, 'employerTotal', x.employer_total, 'total', x.employee_total + x.employer_total,
      'people', x.people,
      'lines', x.lines,
      'status', case when rp.id is not null then rp.status when x.due_on < v_today then 'overdue' else 'due' end,
      'id', rp.id, 'paidOn', rp.paid_on, 'paidAmount', rp.paid_amount, 'method', rp.method, 'reference', rp.reference, 'note', rp.note,
      'paidBy', (select full_name from profiles where id = rp.paid_by)
    ) order by x.month, x.agency)
    from (
      select date_trunc('month', sp.paid_on)::date as month, l ->> 'agency' as agency,
             (date_trunc('month', sp.paid_on)::date + interval '1 month' + interval '14 days')::date as due_on,
             sum((l ->> 'employee')::numeric) as employee_total,
             sum((l ->> 'employer')::numeric) as employer_total,
             count(distinct sp.profile_id) as people,
             jsonb_agg(distinct jsonb_build_object('code', l ->> 'code', 'name', l ->> 'name')) as lines
      from salary_period sp
      cross join lateral jsonb_array_elements(coalesce(sp.deductions, '[]'::jsonb)) l
      where sp.deleted_at is null and sp.status = 'paid' and sp.paid_on is not null
        and extract(year from sp.paid_on) = v_year
        and ((l ->> 'employee')::numeric > 0 or (l ->> 'employer')::numeric > 0)
      group by 1, 2
    ) x
    left join remittance_period rp on rp.deleted_at is null and rp.agency = x.agency and rp.month = x.month), '[]'::jsonb);
end
$$;
revoke all on function remittances_due(integer) from public, anon;
grant execute on function remittances_due(integer) to authenticated;

-- the month's amounts handed over: the withheld part is the expense (the employer's share was
-- expensed with the salaries); p_amount is what was actually paid, for the record
create or replace function pay_remittance(
  p_agency text, p_month date, p_paid_on date default null, p_amount numeric default null,
  p_method payment_method default 'bank', p_reference text default null, p_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_emp numeric;
  v_er numeric;
  v_paid date := coalesce(p_paid_on, (now() at time zone 'Africa/Kigali')::date);
  v_exp uuid;
  v_id uuid;
  v_name text := case p_agency when 'rra' then 'RRA' when 'rssb' then 'RSSB' else 'Other' end;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_agency not in ('rra', 'rssb', 'other') or p_month is null then
    raise exception 'say the agency and the month' using errcode = '22023';
  end if;
  select coalesce(sum((l ->> 'employee')::numeric), 0), coalesce(sum((l ->> 'employer')::numeric), 0)
  into v_emp, v_er
  from salary_period sp cross join lateral jsonb_array_elements(coalesce(sp.deductions, '[]'::jsonb)) l
  where sp.deleted_at is null and sp.status = 'paid' and sp.paid_on is not null
    and date_trunc('month', sp.paid_on)::date = v_month and l ->> 'agency' = p_agency;
  if v_emp + v_er <= 0 then
    raise exception 'nothing was withheld for this agency in that month' using errcode = '22023';
  end if;
  if exists (select 1 from remittance_period where agency = p_agency and month = v_month and deleted_at is null) then
    raise exception 'this period is already settled' using errcode = '23505';
  end if;
  if v_paid > (now() at time zone 'Africa/Kigali')::date then
    raise exception 'the pay date cannot be in the future' using errcode = '22023';
  end if;
  if v_emp > 0 then
    insert into expense (kind, kind_id, label, amount, method, reference, note, paid_on, paid_by)
    values ('other', (select id from money_kind where code = 'remittance'), left(v_name || ' · ' || to_char(v_month, 'MM/YYYY'), 160),
            v_emp, coalesce(p_method, 'bank'), nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), ''), v_paid, auth.uid())
    returning id into v_exp;
  end if;
  insert into remittance_period (agency, month, status, employee_total, employer_total, paid_on, paid_amount, method, reference, note, paid_by, expense_id)
  values (p_agency, v_month, 'paid', v_emp, v_er, v_paid, round(coalesce(p_amount, v_emp + v_er)), coalesce(p_method, 'bank'),
          nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), ''), auth.uid(), v_exp)
  returning id into v_id;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'remittance_period', v_id,
          jsonb_build_object('agency', p_agency, 'month', v_month, 'paidOn', v_paid, 'employee', v_emp, 'employer', v_er, 'amount', round(coalesce(p_amount, v_emp + v_er))));
  return jsonb_build_object('id', v_id, 'expenseId', v_exp, 'employeeTotal', v_emp, 'employerTotal', v_er, 'paidOn', v_paid);
end
$$;
revoke all on function pay_remittance(text, date, date, numeric, payment_method, text, text) from public, anon;
grant execute on function pay_remittance(text, date, date, numeric, payment_method, text, text) to authenticated;

create or replace function unpay_remittance(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_row remittance_period%rowtype;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'give the reason' using errcode = '22023';
  end if;
  select * into v_row from remittance_period where id = p_id and deleted_at is null;
  if not found then
    raise exception 'pay period not found' using errcode = 'P0002';
  end if;
  update expense set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason), updated_at = now()
  where id = v_row.expense_id and voided_at is null;
  update remittance_period set deleted_at = now(), updated_at = now() where id = p_id;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'delete', 'remittance_period', p_id, to_jsonb(v_row) - 'id', jsonb_build_object('reason', trim(p_reason)));
end
$$;
revoke all on function unpay_remittance(uuid, text) from public, anon;
grant execute on function unpay_remittance(uuid, text) to authenticated;

-- a month's remittance skipped (nothing to hand over, paid outside the system…)
create or replace function skip_remittance(p_agency text, p_month date, p_reason text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_id uuid;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'give the reason' using errcode = '22023';
  end if;
  if p_agency not in ('rra', 'rssb', 'other') or p_month is null then
    raise exception 'say the agency and the month' using errcode = '22023';
  end if;
  if exists (select 1 from remittance_period where agency = p_agency and month = v_month and deleted_at is null) then
    raise exception 'this period is already settled' using errcode = '23505';
  end if;
  insert into remittance_period (agency, month, status, note, paid_by)
  values (p_agency, v_month, 'skipped', trim(p_reason), auth.uid())
  returning id into v_id;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'remittance_period', v_id, jsonb_build_object('agency', p_agency, 'month', v_month, 'skipped', true, 'reason', trim(p_reason)));
  return v_id;
end
$$;
revoke all on function skip_remittance(text, date, text) from public, anon;
grant execute on function skip_remittance(text, date, text) to authenticated;

-- the notices: a remittance due within 3 days or overdue (the tax notice kinds carry the words)
create or replace function remittance_alert_check()
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
  v_name text;
begin
  if not finance_right() then
    return jsonb_build_object('due', 0, 'overdue', 0, 'created', 0);
  end if;
  perform pg_advisory_xact_lock(hashtext('mmc.remittance_alert_check'));
  for r in
    select e ->> 'agency' as agency, e ->> 'month' as month, (e ->> 'dueOn')::date as due_on,
           (e ->> 'total')::numeric as amount, e ->> 'status' as status
    from jsonb_array_elements(remittances_due(extract(year from v_today)::int) || remittances_due(extract(year from v_today)::int - 1)) e
    where e ->> 'status' in ('due', 'overdue') and (e ->> 'dueOn')::date <= v_today + 3
  loop
    v_name := (case r.agency when 'rra' then 'RRA' when 'rssb' then 'RSSB' else 'Other' end) || ' ' || r.month;
    if r.status = 'overdue' then
      v_over := v_over + 1;
      v_created := v_created + finance_notice('tax_overdue', 'remit-overdue:' || r.agency || ':' || r.month || ':' || v_day,
        jsonb_build_object('name', v_name, 'dueOn', r.due_on, 'amount', r.amount, 'days', v_today - r.due_on),
        '/app/finance?tab=taxes', true);
    else
      v_due := v_due + 1;
      v_created := v_created + finance_notice('tax_due', 'remit-due:' || r.agency || ':' || r.month,
        jsonb_build_object('name', v_name, 'dueOn', r.due_on, 'amount', r.amount, 'days', r.due_on - v_today),
        '/app/finance?tab=taxes', false);
    end if;
  end loop;
  return jsonb_build_object('due', v_due, 'overdue', v_over, 'created', v_created);
end
$$;
revoke all on function remittance_alert_check() from public, anon;
grant execute on function remittance_alert_check() to authenticated;

create or replace function finance_alert_check()
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  return jsonb_build_object('salaries', salary_alert_check(), 'taxes', tax_alert_check(), 'remittances', remittance_alert_check());
end
$$;
