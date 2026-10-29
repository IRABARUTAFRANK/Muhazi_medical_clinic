-- 0102 · Packs and pieces, and the rest of a prescription the pharmacy cannot give.
--
-- Frank (owner): a medicine comes as a pack (a box of 20 tablets, a bottle of 100 ml, a strip of
-- 10) and the patient buys pieces or whole packs. One rule from the shelf to the bill:
--
--   * The item has a unit (the piece: tablet, capsule, sachet, ml, vial, bottle…) and pack_size
--     (pieces in one pack). A medicine sold whole (a bottle) is pack_size 1 with unit "bottle".
--   * Stock is held and moved in PIECES everywhere: add_stock, dispense_prescription,
--     sell_medicine, the counter sales, the transfer notes, the counts and the write-offs all take
--     piece quantities (as before). The screens show the packs beside them ("503 tablets · 25
--     packs + 3").
--   * The selling price is per piece. item.pack_price (new, optional) is the price of ONE WHOLE
--     PACK: when a cash-priced line comes to whole packs, the line is charged packs × pack_price
--     instead of pieces × price (pack_charge). An insurer's own list price stays per piece.
--   * On the bill such a line is written "Amoxicillin 500 mg · B/20" with quantity = packs and
--     unit_price = the pack price (so every reader's quantity × unit price still holds), and
--     invoice_line.pack_size keeps the pieces per pack (units = quantity × pack_size). A counter
--     sale line keeps its quantity in pieces (the stock movements read it) and records packs and
--     pack_price beside line_total.
--   * set_pack_price(item, price | null): the manager (or item_price.write) sets or clears it;
--     refused while the item has no pack size above 1 (hint pack_size).
--   * add_stock: a line may say pack_size (the "count in boxes" helper): an item without one
--     takes it; a medicine new from the official list takes the list's "B/20" (pack_size_in).
--   * The readers say the pack: stock_overview (packPrice), stock_alerts.low (packSize),
--     pharmacy_queue (packSize, packPrice when it applies, packs, splitFrom), counter_sales
--     (packs, packPrice, packSize, byPack). stock_sales counts units = quantity × pack_size.
--
-- The rest of a prescription the pharmacy cannot give (0097 allowed a part hand-over):
--
--   * rx_not_given on a partly given line tells the prescriber the quantity prescribed, given and
--     remaining, and that the rest may go to an outside pharmacy (outside = true).
--   * rx_set_supply(line, 'outside') on a PARTLY GIVEN line no longer refuses: it sends only the
--     REMAINDER outside. The given part stays recorded and charged on the original line (closed
--     as "not given" for the rest if it was still waiting) and a new outside line holds the rest
--     (quantity = prescribed − given, medication_request.split_from = the original). Called again
--     on the original, the decision applies to that remainder line ('pharmacy' brings the rest
--     back to the pharmacy's list). rx_bought_outside counts such a remainder as "after the
--     pharmacy had none".

-- ---------------------------------------------------------------- columns
alter table item add column if not exists pack_price numeric(12, 0)
  check (pack_price is null or pack_price >= 0);
alter table counter_sale_line add column if not exists packs integer;
alter table counter_sale_line add column if not exists pack_price numeric(12, 0);
-- a bill line charged by the pack: quantity = packs, unit_price = the pack price, pack_size = pieces in one
alter table invoice_line add column if not exists pack_size integer;
alter table medication_request add column if not exists split_from uuid references medication_request (id);
create index if not exists medication_request_split_from_idx on medication_request (split_from)
  where split_from is not null;

-- ---------------------------------------------------------------- helpers
-- "ZYMAFLUOR Tablet 1MG B/100" → 100: the pieces in one pack as the official list writes them.
create or replace function pack_size_in(p_text text)
returns integer
language sql immutable
as $$
  select nullif((regexp_match(coalesce(p_text, ''), 'B\s*/\s*(\d+)', 'i'))[1], '')::integer
$$;

-- What a line of p_units pieces of an item costs at p_unit_price a piece: whole packs at the
-- item's pack price when one is set and the line is cash-priced (p_cash), else pieces × price.
create or replace function pack_charge(p_item_id uuid, p_units numeric, p_unit_price numeric, p_cash boolean)
returns table (by_pack boolean, packs integer, pack_size integer, pack_price numeric, total numeric)
language plpgsql stable
as $$
declare
  v_size integer;
  v_price numeric;
begin
  select i.pack_size, i.pack_price into v_size, v_price from item i where i.id = p_item_id;
  by_pack := coalesce(p_cash, false) and v_price is not null and coalesce(v_size, 1) > 1
             and p_units is not null and p_units > 0 and p_units = round(p_units)
             and (p_units::integer % v_size) = 0;
  pack_size := v_size;
  if by_pack then
    packs := p_units::integer / v_size;
    pack_price := v_price;
    total := packs * v_price;
  else
    packs := null;
    pack_price := null;
    total := round(round(coalesce(p_unit_price, 0)) * coalesce(p_units, 0));
  end if;
  return next;
end
$$;

-- ---------------------------------------------------------------- the pack price (Prices › Medicines)
create or replace function set_pack_price(p_item_id uuid, p_price numeric)
returns numeric
language plpgsql security definer set search_path = public
as $$
declare
  v_pack integer;
begin
  if not (has_perm('item_price.write') or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_price is not null and p_price < 0 then
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  select pack_size into v_pack from item where id = p_item_id and deleted_at is null;
  if not found then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  if p_price is not null and coalesce(v_pack, 1) < 2 then
    raise exception 'say how many units are in one box' using errcode = '22023', hint = 'pack_size';
  end if;
  update item set pack_price = round(p_price), updated_at = now() where id = p_item_id;
  return round(p_price);
end
$$;

-- guard_item (from 20261208090000_reference_list_versions): the pack price too.
create or replace function guard_item()
returns trigger
language plpgsql
as $$
begin
  -- the checked (security definer) functions run as their owner, not as the API roles
  if current_user::text not in ('authenticated', 'anon') then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'a medicine is deleted with the Delete button (the manager)' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (
       new.deleted_at is distinct from old.deleted_at or new.active is distinct from old.active
       or new.reorder_level is distinct from old.reorder_level or new.max_level is distinct from old.max_level
       or new.code is distinct from old.code or new.pack_size is distinct from old.pack_size
       or new.pack_price is distinct from old.pack_price
       or new.reference_removed_at is distinct from old.reference_removed_at) then
    raise exception 'deleting, switching off, the code, the box size and the stock levels change only through their screens'
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------- the bill charges whole packs at the pack price
-- add_charge_internal (from 20261123090000_dispensing_fixes): an item line that comes to whole
-- packs, cash-priced, without a typed price or a discount, is charged packs × pack_price.
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

  -- 0102: whole packs of a cash-priced medicine at the item's pack price: the line is written in
  -- packs ("… · B/20", quantity = packs, unit price = the pack price, pack_size = pieces in one)
  if p_item_id is not null and p_manual_price is null and v_discount = 0 then
    select * into v_pk
    from pack_charge(p_item_id, p_quantity, v_unit, v_invoice.payer_id is null or coalesce(v_fallback, false));
    if v_pk.by_pack then
      v_qty := v_pk.packs;
      v_unit := v_pk.pack_price;
      v_price := v_pk.pack_price;
      v_pack := v_pk.pack_size;
      v_desc := v_desc || ' · B/' || v_pk.pack_size;
    end if;
  end if;

  select c.plan_id into v_plan from coverage c where c.id = v_invoice.coverage_id;
  v_pct := coalesce(coverage_pct_for(v_plan, v_group), 0);
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

-- ---------------------------------------------------------------- counter sales in packs or pieces
-- create_counter_sale (from 20261124090000_stores_and_stock): quantities in pieces; a line that
-- comes to whole packs is charged at the pack price (packs and pack_price kept on the line).
create or replace function create_counter_sale(
  p_lines jsonb, p_buyer_name text default null, p_buyer_phone text default null,
  p_location_id uuid default null, p_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_loc uuid := coalesce(p_location_id, main_pharmacy());
  v_id uuid;
  v_number text;
  v_line record;
  v_price numeric;
  v_total numeric := 0;
  v_usable integer;
  v_pk record;
begin
  if not stock_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_loc is null or not exists (select 1 from stock_location where id = v_loc and type = 'pharmacy' and active and deleted_at is null) then
    raise exception 'choose an open pharmacy store' using errcode = '22023';
  end if;
  v_number := day_number('S', 'counter-sale');
  insert into counter_sale (number, buyer_name, buyer_phone, location_id, note)
  values (v_number, nullif(trim(coalesce(p_buyer_name, '')), ''), nullif(trim(coalesce(p_buyer_phone, '')), ''), v_loc,
          nullif(trim(coalesce(p_note, '')), ''))
  returning id into v_id;
  for v_line in select * from note_lines(p_lines) loop
    if not exists (select 1 from item where id = v_line.item_id and active and deleted_at is null) then
      raise exception 'medicine not found or switched off' using errcode = 'P0002';
    end if;
    select pf.price into v_price from price_for(null, v_line.item_id, null) pf;
    if v_price is null then
      raise exception '% has no selling price: set it first', item_label(v_line.item_id) using errcode = '22023', hint = 'no_price';
    end if;
    -- never sold from expired stock
    v_usable := usable_stock(v_line.item_id, v_loc);
    if v_usable < v_line.quantity then
      raise exception 'only % of % (not expired) in the pharmacy', v_usable, item_label(v_line.item_id)
        using errcode = '23514', hint = 'short';
    end if;
    -- whole packs at the pack price when the item has one; pieces × price otherwise
    select * into v_pk from pack_charge(v_line.item_id, v_line.quantity, round(v_price), true);
    insert into counter_sale_line (sale_id, item_id, quantity, unit_price, line_total, packs, pack_price)
    values (v_id, v_line.item_id, v_line.quantity, round(v_price), v_pk.total,
            case when v_pk.by_pack then v_pk.packs end, case when v_pk.by_pack then v_pk.pack_price end);
    v_total := v_total + v_pk.total;
  end loop;
  update counter_sale set total = v_total where id = v_id;
  insert into notification (kind, params, link, recipient_stations, created_by)
  values ('counter_sale_to_pay', jsonb_build_object('number', v_number, 'amount', v_total,
                                                    'buyer', nullif(trim(coalesce(p_buyer_name, '')), ''), 'saleId', v_id),
          '/app/bills?sale=' || v_id, array['cashier'::station], auth.uid());
  return jsonb_build_object('id', v_id, 'number', v_number, 'total', v_total, 'status', 'open');
end
$$;

-- counter_sales (from 20261124090000_stores_and_stock): each line says its packs, when charged so.
create or replace function counter_sales(p_status text default null, p_from date default null, p_to date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'number', s.number, 'status', s.status, 'buyer', s.buyer_name, 'phone', s.buyer_phone,
      'storeId', s.location_id, 'store', l.name, 'total', s.total, 'note', s.note,
      'at', s.created_at, 'by', (select full_name from profiles where id = s.created_by),
      'paidAt', s.paid_at, 'receipt', pa.receipt_no, 'method', pa.method,
      'cashier', (select full_name from profiles where id = pa.cashier_id),
      'handedOverAt', s.handed_over_at, 'handedOverBy', (select full_name from profiles where id = s.handed_over_by),
      'cancelledAt', s.cancelled_at, 'cancelReason', s.cancel_reason,
      'lines', coalesce((select jsonb_agg(jsonb_build_object(
          'itemId', x.item_id, 'item', item_label(x.item_id), 'unit', i.selling_unit, 'quantity', x.quantity,
          'unitPrice', x.unit_price, 'lineTotal', x.line_total,
          'packSize', i.pack_size, 'packs', x.packs, 'packPrice', x.pack_price, 'byPack', x.packs is not null,
          'inStock', usable_stock(x.item_id, s.location_id)) order by i.name_generic)
        from counter_sale_line x join item i on i.id = x.item_id where x.sale_id = s.id and x.deleted_at is null), '[]'::jsonb)
    ) order by s.created_at desc), '[]'::jsonb)
  from counter_sale s
  join stock_location l on l.id = s.location_id
  left join payment pa on pa.id = s.payment_id
  where s.deleted_at is null
    and (stock_admin() or has_perm('payment.take') or has_perm('billing.read'))
    and (p_status is null or s.status = p_status)
    and ((p_from is null and (s.status in ('open', 'paid') or s.created_at > now() - interval '7 days'))
         or (p_from is not null and (s.created_at at time zone 'Africa/Kigali')::date between p_from and coalesce(p_to, p_from)))
$$;

-- ---------------------------------------------------------------- the pharmacy desk says the packs
-- pharmacy_queue (from 20261207090000_pharmacy_simplified): packSize, the pack price when it
-- applies (cash-priced), the packs the remaining quantity comes to, and splitFrom (the rest of a
-- partly given line sent back to the pharmacy).
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
           -- the pack price counts only for a cash-priced line (no insurer, or the insurer has no own price)
           case when inv.payer_id is null or coalesce(pp.fallback, false) then i.pack_price end as pack_price,
           i.prescribing_rule, m.quantity, m.quantity_given, m.dose, m.frequency, m.duration_days, m.instructions,
           pr.id as prescriber_id, pr.full_name as prescriber, pr.specialty,
           py.name as payer, cp.price as cash_price, pp.price as payer_price, pp.fallback,
           cov.pct,
           pc.total as line_total, pc.packs,
           doctor_holds(m.encounter_id) as holds
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open'
    join patient p on p.id = e.patient_id
    join item i on i.id = m.item_id
    left join invoice inv on inv.encounter_id = e.id
    left join payer py on py.id = inv.payer_id
    left join profiles pr on pr.id = coalesce(m.prescriber_id, m.created_by)
    left join lateral (select pf.price from price_for(null, m.item_id, null) pf) cp on true
    left join lateral (select pf.price, pf.fallback from price_for(null, m.item_id, inv.payer_id) pf) pp on true
    left join lateral (select coalesce(coverage_pct_for((select c.plan_id from coverage c where c.id = inv.coverage_id),
                                                        'pharmacy'::service_group), 0) as pct) cov on true
    left join lateral (select k.total, case when k.by_pack then k.packs end as packs
                       from pack_charge(m.item_id, greatest(m.quantity - m.quantity_given, 0), pp.price,
                                        inv.payer_id is null or coalesce(pp.fallback, false)) k) pc on true
    where rx_pending(m)
  ), priced as (
    select l.*, round(coalesce(case when l.payer_price is null then 0 else l.line_total end, 0) * l.pct / 100) as insurer_share
    from lines l
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'requestId', x.id, 'encounterId', x.encounter_id, 'patientId', x.patient_id, 'patient', x.patient,
      'file', x.file_number, 'ticket', x.ticket,
      'itemId', x.item_id, 'item', x.item, 'unit', x.selling_unit,
      'packSize', x.pack_size, 'packPrice', x.pack_price, 'packs', x.packs, 'splitFrom', x.split_from,
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
    ) order by x.created_at), '[]'::jsonb)
  into v_lines
  from priced x;

  with lines as (
    select m.encounter_id, min(m.created_at) as first_at, count(*)::integer as n,
           sum(case when pp.price is null then 0 else pc.total end) as total,
           sum(round(case when pp.price is null then 0 else pc.total end * cov.pct / 100)) as insurer
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open'
    left join invoice inv on inv.encounter_id = e.id
    left join lateral (select pf.price, pf.fallback from price_for(null, m.item_id, inv.payer_id) pf) pp on true
    left join lateral (select coalesce(coverage_pct_for((select c.plan_id from coverage c where c.id = inv.coverage_id),
                                                        'pharmacy'::service_group), 0) as pct) cov on true
    left join lateral (select k.total from pack_charge(m.item_id, greatest(m.quantity - m.quantity_given, 0), pp.price,
                                                       inv.payer_id is null or coalesce(pp.fallback, false)) k) pc on true
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

-- ---------------------------------------------------------------- the stock readers say the pack
-- stock_overview (from 20261207090000_pharmacy_simplified): packPrice beside packSize.
create or replace function stock_overview()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_admin boolean := stock_admin();
  v_vis uuid[] := visible_stores();
  v_main uuid := main_pharmacy();
  v_transit uuid := (select id from stock_location where type::text = 'transit' and deleted_at is null limit 1);
  v_locations jsonb;
  v_days integer := stock_expiry_days();
  v_items jsonb;
begin
  if not (v_admin or has_perm('stock.read') or cardinality(v_vis) > 0) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.name, 'type', l.type, 'department', d.name, 'active', l.active,
      'isMain', l.id = v_main, 'isRoom', is_room_type(l.type), 'held', holds_store(auth.uid(), l.id),
      'holders', store_holders(l.id)
    ) order by l.active desc, l.type, l.name), '[]'::jsonb)
  into v_locations
  from stock_location l left join department d on d.id = l.department_id
  where l.deleted_at is null and l.type::text <> 'transit' and (v_vis is null or l.id = any (v_vis));

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'code', i.code, 'name', i.name_generic, 'strength', i.strength, 'unit', i.selling_unit,
      'packSize', i.pack_size, 'packPrice', i.pack_price,
      'sellingPrice', (select pf.price from price_for(null, i.id, null) pf),
      'reorderLevel', i.reorder_level, 'maxLevel', i.max_level,
      'onHand', coalesce(t.on_hand, 0),
      'usable', coalesce(t.usable, 0),
      'costValue', case when v_admin then coalesce(t.cost_value, 0) end,
      'avgCost', case when v_admin and coalesce(t.on_hand, 0) > 0 then round(t.cost_value / t.on_hand, 2) end,
      'byLocation', coalesce(t.by_location, '{}'::jsonb),
      'byLocationUsable', coalesce(t.by_location_usable, '{}'::jsonb),
      'earliestExpiry', t.earliest_expiry,
      'nextExpiry', t.next_expiry,
      'expiredUnits', coalesce(t.expired, 0),
      'expiringUnits', coalesce(t.expiring, 0),
      'inTransit', case when v_admin then coalesce(t.in_transit, 0) end,
      'pharmacyUsable', case when v_admin then coalesce(t.pharmacy_usable, 0) end,
      'low', i.reorder_level > 0 and coalesce(t.pharmacy_usable, 0) <= i.reorder_level,
      'active', i.active, 'kind', i.kind
    ) order by i.name_generic), '[]'::jsonb)
  into v_items
  from item i
  left join lateral (
    select sum(s.quantity)::integer as on_hand,
           sum(s.quantity) filter (where s.expiry is null or s.expiry >= current_date)::integer as usable,
           sum(s.quantity * coalesce(b.unit_cost, 0)) as cost_value,
           min(s.expiry) filter (where s.quantity > 0) as earliest_expiry,
           min(s.expiry) filter (where s.quantity > 0 and s.expiry >= current_date) as next_expiry,
           sum(s.quantity) filter (where s.quantity > 0 and s.expiry < current_date)::integer as expired,
           sum(s.quantity) filter (where s.quantity > 0 and s.expiry between current_date and current_date + v_days)::integer as expiring,
           (select jsonb_object_agg(x.location_id::text, x.q) from (
              select s2.location_id, sum(s2.quantity)::integer as q from stock_on_hand s2
              where s2.item_id = i.id and s2.location_id is distinct from v_transit
                and (v_vis is null or s2.location_id = any (v_vis))
              group by s2.location_id having sum(s2.quantity) <> 0) x) as by_location,
           (select jsonb_object_agg(x.location_id::text, x.q) from (
              select s2.location_id, sum(s2.quantity)::integer as q from stock_on_hand s2
              where s2.item_id = i.id and s2.location_id is distinct from v_transit
                and (v_vis is null or s2.location_id = any (v_vis))
                and (s2.expiry is null or s2.expiry >= current_date)
              group by s2.location_id having sum(s2.quantity) <> 0) x) as by_location_usable,
           (select coalesce(sum(s3.quantity), 0)::integer from stock_on_hand s3
             where s3.item_id = i.id and s3.location_id = v_transit) as in_transit,
           (select coalesce(sum(s4.quantity), 0)::integer from stock_on_hand s4
              join stock_location l4 on l4.id = s4.location_id
             where s4.item_id = i.id and l4.type = 'pharmacy' and l4.active and l4.deleted_at is null
               and s4.quantity > 0 and (s4.expiry is null or s4.expiry >= current_date)) as pharmacy_usable
    from stock_on_hand s left join batch b on b.id = s.batch_id
    where s.item_id = i.id and s.location_id is distinct from v_transit
      and (v_vis is null or s.location_id = any (v_vis))
  ) t on true
  where i.deleted_at is null;

  return jsonb_build_object('locations', v_locations, 'items', v_items, 'admin', v_admin, 'mainPharmacyId', v_main, 'expiryDays', v_days,
                            'transit', case when v_admin then jsonb_build_object(
                              'units', (select coalesce(sum(s.quantity), 0) from stock_on_hand s where s.location_id = v_transit),
                              'value', (select coalesce(sum(s.quantity * coalesce(b.unit_cost, 0)), 0) from stock_on_hand s
                                        left join batch b on b.id = s.batch_id where s.location_id = v_transit),
                              'notes', (select count(*) from stock_transfer where status = 'in_transit')) end);
end
$$;

-- stock_alerts (from 20261207090000_pharmacy_simplified): the low list says the pack size too.
create or replace function stock_alerts()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_admin boolean := stock_admin();
  v_vis uuid[] := visible_stores();
  v_days integer := stock_expiry_days();
begin
  return jsonb_build_object(
    'expiryDays', v_days,
    -- the pharmacy: unexpired units at or below the reorder level
    'low', case when v_admin then coalesce((
      select jsonb_agg(jsonb_build_object('itemId', r.item_id, 'item', item_label(r.item_id), 'code', r.code,
                                          'onHand', r.on_hand, 'level', r.reorder_level,
                                          'maxLevel', (select max_level from item where id = r.item_id),
                                          'packSize', (select pack_size from item where id = r.item_id),
                                          'unit', (select selling_unit from item where id = r.item_id))
                       order by r.on_hand::numeric / greatest(r.reorder_level, 1), r.name_generic)
      from items_below_reorder r), '[]'::jsonb) else '[]'::jsonb end,
    -- a room store below the minimum set for it
    'roomLow', coalesce((
      select jsonb_agg(jsonb_build_object('storeId', l.id, 'store', l.name, 'itemId', m.item_id, 'item', item_label(m.item_id),
                                          'onHand', usable_stock(m.item_id, l.id), 'min', m.min_level)
                       order by l.name)
      from store_item_level m join stock_location l on l.id = m.location_id and l.active and l.deleted_at is null
      where (v_vis is null or l.id = any (v_vis)) and usable_stock(m.item_id, l.id) < m.min_level), '[]'::jsonb),
    -- expiring within the window (stock.expiry_days) (not expired yet), batch by batch
    'expiring', coalesce((
      select jsonb_agg(jsonb_build_object('storeId', l.id, 'store', l.name, 'itemId', s.item_id, 'item', item_label(s.item_id),
                                          'batchNo', b.batch_no, 'expiry', s.expiry, 'quantity', s.quantity,
                                          'days', s.expiry - current_date)
                       order by s.expiry, l.name)
      from stock_on_hand s join stock_location l on l.id = s.location_id and l.deleted_at is null and l.type::text <> 'transit'
      left join batch b on b.id = s.batch_id
      where s.quantity > 0 and s.expiry between current_date and current_date + v_days
        and (v_vis is null or l.id = any (v_vis))), '[]'::jsonb),
    -- already expired: to write off (or send back to the pharmacy)
    'expired', coalesce((
      select jsonb_agg(jsonb_build_object('storeId', l.id, 'store', l.name, 'itemId', s.item_id, 'item', item_label(s.item_id),
                                          'batchNo', b.batch_no, 'expiry', s.expiry, 'quantity', s.quantity)
                       order by s.expiry, l.name)
      from stock_on_hand s join stock_location l on l.id = s.location_id and l.deleted_at is null and l.type::text <> 'transit'
      left join batch b on b.id = s.batch_id
      where s.quantity > 0 and s.expiry < current_date
        and (v_vis is null or l.id = any (v_vis))), '[]'::jsonb)
  );
end
$$;

-- stock_sales (from 20261207090000_pharmacy_simplified): a bill line written in packs counts its
-- pieces (quantity × pack_size); the revenue is what the line charged.
create or replace function stock_sales(p_from date, p_to date)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with sold as (
    select l.item_id, (l.quantity * coalesce(l.pack_size, 1))::numeric as units, round(l.quantity * l.unit_price) as revenue
    from invoice_line l
    join invoice inv on inv.id = l.invoice_id and inv.status <> 'credited'
    where l.deleted_at is null and l.item_id is not null
      and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    union all
    select x.item_id, x.quantity, x.line_total
    from counter_sale_line x join counter_sale s on s.id = x.sale_id
    where x.deleted_at is null and s.deleted_at is null and s.status = 'handed_over'
      and (s.handed_over_at at time zone 'Africa/Kigali')::date between p_from and p_to
  ), per_item as (
    select i.name_generic || coalesce(' ' || i.strength, '') as name,
           sum(s.units) as units,
           sum(s.revenue) as revenue,
           round(sum(s.units) * coalesce((
             select sum(coalesce(m.unit_cost, b.unit_cost) * m.quantity) / nullif(sum(m.quantity), 0)
             from stock_movement m join batch b on b.id = m.batch_id
             where m.item_id = i.id and m.type = 'receipt' and m.deleted_at is null and b.deleted_at is null), 0), 2) as cost
    from sold s join item i on i.id = s.item_id
    group by i.id, i.name_generic, i.strength
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'item', x.name, 'units', x.units, 'revenue', x.revenue, 'cost', x.cost, 'margin', x.revenue - x.cost
      ) order by x.revenue desc) from per_item x), '[]'::jsonb),
    'revenue', (select coalesce(sum(revenue), 0) from per_item),
    'cost', (select coalesce(sum(cost), 0) from per_item),
    'margin', (select coalesce(sum(revenue - cost), 0) from per_item),
    'counterRevenue', (select coalesce(sum(s.total), 0) from counter_sale s
                       where s.deleted_at is null and s.status = 'handed_over'
                         and (s.handed_over_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'received', (select coalesce(sum(m.quantity * coalesce(m.unit_cost, b.unit_cost, 0)), 0)
                 from stock_movement m left join batch b on b.id = m.batch_id
                 where m.deleted_at is null and m.type = 'receipt' and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'consumed', (select coalesce(sum(m.quantity * coalesce(b.unit_cost, 0)), 0) from stock_movement m left join batch b on b.id = m.batch_id
                 where m.deleted_at is null and m.type = 'consumption' and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    -- everything held, in every store and on the way
    'stockValue', (select coalesce(sum(s.quantity * coalesce(b.unit_cost, 0)), 0) from stock_on_hand s
                   left join batch b on b.id = s.batch_id where s.quantity > 0)
  )
  where has_perm('stock.read') and stock_admin()
$$;

-- ---------------------------------------------------------------- add stock: the pack size follows
-- add_stock (from 20261208090000_reference_list_versions): a line may say pack_size (counted in
-- boxes): an item without one takes it; a medicine new from the official list takes the list's
-- "B/20". Quantities stay in pieces.
create or replace function add_stock(p_lines jsonb, p_location_id uuid default null, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_main uuid := main_pharmacy();
  v_loc uuid;
  v_id uuid;
  v_number text;
  v_line jsonb;
  v_n integer;
  v_item uuid;
  v_new jsonb;
  v_kind text;
  v_name text;
  v_strength text;
  v_code text;
  v_ref medicine_reference%rowtype;
  v_created boolean;
  v_qty numeric;
  v_units integer;
  v_cost numeric;
  v_sell numeric;
  v_price numeric;
  v_expiry date;
  v_batch uuid;
  v_line_cost numeric;
  v_updated boolean;
  v_ignored boolean;
  v_pack integer;
  v_price_right boolean := has_perm('item_price.write') or has_perm('catalogue.write');
  v_out jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_state text;
  v_msg text;
  v_hint text;
begin
  if not stock_manager() then
    perform assert_stock_write();
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_loc := coalesce(p_location_id, v_main);
  if v_loc is null then
    raise exception 'no pharmacy store yet: create one under Stock' using errcode = 'P0002';
  end if;
  if v_loc is distinct from v_main and not is_manager() then
    raise exception 'stock is added into the main pharmacy (another store: the manager)' using errcode = '42501';
  end if;
  if not exists (select 1 from stock_location where id = v_loc and deleted_at is null and type::text <> 'transit') then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'add at least one medicine' using errcode = '22023';
  end if;
  v_number := day_number('GRN', 'goods-receipt');
  insert into goods_receipt (supplier_id, received_on, note, number, reference, delivered_on, location_id, supplier_name)
  values (null, now(), nullif(trim(coalesce(p_note, '')), ''), v_number, null,
          (now() at time zone 'Africa/Kigali')::date, v_loc, null)
  returning id into v_id;

  for v_line, v_n in select x.value, x.ordinality from jsonb_array_elements(p_lines) with ordinality as x loop
    begin
      v_created := false;
      v_updated := false;
      v_ignored := false;
      v_ref := null;
      v_item := nullif(v_line ->> 'item_id', '')::uuid;
      v_new := case when jsonb_typeof(v_line -> 'new_item') = 'object' then v_line -> 'new_item' end;
      v_sell := nullif(v_line ->> 'sell_price', '')::numeric;
      -- 0102: the pieces in one pack, when the line was counted in boxes
      v_pack := nullif(v_line ->> 'pack_size', '')::integer;
      if v_pack is not null and v_pack < 1 then
        raise exception 'units per box: 1 or more' using errcode = '22023';
      end if;
      if v_sell is not null and v_sell < 0 then
        raise exception 'the price must be zero or more' using errcode = '22023';
      end if;
      if v_item is null and v_new is not null then
        v_kind := coalesce(nullif(v_new ->> 'kind', ''), 'medicine');
        if v_kind not in ('medicine', 'supply') then
          raise exception 'a new item is a medicine or a supply' using errcode = '22023';
        end if;
        v_name := trim(coalesce(v_new ->> 'name', ''));
        v_strength := nullif(trim(coalesce(v_new ->> 'strength', '')), '');
        if length(v_name) < 2 then
          raise exception 'the medicine needs a name' using errcode = '22023';
        end if;
        -- 0098: picked from the official list: the item carries the list's code (its insurer
        -- price and its prescribing rule follow the list)
        v_code := nullif(upper(trim(coalesce(v_new ->> 'code', ''))), '');
        if v_code is not null then
          select * into v_ref from medicine_reference where code = v_code;
          if not found then
            raise exception 'this medicine is not on the reference list' using errcode = 'P0002';
          end if;
          select id into v_item from item where code = v_code;
          if v_item is not null then
            update item set deleted_at = null, active = true where id = v_item and (deleted_at is not null or not active);
          end if;
          -- 0102: the list's "B/20" is the pack size, unless the line says it
          v_pack := coalesce(v_pack, pack_size_in(v_ref.presentation));
        end if;
        -- the same name (and strength) already on the list: that item
        if v_item is null then
          select id into v_item from item
          where deleted_at is null and lower(name_generic) = lower(v_name)
            and lower(coalesce(strength, '')) = lower(coalesce(v_strength, ''))
          order by active desc, created_at
          limit 1;
        end if;
        if v_item is null then
          insert into item (code, name_generic, strength, form, unit, selling_unit, active, kind, pack_size)
          values (coalesce(v_code, case when v_kind = 'supply' then 'SUP-' else 'MED-' end
                    || lpad(next_number('item_code', 0)::text, 4, '0')),
                  v_name, v_strength, nullif(trim(coalesce(v_new ->> 'form', '')), ''),
                  nullif(trim(coalesce(v_new ->> 'unit', '')), ''), nullif(trim(coalesce(v_new ->> 'unit', '')), ''),
                  true, v_kind, v_pack)
          returning id into v_item;
          if v_code is not null then
            update item set prescribing_rule = v_ref.prescribing_rule, atc_group = v_ref.atc_group,
                            name_brand = v_ref.presentation, source = v_ref.source
            where id = v_item;
          end if;
          v_created := true;
        end if;
      end if;
      if v_item is null then
        raise exception 'choose the medicine' using errcode = '22023';
      end if;
      if not exists (select 1 from item where id = v_item and deleted_at is null) then
        raise exception 'medicine not found' using errcode = 'P0002';
      end if;
      -- an item without a pack size takes the one the line was counted with
      if v_pack is not null then
        update item set pack_size = v_pack where id = v_item and pack_size is null;
      end if;
      v_qty := nullif(v_line ->> 'quantity', '')::numeric;
      if v_qty is null or v_qty <= 0 then
        raise exception 'quantity must be more than zero' using errcode = '22023';
      end if;
      if v_qty <> round(v_qty) then
        raise exception 'the quantity must come to whole units' using errcode = '22023';
      end if;
      v_units := v_qty::integer;
      v_cost := nullif(v_line ->> 'unit_cost', '')::numeric;
      if v_cost is null or v_cost < 0 then
        raise exception 'the cost per unit must be zero or more' using errcode = '22023';
      end if;
      v_expiry := nullif(v_line ->> 'expiry', '')::date;
      -- the selling price: a new item (or one without a price) takes it; a different price needs the right
      if v_sell is not null then
        select pf.price into v_price from price_for(null, v_item, null) pf;
        if v_price is null or v_created then
          perform set_cash_price(v_item, v_sell);
          v_updated := true;
        elsif round(v_sell) <> v_price then
          if v_price_right then
            perform set_cash_price(v_item, v_sell);
            v_updated := true;
          else
            v_ignored := true;
          end if;
        end if;
      end if;
      v_batch := receive_batch(v_item, v_loc, v_units, v_cost, v_line ->> 'batch_no', v_expiry, null, null, v_id);
      v_line_cost := round(round(v_cost, 2) * v_units, 2);
      insert into goods_receipt_line (receipt_id, item_id, batch_id, batch_no, expiry, unit, packs, pack_size, units,
                                      unit_cost, pack_cost, line_cost)
      select v_id, v_item, b.id, b.batch_no, b.expiry, 'unit', v_units, 1, v_units, round(v_cost, 2), null, v_line_cost
      from batch b where b.id = v_batch;
      v_total := v_total + v_line_cost;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'item_id', v_item, 'batch_id', v_batch, 'quantity', v_units, 'line_cost', v_line_cost,
        'created', v_created, 'price_updated', v_updated, 'price_ignored', v_ignored,
        'pack_size', (select pack_size from item where id = v_item)));
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
      raise exception 'line %: %', v_n, v_msg using errcode = v_state, hint = coalesce(nullif(v_hint, ''), 'line');
    end;
  end loop;
  update goods_receipt set total_cost = v_total where id = v_id;
  perform stock_alert_run();
  return jsonb_build_object('lines', v_out, 'total_cost', v_total, 'id', v_id, 'number', v_number, 'location_id', v_loc);
end
$$;

-- ---------------------------------------------------------------- the rest of an over-quantity prescription
-- rx_not_given (from 20261210090000_outside_prescriptions): the prescriber is told what was
-- prescribed, given and remaining; the rest may always go to an outside pharmacy.
create or replace function rx_not_given(p_medication_request_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_item text;
  v_name text;
  v_left integer;
  v_main uuid := main_pharmacy();
begin
  perform assert_desk(array['pharmacy'], 'the pharmacy');
  if length(trim(coalesce(p_reason, ''))) < 2 then
    raise exception 'say why the medicine is not given' using errcode = '22023';
  end if;
  select * into v_m from medication_request where id = p_medication_request_id for update;
  if not found or not rx_pending(v_m) then
    raise exception 'this medicine is no longer waiting at the pharmacy' using errcode = 'P0002';
  end if;
  update medication_request
  set not_given_at = now(), not_given_by = auth.uid(), not_given_reason = trim(p_reason)
  where id = v_m.id;
  v_item := rx_label(v_m);
  v_left := ceil(v_m.quantity)::integer - coalesce(v_m.quantity_given, 0);
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
  if coalesce(v_m.prescriber_id, v_m.created_by) is not null
     and coalesce(v_m.prescriber_id, v_m.created_by) is distinct from auth.uid() then
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('rx_not_given', jsonb_build_object('item', v_item, 'name', v_name, 'reason', trim(p_reason),
                                               'quantity', ceil(v_m.quantity)::integer,
                                               'given', coalesce(v_m.quantity_given, 0),
                                               'remaining', v_left,
                                               'unit', (select selling_unit from item where id = v_m.item_id),
                                               'requestId', v_m.id,
                                               -- the pharmacy has not enough (unexpired) for what remains
                                               'noStock', v_main is null or usable_stock(v_m.item_id, v_main) < v_left,
                                               -- the prescriber may send what remains to an outside pharmacy
                                               'outside', true),
            '/app/visit?encounter=' || v_m.encounter_id, coalesce(v_m.prescriber_id, v_m.created_by), auth.uid());
  end if;
  perform after_pharmacy(v_m.encounter_id);
end
$$;

-- rx_set_supply (from 20261210090000_outside_prescriptions): a partly given line sends only its
-- remainder outside (a new line, split_from = the original); the given part stays charged.
create or replace function rx_set_supply(p_request_id uuid, p_supply text, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_rest medication_request%rowtype;
  v_open boolean;
  v_was_waiting boolean;
  v_name text;
  v_left integer;
  v_given integer;
  v_remaining integer;
  v_rest_id uuid;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  if p_supply is null or p_supply not in ('pharmacy', 'outside') then
    raise exception 'unknown supply' using errcode = '22023';
  end if;
  select * into v_m from medication_request where id = p_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  select e.status = 'open' into v_open from encounter e where e.id = v_m.encounter_id;
  -- as prescribing: the doctor treating the patient (or the prescriber, or the manager)
  if not (is_manager() or coalesce(v_m.prescriber_id, v_m.created_by) = auth.uid()
          or (v_open and may_work_on(v_m.encounter_id))) then
    if v_open then
      perform assert_may_work_on(v_m.encounter_id);
    end if;
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_m.cancelled_at is not null or v_m.given_at is not null or v_m.supply = 'room' then
    raise exception 'this medicine was already given or cancelled: it stays as it is' using errcode = 'P0002';
  end if;
  v_given := coalesce(v_m.quantity_given, 0);
  v_remaining := ceil(v_m.quantity)::integer - v_given;
  -- a hand-over of before 0097 (no quantity kept): the whole line was given
  if v_given = 0 and v_m.not_given_at is null and exists (
       select 1 from medication_dispense d where d.medication_request_id = v_m.id and d.deleted_at is null) then
    raise exception 'this medicine was already given or cancelled: it stays as it is' using errcode = 'P0002';
  end if;

  -- 0102: part of it was handed over: the decision is about the REST. The rest already has its
  -- own line (sent outside before): the decision applies to that line.
  if v_given > 0 then
    if v_remaining <= 0 then
      raise exception 'this medicine was already given or cancelled: it stays as it is' using errcode = 'P0002';
    end if;
    select * into v_rest from medication_request
    where split_from = v_m.id and deleted_at is null and cancelled_at is null
    order by created_at desc limit 1;
    if found then
      return rx_set_supply(v_rest.id, p_supply, p_reason) || jsonb_build_object('splitFrom', v_m.id, 'given', v_given);
    end if;
    if p_supply = 'outside' then
      if not v_open then
        raise exception 'visit not found or already closed' using errcode = 'P0002';
      end if;
      v_was_waiting := rx_pending(v_m);
      -- still waiting at the pharmacy: the original closes for the rest (the given part stays)
      if v_was_waiting then
        update medication_request
        set not_given_at = now(), not_given_by = auth.uid(),
            not_given_reason = coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'the rest is bought at an outside pharmacy')
        where id = v_m.id;
      end if;
      insert into medication_request (encounter_id, item_id, dose, route, frequency, duration_days, quantity,
                                      instructions, allergy_override_reason, supply, prescriber_id, medicine_name,
                                      reference_code, supply_set_at, supply_set_by, supply_reason, split_from)
      values (v_m.encounter_id, v_m.item_id, v_m.dose, v_m.route, v_m.frequency, v_m.duration_days,
              v_m.quantity - v_given, v_m.instructions, v_m.allergy_override_reason, 'outside',
              coalesce(v_m.prescriber_id, v_m.created_by),
              coalesce(nullif(trim(coalesce(v_m.medicine_name, '')), ''), item_label(v_m.item_id)),
              coalesce(v_m.reference_code, (select i.code from item i where i.id = v_m.item_id
                                              and exists (select 1 from medicine_reference r where r.code = i.code))),
              now(), auth.uid(), nullif(trim(coalesce(p_reason, '')), ''), v_m.id)
      returning id into v_rest_id;
      if v_was_waiting then
        select p.surname || ' ' || p.given_names into v_name
        from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
        insert into notification (kind, params, link, recipient_stations, created_by)
        values ('rx_outside',
                jsonb_build_object('item', rx_label(v_m), 'name', v_name,
                                   'by', (select full_name from profiles where id = auth.uid()),
                                   'reason', nullif(trim(coalesce(p_reason, '')), ''), 'requestId', v_m.id,
                                   'quantity', v_remaining, 'given', v_given),
                '/app/visit?encounter=' || v_m.encounter_id, array['pharmacy'::station], auth.uid());
        perform after_pharmacy(v_m.encounter_id);
      end if;
      select count(*)::integer into v_left from medication_request m
      where m.encounter_id = v_m.encounter_id and rx_pending(m);
      return jsonb_build_object('id', v_rest_id, 'supply', 'outside', 'changed', true, 'pending', v_left,
                                'splitFrom', v_m.id, 'quantity', v_remaining, 'given', v_given);
    end if;
    -- back to the pharmacy: the rest waits on the original line again (below)
  end if;

  if v_m.supply = p_supply then
    return jsonb_build_object('id', v_m.id, 'supply', v_m.supply, 'changed', false,
                              'pending', (select count(*)::integer from medication_request m
                                          where m.encounter_id = v_m.encounter_id and rx_pending(m)));
  end if;
  v_was_waiting := rx_pending(v_m);
  if p_supply = 'pharmacy' then
    if v_m.item_id is null then
      raise exception 'this medicine is not sold at the clinic: it can only be bought outside' using errcode = '22023';
    end if;
    if not v_open then
      raise exception 'visit not found or already closed' using errcode = 'P0002';
    end if;
    -- back to the pharmacy's list (a "not given" of before is cleared: the pharmacy tries again)
    update medication_request
    set supply = 'pharmacy', not_given_at = null, not_given_by = null, not_given_reason = null,
        supply_set_at = now(), supply_set_by = auth.uid(),
        supply_reason = nullif(trim(coalesce(p_reason, '')), '')
    where id = v_m.id;
    if not exists (select 1 from queue_entry where encounter_id = v_m.encounter_id and station = 'pharmacy'
                   and finished_at is null and deleted_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no)
      values (v_m.encounter_id, 'pharmacy',
              (select ticket_no from queue_entry where encounter_id = v_m.encounter_id order by created_at limit 1));
    end if;
  else
    update medication_request
    set supply = 'outside', medicine_name = coalesce(nullif(trim(coalesce(medicine_name, '')), ''), item_label(item_id)),
        reference_code = coalesce(reference_code, (select i.code from item i where i.id = v_m.item_id
                                                     and exists (select 1 from medicine_reference r where r.code = i.code))),
        supply_set_at = now(), supply_set_by = auth.uid(),
        supply_reason = nullif(trim(coalesce(p_reason, '')), '')
    where id = v_m.id;
    -- it was on the pharmacy's list: the pharmacy is told it left
    if v_was_waiting then
      select p.surname || ' ' || p.given_names into v_name
      from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
      insert into notification (kind, params, link, recipient_stations, created_by)
      values ('rx_outside',
              jsonb_build_object('item', rx_label(v_m), 'name', v_name,
                                 'by', (select full_name from profiles where id = auth.uid()),
                                 'reason', nullif(trim(coalesce(p_reason, '')), ''), 'requestId', v_m.id),
              '/app/visit?encounter=' || v_m.encounter_id, array['pharmacy'::station], auth.uid());
    end if;
    -- nothing left at the pharmacy: the patient goes on (back, cashier, or the visit closes)
    if v_open then
      perform after_pharmacy(v_m.encounter_id);
    end if;
  end if;
  select count(*)::integer into v_left from medication_request m
  where m.encounter_id = v_m.encounter_id and rx_pending(m);
  return jsonb_build_object('id', v_m.id, 'supply', p_supply, 'changed', true, 'pending', v_left,
                            'splitFrom', v_m.split_from);
end
$$;

-- rx_bought_outside (from 20261210090000_outside_prescriptions): the remainder of a partly given
-- line counts as sent outside after the pharmacy had none.
create or replace function rx_bought_outside(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (has_perm('stock.read') and stock_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_to < p_from then
    raise exception 'the end of the period is before its start' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'name', x.name, 'itemId', x.item_id, 'referenceCode', x.code, 'inClinic', x.item_id is not null,
        'times', x.times, 'quantity', x.quantity, 'patients', x.patients, 'lastAt', x.last_at,
        'notGiven', x.not_given)
      order by x.times desc, x.quantity desc, x.name)
    from (
      select min(rx_label(m)) as name, m.item_id, min(m.reference_code) as code,
             count(*)::integer as times, sum(m.quantity) as quantity,
             count(distinct e.patient_id)::integer as patients, max(m.created_at) as last_at,
             -- sent outside after the pharmacy had none (the whole line, or the rest of a part hand-over)
             count(*) filter (where m.not_given_at is not null or m.split_from is not null)::integer as not_given
      from medication_request m join encounter e on e.id = m.encounter_id
      where m.deleted_at is null and m.supply = 'outside' and m.cancelled_at is null
        and (m.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
      group by m.item_id, case when m.item_id is null then lower(coalesce(m.reference_code, rx_label(m))) end
    ) x), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- grants
-- (functions replaced with the same arguments keep their grants)
revoke all on function pack_size_in(text), pack_charge(uuid, numeric, numeric, boolean) from public, anon, authenticated;
revoke all on function set_pack_price(uuid, numeric) from public, anon;
grant execute on function set_pack_price(uuid, numeric) to authenticated;
