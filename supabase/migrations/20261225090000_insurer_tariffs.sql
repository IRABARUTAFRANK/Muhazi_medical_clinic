-- Muhazi Medical Clinic System — 0115 · Insurer tariffs: each insurer's own price list, uploaded or
-- typed, and what happens when the insurer has no price for a line.
--
-- Frank (owner): "A service is 50,000 for a private patient but an insurer sets it at 40,000 and
-- covers 85 % of ITS price; same for medicines (2,000 cash, 1,000 on the insurer's list). Insurers
-- that publish price lists: we upload the list (like the RHIA medicine list) and it is used to
-- charge. Insurers with only a coverage %: our cash price with their coverage. Every insurer must
-- have a way to upload its list of treatments and of medicines. Tested with one insurer: MMI."
--
-- What the clinic had: price_list (payer_id, effective_from/to) + price_list_item, and
-- price_for(service, item, payer, at) = the insurer's own price → the official list's price (an
-- insurer that follows it, medicines only) → the cash price. The bill splits each line with the
-- plan's coverage. What was missing: a way to upload or type an insurer's tariff, a word on WHERE
-- a price came from, and a rule for a line the insurer has no price for.
--
--   * payer.not_listed_rule: what to do when the insurer has no price for a treatment or medicine
--     (neither its own list nor the official list): cash_covered (the cash price with the coverage,
--     as before; the default), not_covered (the patient pays the cash price in full: coverage 0 on
--     that line), ask (Add a treatment and the pharmacy hand-over are refused with hint ask_insurer
--     until the person confirms; orders, bed nights and a medicine given in the room take the cash
--     price with the coverage, as the work is already done).
--   * price_source_for(service, item, payer, at): price_for with a fourth answer, the source:
--     'tariff' (the insurer's own list), 'reference' (the official list), 'cash'. price_for keeps
--     its columns (the views and every reader use it unchanged) and now calls it.
--   * add_charge_confirmed(…) and dispense_prescription_confirmed(…): the same arguments as
--     add_charge and dispense_prescription, for a line refused by the 'ask' rule once the person
--     has confirmed (they set the transaction setting mmc.confirm_insurer and call the function).
--     No signature changes: add_charge_internal, add_charge and dispense_prescription keep theirs.
--   * set_visit_payer re-prices the preset lines of the bill at the new payer's price (an insurer
--     chosen after a consultation was charged at the cash price: the bill now says the insurer's
--     price) and applies not_listed_rule to the split; typed prices, discounts and whole-pack lines
--     keep their price.
--   * import_price_list(payer, name, from, lines, dry_run): the upload. Lines
--     [{kind: service | item | null, code, name, price}] are matched to a service (by code, then
--     by name in any language) and a medicine (by its code — the official list's — then by its
--     name, with or without the strength). The dry run answers matched / unmatched (with the
--     lines) / new / changed / unchanged; a real run makes the list (the previous one of that
--     payer ends the day before) and its items. The manager only; audited.
--   * insurer_tariff_rows(payer): every active treatment and medicine with the cash price, the
--     insurer's price and its source, the coverage % of its group, the patient's and the insurer's
--     share, for the Prices › Insurers table and the visit screens. With the payer's lists.
--   * set_insurer_price(payer, service, item, price | null): one line of the current list (made if
--     there is none); null removes the insurer's own price (the official list or the cash price
--     then applies). start_insurer_tariff(payer, name, from, copy): a new list from a date.
--   * upsert_payer gains follows_reference_list and not_listed_rule (defaults keep them).
--   * The clinic setting insurance.enabled (save_setting, staff_settings, public_clinic_info): the
--     manager switches insurance on from Settings; the public site and the booking form show
--     insurers only when it is on AND an insurer is active.
--   * pharmacy_queue says each line's price source and the insurer's rule.
--
-- Errcodes: 42501 not allowed, 22023 bad input, P0002 not found, MS004 + hint ask_insurer.

-- ---------------------------------------------------------------- the rule for a line without a price
alter table payer add column if not exists not_listed_rule text not null default 'cash_covered';
alter table payer drop constraint if exists payer_not_listed_rule_check;
alter table payer add constraint payer_not_listed_rule_check
  check (not_listed_rule in ('cash_covered', 'not_covered', 'ask'));
comment on column payer.not_listed_rule is
  'A treatment or medicine the insurer has no price for: cash_covered (cash price with the coverage), not_covered (the patient pays the cash price in full), ask (confirm with the insurer first).';

-- ---------------------------------------------------------------- the insurance switch
-- insurance.enabled: the manager switches insurance on when the first partnership starts.
create or replace function insurance_enabled()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select value from setting where key = 'insurance.enabled') = 'true'::jsonb, false)
$$;
revoke all on function insurance_enabled() from public, anon;
grant execute on function insurance_enabled() to authenticated;

-- public_clinic_info (from 20261015180600_public_views): the public site shows insurers only when
-- insurance is on and an insurer is active.
create or replace function public_clinic_info()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'profile', coalesce((select value from setting where key = 'clinic.profile'), '{}'::jsonb),
    'hours', coalesce((select value from setting where key = 'clinic.hours'), '{}'::jsonb),
    'insurance_enabled', insurance_enabled(),
    'insurance', insurance_enabled()
      and exists (select 1 from payer where active and deleted_at is null and type <> 'cash')
  )
$$;

-- staff_settings (from 20261119090000_sessions_by_hours): the insurance switch for the staff screens.
create or replace function staff_settings()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'idle_minutes', coalesce(((select value from setting where key = 'security.lock') ->> 'idle_minutes')::int, 120),
    'trust_days', trust_days(),
    'triage_first', triage_first(),
    'session_hours', session_hours(),
    'insurance_enabled', insurance_enabled(),
    'insurance_active', insurance_enabled()
      and exists (select 1 from payer where active and deleted_at is null and type <> 'cash')
  )
$$;

-- ---------------------------------------------------------------- the price and where it comes from
-- price_source_for: price_for (from 20261208090000_reference_list_versions) with the source of the
-- price: 'tariff' (the insurer's own list in effect on p_at), 'reference' (the official list, an
-- insurer that follows it, medicines only), 'cash' (the clinic's price list). fallback stays what
-- it was: true when an insurer was asked and the cash price answered.
create or replace function price_source_for(
  p_service_id uuid,
  p_item_id uuid,
  p_payer_id uuid,
  p_at date default current_date
)
returns table (price numeric, source text, list_payer_id uuid, fallback boolean)
language plpgsql stable
as $$
begin
  if p_payer_id is not null then
    return query
      select pli.price, 'tariff'::text, pl.payer_id, false
      from price_list pl
      join price_list_item pli on pli.price_list_id = pl.id
      where pl.payer_id = p_payer_id
        and pl.deleted_at is null and pli.deleted_at is null
        and pl.effective_from <= p_at and (pl.effective_to is null or pl.effective_to >= p_at)
        and ((p_service_id is not null and pli.service_id = p_service_id)
          or (p_item_id is not null and pli.item_id = p_item_id))
      order by pl.effective_from desc, pl.created_at desc
      limit 1;
    if found then
      return;
    end if;
    if p_item_id is not null and exists (select 1 from payer py where py.id = p_payer_id and py.follows_reference_list) then
      return query
        select e.price, 'reference'::text, p_payer_id, false
        from item i
        join medicine_reference_entry e on e.code = i.code and e.list_id = reference_list_at(p_at)
        where i.id = p_item_id and e.price is not null
        limit 1;
      if found then
        return;
      end if;
    end if;
  end if;
  return query
    select pli.price, 'cash'::text, null::uuid, (p_payer_id is not null)
    from price_list pl
    join price_list_item pli on pli.price_list_id = pl.id
    where pl.payer_id is null
      and pl.deleted_at is null and pli.deleted_at is null
      and pl.effective_from <= p_at and (pl.effective_to is null or pl.effective_to >= p_at)
      and ((p_service_id is not null and pli.service_id = p_service_id)
        or (p_item_id is not null and pli.item_id = p_item_id))
    order by pl.effective_from desc, pl.created_at desc
    limit 1;
end
$$;

-- price_for keeps its columns (catalogue_services, items_catalogue, the stock screens and the bill
-- read it) and now answers through price_source_for.
create or replace function price_for(
  p_service_id uuid,
  p_item_id uuid,
  p_payer_id uuid,
  p_at date default current_date
)
returns table (price numeric, list_payer_id uuid, fallback boolean)
language sql stable
as $$
  select ps.price, ps.list_payer_id, ps.fallback
  from price_source_for(p_service_id, p_item_id, p_payer_id, p_at) ps
$$;

-- ---------------------------------------------------------------- the insurer
-- upsert_payer (from 20261015180200_catalogue): follows_reference_list (null = unchanged; a new
-- insurer: by its kind, as the 0098 trigger says) and not_listed_rule (null = unchanged; a new
-- insurer: cash_covered).
drop function if exists upsert_payer(uuid, text, payer_type, numeric, jsonb, boolean, text);
create or replace function upsert_payer(
  p_id uuid,
  p_name text,
  p_type payer_type,
  p_coverage_pct numeric,
  p_pct_by_group jsonb default '{}'::jsonb,
  p_active boolean default true,
  p_code text default null,
  p_follows_reference_list boolean default null,
  p_not_listed_rule text default null
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
  if p_not_listed_rule is not null and p_not_listed_rule not in ('cash_covered', 'not_covered', 'ask') then
    raise exception 'the rule for a line without a price is cash_covered, not_covered or ask' using errcode = '22023';
  end if;
  if v_id is null then
    if v_code is null then
      v_code := upper(regexp_replace(p_name, '[^A-Za-z0-9]', '', 'g'));
    end if;
    insert into payer (code, name, type, active, not_listed_rule)
    values (v_code, trim(p_name), p_type, p_active, coalesce(p_not_listed_rule, 'cash_covered'))
    returning id into v_id;
    -- the kind's default (the 0098 trigger) unless the form said otherwise
    if p_follows_reference_list is not null then
      update payer set follows_reference_list = p_follows_reference_list where id = v_id;
    end if;
    insert into plan (payer_id, name, coverage_pct, pct_by_group)
    values (v_id, 'Standard', p_coverage_pct, coalesce(p_pct_by_group, '{}'::jsonb));
  else
    update payer
    set name = trim(p_name), type = p_type, active = p_active, code = coalesce(v_code, code),
        follows_reference_list = coalesce(p_follows_reference_list, follows_reference_list),
        not_listed_rule = coalesce(p_not_listed_rule, not_listed_rule)
    where id = v_id;
    if not found then
      raise exception 'insurer not found' using errcode = 'P0002';
    end if;
    update plan set coverage_pct = p_coverage_pct, pct_by_group = coalesce(p_pct_by_group, '{}'::jsonb)
    where payer_id = v_id and active and deleted_at is null;
    if not found then
      insert into plan (payer_id, name, coverage_pct, pct_by_group)
      values (v_id, 'Standard', p_coverage_pct, coalesce(p_pct_by_group, '{}'::jsonb));
    end if;
  end if;
  return v_id;
end
$$;

-- insurer_plans (from 20261015180200_catalogue): the two new columns, at the end.
create or replace view insurer_plans with (security_invoker = true) as
  select p.id, p.code, p.name, p.type, p.active, pl.id as plan_id, pl.coverage_pct, pl.pct_by_group,
         p.follows_reference_list, p.not_listed_rule
  from payer p
  left join plan pl on pl.payer_id = p.id and pl.active and pl.deleted_at is null
  where p.deleted_at is null and p.type <> 'cash';

-- ---------------------------------------------------------------- who pays: the bill re-priced
-- set_visit_payer (from 20261015180300_billing): the preset lines are priced again at the new
-- payer's price (its tariff, the official list or the cash price) and split with its coverage and
-- its not_listed_rule ('ask' counts as covered here: the person chose the insurer knowingly).
-- A typed price, a discounted line and a whole-pack line keep their unit price.
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
  v_rule text;
  v_payer uuid;
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
    select type, not_listed_rule into v_type, v_rule from payer where id = p_payer_id and active and deleted_at is null;
    if v_type is null then
      raise exception 'unknown or inactive insurer' using errcode = '22023';
    end if;
  end if;

  if p_payer_id is null or v_type = 'cash' then
    update encounter set coverage_id = null where id = p_encounter_id;
    update invoice set payer_id = null, coverage_id = null where id = v_invoice.id;
    v_payer := null;
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
    v_payer := p_payer_id;
  end if;

  -- the preset lines at the new payer's price (a typed price, a discount or a whole-pack line keeps its own)
  update invoice_line l
  set list_price = n.price, unit_price = n.price
  from (
    select l2.id, pf.price
    from invoice_line l2
    cross join lateral price_source_for(l2.service_id, l2.item_id, v_payer, (l2.created_at at time zone 'Africa/Kigali')::date) pf
    where l2.invoice_id = v_invoice.id and l2.deleted_at is null
      and l2.price_origin <> 'manual' and coalesce(l2.discount_pct, 0) = 0 and l2.pack_size is null
      and pf.price is not null
  ) n
  where l.id = n.id;

  -- the split: the payer's coverage of each line's group (0 for cash); a line the insurer has no
  -- price for follows its rule
  update invoice_line l
  set coverage_pct = g.pct,
      insurer_share = round(round(l.unit_price * l.quantity) * g.pct / 100),
      patient_share = round(l.unit_price * l.quantity) - round(round(l.unit_price * l.quantity) * g.pct / 100)
  from (
    select l2.id,
           case
             when v_payer is null then 0
             when v_rule = 'not_covered' and l2.price_origin <> 'manual' and pf.source = 'cash' then 0
             else coalesce(coverage_pct_for(v_plan, coalesce(s.service_group, 'pharmacy'::service_group)), 0)
           end as pct
    from invoice_line l2
    left join service s on s.id = l2.service_id
    left join lateral price_source_for(l2.service_id, l2.item_id, v_payer, (l2.created_at at time zone 'Africa/Kigali')::date) pf on true
    where l2.invoice_id = v_invoice.id and l2.deleted_at is null
  ) g
  where l.id = g.id;
  perform recompute_invoice(v_invoice.id);
end
$$;

-- ---------------------------------------------------------------- the insurer's tariff: the upload
-- import_price_list: the manager uploads an insurer's price list (Excel or CSV read by the web
-- app into lines). Each line names a treatment or a medicine by code or by name and gives the
-- insurer's price. kind: 'service' | 'item' | null (not known: a service first, then a medicine).
create or replace function import_price_list(
  p_payer uuid,
  p_name text,
  p_effective_from date,
  p_lines jsonb,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_payer payer%rowtype;
  v_name text := nullif(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
  v_line jsonb;
  v_n integer;
  v_row integer;
  v_kind text;
  v_code text;
  v_text text;
  v_norm text;
  v_price_txt text;
  v_price numeric;
  v_service uuid;
  v_item uuid;
  v_count integer;
  v_reason text;
  v_unmatched jsonb := '[]'::jsonb;
  v_matched integer;
  v_new integer;
  v_changed integer;
  v_unchanged integer;
  v_prev price_list%rowtype;
  v_prev_rows integer;
  v_list uuid;
  v_closed integer := 0;
  v_superseded integer := 0;
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_payer from payer where id = p_payer and deleted_at is null;
  if not found or v_payer.type = 'cash' then
    raise exception 'insurer not found' using errcode = 'P0002';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'the list has no rows' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 20000 then
    raise exception 'the list has too many rows' using errcode = '22023';
  end if;
  if v_name is null or length(v_name) > 120 then
    raise exception 'give the list a name' using errcode = '22023';
  end if;
  if p_effective_from is null then
    raise exception 'give the date the list starts' using errcode = '22023';
  end if;

  create temp table if not exists _tariff_import (
    ord integer primary key,
    service_id uuid,
    item_id uuid,
    price numeric(12, 0) not null
  ) on commit drop;
  truncate _tariff_import;

  for v_line, v_n in select x.value, x.ordinality from jsonb_array_elements(p_lines) with ordinality as x loop
    v_row := v_n;
    v_service := null;
    v_item := null;
    v_reason := null;
    if jsonb_typeof(v_line) <> 'object' then
      v_unmatched := v_unmatched || jsonb_build_array(jsonb_build_object('row', v_row, 'reason', 'not_a_row'));
      continue;
    end if;
    if coalesce(v_line ->> 'row', '') ~ '^\d{1,7}$' then
      v_row := (v_line ->> 'row')::integer;
    end if;
    v_kind := nullif(lower(trim(coalesce(v_line ->> 'kind', ''))), '');
    v_code := upper(regexp_replace(coalesce(v_line ->> 'code', ''), '\s+', '', 'g'));
    v_text := nullif(regexp_replace(trim(coalesce(v_line ->> 'name', '')), '\s+', ' ', 'g'), '');
    v_norm := lower(v_text);
    v_price_txt := nullif(regexp_replace(trim(coalesce(v_line ->> 'price', '')), '[\s,]|rwf|frw', '', 'gi'), '');

    if v_price_txt is null or v_price_txt !~ '^\d{1,10}(\.\d+)?$' then
      v_reason := 'bad_price';
    elsif v_code = '' and v_text is null then
      v_reason := 'no_name';
    else
      v_price := round(v_price_txt::numeric);
      -- a treatment: by its code, then by its name in any language
      if v_kind is null or v_kind = 'service' then
        if v_code <> '' then
          select s.id into v_service from service s where s.deleted_at is null and upper(s.code) = v_code limit 1;
        end if;
        if v_service is null and v_text is not null then
          select count(*)::int, min(s.id::text)::uuid into v_count, v_service
          from service s
          where s.deleted_at is null
            and (lower(s.name_en) = v_norm or lower(s.name_fr) = v_norm or lower(s.name_kin) = v_norm);
          if v_count > 1 then
            v_service := null;
            v_reason := 'ambiguous';
          end if;
        end if;
      end if;
      -- a medicine: by its code (the official list's), then by its name with or without the strength
      if v_service is null and v_reason is null and (v_kind is null or v_kind = 'item') then
        if v_code <> '' then
          select i.id into v_item from item i where i.deleted_at is null and upper(i.code) = v_code limit 1;
        end if;
        if v_item is null and v_text is not null then
          select count(*)::int, min(i.id::text)::uuid into v_count, v_item
          from item i
          where i.deleted_at is null
            and (lower(i.name_generic) = v_norm
                 or lower(i.name_generic || ' ' || coalesce(i.strength, '')) = v_norm
                 or lower(i.name_generic || ' ' || coalesce(i.strength, '') || ' ' || coalesce(i.form, '')) = v_norm
                 or lower(coalesce(i.name_brand, '')) = v_norm);
          if v_count > 1 then
            v_item := null;
            v_reason := 'ambiguous';
          end if;
        end if;
      end if;
      if v_service is null and v_item is null and v_reason is null then
        v_reason := 'not_found';
      end if;
      if v_reason is null and exists (
        select 1 from _tariff_import t
        where (v_service is not null and t.service_id = v_service) or (v_item is not null and t.item_id = v_item)) then
        v_reason := 'duplicate';
      end if;
    end if;
    if v_reason is not null then
      v_unmatched := v_unmatched || jsonb_build_array(jsonb_build_object(
        'row', v_row, 'kind', v_kind, 'code', nullif(v_code, ''), 'name', v_text, 'price', v_line ->> 'price',
        'reason', v_reason));
      continue;
    end if;
    insert into _tariff_import (ord, service_id, item_id, price) values (v_n, v_service, v_item, v_price);
  end loop;

  select count(*)::int into v_matched from _tariff_import;
  -- compared with the insurer's own price in effect today
  select (count(*) filter (where cur.price is null))::int,
         (count(*) filter (where cur.price is not null and cur.price <> t.price))::int,
         (count(*) filter (where cur.price is not null and cur.price = t.price))::int
  into v_new, v_changed, v_unchanged
  from _tariff_import t
  left join lateral (
    select pf.price from price_source_for(t.service_id, t.item_id, p_payer, current_date) pf where pf.source = 'tariff'
  ) cur on true;
  select * into v_prev from price_list
  where payer_id = p_payer and deleted_at is null
    and effective_from <= current_date and (effective_to is null or effective_to >= current_date)
  order by effective_from desc, created_at desc limit 1;
  if v_prev.id is not null then
    select count(*)::int into v_prev_rows from price_list_item where price_list_id = v_prev.id and deleted_at is null;
  end if;

  if not p_dry_run then
    if v_matched = 0 then
      raise exception 'no row of the list matches a treatment or a medicine' using errcode = '22023';
    end if;
    -- the lists before this one end the day before; one starting the same day or later is replaced
    update price_list set effective_to = p_effective_from - 1, updated_at = now()
    where payer_id = p_payer and deleted_at is null
      and effective_from < p_effective_from and (effective_to is null or effective_to >= p_effective_from);
    get diagnostics v_closed = row_count;
    update price_list set deleted_at = now(), updated_at = now()
    where payer_id = p_payer and deleted_at is null and effective_from >= p_effective_from;
    get diagnostics v_superseded = row_count;
    insert into price_list (payer_id, name, effective_from)
    values (p_payer, v_name, p_effective_from)
    returning id into v_list;
    insert into price_list_item (price_list_id, service_id, item_id, price)
    select v_list, service_id, item_id, price from _tariff_import order by ord;
    insert into audit_event (actor_id, action, entity, entity_id, after)
    values (auth.uid(), 'create', 'price_list', v_list,
            jsonb_build_object('payer', v_payer.code, 'name', v_name, 'effectiveFrom', p_effective_from,
                               'rows', v_matched, 'unmatched', jsonb_array_length(v_unmatched),
                               'new', v_new, 'changed', v_changed, 'closed', v_closed, 'replaced', v_superseded));
  end if;
  truncate _tariff_import;

  return jsonb_build_object(
    'dryRun', p_dry_run, 'id', v_list, 'payerId', p_payer, 'name', v_name, 'effectiveFrom', p_effective_from,
    'total', jsonb_array_length(p_lines), 'matched', v_matched, 'unmatched', v_unmatched,
    'new', v_new, 'changed', v_changed, 'unchanged', v_unchanged,
    'previous', case when v_prev.id is null then null
                     else jsonb_build_object('name', v_prev.name, 'effectiveFrom', v_prev.effective_from, 'rows', v_prev_rows) end,
    'closed', v_closed, 'replaced', v_superseded);
end
$$;

-- ---------------------------------------------------------------- the tariff table
-- insurer_tariff_rows: every active treatment and medicine with the cash price, the insurer's
-- price and where it comes from (tariff | reference | cash | none), the coverage % of the line's
-- group (0 when the rule is not_covered and the insurer has no price), the patient's and the
-- insurer's share of that price; and the insurer's lists (current first). Any signed-in staff
-- member (the visit screens show the split before a line is charged).
create or replace function insurer_tariff_rows(p_payer uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_payer payer%rowtype;
  v_plan plan%rowtype;
  v_rows jsonb;
  v_lists jsonb;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_payer from payer where id = p_payer and deleted_at is null;
  if not found or v_payer.type = 'cash' then
    raise exception 'insurer not found' using errcode = 'P0002';
  end if;
  select * into v_plan from plan where payer_id = p_payer and active and deleted_at is null
  order by created_at limit 1;

  with base as (
    select 'service'::text as kind, s.id, s.code, s.name_en as name, s.name_fr, s.name_kin,
           s.service_group::text as grp, s.category_id
    from service s where s.deleted_at is null and s.active
    union all
    select 'item', i.id, i.code, i.name_generic || coalesce(' ' || i.strength, ''), null, null, 'pharmacy', null
    from item i where i.deleted_at is null and i.active
  ), priced as (
    select b.*, cp.price as cash_price, pp.price, pp.source,
           case when coalesce(pp.source, 'cash') = 'cash' and v_payer.not_listed_rule = 'not_covered' then 0
                else coalesce(coverage_pct_for(v_plan.id, b.grp::service_group), 0) end as pct
    from base b
    left join lateral (select pf.price from price_source_for(case when b.kind = 'service' then b.id end,
                                                             case when b.kind = 'item' then b.id end, null) pf) cp on true
    left join lateral (select pf.price, pf.source from price_source_for(case when b.kind = 'service' then b.id end,
                                                                        case when b.kind = 'item' then b.id end, p_payer) pf) pp on true
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'kind', x.kind, 'id', x.id, 'code', x.code, 'name', x.name, 'nameFr', x.name_fr, 'nameKin', x.name_kin,
      'group', x.grp, 'categoryId', x.category_id,
      'cashPrice', x.cash_price, 'price', x.price, 'source', coalesce(x.source, 'none'),
      'coveragePct', x.pct,
      'insurerShare', case when x.price is null then null else round(x.price * x.pct / 100) end,
      'patientShare', case when x.price is null then null else x.price - round(x.price * x.pct / 100) end,
      'ask', coalesce(x.source, 'cash') = 'cash' and v_payer.not_listed_rule = 'ask'
    ) order by x.kind desc, x.name, x.code), '[]'::jsonb)
  into v_rows
  from priced x;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', pl.id, 'name', pl.name, 'effectiveFrom', pl.effective_from, 'effectiveTo', pl.effective_to,
      'rows', (select count(*)::int from price_list_item x where x.price_list_id = pl.id and x.deleted_at is null),
      'createdAt', pl.created_at, 'createdBy', pr.full_name,
      'inEffect', pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date),
      'future', pl.effective_from > current_date
    ) order by pl.effective_from desc, pl.created_at desc), '[]'::jsonb)
  into v_lists
  from price_list pl
  left join profiles pr on pr.id = pl.created_by
  where pl.payer_id = p_payer and pl.deleted_at is null;

  return jsonb_build_object(
    'payerId', p_payer, 'code', v_payer.code, 'name', v_payer.name,
    'notListedRule', v_payer.not_listed_rule, 'followsReferenceList', v_payer.follows_reference_list,
    'coveragePct', v_plan.coverage_pct, 'pctByGroup', coalesce(v_plan.pct_by_group, '{}'::jsonb),
    'rows', v_rows, 'lists', v_lists);
end
$$;

-- ---------------------------------------------------------------- one line, by hand
-- set_insurer_price: the insurer's price for one treatment or medicine on its current list (made
-- today when there is none); null takes the insurer's own price away (the official list or the
-- cash price then applies). The manager, or whoever holds catalogue.write. Answers the list's id.
create or replace function set_insurer_price(p_payer uuid, p_service_id uuid, p_item_id uuid, p_price numeric)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_payer payer%rowtype;
  v_list uuid;
begin
  if not (is_manager() or has_perm('catalogue.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if (p_service_id is null) = (p_item_id is null) then
    raise exception 'give a service or an item, not both' using errcode = '22023';
  end if;
  if p_price is not null and (p_price < 0 or p_price > 9999999999) then
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  select * into v_payer from payer where id = p_payer and deleted_at is null;
  if not found or v_payer.type = 'cash' then
    raise exception 'insurer not found' using errcode = 'P0002';
  end if;
  if p_service_id is not null and not exists (select 1 from service where id = p_service_id and deleted_at is null) then
    raise exception 'unknown or inactive service/item' using errcode = '22023';
  end if;
  if p_item_id is not null and not exists (select 1 from item where id = p_item_id and deleted_at is null) then
    raise exception 'unknown or inactive service/item' using errcode = '22023';
  end if;
  select id into v_list from price_list
  where payer_id = p_payer and deleted_at is null
    and effective_from <= current_date and (effective_to is null or effective_to >= current_date)
  order by effective_from desc, created_at desc limit 1;
  if v_list is null then
    if p_price is null then
      return null;
    end if;
    insert into price_list (payer_id, name, effective_from)
    values (p_payer, v_payer.name || ' tariff', current_date)
    returning id into v_list;
  end if;
  if p_price is null then
    update price_list_item set deleted_at = now(), updated_at = now()
    where price_list_id = v_list and deleted_at is null
      and ((p_service_id is not null and service_id = p_service_id) or (p_item_id is not null and item_id = p_item_id));
  elsif p_service_id is not null then
    insert into price_list_item (price_list_id, service_id, price) values (v_list, p_service_id, round(p_price))
    on conflict (price_list_id, service_id) where service_id is not null
    do update set price = excluded.price, deleted_at = null, updated_at = now();
  else
    insert into price_list_item (price_list_id, item_id, price) values (v_list, p_item_id, round(p_price))
    on conflict (price_list_id, item_id) where item_id is not null
    do update set price = excluded.price, deleted_at = null, updated_at = now();
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'update', 'price_list', v_list,
          jsonb_build_object('payer', v_payer.code, 'serviceId', p_service_id, 'itemId', p_item_id,
                             'price', case when p_price is null then null else round(p_price) end));
  return v_list;
end
$$;

-- start_insurer_tariff: a new list of the insurer from a date, copying the list in effect the day
-- before (p_copy) or empty; the earlier lists end the day before, one starting on or after that
-- date is replaced. Answers the new list's id.
create or replace function start_insurer_tariff(p_payer uuid, p_name text, p_from date, p_copy boolean default true)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_payer payer%rowtype;
  v_name text := nullif(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
  v_from date := coalesce(p_from, current_date);
  v_prev uuid;
  v_list uuid;
  v_rows integer := 0;
begin
  if not (is_manager() or has_perm('catalogue.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_payer from payer where id = p_payer and deleted_at is null;
  if not found or v_payer.type = 'cash' then
    raise exception 'insurer not found' using errcode = 'P0002';
  end if;
  if v_name is null or length(v_name) > 120 then
    raise exception 'give the list a name' using errcode = '22023';
  end if;
  -- the list in effect the day before the new one starts (the one to copy)
  select id into v_prev from price_list
  where payer_id = p_payer and deleted_at is null
    and effective_from <= v_from - 1 and (effective_to is null or effective_to >= v_from - 1)
  order by effective_from desc, created_at desc limit 1;
  update price_list set effective_to = v_from - 1, updated_at = now()
  where payer_id = p_payer and deleted_at is null
    and effective_from < v_from and (effective_to is null or effective_to >= v_from);
  update price_list set deleted_at = now(), updated_at = now()
  where payer_id = p_payer and deleted_at is null and effective_from >= v_from;
  insert into price_list (payer_id, name, effective_from) values (p_payer, v_name, v_from) returning id into v_list;
  if coalesce(p_copy, true) and v_prev is not null then
    insert into price_list_item (price_list_id, service_id, item_id, price)
    select v_list, service_id, item_id, price from price_list_item where price_list_id = v_prev and deleted_at is null;
    get diagnostics v_rows = row_count;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'price_list', v_list,
          jsonb_build_object('payer', v_payer.code, 'name', v_name, 'effectiveFrom', v_from, 'rows', v_rows,
                             'copiedFrom', v_prev));
  return v_list;
end
$$;

-- ---------------------------------------------------------------- the bill: one price rule, with the source
-- add_charge_internal (from 20261217090000_packaging_and_charging): the insurer's own tariff, the
-- official list or the cash price (price_source_for); a line the insurer has no price for follows
-- the insurer's not_listed_rule: cash_covered (the cash price with the coverage, as before),
-- not_covered (coverage 0 on that line: the patient pays the cash price in full), ask (an added
-- treatment or a hand-over is refused with hint ask_insurer until the person confirms through
-- add_charge_confirmed / dispense_prescription_confirmed, which set the transaction setting
-- mmc.confirm_insurer; orders, bed nights and a medicine given in the room take the cash price
-- with the coverage, as the work is already done). Same arguments as before.
create or replace function add_charge_internal(
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
  v_source text;
  v_rule text;
  v_payer_type payer_type;
  v_pct numeric := 0;
  v_origin price_origin := 'preset';
  v_line_total numeric;
  v_insurer numeric;
  v_line_id uuid;
  v_allow_manual boolean := false;
  v_max_discount numeric := 0;
  v_discount numeric := coalesce(p_discount_pct, 0);
  v_qty numeric := p_quantity;
  v_pack integer;
  v_pk record;
  v_cash boolean;
  v_pack_list numeric;
begin
  if (p_service_id is null) = (p_item_id is null) then
    raise exception 'give a service or an item, not both' using errcode = '22023';
  end if;
  select * into v_invoice from invoice where encounter_id = p_encounter_id;
  if not found or v_invoice.status <> 'draft' then
    -- its own code: a missing price (P0002) may be handed over free, a closed bill never
    raise exception 'no open bill for this visit: the bill was already closed' using errcode = 'MS001', hint = 'no_open_bill';
  end if;

  if p_service_id is not null then
    select s.name_en, s.service_group, s.allow_manual_price, s.max_discount_pct
    into v_desc, v_group, v_allow_manual, v_max_discount
    from service s where s.id = p_service_id and (s.active or p_source_type = 'bed_stay');
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
    if not (v_allow_manual or p_source_type = 'bed_stay' or has_perm('charge.manual')) then
      raise exception 'a typed price is not allowed for this service' using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_manual_reason, '')), '') is null then
      raise exception 'a reason is required for a typed price' using errcode = '22023';
    end if;
    v_price := p_manual_price;
    v_origin := 'manual';
  else
    select pf.price, pf.fallback, pf.source into v_price, v_fallback, v_source
    from price_source_for(p_service_id, p_item_id, v_invoice.payer_id) pf;
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
  -- 0115: the insurer has no price of its own for this line (its list or the official list)
  if v_invoice.payer_id is not null and p_manual_price is null and v_source = 'cash' then
    select py.not_listed_rule, py.type into v_rule, v_payer_type from payer py where py.id = v_invoice.payer_id;
    if v_payer_type is distinct from 'cash' then
      if v_rule = 'not_covered' then
        v_pct := 0;
      elsif v_rule = 'ask' and coalesce(current_setting('mmc.confirm_insurer', true), '') <> 'on'
            and (p_source_type is null or p_source_type = 'medication_dispense') then
        raise exception 'this is not on the insurer''s list: confirm the cash price with the insurer first'
          using errcode = 'MS004', hint = 'ask_insurer';
      end if;
    end if;
  end if;

  -- 0107: a medicine is priced by how it is sold (price_quantity): by the piece, by the whole
  -- pack only (a quantity that is not whole packs is refused), or both (the whole packs at the
  -- pack price, the pieces left at the piece price). A cash-priced line (no insurer, or the
  -- insurer has no own price) only: an insurer's own price stays per piece. The whole packs are
  -- written as their own line ("… · B/8", quantity = packs, unit price = the pack price,
  -- pack_size = pieces in one); the pieces left as a second line at the piece price.
  if p_item_id is not null and p_manual_price is null then
    v_cash := v_invoice.payer_id is null or coalesce(v_fallback, false);
    select * into v_pk from price_quantity(p_item_id, p_quantity, v_unit, v_cash, v_discount);
    if not v_pk.ok then
      perform assert_whole_packs(p_item_id, p_quantity);
    end if;
    if v_pk.packs > 0 then
      select i.pack_price into v_pack_list from item i where i.id = p_item_id;
      v_line_total := v_pk.packs * v_pk.pack_price;
      v_insurer := round(v_line_total * v_pct / 100);
      insert into invoice_line (
        invoice_id, service_id, item_id, description, quantity, unit_price, list_price, discount_pct,
        discount_reason, coverage_pct, patient_share, insurer_share, office, performed_by, entered_for,
        source_type, source_id, price_origin, manual_reason, pack_size
      ) values (
        v_invoice.id, null, p_item_id, v_desc || ' · B/' || v_pk.pack_size, v_pk.packs, v_pk.pack_price,
        coalesce(v_pack_list, v_pk.pack_price), v_discount,
        nullif(trim(coalesce(p_discount_reason, '')), ''), v_pct, v_line_total - v_insurer, v_insurer,
        p_office, coalesce(p_performed_by, auth.uid()), p_entered_for, p_source_type, p_source_id,
        v_origin, null, v_pk.pack_size
      ) returning id into v_line_id;
      if v_pk.pieces > 0 then
        v_line_total := round(v_unit * v_pk.pieces);
        v_insurer := round(v_line_total * v_pct / 100);
        insert into invoice_line (
          invoice_id, service_id, item_id, description, quantity, unit_price, list_price, discount_pct,
          discount_reason, coverage_pct, patient_share, insurer_share, office, performed_by, entered_for,
          source_type, source_id, price_origin, manual_reason, pack_size
        ) values (
          v_invoice.id, null, p_item_id, v_desc, v_pk.pieces, v_unit, v_price, v_discount,
          nullif(trim(coalesce(p_discount_reason, '')), ''), v_pct, v_line_total - v_insurer, v_insurer,
          p_office, coalesce(p_performed_by, auth.uid()), p_entered_for, p_source_type, p_source_id,
          v_origin, null, null
        );
      end if;
      perform recompute_invoice(v_invoice.id);
      return v_line_id;
    end if;
  end if;
  v_line_total := round(v_unit * v_qty);
  v_insurer := round(v_line_total * v_pct / 100);

  insert into invoice_line (
    invoice_id, service_id, item_id, description, quantity, unit_price, list_price, discount_pct,
    discount_reason, coverage_pct, patient_share, insurer_share, office, performed_by, entered_for,
    source_type, source_id, price_origin, manual_reason, pack_size
  ) values (
    v_invoice.id, p_service_id, p_item_id, v_desc, v_qty, v_unit, v_price, v_discount,
    nullif(trim(coalesce(p_discount_reason, '')), ''), v_pct, v_line_total - v_insurer, v_insurer,
    p_office, coalesce(p_performed_by, auth.uid()), p_entered_for, p_source_type, p_source_id,
    v_origin, p_manual_reason, v_pack
  ) returning id into v_line_id;

  perform recompute_invoice(v_invoice.id);
  return v_line_id;
end
$$;

-- ---------------------------------------------------------------- the confirmed charge (the 'ask' rule)
-- add_charge_confirmed: add_charge once the person confirmed the cash price with the insurer (the
-- refusal MS004 / ask_insurer). The confirmation is a transaction setting add_charge_internal reads.
create or replace function add_charge_confirmed(
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
begin
  perform set_config('mmc.confirm_insurer', 'on', true);
  return add_charge(p_encounter_id, p_office, p_service_id, p_item_id, p_quantity, p_manual_price,
                    p_manual_reason, p_performed_by, p_entered_for, p_source_type, p_source_id,
                    p_discount_pct, p_discount_reason);
end
$$;

-- dispense_prescription_confirmed: the hand-over of a medicine the insurer has no price for, once
-- confirmed with the insurer (the 'ask' rule).
create or replace function dispense_prescription_confirmed(
  p_medication_request_id uuid, p_location_id uuid default null, p_quantity integer default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  perform set_config('mmc.confirm_insurer', 'on', true);
  return dispense_prescription(p_medication_request_id, p_location_id, p_quantity);
end
$$;

-- ---------------------------------------------------------------- the clinic setting
-- save_setting (from 20261207090000_pharmacy_simplified): insurance.enabled, true or false.
create or replace function save_setting(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_hours numeric;
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_key not in ('clinic.profile', 'clinic.hours', 'clinic.features', 'patient.fields', 'security.lock', 'security.otp', 'security.session', 'flow', 'stock.expiry_days', 'insurance.enabled') then
    raise exception 'unknown setting %', p_key using errcode = '22023';
  end if;
  if p_key = 'security.session' then
    if not is_manager() then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if jsonb_typeof(p_value -> 'hours') is distinct from 'number' then
      raise exception 'hours must be a whole number between 1 and 12' using errcode = '22023';
    end if;
    v_hours := (p_value ->> 'hours')::numeric;
    if v_hours <> trunc(v_hours) or v_hours < 1 or v_hours > 12 then
      raise exception 'hours must be a whole number between 1 and 12' using errcode = '22023';
    end if;
  end if;
  if p_key = 'security.lock' then
    if jsonb_typeof(p_value -> 'idle_minutes') <> 'number'
       or (p_value ->> 'idle_minutes')::numeric < 1
       or (p_value ->> 'idle_minutes')::numeric > 480 then
      raise exception 'idle_minutes must be between 1 and 480' using errcode = '22023';
    end if;
  end if;
  if p_key = 'security.otp' then
    if jsonb_typeof(p_value -> 'trust_days') <> 'number'
       or (p_value ->> 'trust_days')::numeric < 0
       or (p_value ->> 'trust_days')::numeric > 90 then
      raise exception 'trust_days must be between 0 and 90' using errcode = '22023';
    end if;
  end if;
  if p_key = 'flow' and jsonb_typeof(p_value -> 'triage_first') <> 'boolean' then
    raise exception 'flow.triage_first must be true or false' using errcode = '22023';
  end if;
  if p_key = 'patient.fields' and jsonb_typeof(p_value) <> 'array' then
    raise exception 'patient.fields must be a list' using errcode = '22023';
  end if;
  if p_key = 'insurance.enabled' and jsonb_typeof(p_value) is distinct from 'boolean' then
    raise exception 'insurance.enabled must be true or false' using errcode = '22023';
  end if;
  if p_key = 'stock.expiry_days' then
    if jsonb_typeof(p_value) is distinct from 'number' then
      raise exception 'the expiry window is a whole number of days between 1 and 365' using errcode = '22023';
    end if;
    if (p_value #>> '{}')::numeric <> trunc((p_value #>> '{}')::numeric)
       or (p_value #>> '{}')::numeric < 1 or (p_value #>> '{}')::numeric > 365 then
      raise exception 'the expiry window is a whole number of days between 1 and 365' using errcode = '22023';
    end if;
  end if;
  insert into setting (key, value, changed_by, changed_at)
  values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, changed_by = auth.uid(), changed_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'setting', null, jsonb_build_object('key', p_key));
end
$$;
-- pharmacy_queue (from 20261217090000_packaging_and_charging): each line says where its price
-- comes from (priceSource: tariff | reference | cash) and the insurer's rule for a medicine not
-- on its list (notListedRule); a 'not_covered' medicine has no insurer share.
create or replace function pharmacy_queue(p_location_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_loc uuid;
  v_stores jsonb;
  v_lines jsonb;
  v_patients jsonb;
begin
  -- the pharmacy and the manager only: the list carries allergies, prescriptions and bill amounts
  if not (may_use_desk('pharmacy') or is_manager()) then
    return jsonb_build_object('locationId', null, 'stores', '[]'::jsonb, 'lines', '[]'::jsonb, 'patients', '[]'::jsonb);
  end if;
  if p_location_id is not null then
    if not exists (select 1 from stock_location where id = p_location_id and type = 'pharmacy'
                   and active and deleted_at is null) then
      raise exception 'choose an open pharmacy store' using errcode = '22023';
    end if;
    v_loc := p_location_id;
  else
    v_loc := main_pharmacy();
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'isMain', l.id = main_pharmacy())
                            order by (l.id = main_pharmacy()) desc, l.created_at), '[]'::jsonb)
  into v_stores
  from stock_location l where l.type = 'pharmacy' and l.active and l.deleted_at is null;

  with lines as (
    select m.id, m.encounter_id, m.created_at, m.split_from, p.id as patient_id,
           p.surname || ' ' || p.given_names as patient, p.file_number, p.sex, p.birth_date, p.allergies,
           (select q.ticket_no from queue_entry q where q.encounter_id = m.encounter_id order by q.created_at limit 1) as ticket,
           m.item_id, i.name_generic || coalesce(' ' || i.strength, '') as item, i.selling_unit, i.pack_size,
           i.sale_mode, i.pack_unit, d.due,
           -- the pack price counts only for a cash-priced line (no insurer, or the insurer has no own price)
           case when (inv.payer_id is null or coalesce(pp.fallback, false)) and i.sale_mode <> 'piece'
                then i.pack_price end as pack_price,
           i.prescribing_rule, m.quantity, m.quantity_given, m.dose, m.frequency, m.duration_days, m.instructions,
           pr.id as prescriber_id, pr.full_name as prescriber, pr.specialty,
           py.name as payer, cp.price as cash_price, pp.price as payer_price, pp.fallback,
           cov.pct, pp.source as price_source, py.not_listed_rule,
           pc.total as line_total, pc.packs, pc.pieces as rest,
           doctor_holds(m.encounter_id) as holds
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open'
    join patient p on p.id = e.patient_id
    join item i on i.id = m.item_id
    left join invoice inv on inv.encounter_id = e.id
    left join payer py on py.id = inv.payer_id
    left join profiles pr on pr.id = coalesce(m.prescriber_id, m.created_by)
    left join lateral (select pf.price from price_for(null, m.item_id, null) pf) cp on true
    left join lateral (select pf.price, pf.fallback, pf.source from price_source_for(null, m.item_id, inv.payer_id) pf) pp on true
    left join lateral (select case when inv.payer_id is not null and pp.source = 'cash' and py.not_listed_rule = 'not_covered' then 0
                              else coalesce(coverage_pct_for((select c.plan_id from coverage c where c.id = inv.coverage_id),
                                                             'pharmacy'::service_group), 0) end as pct) cov on true
    -- 0107: what is given by default: what remains (a medicine sold only by the whole pack:
    -- up to whole packs), priced by how it is sold
    left join lateral (select rx_due(m.item_id, greatest(ceil(m.quantity)::integer - m.quantity_given, 0)) as due) d on true
    left join lateral (select k.total, case when k.packs > 0 then k.packs end as packs, k.pieces
                       from price_quantity(m.item_id, d.due, pp.price,
                                           inv.payer_id is null or coalesce(pp.fallback, false)) k) pc on true
    where rx_pending(m)
  ), priced as (
    select l.*, round(coalesce(case when l.payer_price is null then 0 else l.line_total end, 0) * l.pct / 100) as insurer_share
    from lines l
  )
  select
    coalesce(jsonb_agg((jsonb_build_object(
      'requestId', x.id, 'encounterId', x.encounter_id, 'patientId', x.patient_id, 'patient', x.patient,
      'file', x.file_number, 'ticket', x.ticket,
      'itemId', x.item_id, 'item', x.item, 'unit', x.selling_unit,
      'packSize', x.pack_size, 'packPrice', x.pack_price, 'packs', x.packs, 'splitFrom', x.split_from,
      'saleMode', x.sale_mode, 'packUnit', x.pack_unit, 'due', x.due, 'restPieces', x.rest,
      'quantity', x.quantity, 'given', x.quantity_given,
      'remaining', ceil(x.quantity)::integer - x.quantity_given, 'dose', x.dose, 'frequency', x.frequency, 'days', x.duration_days,
      'instructions', x.instructions, 'prescriber', x.prescriber, 'prescriberId', x.prescriber_id, 'at', x.created_at,
      -- the cash price (as before) and what the bill will say
      'price', x.cash_price, 'cashPrice', x.cash_price, 'payerPrice', x.payer_price,
      'priced', x.payer_price is not null, 'payer', x.payer, 'coveragePct', x.pct,
      'lineTotal', case when x.payer_price is null then 0 else coalesce(x.line_total, 0) end, 'insurerShare', x.insurer_share,
      'patientShare', case when x.payer_price is null then 0 else coalesce(x.line_total, 0) end - x.insurer_share,
      -- the stock of the store chosen at the desk
      'locationId', v_loc, 'pharmacyLocationId', v_loc,
      'onHandPharmacy', case when v_loc is null then 0 else usable_stock(x.item_id, v_loc) end,
      'expiredInPharmacy', (select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s
                            where s.item_id = x.item_id and s.location_id = v_loc and s.quantity > 0
                              and s.expiry < current_date),
      'onHandElsewhere', (select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s
                          join stock_location l on l.id = s.location_id
                          where s.item_id = x.item_id and l.id is distinct from v_loc and l.active and l.deleted_at is null
                            and s.quantity > 0 and (s.expiry is null or s.expiry >= current_date)),
      'doctorHolds', x.holds,
      -- the pharmacist's check
      'sex', x.sex, 'birthDate', x.birth_date,
      'ageYears', case when x.birth_date is not null then extract(year from age(current_date, x.birth_date))::integer end,
      'allergies', x.allergies,
      'prescribingRule', x.prescribing_rule, 'prescriberSpecialty', x.specialty,
      'ruleOk', rx_rule_ok(x.prescribing_rule, x.specialty)
    ) || jsonb_build_object('priceSource', x.price_source, 'notListedRule', x.not_listed_rule)) order by x.created_at), '[]'::jsonb)
  into v_lines
  from priced x;

  with lines as (
    select m.encounter_id, min(m.created_at) as first_at, count(*)::integer as n,
           sum(case when pp.price is null then 0 else pc.total end) as total,
           sum(round(case when pp.price is null then 0 else pc.total end * cov.pct / 100)) as insurer
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open'
    left join invoice inv on inv.encounter_id = e.id
    left join payer py on py.id = inv.payer_id
    left join lateral (select pf.price, pf.fallback, pf.source from price_source_for(null, m.item_id, inv.payer_id) pf) pp on true
    left join lateral (select case when inv.payer_id is not null and pp.source = 'cash' and py.not_listed_rule = 'not_covered' then 0
                              else coalesce(coverage_pct_for((select c.plan_id from coverage c where c.id = inv.coverage_id),
                                                             'pharmacy'::service_group), 0) end as pct) cov on true
    left join lateral (select k.total
                       from price_quantity(m.item_id,
                                           rx_due(m.item_id, greatest(ceil(m.quantity)::integer - m.quantity_given, 0)),
                                           pp.price, inv.payer_id is null or coalesce(pp.fallback, false)) k) pc on true
    where rx_pending(m)
    group by m.encounter_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'encounterId', l.encounter_id, 'patientId', p.id, 'patient', p.surname || ' ' || p.given_names,
      'file', p.file_number,
      'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = l.encounter_id order by q.created_at limit 1),
      'sex', p.sex, 'birthDate', p.birth_date,
      'ageYears', case when p.birth_date is not null then extract(year from age(current_date, p.birth_date))::integer end,
      'ageMonths', case when p.birth_date is not null
                        then (extract(year from age(current_date, p.birth_date)) * 12
                              + extract(month from age(current_date, p.birth_date)))::integer end,
      'allergies', p.allergies, 'payer', py.name,
      'lines', l.n, 'total', l.total, 'insurerShare', l.insurer, 'patientShare', l.total - l.insurer,
      'balance', invoice_balance(inv.id),
      'doctorHolds', doctor_holds(l.encounter_id)
    ) order by l.first_at), '[]'::jsonb)
  into v_patients
  from lines l
  join encounter e on e.id = l.encounter_id
  join patient p on p.id = e.patient_id
  left join invoice inv on inv.encounter_id = e.id
  left join payer py on py.id = inv.payer_id;

  return jsonb_build_object('locationId', v_loc, 'stores', v_stores, 'lines', v_lines, 'patients', v_patients);
end
$$;

-- ---------------------------------------------------------------- the bill's lines: the cash price beside the insurer's
-- visit_charges (from 20261015180200_catalogue): the treatment or medicine of the line and its cash
-- price on the day, so the bill and the receipt can print both prices (columns added at the end).
create or replace view visit_charges with (security_invoker = true) as
  select l.id, l.invoice_id, i.encounter_id, l.description, l.quantity, l.unit_price, l.list_price,
         l.discount_pct, l.discount_reason, l.coverage_pct, l.patient_share, l.insurer_share,
         l.office, l.price_origin, l.created_at, l.entered_by, p.full_name as entered_by_name,
         l.service_id, l.item_id,
         (select pf.price from price_for(l.service_id, l.item_id, null, (l.created_at at time zone 'Africa/Kigali')::date) pf) as cash_price
  from invoice_line l
  join invoice i on i.id = l.invoice_id
  left join profiles p on p.id = l.entered_by
  where l.deleted_at is null;

-- ---------------------------------------------------------------- grants
-- (functions replaced with the same arguments keep their grants; the new ones need theirs)
revoke all on function
  add_charge_confirmed(uuid, station, uuid, uuid, numeric, numeric, text, uuid, uuid, text, uuid, numeric, text),
  dispense_prescription_confirmed(uuid, uuid, integer),
  upsert_payer(uuid, text, payer_type, numeric, jsonb, boolean, text, boolean, text),
  import_price_list(uuid, text, date, jsonb, boolean), insurer_tariff_rows(uuid),
  set_insurer_price(uuid, uuid, uuid, numeric), start_insurer_tariff(uuid, text, date, boolean),
  price_source_for(uuid, uuid, uuid, date)
  from public, anon;
grant execute on function
  add_charge_confirmed(uuid, station, uuid, uuid, numeric, numeric, text, uuid, uuid, text, uuid, numeric, text),
  dispense_prescription_confirmed(uuid, uuid, integer),
  upsert_payer(uuid, text, payer_type, numeric, jsonb, boolean, text, boolean, text),
  import_price_list(uuid, text, date, jsonb, boolean), insurer_tariff_rows(uuid),
  set_insurer_price(uuid, uuid, uuid, numeric), start_insurer_tariff(uuid, text, date, boolean),
  price_source_for(uuid, uuid, uuid, date)
  to authenticated;
