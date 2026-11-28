-- 0214 · The rules on salaries, every part editable. The owner (2026-11-28): "those rules will be
-- customizable … when there are other updated rules it is possible to update also in our system,
-- or if there is one that the clinic does not pay then we turn it off … precise and accurate".
--   * every rule (built in or the clinic's own) is switched off and on again with
--     set_deduction_active(); editing a rule keeps it as it was (on or off)
--   * a built-in rule's "Paid to" and "Counted on" can be changed (PAYE stays RRA, on the gross)
--   * the rates of a rule by date: saving the same rates again adds no row; a dated rate typed by
--     mistake is removed (remove_deduction_rate), the last one stays
--   * the PAYE bands by date: the casual worker's rate (was 15% fixed) is saved with each set of
--     bands (paye_casual); two bands starting at the same amount are refused; a set of bands is
--     removed (remove_paye_bands), the last one stays
--   * the day of the next month PAYE and RSSB are handed over by (was the 15th, fixed):
--     remittance_day, per agency; remittances_due() uses it
--   * payslip_preview(): a salary tried before it is paid (the rules of a date, for everyone or
--     for one employee)
--   * deductions_list(): + each rate's date and who set it, the employees a rule applies to
--     really (those it is on for by default count too), the sets of bands with their casual rate,
--     the hand-over days
--   * void_expense(): the clinic's share paid to RSSB and a hand-over are undone where they were
--     made (with the salary, on the Taxes tab), not cancelled alone from the expenses list

-- ---------------------------------------------------------------- tables
create table if not exists paye_casual (
  valid_from date primary key,
  rate numeric(5, 2) not null check (rate between 0 and 100),
  set_by uuid references profiles (id) on delete set null,
  set_at timestamptz not null default now()
);
comment on table paye_casual is 'The casual worker''s PAYE rate above the free band, by valid-from date (0214; was 15% fixed).';
alter table paye_casual enable row level security;
revoke all on paye_casual from anon, authenticated;
insert into paye_casual (valid_from, rate)
select coalesce((select min(valid_from) from paye_band where deleted_at is null), '2024-01-01'::date), 15
where not exists (select 1 from paye_casual);

create table if not exists remittance_day (
  agency text primary key check (agency in ('rra', 'rssb', 'other')),
  due_day integer not null check (due_day between 1 and 28),
  set_by uuid references profiles (id) on delete set null,
  set_at timestamptz not null default now()
);
comment on table remittance_day is 'The day of the next month what was withheld from salaries is handed over by, per agency (0214; was the 15th).';
alter table remittance_day enable row level security;
revoke all on remittance_day from anon, authenticated;
insert into remittance_day (agency, due_day)
select v.agency, 15 from (values ('rra'), ('rssb'), ('other')) as v(agency)
where not exists (select 1 from remittance_day d where d.agency = v.agency);

-- ---------------------------------------------------------------- PAYE
-- paye_of (20270210090000_salary_deductions): the casual worker's rate from paye_casual
create or replace function paye_of(p_gross numeric, p_on date default null, p_mode text default 'normal')
returns numeric
language plpgsql stable security definer set search_path = public
as $$
declare
  v_on date := coalesce(p_on, (now() at time zone 'Africa/Kigali')::date);
  v_from date;
  v_tax numeric := 0;
  v_free numeric := 0;
  v_casual numeric;
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
    select c.rate into v_casual from paye_casual c where c.valid_from <= v_on order by c.valid_from desc limit 1;
    return round(greatest(p_gross - coalesce(v_free, 0), 0) * coalesce(v_casual, 15) / 100);
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

-- the bands valid from a date, replaced as a set, with the casual worker's rate of that date
-- (null: the rate in force stays)
drop function if exists set_paye_bands(date, jsonb);
create or replace function set_paye_bands(p_valid_from date, p_bands jsonb, p_casual_rate numeric default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  b jsonb;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_valid_from is null or jsonb_typeof(p_bands) <> 'array' or jsonb_array_length(p_bands) = 0 then
    raise exception 'give the bands and the date they apply from' using errcode = '22023';
  end if;
  for b in select * from jsonb_array_elements(p_bands) loop
    if (b ->> 'lower') is null or (b ->> 'rate') is null or (b ->> 'lower')::numeric < 0 or (b ->> 'rate')::numeric < 0 or (b ->> 'rate')::numeric > 100 then
      raise exception 'a band is a lower bound and a rate between 0 and 100' using errcode = '22023';
    end if;
  end loop;
  if (select count(distinct round((e ->> 'lower')::numeric)) from jsonb_array_elements(p_bands) e) < jsonb_array_length(p_bands) then
    raise exception 'two bands start at the same amount' using errcode = '22023';
  end if;
  if p_casual_rate is not null and (p_casual_rate < 0 or p_casual_rate > 100) then
    raise exception 'the casual worker''s rate is between 0 and 100' using errcode = '22023';
  end if;
  delete from paye_band where valid_from = p_valid_from;
  insert into paye_band (valid_from, lower_bound, rate)
  select p_valid_from, round((e ->> 'lower')::numeric), (e ->> 'rate')::numeric from jsonb_array_elements(p_bands) e;
  if p_casual_rate is not null then
    insert into paye_casual (valid_from, rate, set_by, set_at) values (p_valid_from, p_casual_rate, auth.uid(), now())
    on conflict (valid_from) do update set rate = excluded.rate, set_by = excluded.set_by, set_at = now();
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'paye_band', null,
          jsonb_build_object('validFrom', p_valid_from, 'bands', p_bands, 'casualRate', p_casual_rate));
end
$$;
revoke all on function set_paye_bands(date, jsonb, numeric) from public, anon;
grant execute on function set_paye_bands(date, jsonb, numeric) to authenticated;

-- a set of bands typed by mistake is removed; the last set stays (PAYE needs one)
create or replace function remove_paye_bands(p_valid_from date)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_before jsonb;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select jsonb_agg(jsonb_build_object('lower', lower_bound, 'rate', rate) order by lower_bound) into v_before
  from paye_band where valid_from = p_valid_from and deleted_at is null;
  if v_before is null then
    raise exception 'these bands were not found' using errcode = 'P0002';
  end if;
  if (select count(distinct valid_from) from paye_band where deleted_at is null) <= 1 then
    raise exception 'keep at least one set of bands' using errcode = '22023';
  end if;
  delete from paye_band where valid_from = p_valid_from;
  if (select count(*) from paye_casual) > 1 then
    delete from paye_casual where valid_from = p_valid_from;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, before)
  values (auth.uid(), 'delete', 'paye_band', null, jsonb_build_object('validFrom', p_valid_from, 'bands', v_before));
end
$$;
revoke all on function remove_paye_bands(date) from public, anon;
grant execute on function remove_paye_bands(date) to authenticated;

-- ---------------------------------------------------------------- the rules
-- set_deduction (20270210090000_salary_deductions): a built-in rule's agency and base can change
-- (not PAYE's); an existing rule keeps its on/off state when p_active is null; the same rates as
-- those in force on the date add no row; a rule gives at least one share
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
  v_in deduction_rate%rowtype;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_id is not null then
    select * into v_r from deduction_rule where id = v_id and deleted_at is null;
    if not found then
      raise exception 'deduction not found' using errcode = 'P0002';
    end if;
  end if;
  if v_name = '' and v_r.code is null then
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
  if coalesce(v_r.code, '') <> 'paye'
     and p_employee_rate is null and p_employee_amount is null and p_employer_rate is null and p_employer_amount is null then
    raise exception 'say what is taken from the employee or added by the clinic' using errcode = '22023';
  end if;
  if v_id is null then
    insert into deduction_rule (name, agency, base, default_on, active, note, sort_order)
    values (v_name, coalesce(p_agency, 'other'), coalesce(p_base, 'gross'), coalesce(p_default_on, false), coalesce(p_active, true),
            nullif(trim(coalesce(p_note, '')), ''), 70)
    returning id into v_id;
  else
    update deduction_rule
    set name = case when v_r.code is null then v_name else v_r.name end,
        agency = case when v_r.code = 'paye' then 'rra' else coalesce(p_agency, v_r.agency) end,
        base = case when v_r.code = 'paye' then 'gross' else coalesce(p_base, v_r.base) end,
        default_on = coalesce(p_default_on, v_r.default_on), active = coalesce(p_active, v_r.active),
        note = nullif(trim(coalesce(p_note, '')), ''), updated_at = now()
    where id = v_id;
  end if;
  if coalesce(v_r.code, '') <> 'paye' then
    if p_valid_from is null then
      raise exception 'say the date the rates apply from' using errcode = '22023';
    end if;
    select * into v_in from deduction_rate x
    where x.rule_id = v_id and x.deleted_at is null and x.valid_from <= p_valid_from
    order by x.valid_from desc limit 1;
    -- the same rates as those already in force on that date: nothing to add
    if v_in.id is null or v_in.valid_from = p_valid_from
       or v_in.employee_rate is distinct from p_employee_rate
       or v_in.employee_amount is distinct from (case when p_employee_amount is null then null else round(p_employee_amount) end)
       or v_in.employer_rate is distinct from p_employer_rate
       or v_in.employer_amount is distinct from (case when p_employer_amount is null then null else round(p_employer_amount) end) then
      delete from deduction_rate where rule_id = v_id and valid_from = p_valid_from;
      insert into deduction_rate (rule_id, valid_from, employee_rate, employee_amount, employer_rate, employer_amount, set_by)
      values (v_id, p_valid_from, p_employee_rate, case when p_employee_amount is null then null else round(p_employee_amount) end,
              p_employer_rate, case when p_employer_amount is null then null else round(p_employer_amount) end, auth.uid());
    end if;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'deduction_rule', v_id,
          jsonb_build_object('name', coalesce(nullif(v_name, ''), v_r.name), 'agency', p_agency, 'base', p_base, 'defaultOn', p_default_on,
                             'validFrom', p_valid_from,
                             'employeeRate', p_employee_rate, 'employeeAmount', p_employee_amount,
                             'employerRate', p_employer_rate, 'employerAmount', p_employer_amount, 'active', p_active));
  return v_id;
end
$$;
revoke all on function set_deduction(uuid, text, text, text, boolean, numeric, numeric, numeric, numeric, date, text, boolean) from public, anon;
grant execute on function set_deduction(uuid, text, text, text, boolean, numeric, numeric, numeric, numeric, date, text, boolean) to authenticated;

-- a rule switched off for the whole clinic (no salary counts it), or on again
create or replace function set_deduction_active(p_id uuid, p_active boolean)
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
  update deduction_rule set active = coalesce(p_active, true), updated_at = now() where id = p_id;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'settings', 'deduction_rule', p_id,
          jsonb_build_object('name', v_r.name, 'active', v_r.active), jsonb_build_object('name', v_r.name, 'active', coalesce(p_active, true)));
end
$$;
revoke all on function set_deduction_active(uuid, boolean) from public, anon;
grant execute on function set_deduction_active(uuid, boolean) to authenticated;

-- a dated rate typed by mistake; the last rate of a rule stays (switch the rule off instead)
create or replace function remove_deduction_rate(p_rule uuid, p_valid_from date)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_x deduction_rate%rowtype;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_x from deduction_rate where rule_id = p_rule and valid_from = p_valid_from and deleted_at is null;
  if not found then
    raise exception 'this rate was not found' using errcode = 'P0002';
  end if;
  if (select count(*) from deduction_rate where rule_id = p_rule and deleted_at is null) <= 1 then
    raise exception 'keep at least one rate: switch the deduction off instead' using errcode = '22023';
  end if;
  update deduction_rate set deleted_at = now(), updated_at = now() where id = v_x.id;
  insert into audit_event (actor_id, action, entity, entity_id, before)
  values (auth.uid(), 'delete', 'deduction_rate', v_x.id, to_jsonb(v_x) - 'id');
end
$$;
revoke all on function remove_deduction_rate(uuid, date) from public, anon;
grant execute on function remove_deduction_rate(uuid, date) to authenticated;

-- the day of the next month an agency's amounts are handed over by
create or replace function set_remittance_day(p_agency text, p_day integer)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_before integer;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_agency not in ('rra', 'rssb', 'other') then
    raise exception 'say the agency and the month' using errcode = '22023';
  end if;
  if p_day is null or p_day < 1 or p_day > 28 then
    raise exception 'the hand-over day is a day of the month from 1 to 28' using errcode = '22023';
  end if;
  select due_day into v_before from remittance_day where agency = p_agency;
  insert into remittance_day (agency, due_day, set_by, set_at) values (p_agency, p_day, auth.uid(), now())
  on conflict (agency) do update set due_day = excluded.due_day, set_by = excluded.set_by, set_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'settings', 'remittance_day', null,
          jsonb_build_object('agency', p_agency, 'day', v_before), jsonb_build_object('agency', p_agency, 'day', p_day));
end
$$;
revoke all on function set_remittance_day(text, integer) from public, anon;
grant execute on function set_remittance_day(text, integer) to authenticated;

-- deductions_list (20270210090000_salary_deductions): + who set each rate and when, the employees
-- a rule really applies to today, the sets of bands with the casual rate, the hand-over days
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
                                                               'employerRate', x.employer_rate, 'employerAmount', x.employer_amount,
                                                               'setBy', (select p.full_name from profiles p where p.id = x.set_by),
                                                               'setAt', x.created_at) order by x.valid_from)
                           from deduction_rate x where x.rule_id = r.id and x.deleted_at is null), '[]'::jsonb),
        'people', (select count(*)
                   from staff_salary s
                   join profiles p on p.id = s.profile_id and p.deleted_at is null and p.active
                   where s.deleted_at is null
                     and case when r.code = 'paye' then s.paye_mode <> 'none'
                              else coalesce(deduction_applies(s.profile_id, r.id, v_today), false) end)
      ) order by r.sort_order, r.name)
      from deduction_rule r where r.deleted_at is null), '[]'::jsonb),
    'payeBands', coalesce((
      select jsonb_agg(jsonb_build_object('validFrom', b.valid_from, 'lower', b.lower_bound, 'rate', b.rate) order by b.valid_from, b.lower_bound)
      from paye_band b where b.deleted_at is null), '[]'::jsonb),
    'payeSets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'validFrom', s.valid_from,
        'casualRate', (select c.rate from paye_casual c where c.valid_from <= s.valid_from order by c.valid_from desc limit 1),
        'bands', (select jsonb_agg(jsonb_build_object('lower', b.lower_bound, 'rate', b.rate) order by b.lower_bound)
                  from paye_band b where b.deleted_at is null and b.valid_from = s.valid_from)
      ) order by s.valid_from)
      from (select distinct valid_from from paye_band where deleted_at is null) s), '[]'::jsonb),
    'remitDays', coalesce((select jsonb_object_agg(d.agency, d.due_day) from remittance_day d), '{}'::jsonb),
    'salaried', (select count(*) from staff_salary s join profiles p on p.id = s.profile_id and p.deleted_at is null and p.active
                 where s.deleted_at is null),
    'today', v_today);
end
$$;
revoke all on function deductions_list() from public, anon;
grant execute on function deductions_list() to authenticated;

-- ---------------------------------------------------------------- try a salary
-- the pay slip of a gross salary on a date, with the rules as they are: for one employee (their
-- ticks and PAYE way) or for anyone (the rules on for everyone)
create or replace function payslip_preview(p_gross numeric, p_on date default null, p_paye_mode text default null, p_profile uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_gross is null or p_gross < 0 or p_gross > 999999999 then
    raise exception 'the salary must be zero or more' using errcode = '22023';
  end if;
  if p_paye_mode is not null and p_paye_mode not in ('normal', 'none', 'casual') then
    raise exception 'PAYE is paid, not paid, or at the casual rate' using errcode = '22023';
  end if;
  return payslip_of(p_profile, p_gross, coalesce(p_on, (now() at time zone 'Africa/Kigali')::date), p_paye_mode);
end
$$;
revoke all on function payslip_preview(numeric, date, text, uuid) from public, anon;
grant execute on function payslip_preview(numeric, date, text, uuid) to authenticated;

-- ---------------------------------------------------------------- the hand-over day
-- remittances_due (20270210090000_salary_deductions): due on the agency's day of the next month
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
      'month', to_char(y.month, 'YYYY-MM'), 'agency', y.agency, 'dueOn', y.due_on,
      'employeeTotal', y.employee_total, 'employerTotal', y.employer_total, 'total', y.employee_total + y.employer_total,
      'people', y.people,
      'lines', y.lines,
      'status', case when rp.id is not null then rp.status when y.due_on < v_today then 'overdue' else 'due' end,
      'id', rp.id, 'paidOn', rp.paid_on, 'paidAmount', rp.paid_amount, 'method', rp.method, 'reference', rp.reference, 'note', rp.note,
      'paidBy', (select full_name from profiles where id = rp.paid_by)
    ) order by y.month, y.agency)
    from (
      select x.*, ((x.month + interval '1 month')::date + (coalesce(rd.due_day, 15) - 1)) as due_on
      from (
        select date_trunc('month', sp.paid_on)::date as month, l ->> 'agency' as agency,
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
      left join remittance_day rd on rd.agency = x.agency
    ) y
    left join remittance_period rp on rp.deleted_at is null and rp.agency = y.agency and rp.month = y.month), '[]'::jsonb);
end
$$;
revoke all on function remittances_due(integer) from public, anon;
grant execute on function remittances_due(integer) to authenticated;

-- ---------------------------------------------------------------- the expenses list
-- void_expense (20270209090000_money_kinds): the clinic's share paid to RSSB goes with its salary,
-- a hand-over with its month on the Taxes tab
create or replace function void_expense(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_e expense%rowtype;
  v_code text;
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
  select code into v_code from money_kind where id = v_e.kind_id;
  if v_code = 'statutory' or v_e.salary_period_id is not null then
    raise exception 'the clinic''s share is undone with its salary, on the Salaries tab' using errcode = '22023';
  end if;
  if v_code = 'remittance' then
    raise exception 'a hand-over to RRA or RSSB is undone on the Taxes tab' using errcode = '22023';
  end if;
  update expense set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason), updated_at = now() where id = p_id;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'delete', 'expense', p_id, to_jsonb(v_e) - 'id', jsonb_build_object('reason', trim(p_reason)));
end
$$;
revoke all on function void_expense(uuid, text) from public, anon;
grant execute on function void_expense(uuid, text) to authenticated;
