-- Muhazi Medical Clinic System — 0014 treatments, discounts, insurers and coverage
-- The manager maintains the treatment catalogue (what the clinic treats and the price), the
-- discount a clinician may give per treatment, the insurers the clinic works with and what
-- each one covers. A clinician adds a treatment to the visit with an optional discount and
-- sees the patient / insurer split at once.

-- ---------------------------------------------------------------- catalogue columns
alter table service
  add column max_discount_pct numeric(5, 2) not null default 0 check (max_discount_pct between 0 and 100);
comment on column service.max_discount_pct is 'Largest discount a clinician may give on this treatment without the manager.';

alter table invoice_line
  add column list_price numeric(12, 0),
  add column discount_pct numeric(5, 2) not null default 0 check (discount_pct between 0 and 100),
  add column discount_reason text;
update invoice_line set list_price = unit_price where list_price is null;

-- ---------------------------------------------------------------- add_charge with a discount
drop function if exists add_charge(uuid, station, uuid, uuid, numeric, numeric, text, uuid, uuid, text, uuid);
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
  p_source_id uuid default null,
  p_discount_pct numeric default 0,
  p_discount_reason text default null
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
  v_unit numeric;
  v_fallback boolean;
  v_pct numeric := 0;
  v_origin price_origin := 'preset';
  v_line_total numeric;
  v_insurer numeric;
  v_line_id uuid;
  v_allow_manual boolean := false;
  v_max_discount numeric := 0;
  v_discount numeric := coalesce(p_discount_pct, 0);
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
    select s.name_en, s.service_group, s.allow_manual_price, s.max_discount_pct
    into v_desc, v_group, v_allow_manual, v_max_discount
    from service s where s.id = p_service_id and s.active;
  else
    select i.name_generic || coalesce(' ' || i.strength, ''), 'pharmacy'::service_group, false, 0
    into v_desc, v_group, v_allow_manual, v_max_discount
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

  -- Discount: within the treatment's allowance, or the manager; always with a reason.
  if v_discount < 0 or v_discount > 100 then
    raise exception 'discount must be between 0 and 100 %%' using errcode = '22023';
  end if;
  if v_discount > 0 then
    if v_discount > v_max_discount and not is_manager() then
      raise exception 'the discount on this treatment may not exceed %%%', v_max_discount using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_discount_reason, '')), '') is null then
      raise exception 'a reason is required for a discount' using errcode = '22023';
    end if;
  end if;
  v_unit := round(v_price * (100 - v_discount) / 100);

  select c.plan_id into v_plan from coverage c where c.id = v_invoice.coverage_id;
  v_pct := coalesce(coverage_pct_for(v_plan, v_group), 0);
  v_line_total := round(v_unit * p_quantity);
  v_insurer := round(v_line_total * v_pct / 100);

  insert into invoice_line (
    invoice_id, service_id, item_id, description, quantity, unit_price, list_price, discount_pct,
    discount_reason, coverage_pct, patient_share, insurer_share, office, performed_by, entered_for,
    source_type, source_id, price_origin, manual_reason
  ) values (
    v_invoice.id, p_service_id, p_item_id, v_desc, p_quantity, v_unit, v_price, v_discount,
    nullif(trim(coalesce(p_discount_reason, '')), ''), v_pct, v_line_total - v_insurer, v_insurer,
    p_office, coalesce(p_performed_by, auth.uid()), p_entered_for, p_source_type, p_source_id,
    v_origin, p_manual_reason
  ) returning id into v_line_id;

  perform recompute_invoice(v_invoice.id);
  return v_line_id;
end
$$;

-- Remove a charge from a draft bill (kept as a soft delete for the audit trail).
create or replace function void_charge(p_line_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice uuid;
begin
  if not has_perm('charge.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  update invoice_line l set deleted_at = now(), manual_reason = coalesce(l.manual_reason || ' · ', '') || 'removed: ' || trim(p_reason)
  from invoice i
  where l.id = p_line_id and i.id = l.invoice_id and i.status = 'draft' and l.deleted_at is null
  returning l.invoice_id into v_invoice;
  if v_invoice is null then
    raise exception 'charge not found or bill already posted' using errcode = 'P0002';
  end if;
  perform recompute_invoice(v_invoice);
end
$$;

-- ---------------------------------------------------------------- who pays for this visit
-- Cash, or one of the insurers the clinic works with; re-splits every charge already on the bill.
create or replace function set_visit_payer(p_encounter_id uuid, p_payer_id uuid, p_member_number text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice invoice%rowtype;
  v_patient uuid;
  v_plan uuid;
  v_coverage uuid;
  v_type payer_type;
begin
  if not (has_perm('charge.write') or has_perm('billing.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_invoice from invoice where encounter_id = p_encounter_id;
  if not found or v_invoice.status <> 'draft' then
    raise exception 'no open bill for this visit' using errcode = 'P0002';
  end if;
  select patient_id into v_patient from encounter where id = p_encounter_id;

  if p_payer_id is not null then
    select type into v_type from payer where id = p_payer_id and active and deleted_at is null;
    if v_type is null then
      raise exception 'unknown or inactive insurer' using errcode = '22023';
    end if;
  end if;

  if p_payer_id is null or v_type = 'cash' then
    update encounter set coverage_id = null where id = p_encounter_id;
    update invoice set payer_id = null, coverage_id = null where id = v_invoice.id;
    update invoice_line set coverage_pct = 0, insurer_share = 0, patient_share = round(unit_price * quantity)
    where invoice_id = v_invoice.id and deleted_at is null;
  else
    select id into v_plan from plan where payer_id = p_payer_id and active and deleted_at is null
    order by created_at limit 1;
    select id into v_coverage from coverage
    where patient_id = v_patient and payer_id = p_payer_id and active and deleted_at is null
    order by created_at desc limit 1;
    if v_coverage is null then
      insert into coverage (patient_id, payer_id, plan_id, member_number)
      values (v_patient, p_payer_id, v_plan, nullif(trim(coalesce(p_member_number, '')), ''))
      returning id into v_coverage;
    elsif p_member_number is not null then
      update coverage set member_number = nullif(trim(p_member_number), ''), plan_id = coalesce(plan_id, v_plan) where id = v_coverage;
    end if;
    select plan_id into v_plan from coverage where id = v_coverage;
    update encounter set coverage_id = v_coverage where id = p_encounter_id;
    update invoice set payer_id = p_payer_id, coverage_id = v_coverage where id = v_invoice.id;
    update invoice_line l
    set coverage_pct = g.pct,
        insurer_share = round(round(l.unit_price * l.quantity) * g.pct / 100),
        patient_share = round(l.unit_price * l.quantity) - round(round(l.unit_price * l.quantity) * g.pct / 100)
    from (
      select l2.id, coalesce(coverage_pct_for(v_plan, coalesce(s.service_group, 'pharmacy'::service_group)), 0) as pct
      from invoice_line l2 left join service s on s.id = l2.service_id
      where l2.invoice_id = v_invoice.id and l2.deleted_at is null
    ) g
    where l.id = g.id;
  end if;
  perform recompute_invoice(v_invoice.id);
end
$$;

-- Station done: close this station's queue entry and send the patient on (cashier by default).
create or replace function finish_station(p_encounter_id uuid, p_station station, p_next station default 'cashier')
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = p_station and finished_at is null;
  if p_next is not null then
    select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
    if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = p_next and finished_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no) values (p_encounter_id, p_next, coalesce(v_ticket, 'A-000'));
    end if;
  end if;
end
$$;

-- ---------------------------------------------------------------- manager: treatments and prices
-- Create or update a treatment and its cash price in one call.
create or replace function upsert_service(
  p_id uuid,
  p_name_en text,
  p_group service_group,
  p_cash_price numeric,
  p_name_kin text default null,
  p_name_fr text default null,
  p_max_discount_pct numeric default 0,
  p_allow_manual boolean default false,
  p_active boolean default true,
  p_code text default null,
  p_booking_category text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_list uuid;
  v_code text := nullif(upper(trim(coalesce(p_code, ''))), '');
  v_cat text := nullif(trim(coalesce(p_booking_category, '')), '');
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name_en, ''))) < 2 then
    raise exception 'the treatment needs a name' using errcode = '22023';
  end if;
  if p_cash_price is null or p_cash_price < 0 then
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  if v_id is null then
    if v_code is null then
      v_code := 'TRT-' || lpad(next_number('service_code', 0)::text, 4, '0');
    end if;
    insert into service (code, name_en, name_kin, name_fr, service_group, allow_manual_price, max_discount_pct, active, booking_category)
    values (v_code, trim(p_name_en), nullif(trim(coalesce(p_name_kin, '')), ''), nullif(trim(coalesce(p_name_fr, '')), ''),
            p_group, p_allow_manual, coalesce(p_max_discount_pct, 0), p_active, v_cat)
    returning id into v_id;
  else
    update service
    set name_en = trim(p_name_en), name_kin = nullif(trim(coalesce(p_name_kin, '')), ''),
        name_fr = nullif(trim(coalesce(p_name_fr, '')), ''), service_group = p_group,
        allow_manual_price = p_allow_manual, max_discount_pct = coalesce(p_max_discount_pct, 0), active = p_active,
        code = coalesce(v_code, code), booking_category = v_cat
    where id = v_id;
    if not found then
      raise exception 'treatment not found' using errcode = 'P0002';
    end if;
  end if;

  select id into v_list from price_list
  where payer_id is null and deleted_at is null and effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
  order by effective_from desc limit 1;
  if v_list is null then
    insert into price_list (payer_id, name, effective_from) values (null, 'Cash prices', current_date) returning id into v_list;
  end if;
  insert into price_list_item (price_list_id, service_id, price) values (v_list, v_id, round(p_cash_price))
  on conflict (price_list_id, service_id) where service_id is not null
  do update set price = excluded.price, deleted_at = null;
  return v_id;
end
$$;

-- Insurer-specific price for a treatment (empty price = fall back to the cash price).
create or replace function set_service_price(p_service_id uuid, p_payer_id uuid, p_price numeric)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_list uuid;
  v_name text;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select id into v_list from price_list
  where payer_id = p_payer_id and deleted_at is null and effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
  order by effective_from desc limit 1;
  if v_list is null then
    select name into v_name from payer where id = p_payer_id;
    insert into price_list (payer_id, name, effective_from) values (p_payer_id, coalesce(v_name, 'Insurer') || ' tariff', current_date)
    returning id into v_list;
  end if;
  if p_price is null then
    update price_list_item set deleted_at = now() where price_list_id = v_list and service_id = p_service_id and deleted_at is null;
  else
    insert into price_list_item (price_list_id, service_id, price) values (v_list, p_service_id, round(p_price))
    on conflict (price_list_id, service_id) where service_id is not null
    do update set price = excluded.price, deleted_at = null;
  end if;
end
$$;

-- ---------------------------------------------------------------- manager: insurers and coverage
-- Create or update an insurer and its standard plan (overall % and per-group overrides such as
-- {"dental": 50}). Activating an insurer makes it selectable on a visit.
create or replace function upsert_payer(
  p_id uuid,
  p_name text,
  p_type payer_type,
  p_coverage_pct numeric,
  p_pct_by_group jsonb default '{}'::jsonb,
  p_active boolean default true,
  p_code text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_code text := nullif(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), '');
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_type = 'cash' then
    raise exception 'cash is not an insurer' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'the insurer needs a name' using errcode = '22023';
  end if;
  if p_coverage_pct is null or p_coverage_pct < 0 or p_coverage_pct > 100 then
    raise exception 'coverage must be between 0 and 100 %%' using errcode = '22023';
  end if;
  if v_id is null then
    if v_code is null then
      v_code := upper(regexp_replace(p_name, '[^A-Za-z0-9]', '', 'g'));
    end if;
    insert into payer (code, name, type, active) values (v_code, trim(p_name), p_type, p_active) returning id into v_id;
    insert into plan (payer_id, name, coverage_pct, pct_by_group) values (v_id, 'Standard', p_coverage_pct, coalesce(p_pct_by_group, '{}'::jsonb));
  else
    update payer set name = trim(p_name), type = p_type, active = p_active, code = coalesce(v_code, code) where id = v_id;
    if not found then
      raise exception 'insurer not found' using errcode = 'P0002';
    end if;
    update plan set coverage_pct = p_coverage_pct, pct_by_group = coalesce(p_pct_by_group, '{}'::jsonb)
    where payer_id = v_id and active and deleted_at is null;
    if not found then
      insert into plan (payer_id, name, coverage_pct, pct_by_group) values (v_id, 'Standard', p_coverage_pct, coalesce(p_pct_by_group, '{}'::jsonb));
    end if;
  end if;
  return v_id;
end
$$;

-- ---------------------------------------------------------------- read models
create or replace view catalogue_services with (security_invoker = true) as
  select s.id, s.code, s.name_en, s.name_kin, s.name_fr, s.service_group, s.allow_manual_price,
         s.max_discount_pct, s.active, s.default_duration_min, s.booking_category,
         (select pf.price from price_for(s.id, null, null) pf) as cash_price,
         coalesce((
           select jsonb_object_agg(pl.payer_id::text, pli.price)
           from price_list pl
           join price_list_item pli on pli.price_list_id = pl.id
           where pl.payer_id is not null and pli.service_id = s.id
             and pl.deleted_at is null and pli.deleted_at is null
             and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
         ), '{}'::jsonb) as payer_prices
  from service s
  where s.deleted_at is null;

create or replace view insurer_plans with (security_invoker = true) as
  select p.id, p.code, p.name, p.type, p.active, pl.id as plan_id, pl.coverage_pct, pl.pct_by_group
  from payer p
  left join plan pl on pl.payer_id = p.id and pl.active and pl.deleted_at is null
  where p.deleted_at is null and p.type <> 'cash';

create or replace view visit_bill with (security_invoker = true) as
  select i.id as invoice_id, i.encounter_id, i.status, i.payer_id, py.name as payer_name,
         i.total, i.patient_share, i.insurer_share, i.number
  from invoice i
  left join payer py on py.id = i.payer_id;

create or replace view visit_charges with (security_invoker = true) as
  select l.id, l.invoice_id, i.encounter_id, l.description, l.quantity, l.unit_price, l.list_price,
         l.discount_pct, l.discount_reason, l.coverage_pct, l.patient_share, l.insurer_share,
         l.office, l.price_origin, l.created_at, l.entered_by, p.full_name as entered_by_name
  from invoice_line l
  join invoice i on i.id = l.invoice_id
  left join profiles p on p.id = l.entered_by
  where l.deleted_at is null;

revoke all on catalogue_services, insurer_plans, visit_bill, visit_charges from anon;
grant select on catalogue_services, insurer_plans, visit_bill, visit_charges to authenticated;
grant execute on function
  add_charge(uuid, station, uuid, uuid, numeric, numeric, text, uuid, uuid, text, uuid, numeric, text),
  void_charge(uuid, text), set_visit_payer(uuid, uuid, text), finish_station(uuid, station, station),
  upsert_service(uuid, text, service_group, numeric, text, text, numeric, boolean, boolean, text, text),
  set_service_price(uuid, uuid, numeric),
  upsert_payer(uuid, text, payer_type, numeric, jsonb, boolean, text) to authenticated;
revoke execute on function
  add_charge(uuid, station, uuid, uuid, numeric, numeric, text, uuid, uuid, text, uuid, numeric, text),
  void_charge(uuid, text), set_visit_payer(uuid, uuid, text), finish_station(uuid, station, station),
  upsert_service(uuid, text, service_group, numeric, text, text, numeric, boolean, boolean, text, text),
  set_service_price(uuid, uuid, numeric),
  upsert_payer(uuid, text, payer_type, numeric, jsonb, boolean, text) from anon;
