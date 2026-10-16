-- Muhazi Medical Clinic System — 0006 billing, cashier, claims
-- One draft invoice per encounter accumulates charges office by office; the cashier collects the
-- patient share; posting makes the invoice immutable and opens the insurer claim.
-- Source: doc §4 (billing and pricing model), §5.7, §5.8, §10.2, §10.4.

create table invoice (
  like mmc_base including all,
  encounter_id uuid not null unique references encounter (id),
  number text unique,
  status invoice_status not null default 'draft',
  payer_id uuid references payer (id),
  coverage_id uuid references coverage (id),
  total numeric(12, 0) not null default 0,
  patient_share numeric(12, 0) not null default 0,
  insurer_share numeric(12, 0) not null default 0,
  tax_fields jsonb not null default '{}'::jsonb,
  posted_at timestamptz,
  posted_by uuid,
  provisional_no text
);
create index invoice_status_idx on invoice (status, posted_at desc);
create index invoice_payer_idx on invoice (payer_id, posted_at desc);

create table invoice_line (
  like mmc_base including all,
  invoice_id uuid not null references invoice (id),
  service_id uuid references service (id),
  item_id uuid references item (id),
  description text not null,
  quantity numeric(10, 2) not null default 1 check (quantity > 0),
  unit_price numeric(12, 0) not null check (unit_price >= 0),
  coverage_pct numeric(5, 2) not null default 0,
  patient_share numeric(12, 0) not null default 0,
  insurer_share numeric(12, 0) not null default 0,
  tax_type tax_type not null default 'exempt',
  office station not null,
  performed_by uuid,
  entered_by uuid default auth.uid(),
  entered_for uuid,
  source_type text,
  source_id uuid,
  price_origin price_origin not null default 'preset',
  manual_reason text,
  check ((service_id is null) <> (item_id is null))
);
create index invoice_line_invoice_idx on invoice_line (invoice_id, office);

create table payment (
  like mmc_base including all,
  invoice_id uuid not null references invoice (id),
  method payment_method not null,
  amount numeric(12, 0) not null check (amount > 0),
  reference text,
  payer_phone text,
  cashier_id uuid default auth.uid(),
  paid_at timestamptz not null default now(),
  day_close_id uuid,
  provider_status jsonb not null default '{}'::jsonb
);
create index payment_invoice_idx on payment (invoice_id);
create index payment_day_idx on payment (paid_at, method);

create table credit_note (
  like mmc_base including all,
  invoice_id uuid not null references invoice (id),
  number text unique,
  lines jsonb not null default '[]'::jsonb,
  total numeric(12, 0) not null default 0,
  reason text not null,
  approver_id uuid,
  refund_payment_id uuid references payment (id)
);

create table claim_batch (
  like mmc_base including all,
  payer_id uuid not null references payer (id),
  period_start date not null,
  period_end date not null,
  number text unique,
  status batch_status not null default 'draft',
  submitted_at timestamptz,
  submitted_by uuid,
  total_claimed numeric(12, 0) not null default 0,
  total_paid numeric(12, 0) not null default 0
);

create table claim (
  like mmc_base including all,
  invoice_id uuid not null unique references invoice (id),
  payer_id uuid not null references payer (id),
  member_number text,
  amount numeric(12, 0) not null default 0,
  status claim_status not null default 'open',
  rejection_reason text,
  batch_id uuid references claim_batch (id),
  resubmitted_in uuid references claim_batch (id),
  missing_docs jsonb not null default '[]'::jsonb
);
create index claim_payer_status_idx on claim (payer_id, status);

create table day_close (
  like mmc_base including all,
  date date not null,
  cashier_id uuid not null default auth.uid(),
  expected jsonb not null default '{}'::jsonb,
  counted jsonb not null default '{}'::jsonb,
  variance numeric(12, 0) not null default 0,
  note text,
  unique (date, cashier_id)
);
alter table payment add constraint payment_day_close_fk foreign key (day_close_id) references day_close (id);

select install_common_triggers('invoice');
select install_common_triggers('invoice_line');
select install_common_triggers('payment');
select install_common_triggers('credit_note');
select install_common_triggers('claim_batch');
select install_common_triggers('claim');
select install_common_triggers('day_close');

-- ---------------------------------------------------------------- immutability (doc §4.2, §10.4)
create or replace function guard_posted_invoice()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('posted', 'credited') then
    -- Only the status transition posted → credited and the provisional number are allowed to change.
    if new.total is distinct from old.total or new.patient_share is distinct from old.patient_share
       or new.insurer_share is distinct from old.insurer_share or new.number is distinct from old.number
       or new.payer_id is distinct from old.payer_id or new.encounter_id is distinct from old.encounter_id
       or (new.status is distinct from old.status and not (old.status = 'posted' and new.status = 'credited')) then
      raise exception 'invoice % is posted and immutable; issue a credit note', old.number using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;
create trigger trg_invoice_immutable before update on invoice
  for each row execute function guard_posted_invoice();

create or replace function guard_posted_invoice_lines()
returns trigger
language plpgsql
as $$
declare
  v_status invoice_status;
begin
  select status into v_status from invoice where id = coalesce(new.invoice_id, old.invoice_id);
  if v_status <> 'draft' then
    raise exception 'lines of a posted invoice cannot change' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;
create trigger trg_invoice_line_immutable before insert or update or delete on invoice_line
  for each row execute function guard_posted_invoice_lines();

create or replace function guard_submitted_batch()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('submitted', 'paid', 'closed') and new.status = 'draft' then
    raise exception 'a submitted claim batch cannot be reopened' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger trg_batch_immutable before update on claim_batch
  for each row execute function guard_submitted_batch();

-- ---------------------------------------------------------------- the running bill
-- Every encounter gets a draft invoice as soon as it opens (doc §4.2).
create or replace function ensure_draft_invoice()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_payer uuid;
begin
  select c.payer_id into v_payer from coverage c where c.id = new.coverage_id;
  insert into invoice (encounter_id, payer_id, coverage_id)
  values (new.id, v_payer, new.coverage_id)
  on conflict (encounter_id) do nothing;
  return new;
end
$$;
create trigger trg_encounter_invoice after insert on encounter
  for each row execute function ensure_draft_invoice();

create or replace function recompute_invoice(p_invoice_id uuid)
returns void
language sql security definer set search_path = public
as $$
  update invoice i
  set total = coalesce(s.total, 0),
      patient_share = coalesce(s.patient_share, 0),
      insurer_share = coalesce(s.insurer_share, 0)
  from (
    select invoice_id,
           sum(round(unit_price * quantity)) as total,
           sum(patient_share) as patient_share,
           sum(insurer_share) as insurer_share
    from invoice_line
    where invoice_id = p_invoice_id and deleted_at is null
    group by invoice_id
  ) s
  where i.id = p_invoice_id and i.status = 'draft'
$$;

-- Add a charge from any office: preset price from the payer's list, or a typed price if the
-- service allows it (doc §4.1). Stores office, performer, price origin on the line.
create or replace function add_charge(
  p_encounter_id uuid,
  p_office station,
  p_service_id uuid default null,
  p_item_id uuid default null,
  p_quantity numeric default 1,
  p_manual_price numeric default null,
  p_manual_reason text default null,
  p_performed_by uuid default null,
  p_entered_for uuid default null,
  p_source_type text default null,
  p_source_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice invoice%rowtype;
  v_plan uuid;
  v_group service_group;
  v_desc text;
  v_price numeric;
  v_fallback boolean;
  v_pct numeric := 0;
  v_origin price_origin := 'preset';
  v_line_total numeric;
  v_insurer numeric;
  v_line_id uuid;
  v_allow_manual boolean := false;
begin
  if not has_perm('charge.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if (p_service_id is null) = (p_item_id is null) then
    raise exception 'give a service or an item, not both' using errcode = '22023';
  end if;
  select * into v_invoice from invoice where encounter_id = p_encounter_id;
  if not found or v_invoice.status <> 'draft' then
    raise exception 'no open bill for this visit' using errcode = 'P0002';
  end if;

  if p_service_id is not null then
    select s.name_en, s.service_group, s.allow_manual_price into v_desc, v_group, v_allow_manual
    from service s where s.id = p_service_id and s.active;
  else
    select i.name_generic || coalesce(' ' || i.strength, ''), 'pharmacy'::service_group, false into v_desc, v_group, v_allow_manual
    from item i where i.id = p_item_id and i.active;
    v_origin := 'pharmacy';
  end if;
  if v_desc is null then
    raise exception 'unknown or inactive service/item' using errcode = '22023';
  end if;

  if p_manual_price is not null then
    if not (v_allow_manual or has_perm('charge.manual')) then
      raise exception 'a typed price is not allowed for this service' using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_manual_reason, '')), '') is null then
      raise exception 'a reason is required for a typed price' using errcode = '22023';
    end if;
    v_price := p_manual_price;
    v_origin := 'manual';
  else
    select pf.price, pf.fallback into v_price, v_fallback
    from price_for(p_service_id, p_item_id, v_invoice.payer_id) pf;
    if v_price is null then
      raise exception 'no price found for this service/item' using errcode = 'P0002';
    end if;
  end if;

  select c.plan_id into v_plan from coverage c where c.id = v_invoice.coverage_id;
  v_pct := coalesce(coverage_pct_for(v_plan, v_group), 0);
  v_line_total := round(v_price * p_quantity);
  v_insurer := round(v_line_total * v_pct / 100);

  insert into invoice_line (
    invoice_id, service_id, item_id, description, quantity, unit_price, coverage_pct,
    patient_share, insurer_share, office, performed_by, entered_for, source_type, source_id,
    price_origin, manual_reason
  ) values (
    v_invoice.id, p_service_id, p_item_id, v_desc, p_quantity, v_price, v_pct,
    v_line_total - v_insurer, v_insurer, p_office, coalesce(p_performed_by, auth.uid()), p_entered_for,
    p_source_type, p_source_id, v_origin, p_manual_reason
  ) returning id into v_line_id;

  perform recompute_invoice(v_invoice.id);
  return v_line_id;
end
$$;

-- Cashier: record a payment against the patient share (split payments allowed).
create or replace function record_payment(
  p_invoice_id uuid,
  p_method payment_method,
  p_amount numeric,
  p_reference text default null,
  p_payer_phone text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if not has_perm('billing.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_method in ('momo', 'airtel', 'card', 'bank') and nullif(trim(coalesce(p_reference, '')), '') is null then
    raise exception 'a transaction reference is required for %', p_method using errcode = '22023';
  end if;
  insert into payment (invoice_id, method, amount, reference, payer_phone)
  values (p_invoice_id, p_method, p_amount, p_reference, p_payer_phone)
  returning id into v_id;
  return v_id;
end
$$;

-- Post the invoice: hub-assigned number, immutable from now on, claim opened for the insurer share.
create or replace function post_invoice(p_invoice_id uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_inv invoice%rowtype;
  v_year integer := extract(year from now())::integer;
  v_number text;
  v_member text;
begin
  if not has_perm('billing.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform recompute_invoice(p_invoice_id);
  select * into v_inv from invoice where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if v_inv.status <> 'draft' then
    return v_inv.number;
  end if;
  if not exists (select 1 from invoice_line where invoice_id = p_invoice_id and deleted_at is null) then
    raise exception 'cannot post an empty invoice' using errcode = '23514';
  end if;
  v_number := 'INV-' || v_year || '-' || lpad(next_number('invoice', v_year)::text, 6, '0');
  update invoice set status = 'posted', number = v_number, posted_at = now(), posted_by = auth.uid()
  where id = p_invoice_id;
  if v_inv.insurer_share > 0 and v_inv.payer_id is not null then
    select member_number into v_member from coverage where id = v_inv.coverage_id;
    insert into claim (invoice_id, payer_id, member_number, amount)
    values (p_invoice_id, v_inv.payer_id, v_member, v_inv.insurer_share)
    on conflict (invoice_id) do nothing;
  end if;
  return v_number;
end
$$;

-- Balance due by the patient on an invoice.
create or replace function invoice_balance(p_invoice_id uuid)
returns numeric
language sql stable security definer set search_path = public
as $$
  select i.patient_share - coalesce((select sum(p.amount) from payment p where p.invoice_id = i.id and p.deleted_at is null), 0)
  from invoice i where i.id = p_invoice_id
$$;

-- Monthly claim batch per insurer: collects posted insured invoices of the period (doc §4.5).
create or replace function create_claim_batch(p_payer_id uuid, p_period_start date, p_period_end date)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_code text;
  v_total numeric;
begin
  if not has_perm('claims.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select code into v_code from payer where id = p_payer_id;
  insert into claim_batch (payer_id, period_start, period_end, number)
  values (p_payer_id, p_period_start, p_period_end,
          'CLM-' || v_code || '-' || to_char(p_period_start, 'YYYY-MM'))
  returning id into v_id;
  update claim c set status = 'batched', batch_id = v_id
  from invoice i
  where c.invoice_id = i.id and c.payer_id = p_payer_id and c.status = 'open'
    and i.status = 'posted' and i.posted_at::date between p_period_start and p_period_end;
  select coalesce(sum(amount), 0) into v_total from claim where batch_id = v_id;
  update claim_batch set total_claimed = v_total where id = v_id;
  return v_id;
end
$$;
