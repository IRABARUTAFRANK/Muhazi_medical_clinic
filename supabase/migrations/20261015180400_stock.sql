-- Muhazi Medical Clinic System — 0005 pharmacy and stock
-- Locations, suppliers, batches, movements (the ledger), dispensing, purchase orders.
-- Quantities are never stored as editable numbers: stock on hand is a sum of movements (doc §9.2, §10.4).

create table stock_location (
  like mmc_base including all,
  name text not null unique,
  type stock_location_type not null
);

create table supplier (
  like mmc_base including all,
  name text not null unique,
  contacts jsonb not null default '{}'::jsonb,
  terms text,
  active boolean not null default true
);

create table batch (
  like mmc_base including all,
  item_id uuid not null references item (id),
  batch_no text not null,
  expiry date not null,
  unit_cost numeric(12, 2) not null default 0 check (unit_cost >= 0),
  supplier_id uuid references supplier (id),
  received_on timestamptz not null default now(),
  unique (item_id, batch_no)
);
create index batch_expiry_idx on batch (item_id, expiry);

create table stock_movement (
  like mmc_base including all,
  item_id uuid not null references item (id),
  batch_id uuid references batch (id),
  from_location_id uuid references stock_location (id),
  to_location_id uuid references stock_location (id),
  quantity integer not null check (quantity > 0),
  type stock_movement_type not null,
  reason text,
  approver_id uuid,
  procedure_id uuid references procedure (id),
  dispense_id uuid,
  moved_at timestamptz not null default now(),
  check (from_location_id is not null or to_location_id is not null)
);
create index stock_movement_item_idx on stock_movement (item_id, batch_id, moved_at);

create table medication_dispense (
  like mmc_base including all,
  medication_request_id uuid references medication_request (id),
  encounter_id uuid not null references encounter (id),
  item_id uuid not null references item (id),
  batch_id uuid not null references batch (id),
  quantity numeric(10, 2) not null check (quantity > 0),
  dispenser_id uuid default auth.uid(),
  label_printed boolean not null default false,
  substitution_reason text
);
alter table stock_movement add constraint stock_movement_dispense_fk
  foreign key (dispense_id) references medication_dispense (id);

create table purchase_order (
  like mmc_base including all,
  supplier_id uuid not null references supplier (id),
  number text unique,
  status text not null default 'draft' check (status in ('draft', 'sent', 'partially_received', 'received', 'cancelled')),
  expected_at date,
  note text
);

create table purchase_order_line (
  like mmc_base including all,
  purchase_order_id uuid not null references purchase_order (id) on delete cascade,
  item_id uuid not null references item (id),
  quantity integer not null check (quantity > 0),
  unit_price numeric(12, 2) not null default 0,
  received_quantity integer not null default 0
);

create table goods_receipt (
  like mmc_base including all,
  purchase_order_id uuid references purchase_order (id),
  supplier_id uuid references supplier (id),
  received_on timestamptz not null default now(),
  note text
);

select install_common_triggers('stock_location');
select install_common_triggers('supplier');
select install_common_triggers('batch');
select install_common_triggers('stock_movement');
select install_common_triggers('medication_dispense');
select install_common_triggers('purchase_order');
select install_common_triggers('purchase_order_line');
select install_common_triggers('goods_receipt');

-- Stock on hand per item, batch and location = receipts in − issues out.
create view stock_on_hand as
  with moves as (
    select item_id, batch_id, to_location_id as location_id, quantity from stock_movement where to_location_id is not null and deleted_at is null
    union all
    select item_id, batch_id, from_location_id, -quantity from stock_movement where from_location_id is not null and deleted_at is null
  )
  select m.item_id, m.batch_id, m.location_id, sum(m.quantity)::integer as quantity, b.expiry
  from moves m
  left join batch b on b.id = m.batch_id
  group by m.item_id, m.batch_id, m.location_id, b.expiry;

create view items_below_reorder as
  select i.id as item_id, i.code, i.name_generic, i.reorder_level, coalesce(sum(s.quantity), 0)::integer as on_hand
  from item i
  left join stock_on_hand s on s.item_id = i.id
  where i.active and i.deleted_at is null
  group by i.id
  having coalesce(sum(s.quantity), 0) < i.reorder_level;

-- Dispense earliest-expiry-first from one location; writes the ledger and the invoice line is added by billing.
create or replace function dispense_fefo(
  p_encounter_id uuid,
  p_item_id uuid,
  p_quantity integer,
  p_location_id uuid,
  p_medication_request_id uuid default null,
  p_substitution_reason text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_remaining integer := p_quantity;
  v_row record;
  v_take integer;
  v_dispense_id uuid;
  v_first boolean := true;
begin
  if not has_perm('stock.dispense') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_quantity <= 0 then
    raise exception 'quantity must be positive' using errcode = '22023';
  end if;
  for v_row in
    select s.batch_id, s.quantity
    from stock_on_hand s
    where s.item_id = p_item_id and s.location_id = p_location_id and s.quantity > 0 and s.batch_id is not null
    order by s.expiry asc nulls last
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.quantity, v_remaining);
    if v_first then
      insert into medication_dispense (medication_request_id, encounter_id, item_id, batch_id, quantity, substitution_reason)
      values (p_medication_request_id, p_encounter_id, p_item_id, v_row.batch_id, p_quantity, p_substitution_reason)
      returning id into v_dispense_id;
      v_first := false;
    end if;
    insert into stock_movement (item_id, batch_id, from_location_id, quantity, type, dispense_id)
    values (p_item_id, v_row.batch_id, p_location_id, v_take, 'dispense', v_dispense_id);
    v_remaining := v_remaining - v_take;
  end loop;
  if v_remaining > 0 then
    raise exception 'insufficient stock: % unit(s) short', v_remaining using errcode = '23514';
  end if;
  return v_dispense_id;
end
$$;
