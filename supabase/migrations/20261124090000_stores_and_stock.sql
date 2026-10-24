-- 0083 · Stores and stock: the pharmacy is the main store; room stores held by named staff.
--
-- Frank's decision: "the main store will be the pharmacy where all medicines and product supplies
-- are stored and received, recorded from"; some medicines must be in a doctor's office (or a
-- department) so they give them themselves: the pharmacist sends them physically and in the
-- system; the manager decides who holds such a store; those people get "My store" in their system.
--
--   * B  THE PHARMACY IS THE MAIN STORE. Every delivery from a supplier is received into a pharmacy
--        store (the main pharmacy by default): receive_delivery (a goods received note GRN-YYMMDD-NNN
--        with several lines, boxes or units, its own cost per line). receive_stock keeps working,
--        for pharmacy stores (and the lab's own store for its reagents). No new main_store can be
--        created; an existing one keeps its stock and history, sends it to the pharmacy
--        (transfer_stock) and is then closed.
--   * C  ROOM STORES. The manager creates them (type room, or nursing / lab / theatre), names them,
--        and assigns who holds them: named staff and/or whole departments (stock_location_holder).
--        Only the manager creates, renames, assigns, closes (empty, no note on the way) and reopens
--        them. my_stores(): the stores the caller holds ("My store").
--   * D  SUPPLYING A ROOM STORE. The holder asks for a refill (request_refill, RQ-YYMMDD-NNN; the
--        pharmacy is told). The pharmacy sends (send_to_room): a transfer note T-YYMMDD-NNN, batches
--        earliest expiry first, never expired; the units leave the pharmacy at once and are "on the
--        way" (the system store "In transit", type transit) until the holder confirms receipt
--        (confirm_receipt: all, or line by line with the quantity received; a difference goes back
--        to the pharmacy or is a loss, with its reason; the manager and the pharmacy are told). The
--        pharmacy cancels a note not yet received (cancel_transfer: the units come back). The holder
--        returns stock with a return note RT-YYMMDD-NNN (return_to_pharmacy), confirmed by the
--        pharmacy the same way.
--   * E  USING A ROOM STORE. "Given here" (prescribe, supply room) takes only from a store the
--        prescriber holds (the one chosen, else their own: personal first, then their department's),
--        unexpired, earliest expiry first; nobody else may give here (the manager may, from any room
--        store). Holders count their store and write stock off with a reason; the pharmacy and the
--        manager see every store (room_store_summary, store_stock, stock_movements).
--   * F  VISIBILITY. The pharmacy (stock.dispense) and the manager see every store; others see the
--        stores they hold.
--   * BATCH-1  a batch number already received with another expiry is refused; each receipt keeps
--        its own cost (a cost layer: batch rows per (medicine, batch number, cost), and the cost on
--        the receipt movement); an expiry date in the past and a closed store are refused.
--   * RIGHTS-2 pharmacy and main stores: received, sent, counted, written off, closed and opened by
--        the pharmacy (stock.dispense) or the manager; room stores: counted, written off and given
--        from by their holders; the lab keeps its lab store (holders with stock.write receive).
--   * STORE-2  stock_overview lists every store (closed ones too, with active, type, isMain, holders).
--   * CAT-1    delete_item refuses a medicine that still has stock (switch it off instead).
--   * ALERT-1  low = unexpired units in the pharmacy at or below the reorder level; per room store an
--        optional minimum (set_store_min); expiring (today..+90 days) apart from expired; the
--        pharmacy is told once when a medicine falls to its level, the holders when their store
--        falls below its minimum (stock_alerts lists them all).
--   * REORDER  reorder_suggestions(): what to order, up to item.max_level (set_reorder_level), with
--        the last supplier, the last cost and the average use per month (90 days).
--   * COUNTER SALE  a walk-in buyer without a visit pays FIRST (S-YYMMDD-NNN): create_counter_sale
--        (pharmacy, cash prices), take_counter_payment (cashier: a payment with its receipt, counted
--        in the cash count and cashier_summary), hand_over_counter_sale (pharmacy, earliest expiry
--        first, never expired), cancel_counter_sale while unpaid.
--   * room_store_summary(store, from, to): stock value, given to patients, received, returned, losses.
--
-- Errcodes: 42501 not allowed (hint not_holder / no_room_store where it helps), 22023 bad input
-- (hints: not_room_store, receive_into_pharmacy, use_transfer_note, no_main_store, batch_expiry,
-- expired_date, store_closed, no_price, not_paid, difference_reason), 23514 not enough stock / store
-- not empty (hints: short, store_has_stock, notes_in_transit), 23505 already done (hint
-- duplicate_delivery for a delivery note already entered), P0002 not found.
--
-- Note on enum values: 'room' and 'transit' are added here; nothing in this file uses them as
-- values (the "In transit" store is created the first time a note is sent), so the file runs in one
-- transaction.

-- ---------------------------------------------------------------- types and columns
alter type stock_location_type add value if not exists 'room';
alter type stock_location_type add value if not exists 'transit';

-- each receipt keeps its own cost: one batch row per (medicine, batch number, cost)
alter table batch drop constraint if exists batch_item_id_batch_no_key;
create unique index if not exists batch_layer_uq on batch (item_id, batch_no, unit_cost) where deleted_at is null;
create index if not exists batch_no_idx on batch (item_id, batch_no);

alter table stock_movement add column if not exists unit_cost numeric(12, 2);
alter table stock_movement add column if not exists goods_receipt_id uuid references goods_receipt (id);

-- ---------------------------------------------------------------- who holds a room store
create table if not exists stock_location_holder (
  like mmc_base including all,
  location_id uuid not null references stock_location (id),
  profile_id uuid references profiles (id) on delete cascade,
  department_id uuid references department (id) on delete cascade,
  check ((profile_id is null) <> (department_id is null))
);
create unique index if not exists stock_location_holder_person_uq on stock_location_holder (location_id, profile_id)
  where deleted_at is null and profile_id is not null;
create unique index if not exists stock_location_holder_dept_uq on stock_location_holder (location_id, department_id)
  where deleted_at is null and department_id is not null;
select install_common_triggers('stock_location_holder');

-- an optional minimum per room store and medicine (the holders are told when it falls below)
create table if not exists store_item_level (
  location_id uuid not null references stock_location (id),
  item_id uuid not null references item (id),
  min_level integer not null check (min_level > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (location_id, item_id)
);

-- a low-stock notice is sent once, until the stock is back above the level
create table if not exists low_stock_flag (
  item_id uuid not null references item (id),
  scope text not null,              -- 'pharmacy' or the room store's id
  flagged_at timestamptz not null default now(),
  primary key (item_id, scope)
);

-- ---------------------------------------------------------------- refill requests and transfer notes
create table if not exists store_request (
  like mmc_base including all,
  number text not null unique,
  location_id uuid not null references stock_location (id),
  status text not null default 'open' check (status in ('open', 'fulfilled', 'declined', 'cancelled')),
  lines jsonb not null default '[]'::jsonb,   -- [{ itemId, quantity }]
  note text,
  decided_by uuid references profiles (id) on delete set null,
  decided_at timestamptz,
  decline_reason text,
  transfer_id uuid
);
create index if not exists store_request_status_idx on store_request (status, location_id);
select install_common_triggers('store_request');

create table if not exists stock_transfer (
  like mmc_base including all,
  number text not null unique,
  direction text not null check (direction in ('to_room', 'to_pharmacy')),
  from_location_id uuid not null references stock_location (id),
  to_location_id uuid not null references stock_location (id),
  status text not null default 'in_transit' check (status in ('in_transit', 'received', 'cancelled')),
  request_id uuid references store_request (id),
  note text,
  sent_at timestamptz not null default now(),
  received_by uuid references profiles (id) on delete set null,
  confirmed_at timestamptz,
  receive_note text,
  has_difference boolean not null default false,
  cancelled_by uuid references profiles (id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text
);
create index if not exists stock_transfer_status_idx on stock_transfer (status, to_location_id);
create index if not exists stock_transfer_from_idx on stock_transfer (from_location_id);
select install_common_triggers('stock_transfer');

create table if not exists stock_transfer_line (
  like mmc_base including all,
  transfer_id uuid not null references stock_transfer (id) on delete cascade,
  item_id uuid not null references item (id),
  batch_id uuid not null references batch (id),
  quantity integer not null check (quantity > 0),
  unit_cost numeric(12, 2) not null default 0,
  received_quantity integer check (received_quantity >= 0),
  difference_action text check (difference_action in ('returned', 'loss')),
  difference_reason text
);
create index if not exists stock_transfer_line_transfer_idx on stock_transfer_line (transfer_id);
select install_common_triggers('stock_transfer_line');

alter table store_request drop constraint if exists store_request_transfer_fk;
alter table store_request add constraint store_request_transfer_fk foreign key (transfer_id) references stock_transfer (id);
alter table stock_movement add column if not exists stock_transfer_id uuid references stock_transfer (id);
create index if not exists stock_movement_transfer_idx on stock_movement (stock_transfer_id) where stock_transfer_id is not null;

-- ---------------------------------------------------------------- deliveries (goods received notes)
alter table goods_receipt add column if not exists number text;
alter table goods_receipt add column if not exists reference text;
alter table goods_receipt add column if not exists delivered_on date;
alter table goods_receipt add column if not exists location_id uuid references stock_location (id);
alter table goods_receipt add column if not exists supplier_name text;
alter table goods_receipt add column if not exists total_cost numeric(14, 2) not null default 0;
create unique index if not exists goods_receipt_number_uq on goods_receipt (number) where number is not null;

create table if not exists goods_receipt_line (
  like mmc_base including all,
  receipt_id uuid not null references goods_receipt (id) on delete cascade,
  item_id uuid not null references item (id),
  batch_id uuid not null references batch (id),
  batch_no text not null,
  expiry date not null,
  unit text not null check (unit in ('box', 'unit')),
  packs numeric(12, 2) not null,
  pack_size integer not null default 1,
  units integer not null check (units > 0),
  unit_cost numeric(12, 2) not null,
  pack_cost numeric(12, 2),
  line_cost numeric(14, 2) not null
);
create index if not exists goods_receipt_line_receipt_idx on goods_receipt_line (receipt_id);
select install_common_triggers('goods_receipt_line');

-- ---------------------------------------------------------------- counter sales (walk-in, pays first)
create table if not exists counter_sale (
  like mmc_base including all,
  number text not null unique,
  buyer_name text,
  buyer_phone text,
  location_id uuid not null references stock_location (id),
  status text not null default 'open' check (status in ('open', 'paid', 'handed_over', 'cancelled')),
  total numeric(12, 0) not null default 0,
  note text,
  paid_at timestamptz,
  payment_id uuid,
  handed_over_at timestamptz,
  handed_over_by uuid references profiles (id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by uuid references profiles (id) on delete set null,
  cancel_reason text
);
create index if not exists counter_sale_status_idx on counter_sale (status, created_at);
select install_common_triggers('counter_sale');

create table if not exists counter_sale_line (
  like mmc_base including all,
  sale_id uuid not null references counter_sale (id) on delete cascade,
  item_id uuid not null references item (id),
  quantity integer not null check (quantity > 0),
  unit_price numeric(12, 0) not null,
  line_total numeric(12, 0) not null
);
create index if not exists counter_sale_line_sale_idx on counter_sale_line (sale_id);
select install_common_triggers('counter_sale_line');

alter table stock_movement add column if not exists counter_sale_id uuid references counter_sale (id);

-- A payment is for a visit's bill or for a counter sale (the same receipts, the same cash count).
alter table payment alter column invoice_id drop not null;
alter table payment add column if not exists counter_sale_id uuid references counter_sale (id);
alter table payment drop constraint if exists payment_target_ck;
alter table payment add constraint payment_target_ck check ((invoice_id is null) <> (counter_sale_id is null));
-- a visit's bill: cash, MTN MoMo or Airtel Money (as before); a counter sale may also be paid by
-- card or bank transfer (take_counter_payment, with a reference)
alter table payment drop constraint if exists payment_method_accepted;
alter table payment
  add constraint payment_method_accepted
  check (method in ('cash', 'momo', 'airtel') or (counter_sale_id is not null and method in ('card', 'bank'))) not valid;
alter table payment drop constraint if exists payment_method_desk;
alter table payment
  add constraint payment_method_desk
  check (method::text in ('cash', 'momo', 'airtel') or (counter_sale_id is not null and method::text in ('card', 'bank'))) not valid;
alter table counter_sale drop constraint if exists counter_sale_payment_fk;
alter table counter_sale add constraint counter_sale_payment_fk foreign key (payment_id) references payment (id);

-- ---------------------------------------------------------------- rights on the tables
-- Read with stock.read (the functions are the way in); written only by the checked functions.
alter table stock_location_holder enable row level security;
drop policy if exists stock_location_holder_select on stock_location_holder;
create policy stock_location_holder_select on stock_location_holder for select to authenticated
  using (has_perm('stock.read') or profile_id = auth.uid());
alter table store_item_level enable row level security;
drop policy if exists store_item_level_select on store_item_level;
create policy store_item_level_select on store_item_level for select to authenticated using (has_perm('stock.read'));
alter table low_stock_flag enable row level security;
select apply_rls('store_request', 'stock.read', 'stock.write');
select apply_rls('stock_transfer', 'stock.read', 'stock.write');
select apply_rls('stock_transfer_line', 'stock.read', 'stock.write');
select apply_rls('goods_receipt_line', 'stock.read', 'stock.write');
select apply_rls('counter_sale', 'stock.read', 'stock.write');
select apply_rls('counter_sale_line', 'stock.read', 'stock.write');
-- the cashier reads counter sales too (payment.take)
drop policy if exists counter_sale_select_cashier on counter_sale;
create policy counter_sale_select_cashier on counter_sale for select to authenticated using (has_perm('payment.take'));
drop policy if exists counter_sale_line_select_cashier on counter_sale_line;
create policy counter_sale_line_select_cashier on counter_sale_line for select to authenticated using (has_perm('payment.take'));

revoke insert, update, delete on stock_location, stock_location_holder, store_item_level, low_stock_flag,
  store_request, stock_transfer, stock_transfer_line, goods_receipt, goods_receipt_line, counter_sale,
  counter_sale_line from authenticated, anon;
revoke all on low_stock_flag from authenticated, anon;
do $$
declare
  t text;
begin
  foreach t in array array['stock_location', 'store_request', 'stock_transfer', 'stock_transfer_line', 'goods_receipt',
                           'goods_receipt_line', 'counter_sale', 'counter_sale_line'] loop
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('drop policy if exists %I on %I', t || '_delete', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- helpers
-- A store a holder gives from (room, nursing, lab, theatre): not the pharmacy, a main store or the
-- system store "In transit". (Compared as text: the new enum values are not used in this file.)
create or replace function is_room_type(p_type stock_location_type)
returns boolean
language sql immutable
as $$
  select p_type::text not in ('pharmacy', 'main_store', 'transit')
$$;

-- The pharmacy (stock.dispense) or the manager: they see and run every store.
create or replace function stock_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select is_manager() or has_perm('stock.dispense')
$$;

-- Does this person hold the store (named, or through one of their departments)?
create or replace function holds_store(p_staff uuid, p_location uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from stock_location_holder h
    join profiles me on me.id = p_staff and me.active
    where h.location_id = p_location and h.deleted_at is null
      and (h.profile_id = p_staff
           or h.department_id in (select sd.department_id from staff_department sd where sd.profile_id = p_staff))
  )
$$;

-- The caller sees this store (the pharmacy and the manager see all; holders their own).
create or replace function may_see_store(p_location uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select stock_admin() or holds_store(auth.uid(), p_location)
$$;

-- The stores the caller may see (null = every store).
create or replace function visible_stores()
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select case when stock_admin() then null
              else coalesce((select array_agg(l.id) from stock_location l
                             where l.deleted_at is null and holds_store(auth.uid(), l.id)), '{}'::uuid[]) end
$$;

-- A medicine's name as written on notes and labels.
create or replace function item_label(p_item_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select i.name_generic || coalesce(' ' || i.strength, '') from item i where i.id = p_item_id
$$;

-- A number of the day: PREFIX-YYMMDD-NNN (Kigali date; NNN counts per day and series).
create or replace function day_number(p_prefix text, p_series text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_day date := (now() at time zone 'Africa/Kigali')::date;
  v_n integer;
begin
  v_n := next_number(p_series, to_char(v_day, 'YYYYMMDD')::integer);
  return p_prefix || '-' || to_char(v_day, 'YYMMDD') || '-'
         || case when v_n < 1000 then lpad(v_n::text, 3, '0') else v_n::text end;
end
$$;

-- The system store where a transfer note's units are while on the way (created on first use).
create or replace function transit_store()
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from stock_location where type::text = 'transit' and deleted_at is null order by created_at limit 1;
  if v_id is null then
    insert into stock_location (name, type, active)
    values ('In transit · transfer notes', 'transit', false)
    on conflict (name) do nothing;
    select id into v_id from stock_location where type::text = 'transit' and deleted_at is null order by created_at limit 1;
  end if;
  if v_id is null then
    raise exception 'the store "In transit · transfer notes" could not be created' using errcode = 'P0002';
  end if;
  return v_id;
end
$$;

-- A notice to the people who hold a store: each named holder, each holding department.
create or replace function notify_holders(p_location uuid, p_kind text, p_params jsonb, p_link text default null)
returns void
language sql security definer set search_path = public
as $$
  insert into notification (kind, params, link, recipient_user, recipient_department, created_by)
  select p_kind, p_params, coalesce(p_link, '/app/stock?tab=mine&store=' || p_location), h.profile_id, h.department_id, auth.uid()
  from stock_location_holder h
  where h.location_id = p_location and h.deleted_at is null
$$;

-- The holders of a store, as shown on screens.
create or replace function store_holders(p_location uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', h.id, 'profileId', h.profile_id, 'name', p.full_name, 'role', p.role,
      'departmentId', h.department_id, 'department', d.name
    ) order by d.name nulls first, p.full_name), '[]'::jsonb)
  from stock_location_holder h
  left join profiles p on p.id = h.profile_id
  left join department d on d.id = h.department_id
  where h.location_id = p_location and h.deleted_at is null
$$;

-- Units leave a room store without a patient (counted down, written off): the manager and the
-- pharmacy are told (room_stock_loss).
create or replace function notify_room_loss(p_item_id uuid, p_store stock_location, p_units integer, p_reason text)
returns void
language sql security definer set search_path = public
as $$
  insert into notification (kind, params, link, recipient_role, recipient_stations, created_by)
  select 'room_stock_loss',
         jsonb_build_object('item', item_label(p_item_id), 'store', p_store.name, 'storeId', p_store.id,
                            'units', p_units, 'reason', p_reason,
                            'by', (select full_name from profiles where id = auth.uid())),
         '/app/stock?tab=rooms&store=' || p_store.id, r.role, r.stations, auth.uid()
  from (values ('manager'::role_key, null::station[]), (null::role_key, array['pharmacy'::station])) r(role, stations)
$$;

-- Find (or add) a supplier by name.
create or replace function supplier_for(p_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if nullif(trim(coalesce(p_name, '')), '') is null then
    return null;
  end if;
  select id into v_id from supplier where lower(name) = lower(trim(p_name)) and deleted_at is null;
  if v_id is null then
    insert into supplier (name) values (trim(p_name)) returning id into v_id;
  end if;
  return v_id;
end
$$;

-- ---------------------------------------------------------------- the stores (B, C, RIGHTS-2)
-- Pharmacy stores: the pharmacy or the manager. Room stores: the manager. No new main store; an
-- existing one may be renamed. A store that holds stock (or has a note on the way) keeps its type.
create or replace function save_location(p_id uuid, p_name text, p_type stock_location_type, p_department_id uuid default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_old stock_location%rowtype;
begin
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'the store needs a name' using errcode = '22023';
  end if;
  if p_type::text = 'transit' then
    raise exception 'this store type is kept by the system' using errcode = '22023';
  end if;
  if v_id is not null then
    select * into v_old from stock_location where id = v_id and deleted_at is null;
    if not found then
      raise exception 'store not found' using errcode = 'P0002';
    end if;
    if v_old.type::text = 'transit' then
      raise exception 'this store is kept by the system' using errcode = '22023';
    end if;
  end if;
  if p_type = 'main_store' and (v_id is null or v_old.type <> 'main_store') then
    raise exception 'deliveries are received into the pharmacy: a new main store is not created'
      using errcode = '22023', hint = 'no_main_store';
  end if;
  -- who may: the pharmacy stores by the pharmacy or the manager, the room stores by the manager
  if is_room_type(p_type) or (v_id is not null and is_room_type(v_old.type)) then
    if not is_manager() then
      raise exception 'only the manager creates and changes room stores' using errcode = '42501';
    end if;
  elsif not stock_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_id is null then
    insert into stock_location (name, type, department_id) values (trim(p_name), p_type, p_department_id)
    returning id into v_id;
  else
    if v_old.type <> p_type and (
         exists (select 1 from stock_on_hand where location_id = v_id and quantity <> 0)
         or exists (select 1 from stock_transfer t where t.status = 'in_transit'
                    and (t.from_location_id = v_id or t.to_location_id = v_id))) then
      raise exception 'a store that holds stock keeps its type' using errcode = '23514', hint = 'store_has_stock';
    end if;
    update stock_location set name = trim(p_name), type = p_type, department_id = p_department_id, updated_at = now()
    where id = v_id;
    if v_old.is_main and p_type <> 'pharmacy' then
      update stock_location set is_main = false where id = v_id;
    end if;
  end if;
  -- a room store given to a department: the department holds it
  if is_room_type(p_type) and p_department_id is not null
     and not exists (select 1 from stock_location_holder where location_id = v_id and department_id = p_department_id
                     and deleted_at is null) then
    insert into stock_location_holder (location_id, department_id) values (v_id, p_department_id);
  end if;
  return v_id;
end
$$;

-- Creates or renames a room store (manager) and, when given, sets who holds it.
create or replace function save_room_store(
  p_id uuid, p_name text, p_type text default 'room', p_staff uuid[] default null, p_departments uuid[] default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_type text := coalesce(nullif(trim(p_type), ''), 'room');
begin
  if not is_manager() then
    raise exception 'only the manager creates and changes room stores' using errcode = '42501';
  end if;
  if v_type not in ('room', 'nursing', 'lab', 'theatre') then
    raise exception 'a room store is of type room, nursing, lab or theatre' using errcode = '22023', hint = 'not_room_store';
  end if;
  if p_id is not null and not exists (select 1 from stock_location where id = p_id and deleted_at is null
                                      and is_room_type(type)) then
    raise exception 'room store not found' using errcode = 'P0002';
  end if;
  v_id := save_location(p_id, p_name, v_type::stock_location_type,
                        (select department_id from stock_location where id = p_id));
  if p_staff is not null or p_departments is not null then
    perform set_store_holders(v_id, coalesce(p_staff, '{}'::uuid[]), coalesce(p_departments, '{}'::uuid[]));
  end if;
  return v_id;
end
$$;

-- One holder more (a person or a department). Manager only.
create or replace function assign_store_holder(p_location_id uuid, p_profile_id uuid default null, p_department_id uuid default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_name text;
begin
  if not is_manager() then
    raise exception 'only the manager decides who holds a room store' using errcode = '42501';
  end if;
  if (p_profile_id is null) = (p_department_id is null) then
    raise exception 'choose a person or a department' using errcode = '22023';
  end if;
  select name into v_name from stock_location where id = p_location_id and deleted_at is null and is_room_type(type);
  if v_name is null then
    raise exception 'choose a room store' using errcode = '22023', hint = 'not_room_store';
  end if;
  if p_profile_id is not null and not exists (select 1 from profiles where id = p_profile_id and active) then
    raise exception 'employee not found or not active' using errcode = 'P0002';
  end if;
  if p_department_id is not null and not exists (select 1 from department where id = p_department_id and deleted_at is null) then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  select id into v_id from stock_location_holder
  where location_id = p_location_id and deleted_at is null
    and (profile_id = p_profile_id or department_id = p_department_id);
  if v_id is not null then
    return v_id;
  end if;
  insert into stock_location_holder (location_id, profile_id, department_id)
  values (p_location_id, p_profile_id, p_department_id)
  returning id into v_id;
  insert into notification (kind, params, link, recipient_user, recipient_department, created_by)
  values ('store_assigned', jsonb_build_object('store', v_name, 'storeId', p_location_id),
          '/app/stock?tab=mine&store=' || p_location_id, p_profile_id, p_department_id, auth.uid());
  return v_id;
end
$$;

create or replace function unassign_store_holder(p_holder_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_manager() then
    raise exception 'only the manager decides who holds a room store' using errcode = '42501';
  end if;
  update stock_location_holder set deleted_at = now() where id = p_holder_id and deleted_at is null;
  if not found then
    raise exception 'holder not found' using errcode = 'P0002';
  end if;
end
$$;

-- The whole list of holders at once (the manager's form): those left out stop holding the store.
create or replace function set_store_holders(p_location_id uuid, p_staff uuid[], p_departments uuid[])
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_p uuid;
begin
  if not is_manager() then
    raise exception 'only the manager decides who holds a room store' using errcode = '42501';
  end if;
  if not exists (select 1 from stock_location where id = p_location_id and deleted_at is null and is_room_type(type)) then
    raise exception 'choose a room store' using errcode = '22023', hint = 'not_room_store';
  end if;
  update stock_location_holder set deleted_at = now()
  where location_id = p_location_id and deleted_at is null
    and ((profile_id is not null and not (profile_id = any (coalesce(p_staff, '{}'::uuid[]))))
         or (department_id is not null and not (department_id = any (coalesce(p_departments, '{}'::uuid[])))));
  foreach v_p in array coalesce(p_staff, '{}'::uuid[]) loop
    perform assign_store_holder(p_location_id, v_p, null);
  end loop;
  foreach v_p in array coalesce(p_departments, '{}'::uuid[]) loop
    perform assign_store_holder(p_location_id, null, v_p);
  end loop;
  return store_holders(p_location_id);
end
$$;

-- Close (empty, nothing on the way) or reopen a store. Room stores: the manager. Pharmacy and main
-- stores: the pharmacy or the manager.
create or replace function set_location_active(p_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_l stock_location%rowtype;
begin
  select * into v_l from stock_location where id = p_id and deleted_at is null for update;
  if not found then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if v_l.type::text = 'transit' then
    raise exception 'this store is kept by the system' using errcode = '22023';
  end if;
  if is_room_type(v_l.type) then
    if not is_manager() then
      raise exception 'only the manager closes and reopens room stores' using errcode = '42501';
    end if;
  elsif not stock_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not p_active then
    if exists (select 1 from stock_on_hand where location_id = p_id and quantity > 0) then
      raise exception 'this store still holds stock: return it to the pharmacy (or send it on) first'
        using errcode = '23514', hint = 'store_has_stock';
    end if;
    if exists (select 1 from stock_transfer t where t.status = 'in_transit'
               and (t.from_location_id = p_id or t.to_location_id = p_id)) then
      raise exception 'a transfer note to or from this store is still on the way: receive or cancel it first'
        using errcode = '23514', hint = 'notes_in_transit';
    end if;
    update store_request set status = 'cancelled', decided_at = now(), decided_by = auth.uid(),
           decline_reason = 'store closed'
    where location_id = p_id and status = 'open';
  end if;
  update stock_location set active = p_active, updated_at = now(),
         is_main = case when p_active then is_main else false end
  where id = p_id;
  -- the main pharmacy closed: the next open pharmacy store receives
  if not p_active and v_l.is_main then
    update stock_location set is_main = true
    where id = (select id from stock_location where type = 'pharmacy' and active and deleted_at is null
                order by created_at limit 1);
  end if;
end
$$;

-- ---------------------------------------------------------------- the holders' stores (E: given here)
-- The store a medicine "given here" comes out of: a store the prescriber holds (the manager: any
-- room store), open, with enough unexpired units in total. The one chosen, else their own: held
-- personally first, then through a department, then the desk's kind, then the oldest. null when
-- none holds enough (prescribe then refuses with MS003). Nobody else gives here.
create or replace function room_store_for(
  p_staff uuid, p_item_id uuid, p_quantity integer, p_location uuid default null, p_station station default null
)
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := exists (select 1 from profiles where id = p_staff and active and role = 'manager');
  v_qty integer := greatest(coalesce(p_quantity, 1), 1);
  v_id uuid;
begin
  if p_location is not null then
    if not exists (select 1 from stock_location where id = p_location and deleted_at is null and active
                   and is_room_type(type)) then
      raise exception 'choose an open room store' using errcode = '22023', hint = 'not_room_store';
    end if;
    if not v_manager and not holds_store(p_staff, p_location) then
      raise exception 'you do not hold that store: give from your own store, or prescribe it for the pharmacy'
        using errcode = '42501', hint = 'not_holder';
    end if;
    return case when usable_stock(p_item_id, p_location) >= v_qty then p_location end;
  end if;
  if not v_manager and not exists (select 1 from stock_location l where l.deleted_at is null and l.active
                                   and is_room_type(l.type) and holds_store(p_staff, l.id)) then
    raise exception 'you hold no room store: prescribe it for the pharmacy'
      using errcode = '42501', hint = 'no_room_store';
  end if;
  select l.id into v_id
  from stock_location l
  where l.deleted_at is null and l.active and is_room_type(l.type)
    and (v_manager or holds_store(p_staff, l.id))
    and usable_stock(p_item_id, l.id) >= v_qty
  order by
    exists (select 1 from stock_location_holder h where h.location_id = l.id and h.deleted_at is null
            and h.profile_id = p_staff) desc,
    holds_store(p_staff, l.id) desc,
    (l.type = case when p_station in ('nursing', 'beds', 'triage') then 'nursing'::stock_location_type
                   when p_station = 'theatre' then 'theatre'::stock_location_type end) desc nulls last,
    l.created_at
  limit 1;
  return v_id;
end
$$;

-- The stores the caller holds ("My store"), with what needs attention.
create or replace function my_stores()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.name, 'type', l.type, 'active', l.active,
      'personal', exists (select 1 from stock_location_holder h where h.location_id = l.id and h.deleted_at is null
                          and h.profile_id = auth.uid()),
      'departments', coalesce((select jsonb_agg(d.name order by d.name) from stock_location_holder h
                               join department d on d.id = h.department_id
                               join staff_department sd on sd.department_id = h.department_id and sd.profile_id = auth.uid()
                               where h.location_id = l.id and h.deleted_at is null), '[]'::jsonb),
      'items', (select count(distinct s.item_id) from stock_on_hand s where s.location_id = l.id and s.quantity > 0)::integer,
      'units', (select coalesce(sum(s.quantity), 0) from stock_on_hand s where s.location_id = l.id and s.quantity > 0)::integer,
      'expiredUnits', (select coalesce(sum(s.quantity), 0) from stock_on_hand s where s.location_id = l.id
                       and s.quantity > 0 and s.expiry < current_date)::integer,
      'expiringUnits', (select coalesce(sum(s.quantity), 0) from stock_on_hand s where s.location_id = l.id
                        and s.quantity > 0 and s.expiry between current_date and current_date + 90)::integer,
      'low', (select count(*) from store_item_level m where m.location_id = l.id
              and usable_stock(m.item_id, l.id) < m.min_level)::integer,
      'incoming', (select count(*) from stock_transfer t where t.to_location_id = l.id and t.status = 'in_transit')::integer,
      'returnsOnTheWay', (select count(*) from stock_transfer t where t.from_location_id = l.id
                          and t.direction = 'to_pharmacy' and t.status = 'in_transit')::integer,
      'openRequests', (select count(*) from store_request r where r.location_id = l.id and r.status = 'open')::integer
    ) order by l.name), '[]'::jsonb)
  from stock_location l
  where l.deleted_at is null and l.active and is_room_type(l.type) and holds_store(auth.uid(), l.id)
$$;

-- One store's stock, batch by batch (its holders, the pharmacy, the manager).
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
           sum(s.quantity) filter (where s.expiry between current_date and current_date + 90)::integer as expiring,
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
                                       else has_perm('stock.dispense') end,
    'items', v_items,
    'onTheWay', v_incoming,
    'value', case when v_admin then (select coalesce(sum(s.quantity * coalesce(b.unit_cost, 0)), 0)
                                     from stock_on_hand s left join batch b on b.id = s.batch_id
                                     where s.location_id = p_location_id and s.quantity > 0) end
  );
end
$$;

-- The minimum a room store keeps of a medicine (its holders, the pharmacy, the manager). 0 / null: none.
create or replace function set_store_min(p_location_id uuid, p_item_id uuid, p_min integer)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from stock_location where id = p_location_id and deleted_at is null and is_room_type(type)) then
    raise exception 'choose a room store' using errcode = '22023', hint = 'not_room_store';
  end if;
  if not (stock_admin() or holds_store(auth.uid(), p_location_id)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from item where id = p_item_id and deleted_at is null) then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  if p_min is not null and p_min < 0 then
    raise exception 'the minimum must be zero or more' using errcode = '22023';
  end if;
  if coalesce(p_min, 0) = 0 then
    delete from store_item_level where location_id = p_location_id and item_id = p_item_id;
    delete from low_stock_flag where item_id = p_item_id and scope = p_location_id::text;
  else
    insert into store_item_level (location_id, item_id, min_level) values (p_location_id, p_item_id, p_min)
    on conflict (location_id, item_id) do update set min_level = excluded.min_level, updated_at = now(),
                                                     updated_by = auth.uid();
    perform check_room_low(p_item_id, p_location_id);
  end if;
end
$$;

-- ---------------------------------------------------------------- receiving (B, BATCH-1)
-- Internal: units of one batch come into a store. The expiry date is the one on the box (never in
-- the past, the same for every delivery of that batch number); each cost is its own layer (a batch
-- row per cost), so a later delivery never changes the value of earlier units.
create or replace function receive_batch(
  p_item_id uuid, p_location_id uuid, p_units integer, p_unit_cost numeric, p_batch_no text, p_expiry date,
  p_supplier_id uuid default null, p_reason text default null, p_receipt_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_no text := nullif(upper(trim(coalesce(p_batch_no, ''))), '');
  v_cost numeric := round(coalesce(p_unit_cost, -1), 2);
  v_other date;
  v_batch uuid;
begin
  if p_units is null or p_units <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if v_cost < 0 then
    raise exception 'the cost per unit must be zero or more' using errcode = '22023';
  end if;
  if p_expiry is null then
    raise exception 'give the expiry date written on the box' using errcode = '22023';
  end if;
  if p_expiry < current_date then
    raise exception 'this expiry date is already past: expired goods are not received' using errcode = '22023', hint = 'expired_date';
  end if;
  if not exists (select 1 from item where id = p_item_id and deleted_at is null) then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from stock_location where id = p_location_id and deleted_at is null) then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from stock_location where id = p_location_id and active and type::text <> 'transit') then
    raise exception 'this store is closed: reopen it first' using errcode = '22023', hint = 'store_closed';
  end if;
  if v_no is null then
    v_no := day_number('B', 'batch-day');
  end if;
  select expiry into v_other from batch
  where item_id = p_item_id and upper(batch_no) = v_no and deleted_at is null and expiry <> p_expiry
  limit 1;
  if v_other is not null then
    raise exception 'batch % of this medicine was received with expiry %: check the box', v_no, to_char(v_other, 'DD/MM/YYYY')
      using errcode = '22023', hint = 'batch_expiry';
  end if;
  select id into v_batch from batch
  where item_id = p_item_id and upper(batch_no) = v_no and unit_cost = v_cost and deleted_at is null
  limit 1;
  if v_batch is null then
    insert into batch (item_id, batch_no, expiry, unit_cost, supplier_id)
    values (p_item_id, v_no, p_expiry, v_cost, p_supplier_id)
    returning id into v_batch;
  end if;
  insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason, unit_cost, goods_receipt_id)
  values (p_item_id, v_batch, p_location_id, p_units, 'receipt', nullif(trim(coalesce(p_reason, '')), ''), v_cost, p_receipt_id);
  return v_batch;
end
$$;

-- One delivery line, as before: into a pharmacy store (the pharmacy or the manager), or into the
-- lab's own store (its holders with stock.write: reagents). Other stores are supplied by the pharmacy.
create or replace function receive_stock(
  p_item_id uuid, p_location_id uuid, p_quantity integer, p_unit_cost numeric,
  p_batch_no text default null, p_expiry date default null, p_supplier text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_l stock_location%rowtype;
begin
  select * into v_l from stock_location where id = p_location_id and deleted_at is null;
  if not found then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if v_l.type = 'pharmacy' then
    if not stock_admin() then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  elsif v_l.type = 'lab' then
    if not (is_manager() or (has_perm('stock.write') and holds_store(auth.uid(), p_location_id))) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  else
    raise exception 'deliveries are received into the pharmacy; room stores are supplied by the pharmacy with a transfer note'
      using errcode = '22023', hint = 'receive_into_pharmacy';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if p_unit_cost is null or p_unit_cost < 0 then
    raise exception 'the cost per unit must be zero or more' using errcode = '22023';
  end if;
  return receive_batch(p_item_id, p_location_id, p_quantity, p_unit_cost, p_batch_no, p_expiry,
                       supplier_for(p_supplier), nullif(trim(coalesce(p_supplier, '')), ''), null);
end
$$;

-- Sets the cash price of a medicine that has none (a medicine new at the clinic).
create or replace function set_cash_price_if_none(p_item_id uuid, p_price numeric)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_list uuid;
begin
  if p_price is null or p_price < 0 or (select pf.price from price_for(null, p_item_id, null) pf) is not null then
    return;
  end if;
  select id into v_list from price_list
  where payer_id is null and deleted_at is null and effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
  order by effective_from desc limit 1;
  if v_list is null then
    insert into price_list (payer_id, name, effective_from) values (null, 'Cash prices', current_date) returning id into v_list;
  end if;
  insert into price_list_item (price_list_id, item_id, price) values (v_list, p_item_id, round(p_price))
  on conflict (price_list_id, item_id) where item_id is not null
  do update set price = excluded.price, deleted_at = null;
end
$$;

-- A delivery from a supplier (goods received note): several lines in one go, into the pharmacy.
-- Line: { itemId | refCode, batchNo?, expiry, quantity, unit: 'box' | 'unit', packSize?, cost (per box
-- or per unit, as unit), sellingPrice? (a medicine new at the clinic) }.
create or replace function receive_delivery(
  p_supplier text, p_reference text, p_lines jsonb, p_delivered_on date default null,
  p_location_id uuid default null, p_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_loc uuid;
  v_sup uuid;
  v_ref text := nullif(trim(coalesce(p_reference, '')), '');
  v_on date := coalesce(p_delivered_on, (now() at time zone 'Africa/Kigali')::date);
  v_id uuid;
  v_number text;
  v_line jsonb;
  v_n integer;
  v_item uuid;
  v_code text;
  v_r medicine_reference%rowtype;
  v_unit text;
  v_qty numeric;
  v_pack integer;
  v_units integer;
  v_cost numeric;
  v_unit_cost numeric;
  v_line_cost numeric;
  v_expiry date;
  v_batch uuid;
  v_total numeric := 0;
  v_all_units integer := 0;
  v_state text;
  v_msg text;
  v_hint text;
begin
  if not stock_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_loc := coalesce(p_location_id, main_pharmacy());
  if v_loc is null or not exists (select 1 from stock_location where id = v_loc and type = 'pharmacy' and active
                                  and deleted_at is null) then
    raise exception 'deliveries are received into an open pharmacy store' using errcode = '22023', hint = 'receive_into_pharmacy';
  end if;
  if length(trim(coalesce(p_supplier, ''))) < 2 then
    raise exception 'name the supplier' using errcode = '22023', hint = 'supplier';
  end if;
  if v_on > (now() at time zone 'Africa/Kigali')::date then
    raise exception 'the delivery date is in the future' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'add at least one medicine' using errcode = '22023';
  end if;
  v_sup := supplier_for(p_supplier);
  if v_ref is not null and exists (select 1 from goods_receipt g where g.supplier_id = v_sup and lower(g.reference) = lower(v_ref)
                                   and g.deleted_at is null) then
    raise exception 'delivery note % of this supplier was already received', v_ref using errcode = '23505', hint = 'duplicate_delivery';
  end if;
  v_number := day_number('GRN', 'goods-receipt');
  insert into goods_receipt (supplier_id, received_on, note, number, reference, delivered_on, location_id, supplier_name)
  values (v_sup, now(), nullif(trim(coalesce(p_note, '')), ''), v_number, v_ref, v_on, v_loc, trim(p_supplier))
  returning id into v_id;

  for v_line, v_n in select x.value, x.ordinality from jsonb_array_elements(p_lines) with ordinality as x loop
    begin
      v_item := nullif(v_line ->> 'itemId', '')::uuid;
      v_code := nullif(upper(trim(coalesce(v_line ->> 'refCode', ''))), '');
      if v_item is null and v_code is not null then
        select id into v_item from item where code = v_code and deleted_at is null;
        if v_item is null then
          -- a medicine new at the clinic, from the reference list (RHIA): added with its selling price
          select * into v_r from medicine_reference where code = v_code;
          if not found then
            raise exception 'this medicine is not on the reference list' using errcode = 'P0002';
          end if;
          v_item := upsert_item(null, v_r.generic,
                                coalesce(nullif(v_line ->> 'sellingPrice', '')::numeric, v_r.price),
                                v_r.presentation, null, v_r.unit, true, v_r.code);
        end if;
      end if;
      if v_item is null or not exists (select 1 from item where id = v_item and deleted_at is null) then
        raise exception 'choose the medicine' using errcode = '22023';
      end if;
      v_unit := coalesce(nullif(v_line ->> 'unit', ''), 'unit');
      if v_unit not in ('box', 'unit') then
        raise exception 'count in boxes or in units' using errcode = '22023';
      end if;
      v_qty := nullif(v_line ->> 'quantity', '')::numeric;
      if v_qty is null or v_qty <= 0 then
        raise exception 'quantity must be more than zero' using errcode = '22023';
      end if;
      if v_unit = 'box' then
        v_pack := coalesce(nullif(v_line ->> 'packSize', '')::integer, (select pack_size from item where id = v_item));
        if v_pack is null or v_pack < 1 then
          raise exception 'say how many units are in one box' using errcode = '22023', hint = 'pack_size';
        end if;
        update item set pack_size = v_pack where id = v_item and pack_size is null;
      else
        v_pack := 1;
      end if;
      v_units := round(v_qty * v_pack)::integer;
      if v_units <> v_qty * v_pack or v_units <= 0 then
        raise exception 'the quantity must come to whole units' using errcode = '22023';
      end if;
      v_cost := nullif(v_line ->> 'cost', '')::numeric;
      if v_cost is null or v_cost < 0 then
        raise exception 'the cost must be zero or more' using errcode = '22023';
      end if;
      v_unit_cost := round(v_cost / v_pack, 2);
      v_line_cost := round(v_cost * v_qty, 2);
      v_expiry := nullif(v_line ->> 'expiry', '')::date;
      perform set_cash_price_if_none(v_item, nullif(v_line ->> 'sellingPrice', '')::numeric);
      v_batch := receive_batch(v_item, v_loc, v_units, v_unit_cost, v_line ->> 'batchNo', v_expiry, v_sup,
                               trim(p_supplier) || coalesce(' · ' || v_ref, '') || ' · ' || v_number, v_id);
      insert into goods_receipt_line (receipt_id, item_id, batch_id, batch_no, expiry, unit, packs, pack_size, units,
                                      unit_cost, pack_cost, line_cost)
      values (v_id, v_item, v_batch, (select batch_no from batch where id = v_batch), v_expiry, v_unit, v_qty, v_pack,
              v_units, v_unit_cost, case when v_unit = 'box' then v_cost end, v_line_cost);
      v_total := v_total + v_line_cost;
      v_all_units := v_all_units + v_units;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
      raise exception 'line %: %', v_n, v_msg using errcode = v_state, hint = coalesce(nullif(v_hint, ''), 'line');
    end;
  end loop;
  update goods_receipt set total_cost = v_total where id = v_id;
  return jsonb_build_object('id', v_id, 'number', v_number, 'locationId', v_loc,
                            'lines', jsonb_array_length(p_lines), 'units', v_all_units, 'totalCost', v_total);
end
$$;

-- Deliveries received in a period (the pharmacy and the manager).
create or replace function deliveries(p_from date default null, p_to date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', g.id, 'number', g.number, 'supplier', coalesce(g.supplier_name, s.name), 'reference', g.reference,
      'deliveredOn', g.delivered_on, 'receivedAt', g.received_on, 'receivedBy', pr.full_name,
      'store', l.name, 'storeId', g.location_id, 'note', g.note,
      'lines', (select count(*) from goods_receipt_line x where x.receipt_id = g.id and x.deleted_at is null)::integer,
      'units', (select coalesce(sum(x.units), 0) from goods_receipt_line x where x.receipt_id = g.id and x.deleted_at is null)::integer,
      'totalCost', g.total_cost
    ) order by g.received_on desc), '[]'::jsonb)
  from goods_receipt g
  left join supplier s on s.id = g.supplier_id
  left join stock_location l on l.id = g.location_id
  left join profiles pr on pr.id = g.created_by
  where stock_admin() and g.deleted_at is null and g.number is not null
    and (g.received_on at time zone 'Africa/Kigali')::date
        between coalesce(p_from, (now() at time zone 'Africa/Kigali')::date - 30)
            and coalesce(p_to, (now() at time zone 'Africa/Kigali')::date)
$$;

create or replace function delivery_detail(p_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
      'id', g.id, 'number', g.number, 'supplier', coalesce(g.supplier_name, s.name), 'reference', g.reference,
      'deliveredOn', g.delivered_on, 'receivedAt', g.received_on, 'receivedBy', pr.full_name,
      'store', l.name, 'storeId', g.location_id, 'note', g.note, 'totalCost', g.total_cost,
      'lines', coalesce((select jsonb_agg(jsonb_build_object(
          'id', x.id, 'itemId', x.item_id, 'item', item_label(x.item_id), 'unit', x.unit, 'packs', x.packs,
          'packSize', x.pack_size, 'units', x.units, 'batchNo', x.batch_no, 'expiry', x.expiry,
          'unitCost', x.unit_cost, 'packCost', x.pack_cost, 'lineCost', x.line_cost
        ) order by x.created_at) from goods_receipt_line x where x.receipt_id = g.id and x.deleted_at is null), '[]'::jsonb))
  from goods_receipt g
  left join supplier s on s.id = g.supplier_id
  left join stock_location l on l.id = g.location_id
  left join profiles pr on pr.id = g.created_by
  where stock_admin() and g.id = p_id and g.deleted_at is null
$$;

-- ---------------------------------------------------------------- taking stock (RIGHTS-2)
-- Who works a store: a room store, its holders (and the manager); a pharmacy or main store, the
-- pharmacy (and the manager). The system store "In transit" by nobody.
create or replace function assert_store_work(p_location_id uuid)
returns stock_location
language plpgsql stable security definer set search_path = public
as $$
declare
  v_l stock_location%rowtype;
begin
  select * into v_l from stock_location where id = p_location_id and deleted_at is null;
  if not found then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if v_l.type::text = 'transit' then
    raise exception 'the units on the way belong to their transfer note' using errcode = '22023';
  end if;
  if is_room_type(v_l.type) then
    if not (is_manager() or holds_store(auth.uid(), p_location_id)) then
      raise exception 'only the people who hold this store (or the manager) work its stock'
        using errcode = '42501', hint = 'not_holder';
    end if;
  elsif not stock_admin() then
    raise exception 'only the pharmacy (or the manager) works the pharmacy stock' using errcode = '42501';
  end if;
  return v_l;
end
$$;

-- Used without a sale or written off (expired, damaged…): always with a reason.
create or replace function use_stock(
  p_item_id uuid, p_location_id uuid, p_quantity integer, p_encounter_id uuid default null, p_reason text default null
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_remaining integer := p_quantity;
  v_row record;
  v_take integer;
  v_reason text := coalesce(nullif(trim(coalesce(p_reason, '')), ''),
                            case when p_encounter_id is not null then 'visit ' || p_encounter_id::text end);
  v_l stock_location%rowtype;
begin
  v_l := assert_store_work(p_location_id);
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if length(coalesce(v_reason, '')) < 3 then
    raise exception 'say why (expired, damaged, used…)' using errcode = '22023';
  end if;
  perform lock_stock(p_item_id, p_location_id);
  -- a write-off (expired, damaged): the oldest batches first, expired ones included
  for v_row in
    select s.batch_id, s.quantity from stock_on_hand s
    where s.item_id = p_item_id and s.location_id = p_location_id and s.quantity > 0
    order by s.expiry asc nulls last
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.quantity, v_remaining);
    insert into stock_movement (item_id, batch_id, from_location_id, quantity, type, reason)
    values (p_item_id, v_row.batch_id, p_location_id, v_take, 'consumption', v_reason);
    v_remaining := v_remaining - v_take;
  end loop;
  if v_remaining > 0 then
    raise exception 'not enough stock in that store: % unit(s) short', v_remaining using errcode = '23514', hint = 'short';
  end if;
  -- a room store's write-off: the manager and the pharmacy are told
  if is_room_type(v_l.type) then
    perform notify_room_loss(p_item_id, v_l, p_quantity, v_reason);
  end if;
  return p_quantity;
end
$$;

-- The count of a store: the difference is written with its reason.
create or replace function adjust_stock(p_item_id uuid, p_location_id uuid, p_counted integer, p_reason text)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_on_hand integer;
  v_diff integer;
  v_remaining integer;
  v_row record;
  v_take integer;
  v_batch uuid;
  v_l stock_location%rowtype;
begin
  v_l := assert_store_work(p_location_id);
  if p_counted is null or p_counted < 0 then
    raise exception 'the count must be zero or more' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the count changes' using errcode = '22023';
  end if;
  perform lock_stock(p_item_id, p_location_id);
  select coalesce(sum(quantity), 0)::integer into v_on_hand
  from stock_on_hand where item_id = p_item_id and location_id = p_location_id;
  v_diff := p_counted - v_on_hand;
  -- a room store is supplied only by the pharmacy's transfer notes: its holders do not count it up
  if is_room_type(v_l.type) and v_diff > 0 and not stock_admin() then
    raise exception 'more on the shelf than the system says: ask the pharmacy to send it with a transfer note'
      using errcode = '22023', hint = 'use_transfer_note';
  end if;
  if v_diff < 0 then
    v_remaining := -v_diff;
    for v_row in
      select s.batch_id, s.quantity from stock_on_hand s
      where s.item_id = p_item_id and s.location_id = p_location_id and s.quantity > 0
      order by s.expiry asc nulls last
    loop
      exit when v_remaining <= 0;
      v_take := least(v_row.quantity, v_remaining);
      insert into stock_movement (item_id, batch_id, from_location_id, quantity, type, reason)
      values (p_item_id, v_row.batch_id, p_location_id, v_take, 'adjustment', 'count: ' || trim(p_reason));
      v_remaining := v_remaining - v_take;
    end loop;
    if is_room_type(v_l.type) then
      perform notify_room_loss(p_item_id, v_l, -v_diff, 'count: ' || trim(p_reason));
    end if;
  elsif v_diff > 0 then
    -- more on the shelf: the latest batch this store has held, else the medicine's latest batch
    select b.id into v_batch from batch b
    where b.item_id = p_item_id and b.deleted_at is null
    order by exists (select 1 from stock_movement m where m.batch_id = b.id and m.to_location_id = p_location_id
                     and m.deleted_at is null) desc,
             b.received_on desc
    limit 1;
    if v_batch is null then
      raise exception 'no batch of this item yet: receive it instead' using errcode = 'P0002';
    end if;
    insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason)
    values (p_item_id, v_batch, p_location_id, v_diff, 'adjustment', 'count: ' || trim(p_reason));
  end if;
  return v_diff;
end
$$;

-- Between pharmacy stores, or from an old main store to the pharmacy (the pharmacy or the manager).
-- A room store is supplied with a transfer note (send_to_room) and sends back with a return note.
create or replace function transfer_stock(
  p_item_id uuid, p_from_location_id uuid, p_to_location_id uuid, p_quantity integer, p_reason text default null
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_remaining integer := p_quantity;
  v_row record;
  v_take integer;
  v_from stock_location%rowtype;
  v_to stock_location%rowtype;
begin
  if not stock_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'choose a different destination' using errcode = '22023';
  end if;
  select * into v_from from stock_location where id = p_from_location_id and deleted_at is null;
  select * into v_to from stock_location where id = p_to_location_id and deleted_at is null;
  if v_from.id is null or v_to.id is null then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if v_from.type not in ('pharmacy', 'main_store') or v_to.type <> 'pharmacy' then
    raise exception 'a room store is supplied with a transfer note, and sends back with a return note'
      using errcode = '22023', hint = 'use_transfer_note';
  end if;
  if not v_to.active then
    raise exception 'this store is closed: reopen it first' using errcode = '22023', hint = 'store_closed';
  end if;
  perform lock_stock(p_item_id, p_from_location_id);
  for v_row in
    select s.batch_id, s.quantity, b.unit_cost from stock_on_hand s left join batch b on b.id = s.batch_id
    where s.item_id = p_item_id and s.location_id = p_from_location_id and s.quantity > 0
      and (s.expiry is null or s.expiry >= current_date)   -- expired stock is not sent on
    order by s.expiry asc nulls last
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.quantity, v_remaining);
    insert into stock_movement (item_id, batch_id, from_location_id, to_location_id, quantity, type, reason, unit_cost)
    values (p_item_id, v_row.batch_id, p_from_location_id, p_to_location_id, v_take, 'transfer',
            nullif(trim(coalesce(p_reason, '')), ''), v_row.unit_cost);
    v_remaining := v_remaining - v_take;
  end loop;
  if v_remaining > 0 then
    raise exception 'not enough stock in that store: % unit(s) short', v_remaining using errcode = '23514', hint = 'short';
  end if;
  return p_quantity;
end
$$;

-- ---------------------------------------------------------------- low stock watch (ALERT-1)
-- The pharmacy: unexpired units in the open pharmacy stores at or below the reorder level: told
-- once (until the stock is back above).
create or replace function check_pharmacy_low(p_item_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_level integer;
  v_usable integer;
begin
  select reorder_level into v_level from item where id = p_item_id and active and deleted_at is null;
  if coalesce(v_level, 0) <= 0 then
    delete from low_stock_flag where item_id = p_item_id and scope = 'pharmacy';
    return;
  end if;
  select coalesce(sum(s.quantity), 0)::integer into v_usable
  from stock_on_hand s join stock_location l on l.id = s.location_id
  where s.item_id = p_item_id and l.type = 'pharmacy' and l.active and l.deleted_at is null and s.quantity > 0
    and (s.expiry is null or s.expiry >= current_date);
  if v_usable <= v_level then
    if not exists (select 1 from low_stock_flag where item_id = p_item_id and scope = 'pharmacy') then
      insert into low_stock_flag (item_id, scope) values (p_item_id, 'pharmacy');
      insert into notification (kind, params, link, recipient_stations, created_by)
      values ('stock_low', jsonb_build_object('item', item_label(p_item_id), 'itemId', p_item_id,
                                              'onHand', v_usable, 'level', v_level),
              '/app/stock?tab=reorder', array['pharmacy'::station], auth.uid());
    end if;
  else
    delete from low_stock_flag where item_id = p_item_id and scope = 'pharmacy';
  end if;
end
$$;

-- A room store below the minimum set for it: its holders are told once.
create or replace function check_room_low(p_item_id uuid, p_location_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_min integer;
  v_usable integer;
begin
  select min_level into v_min from store_item_level where location_id = p_location_id and item_id = p_item_id;
  if v_min is null then
    delete from low_stock_flag where item_id = p_item_id and scope = p_location_id::text;
    return;
  end if;
  v_usable := usable_stock(p_item_id, p_location_id);
  if v_usable < v_min then
    if not exists (select 1 from low_stock_flag where item_id = p_item_id and scope = p_location_id::text) then
      insert into low_stock_flag (item_id, scope) values (p_item_id, p_location_id::text);
      perform notify_holders(p_location_id, 'room_stock_low',
                             jsonb_build_object('item', item_label(p_item_id), 'itemId', p_item_id,
                                                'store', (select name from stock_location where id = p_location_id),
                                                'onHand', v_usable, 'min', v_min));
    end if;
  else
    delete from low_stock_flag where item_id = p_item_id and scope = p_location_id::text;
  end if;
end
$$;

create or replace function stock_low_watch()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_loc uuid;
  v_type text;
begin
  foreach v_loc in array array[new.from_location_id, new.to_location_id] loop
    continue when v_loc is null;
    select type::text into v_type from stock_location where id = v_loc;
    if v_type = 'pharmacy' then
      perform check_pharmacy_low(new.item_id);
    elsif v_type in ('room', 'nursing', 'lab', 'theatre') then
      perform check_room_low(new.item_id, v_loc);
    end if;
  end loop;
  return null;
end
$$;
drop trigger if exists trg_stock_low_watch on stock_movement;
create trigger trg_stock_low_watch after insert on stock_movement
  for each row execute function stock_low_watch();

-- ---------------------------------------------------------------- refill requests (D1)
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
  select jsonb_agg(jsonb_build_object('itemId', y.item_id, 'quantity', y.q) order by y.item_id)
  into v_lines
  from (select (x ->> 'itemId')::uuid as item_id, sum((x ->> 'quantity')::integer)::integer as q
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

-- Refill requests: the pharmacy and the manager see all; holders those of their stores.
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
          'inPharmacy', usable_stock(x."itemId", main_pharmacy()),
          'inStore', usable_stock(x."itemId", r.location_id)
        )) from jsonb_to_recordset(r.lines) as x("itemId" uuid, quantity integer)
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

create or replace function decline_refill(p_request_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_r store_request%rowtype;
begin
  if not stock_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the request is declined' using errcode = '22023';
  end if;
  select * into v_r from store_request where id = p_request_id and deleted_at is null for update;
  if not found or v_r.status <> 'open' then
    raise exception 'this request is no longer open' using errcode = 'P0002';
  end if;
  update store_request set status = 'declined', decided_by = auth.uid(), decided_at = now(), decline_reason = trim(p_reason)
  where id = v_r.id;
  insert into notification (kind, params, link, recipient_user, created_by)
  values ('refill_declined', jsonb_build_object('number', v_r.number,
                                                'store', (select name from stock_location where id = v_r.location_id),
                                                'reason', trim(p_reason),
                                                'by', (select full_name from profiles where id = auth.uid())),
          '/app/stock?tab=mine&store=' || v_r.location_id, v_r.created_by, auth.uid());
end
$$;

create or replace function cancel_refill(p_request_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_r store_request%rowtype;
begin
  select * into v_r from store_request where id = p_request_id and deleted_at is null for update;
  if not found or v_r.status <> 'open' then
    raise exception 'this request is no longer open' using errcode = 'P0002';
  end if;
  if not (is_manager() or v_r.created_by = auth.uid() or holds_store(auth.uid(), v_r.location_id)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update store_request set status = 'cancelled', decided_by = auth.uid(), decided_at = now() where id = v_r.id;
end
$$;

-- ---------------------------------------------------------------- transfer notes (D2-D4)
-- Internal: the lines of a note leave a store, earliest expiry first (p_expired: expired batches may
-- go too, a return to the pharmacy), into "In transit".
create or replace function transfer_out(p_transfer_id uuid, p_from uuid, p_item_id uuid, p_quantity integer, p_expired boolean)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_transit uuid := transit_store();
  v_number text := (select number from stock_transfer where id = p_transfer_id);
  v_remaining integer := p_quantity;
  v_row record;
  v_take integer;
  v_left integer;
begin
  perform lock_stock(p_item_id, p_from);
  for v_row in
    select s.batch_id, s.quantity, coalesce(b.unit_cost, 0) as unit_cost from stock_on_hand s
    left join batch b on b.id = s.batch_id
    where s.item_id = p_item_id and s.location_id = p_from and s.quantity > 0 and s.batch_id is not null
      and (p_expired or s.expiry is null or s.expiry >= current_date)
    order by s.expiry asc nulls last
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.quantity, v_remaining);
    insert into stock_transfer_line (transfer_id, item_id, batch_id, quantity, unit_cost)
    values (p_transfer_id, p_item_id, v_row.batch_id, v_take, v_row.unit_cost);
    insert into stock_movement (item_id, batch_id, from_location_id, to_location_id, quantity, type, reason,
                                unit_cost, stock_transfer_id)
    values (p_item_id, v_row.batch_id, p_from, v_transit, v_take, 'transfer', 'on the way: ' || v_number,
            v_row.unit_cost, p_transfer_id);
    v_remaining := v_remaining - v_take;
  end loop;
  if v_remaining > 0 then
    v_left := p_quantity - v_remaining;
    raise exception 'not enough % % in that store: % available, % asked',
      item_label(p_item_id), case when p_expired then '' else '(not expired)' end, v_left, p_quantity
      using errcode = '23514', hint = 'short';
  end if;
  return p_quantity;
end
$$;

-- The lines of a note as one array: [{ itemId, quantity }] merged per medicine (whole units > 0).
create or replace function note_lines(p_lines jsonb)
returns table (item_id uuid, quantity integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'add at least one medicine' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) x
             where nullif(x ->> 'itemId', '') is null or coalesce(nullif(x ->> 'quantity', '')::numeric, 0) <= 0
                or (x ->> 'quantity')::numeric <> round((x ->> 'quantity')::numeric)) then
    raise exception 'each line needs a medicine and a whole quantity above zero' using errcode = '22023';
  end if;
  return query
    select (x ->> 'itemId')::uuid, sum((x ->> 'quantity')::integer)::integer
    from jsonb_array_elements(p_lines) x
    group by 1 order by 1;
end
$$;

-- The pharmacy sends medicines to a room store (on its own, or for a refill request).
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
  if not stock_admin() then
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

-- A holder (or the manager) sends stock back to the pharmacy: unused, near expiry, or everything
-- before the store closes (p_lines null). Expired units may go back too (the pharmacy writes them off).
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

-- Lines, units and value of a note (what the send / return functions answer).
create or replace function transfer_note_totals(p_transfer_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object('id', t.id, 'number', t.number, 'direction', t.direction, 'status', t.status,
                            'lines', (select count(distinct x.item_id) from stock_transfer_line x where x.transfer_id = t.id)::integer,
                            'units', (select coalesce(sum(x.quantity), 0) from stock_transfer_line x where x.transfer_id = t.id)::integer,
                            'value', (select coalesce(sum(x.quantity * x.unit_cost), 0) from stock_transfer_line x where x.transfer_id = t.id))
  from stock_transfer t where t.id = p_transfer_id
$$;

-- The receiver confirms: everything as sent (p_lines null), or line by line
-- [{ lineId, received, reason, action: 'returned' | 'loss' }]. Only then is the stock in the store.
create or replace function confirm_receipt(p_transfer_id uuid, p_lines jsonb default null, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_t stock_transfer%rowtype;
  v_transit uuid := transit_store();
  v_line stock_transfer_line%rowtype;
  v_given jsonb;
  v_recv integer;
  v_diff integer;
  v_reason text;
  v_action text;
  v_in integer := 0;
  v_back integer := 0;
  v_lost integer := 0;
  v_store text;
begin
  select * into v_t from stock_transfer where id = p_transfer_id and deleted_at is null for update;
  if not found then
    raise exception 'transfer note not found' using errcode = 'P0002';
  end if;
  if v_t.direction = 'to_room' then
    if not (is_manager() or holds_store(auth.uid(), v_t.to_location_id)) then
      raise exception 'only the people who hold this store confirm what arrived' using errcode = '42501', hint = 'not_holder';
    end if;
  elsif not stock_admin() then
    raise exception 'only the pharmacy confirms what came back' using errcode = '42501';
  end if;
  -- two people: the one who sent the note does not also confirm it (the manager excepted)
  if v_t.created_by = auth.uid() and not is_manager() then
    raise exception 'the person who sent this note does not confirm it: the receiver does'
      using errcode = '42501', hint = 'own_note';
  end if;
  if v_t.status <> 'in_transit' then
    raise exception 'this note was already %', case v_t.status when 'received' then 'received' else 'cancelled' end
      using errcode = '23505';
  end if;
  if not exists (select 1 from stock_location where id = v_t.to_location_id and active) then
    raise exception 'the receiving store is closed: reopen it first' using errcode = '22023', hint = 'store_closed';
  end if;
  if p_lines is not null and jsonb_typeof(p_lines) <> 'array' then
    raise exception 'the lines are a list' using errcode = '22023';
  end if;
  if p_lines is not null and exists (
       select 1 from jsonb_array_elements(p_lines) x
       where not exists (select 1 from stock_transfer_line l where l.transfer_id = v_t.id
                         and l.id = nullif(x ->> 'lineId', '')::uuid)) then
    raise exception 'a line is not on this note' using errcode = '22023';
  end if;
  for v_line in select * from stock_transfer_line where transfer_id = v_t.id and deleted_at is null order by created_at for update loop
    v_given := null;
    select x.v into v_given from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as x(v)
    where (x.v ->> 'lineId')::uuid = v_line.id limit 1;
    v_recv := coalesce(nullif(v_given ->> 'received', '')::numeric, v_line.quantity);
    if v_recv < 0 or v_recv > v_line.quantity or v_recv <> round(v_recv) then
      raise exception 'received: a whole number between 0 and % for %', v_line.quantity, item_label(v_line.item_id)
        using errcode = '22023';
    end if;
    v_diff := v_line.quantity - v_recv;
    v_reason := nullif(trim(coalesce(v_given ->> 'reason', '')), '');
    v_action := case coalesce(nullif(v_given ->> 'action', ''), 'returned') when 'return' then 'returned' when 'lost' then 'loss'
                     else coalesce(nullif(v_given ->> 'action', ''), 'returned') end;
    if v_diff > 0 and length(coalesce(v_reason, '')) < 3 then
      raise exception 'say why % of % did not arrive', v_diff, item_label(v_line.item_id)
        using errcode = '22023', hint = 'difference_reason';
    end if;
    if v_diff > 0 and v_action not in ('returned', 'loss') then
      raise exception 'a difference goes back (returned) or is a loss' using errcode = '22023';
    end if;
    if v_recv > 0 then
      insert into stock_movement (item_id, batch_id, from_location_id, to_location_id, quantity, type, reason, unit_cost, stock_transfer_id)
      values (v_line.item_id, v_line.batch_id, v_transit, v_t.to_location_id, v_recv, 'transfer', 'received: ' || v_t.number,
              v_line.unit_cost, v_t.id);
      v_in := v_in + v_recv;
    end if;
    if v_diff > 0 and v_action = 'returned' then
      insert into stock_movement (item_id, batch_id, from_location_id, to_location_id, quantity, type, reason, unit_cost, stock_transfer_id)
      values (v_line.item_id, v_line.batch_id, v_transit, v_t.from_location_id, v_diff, 'transfer',
              'not received (' || v_t.number || '): ' || v_reason, v_line.unit_cost, v_t.id);
      v_back := v_back + v_diff;
    elsif v_diff > 0 then
      insert into stock_movement (item_id, batch_id, from_location_id, quantity, type, reason, unit_cost, stock_transfer_id)
      values (v_line.item_id, v_line.batch_id, v_transit, v_diff, 'adjustment',
              'lost on the way (' || v_t.number || '): ' || v_reason, v_line.unit_cost, v_t.id);
      v_lost := v_lost + v_diff;
    end if;
    update stock_transfer_line
    set received_quantity = v_recv, difference_action = case when v_diff > 0 then v_action end,
        difference_reason = case when v_diff > 0 then v_reason end
    where id = v_line.id;
  end loop;
  update stock_transfer
  set status = 'received', received_by = auth.uid(), confirmed_at = now(),
      receive_note = nullif(trim(coalesce(p_note, '')), ''), has_difference = (v_back + v_lost) > 0
  where id = v_t.id;
  v_store := (select name from stock_location where id = case when v_t.direction = 'to_room' then v_t.to_location_id
                                                               else v_t.from_location_id end);
  -- the sender is told it arrived
  insert into notification (kind, params, link, recipient_user, created_by)
  values ('transfer_received', jsonb_build_object('number', v_t.number, 'store', v_store, 'transferId', v_t.id,
                                                  'by', (select full_name from profiles where id = auth.uid()),
                                                  'missing', v_back + v_lost),
          case when v_t.direction = 'to_room' then '/app/stock?tab=rooms&note=' || v_t.id
               else '/app/stock?tab=mine&store=' || v_t.from_location_id || '&note=' || v_t.id end,
          v_t.created_by, auth.uid());
  -- a difference: the manager and the pharmacy are told
  if v_back + v_lost > 0 then
    insert into notification (kind, params, link, recipient_role, created_by)
    values ('transfer_difference', jsonb_build_object('number', v_t.number, 'store', v_store, 'transferId', v_t.id,
                                                      'returned', v_back, 'lost', v_lost,
                                                      'by', (select full_name from profiles where id = auth.uid())),
            '/app/stock?tab=rooms&note=' || v_t.id, 'manager', auth.uid());
    insert into notification (kind, params, link, recipient_stations, created_by)
    values ('transfer_difference', jsonb_build_object('number', v_t.number, 'store', v_store, 'transferId', v_t.id,
                                                      'returned', v_back, 'lost', v_lost,
                                                      'by', (select full_name from profiles where id = auth.uid())),
            '/app/stock?tab=rooms&note=' || v_t.id, array['pharmacy'::station], auth.uid());
  end if;
  return jsonb_build_object('id', v_t.id, 'number', v_t.number, 'status', 'received',
                            'received', v_in, 'returned', v_back, 'lost', v_lost);
end
$$;

-- A note not yet received is cancelled: every unit goes back where it came from.
-- To a room store: the pharmacy (or the manager). A return note: its store's holders (or the manager).
create or replace function cancel_transfer(p_transfer_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_t stock_transfer%rowtype;
  v_transit uuid := transit_store();
  v_line stock_transfer_line%rowtype;
  v_units integer := 0;
  v_store text;
begin
  select * into v_t from stock_transfer where id = p_transfer_id and deleted_at is null for update;
  if not found then
    raise exception 'transfer note not found' using errcode = 'P0002';
  end if;
  if v_t.direction = 'to_room' then
    if not stock_admin() then
      raise exception 'only the pharmacy (or the manager) cancels a note it sent' using errcode = '42501';
    end if;
  elsif not (is_manager() or holds_store(auth.uid(), v_t.from_location_id)) then
    raise exception 'only the people who hold this store (or the manager) cancel its return note' using errcode = '42501', hint = 'not_holder';
  end if;
  if v_t.status <> 'in_transit' then
    raise exception 'this note was already %', case v_t.status when 'received' then 'received' else 'cancelled' end
      using errcode = '23505';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the note is cancelled' using errcode = '22023';
  end if;
  for v_line in select * from stock_transfer_line where transfer_id = v_t.id and deleted_at is null loop
    insert into stock_movement (item_id, batch_id, from_location_id, to_location_id, quantity, type, reason, unit_cost, stock_transfer_id)
    values (v_line.item_id, v_line.batch_id, v_transit, v_t.from_location_id, v_line.quantity, 'transfer',
            'cancelled (' || v_t.number || '): ' || trim(p_reason), v_line.unit_cost, v_t.id);
    v_units := v_units + v_line.quantity;
  end loop;
  update stock_transfer set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = trim(p_reason)
  where id = v_t.id;
  -- a refill request served by this note is open again
  update store_request set status = 'open', transfer_id = null, decided_by = null, decided_at = null
  where transfer_id = v_t.id and status = 'fulfilled';
  if v_t.direction = 'to_room' then
    v_store := (select name from stock_location where id = v_t.to_location_id);
    perform notify_holders(v_t.to_location_id, 'transfer_cancelled',
                           jsonb_build_object('number', v_t.number, 'store', v_store, 'reason', trim(p_reason),
                                              'by', (select full_name from profiles where id = auth.uid())));
  else
    v_store := (select name from stock_location where id = v_t.from_location_id);
    insert into notification (kind, params, link, recipient_stations, created_by)
    values ('transfer_cancelled', jsonb_build_object('number', v_t.number, 'store', v_store, 'reason', trim(p_reason),
                                                     'by', (select full_name from profiles where id = auth.uid())),
            '/app/stock?tab=rooms&note=' || v_t.id, array['pharmacy'::station], auth.uid());
  end if;
  return jsonb_build_object('id', v_t.id, 'number', v_t.number, 'status', 'cancelled', 'units', v_units);
end
$$;

-- Transfer and return notes: the pharmacy and the manager see all; holders those of their stores.
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
      -- what the reader may do with it now
      'canReceive', t.status = 'in_transit' and case when t.direction = 'to_room'
                      then is_manager() or holds_store(auth.uid(), t.to_location_id) else stock_admin() end,
      'canCancel', t.status = 'in_transit' and case when t.direction = 'to_room'
                      then stock_admin() else is_manager() or holds_store(auth.uid(), t.from_location_id) end
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

-- One note, line by line (batch, expiry), for the screen and the printed note.
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
        'value', case when v_admin then l.quantity * l.unit_cost end
      ) order by i.name_generic, b.expiry)
      from stock_transfer_line l join item i on i.id = l.item_id join batch b on b.id = l.batch_id
      where l.transfer_id = p_id and l.deleted_at is null), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------- what is where (STORE-2, F)
-- Every store that is not deleted (closed ones too: they can be reopened), with its holders; the
-- medicines with their stock in the stores the reader may see (the pharmacy and the manager: all).
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
      'packSize', i.pack_size,
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
      'active', i.active
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
           sum(s.quantity) filter (where s.quantity > 0 and s.expiry between current_date and current_date + 90)::integer as expiring,
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

  return jsonb_build_object('locations', v_locations, 'items', v_items, 'admin', v_admin, 'mainPharmacyId', v_main,
                            'transit', case when v_admin then jsonb_build_object(
                              'units', (select coalesce(sum(s.quantity), 0) from stock_on_hand s where s.location_id = v_transit),
                              'value', (select coalesce(sum(s.quantity * coalesce(b.unit_cost, 0)), 0) from stock_on_hand s
                                        left join batch b on b.id = s.batch_id where s.location_id = v_transit),
                              'notes', (select count(*) from stock_transfer where status = 'in_transit')) end);
end
$$;

-- The ledger of a period: the pharmacy and the manager see every store, holders their own stores.
drop function if exists stock_movements(date, date, uuid);
create or replace function stock_movements(p_from date, p_to date, p_item_id uuid default null, p_location_id uuid default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'at', m.moved_at, 'type', m.type, 'itemId', m.item_id, 'item', i.name_generic || coalesce(' ' || i.strength, ''),
    'quantity', m.quantity, 'fromId', m.from_location_id, 'from', lf.name, 'toId', m.to_location_id, 'to', lt.name,
    'batch', b.batch_no, 'expiry', b.expiry,
    'unitCost', case when stock_admin() then coalesce(m.unit_cost, b.unit_cost) end,
    'value', case when stock_admin() then m.quantity * coalesce(m.unit_cost, b.unit_cost, 0) end,
    'reason', m.reason, 'by', pr.full_name,
    'transferId', m.stock_transfer_id, 'transfer', (select t.number from stock_transfer t where t.id = m.stock_transfer_id),
    'delivery', (select g.number from goods_receipt g where g.id = m.goods_receipt_id),
    'sale', (select cs.number from counter_sale cs where cs.id = m.counter_sale_id),
    'requestId', m.medication_request_id
  ) order by m.moved_at desc), '[]'::jsonb)
  from stock_movement m
  join item i on i.id = m.item_id
  left join batch b on b.id = m.batch_id
  left join stock_location lf on lf.id = m.from_location_id
  left join stock_location lt on lt.id = m.to_location_id
  left join profiles pr on pr.id = m.created_by
  where m.deleted_at is null
    and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to
    and (p_item_id is null or m.item_id = p_item_id)
    and (p_location_id is null or m.from_location_id = p_location_id or m.to_location_id = p_location_id)
    and (stock_admin() or holds_store(auth.uid(), m.from_location_id) or holds_store(auth.uid(), m.to_location_id))
$$;

-- ---------------------------------------------------------------- alerts (ALERT-1)
create or replace function stock_alerts()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_admin boolean := stock_admin();
  v_vis uuid[] := visible_stores();
begin
  return jsonb_build_object(
    -- the pharmacy: unexpired units at or below the reorder level
    'low', case when v_admin then coalesce((
      select jsonb_agg(jsonb_build_object('itemId', r.item_id, 'item', item_label(r.item_id), 'code', r.code,
                                          'onHand', r.on_hand, 'level', r.reorder_level,
                                          'maxLevel', (select max_level from item where id = r.item_id))
                       order by r.on_hand::numeric / greatest(r.reorder_level, 1), r.name_generic)
      from items_below_reorder r), '[]'::jsonb) else '[]'::jsonb end,
    -- a room store below the minimum set for it
    'roomLow', coalesce((
      select jsonb_agg(jsonb_build_object('storeId', l.id, 'store', l.name, 'itemId', m.item_id, 'item', item_label(m.item_id),
                                          'onHand', usable_stock(m.item_id, l.id), 'min', m.min_level)
                       order by l.name)
      from store_item_level m join stock_location l on l.id = m.location_id and l.active and l.deleted_at is null
      where (v_vis is null or l.id = any (v_vis)) and usable_stock(m.item_id, l.id) < m.min_level), '[]'::jsonb),
    -- expiring within 90 days (not expired yet), batch by batch
    'expiring', coalesce((
      select jsonb_agg(jsonb_build_object('storeId', l.id, 'store', l.name, 'itemId', s.item_id, 'item', item_label(s.item_id),
                                          'batchNo', b.batch_no, 'expiry', s.expiry, 'quantity', s.quantity,
                                          'days', s.expiry - current_date)
                       order by s.expiry, l.name)
      from stock_on_hand s join stock_location l on l.id = s.location_id and l.deleted_at is null and l.type::text <> 'transit'
      left join batch b on b.id = s.batch_id
      where s.quantity > 0 and s.expiry between current_date and current_date + 90
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

-- One rule everywhere: low = unexpired units in the open pharmacy stores at or below the level.
create or replace view items_below_reorder as
  select i.id as item_id, i.code, i.name_generic, i.reorder_level, coalesce(p.q, 0)::integer as on_hand
  from item i
  left join lateral (
    select sum(s.quantity) as q from stock_on_hand s join stock_location l on l.id = s.location_id
    where s.item_id = i.id and l.type = 'pharmacy' and l.active and l.deleted_at is null and s.quantity > 0
      and (s.expiry is null or s.expiry >= current_date)
  ) p on true
  where i.active and i.deleted_at is null and i.reorder_level > 0 and coalesce(p.q, 0) <= i.reorder_level;

-- ---------------------------------------------------------------- what to order (REORDER)
drop function if exists set_reorder_level(uuid, integer);
create or replace function set_reorder_level(p_item_id uuid, p_level integer, p_max_level integer default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not (has_perm('catalogue.write') or has_perm('item_price.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_level is null or p_level < 0 then
    raise exception 'the level must be zero or more' using errcode = '22023';
  end if;
  if p_max_level is not null and p_max_level < 0 then
    raise exception 'the most to keep must be zero or more' using errcode = '22023';
  end if;
  if coalesce(p_max_level, 0) > 0 and p_max_level <= p_level then
    raise exception 'the most to keep must be above the reorder level' using errcode = '22023';
  end if;
  update item
  set reorder_level = p_level,
      max_level = case when p_max_level is null then max_level when p_max_level = 0 then null else p_max_level end,
      updated_at = now()
  where id = p_item_id and deleted_at is null;
  if not found then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  perform check_pharmacy_low(p_item_id);
end
$$;

-- The medicines to order: unexpired pharmacy units at or below the level, with a quantity up to the
-- most to keep (max level; else twice the level or two months of use), the last supplier and cost,
-- and the average use per month (90 days: handed over, sold, given in the rooms).
create or replace function reorder_suggestions()
returns jsonb
language sql stable security definer set search_path = public
as $$
  with low as (
    select r.item_id, r.on_hand, r.reorder_level, i.max_level, i.pack_size, i.selling_unit, i.code, i.name_generic
    from items_below_reorder r join item i on i.id = r.item_id
  ), use90 as (
    select m.item_id,
           sum(case when m.type in ('dispense', 'consumption') then m.quantity else -m.quantity end) as units
    from stock_movement m
    left join stock_location lf on lf.id = m.from_location_id
    where m.deleted_at is null and m.moved_at > now() - interval '90 days'
      and m.item_id in (select item_id from low)
      and ((m.type = 'dispense' and lf.type = 'pharmacy')
           or (m.type = 'consumption' and m.medication_request_id is not null)
           or (m.type = 'return' and (m.dispense_id is not null or m.medication_request_id is not null)))
    group by m.item_id
  ), last_in as (
    select distinct on (m.item_id) m.item_id, m.moved_at, coalesce(m.unit_cost, b.unit_cost) as unit_cost,
           coalesce(g.supplier_name, s.name, nullif(m.reason, '')) as supplier
    from stock_movement m
    left join batch b on b.id = m.batch_id
    left join goods_receipt g on g.id = m.goods_receipt_id
    left join supplier s on s.id = coalesce(g.supplier_id, b.supplier_id)
    where m.deleted_at is null and m.type = 'receipt' and m.item_id in (select item_id from low)
    order by m.item_id, m.moved_at desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'itemId', l.item_id, 'item', item_label(l.item_id), 'code', l.code, 'unit', l.selling_unit, 'packSize', l.pack_size,
      'onHand', l.on_hand, 'level', l.reorder_level, 'maxLevel', l.max_level,
      'inRooms', (select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s join stock_location x on x.id = s.location_id
                  where s.item_id = l.item_id and x.active and x.deleted_at is null and is_room_type(x.type) and s.quantity > 0
                    and (s.expiry is null or s.expiry >= current_date)),
      'monthlyUse', round(greatest(coalesce(u.units, 0), 0) / 3.0, 1),
      'suggested', z.suggested,
      'suggestedBoxes', case when coalesce(l.pack_size, 0) > 1 then ceil(z.suggested::numeric / l.pack_size)::integer end,
      'lastSupplier', li.supplier, 'lastCost', li.unit_cost, 'lastReceivedAt', li.moved_at,
      'estimatedCost', round(z.suggested * coalesce(li.unit_cost, 0))
    ) order by l.on_hand::numeric / greatest(l.reorder_level, 1), l.name_generic), '[]'::jsonb)
  from low l
  left join use90 u on u.item_id = l.item_id
  left join last_in li on li.item_id = l.item_id
  cross join lateral (
    select greatest(0, coalesce(nullif(l.max_level, 0),
                                greatest(l.reorder_level * 2, ceil(greatest(coalesce(u.units, 0), 0) / 3.0 * 2)::integer))
                       - l.on_hand)::integer as suggested
  ) z
  where stock_admin()
$$;

-- ---------------------------------------------------------------- catalogue (CAT-1)
create or replace function delete_item(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_units integer;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(sum(quantity), 0)::integer into v_units from stock_on_hand where item_id = p_id and quantity > 0;
  if v_units > 0 then
    raise exception 'this medicine still has % unit(s) in stock: switch it off instead of deleting it', v_units
      using errcode = '23514', hint = 'has_stock';
  end if;
  update item set deleted_at = now(), active = false where id = p_id and deleted_at is null;
  if not found then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------- counter sales (a walk-in pays first)
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
    insert into counter_sale_line (sale_id, item_id, quantity, unit_price, line_total)
    values (v_id, v_line.item_id, v_line.quantity, round(v_price), round(v_price) * v_line.quantity);
    v_total := v_total + round(v_price) * v_line.quantity;
  end loop;
  update counter_sale set total = v_total where id = v_id;
  insert into notification (kind, params, link, recipient_stations, created_by)
  values ('counter_sale_to_pay', jsonb_build_object('number', v_number, 'amount', v_total,
                                                    'buyer', nullif(trim(coalesce(p_buyer_name, '')), ''), 'saleId', v_id),
          '/app/bills?sale=' || v_id, array['cashier'::station], auth.uid());
  return jsonb_build_object('id', v_id, 'number', v_number, 'total', v_total, 'status', 'open');
end
$$;

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
begin
  if not has_perm('payment.take') then
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
  -- no money for medicines no longer on the shelf
  select string_agg(item_label(l.item_id), ', ') into v_short
  from counter_sale_line l
  where l.sale_id = v_s.id and l.deleted_at is null and usable_stock(l.item_id, v_s.location_id) < l.quantity;
  if v_short is not null then
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
  insert into notification (kind, params, link, recipient_stations, created_by)
  values ('counter_sale_paid', jsonb_build_object('number', v_s.number, 'amount', v_s.total, 'buyer', v_s.buyer_name,
                                                  'saleId', v_s.id),
          '/app/stock?tab=pharmacy&sale=' || v_s.id, array['pharmacy'::station], auth.uid());
  return jsonb_build_object('id', v_s.id, 'number', v_s.number, 'status', 'paid', 'amount', v_s.total,
                            'receipt', v_receipt, 'paymentId', v_pay);
end
$$;

-- Internal: a paid sale's units leave the pharmacy store (earliest expiry first, never expired),
-- with a lock, at payment time. They wait on the counter for the buyer.
create or replace function counter_sale_take(p_sale_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_s counter_sale%rowtype;
  v_line counter_sale_line%rowtype;
  v_remaining integer;
  v_row record;
  v_take integer;
begin
  select * into v_s from counter_sale where id = p_sale_id;
  for v_line in select * from counter_sale_line where sale_id = v_s.id and deleted_at is null order by item_id loop
    perform lock_stock(v_line.item_id, v_s.location_id);
    v_remaining := v_line.quantity;
    for v_row in
      select s.batch_id, s.quantity, coalesce(b.unit_cost, 0) as unit_cost
      from stock_on_hand s left join batch b on b.id = s.batch_id
      where s.item_id = v_line.item_id and s.location_id = v_s.location_id and s.quantity > 0 and s.batch_id is not null
        and (s.expiry is null or s.expiry >= current_date)
      order by s.expiry asc nulls last
    loop
      exit when v_remaining <= 0;
      v_take := least(v_row.quantity, v_remaining);
      insert into stock_movement (item_id, batch_id, from_location_id, quantity, type, reason, unit_cost, counter_sale_id)
      values (v_line.item_id, v_row.batch_id, v_s.location_id, v_take, 'dispense', 'counter sale ' || v_s.number,
              v_row.unit_cost, v_s.id);
      v_remaining := v_remaining - v_take;
    end loop;
    if v_remaining > 0 then
      raise exception 'not enough % (not expired) in the pharmacy: % unit(s) short', item_label(v_line.item_id), v_remaining
        using errcode = '23514', hint = 'short';
    end if;
  end loop;
end
$$;

-- Internal: what a sale holds now, per medicine and batch (taken minus put back).
create or replace function counter_sale_held(p_sale_id uuid)
returns table (item_id uuid, batch_id uuid, quantity integer, unit_cost numeric)
language sql stable security definer set search_path = public
as $$
  select m.item_id, m.batch_id,
         sum(case when m.type = 'dispense' then m.quantity else -m.quantity end)::integer,
         max(m.unit_cost)
  from stock_movement m
  where m.counter_sale_id = p_sale_id and m.deleted_at is null
  group by m.item_id, m.batch_id
  having sum(case when m.type = 'dispense' then m.quantity else -m.quantity end) > 0
$$;

-- After payment the pharmacy hands the medicines over: the units taken at payment (earliest expiry
-- first, never expired).
create or replace function hand_over_counter_sale(p_sale_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_s counter_sale%rowtype;
  v_lines jsonb;
begin
  if not stock_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_s from counter_sale where id = p_sale_id and deleted_at is null for update;
  if not found or v_s.status = 'cancelled' then
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

create or replace function cancel_counter_sale(p_sale_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_s counter_sale%rowtype;
begin
  if not (stock_admin() or has_perm('payment.take')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the sale is cancelled' using errcode = '22023';
  end if;
  select * into v_s from counter_sale where id = p_sale_id and deleted_at is null for update;
  if not found then
    raise exception 'sale not found' using errcode = 'P0002';
  end if;
  if v_s.status <> 'open' then
    raise exception 'only an unpaid sale is cancelled (a payment is cancelled at the cashier first)' using errcode = '23505';
  end if;
  update counter_sale set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = trim(p_reason)
  where id = v_s.id;
end
$$;

-- Counter sales: open and paid ones (any day) and the others of the period (default: the last 7 days).
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

-- A payment cancelled: a visit's bill owes it again; a counter sale not handed over is unpaid again.
create or replace function void_payment(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_p payment%rowtype;
  v_enc uuid;
  v_sale counter_sale%rowtype;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the payment is cancelled' using errcode = '22023';
  end if;
  select * into v_p from payment where id = p_payment_id and deleted_at is null for update;
  if not found then
    raise exception 'payment not found or already cancelled' using errcode = 'P0002';
  end if;
  if not is_manager() then
    if not (has_perm('billing.write') or has_perm('payment.take')) or v_p.cashier_id is distinct from auth.uid() then
      raise exception 'only the person who took the payment (or the manager) can cancel it' using errcode = '42501';
    end if;
    if (v_p.paid_at at time zone 'Africa/Kigali')::date <> (now() at time zone 'Africa/Kigali')::date then
      raise exception 'a payment of another day is cancelled by the manager' using errcode = '42501';
    end if;
    if v_p.day_close_id is not null then
      raise exception 'the cash of that day is already counted: ask the manager' using errcode = '42501';
    end if;
  end if;
  if v_p.counter_sale_id is not null then
    select * into v_sale from counter_sale where id = v_p.counter_sale_id for update;
    if v_sale.status = 'handed_over' then
      raise exception 'the medicines of this sale were already handed over' using errcode = '23514';
    end if;
  end if;
  update payment set deleted_at = now(), void_reason = trim(p_reason), voided_by = auth.uid(), voided_at = now()
  where id = p_payment_id;
  if v_p.counter_sale_id is not null then
    -- the units taken at payment go back on the shelf
    insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason, unit_cost, counter_sale_id)
    select h.item_id, h.batch_id, v_sale.location_id, h.quantity, 'return',
           'payment cancelled: ' || v_sale.number, h.unit_cost, v_sale.id
    from counter_sale_held(v_sale.id) h;
    update counter_sale set status = 'open', paid_at = null, payment_id = null where id = v_p.counter_sale_id;
    return jsonb_build_object('encounterId', null, 'counterSaleId', v_p.counter_sale_id, 'balance', v_sale.total);
  end if;
  select encounter_id into v_enc from invoice where id = v_p.invoice_id;
  return jsonb_build_object('encounterId', v_enc, 'balance', invoice_balance(v_p.invoice_id));
end
$$;

-- The cash desk: counter sales are payments like the others (the same totals, cash count and
-- receipts); the list says which sale, and the sales waiting to be paid are listed.
create or replace function cashier_summary(p_day date default null, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, p_day, v_today);
  v_to date := coalesce(p_to, p_day, p_from, v_today);
  v_day date;
  v_len integer;
begin
  if not has_perm('billing.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  v_day := coalesce(p_day, v_to);
  v_len := v_to - v_from + 1;
  return jsonb_build_object(
    'day', v_day,
    'from', v_from,
    'to', v_to,
    'total', (select coalesce(sum(amount), 0) from payment
              where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'count', (select count(*) from payment
              where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'previousTotal', (select coalesce(sum(amount), 0) from payment
                      where deleted_at is null
                        and (paid_at at time zone 'Africa/Kigali')::date between v_from - v_len and v_from - 1
                        and (v_to <> v_today or paid_at <= now() - make_interval(days => v_len))),
    'served', (select count(distinct q.encounter_id) from queue_entry q
               where q.deleted_at is null and q.station = 'cashier' and q.finished_at is not null
                 and (q.finished_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'refunded', (select coalesce(sum(amount), 0) from refund
                 where deleted_at is null and (refunded_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'refunds', coalesce((
      select jsonb_agg(x.j order by x.at desc) from (
        select r.refunded_at as at, jsonb_build_object(
            'id', r.id, 'at', r.refunded_at, 'method', r.method, 'amount', r.amount, 'reference', r.reference,
            'reason', r.reason, 'patient', p.surname || ' ' || p.given_names,
            'cashier', (select full_name from profiles where id = r.cashier_id), 'mine', r.cashier_id = auth.uid()
          ) as j
        from refund r
        join invoice i on i.id = r.invoice_id
        join encounter e on e.id = i.encounter_id
        join patient p on p.id = e.patient_id
        where r.deleted_at is null and (r.refunded_at at time zone 'Africa/Kigali')::date between v_from and v_to
        order by r.refunded_at desc limit 500) x
    ), '[]'::jsonb),
    'debts', (select count(*) from invoice i join encounter e on e.id = i.encounter_id
              where i.deleted_at is null and e.status <> 'open' and invoice_balance(i.id) > 0),
    'debtsDue', (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id
                 where i.deleted_at is null and e.status <> 'open' and invoice_balance(i.id) > 0),
    'mine', (select coalesce(sum(amount), 0) from payment
             where deleted_at is null and cashier_id = auth.uid()
               and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'byMethod', coalesce((
      select jsonb_agg(jsonb_build_object('method', m.method, 'amount', m.amount, 'count', m.n) order by m.amount desc)
      from (select method::text as method, sum(amount) as amount, count(*) as n from payment
            where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
            group by method) m
    ), '[]'::jsonb),
    'byCashier', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.name, 'amount', c.amount, 'count', c.n) order by c.amount desc)
      from (select coalesce(pr.full_name, '—') as name, sum(pa.amount) as amount, count(*) as n
            from payment pa left join profiles pr on pr.id = pa.cashier_id
            where pa.deleted_at is null and (pa.paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
            group by pr.full_name) c
    ), '[]'::jsonb),
    -- the payments of the period: visits' bills and counter sales
    'payments', coalesce((
      select jsonb_agg(x.j order by x.at desc) from (
        select pa.paid_at as at, jsonb_build_object(
            'id', pa.id, 'at', pa.paid_at, 'method', pa.method, 'amount', pa.amount, 'reference', pa.reference,
            'invoice', i.number, 'encounterId', i.encounter_id,
            'patient', coalesce(p.surname || ' ' || p.given_names, cs.buyer_name),
            'fileNumber', p.file_number,
            'counterSaleId', cs.id, 'counterSale', cs.number,
            'cashier', pr.full_name, 'receipt', pa.receipt_no,
            'mine', pa.cashier_id = auth.uid(), 'counted', pa.day_close_id is not null
          ) as j
        from payment pa
        left join invoice i on i.id = pa.invoice_id
        left join encounter e on e.id = i.encounter_id
        left join patient p on p.id = e.patient_id
        left join counter_sale cs on cs.id = pa.counter_sale_id
        left join profiles pr on pr.id = pa.cashier_id
        where pa.deleted_at is null and (pa.paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
        order by pa.paid_at desc limit 500) x
    ), '[]'::jsonb),
    'voided', coalesce((
      select jsonb_agg(x.j order by x.at desc) from (
        select pa.voided_at as at, jsonb_build_object(
            'id', pa.id, 'at', pa.paid_at, 'method', pa.method, 'amount', pa.amount, 'receipt', pa.receipt_no,
            'patient', coalesce(p.surname || ' ' || p.given_names, cs.buyer_name),
            'counterSale', cs.number, 'reason', pa.void_reason,
            'by', (select full_name from profiles where id = pa.voided_by), 'voidedAt', pa.voided_at
          ) as j
        from payment pa
        left join invoice i on i.id = pa.invoice_id
        left join encounter e on e.id = i.encounter_id
        left join patient p on p.id = e.patient_id
        left join counter_sale cs on cs.id = pa.counter_sale_id
        where pa.deleted_at is not null and pa.voided_at is not null
          and (pa.paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
        order by pa.voided_at desc limit 500) x
    ), '[]'::jsonb),
    'closes', coalesce((
      select jsonb_agg(jsonb_build_object(
          'cashier', pr.full_name, 'mine', d.cashier_id = auth.uid(), 'expected', d.expected,
          'counted', d.counted, 'variance', d.variance, 'note', d.note, 'at', d.updated_at
        ) order by pr.full_name)
      from day_close d left join profiles pr on pr.id = d.cashier_id
      where d.deleted_at is null and d.date = v_day
    ), '[]'::jsonb),
    'myExpected', coalesce((
      select jsonb_object_agg(n.method, n.amount) from (select m.method, sum(m.amount) as amount from (
          select method::text as method, amount from payment
          where deleted_at is null and cashier_id = auth.uid() and (paid_at at time zone 'Africa/Kigali')::date = v_day
          union all
          select method::text, -amount from refund
          where deleted_at is null and cashier_id = auth.uid() and (refunded_at at time zone 'Africa/Kigali')::date = v_day
        ) m group by m.method) n
    ), '{}'::jsonb),
    'openBills', (select count(*) from invoice i join encounter e on e.id = i.encounter_id
                  where i.deleted_at is null and i.status = 'draft' and e.status = 'open' and invoice_balance(i.id) > 0),
    'openDue', (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id
                where i.deleted_at is null and i.status = 'draft' and e.status = 'open' and invoice_balance(i.id) > 0),
    -- counter sales (walk-in buyers): paid in the period, and those waiting to pay now
    'counterSales', jsonb_build_object(
      'count', (select count(*) from payment where deleted_at is null and counter_sale_id is not null
                and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to),
      'total', (select coalesce(sum(amount), 0) from payment where deleted_at is null and counter_sale_id is not null
                and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to)),
    'counterToPay', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', s.id, 'number', s.number, 'buyer', s.buyer_name, 'phone', s.buyer_phone, 'total', s.total,
          'at', s.created_at, 'by', (select full_name from profiles where id = s.created_by),
          'lines', (select count(*) from counter_sale_line x where x.sale_id = s.id and x.deleted_at is null)
        ) order by s.created_at)
      from counter_sale s where s.deleted_at is null and s.status = 'open'
    ), '[]'::jsonb)
  );
end
$$;

-- The pharmacy dashboard: also counter sales, refill requests and returns waiting.
create or replace function pharmacy_summary(p_from date default null, p_to date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with today as (
    select coalesce(p_from, k) as f, coalesce(p_to, p_from, k) as t
    from (select (now() at time zone 'Africa/Kigali')::date as k) z
  ),
  pending as (
    select m.* from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open'
    where rx_pending(m)
  ),
  given as (
    select m.* from medication_request m, today
    where m.deleted_at is null and m.supply = 'pharmacy' and m.given_at is not null
      and (m.given_at at time zone 'Africa/Kigali')::date between today.f and today.t
  ),
  sold as (
    select s.* from counter_sale s, today
    where s.deleted_at is null and s.status = 'handed_over'
      and (s.handed_over_at at time zone 'Africa/Kigali')::date between today.f and today.t
  )
  select jsonb_build_object(
    'lines', (select count(*) from pending),
    'patients', (select count(distinct encounter_id) from pending),
    'dispensedToday', (select count(*) from given),
    'patientsServedToday', (select count(distinct encounter_id) from given),
    'notGivenToday', (select count(*) from medication_request m, today
                      where m.deleted_at is null and (m.not_given_at at time zone 'Africa/Kigali')::date between today.f and today.t),
    'salesToday', (select coalesce(sum(l.patient_share + l.insurer_share), 0) from invoice_line l, today
                   where l.deleted_at is null and l.source_type = 'medication_dispense'
                     and (l.created_at at time zone 'Africa/Kigali')::date between today.f and today.t),
    'topToday', coalesce((select jsonb_agg(x order by x.count desc, x.item) from (
                   select i.name_generic || coalesce(' ' || i.strength, '') as item, count(*)::int as count
                   from given g join item i on i.id = g.item_id group by 1 order by 2 desc limit 5) x), '[]'::jsonb),
    'notGiven', coalesce((select jsonb_agg(jsonb_build_object(
                   'item', i.name_generic || coalesce(' ' || i.strength, ''), 'patient', p.surname || ' ' || p.given_names,
                   'reason', m.not_given_reason, 'at', m.not_given_at) order by m.not_given_at desc)
                 from medication_request m, today, item i, encounter e, patient p
                 where m.deleted_at is null and i.id = m.item_id and e.id = m.encounter_id and p.id = e.patient_id
                   and (m.not_given_at at time zone 'Africa/Kigali')::date between today.f and today.t), '[]'::jsonb),
    -- counter sales handed over in the period; sales waiting to be paid / to be handed over now
    'counterSales', (select count(*) from sold),
    'counterSalesTotal', (select coalesce(sum(total), 0) from sold),
    'counterToPay', (select count(*) from counter_sale where deleted_at is null and status = 'open'),
    'counterToHandOver', (select count(*) from counter_sale where deleted_at is null and status = 'paid'),
    -- room stores: refills asked, returns to confirm
    'refillsOpen', (select count(*) from store_request where deleted_at is null and status = 'open'),
    'returnsToConfirm', (select count(*) from stock_transfer where deleted_at is null and status = 'in_transit'
                         and direction = 'to_pharmacy'),
    'notesOnTheWay', (select count(*) from stock_transfer where deleted_at is null and status = 'in_transit'
                      and direction = 'to_room')
  )
  where has_perm('stock.read')
$$;

-- What was sold per medicine in a period (bills and counter sales), at the cost of the receipts.
create or replace function stock_sales(p_from date, p_to date)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with sold as (
    select l.item_id, l.quantity::numeric as units, round(l.quantity * l.unit_price) as revenue
    from invoice_line l
    join invoice inv on inv.id = l.invoice_id and inv.status <> 'credited'
    where l.deleted_at is null and l.item_id is not null
      and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    union all
    select x.item_id, x.quantity, x.line_total
    from counter_sale_line x join counter_sale s on s.id = x.sale_id
    where x.deleted_at is null and s.deleted_at is null and s.status = 'handed_over'
      and (s.handed_over_at at time zone 'Africa/Kigali')::date between p_from and p_to
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'item', x.name, 'units', x.units, 'revenue', x.revenue, 'cost', x.cost, 'margin', x.revenue - x.cost
      ) order by x.revenue desc)
      from (
        select i.name_generic || coalesce(' ' || i.strength, '') as name,
               sum(s.units) as units,
               sum(s.revenue) as revenue,
               round(sum(s.units) * coalesce((
                 select sum(coalesce(m.unit_cost, b.unit_cost) * m.quantity) / nullif(sum(m.quantity), 0)
                 from stock_movement m join batch b on b.id = m.batch_id
                 where m.item_id = i.id and m.type = 'receipt' and m.deleted_at is null and b.deleted_at is null), 0), 2) as cost
        from sold s join item i on i.id = s.item_id
        group by i.id, i.name_generic, i.strength
      ) x), '[]'::jsonb),
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

-- The cash count: card and bank (counter sales) are counted too, so a card sale counted right
-- gives no difference. (As 20261105090000_desks_wave7.sql; only the methods kept from the count change.)
create or replace function close_cash_day(p_day date, p_counted jsonb, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_day date := coalesce(p_day, (now() at time zone 'Africa/Kigali')::date);
  v_expected jsonb;
  v_counted jsonb := '{}'::jsonb;
  v_variance numeric;
  v_id uuid;
  v_key text;
  v_val text;
begin
  if not (has_perm('billing.write') or has_perm('payment.take')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(jsonb_object_agg(n.method, n.amount), '{}'::jsonb) into v_expected
  from (select m.method, sum(m.amount) as amount from (
          select method::text as method, amount from payment
          where deleted_at is null and cashier_id = auth.uid() and (paid_at at time zone 'Africa/Kigali')::date = v_day
          union all
          select method::text, -amount from refund
          where deleted_at is null and cashier_id = auth.uid() and (refunded_at at time zone 'Africa/Kigali')::date = v_day
        ) m group by m.method) n;
  for v_key, v_val in select key, value from jsonb_each_text(coalesce(p_counted, '{}'::jsonb)) loop
    if v_key in ('cash', 'momo', 'airtel', 'card', 'bank') and v_val ~ '^[0-9]+$' then
      v_counted := v_counted || jsonb_build_object(v_key, v_val::numeric);
    end if;
  end loop;
  v_variance := coalesce((select sum(value::numeric) from jsonb_each_text(v_counted)), 0)
              - coalesce((select sum(value::numeric) from jsonb_each_text(v_expected)), 0);
  insert into day_close (date, cashier_id, expected, counted, variance, note)
  values (v_day, auth.uid(), v_expected, v_counted, v_variance, nullif(trim(coalesce(p_note, '')), ''))
  on conflict (date, cashier_id) do update
  set expected = excluded.expected, counted = excluded.counted, variance = excluded.variance,
      note = excluded.note, updated_at = now()
  returning id into v_id;
  update payment set day_close_id = v_id
  where deleted_at is null and cashier_id = auth.uid() and (paid_at at time zone 'Africa/Kigali')::date = v_day;
  return jsonb_build_object('id', v_id, 'expected', v_expected, 'counted', v_counted, 'variance', v_variance);
end
$$;

-- ---------------------------------------------------------------- the room store report
-- One room store over a period: its stock now (and value), what it gave to patients (lines,
-- patients, units, cost, what was charged), received from the pharmacy, sent back, and the losses
-- (written off, count differences). Its holders, the pharmacy and the manager; values for the
-- pharmacy and the manager.
create or replace function room_store_summary(p_store uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_l stock_location%rowtype;
  v_from date := coalesce(p_from, date_trunc('month', now() at time zone 'Africa/Kigali')::date);
  v_to date := coalesce(p_to, (now() at time zone 'Africa/Kigali')::date);
  v_admin boolean := stock_admin();
  v_out jsonb;
begin
  select * into v_l from stock_location where id = p_store and deleted_at is null;
  if not found or not is_room_type(v_l.type) then
    raise exception 'room store not found' using errcode = 'P0002';
  end if;
  if not may_see_store(p_store) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  with moves as (
    select m.item_id,
           case
             when m.type = 'consumption' and m.from_location_id = p_store and m.medication_request_id is not null then 'given'
             when m.type = 'consumption' and m.from_location_id = p_store then 'written_off'
             when m.type = 'adjustment' and m.from_location_id = p_store then 'count_down'
             when m.type = 'adjustment' and m.to_location_id = p_store then 'count_up'
             when m.type = 'transfer' and m.from_location_id = p_store then 'returned'
             when m.type = 'transfer' and m.to_location_id = p_store and t.direction = 'to_pharmacy' then 'came_back'
             when m.type in ('transfer', 'receipt') and m.to_location_id = p_store then 'received'
             when m.type = 'return' and m.to_location_id = p_store then 'given_back'
             else 'other'
           end as kind,
           m.quantity, m.quantity * coalesce(m.unit_cost, b.unit_cost, 0) as value,
           m.medication_request_id as request_id, m.stock_transfer_id as transfer_id
    from stock_movement m
    left join batch b on b.id = m.batch_id
    left join stock_transfer t on t.id = m.stock_transfer_id
    where m.deleted_at is null and (m.from_location_id = p_store or m.to_location_id = p_store)
      and (m.moved_at at time zone 'Africa/Kigali')::date between v_from and v_to
  ), by_item as (
    select item_id,
           coalesce(sum(quantity) filter (where kind = 'given'), 0)
             - coalesce(sum(quantity) filter (where kind = 'given_back'), 0) as given,
           coalesce(sum(quantity) filter (where kind = 'received'), 0) as received,
           coalesce(sum(quantity) filter (where kind = 'returned'), 0)
             - coalesce(sum(quantity) filter (where kind = 'came_back'), 0) as returned,
           coalesce(sum(quantity) filter (where kind = 'written_off'), 0) as written_off,
           coalesce(sum(quantity) filter (where kind = 'count_up'), 0)
             - coalesce(sum(quantity) filter (where kind = 'count_down'), 0) as count_diff
    from moves group by item_id
  )
  select jsonb_build_object(
    'store', jsonb_build_object('id', v_l.id, 'name', v_l.name, 'type', v_l.type, 'active', v_l.active,
                                'holders', store_holders(v_l.id)),
    'from', v_from, 'to', v_to,
    'stock', jsonb_build_object(
      'units', (select coalesce(sum(s.quantity), 0) from stock_on_hand s where s.location_id = p_store and s.quantity > 0),
      'expiredUnits', (select coalesce(sum(s.quantity), 0) from stock_on_hand s where s.location_id = p_store
                       and s.quantity > 0 and s.expiry < current_date),
      'value', case when v_admin then (select coalesce(sum(s.quantity * coalesce(b.unit_cost, 0)), 0)
                                       from stock_on_hand s left join batch b on b.id = s.batch_id
                                       where s.location_id = p_store and s.quantity > 0) end),
    'given', jsonb_build_object(
      'lines', (select count(distinct request_id) from moves where kind = 'given'),
      'patients', (select count(distinct r.encounter_id) from medication_request r
                   where r.id in (select request_id from moves where kind = 'given')),
      'units', (select coalesce(sum(quantity), 0) from moves where kind = 'given')
               - (select coalesce(sum(quantity), 0) from moves where kind = 'given_back'),
      'value', case when v_admin then (select coalesce(sum(value), 0) from moves where kind = 'given') end,
      -- what the patients' bills say for them
      'charged', (select coalesce(sum(l.patient_share + l.insurer_share), 0) from invoice_line l
                  where l.deleted_at is null and l.source_type = 'medication_request'
                    and l.source_id in (select request_id from moves where kind = 'given'))),
    'received', jsonb_build_object(
      'notes', (select count(distinct transfer_id) from moves where kind = 'received'),
      'units', (select coalesce(sum(quantity), 0) from moves where kind = 'received'),
      'value', case when v_admin then (select coalesce(sum(value), 0) from moves where kind = 'received') end),
    'returned', jsonb_build_object(
      'notes', (select count(distinct transfer_id) from moves where kind = 'returned'),
      'units', (select coalesce(sum(quantity), 0) from moves where kind = 'returned')
               - (select coalesce(sum(quantity), 0) from moves where kind = 'came_back'),
      'value', case when v_admin then (select coalesce(sum(value), 0) from moves where kind = 'returned')
                                      - (select coalesce(sum(value), 0) from moves where kind = 'came_back') end),
    'losses', jsonb_build_object(
      'writtenOff', (select coalesce(sum(quantity), 0) from moves where kind = 'written_off'),
      'writtenOffValue', case when v_admin then (select coalesce(sum(value), 0) from moves where kind = 'written_off') end,
      'countDown', (select coalesce(sum(quantity), 0) from moves where kind = 'count_down'),
      'countUp', (select coalesce(sum(quantity), 0) from moves where kind = 'count_up'),
      'countValue', case when v_admin then (select coalesce(sum(value), 0) from moves where kind = 'count_down')
                                          - (select coalesce(sum(value), 0) from moves where kind = 'count_up') end),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'itemId', y.item_id, 'item', item_label(y.item_id), 'given', y.given, 'received', y.received,
        'returned', y.returned, 'writtenOff', y.written_off, 'countDiff', y.count_diff,
        'onHand', (select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s
                   where s.item_id = y.item_id and s.location_id = p_store)
      ) order by y.given desc, item_label(y.item_id)) from by_item y), '[]'::jsonb)
  ) into v_out;
  return v_out;
end
$$;

-- ---------------------------------------------------------------- who holds the stores today
-- The people who actually gave from a store in the last 180 days hold it (a doctor's office store
-- stays with that doctor). A store given to a department keeps it as holder. A lab or nursing store
-- nobody holds yet is held by the departments of that role (else each lab technician / nurse), so the
-- work goes on; the manager changes it under Stock → Room stores ("Stores without a holder").
insert into stock_location_holder (location_id, profile_id)
select distinct l.id, m.created_by from stock_location l
join stock_movement m on m.from_location_id = l.id and m.type = 'consumption' and m.deleted_at is null
  and m.created_at >= now() - interval '180 days' and m.created_by is not null
join profiles p on p.id = m.created_by and p.active and p.role::text not in ('pharmacist', 'manager')
where l.deleted_at is null and is_room_type(l.type)
  and not exists (select 1 from stock_location_holder h where h.location_id = l.id and h.profile_id = m.created_by
                  and h.deleted_at is null);
insert into stock_location_holder (location_id, department_id)
select l.id, l.department_id from stock_location l
where l.deleted_at is null and l.department_id is not null and is_room_type(l.type)
  and not exists (select 1 from stock_location_holder h where h.location_id = l.id and h.department_id = l.department_id
                  and h.deleted_at is null);
insert into stock_location_holder (location_id, department_id)
select l.id, d.id from stock_location l
join department d on d.deleted_at is null and d.active
  and ((l.type = 'lab' and 'lab_tech' = any (d.roles)) or (l.type = 'nursing' and 'nurse' = any (d.roles)))
where l.deleted_at is null and l.type in ('lab', 'nursing')
  and not exists (select 1 from stock_location_holder h where h.location_id = l.id and h.deleted_at is null);
insert into stock_location_holder (location_id, profile_id)
select l.id, p.id from stock_location l
join profiles p on p.active and ((l.type = 'lab' and p.role = 'lab_tech') or (l.type = 'nursing' and p.role = 'nurse'))
where l.deleted_at is null and l.type in ('lab', 'nursing')
  and not exists (select 1 from stock_location_holder h where h.location_id = l.id and h.deleted_at is null);

-- ---------------------------------------------------------------- undo "given here"
-- A medicine given here by mistake (wrong medicine or quantity): the person who gave it (the same
-- day) or the manager puts it back. The units go back into the store they came from; on an open
-- bill the line leaves it, on a posted bill a credit note gives it back (as return_medicine).
create or replace function undo_given_here(p_request_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_inv invoice%rowtype;
  v_mv record;
  v_back integer := 0;
  v_patient numeric := 0;
  v_insurer numeric := 0;
  v_total numeric := 0;
  v_lines jsonb;
  v_cn uuid;
  v_year integer := extract(year from now())::integer;
  v_balance numeric;
  v_mode text := 'bill';
  v_name text;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the medicine is put back' using errcode = '22023';
  end if;
  select * into v_m from medication_request where id = p_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  if v_m.not_given_at is not null or v_m.cancelled_at is not null then
    raise exception 'this medicine was already put back' using errcode = '23505';
  end if;
  if v_m.supply <> 'room' or v_m.given_at is null then
    raise exception 'only a medicine given here is put back here' using errcode = '22023';
  end if;
  if not is_manager() then
    if v_m.given_by is distinct from auth.uid() then
      raise exception 'only the person who gave it (or the manager) puts it back' using errcode = '42501';
    end if;
    if (v_m.given_at at time zone 'Africa/Kigali')::date <> (now() at time zone 'Africa/Kigali')::date then
      raise exception 'a medicine given on another day is put back by the manager' using errcode = '42501';
    end if;
  end if;
  -- the units go back into the store they came from
  for v_mv in
    select item_id, batch_id, from_location_id, sum(quantity)::integer as quantity from stock_movement
    where medication_request_id = v_m.id and type = 'consumption' and from_location_id is not null and deleted_at is null
    group by item_id, batch_id, from_location_id
  loop
    insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason, medication_request_id)
    values (v_mv.item_id, v_mv.batch_id, v_mv.from_location_id, v_mv.quantity, 'return',
            'put back: ' || trim(p_reason), v_m.id);
    v_back := v_back + v_mv.quantity;
  end loop;
  select * into v_inv from invoice where encounter_id = v_m.encounter_id;
  if v_inv.id is null or v_inv.status = 'draft' then
    update invoice_line set deleted_at = now(),
           manual_reason = coalesce(manual_reason || ' · ', '') || 'returned: ' || trim(p_reason)
    where source_type = 'medication_request' and source_id = v_m.id and deleted_at is null;
    if v_inv.id is not null then
      perform recompute_invoice(v_inv.id);
    end if;
  else
    v_mode := 'credit';
    select coalesce(sum(l.patient_share), 0), coalesce(sum(l.insurer_share), 0),
           coalesce(sum(round(l.unit_price * l.quantity)), 0),
           coalesce(jsonb_agg(jsonb_build_object('lineId', l.id, 'description', l.description, 'quantity', l.quantity,
                                                 'unitPrice', l.unit_price, 'patientShare', l.patient_share,
                                                 'insurerShare', l.insurer_share)), '[]'::jsonb)
    into v_patient, v_insurer, v_total, v_lines
    from invoice_line l
    where l.invoice_id = v_inv.id and l.source_type = 'medication_request' and l.source_id = v_m.id
      and l.deleted_at is null;
    if v_total > 0 then
      insert into credit_note (invoice_id, number, lines, total, reason, approver_id, patient_amount, insurer_amount,
                               source_type, source_id)
      values (v_inv.id, 'CN-' || v_year || '-' || lpad(next_number('credit_note', v_year)::text, 6, '0'),
              v_lines, v_total, 'returned: ' || trim(p_reason), auth.uid(), v_patient, v_insurer,
              'medication_request', v_m.id)
      returning id into v_cn;
      if v_insurer > 0 then
        update claim set amount = greatest(0, amount - v_insurer)
        where invoice_id = v_inv.id and status = 'open' and batch_id is null;
      end if;
    end if;
  end if;
  update medication_request
  set given_at = null, given_by = null, not_given_at = now(), not_given_by = auth.uid(),
      not_given_reason = 'returned: ' || trim(p_reason)
  where id = v_m.id;
  v_balance := case when v_inv.id is not null then invoice_balance(v_inv.id) else 0 end;
  if v_mode = 'credit' and v_balance < 0 then
    -- money to give back: the cashier is told
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
    insert into notification (kind, params, link, recipient_stations, created_by)
    values ('refund_due', jsonb_build_object('name', v_name, 'item', item_label(v_m.item_id), 'amount', -v_balance,
                                             'reason', trim(p_reason)),
            '/app/visit?encounter=' || v_m.encounter_id, array['cashier'::station], auth.uid());
  end if;
  return jsonb_build_object('units', v_back, 'mode', v_mode, 'creditNoteId', v_cn,
                            'credit', case when v_mode = 'credit' then v_patient else 0 end, 'balance', v_balance);
end
$$;

-- ---------------------------------------------------------------- box size (CAT-1)
-- Units per box: a checked function (the item table is not written directly for it).
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
  update item set pack_size = p_pack, updated_at = now() where id = p_item_id and deleted_at is null;
  if not found then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  return p_pack;
end
$$;

-- A direct API request on a medicine does not delete it, switch it off, or change its code, box
-- size or stock levels: delete_item (manager, no stock left), set_reorder_level and set_pack_size do.
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
       or new.code is distinct from old.code or new.pack_size is distinct from old.pack_size) then
    raise exception 'deleting, switching off, the code, the box size and the stock levels change only through their screens'
      using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists trg_item_guard on item;
create trigger trg_item_guard before update or delete on item
  for each row execute function guard_item();

-- ---------------------------------------------------------------- money tables (RIGHTS-2)
-- Bills, bill lines, payments and claims: written only by the checked functions (charges, hand-
-- overs, given here, payments, voids, credit notes). The bill stays a draft for the whole visit
-- (pay at the end), so a direct write could make a medicine given free or undo a payment.
revoke insert, update, delete on invoice, invoice_line, payment, claim from authenticated, anon;
do $$
declare
  t text;
begin
  foreach t in array array['invoice', 'invoice_line', 'payment', 'claim'] loop
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('drop policy if exists %I on %I', t || '_delete', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- reading the tables (F)
-- What the functions show is what the tables show: every store to the pharmacy and the manager,
-- their own stores to holders; costs, deliveries and walk-in buyers to the pharmacy and the manager
-- (and the cashier for counter sales).
drop policy if exists stock_movement_select on stock_movement;
create policy stock_movement_select on stock_movement for select to authenticated
  using (stock_admin() or may_see_store(from_location_id) or may_see_store(to_location_id));
drop policy if exists batch_select on batch;
create policy batch_select on batch for select to authenticated using (stock_admin());
drop policy if exists goods_receipt_select on goods_receipt;
create policy goods_receipt_select on goods_receipt for select to authenticated using (stock_admin());
drop policy if exists goods_receipt_line_select on goods_receipt_line;
create policy goods_receipt_line_select on goods_receipt_line for select to authenticated using (stock_admin());
drop policy if exists store_request_select on store_request;
create policy store_request_select on store_request for select to authenticated using (may_see_store(location_id));
drop policy if exists stock_transfer_select on stock_transfer;
create policy stock_transfer_select on stock_transfer for select to authenticated
  using (may_see_store(from_location_id) or may_see_store(to_location_id));
drop policy if exists stock_transfer_line_select on stock_transfer_line;
create policy stock_transfer_line_select on stock_transfer_line for select to authenticated
  using (stock_admin() or exists (select 1 from stock_transfer t where t.id = transfer_id
                                  and (may_see_store(t.from_location_id) or may_see_store(t.to_location_id))));
drop policy if exists counter_sale_select on counter_sale;
drop policy if exists counter_sale_select_cashier on counter_sale;
create policy counter_sale_select on counter_sale for select to authenticated
  using (stock_admin() or has_perm('payment.take'));
drop policy if exists counter_sale_line_select on counter_sale_line;
drop policy if exists counter_sale_line_select_cashier on counter_sale_line;
create policy counter_sale_line_select on counter_sale_line for select to authenticated
  using (stock_admin() or has_perm('payment.take'));
-- the balances view reads the ledger as the person asking (the checked functions are not affected)
alter view stock_on_hand set (security_invoker = true);

-- ---------------------------------------------------------------- grants
revoke all on function is_room_type(stock_location_type), stock_admin(), may_see_store(uuid), item_label(uuid),
  save_location(uuid, text, stock_location_type, uuid), save_room_store(uuid, text, text, uuid[], uuid[]),
  assign_store_holder(uuid, uuid, uuid), unassign_store_holder(uuid), set_store_holders(uuid, uuid[], uuid[]),
  set_location_active(uuid, boolean), my_stores(), store_stock(uuid), set_store_min(uuid, uuid, integer),
  receive_stock(uuid, uuid, integer, numeric, text, date, text),
  receive_delivery(text, text, jsonb, date, uuid, text), deliveries(date, date), delivery_detail(uuid),
  use_stock(uuid, uuid, integer, uuid, text), adjust_stock(uuid, uuid, integer, text),
  transfer_stock(uuid, uuid, uuid, integer, text),
  request_refill(uuid, jsonb, text), refill_requests(text, uuid), decline_refill(uuid, text), cancel_refill(uuid),
  send_to_room(uuid, jsonb, uuid, text, uuid), return_to_pharmacy(uuid, jsonb, text),
  confirm_receipt(uuid, jsonb, text), cancel_transfer(uuid, text), transfer_notes(text, uuid, date, date),
  transfer_note(uuid), stock_overview(), stock_movements(date, date, uuid, uuid), stock_alerts(),
  set_reorder_level(uuid, integer, integer), reorder_suggestions(), delete_item(uuid),
  create_counter_sale(jsonb, text, text, uuid, text), take_counter_payment(uuid, payment_method, text, text),
  hand_over_counter_sale(uuid), cancel_counter_sale(uuid, text), counter_sales(text, date, date),
  void_payment(uuid, text), cashier_summary(date, date, date), pharmacy_summary(date, date), stock_sales(date, date),
  room_store_summary(uuid, date, date), undo_given_here(uuid, text), set_pack_size(uuid, integer)
  from public, anon;
grant execute on function is_room_type(stock_location_type), stock_admin(), may_see_store(uuid), item_label(uuid),
  save_location(uuid, text, stock_location_type, uuid), save_room_store(uuid, text, text, uuid[], uuid[]),
  assign_store_holder(uuid, uuid, uuid), unassign_store_holder(uuid), set_store_holders(uuid, uuid[], uuid[]),
  set_location_active(uuid, boolean), my_stores(), store_stock(uuid), set_store_min(uuid, uuid, integer),
  receive_stock(uuid, uuid, integer, numeric, text, date, text),
  receive_delivery(text, text, jsonb, date, uuid, text), deliveries(date, date), delivery_detail(uuid),
  use_stock(uuid, uuid, integer, uuid, text), adjust_stock(uuid, uuid, integer, text),
  transfer_stock(uuid, uuid, uuid, integer, text),
  request_refill(uuid, jsonb, text), refill_requests(text, uuid), decline_refill(uuid, text), cancel_refill(uuid),
  send_to_room(uuid, jsonb, uuid, text, uuid), return_to_pharmacy(uuid, jsonb, text),
  confirm_receipt(uuid, jsonb, text), cancel_transfer(uuid, text), transfer_notes(text, uuid, date, date),
  transfer_note(uuid), stock_overview(), stock_movements(date, date, uuid, uuid), stock_alerts(),
  set_reorder_level(uuid, integer, integer), reorder_suggestions(), delete_item(uuid),
  create_counter_sale(jsonb, text, text, uuid, text), take_counter_payment(uuid, payment_method, text, text),
  hand_over_counter_sale(uuid), cancel_counter_sale(uuid, text), counter_sales(text, date, date),
  void_payment(uuid, text), cashier_summary(date, date, date), pharmacy_summary(date, date), stock_sales(date, date),
  room_store_summary(uuid, date, date), undo_given_here(uuid, text), set_pack_size(uuid, integer)
  to authenticated;
-- internal: only the checked functions call them
revoke all on function holds_store(uuid, uuid), visible_stores(), day_number(text, text), transit_store(),
  notify_holders(uuid, text, jsonb, text), store_holders(uuid), supplier_for(text),
  receive_batch(uuid, uuid, integer, numeric, text, date, uuid, text, uuid), set_cash_price_if_none(uuid, numeric),
  assert_store_work(uuid), check_pharmacy_low(uuid), check_room_low(uuid, uuid), stock_low_watch(),
  transfer_out(uuid, uuid, uuid, integer, boolean), note_lines(jsonb), transfer_note_totals(uuid),
  room_store_for(uuid, uuid, integer, uuid, station), notify_room_loss(uuid, stock_location, integer, text),
  counter_sale_take(uuid), counter_sale_held(uuid), guard_item()
  from public, anon, authenticated;
