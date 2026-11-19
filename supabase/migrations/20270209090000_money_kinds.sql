-- 0185 · Kinds of money. The owner (2026-11-19): "there are other kinds of revenue and expenses
-- which may be made and need to be added to the list of revenue or expenses the clinic has: make a
-- way it is added, with its description describing what it really is". And: the taxes are kept
-- apart from the other finance figures, never mixed into the result.
--   * money_kind: one row per kind of money in (patient bills, walk-in sales, rent received,
--     training fees…) or money out (salaries, stock bought, electricity, rent…). The built-in
--     kinds (code set) are filled by the system and cannot be removed; the accountant adds the
--     others, with a description, and retires a kind no longer used (its past entries keep it).
--   * expense.kind_id: every expense names its kind (the old text kind stays: 'salary', 'tax',
--     'other' — a user kind is 'other').
--   * other_income: money in that is not a patient's bill or a walk-in sale, recorded by the
--     accountant with its kind (add_income, void_income, incomes_list).
--   * money_kinds, set_money_kind, remove_money_kind; add_expense takes the kind.
--   * finance_summary: other money in, money in and out by kind; the result BEFORE TAX — the
--     taxes paid are reported apart and no longer taken off the result (0184 did).
-- Read and changed by the manager and the cashier only (finance_right).

-- ---------------------------------------------------------------- the kinds
create table if not exists money_kind (
  like mmc_base including all,
  side text not null check (side in ('in', 'out')),
  code text unique,
  name text not null check (length(name) between 1 and 80),
  description text check (description is null or length(description) <= 300),
  active boolean not null default true,
  sort_order integer not null default 100
);
comment on table money_kind is 'A kind of money in or out; code set = built in, filled by the system (0185).';
alter table money_kind enable row level security;
revoke all on money_kind from anon, authenticated;

insert into money_kind (side, code, name, description, sort_order)
select v.side, v.code, v.name, v.description, v.sort_order
from (values
  ('in', 'bills', 'Patient bills', 'Payments taken on patients’ bills at the cash desk, less the refunds given back', 10),
  ('in', 'walkin', 'Walk-in sales', 'Medicines and products sold at the pharmacy to buyers without a visit', 20),
  ('out', 'salary', 'Salaries', 'The salaries paid to the employees (net, once deductions exist)', 10),
  ('out', 'statutory', 'Statutory contributions', 'The clinic’s own share to RSSB: pension, maternity, occupational hazards', 20),
  ('out', 'remittance', 'Payroll remittances', 'What was withheld from salaries and handed over to RRA and RSSB (PAYE, pension, Mutuelle…)', 30),
  ('out', 'stock', 'Stock bought', 'The deliveries received into the stock, at cost', 40),
  ('out', 'tax', 'Taxes', 'The taxes the clinic itself pays: income tax, trading licence… (kept apart from the result)', 90),
  ('out', 'other', 'Other expenses', 'Expenses recorded before the kinds existed, or with no kind', 100)
) as v(side, code, name, description, sort_order)
where not exists (select 1 from money_kind k where k.code = v.code);

alter table expense add column if not exists kind_id uuid references money_kind (id) on delete set null;
update expense e set kind_id = k.id from money_kind k
where e.kind_id is null and k.code = e.kind;
create index if not exists expense_kind_idx on expense (kind_id);

-- ---------------------------------------------------------------- other money in
create table if not exists other_income (
  like mmc_base including all,
  kind_id uuid not null references money_kind (id),
  amount numeric(12, 0) not null check (amount > 0),
  method payment_method not null default 'cash',
  reference text check (reference is null or length(reference) <= 80),
  received_from text check (received_from is null or length(received_from) <= 120),
  note text check (note is null or length(note) <= 300),
  received_on date not null default current_date,
  recorded_by uuid references profiles (id) on delete set null,
  voided_at timestamptz,
  voided_by uuid references profiles (id) on delete set null,
  void_reason text
);
create index if not exists other_income_day_idx on other_income (received_on);
comment on table other_income is 'Money in that is not a patient bill nor a walk-in sale: rent received, a training fee, a donation… (0185).';
alter table other_income enable row level security;
revoke all on other_income from anon, authenticated;

-- ---------------------------------------------------------------- the kinds: read, set, remove
create or replace function money_kinds()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', k.id, 'side', k.side, 'code', k.code, 'name', k.name, 'description', k.description,
      'active', k.active, 'sortOrder', k.sort_order,
      'inUse', (select count(*) from expense e where e.kind_id = k.id)
             + (select count(*) from other_income i where i.kind_id = k.id)
    ) order by k.side desc, k.sort_order, k.name)
    from money_kind k where k.deleted_at is null), '[]'::jsonb);
end
$$;
revoke all on function money_kinds() from public, anon;
grant execute on function money_kinds() to authenticated;

-- p_id null: a new kind. A built-in kind keeps its side, name and code: only the description and
-- active can change (its name is translated on the screens).
create or replace function set_money_kind(p_id uuid, p_side text, p_name text, p_description text default null, p_active boolean default true)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_name text := left(trim(coalesce(p_name, '')), 80);
  v_desc text := nullif(left(trim(coalesce(p_description, '')), 300), '');
  v_k money_kind%rowtype;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_id is null then
    if p_side not in ('in', 'out') then
      raise exception 'a kind is money in or money out' using errcode = '22023';
    end if;
    if v_name = '' then
      raise exception 'say the name of the kind' using errcode = '22023';
    end if;
    if exists (select 1 from money_kind k where k.deleted_at is null and k.side = p_side and lower(k.name) = lower(v_name)) then
      raise exception 'a kind with this name exists' using errcode = '23505';
    end if;
    insert into money_kind (side, name, description, active, sort_order)
    values (p_side, v_name, v_desc, coalesce(p_active, true), 50)
    returning id into v_id;
    insert into audit_event (actor_id, action, entity, entity_id, after)
    values (auth.uid(), 'create', 'money_kind', v_id, jsonb_build_object('side', p_side, 'name', v_name, 'description', v_desc));
    return v_id;
  end if;
  select * into v_k from money_kind where id = v_id and deleted_at is null;
  if not found then
    raise exception 'kind not found' using errcode = 'P0002';
  end if;
  if v_k.code is null then
    if v_name = '' then
      raise exception 'say the name of the kind' using errcode = '22023';
    end if;
    if exists (select 1 from money_kind k where k.deleted_at is null and k.id <> v_id and k.side = v_k.side and lower(k.name) = lower(v_name)) then
      raise exception 'a kind with this name exists' using errcode = '23505';
    end if;
    update money_kind set name = v_name, description = v_desc, active = coalesce(p_active, true), updated_at = now() where id = v_id;
  else
    update money_kind set description = v_desc, active = coalesce(p_active, true), updated_at = now() where id = v_id;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'settings', 'money_kind', v_id, to_jsonb(v_k) - 'id',
          jsonb_build_object('name', coalesce(nullif(v_name, ''), v_k.name), 'description', v_desc, 'active', coalesce(p_active, true)));
  return v_id;
end
$$;
revoke all on function set_money_kind(uuid, text, text, text, boolean) from public, anon;
grant execute on function set_money_kind(uuid, text, text, text, boolean) to authenticated;

create or replace function remove_money_kind(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_k money_kind%rowtype;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_k from money_kind where id = p_id and deleted_at is null;
  if not found then
    raise exception 'kind not found' using errcode = 'P0002';
  end if;
  if v_k.code is not null then
    raise exception 'this kind is built in' using errcode = '22023';
  end if;
  if exists (select 1 from expense e where e.kind_id = p_id) or exists (select 1 from other_income i where i.kind_id = p_id) then
    raise exception 'this kind is in use: retire it instead' using errcode = '22023';
  end if;
  update money_kind set deleted_at = now(), updated_at = now() where id = p_id;
  insert into audit_event (actor_id, action, entity, entity_id, before)
  values (auth.uid(), 'delete', 'money_kind', p_id, to_jsonb(v_k) - 'id');
end
$$;
revoke all on function remove_money_kind(uuid) from public, anon;
grant execute on function remove_money_kind(uuid) to authenticated;

-- ---------------------------------------------------------------- other money in
create or replace function add_income(
  p_kind uuid, p_amount numeric, p_method payment_method default 'cash', p_reference text default null,
  p_received_on date default null, p_from text default null, p_note text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_k money_kind%rowtype;
  v_id uuid;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_k from money_kind where id = p_kind and deleted_at is null and side = 'in';
  if not found then
    raise exception 'kind not found' using errcode = 'P0002';
  end if;
  if v_k.code is not null then
    raise exception 'patients’ money is taken at the cash desk' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'the amount received must be more than zero' using errcode = '22023';
  end if;
  if coalesce(p_received_on, (now() at time zone 'Africa/Kigali')::date) > (now() at time zone 'Africa/Kigali')::date then
    raise exception 'the date cannot be in the future' using errcode = '22023';
  end if;
  insert into other_income (kind_id, amount, method, reference, received_from, note, received_on, recorded_by)
  values (p_kind, round(p_amount), coalesce(p_method, 'cash'), nullif(trim(coalesce(p_reference, '')), ''),
          nullif(left(trim(coalesce(p_from, '')), 120), ''), nullif(trim(coalesce(p_note, '')), ''),
          coalesce(p_received_on, (now() at time zone 'Africa/Kigali')::date), auth.uid())
  returning id into v_id;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'other_income', v_id,
          jsonb_build_object('kind', v_k.name, 'amount', round(p_amount), 'method', coalesce(p_method, 'cash'), 'from', p_from));
  return v_id;
end
$$;
revoke all on function add_income(uuid, numeric, payment_method, text, date, text, text) from public, anon;
grant execute on function add_income(uuid, numeric, payment_method, text, date, text, text) to authenticated;

create or replace function void_income(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_i other_income%rowtype;
begin
  if not finance_right() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'give the reason' using errcode = '22023';
  end if;
  select * into v_i from other_income where id = p_id and voided_at is null;
  if not found then
    raise exception 'money in not found' using errcode = 'P0002';
  end if;
  update other_income set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason), updated_at = now() where id = p_id;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'delete', 'other_income', p_id, to_jsonb(v_i) - 'id', jsonb_build_object('reason', trim(p_reason)));
end
$$;
revoke all on function void_income(uuid, text) from public, anon;
grant execute on function void_income(uuid, text) to authenticated;

create or replace function incomes_list(p_from date, p_to date)
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
    'id', i.id, 'kindId', i.kind_id, 'kind', k.name, 'amount', i.amount, 'method', i.method, 'reference', i.reference,
    'from', i.received_from, 'note', i.note, 'receivedOn', i.received_on,
    'recordedBy', (select pr.full_name from profiles pr where pr.id = i.recorded_by),
    'voided', i.voided_at is not null, 'voidReason', i.void_reason
  ) order by i.received_on desc, i.created_at desc), '[]'::jsonb)
  into v_out
  from other_income i join money_kind k on k.id = i.kind_id
  where i.received_on between p_from and p_to;
  return v_out;
end
$$;
revoke all on function incomes_list(date, date) from public, anon;
grant execute on function incomes_list(date, date) to authenticated;

-- ---------------------------------------------------------------- expenses with a kind
-- add_expense (20270208090000_taxes): + p_kind_id, the kind chosen from the list; a built-in kind
-- the system fills (salary, statutory, remittance, stock) is refused here; the text kind follows
drop function if exists add_expense(text, numeric, payment_method, text, date, text, text);
create or replace function add_expense(
  p_label text, p_amount numeric, p_method payment_method default 'cash', p_reference text default null,
  p_paid_on date default null, p_note text default null, p_kind text default 'other', p_kind_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_k money_kind%rowtype;
  v_kind text;
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
  if p_amount is null or p_amount <= 0 then
    raise exception 'the amount paid must be more than zero' using errcode = '22023';
  end if;
  insert into expense (kind, kind_id, label, amount, method, reference, note, paid_on, paid_by)
  values (v_kind, v_k.id, left(trim(p_label), 160), round(p_amount), coalesce(p_method, 'cash'), nullif(trim(coalesce(p_reference, '')), ''),
          nullif(trim(coalesce(p_note, '')), ''), coalesce(p_paid_on, (now() at time zone 'Africa/Kigali')::date), auth.uid())
  returning id into v_id;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'expense', v_id, jsonb_build_object('kind', v_k.name, 'label', left(trim(p_label), 160), 'amount', round(p_amount), 'method', coalesce(p_method, 'cash')));
  return v_id;
end
$$;
revoke all on function add_expense(text, numeric, payment_method, text, date, text, text, uuid) from public, anon;
grant execute on function add_expense(text, numeric, payment_method, text, date, text, text, uuid) to authenticated;

-- the salary and tax expenses name their kind too (pay_salary / pay_tax insert without kind_id)
create or replace function expense_kind_default()
returns trigger
language plpgsql
as $$
begin
  if new.kind_id is null then
    select id into new.kind_id from money_kind where code = new.kind;
  end if;
  return new;
end
$$;
drop trigger if exists expense_kind_default on expense;
create trigger expense_kind_default before insert on expense
for each row execute function expense_kind_default();

-- expenses_list (20270208090000_taxes): + the kind
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
    'voided', e.voided_at is not null, 'voidReason', e.void_reason, 'periodId', coalesce(e.salary_period_id, e.tax_period_id)
  ) order by e.paid_on desc, e.created_at desc), '[]'::jsonb)
  into v_out
  from expense e left join money_kind k on k.id = e.kind_id
  where e.paid_on between p_from and p_to;
  return v_out;
end
$$;

-- ---------------------------------------------------------------- the money, by kind, before tax
-- finance_summary (20270208090000_taxes): other money in; money in and out by kind; the result
-- before tax (the taxes are reported apart: 'taxes', 'taxesDue', never in 'net')
create or replace function finance_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_revenue numeric;
  v_refunds numeric;
  v_walkin numeric;
  v_income numeric;
  v_salaries numeric;
  v_statutory numeric;
  v_remittance numeric;
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
  select coalesce(sum(p.amount), 0) into v_walkin from payment p
  where p.deleted_at is null and p.voided_at is null and (p.paid_at at time zone 'Africa/Kigali')::date between p_from and p_to
    and p.counter_sale_id is not null;
  select coalesce(sum(amount), 0) into v_refunds from refund
  where deleted_at is null and (refunded_at at time zone 'Africa/Kigali')::date between p_from and p_to;
  select coalesce(sum(amount), 0) into v_income from other_income
  where voided_at is null and received_on between p_from and p_to;
  select coalesce(sum(e.amount) filter (where e.kind = 'salary'), 0),
         coalesce(sum(e.amount) filter (where k.code = 'statutory'), 0),
         coalesce(sum(e.amount) filter (where k.code = 'remittance'), 0),
         coalesce(sum(e.amount) filter (where e.kind = 'tax'), 0),
         coalesce(sum(e.amount) filter (where e.kind = 'other' and coalesce(k.code, '') not in ('statutory', 'remittance')), 0)
  into v_salaries, v_statutory, v_remittance, v_taxes, v_other
  from expense e left join money_kind k on k.id = e.kind_id
  where e.voided_at is null and e.paid_on between p_from and p_to;
  select coalesce(sum(m.quantity * coalesce(m.unit_cost, b.unit_cost, 0)), 0) into v_stock
  from stock_movement m left join batch b on b.id = m.batch_id
  where m.deleted_at is null and m.type = 'receipt' and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to;
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'revenue', v_revenue, 'refunds', v_refunds, 'netRevenue', v_revenue - v_refunds,
    'walkIn', v_walkin, 'otherIncome', v_income,
    'moneyIn', v_revenue - v_refunds + v_income,
    'salaries', v_salaries, 'statutory', v_statutory, 'remittances', v_remittance,
    'taxes', v_taxes, 'otherExpenses', v_other, 'stockBought', v_stock,
    'expenses', v_salaries + v_statutory + v_remittance + v_other + v_stock,
    'net', v_revenue - v_refunds + v_income - v_salaries - v_statutory - v_remittance - v_other - v_stock,
    'byMethod', coalesce((
      select jsonb_agg(jsonb_build_object('method', x.method, 'count', x.n, 'amount', x.amount) order by x.amount desc)
      from (select p.method, count(*)::int as n, sum(p.amount) as amount from payment p
            where p.deleted_at is null and p.voided_at is null and (p.paid_at at time zone 'Africa/Kigali')::date between p_from and p_to
            group by p.method) x), '[]'::jsonb),
    'byKindIn', coalesce((
      select jsonb_agg(jsonb_build_object('id', k.id, 'code', k.code, 'name', k.name, 'amount', x.amount) order by k.sort_order, k.name)
      from (
        select (select id from money_kind where code = 'bills') as kind_id, v_revenue - v_refunds - v_walkin as amount
        union all
        select (select id from money_kind where code = 'walkin'), v_walkin
        union all
        select i.kind_id, sum(i.amount) from other_income i
        where i.voided_at is null and i.received_on between p_from and p_to group by i.kind_id
      ) x join money_kind k on k.id = x.kind_id
      where x.amount <> 0), '[]'::jsonb),
    'byKindOut', coalesce((
      select jsonb_agg(jsonb_build_object('id', k.id, 'code', k.code, 'name', k.name, 'amount', x.amount) order by k.sort_order, k.name)
      from (
        select e.kind_id, sum(e.amount) as amount from expense e
        where e.voided_at is null and e.kind <> 'tax' and e.paid_on between p_from and p_to group by e.kind_id
        union all
        select (select id from money_kind where code = 'stock'), v_stock
      ) x join money_kind k on k.id = x.kind_id
      where x.amount <> 0), '[]'::jsonb),
    'byMonth', coalesce((
      select jsonb_agg(jsonb_build_object(
        'month', to_char(m.d, 'YYYY-MM'),
        'revenue', (select coalesce(sum(amount), 0) from payment p where p.deleted_at is null and p.voided_at is null
                    and date_trunc('month', p.paid_at at time zone 'Africa/Kigali') = m.d),
        'refunds', (select coalesce(sum(amount), 0) from refund r where r.deleted_at is null
                    and date_trunc('month', r.refunded_at at time zone 'Africa/Kigali') = m.d),
        'otherIncome', (select coalesce(sum(amount), 0) from other_income i where i.voided_at is null and date_trunc('month', i.received_on) = m.d),
        'salaries', (select coalesce(sum(e.amount), 0) from expense e left join money_kind k on k.id = e.kind_id
                     where e.voided_at is null and (e.kind = 'salary' or k.code in ('statutory', 'remittance')) and date_trunc('month', e.paid_on) = m.d),
        'taxes', (select coalesce(sum(amount), 0) from expense e where e.voided_at is null and e.kind = 'tax' and date_trunc('month', e.paid_on) = m.d),
        'other', (select coalesce(sum(e.amount), 0) from expense e left join money_kind k on k.id = e.kind_id
                  where e.voided_at is null and e.kind = 'other' and coalesce(k.code, '') not in ('statutory', 'remittance') and date_trunc('month', e.paid_on) = m.d),
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
