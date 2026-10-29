-- 0109 · Walk-in buyers from a room store, only when the manager allows it.
--
-- Frank: a staff member who holds a store (a room store, "My store") may sell a medicine to a
-- walk-in buyer only when the manager has given them that right. Until now only the pharmacy desk
-- sold to walk-in buyers (counter sales, from a pharmacy store).
--
-- * New feature in Settings › Who may do what: "Sell to walk-in buyers from my store"
--   (stock.sell_walkin). No role has it by default (the manager keeps every feature); the manager
--   switches it on for a role or gives it to one person as an exception (0054 mechanism).
-- * may_sell_walkin(store): a pharmacy store → the pharmacy desk or the manager (as before); a room
--   store → the manager, or someone who holds that store AND has stock.sell_walkin.
-- * create_counter_sale accepts a room store under that rule (stock checked in that store, priced
--   by how the medicine is sold, 0107); hand_over_counter_sale, cancel_counter_sale and the list
--   (counter_sales) follow the same rule. take_counter_payment is unchanged in its rights: the seller
--   takes the money only with "Take payments"; otherwise the sale waits at the cashier, and when the
--   cashier takes it the seller (not the pharmacy) is told the medicines can be handed over.

-- ---------------------------------------------------------------- the feature
create or replace function managed_permission(p text)
returns boolean
language sql immutable
as $$
  select p in ('payment.take', 'visit.start', 'vitals.write', 'charge.write', 'clinical.write',
               'orders.write', 'appointment.approve', 'stock.write', 'records.approve', 'stock.sell_walkin')
$$;

insert into role_permissions (role, permission) values ('manager', 'stock.sell_walkin')
on conflict do nothing;

create or replace function my_permissions()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(p), '[]'::jsonb)
  from unnest(array['payment.take', 'visit.start', 'vitals.write', 'charge.write', 'clinical.write',
                    'orders.write', 'appointment.approve', 'stock.write', 'records.approve',
                    'stock.sell_walkin']) as p
  where has_perm(p)
$$;

-- ---------------------------------------------------------------- who may sell from a store
create or replace function may_sell_walkin(p_location_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((
    select case
             when l.type = 'pharmacy' then stock_admin()
             when is_room_type(l.type) then is_manager()
                  or (has_perm('stock.sell_walkin') and holds_store(auth.uid(), l.id))
             else false
           end
    from stock_location l
    where l.id = p_location_id and l.deleted_at is null and l.active
  ), false)
$$;
revoke all on function may_sell_walkin(uuid) from public, anon;
grant execute on function may_sell_walkin(uuid) to authenticated;

-- ---------------------------------------------------------------- the sale
-- create_counter_sale (from 20261217090000_packaging_and_charging): a room store under the rule above.
create or replace function create_counter_sale(
  p_lines jsonb, p_buyer_name text default null, p_buyer_phone text default null,
  p_location_id uuid default null, p_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_loc uuid := coalesce(p_location_id, main_pharmacy());
  v_room boolean;
  v_id uuid;
  v_number text;
  v_line record;
  v_price numeric;
  v_total numeric := 0;
  v_usable integer;
  v_pk record;
begin
  select is_room_type(l.type) into v_room
  from stock_location l
  where l.id = v_loc and l.active and l.deleted_at is null and (l.type = 'pharmacy' or is_room_type(l.type));
  if not found then
    -- nobody sells from a closed or unknown store; the pharmacy desk's message as before
    if not stock_admin() then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    raise exception 'choose an open pharmacy store' using errcode = '22023';
  end if;
  if not may_sell_walkin(v_loc) then
    if v_room then
      raise exception 'you may not sell to walk-in buyers from this store (the manager has not allowed it)'
        using errcode = '42501', hint = 'not_permitted';
    end if;
    raise exception 'not allowed' using errcode = '42501';
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
      if v_room then
        raise exception 'only % of % (not expired) in this store', v_usable, item_label(v_line.item_id)
          using errcode = '23514', hint = 'short';
      end if;
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

-- take_counter_payment (from 20261207090000_pharmacy_simplified): same rights; a room store's sale
-- paid by someone else (the cashier) tells its seller, not the pharmacy.
create or replace function take_counter_payment(
  p_sale_id uuid, p_method payment_method, p_reference text default null, p_payer_phone text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_s counter_sale%rowtype;
  v_year integer := extract(year from now())::integer;
  v_pay uuid;
  v_receipt text;
  v_short text;
  v_room boolean;
begin
  if not (has_perm('payment.take') or pharmacy_takes_money()) then
    raise exception 'you may not take payments (the manager has not allowed it)' using errcode = '42501';
  end if;
  select * into v_s from counter_sale where id = p_sale_id and deleted_at is null for update;
  if not found then
    raise exception 'sale not found' using errcode = 'P0002';
  end if;
  if v_s.status = 'cancelled' then
    raise exception 'this sale was cancelled' using errcode = 'P0002';
  end if;
  if v_s.status <> 'open' then
    raise exception 'this sale is already paid' using errcode = '23505';
  end if;
  if p_method not in ('cash', 'momo', 'airtel', 'card', 'bank') then
    raise exception 'a counter sale is paid in cash, mobile money, card or bank' using errcode = '22023';
  end if;
  if p_method in ('momo', 'airtel', 'card', 'bank') and nullif(trim(coalesce(p_reference, '')), '') is null then
    raise exception 'a transaction reference is required for %', p_method using errcode = '22023';
  end if;
  select is_room_type(l.type) into v_room from stock_location l where l.id = v_s.location_id;
  -- no money for medicines no longer on the shelf
  select string_agg(item_label(l.item_id), ', ') into v_short
  from counter_sale_line l
  where l.sale_id = v_s.id and l.deleted_at is null and usable_stock(l.item_id, v_s.location_id) < l.quantity;
  if v_short is not null then
    if coalesce(v_room, false) then
      raise exception 'no longer enough in this store: %', v_short using errcode = '23514', hint = 'short';
    end if;
    raise exception 'no longer enough in the pharmacy: %', v_short using errcode = '23514', hint = 'short';
  end if;
  if v_s.total > 0 then
    insert into payment (invoice_id, counter_sale_id, method, amount, reference, payer_phone, receipt_no)
    values (null, v_s.id, p_method, v_s.total, nullif(trim(coalesce(p_reference, '')), ''),
            nullif(trim(coalesce(p_payer_phone, '')), ''),
            'RCT-' || v_year || '-' || lpad(next_number('receipt', v_year)::text, 6, '0'))
    returning id, receipt_no into v_pay, v_receipt;
  end if;
  -- the units are the buyer's from now on: they leave the shelf's balance at once, so a hand-over,
  -- another sale or a transfer note cannot take them before the buyer collects
  perform counter_sale_take(v_s.id);
  update counter_sale set status = 'paid', paid_at = now(), payment_id = v_pay where id = v_s.id;
  if coalesce(v_room, false) then
    -- a room store's sale: its seller hands it over (told only when someone else took the money)
    if v_s.created_by is distinct from auth.uid() then
      insert into notification (kind, params, link, recipient_user, created_by)
      values ('counter_sale_paid', jsonb_build_object('number', v_s.number, 'amount', v_s.total, 'buyer', v_s.buyer_name,
                                                      'saleId', v_s.id),
              '/app/stock?tab=mine&sale=' || v_s.id, v_s.created_by, auth.uid());
    end if;
  elsif not pharmacy_takes_money() then
    insert into notification (kind, params, link, recipient_stations, created_by)
    values ('counter_sale_paid', jsonb_build_object('number', v_s.number, 'amount', v_s.total, 'buyer', v_s.buyer_name,
                                                    'saleId', v_s.id),
            '/app/stock?tab=pharmacy&sale=' || v_s.id, array['pharmacy'::station], auth.uid());
  end if;
  return jsonb_build_object('id', v_s.id, 'number', v_s.number, 'status', 'paid', 'amount', v_s.total,
                            'receipt', v_receipt, 'paymentId', v_pay);
end
$$;

-- hand_over_counter_sale (from 20261124090000_stores_and_stock): whoever may sell from the sale's store.
create or replace function hand_over_counter_sale(p_sale_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_s counter_sale%rowtype;
  v_lines jsonb;
begin
  select * into v_s from counter_sale where id = p_sale_id and deleted_at is null for update;
  if not found then
    if not stock_admin() then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    raise exception 'sale not found or cancelled' using errcode = 'P0002';
  end if;
  if not may_sell_walkin(v_s.location_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_s.status = 'cancelled' then
    raise exception 'sale not found or cancelled' using errcode = 'P0002';
  end if;
  if v_s.status = 'open' then
    raise exception 'the buyer pays first, at the cashier' using errcode = '22023', hint = 'not_paid';
  end if;
  if v_s.status = 'handed_over' then
    raise exception 'already handed over' using errcode = '23505';
  end if;
  -- (a sale paid with nothing taken yet, e.g. a free one: taken now)
  if not exists (select 1 from counter_sale_held(v_s.id)) then
    perform counter_sale_take(v_s.id);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('itemId', x.item_id, 'item', item_label(x.item_id),
                                               'quantity', x.quantity, 'batches', x.batches) order by x.item_id), '[]'::jsonb)
  into v_lines
  from (select h.item_id, sum(h.quantity)::integer as quantity,
               jsonb_agg(jsonb_build_object('batchNo', b.batch_no, 'expiry', b.expiry, 'quantity', h.quantity)
                         order by b.expiry asc nulls last) as batches
        from counter_sale_held(v_s.id) h join batch b on b.id = h.batch_id
        group by h.item_id) x;
  update counter_sale set status = 'handed_over', handed_over_at = now(), handed_over_by = auth.uid() where id = v_s.id;
  return jsonb_build_object('id', v_s.id, 'number', v_s.number, 'status', 'handed_over', 'buyer', v_s.buyer_name,
                            'lines', v_lines);
end
$$;

-- cancel_counter_sale (from 20261124090000_stores_and_stock): also the room store's seller.
create or replace function cancel_counter_sale(p_sale_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_s counter_sale%rowtype;
begin
  select * into v_s from counter_sale where id = p_sale_id and deleted_at is null for update;
  if not (stock_admin() or has_perm('payment.take') or (found and may_sell_walkin(v_s.location_id))) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the sale is cancelled' using errcode = '22023';
  end if;
  if v_s.id is null then
    raise exception 'sale not found' using errcode = 'P0002';
  end if;
  if v_s.status <> 'open' then
    raise exception 'only an unpaid sale is cancelled (a payment is cancelled at the cashier first)' using errcode = '23505';
  end if;
  update counter_sale set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = trim(p_reason)
  where id = v_s.id;
end
$$;

-- counter_sales (from 20261217090000_packaging_and_charging): a room store's seller sees the sales of
-- the stores they hold.
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
      'roomStore', is_room_type(l.type),
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
    and (stock_admin() or has_perm('payment.take') or has_perm('billing.read')
         or (has_perm('stock.sell_walkin') and holds_store(auth.uid(), s.location_id)))
    and (p_status is null or s.status = p_status)
    and ((p_from is null and (s.status in ('open', 'paid') or s.created_at > now() - interval '7 days'))
         or (p_from is not null and (s.created_at at time zone 'Africa/Kigali')::date between p_from and coalesce(p_to, p_from)))
$$;
