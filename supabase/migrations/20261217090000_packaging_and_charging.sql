-- 0107 · How a medicine is packed and how it is sold.
--
-- Frank (owner): "When I add stock I say its package (a pack of 8 pieces, or only pieces) and how
-- it is charged: per pack, per piece, or both a pack price and a piece price, so that however the
-- doctor or the patient buys it, it is sold and priced accordingly."
--
--   * The package: pieces only (item.pack_size null or 1: stocked and sold by the piece) or a pack
--     of N pieces (pack_size >= 2). item.unit / selling_unit is the piece (tablet, capsule,
--     sachet, ampoule, bottle…); item.pack_unit (new) is the pack's word (box, strip, blister…).
--   * How it is sold: item.sale_mode (new) in
--       'piece' — by the piece at the piece price (packs typed are only a way to count pieces);
--       'pack'  — only by whole packs at the pack price: a quantity that is not whole packs is
--                 refused (assert_whole_packs). The piece price is derived (pack price / pieces
--                 in one), kept as the cash price for the insurers' fallback and the valuation;
--       'both'  — whole packs at the pack price and the pieces left at the piece price
--                 (1 pack + 3 pieces = pack price + 3 × piece price).
--     'pack' and 'both' need a pack size of 2 or more and a pack price (a check on item).
--   * Stock stays in PIECES everywhere (add stock, hand-over, sales, transfers, counts, write-offs,
--     reorder levels): the screens show the packs beside them.
--   * One price rule for every selling path: price_quantity(item, pieces, piece price, cash,
--     discount). add_charge_internal (the hand-over, Sell a medicine, "I give it here", a desk's
--     charge), create_counter_sale (walk-in buyers) and the readers (pharmacy_queue) use it. An
--     insurer's own price stays per piece (a cash-priced line only is priced by the pack). On the
--     bill the whole packs are their own line ("… · B/8", quantity = packs, unit price = the pack
--     price, pack_size = pieces in one) and the pieces left a second line at the piece price.
--   * The hand-over of a pack-only medicine gives whole packs: the last pack may pass what remains
--     (10 prescribed in packs of 8: 16 may be given; pharmacy_queue says due = 16).
--   * Who changes the package and the prices: set_item_packaging (the manager, item_price.write or
--     catalogue.write), as set_pack_size / set_pack_price. add_stock takes them on a line: a new
--     item always, an item already known only for a person with that right (else the line says
--     price_ignored, as for a price before).
--   * Existing items: a pack size of 2 or more with a pack price → 'both' (as 0103 charged them);
--     the rest → 'piece'. Run again, the migration keeps what was chosen since.

-- ---------------------------------------------------------------- columns
alter table item add column if not exists pack_unit text;
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'item' and column_name = 'sale_mode') then
    alter table item add column sale_mode text not null default 'piece';
    -- the items 0103 charged by the pack (a pack price set) keep being charged so
    update item set sale_mode = 'both' where coalesce(pack_size, 1) >= 2 and pack_price is not null;
  end if;
end
$$;
alter table item drop constraint if exists item_sale_mode_check;
alter table item add constraint item_sale_mode_check check (sale_mode in ('piece', 'pack', 'both'));
-- by the pack: a pack of 2 or more and its price
alter table item drop constraint if exists item_sale_mode_pack;
alter table item add constraint item_sale_mode_pack
  check (sale_mode = 'piece' or (coalesce(pack_size, 1) >= 2 and pack_price is not null));
-- a walk-in sale line keeps the pieces in one pack it was priced with
alter table counter_sale_line add column if not exists pack_size integer;

-- ---------------------------------------------------------------- guard: through the checked functions only
-- guard_item (from 20261214090000_packs_and_pieces): how it is sold and the pack word too.
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
       or new.pack_price is distinct from old.pack_price or new.sale_mode is distinct from old.sale_mode
       or new.pack_unit is distinct from old.pack_unit
       or new.reference_removed_at is distinct from old.reference_removed_at) then
    raise exception 'deleting, switching off, the code, the box size and the stock levels change only through their screens'
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------- the price rule
-- What p_pieces pieces of an item cost, by how it is sold. p_piece_price is the price of one
-- piece on the line (the insurer's own, or the cash price, already less a discount); p_cash says
-- the line is cash-priced (no insurer, or the insurer has no own price): only then are whole packs
-- charged at the pack price (less p_discount_pct). Returns the whole packs and the pieces left,
-- the prices used, the total, and ok = false for a pack-only medicine asked in pieces that are not
-- whole packs (the callers refuse it with assert_whole_packs).
create or replace function price_quantity(
  p_item_id uuid, p_pieces numeric, p_piece_price numeric, p_cash boolean default true, p_discount_pct numeric default 0
)
returns table (sale_mode text, pack_size integer, pack_unit text, unit text, packs integer, pieces numeric,
               pack_price numeric, piece_price numeric, total numeric, ok boolean)
language plpgsql stable
as $$
#variable_conflict use_column
declare
  v_mode text;
  v_size integer;
  v_pack numeric;
  v_piece numeric := round(coalesce(p_piece_price, 0));
  v_q numeric := greatest(coalesce(p_pieces, 0), 0);
  v_whole boolean;
begin
  select coalesce(i.sale_mode, 'piece'), case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end,
         i.pack_price, i.pack_unit, i.selling_unit
  into v_mode, v_size, v_pack, pack_unit, unit
  from item i where i.id = p_item_id;
  if v_size is null then
    v_mode := 'piece';
  end if;
  sale_mode := coalesce(v_mode, 'piece');
  pack_size := v_size;
  v_whole := v_size is not null and v_q > 0 and v_q = trunc(v_q) and (v_q::integer % v_size) = 0;
  ok := sale_mode <> 'pack' or v_whole;
  piece_price := v_piece;
  if coalesce(p_cash, false) and sale_mode in ('pack', 'both') and v_pack is not null and v_q > 0
     and (sale_mode = 'both' or v_whole) then
    pack_price := round(v_pack * (100 - coalesce(p_discount_pct, 0)) / 100);
    packs := floor(v_q / v_size)::integer;
    pieces := v_q - packs * v_size;
    total := packs * pack_price + round(v_piece * pieces);
  else
    pack_price := case when sale_mode <> 'piece' and v_pack is not null
                       then round(v_pack * (100 - coalesce(p_discount_pct, 0)) / 100) end;
    packs := 0;
    pieces := v_q;
    total := round(v_piece * v_q);
  end if;
  return next;
end
$$;

-- pack_charge (from 20261214090000_packs_and_pieces): kept for any older reader; it is the same rule.
create or replace function pack_charge(p_item_id uuid, p_units numeric, p_unit_price numeric, p_cash boolean)
returns table (by_pack boolean, packs integer, pack_size integer, pack_price numeric, total numeric)
language plpgsql stable
as $$
#variable_conflict use_column
begin
  return query
  select k.packs > 0, case when k.packs > 0 then k.packs end, k.pack_size,
         case when k.packs > 0 then k.pack_price end, k.total
  from price_quantity(p_item_id, p_units, p_unit_price, p_cash) k;
end
$$;

-- What a hand-over gives by default of p_remaining pieces: all of it; a medicine sold only by the
-- whole pack: up to whole packs (10 remaining in packs of 8: 16).
create or replace function rx_due(p_item_id uuid, p_remaining integer)
returns integer
language sql stable
as $$
  select case when i.sale_mode = 'pack' and coalesce(i.pack_size, 1) >= 2 and coalesce(p_remaining, 0) > 0
              then ceil(p_remaining::numeric / i.pack_size)::integer * i.pack_size
              else greatest(coalesce(p_remaining, 0), 0) end
  from item i where i.id = p_item_id
$$;

-- A medicine sold only by the whole pack refuses a quantity that is not whole packs.
create or replace function assert_whole_packs(p_item_id uuid, p_pieces numeric)
returns void
language plpgsql stable security definer set search_path = public
as $$
declare
  v_mode text;
  v_size integer;
begin
  select i.sale_mode, i.pack_size into v_mode, v_size from item i where i.id = p_item_id;
  if v_mode = 'pack' and coalesce(v_size, 1) >= 2
     and (p_pieces is null or p_pieces <= 0 or p_pieces <> trunc(p_pieces) or (p_pieces::integer % v_size) <> 0) then
    raise exception '% is sold only in whole packs of %: % is not a whole number of packs',
      item_label(p_item_id), v_size, trim_scale(coalesce(p_pieces, 0))
      using errcode = '22023', hint = 'whole_packs';
  end if;
end
$$;

-- ---------------------------------------------------------------- the package and how it is sold
-- Internal (add_stock, set_item_packaging): sets the package (pieces only: p_pack_size null or 1;
-- a pack of p_pack_size >= 2, its word p_pack_unit), the piece word p_unit (when said), how it is
-- sold and its prices. 'piece' and 'both' need the piece price; 'pack' and 'both' the pack price;
-- 'pack' derives the piece price (pack price / pieces in one). The piece price is the cash price.
create or replace function apply_item_packaging(
  p_item_id uuid, p_pack_size integer, p_sale_mode text, p_piece_price numeric, p_pack_price numeric,
  p_unit text default null, p_pack_unit text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_mode text := coalesce(nullif(trim(coalesce(p_sale_mode, '')), ''), 'piece');
  v_size integer := case when coalesce(p_pack_size, 1) >= 2 then p_pack_size end;
  v_piece numeric;
  v_pack numeric;
  v_unit text := nullif(trim(coalesce(p_unit, '')), '');
  v_pack_unit text := nullif(trim(coalesce(p_pack_unit, '')), '');
begin
  if v_mode not in ('piece', 'pack', 'both') then
    raise exception 'say how it is sold: by the piece, by the pack or both' using errcode = '22023';
  end if;
  if p_pack_size is not null and p_pack_size < 1 then
    raise exception 'units per box: 1 or more' using errcode = '22023';
  end if;
  if v_mode <> 'piece' and v_size is null then
    raise exception 'say how many units are in one box' using errcode = '22023', hint = 'pack_size';
  end if;
  if (p_piece_price is not null and p_piece_price < 0) or (p_pack_price is not null and p_pack_price < 0) then
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  if v_mode in ('pack', 'both') and p_pack_price is null then
    raise exception 'say the price of one pack' using errcode = '22023';
  end if;
  if v_mode in ('piece', 'both') and p_piece_price is null then
    raise exception 'say the price of one piece' using errcode = '22023';
  end if;
  v_pack := case when v_mode <> 'piece' then round(p_pack_price) end;
  v_piece := case when v_mode = 'pack' then round(v_pack / v_size) else round(p_piece_price) end;
  update item
  set pack_size = v_size, sale_mode = v_mode, pack_price = v_pack,
      pack_unit = case when v_size is null then null else coalesce(v_pack_unit, pack_unit) end,
      unit = coalesce(v_unit, unit), selling_unit = coalesce(v_unit, selling_unit),
      updated_at = now()
  where id = p_item_id and deleted_at is null;
  if not found then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  perform set_cash_price(p_item_id, v_piece);
  return (select jsonb_build_object('itemId', i.id, 'packSize', i.pack_size, 'packUnit', i.pack_unit,
                                    'unit', i.selling_unit, 'saleMode', i.sale_mode, 'packPrice', i.pack_price,
                                    'piecePrice', v_piece)
          from item i where i.id = p_item_id);
end
$$;

-- Prices › Medicines and Add stock: the manager, or a person with the price right
-- (item_price.write, catalogue.write) sets the package and how it is sold.
create or replace function set_item_packaging(
  p_item_id uuid, p_pack_size integer, p_sale_mode text, p_piece_price numeric, p_pack_price numeric,
  p_unit text default null, p_pack_unit text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if not (has_perm('item_price.write') or has_perm('catalogue.write') or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return apply_item_packaging(p_item_id, p_pack_size, p_sale_mode, p_piece_price, p_pack_price, p_unit, p_pack_unit);
end
$$;

-- set_pack_size (from 20261124090000_stores_and_stock): no pack any more (1): sold by the piece.
create or replace function set_pack_size(p_item_id uuid, p_pack integer)
returns integer
language plpgsql security definer set search_path = public
as $$
begin
  if not (has_perm('item_price.write') or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_pack is null or p_pack < 1 then
    raise exception 'units per box: 1 or more' using errcode = '22023';
  end if;
  update item
  set pack_size = p_pack, updated_at = now(),
      sale_mode = case when p_pack < 2 then 'piece' else sale_mode end,
      pack_price = case when p_pack < 2 then null else pack_price end,
      pack_unit = case when p_pack < 2 then null else pack_unit end
  where id = p_item_id and deleted_at is null;
  if not found then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  return p_pack;
end
$$;

-- set_pack_price (from 20261214090000_packs_and_pieces): a pack price on an item sold by the piece
-- makes it sold both ways (as 0103 charged it); cleared, it is sold by the piece; a pack-only
-- item's piece price follows the pack price.
create or replace function set_pack_price(p_item_id uuid, p_price numeric)
returns numeric
language plpgsql security definer set search_path = public
as $$
declare
  v_pack integer;
  v_mode text;
begin
  if not (has_perm('item_price.write') or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_price is not null and p_price < 0 then
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  select pack_size, sale_mode into v_pack, v_mode from item where id = p_item_id and deleted_at is null;
  if not found then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  if p_price is not null and coalesce(v_pack, 1) < 2 then
    raise exception 'say how many units are in one box' using errcode = '22023', hint = 'pack_size';
  end if;
  update item
  set pack_price = round(p_price), updated_at = now(),
      sale_mode = case when p_price is null then 'piece' when v_mode = 'piece' then 'both' else v_mode end
  where id = p_item_id;
  if p_price is not null and v_mode = 'pack' then
    perform set_cash_price(p_item_id, round(round(p_price) / v_pack));
  end if;
  return round(p_price);
end
$$;

-- ---------------------------------------------------------------- the bill: one price rule
-- add_charge_internal (from 20261214090000_packs_and_pieces): priced by price_quantity.

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

-- ---------------------------------------------------------------- the hand-over (and Sell a medicine)
-- dispense_prescription (from 20261210090000_outside_prescriptions): a medicine sold only by the
-- whole pack is given in whole packs (the last one may pass what remains); charged as given.
create or replace function dispense_prescription(
  p_medication_request_id uuid, p_location_id uuid default null, p_quantity integer default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_loc uuid;
  v_dispense uuid;
  v_charged boolean := false;
  v_whole integer;
  v_left integer;
  v_give integer;
  v_charge numeric;
  v_done boolean;
  v_to uuid;
  v_name text;
  v_mode text;
  v_size integer;
  v_most integer;
begin
  perform assert_desk(array['pharmacy'], 'the pharmacy');
  select * into v_m from medication_request where id = p_medication_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  if v_m.supply = 'outside' then
    raise exception 'this medicine is bought at an outside pharmacy: the clinic does not give it' using errcode = '23505';
  end if;
  if v_m.cancelled_at is not null then
    raise exception 'the doctor cancelled this medicine' using errcode = '23505';
  end if;
  v_whole := ceil(v_m.quantity)::integer;
  v_left := v_whole - coalesce(v_m.quantity_given, 0);
  if v_m.given_at is not null or v_left <= 0
     or (coalesce(v_m.quantity_given, 0) = 0 and exists (
           select 1 from medication_dispense d where d.medication_request_id = v_m.id and d.deleted_at is null)) then
    raise exception 'already dispensed' using errcode = '23505';
  end if;
  if v_m.not_given_at is not null then
    raise exception 'this medicine was marked as not given' using errcode = '23505';
  end if;
  if p_quantity is not null and p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  -- 0107: a medicine sold only by the whole pack is given in whole packs: the last pack may
  -- take the quantity above what remains (10 prescribed, packs of 8: 16 may be given)
  select i.sale_mode, case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end into v_mode, v_size
  from item i where i.id = v_m.item_id;
  v_most := case when v_mode = 'pack' and v_size is not null then ceil(v_left::numeric / v_size)::integer * v_size
                 else v_left end;
  if p_quantity is not null and p_quantity > v_most then
    raise exception 'only % left to give of this medicine', v_left using errcode = '22023', hint = 'more_than_remaining';
  end if;
  -- The prescription is final once the doctor has finished (or sent the patient on). A sale written
  -- by the pharmacist themself is not held.
  if coalesce(v_m.prescriber_id, v_m.created_by) is distinct from auth.uid() and doctor_holds(v_m.encounter_id) then
    raise exception 'the doctor is still seeing this patient: hand the medicines over when the doctor has finished'
      using errcode = 'MS002', hint = 'doctor_holds';
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
  if v_loc is null then
    raise exception 'no pharmacy store yet: create one under Stock' using errcode = 'P0002';
  end if;
  v_give := coalesce(p_quantity, v_left);
  perform assert_whole_packs(v_m.item_id, v_give);
  v_done := v_give >= v_left;
  v_dispense := dispense_fefo(v_m.encounter_id, v_m.item_id, v_give, v_loc, v_m.id, null);
  -- the bill charges what is given; the last part charges what remains of the prescribed quantity
  -- (whole packs only: what is given, whole packs)
  v_charge := case when v_mode = 'pack' and v_size is not null then v_give
                   when v_done then v_m.quantity - coalesce(v_m.quantity_given, 0) else v_give end;
  -- no price: handed over free (charged = false); no open bill: refused (MS001)
  begin
    perform add_charge_internal(v_m.encounter_id, 'pharmacy'::station, null, v_m.item_id, v_charge,
                       null, null, null, null, 'medication_dispense', v_dispense);
    v_charged := true;
  exception when sqlstate 'P0002' then
    v_charged := false;
  end;
  update medication_request
  set quantity_given = coalesce(quantity_given, 0) + v_give,
      given_at = case when v_done then now() end,
      given_by = case when v_done then auth.uid() end
  where id = v_m.id;
  -- part given: the prescriber is told what was given and what remains
  if not v_done then
    v_to := coalesce(v_m.prescriber_id, v_m.created_by);
    if v_to is not null and v_to is distinct from auth.uid() then
      select p.surname || ' ' || p.given_names into v_name
      from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
      insert into notification (kind, params, link, recipient_user, created_by)
      values ('rx_part_given',
              jsonb_build_object('item', item_label(v_m.item_id), 'name', v_name,
                                 'given', coalesce(v_m.quantity_given, 0) + v_give, 'remaining', v_left - v_give,
                                 'quantity', v_whole, 'requestId', v_m.id),
              '/app/visit?encounter=' || v_m.encounter_id, v_to, auth.uid());
    end if;
  end if;
  -- the last line handed over: on to the cashier (money due) or the visit closes
  perform after_pharmacy(v_m.encounter_id);
  perform stock_alert_run();
  return jsonb_build_object('dispenseId', v_dispense, 'charged', v_charged, 'locationId', v_loc,
                            'given', v_give, 'givenTotal', coalesce(v_m.quantity_given, 0) + v_give,
                            'remaining', greatest(v_left - v_give, 0), 'quantity', v_whole);
end
$$;

-- sell_medicine (from 20261126090000_departments_decide_desks): whole packs for a pack-only medicine.
create or replace function sell_medicine(
  p_encounter_id uuid,
  p_item_id uuid,
  p_quantity numeric,
  p_instructions text default null,
  p_location_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  perform assert_desk(array['pharmacy'], 'the pharmacy');
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'the quantity must be more than zero' using errcode = '22023';
  end if;
  if not exists (select 1 from item where id = p_item_id and deleted_at is null) then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  -- 0107: a medicine sold only by the whole pack: whole packs
  perform assert_whole_packs(p_item_id, p_quantity);
  insert into medication_request (encounter_id, item_id, quantity, instructions, supply, prescriber_id)
  values (p_encounter_id, p_item_id, p_quantity,
          coalesce(nullif(trim(coalesce(p_instructions, '')), ''), 'Pharmacy sale'), 'pharmacy', auth.uid())
  returning id into v_id;
  return dispense_prescription(v_id, p_location_id) || jsonb_build_object('requestId', v_id);
end
$$;

-- ---------------------------------------------------------------- walk-in buyers
-- create_counter_sale (from 20261214090000_packs_and_pieces): priced by how the medicine is sold;
-- the line keeps its pieces (quantity), the whole packs and their price, and the pack size.
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
    -- 0107: how the medicine is sold (whole packs only: whole packs)
    perform assert_whole_packs(v_line.item_id, v_line.quantity);
    -- never sold from expired stock
    v_usable := usable_stock(v_line.item_id, v_loc);
    if v_usable < v_line.quantity then
      raise exception 'only % of % (not expired) in the pharmacy', v_usable, item_label(v_line.item_id)
        using errcode = '23514', hint = 'short';
    end if;
    -- priced by how it is sold: whole packs at the pack price, pieces at the piece price
    select * into v_pk from price_quantity(v_line.item_id, v_line.quantity, round(v_price), true);
    insert into counter_sale_line (sale_id, item_id, quantity, unit_price, line_total, packs, pack_price, pack_size)
    values (v_id, v_line.item_id, v_line.quantity, round(v_price), v_pk.total,
            case when v_pk.packs > 0 then v_pk.packs end, case when v_pk.packs > 0 then v_pk.pack_price end,
            v_pk.pack_size);
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

-- counter_sales (from 20261214090000_packs_and_pieces): how it is sold, the pack word, the pieces.
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
          'packSize', coalesce(x.pack_size, i.pack_size), 'packs', x.packs, 'packPrice', x.pack_price,
          'byPack', x.packs is not null,
          -- 0107: how it is sold, the pack word, the pieces beside the whole packs
          'saleMode', i.sale_mode, 'packUnit', i.pack_unit,
          'pieces', x.quantity - coalesce(x.packs, 0) * coalesce(x.pack_size, i.pack_size, 1),
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

-- ---------------------------------------------------------------- the readers say how it is sold
-- pharmacy_queue (from 20261214090000_packs_and_pieces): saleMode, packUnit, due (what is given
-- by default: whole packs for a pack-only medicine), restPieces; priced with price_quantity.
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
           cov.pct,
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
    left join lateral (select pf.price, pf.fallback from price_for(null, m.item_id, inv.payer_id) pf) pp on true
    left join lateral (select coalesce(coverage_pct_for((select c.plan_id from coverage c where c.id = inv.coverage_id),
                                                        'pharmacy'::service_group), 0) as pct) cov on true
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
    coalesce(jsonb_agg(jsonb_build_object(
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

-- stock_overview (from 20261214090000_packs_and_pieces): saleMode and packUnit.
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
      'saleMode', i.sale_mode, 'packUnit', i.pack_unit,
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

-- stock_alerts (from 20261214090000_packs_and_pieces): the pack word of a low medicine.
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
                                          'unit', (select selling_unit from item where id = r.item_id),
                                          'packUnit', (select pack_unit from item where id = r.item_id))
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

-- store_stock (from 20261207090000_pharmacy_simplified): saleMode, packUnit, packPrice.
create or replace function store_stock(p_location_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_l stock_location%rowtype;
  v_admin boolean := stock_admin();
  v_items jsonb;
  v_incoming jsonb;
begin
  select * into v_l from stock_location where id = p_location_id and deleted_at is null;
  if not found or v_l.type::text = 'transit' then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if not may_see_store(p_location_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'itemId', i.id, 'item', i.name_generic || coalesce(' ' || i.strength, ''), 'code', i.code,
      'unit', i.selling_unit, 'packSize', i.pack_size,
      'saleMode', i.sale_mode, 'packUnit', i.pack_unit, 'packPrice', i.pack_price,
      -- 0107: the usable stock at selling price (whole packs at the pack price)
      'sellValue', round(sell_value(coalesce(t.usable, 0), (select pf.price from price_for(null, i.id, null) pf),
                                    i.pack_price, i.pack_size, i.sale_mode)),
      'onHand', coalesce(t.on_hand, 0), 'usable', coalesce(t.usable, 0), 'expired', coalesce(t.expired, 0),
      'expiringSoon', coalesce(t.expiring, 0), 'earliestExpiry', t.next_expiry,
      'minLevel', m.min_level, 'low', m.min_level is not null and coalesce(t.usable, 0) < m.min_level,
      'price', (select pf.price from price_for(null, i.id, null) pf),
      'value', case when v_admin then coalesce(t.value, 0) end,
      'batches', coalesce(t.batches, '[]'::jsonb)
    ) order by i.name_generic), '[]'::jsonb)
  into v_items
  from item i
  left join store_item_level m on m.location_id = p_location_id and m.item_id = i.id
  left join lateral (
    select sum(s.quantity)::integer as on_hand,
           sum(s.quantity) filter (where s.expiry is null or s.expiry >= current_date)::integer as usable,
           sum(s.quantity) filter (where s.expiry < current_date)::integer as expired,
           sum(s.quantity) filter (where s.expiry between current_date and current_date + stock_expiry_days())::integer as expiring,
           min(s.expiry) filter (where s.expiry >= current_date) as next_expiry,
           sum(s.quantity * coalesce(b.unit_cost, 0)) as value,
           jsonb_agg(jsonb_build_object('batchId', s.batch_id, 'batchNo', b.batch_no, 'expiry', s.expiry,
                                        'quantity', s.quantity, 'expired', s.expiry < current_date,
                                        'unitCost', case when v_admin then b.unit_cost end)
                     order by s.expiry nulls last) as batches
    from stock_on_hand s left join batch b on b.id = s.batch_id
    where s.item_id = i.id and s.location_id = p_location_id and s.quantity > 0
  ) t on true
  where i.deleted_at is null and (t.on_hand is not null or m.min_level is not null);

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'number', t.number, 'direction', t.direction, 'sentAt', t.sent_at,
      'from', lf.name, 'to', lt.name,
      'lines', (select count(*) from stock_transfer_line x where x.transfer_id = t.id)::integer,
      'units', (select coalesce(sum(x.quantity), 0) from stock_transfer_line x where x.transfer_id = t.id)::integer
    ) order by t.sent_at), '[]'::jsonb)
  into v_incoming
  from stock_transfer t
  join stock_location lf on lf.id = t.from_location_id
  join stock_location lt on lt.id = t.to_location_id
  where t.status = 'in_transit' and (t.to_location_id = p_location_id or t.from_location_id = p_location_id);

  return jsonb_build_object(
    'store', jsonb_build_object('id', v_l.id, 'name', v_l.name, 'type', v_l.type, 'active', v_l.active,
                                'isMain', v_l.is_main, 'isRoom', is_room_type(v_l.type),
                                'holders', store_holders(v_l.id)),
    'held', holds_store(auth.uid(), v_l.id),
    -- count and write off: the holders (room store) or the pharmacy (pharmacy and main stores); the manager
    'canManage', is_manager() or case when is_room_type(v_l.type) then holds_store(auth.uid(), v_l.id)
                                       else stock_manager() end,
    'items', v_items,
    'onTheWay', v_incoming,
    'sellValue', (select coalesce(sum((x ->> 'sellValue')::numeric), 0) from jsonb_array_elements(v_items) x),
    'value', case when v_admin then (select coalesce(sum(s.quantity * coalesce(b.unit_cost, 0)), 0)
                                     from stock_on_hand s left join batch b on b.id = s.batch_id
                                     where s.location_id = p_location_id and s.quantity > 0) end
  );
end
$$;

-- ---------------------------------------------------------------- add stock: the package and how it is sold
-- add_stock (from 20261214090000_packs_and_pieces): a line may say sale_mode (piece, pack, both),
-- pack_size, pack_unit, sell_price (the piece), pack_price, and pack_cost (the cost of one pack).
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
  v_mode text;
  v_pack_price numeric;
  v_pack_unit text;
  v_pack_cost numeric;
  v_unit text;
  v_size integer;
  v_cur record;
  v_packaging boolean;
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
      v_packaging := false;
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
      -- 0107: the line may say the package and how it is sold (sale_mode: piece, pack or both),
      -- the pack price and the pack word; and the cost of one pack instead of one piece
      v_mode := nullif(trim(coalesce(v_line ->> 'sale_mode', '')), '');
      v_pack_price := nullif(v_line ->> 'pack_price', '')::numeric;
      v_pack_unit := nullif(trim(coalesce(v_line ->> 'pack_unit', '')), '');
      v_pack_cost := nullif(v_line ->> 'pack_cost', '')::numeric;
      v_unit := nullif(trim(coalesce(v_line ->> 'unit', '')), '');
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
      -- 0107: the package and how it is sold, said on the line: a new item takes them; an item
      -- already known changes only for a person with the price right (else they are left as they
      -- are and the line says so)
      if v_mode is not null then
        select i.pack_size, i.sale_mode, i.pack_price, i.pack_unit, i.selling_unit,
               (select pf.price from price_for(null, i.id, null) pf) as price
        into v_cur from item i where i.id = v_item;
        if v_created
           or coalesce(case when coalesce(v_pack, 1) >= 2 then v_pack end, 0)
                is distinct from coalesce(case when coalesce(v_cur.pack_size, 1) >= 2 then v_cur.pack_size end, 0)
           or v_mode is distinct from v_cur.sale_mode
           or (v_mode <> 'piece' and round(v_pack_price) is distinct from v_cur.pack_price)
           or (v_mode <> 'pack' and v_sell is not null and round(v_sell) is distinct from v_cur.price)
           or (v_pack_unit is not null and coalesce(v_pack, 1) >= 2 and v_pack_unit is distinct from v_cur.pack_unit)
           or (v_unit is not null and v_unit is distinct from v_cur.selling_unit) then
          if v_created or v_price_right then
            perform apply_item_packaging(v_item, v_pack, v_mode,
                                         case when v_mode = 'pack' then null else coalesce(v_sell, v_cur.price) end,
                                         v_pack_price, v_unit, v_pack_unit);
            v_updated := true;
            v_packaging := true;
          else
            v_ignored := true;
          end if;
        end if;
        -- the price was said with the package
        v_sell := null;
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
      -- 0107: the cost of one pack: the cost of one piece is that / the pieces in one pack
      v_size := (select case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end from item i where i.id = v_item);
      if v_pack_cost is not null then
        if v_pack_cost < 0 then
          raise exception 'the cost per unit must be zero or more' using errcode = '22023';
        end if;
        if v_size is null then
          raise exception 'say how many units are in one box' using errcode = '22023', hint = 'pack_size';
        end if;
        v_cost := v_pack_cost / v_size;
      end if;
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
      v_line_cost := case when v_pack_cost is not null then round(v_pack_cost * v_units / v_size, 2)
                          else round(round(v_cost, 2) * v_units, 2) end;
      insert into goods_receipt_line (receipt_id, item_id, batch_id, batch_no, expiry, unit, packs, pack_size, units,
                                      unit_cost, pack_cost, line_cost)
      select v_id, v_item, b.id, b.batch_no, b.expiry,
             case when v_pack_cost is not null and v_units % v_size = 0 then 'box' else 'unit' end,
             case when v_pack_cost is not null and v_units % v_size = 0 then v_units / v_size else v_units end,
             case when v_pack_cost is not null and v_units % v_size = 0 then v_size else 1 end,
             v_units, round(v_cost, 2), case when v_pack_cost is not null then round(v_pack_cost, 2) end, v_line_cost
      from batch b where b.id = v_batch;
      v_total := v_total + v_line_cost;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'item_id', v_item, 'batch_id', v_batch, 'quantity', v_units, 'line_cost', v_line_cost,
        'created', v_created, 'price_updated', v_updated, 'price_ignored', v_ignored,
        'pack_size', (select pack_size from item where id = v_item),
        'sale_mode', (select sale_mode from item where id = v_item), 'packaging_updated', v_packaging));
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

-- ---------------------------------------------------------------- moving stock between stores, in packs or pieces
-- Frank (owner): each line of a transfer note (pharmacy → room store), a refill request and its
-- fulfilment, and a return note says its quantity in packs or pieces as the medicine is packed
-- ("4 boxes of 8", "30 tablets"), and keeps the value at the time: the cost and the selling price,
-- so the note says "4 boxes of 8 (32 tablets) · cost … · value at selling price …" with totals.
--
--   * The quantity stays in pieces (stock_transfer_line.quantity, as before). Each line keeps, as
--     they were when it was written: unit_cost (already), unit_price (the piece's cash price),
--     pack_size, pack_price and sale_mode, and in_packs (typed in packs). A trigger fills them.
--   * A note line may say mode = 'packs' | 'pieces' and split = true. A medicine sold only by the
--     whole pack goes in whole packs; "split a pack" (pieces) only for the pharmacy (or the
--     manager). A return to the pharmacy may send loose pieces (what is left of an opened pack).
--   * The value at selling price: whole packs at the pack price (pack and both), the pieces left at
--     the piece price (a pack-only medicine: the pack price / pieces in one) — sell_value.
alter table stock_transfer_line add column if not exists unit_price numeric(12, 0);
alter table stock_transfer_line add column if not exists pack_price numeric(12, 0);
alter table stock_transfer_line add column if not exists pack_size integer;
alter table stock_transfer_line add column if not exists sale_mode text;
alter table stock_transfer_line add column if not exists in_packs boolean not null default false;

-- What p_q pieces are worth at selling price, with the prices given (a line's, or an item's).
create or replace function sell_value(p_q numeric, p_unit_price numeric, p_pack_price numeric, p_pack_size integer,
                                      p_mode text)
returns numeric
language sql immutable
as $$
  select case
    when p_mode in ('pack', 'both') and coalesce(p_pack_size, 1) >= 2 and p_pack_price is not null then
      floor(coalesce(p_q, 0) / p_pack_size) * p_pack_price
      + (coalesce(p_q, 0) - floor(coalesce(p_q, 0) / p_pack_size) * p_pack_size)
        * case when p_mode = 'pack' then p_pack_price / p_pack_size else coalesce(p_unit_price, 0) end
    else coalesce(p_q, 0) * coalesce(p_unit_price, 0) end
$$;

-- The lines of a note in packs: a pack-only medicine in whole packs (split: the pharmacy only,
-- unless p_pieces_ok, a return); the medicines typed in packs are remembered for the lines
-- written next in this transaction (the snapshot trigger reads them).
create or replace function note_packs(p_lines jsonb, p_pieces_ok boolean default false)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_x jsonb;
  v_item uuid;
  v_q numeric;
  v_mode text;
  v_size integer;
  v_packs jsonb := '[]'::jsonb;
begin
  if p_lines is not null and jsonb_typeof(p_lines) = 'array' then
    for v_x in select x.value from jsonb_array_elements(p_lines) x loop
      continue when jsonb_typeof(v_x) <> 'object'
                 or coalesce(v_x ->> 'itemId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
      v_item := (v_x ->> 'itemId')::uuid;
      v_q := case when coalesce(v_x ->> 'quantity', '') ~ '^\s*\d+(\.\d+)?\s*$' then (v_x ->> 'quantity')::numeric end;
      if coalesce(v_x ->> 'mode', '') = 'packs' then
        v_packs := v_packs || to_jsonb(v_item::text);
      end if;
      select i.sale_mode, i.pack_size into v_mode, v_size from item i where i.id = v_item;
      if not coalesce(p_pieces_ok, false) and v_mode = 'pack' and coalesce(v_size, 1) >= 2 and v_q is not null
         and v_q > 0 and (v_q <> trunc(v_q) or (v_q::integer % v_size) <> 0) then
        if coalesce(v_x ->> 'split', '') = 'true' then
          if not stock_admin() then
            raise exception 'only the pharmacy opens a pack of %: send whole packs', item_label(v_item)
              using errcode = '42501', hint = 'split_pack';
          end if;
        else
          perform assert_whole_packs(v_item, v_q);
        end if;
      end if;
    end loop;
  end if;
  perform set_config('mmc.note_packs', v_packs::text, true);
end
$$;

-- Each line of a note keeps the prices and the package of its medicine as they were.
create or replace function stock_transfer_line_snapshot()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_size integer;
  v_pack numeric;
  v_mode text;
  v_typed text := nullif(current_setting('mmc.note_packs', true), '');
begin
  select case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end, i.pack_price, i.sale_mode
  into v_size, v_pack, v_mode from item i where i.id = new.item_id;
  new.pack_size := coalesce(new.pack_size, v_size);
  new.sale_mode := coalesce(new.sale_mode, v_mode, 'piece');
  new.pack_price := coalesce(new.pack_price, case when new.sale_mode <> 'piece' then v_pack end);
  new.unit_price := coalesce(new.unit_price, (select pf.price from price_for(null, new.item_id, null) pf));
  new.in_packs := coalesce(new.in_packs, false)
                  or (v_typed is not null and v_size is not null and v_typed::jsonb ? new.item_id::text);
  return new;
end
$$;
drop trigger if exists trg_stock_transfer_line_snapshot on stock_transfer_line;
create trigger trg_stock_transfer_line_snapshot before insert on stock_transfer_line
  for each row execute function stock_transfer_line_snapshot();
-- the notes written before: today's prices and package (the value at the time was not kept)
update stock_transfer_line l
set pack_size = case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end,
    sale_mode = i.sale_mode,
    pack_price = case when i.sale_mode <> 'piece' then i.pack_price end,
    unit_price = (select pf.price from price_for(null, i.id, null) pf)
from item i
where i.id = l.item_id and l.unit_price is null and l.sale_mode is null;


-- send_to_room (from 20261128090000_switches_enforced): lines in whole packs (the pharmacy may split).
create or replace function send_to_room(
  p_location_id uuid, p_lines jsonb, p_request_id uuid default null, p_note text default null,
  p_from_location_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_to stock_location%rowtype;
  v_from uuid := coalesce(p_from_location_id, main_pharmacy());
  v_r store_request%rowtype;
  v_id uuid;
  v_number text;
  v_line record;
begin
  if not stock_manager() then
    perform assert_stock_write();
    raise exception 'only the pharmacy (or the manager) sends stock to a room store' using errcode = '42501';
  end if;
  select * into v_to from stock_location where id = p_location_id and deleted_at is null and active;
  if not found or not is_room_type(v_to.type) then
    raise exception 'choose an open room store' using errcode = '22023', hint = 'not_room_store';
  end if;
  -- nobody would be told or could confirm it: the manager assigns a holder first
  if not exists (select 1 from stock_location_holder where location_id = p_location_id and deleted_at is null) then
    raise exception 'this room store has no holder yet: the manager assigns one first'
      using errcode = '22023', hint = 'no_holder';
  end if;
  if v_from is null or not exists (select 1 from stock_location where id = v_from and type = 'pharmacy' and active
                                   and deleted_at is null) then
    raise exception 'room stores are supplied from an open pharmacy store' using errcode = '22023';
  end if;
  if p_request_id is not null then
    select * into v_r from store_request where id = p_request_id and deleted_at is null for update;
    if not found or v_r.status <> 'open' then
      raise exception 'this request is no longer open' using errcode = 'P0002';
    end if;
    if v_r.location_id <> p_location_id then
      raise exception 'this request is for another store' using errcode = '22023';
    end if;
  end if;
  -- 0107: a pack-only medicine in whole packs (the pharmacy may split a pack); typed packs kept
  perform note_packs(p_lines, false);
  v_number := day_number('T', 'transfer');
  insert into stock_transfer (number, direction, from_location_id, to_location_id, request_id, note)
  values (v_number, 'to_room', v_from, p_location_id, p_request_id, nullif(trim(coalesce(p_note, '')), ''))
  returning id into v_id;
  for v_line in select * from note_lines(p_lines) loop
    if not exists (select 1 from item where id = v_line.item_id and deleted_at is null) then
      raise exception 'medicine not found' using errcode = 'P0002';
    end if;
    perform transfer_out(v_id, v_from, v_line.item_id, v_line.quantity, false);
  end loop;
  if p_request_id is not null then
    update store_request set status = 'fulfilled', transfer_id = v_id, decided_by = auth.uid(), decided_at = now()
    where id = p_request_id;
  end if;
  perform notify_holders(p_location_id, 'transfer_sent',
                         jsonb_build_object('number', v_number, 'store', v_to.name, 'transferId', v_id,
                                            'lines', (select count(distinct item_id) from stock_transfer_line where transfer_id = v_id),
                                            'by', (select full_name from profiles where id = auth.uid())),
                         '/app/stock?tab=mine&store=' || p_location_id || '&note=' || v_id);
  return transfer_note_totals(v_id);
end
$$;

-- request_refill (from 20261124090000_stores_and_stock): whole packs; the lines keep how they were typed.
create or replace function request_refill(p_location_id uuid, p_lines jsonb, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_lines jsonb;
  v_bad integer;
  v_id uuid;
  v_number text;
begin
  select name into v_name from stock_location where id = p_location_id and deleted_at is null and active and is_room_type(type);
  if v_name is null then
    raise exception 'choose an open room store' using errcode = '22023', hint = 'not_room_store';
  end if;
  if not (is_manager() or holds_store(auth.uid(), p_location_id)) then
    raise exception 'only the people who hold this store ask for its refill' using errcode = '42501', hint = 'not_holder';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'add at least one medicine' using errcode = '22023';
  end if;
  select count(*) into v_bad from jsonb_array_elements(p_lines) x
  where nullif(x ->> 'itemId', '') is null or coalesce(nullif(x ->> 'quantity', '')::numeric, 0) <= 0
     or (x ->> 'quantity')::numeric <> round((x ->> 'quantity')::numeric)
     or not exists (select 1 from item i where i.id = (x ->> 'itemId')::uuid and i.deleted_at is null);
  if v_bad > 0 then
    raise exception 'each line needs a medicine and a whole quantity above zero' using errcode = '22023';
  end if;
  -- 0107: a pack-only medicine is asked in whole packs; the request keeps how it was typed
  perform note_packs(p_lines, false);
  select jsonb_agg(jsonb_build_object('itemId', y.item_id, 'quantity', y.q, 'mode', y.mode) order by y.item_id)
  into v_lines
  from (select (x ->> 'itemId')::uuid as item_id, sum((x ->> 'quantity')::integer)::integer as q,
               case when bool_or(x ->> 'mode' = 'packs') then 'packs' else 'pieces' end as mode
        from jsonb_array_elements(p_lines) x group by 1) y;
  v_number := day_number('RQ', 'store-request');
  insert into store_request (number, location_id, lines, note)
  values (v_number, p_location_id, v_lines, nullif(trim(coalesce(p_note, '')), ''))
  returning id into v_id;
  insert into notification (kind, params, link, recipient_stations, created_by)
  values ('refill_requested', jsonb_build_object('number', v_number, 'store', v_name, 'storeId', p_location_id,
                                                 'lines', jsonb_array_length(v_lines),
                                                 'by', (select full_name from profiles where id = auth.uid())),
          '/app/stock?tab=rooms&request=' || v_id, array['pharmacy'::station], auth.uid());
  return jsonb_build_object('id', v_id, 'number', v_number, 'lines', jsonb_array_length(v_lines));
end
$$;

-- return_to_pharmacy (from 20261124090000_stores_and_stock): loose pieces may come back.
create or replace function return_to_pharmacy(p_location_id uuid, p_lines jsonb default null, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_from stock_location%rowtype;
  v_to uuid := main_pharmacy();
  v_id uuid;
  v_number text;
  v_line record;
  v_lines jsonb := p_lines;
begin
  select * into v_from from stock_location where id = p_location_id and deleted_at is null;
  if not found or not is_room_type(v_from.type) then
    raise exception 'choose a room store' using errcode = '22023', hint = 'not_room_store';
  end if;
  if not (is_manager() or holds_store(auth.uid(), p_location_id)) then
    raise exception 'only the people who hold this store (or the manager) send its stock back' using errcode = '42501', hint = 'not_holder';
  end if;
  if v_to is null then
    raise exception 'no open pharmacy store to send it to' using errcode = 'P0002';
  end if;
  if v_lines is null then
    -- everything the store holds
    select jsonb_agg(y.x) into v_lines from (
      select jsonb_build_object('itemId', s.item_id, 'quantity', sum(s.quantity)) as x
      from stock_on_hand s where s.location_id = p_location_id and s.quantity > 0 and s.batch_id is not null
      group by s.item_id) y;
    if v_lines is null then
      raise exception 'this store holds nothing to send back' using errcode = '22023';
    end if;
  end if;
  -- 0107: loose pieces may come back (what is left of an opened pack); typed packs kept
  perform note_packs(v_lines, true);
  v_number := day_number('RT', 'transfer-return');
  insert into stock_transfer (number, direction, from_location_id, to_location_id, note)
  values (v_number, 'to_pharmacy', p_location_id, v_to, nullif(trim(coalesce(p_note, '')), ''))
  returning id into v_id;
  for v_line in select * from note_lines(v_lines) loop
    perform transfer_out(v_id, p_location_id, v_line.item_id, v_line.quantity, true);
  end loop;
  insert into notification (kind, params, link, recipient_stations, created_by)
  values ('return_sent', jsonb_build_object('number', v_number, 'store', v_from.name, 'transferId', v_id,
                                            'lines', (select count(distinct item_id) from stock_transfer_line where transfer_id = v_id),
                                            'by', (select full_name from profiles where id = auth.uid())),
          '/app/stock?tab=rooms&note=' || v_id, array['pharmacy'::station], auth.uid());
  return transfer_note_totals(v_id);
end
$$;

-- transfer_note_totals (from 20261124090000_stores_and_stock): the value at selling price.
create or replace function transfer_note_totals(p_transfer_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object('id', t.id, 'number', t.number, 'direction', t.direction, 'status', t.status,
                            'lines', (select count(distinct x.item_id) from stock_transfer_line x where x.transfer_id = t.id)::integer,
                            'units', (select coalesce(sum(x.quantity), 0) from stock_transfer_line x where x.transfer_id = t.id)::integer,
                            'value', (select coalesce(sum(x.quantity * x.unit_cost), 0) from stock_transfer_line x where x.transfer_id = t.id),
                            -- 0107: at selling price, as the lines were written
                            'sellValue', (select round(coalesce(sum(sell_value(x.quantity, x.unit_price, x.pack_price, x.pack_size, x.sale_mode)), 0)) from stock_transfer_line x
                                          where x.transfer_id = t.id))
  from stock_transfer t where t.id = p_transfer_id
$$;

-- transfer_notes (from 20261128090000_switches_enforced): the value at selling price.
create or replace function transfer_notes(
  p_status text default null, p_location_id uuid default null, p_from date default null, p_to date default null
)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.open desc, x.at desc), '[]'::jsonb)
  from (
    select t.status = 'in_transit' as open, t.sent_at as at, jsonb_build_object(
      'id', t.id, 'number', t.number, 'direction', t.direction, 'status', t.status,
      'fromId', t.from_location_id, 'from', lf.name, 'toId', t.to_location_id, 'to', lt.name,
      'sentAt', t.sent_at, 'sentBy', (select full_name from profiles where id = t.created_by),
      'receivedAt', t.confirmed_at, 'receivedBy', (select full_name from profiles where id = t.received_by),
      'cancelledAt', t.cancelled_at, 'cancelledBy', (select full_name from profiles where id = t.cancelled_by),
      'cancelReason', t.cancel_reason, 'note', t.note, 'receiveNote', t.receive_note,
      'requestId', t.request_id, 'requestNumber', (select r.number from store_request r where r.id = t.request_id),
      'hasDifference', t.has_difference,
      'lines', (select count(distinct x.item_id) from stock_transfer_line x where x.transfer_id = t.id)::integer,
      'units', (select coalesce(sum(x.quantity), 0) from stock_transfer_line x where x.transfer_id = t.id)::integer,
      'value', case when stock_admin() then (select coalesce(sum(x.quantity * x.unit_cost), 0)
                                             from stock_transfer_line x where x.transfer_id = t.id) end,
      -- 0107: the value at selling price, as the lines were written
      'sellValue', (select round(coalesce(sum(sell_value(x.quantity, x.unit_price, x.pack_price, x.pack_size, x.sale_mode)), 0)) from stock_transfer_line x
                    where x.transfer_id = t.id and x.deleted_at is null),
      -- what the reader may do with it now
      'canReceive', t.status = 'in_transit' and case when t.direction = 'to_room'
                      then is_manager() or holds_store(auth.uid(), t.to_location_id) else stock_manager() end,
      'canCancel', t.status = 'in_transit' and case when t.direction = 'to_room'
                      then stock_manager() else is_manager() or holds_store(auth.uid(), t.from_location_id) end
    ) as j
    from stock_transfer t
    join stock_location lf on lf.id = t.from_location_id
    join stock_location lt on lt.id = t.to_location_id
    where t.deleted_at is null
      and (p_status is null or t.status = p_status)
      and (p_location_id is null or t.from_location_id = p_location_id or t.to_location_id = p_location_id)
      and (p_from is null or (t.sent_at at time zone 'Africa/Kigali')::date >= p_from)
      and (p_to is null or (t.sent_at at time zone 'Africa/Kigali')::date <= p_to)
      and (stock_admin() or holds_store(auth.uid(), t.from_location_id) or holds_store(auth.uid(), t.to_location_id))
    order by t.sent_at desc
    limit 300
  ) x
$$;

-- transfer_note (from 20261124090000_stores_and_stock): each line says its package and its prices.
create or replace function transfer_note(p_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_t stock_transfer%rowtype;
  v_admin boolean := stock_admin();
  v_head jsonb;
begin
  select * into v_t from stock_transfer where id = p_id and deleted_at is null;
  if not found then
    raise exception 'transfer note not found' using errcode = 'P0002';
  end if;
  if not (v_admin or holds_store(auth.uid(), v_t.from_location_id) or holds_store(auth.uid(), v_t.to_location_id)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_head := jsonb_build_object(
    'id', v_t.id, 'number', v_t.number, 'direction', v_t.direction, 'status', v_t.status,
    'fromId', v_t.from_location_id, 'toId', v_t.to_location_id,
    'from', (select name from stock_location where id = v_t.from_location_id),
    'to', (select name from stock_location where id = v_t.to_location_id),
    'sentAt', v_t.sent_at, 'sentBy', (select full_name from profiles where id = v_t.created_by),
    'receivedAt', v_t.confirmed_at, 'receivedBy', (select full_name from profiles where id = v_t.received_by),
    'cancelledAt', v_t.cancelled_at, 'cancelledBy', (select full_name from profiles where id = v_t.cancelled_by),
    'cancelReason', v_t.cancel_reason, 'note', v_t.note, 'receiveNote', v_t.receive_note,
    'requestId', v_t.request_id, 'requestNumber', (select r.number from store_request r where r.id = v_t.request_id),
    'hasDifference', v_t.has_difference,
    'value', case when v_admin then (select coalesce(sum(x.quantity * x.unit_cost), 0)
                                     from stock_transfer_line x where x.transfer_id = v_t.id) end,
    -- 0107: the value at selling price, as the lines were written
    'sellValue', (select round(coalesce(sum(sell_value(x.quantity, x.unit_price, x.pack_price, x.pack_size, x.sale_mode)), 0)) from stock_transfer_line x
                  where x.transfer_id = v_t.id and x.deleted_at is null),
    'canReceive', v_t.status = 'in_transit' and case when v_t.direction = 'to_room'
                    then is_manager() or holds_store(auth.uid(), v_t.to_location_id) else v_admin end,
    'canCancel', v_t.status = 'in_transit' and case when v_t.direction = 'to_room'
                   then v_admin else is_manager() or holds_store(auth.uid(), v_t.from_location_id) end);
  return v_head || jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'lineId', l.id, 'itemId', l.item_id, 'item', item_label(l.item_id), 'unit', i.selling_unit,
        'batchId', l.batch_id, 'batchNo', b.batch_no, 'expiry', b.expiry, 'expired', b.expiry < current_date,
        'quantity', l.quantity, 'received', l.received_quantity, 'differenceAction', l.difference_action,
        'differenceReason', l.difference_reason,
        'unitCost', case when v_admin then l.unit_cost end,
        'value', case when v_admin then l.quantity * l.unit_cost end,
        -- 0107: the package and the prices as they were when the line was written
        'packSize', l.pack_size, 'packUnit', i.pack_unit, 'saleMode', l.sale_mode, 'inPacks', l.in_packs,
        'unitPrice', l.unit_price, 'packPrice', l.pack_price,
        'sellValue', round(sell_value(l.quantity, l.unit_price, l.pack_price, l.pack_size, l.sale_mode))
      ) order by i.name_generic, b.expiry)
      from stock_transfer_line l join item i on i.id = l.item_id join batch b on b.id = l.batch_id
      where l.transfer_id = p_id and l.deleted_at is null), '[]'::jsonb));
end
$$;

-- refill_requests (from 20261124090000_stores_and_stock): how each line was typed, the package.
create or replace function refill_requests(p_status text default null, p_location_id uuid default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'number', r.number, 'status', r.status, 'storeId', r.location_id, 'store', l.name,
      'note', r.note, 'at', r.created_at, 'by', (select full_name from profiles where id = r.created_by),
      'mine', r.created_by = auth.uid(),
      'decidedAt', r.decided_at, 'decidedBy', (select full_name from profiles where id = r.decided_by),
      'declineReason', r.decline_reason, 'transferId', r.transfer_id,
      'transferNumber', (select t.number from stock_transfer t where t.id = r.transfer_id),
      'lines', coalesce((select jsonb_agg(jsonb_build_object(
          'itemId', x."itemId", 'item', item_label(x."itemId"), 'unit', i.selling_unit, 'quantity', x.quantity,
          -- 0107: how it was typed and the package
          'mode', coalesce(x.mode, 'pieces'), 'packSize', i.pack_size, 'packUnit', i.pack_unit,
          'saleMode', i.sale_mode,
          'inPharmacy', usable_stock(x."itemId", main_pharmacy()),
          'inStore', usable_stock(x."itemId", r.location_id)
        )) from jsonb_to_recordset(r.lines) as x("itemId" uuid, quantity integer, mode text)
          join item i on i.id = x."itemId"), '[]'::jsonb)
    ) order by (r.status = 'open') desc, r.created_at desc), '[]'::jsonb)
  from store_request r
  join stock_location l on l.id = r.location_id
  where r.deleted_at is null
    and (p_status is null or r.status = p_status)
    and (p_location_id is null or r.location_id = p_location_id)
    and (stock_admin() or holds_store(auth.uid(), r.location_id))
    and (r.status = 'open' or r.created_at > now() - interval '90 days')
$$;

-- ---------------------------------------------------------------- grants
-- (functions replaced with the same arguments keep their grants)
revoke all on function price_quantity(uuid, numeric, numeric, boolean, numeric), rx_due(uuid, integer),
  assert_whole_packs(uuid, numeric),
  apply_item_packaging(uuid, integer, text, numeric, numeric, text, text) from public, anon, authenticated;
revoke all on function set_item_packaging(uuid, integer, text, numeric, numeric, text, text) from public, anon;
grant execute on function set_item_packaging(uuid, integer, text, numeric, numeric, text, text) to authenticated;
revoke all on function note_packs(jsonb, boolean), stock_transfer_line_snapshot(),
  sell_value(numeric, numeric, numeric, integer, text) from public, anon, authenticated;
