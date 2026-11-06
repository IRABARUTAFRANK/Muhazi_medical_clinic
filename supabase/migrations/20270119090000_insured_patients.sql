-- 0139 · A patient treated under an insurer: that insurer's prices by default on every visit, and
-- the exceptions the clinic decides.
--
-- * The patient's insurer (patient.insurance_coverage_id): recorded at registration or in the
--   patient's file by reception (or anyone who may change a patient, the cashier, the manager) with
--   save_patient_insurance — the insurer and the member number; none: a private patient.
-- * Every visit of that patient starts under that insurer (a trigger on encounter, before its bill
--   is made): each line takes the insurer's price and coverage from the first one. The visit page
--   can still change the payer of one visit. Insurance switched off: every visit is cash.
-- * One line of one visit can be changed for that patient (change_charge_cover, with a reason, by
--   whoever has the feature "Change a charge's cover": the manager and the cashier at first, the
--   manager switches it for a role or an employee): not covered (the patient pays it all), as a
--   private patient (the clinic's price, the patient pays it all), another price (the insurer's
--   coverage on it), or another coverage; or back to the insurer's. A new payer for the visit
--   puts every line back to its rule.
-- * insurer_prices_for(treatment or medicine): what each insurer pays for it and why, for the
--   treatment's and the medicine's forms (their exceptions are set there with save_tariff_exception
--   and set_insurer_price).

-- ---------------------------------------------------------------- the patient's insurer
alter table patient add column if not exists insurance_coverage_id uuid references coverage (id);
comment on column patient.insurance_coverage_id is
  'The insurer the patient is treated under (0139): every new visit starts with it. Null: a private patient.';

-- the patient's insurer when it still counts (its coverage and insurer active, in its dates)
create or replace function patient_default_coverage(p_patient uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select c.id
  from patient pt
  join coverage c on c.id = pt.insurance_coverage_id and c.active and c.deleted_at is null
    and (c.valid_from is null or c.valid_from <= current_date)
    and (c.valid_to is null or c.valid_to >= current_date)
  join payer p on p.id = c.payer_id and p.deleted_at is null and p.active and p.type <> 'cash'
  where pt.id = p_patient
$$;

-- what the screens show: the insurer, the member number (null: a private patient)
create or replace function patient_insurance(p_patient uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case when has_perm('patient.read') or is_manager() then (
    select jsonb_build_object('coverageId', c.id, 'payerId', c.payer_id, 'payer', p.name, 'payerType', p.type,
                              'memberNumber', c.member_number, 'since', c.created_at)
    from coverage c join payer p on p.id = c.payer_id
    where c.id = patient_default_coverage(p_patient)) end
$$;

create or replace function save_patient_insurance(p_patient uuid, p_payer uuid, p_member_number text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_payer payer%rowtype;
  v_plan uuid;
  v_cov uuid;
  v_before jsonb;
  v_member text := nullif(regexp_replace(trim(coalesce(p_member_number, '')), '\s+', ' ', 'g'), '');
begin
  if not (has_perm('patient.write') or has_perm('billing.write') or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from patient where id = p_patient and deleted_at is null) then
    raise exception 'patient not found' using errcode = 'P0002';
  end if;
  if v_member is not null and length(v_member) > 60 then
    raise exception 'the member number is too long' using errcode = '22023';
  end if;
  select jsonb_build_object('payer', p.name, 'memberNumber', c.member_number) into v_before
  from patient pt join coverage c on c.id = pt.insurance_coverage_id join payer p on p.id = c.payer_id
  where pt.id = p_patient;
  if p_payer is null then
    update patient set insurance_coverage_id = null where id = p_patient;
  else
    select * into v_payer from payer where id = p_payer and deleted_at is null and active and type <> 'cash';
    if not found then
      raise exception 'unknown or inactive insurer' using errcode = '22023';
    end if;
    select id into v_plan from plan where payer_id = p_payer and active and deleted_at is null
    order by created_at limit 1;
    -- the patient's coverage by this insurer (a visit may have made it already)
    select id into v_cov from coverage
    where patient_id = p_patient and payer_id = p_payer and active and deleted_at is null
    order by created_at desc limit 1;
    if v_cov is null then
      insert into coverage (patient_id, payer_id, plan_id, member_number)
      values (p_patient, p_payer, v_plan, v_member)
      returning id into v_cov;
    else
      update coverage set member_number = coalesce(v_member, member_number), plan_id = coalesce(plan_id, v_plan)
      where id = v_cov;
    end if;
    update patient set insurance_coverage_id = v_cov where id = p_patient;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'update', 'patient_insurance', p_patient, v_before,
          jsonb_build_object('payer', v_payer.name, 'memberNumber', case when p_payer is null then null else v_member end));
  return (select jsonb_build_object('coverageId', c.id, 'payerId', c.payer_id, 'payer', p.name, 'payerType', p.type,
                                    'memberNumber', c.member_number, 'since', c.created_at)
          from coverage c join payer p on p.id = c.payer_id
          where c.id = patient_default_coverage(p_patient));
end
$$;

-- every new visit of an insured patient starts under the patient's insurer (before its bill is made)
create or replace function encounter_default_coverage()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.coverage_id is null and new.patient_id is not null and insurance_enabled() then
    new.coverage_id := patient_default_coverage(new.patient_id);
  end if;
  return new;
end
$$;
drop trigger if exists trg_encounter_default_coverage on encounter;
create trigger trg_encounter_default_coverage before insert on encounter
  for each row execute function encounter_default_coverage();

-- ---------------------------------------------------------------- one line, for one patient
alter table invoice_line add column if not exists cover_mode text;
alter table invoice_line drop constraint if exists invoice_line_cover_mode_check;
alter table invoice_line add constraint invoice_line_cover_mode_check
  check (cover_mode is null or cover_mode in ('not_covered', 'private', 'price', 'coverage'));
alter table invoice_line add column if not exists cover_reason text;
alter table invoice_line add column if not exists cover_by uuid references profiles (id);
alter table invoice_line add column if not exists cover_at timestamptz;
comment on column invoice_line.cover_mode is
  'Changed for this patient (0139): not_covered, private (the clinic''s price), price (another price), coverage (another %); null: the insurer''s rule.';

-- "Change a charge's cover": a feature the manager switches (the manager and the cashier at first)
create or replace function managed_permission(p text)
returns boolean
language sql immutable
as $$
  select p in ('payment.take', 'visit.start', 'vitals.write', 'charge.write', 'clinical.write',
               'orders.write', 'appointment.approve', 'stock.write', 'records.approve', 'stock.sell_walkin',
               'charge.override')
$$;
insert into role_permissions (role, permission) values ('manager', 'charge.override'), ('cashier', 'charge.override')
on conflict do nothing;

create or replace function change_charge_cover(p_line uuid, p_mode text, p_value numeric default null, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_line invoice_line%rowtype;
  v_inv invoice%rowtype;
  v_reason text := left(nullif(regexp_replace(trim(coalesce(p_reason, '')), '\s+', ' ', 'g'), ''), 300);
  v_plan uuid;
  v_rule text;
  v_group service_group;
  v_day date;
  v_src text;
  v_ins_price numeric;
  v_cash numeric;
  v_pct numeric;
  v_list numeric;
  v_unit numeric;
  v_total numeric;
  v_disc numeric;
begin
  if not (has_perm('charge.override') or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_mode is null or p_mode not in ('insurer', 'not_covered', 'private', 'price', 'coverage') then
    raise exception 'say how the line is charged' using errcode = '22023';
  end if;
  select * into v_line from invoice_line where id = p_line and deleted_at is null for update;
  if not found then
    raise exception 'charge not found' using errcode = 'P0002';
  end if;
  select * into v_inv from invoice where id = v_line.invoice_id;
  if v_inv.status <> 'draft' then
    raise exception 'no open bill for this visit' using errcode = 'P0002';
  end if;
  if v_inv.payer_id is null then
    raise exception 'this visit has no insurer' using errcode = '22023';
  end if;
  if p_mode <> 'insurer' and v_reason is null then
    raise exception 'give the reason' using errcode = '22023';
  end if;
  if p_mode = 'price' and (p_value is null or p_value < 0 or p_value > 9999999999) then
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  if p_mode = 'coverage' and (p_value is null or p_value < 0 or p_value > 100) then
    raise exception 'the coverage must be between 0 and 100' using errcode = '22023';
  end if;

  select plan_id into v_plan from coverage where id = v_inv.coverage_id;
  select not_listed_rule into v_rule from payer where id = v_inv.payer_id;
  select service_group into v_group from service where id = v_line.service_id;
  v_day := (v_line.created_at at time zone 'Africa/Kigali')::date;
  select ps.price, ps.source into v_ins_price, v_src
  from price_source_for(v_line.service_id, v_line.item_id, v_inv.payer_id, v_day) ps;
  v_disc := coalesce(v_line.discount_pct, 0);

  -- the insurer's rule for the line (as when it was added)
  v_pct := case
    when v_line.price_origin <> 'manual' and v_src = 'excluded' then 0
    when v_rule = 'not_covered' and v_line.price_origin <> 'manual' and v_src = 'cash' then 0
    else coalesce(coverage_pct_for(v_plan, coalesce(v_group, 'pharmacy'::service_group)), 0)
  end;
  -- the insurer's price (a typed price and a whole-pack line keep theirs; a discount stays)
  v_list := v_line.list_price;
  v_unit := v_line.unit_price;
  if v_line.price_origin <> 'manual' and v_line.pack_size is null and v_ins_price is not null then
    v_list := v_ins_price;
    v_unit := round(v_ins_price * (100 - v_disc) / 100);
  end if;

  if p_mode = 'not_covered' then
    v_pct := 0;
  elsif p_mode = 'private' then
    -- as a private patient: the clinic's price, the patient pays it all
    v_pct := 0;
    if v_line.price_origin <> 'manual' and v_line.pack_size is null then
      select pf.price into v_cash from price_for(v_line.service_id, v_line.item_id, null, v_day) pf;
      if v_cash is not null then
        v_list := v_cash;
        v_unit := round(v_cash * (100 - v_disc) / 100);
      end if;
    end if;
  elsif p_mode = 'price' then
    v_unit := round(p_value);
  elsif p_mode = 'coverage' then
    v_pct := p_value;
  end if;

  v_total := round(v_unit * v_line.quantity);
  update invoice_line
  set list_price = v_list, unit_price = v_unit, coverage_pct = v_pct,
      insurer_share = round(v_total * v_pct / 100),
      patient_share = v_total - round(v_total * v_pct / 100),
      cover_mode = nullif(p_mode, 'insurer'),
      cover_reason = case when p_mode = 'insurer' then null else v_reason end,
      cover_by = case when p_mode = 'insurer' then null else auth.uid() end,
      cover_at = case when p_mode = 'insurer' then null else now() end
  where id = p_line;
  perform recompute_invoice(v_inv.id);
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'update', 'invoice_line', p_line,
          jsonb_build_object('mode', coalesce(v_line.cover_mode, 'insurer'), 'unitPrice', v_line.unit_price,
                             'coverage', v_line.coverage_pct),
          jsonb_build_object('mode', p_mode, 'unitPrice', v_unit, 'coverage', v_pct, 'reason', v_reason));
  return jsonb_build_object('mode', p_mode, 'unitPrice', v_unit, 'coverage', v_pct,
                            'insurerShare', round(v_total * v_pct / 100),
                            'patientShare', v_total - round(v_total * v_pct / 100));
end
$$;

-- ---------------------------------------------------------------- the payer of a visit
-- set_visit_payer (from 20270114090000_published_price_lists): + a new payer puts every line back to
-- its rule (what was changed for this patient was decided for the other payer).
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
  -- price for follows its rule; what was changed for this patient goes back to the rule
  update invoice_line l
  set coverage_pct = g.pct,
      insurer_share = round(round(l.unit_price * l.quantity) * g.pct / 100),
      patient_share = round(l.unit_price * l.quantity) - round(round(l.unit_price * l.quantity) * g.pct / 100),
      cover_mode = null, cover_reason = null, cover_by = null, cover_at = null
  from (
    select l2.id,
           case
             when v_payer is null then 0
             when v_rule = 'not_covered' and l2.price_origin <> 'manual' and pf.source = 'cash' then 0
             when l2.price_origin <> 'manual' and pf.source = 'excluded' then 0
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

-- ---------------------------------------------------------------- the bill's lines
-- visit_charge_covers: what was changed for this patient on each line, why, by whom and when (beside
-- visit_charges, which older migrations re-create with their own columns).
create or replace view visit_charge_covers with (security_invoker = true) as
  select l.id, l.invoice_id, i.encounter_id, i.payer_id, l.cover_mode, l.cover_reason,
         cb.full_name as cover_by_name, l.cover_at
  from invoice_line l
  join invoice i on i.id = l.invoice_id
  left join profiles cb on cb.id = l.cover_by
  where l.deleted_at is null;
grant select on visit_charge_covers to authenticated;

-- ---------------------------------------------------------------- what each insurer pays for one treatment or medicine
-- Every insurer (one with no price for it too): its price and where it comes from (price_source_for),
-- the exception that counts on it as on a bill (on its own code first, else on the list line it is
-- linked to: exceptionOwn says which), its own price, its coverage and its rule for what it has no
-- price for. `code` is the key of an exception set on it (save_tariff_exception).
create or replace function insurer_prices_for(p_service_id uuid, p_item_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case when is_manager() or has_perm('catalogue.read') then coalesce((
    select jsonb_agg(jsonb_build_object(
             'payerId', p.id, 'payer', p.name, 'payerType', p.type, 'active', p.active,
             'code', c.code,
             'price', ps.price, 'source', coalesce(ps.source, 'none'), 'fallback', coalesce(ps.fallback, false),
             'cover', e.cover, 'exceptionPrice', e.price, 'note', e.note,
             'exceptionCode', e.code, 'exceptionOwn', coalesce(e.code = c.code, false),
             'ownPrice', (
               select pli.price from price_list pl
               join price_list_item pli on pli.price_list_id = pl.id and pli.deleted_at is null
               where pl.payer_id = p.id and pl.deleted_at is null
                 and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
                 and ((p_service_id is not null and pli.service_id = p_service_id)
                   or (p_item_id is not null and pli.item_id = p_item_id))
               order by pl.effective_from desc, pl.created_at desc limit 1),
             'coveragePct', coverage_pct_for(
               (select pl.id from plan pl where pl.payer_id = p.id and pl.active and pl.deleted_at is null order by pl.created_at limit 1),
               coalesce((select s.service_group from service s where s.id = p_service_id), 'pharmacy'::service_group)),
             'rule', p.not_listed_rule)
           order by p.active desc, p.name)
    from (select tariff_code_of(p_service_id, p_item_id) as code) c
    cross join payer p
    left join lateral price_source_for(p_service_id, p_item_id, p.id) ps on true
    left join lateral (
      select x.code, x.cover, x.price, x.note
      from tariff_exception x
      where x.payer_id = p.id
        and (x.code = c.code
          or x.code in (select k.code from tariff_link k
                        join payer_tariff pt on pt.book_id = k.book_id and pt.payer_id = p.id
                        where (p_service_id is not null and k.service_id = p_service_id)
                           or (p_item_id is not null and k.item_id = p_item_id)))
      order by (x.code = c.code) desc
      limit 1) e on true
    where p.deleted_at is null and p.type <> 'cash'
      and (p_service_id is not null or p_item_id is not null)), '[]'::jsonb) end
$$;

-- ---------------------------------------------------------------- grants
revoke all on function patient_default_coverage(uuid), encounter_default_coverage() from public, anon, authenticated;
revoke all on function patient_insurance(uuid), save_patient_insurance(uuid, uuid, text),
  change_charge_cover(uuid, text, numeric, text), insurer_prices_for(uuid, uuid) from public, anon;
grant execute on function patient_insurance(uuid), save_patient_insurance(uuid, uuid, text),
  change_charge_cover(uuid, text, numeric, text), insurer_prices_for(uuid, uuid) to authenticated;
