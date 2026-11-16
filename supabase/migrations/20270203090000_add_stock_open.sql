-- 0177: the same Add stock form for every medicine, for everyone who adds stock.
--
-- The owner (2026-11-16): a known medicine must not get a different, locked form: the delivery
-- may come packed or priced differently. Whoever may add stock (stock_manager: the manager, the
-- pharmacy desk with "Manage stock", so the keeper too) now sets the package and the prices with
-- the delivery; nothing is silently kept.

-- ---------------------------------------------------------------- add_stock (from 20270130090000_lists_as_one)
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
  v_list_detail text;
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
  -- 0177: whoever may add stock sets the package and the prices with the delivery (the owner:
  -- the same form for every line, a delivery may come packed or priced differently)
  v_price_right boolean := has_perm('item_price.write') or has_perm('catalogue.write') or stock_manager();
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
            -- 0172: a medicine of an uploaded price list (the Ministry's, RSSB's, an insurer's):
            -- the item takes the line's code, so that list prices it
            select l.detail into v_list_detail
            from tariff_book b
            join tariff_version v on v.id = tariff_version_at(b.id, current_date)
            join tariff_line l on l.version_id = v.id and l.removed_at is null and l.code = tariff_code_norm(v_code)
            where b.kind = 'medicines' and b.deleted_at is null
            order by b.priority, b.created_at
            limit 1;
            if not found then
              raise exception 'this medicine is on no list' using errcode = 'P0002';
            end if;
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
                            name_brand = coalesce(v_ref.presentation, v_list_detail), source = coalesce(v_ref.source, source)
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
