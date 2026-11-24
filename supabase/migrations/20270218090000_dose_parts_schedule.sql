-- 0198 · The dose and the pieces, parts of a piece, a time to give, repeated doses.
--
-- Frank (owner, 2026-11-24): "Dose (words)" is not clear; the dose and the number of pieces are
-- not linked ("sometimes dose is not only g … it may have other measurements"); the take-home
-- count is not worked out; only whole pieces ("when i give out this half of a tablet am able to set
-- its price … divide twice the original price of the whole piece with an option to change it
-- also"); no time to give; one press only (a medicine every 8 hours needs a new order each time).
--
-- What this file does, in plain words:
--   * A medicine knows what one piece holds (500 mg a tablet; 250 mg in 5 ml and 100 ml a bottle)
--     and whether it may be given in parts (halves, quarters, or by the ml of a bottle). Set by the
--     manager or the stock keeper (set_item_dose); otherwise worked out from its form (plain tablets
--     in halves, syrups with a known content by the ml, everything else whole). A medicine sold only
--     by the whole box is always whole.
--   * A part of a piece is given here: the stock stays in whole pieces. The first part OPENS one
--     piece (it leaves the stock, earliest expiry first); what is left of it is kept as an opened
--     piece ("½ tablet open", "95 ml left") that the next parts use first. A part goes on the bill
--     as its own line ("… · ½ tablet"): a share of the piece price by default, a whole piece, or a
--     price the clinic set (cash bills only; an insurer pays its own piece price shared). The
--     doctor may change the price of the part on the order (whoever may type a price on the bill,
--     or the manager), with a reason kept on the bill line.
--   * The order has a time to give (now, or a time up to 7 days ahead). It may be given up to 2
--     hours early. Late = more than an hour past and not recorded: one notice per late time (the
--     web runs the catch-up; nothing runs by itself).
--   * An order may be repeated (every 1 to 168 hours, 2 to 200 times or until stopped). Each time
--     is given or not given on its own, leaves the stock and goes on the bill on its own, and is
--     undone on its own; the doctor stops the rest. A repeated order has no take-home part: it is
--     written as a second order, handed over once. The end of the visit ends the repeated orders.
--   * One-time orders (0193) and the older orders of several times keep their behaviour.
-- No existing function changes its arguments. Safe to run twice.

-- ---------------------------------------------------------------- 1 the columns
-- what one piece of a medicine holds, and its parts
alter table item add column if not exists dose_amount numeric(12, 4);
alter table item add column if not exists dose_unit text;
alter table item add column if not exists dose_per numeric(12, 4);
alter table item add column if not exists dose_per_unit text;
alter table item add column if not exists content_amount numeric(12, 4);
alter table item add column if not exists content_unit text;
alter table item add column if not exists part_mode text;
alter table item add column if not exists part_price_rule text not null default 'share';
alter table item add column if not exists half_price numeric(12, 0);
alter table item add column if not exists quarter_price numeric(12, 0);
alter table item add column if not exists measure_price numeric(12, 2);
alter table item add column if not exists dose_set_by uuid references profiles (id);
alter table item add column if not exists dose_set_at timestamptz;
alter table item drop constraint if exists item_dose_check;
alter table item add constraint item_dose_check check (
  (dose_amount is null) = (dose_unit is null) and (dose_amount is null or dose_amount > 0)
  and (dose_per is null) = (dose_per_unit is null) and (dose_per is null or (dose_per > 0 and dose_amount is not null))
  and (content_amount is null) = (content_unit is null) and (content_amount is null or content_amount > 0)
  and (dose_unit is null or dose_unit in ('mcg', 'mg', 'g', 'IU', 'MIU', 'mmol', 'mEq'))
  and (dose_per_unit is null or dose_per_unit in ('ml', 'l', 'g', 'drop', 'puff'))
  and (content_unit is null or content_unit in ('ml', 'l', 'g', 'drop', 'puff')));
alter table item drop constraint if exists item_part_check;
alter table item add constraint item_part_check check (
  (part_mode is null or part_mode in ('whole', 'half', 'quarter', 'measure'))
  and (part_mode is distinct from 'measure' or coalesce(content_unit, '') in ('ml', 'l'))
  and part_price_rule in ('share', 'whole', 'set')
  and (half_price is null or half_price >= 0) and (quarter_price is null or quarter_price >= 0)
  and (measure_price is null or measure_price >= 0));
comment on column item.dose_amount is
  '0198: what one piece holds (500 for 500 mg), or what dose_per of it holds (250 for 250 mg in 5 ml)';
comment on column item.dose_unit is '0198: mcg, mg, g, IU, MIU, mmol or mEq';
comment on column item.dose_per is '0198: the strength is in this much (5 for 250 mg in 5 ml); null: in one piece';
comment on column item.dose_per_unit is '0198: ml, l, g, drop or puff';
comment on column item.content_amount is '0198: the content of one piece (100 for a bottle of 100 ml); null: the piece itself';
comment on column item.content_unit is '0198: ml, l, g, drop or puff';
comment on column item.part_mode is
  '0198: given in parts: whole, half, quarter or measure (by the ml); null: by its form (item_part_mode)';
comment on column item.part_price_rule is
  '0198: the price of a part: share (of the piece price), whole (a whole piece), set (half_price, quarter_price, measure_price; cash bills only)';
comment on column item.half_price is '0198: the set price of ½ piece';
comment on column item.quarter_price is '0198: the set price of ¼ piece (¾ = 3 × ¼)';
comment on column item.measure_price is '0198: the set price of 1 ml of the content';

-- the order: the dose as a number and unit, a part of a piece, the price of the part, the time,
-- and the repeat
alter table nurse_order add column if not exists dose_amount numeric(12, 4);
alter table nurse_order add column if not exists dose_unit text;
alter table nurse_order add column if not exists part numeric(12, 6);
alter table nurse_order add column if not exists part_text text;
alter table nurse_order add column if not exists part_price numeric(12, 0);
alter table nurse_order add column if not exists part_price_by uuid references profiles (id);
alter table nurse_order add column if not exists part_price_reason text;
alter table nurse_order add column if not exists first_at timestamptz;
alter table nurse_order add column if not exists every_minutes integer;
alter table nurse_order drop constraint if exists nurse_order_part_check;
alter table nurse_order add constraint nurse_order_part_check check (part is null or (part > 0 and part < 1));
alter table nurse_order drop constraint if exists nurse_order_every_check;
alter table nurse_order add constraint nurse_order_every_check
  check (every_minutes is null or every_minutes between 60 and 10080);
-- "until stopped": no number of times
alter table nurse_order alter column doses_planned drop not null;
alter table nurse_order drop constraint if exists nurse_order_doses_planned_check;
alter table nurse_order add constraint nurse_order_doses_planned_check
  check ((doses_planned is null and every_minutes is not null) or doses_planned between 1 and 200);
-- a drug: whole pieces here + to take home + a part > 0 (0193 without the part)
alter table nurse_order drop constraint if exists nurse_order_amount_check;
alter table nurse_order add constraint nurse_order_amount_check check (
  case when kind = 'act' then quantity > 0 and home_quantity is null and part is null
       else coalesce(home_quantity, 0) >= 0 and quantity + coalesce(home_quantity, 0) + coalesce(part, 0) > 0 end);
-- a repeated order has no take-home part (it is its own order, handed over once)
alter table nurse_order drop constraint if exists nurse_order_repeat_home_check;
alter table nurse_order add constraint nurse_order_repeat_home_check
  check (every_minutes is null or home_quantity is null);
create index if not exists nurse_order_open_repeat_idx on nurse_order (encounter_id)
  where status = 'open' and every_minutes is not null;
comment on column nurse_order.dose_amount is '0198: the dose as a number (1 for 1 g); dose keeps the words';
comment on column nurse_order.dose_unit is '0198: the unit of the dose (mg, g, ml, tablet…, or the words typed)';
comment on column nurse_order.part is '0198: a part of a piece given here each time (0.5 = ½; 0.05 = 5 ml of 100 ml)';
comment on column nurse_order.part_text is '0198: the part in words, for the bill and the nurse (½ tablet, 5 ml)';
comment on column nurse_order.part_price is '0198: the price of the part changed on the order (null: by the medicine''s rule)';
comment on column nurse_order.first_at is
  '0198: the (first) time to give; null on the orders written before 0198 and on those only to take home';
comment on column nurse_order.every_minutes is '0198: repeated every so many minutes (60 … 10080); null: not repeated';
comment on column nurse_order.doses_planned is
  '0193: 1 (one press); before 0193 several times; 0198: a repeated order''s number of times, null until stopped';

alter table nurse_order_dose add column if not exists due_at timestamptz;
alter table nurse_order_dose add column if not exists part numeric(12, 6);
alter table nurse_order_dose drop constraint if exists nurse_order_dose_part_check;
alter table nurse_order_dose add constraint nurse_order_dose_part_check check (part is null or (part > 0 and part < 1));
comment on column nurse_order_dose.due_at is '0198: the time this time was planned for';
comment on column nurse_order_dose.part is '0198: the part of a piece given at this time';

alter table invoice_line add column if not exists part numeric(12, 6);
alter table invoice_line drop constraint if exists invoice_line_part_check;
alter table invoice_line add constraint invoice_line_part_check check (part is null or (part > 0 and part < 1));
comment on column invoice_line.part is
  '0198: a part of a piece (quantity 1 × the price of the part): 0.5 = ½ piece; the sales report counts it so';

-- ---------------------------------------------------------------- 2 opened pieces, late notices
-- An opened piece: one piece left the stock when it was opened for a part; what is left of it
-- (left_part, of one piece) is used by the next parts. Usually one per medicine and store; an Undo
-- may give back a part to a piece already used up while another is open (then the oldest is used
-- first).
create table if not exists open_piece (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references item (id),
  location_id uuid not null references stock_location (id),
  batch_id uuid references batch (id),
  left_part numeric(12, 6) not null check (left_part >= 0 and left_part <= 1),
  opened_at timestamptz not null default now(),
  opened_by uuid references profiles (id) default auth.uid(),
  opened_dose_id uuid references nurse_order_dose (id),
  movement_id uuid references stock_movement (id),
  closed_at timestamptz,
  closed_by uuid references profiles (id),
  closed_reason text
);
create index if not exists open_piece_open_idx on open_piece (item_id, location_id) where closed_at is null;
create index if not exists open_piece_dose_idx on open_piece (opened_dose_id);
create index if not exists open_piece_movement_idx on open_piece (movement_id);
comment on table open_piece is
  '0198: a piece opened for a part (a cut tablet, an opened bottle): it left the stock when opened; left_part is what is left of it. closed_reason: used up, back in the stock, thrown away: …';
alter table open_piece enable row level security;
revoke all on open_piece from anon, authenticated;

create table if not exists open_piece_use (
  id uuid primary key default gen_random_uuid(),
  open_piece_id uuid not null references open_piece (id),
  dose_id uuid not null references nurse_order_dose (id),
  part numeric(12, 6) not null check (part > 0 and part <= 1),
  at timestamptz not null default now(),
  undone_at timestamptz
);
create index if not exists open_piece_use_dose_idx on open_piece_use (dose_id);
create index if not exists open_piece_use_piece_idx on open_piece_use (open_piece_id);
comment on table open_piece_use is '0198: a part taken from an opened piece by one time of an order (undone_at: given back)';
alter table open_piece_use enable row level security;
revoke all on open_piece_use from anon, authenticated;

create table if not exists order_time_notice (
  order_id uuid not null references nurse_order (id),
  n integer not null,
  kind text not null,
  at timestamptz not null default now(),
  primary key (order_id, n, kind)
);
comment on table order_time_notice is '0198: a notice sent about one time of an order (late), never twice';
alter table order_time_notice enable row level security;
revoke all on order_time_notice from anon, authenticated;

-- ---------------------------------------------------------------- 3 what one piece holds
-- How a medicine may be given in parts: set by the manager, else by its form. A medicine sold only
-- by the whole box: whole. Coated, slow-release, effervescent tablets, capsules, sachets,
-- suppositories, patches, inhalers, sprays and drops: whole. Other tablets: halves. A syrup or
-- suspension whose bottle content is known in ml: by the ml. Everything else: whole. The web
-- works it out the same way (partModeOf); the catalogue gives this answer (part_mode_now).
create or replace function part_mode_by(
  p_part_mode text, p_sale_mode text, p_pack_size integer, p_text text, p_content_unit text, p_content_amount numeric
)
returns text
language sql immutable
as $$
  select case
    when coalesce(p_sale_mode, 'piece') = 'pack' and coalesce(p_pack_size, 1) >= 2 then 'whole'
    when p_part_mode is not null then p_part_mode
    when lower(coalesce(p_text, '')) ~ '(gastro|enteric|retard|prolonged|modified|extended|\msr\M|\mxr\M|\mer\M|\mlp\M|effervescent|capsule|gélule|gelule|sachet|suppositor|patch|inhaler|spray|drops?)'
      then 'whole'
    when lower(coalesce(p_text, '')) ~ '(tab|comprim)' then 'half'
    when lower(coalesce(p_text, '')) ~ '(syrup|sirop|suspension|oral solution|solution buvable)'
         and coalesce(p_content_unit, '') in ('ml', 'l') and coalesce(p_content_amount, 0) > 0 then 'measure'
    else 'whole' end
$$;

create or replace function item_part_mode(p_item_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select part_mode_by(i.part_mode, i.sale_mode, i.pack_size,
                      concat_ws(' ', i.name_generic, i.strength, i.form, i.unit, i.selling_unit),
                      i.content_unit, i.content_amount)
  from item i where i.id = p_item_id
$$;

-- A part in words: "½ tablet", "¼ tablet", "5 ml", "92.5 ml" (by the ml when the medicine is given
-- by measure). Internal: the bill line, the nurse and the opened pieces read it.
create or replace function item_part_text(p_item_id uuid, p_part numeric)
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when coalesce(i.content_unit, '') in ('ml', 'l') and coalesce(i.content_amount, 0) > 0
         and item_part_mode(i.id) = 'measure' then
      trim_scale(round(p_part * i.content_amount * case when i.content_unit = 'l' then 1000 else 1 end, 1))::text || ' ml'
    else
      case when p_part = 0.5 then '½' when p_part = 0.25 then '¼' when p_part = 0.75 then '¾'
           when p_part = 1 then '1' else trim_scale(round(p_part, 2))::text end
      || ' ' || coalesce(nullif(trim(i.selling_unit), ''), nullif(trim(i.unit), ''), 'piece') end
  from item i where i.id = p_item_id
$$;

-- What is left of the opened pieces of a medicine in a store (of one piece). Internal.
-- review 0198: an opened piece of an expired batch is not used (as a whole piece of it is not):
-- it stays listed until it is thrown away.
create or replace function open_piece_usable(p_batch_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_batch_id is null
         or exists (select 1 from batch b where b.id = p_batch_id and (b.expiry is null or b.expiry >= current_date))
$$;

create or replace function open_part_left(p_item_id uuid, p_location_id uuid)
returns numeric
language sql stable security definer set search_path = public
as $$
  select coalesce(sum(p.left_part), 0) from open_piece p
  where p.item_id = p_item_id and p.location_id = p_location_id and p.closed_at is null
    and open_piece_usable(p.batch_id)
$$;

-- What one piece holds, as the screens read it.
create or replace function item_dose_json(p_item_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'itemId', i.id, 'doseAmount', i.dose_amount, 'doseUnit', i.dose_unit, 'dosePer', i.dose_per,
    'dosePerUnit', i.dose_per_unit, 'contentAmount', i.content_amount, 'contentUnit', i.content_unit,
    'partMode', i.part_mode, 'partModeNow', item_part_mode(i.id), 'partPriceRule', i.part_price_rule,
    'halfPrice', i.half_price, 'quarterPrice', i.quarter_price, 'measurePrice', i.measure_price,
    'doseSetBy', (select full_name from profiles where id = i.dose_set_by), 'doseSetAt', i.dose_set_at)
  from item i where i.id = p_item_id
$$;

-- The manager, whoever sets the medicines' prices or the catalogue, or the stock keeper (the
-- people who set the package and prices with a delivery, 0177) says what one piece holds, how it
-- may be given in parts and the price of a part. A null clears. Kept in the change log.
create or replace function set_item_dose(
  p_item_id uuid,
  p_dose_amount numeric default null,
  p_dose_unit text default null,
  p_dose_per numeric default null,
  p_dose_per_unit text default null,
  p_content_amount numeric default null,
  p_content_unit text default null,
  p_part_mode text default null,
  p_part_price_rule text default null,
  p_half_price numeric default null,
  p_quarter_price numeric default null,
  p_measure_price numeric default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_i item%rowtype;
  v_du text := lower(nullif(trim(coalesce(p_dose_unit, '')), ''));
  v_pu text := lower(nullif(trim(coalesce(p_dose_per_unit, '')), ''));
  v_cu text := lower(nullif(trim(coalesce(p_content_unit, '')), ''));
  v_mode text := lower(nullif(trim(coalesce(p_part_mode, '')), ''));
  v_rule text := coalesce(lower(nullif(trim(coalesce(p_part_price_rule, '')), '')), 'share');
  v_now text;
  v_before jsonb;
begin
  if auth.uid() is null
     or not (is_manager() or has_perm('catalogue.write') or has_perm('item_price.write') or stock_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_i from item where id = p_item_id and deleted_at is null for update;
  if not found then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  -- the units are kept as codes (IU, MIU, mEq keep their capitals)
  v_du := case v_du when 'µg' then 'mcg' when 'ug' then 'mcg' when 'iu' then 'IU' when 'ui' then 'IU'
                    when 'miu' then 'MIU' when 'mui' then 'MIU' when 'meq' then 'mEq' else v_du end;
  v_pu := case v_pu when 'drops' then 'drop' when 'puffs' then 'puff' else v_pu end;
  v_cu := case v_cu when 'drops' then 'drop' when 'puffs' then 'puff' else v_cu end;
  if (p_dose_amount is null) <> (v_du is null) or coalesce(p_dose_amount, 1) <= 0
     or coalesce(v_du, 'mg') not in ('mcg', 'mg', 'g', 'IU', 'MIU', 'mmol', 'mEq') then
    raise exception 'say what one piece holds as a number and a unit (mcg, mg, g, IU, MIU, mmol or mEq)'
      using errcode = '22023', hint = 'bad_strength';
  end if;
  if (p_dose_per is null) <> (v_pu is null) or coalesce(p_dose_per, 1) <= 0
     or (p_dose_per is not null and p_dose_amount is null)
     or coalesce(v_pu, 'ml') not in ('ml', 'l', 'g', 'drop', 'puff') then
    raise exception 'say in how much the strength is (for example 250 mg in 5 ml)'
      using errcode = '22023', hint = 'bad_strength';
  end if;
  if (p_content_amount is null) <> (v_cu is null) or coalesce(p_content_amount, 1) <= 0
     or coalesce(v_cu, 'ml') not in ('ml', 'l', 'g', 'drop', 'puff') then
    raise exception 'say the content of one piece as a number and a unit (ml, l, g, drops or puffs)'
      using errcode = '22023', hint = 'bad_content';
  end if;
  if v_mode is not null and v_mode not in ('whole', 'half', 'quarter', 'measure') then
    raise exception 'given in parts: whole only, halves, quarters or by measure' using errcode = '22023', hint = 'bad_part_mode';
  end if;
  if v_rule not in ('share', 'whole', 'set') then
    raise exception 'the price of a part is a share of the piece price, the price of a whole piece, or a price you set'
      using errcode = '22023', hint = 'bad_part_mode';
  end if;
  if coalesce(p_half_price, 0) < 0 or coalesce(p_quarter_price, 0) < 0 or coalesce(p_measure_price, 0) < 0 then
    raise exception 'the price must be zero or more' using errcode = '22023';
  end if;
  if v_mode = 'measure' and coalesce(v_cu, '') not in ('ml', 'l') then
    raise exception 'giving by the ml needs the content of one piece in ml (for example 100 ml)'
      using errcode = '22023', hint = 'measure_needs_content';
  end if;
  if v_mode in ('half', 'quarter', 'measure') and coalesce(v_i.sale_mode, 'piece') = 'pack'
     and coalesce(v_i.pack_size, 1) >= 2 then
    raise exception 'a medicine sold only by the whole box is given in whole pieces'
      using errcode = '22023', hint = 'box_only_whole';
  end if;
  v_now := part_mode_by(v_mode, v_i.sale_mode, v_i.pack_size,
                        concat_ws(' ', v_i.name_generic, v_i.strength, v_i.form, v_i.unit, v_i.selling_unit),
                        v_cu, p_content_amount);
  if v_rule = 'set' and ((v_now = 'half' and p_half_price is null)
                         or (v_now = 'quarter' and p_quarter_price is null)
                         or (v_now = 'measure' and p_measure_price is null)) then
    raise exception 'type the price of the part you set' using errcode = '22023', hint = 'set_price_needed';
  end if;
  v_before := item_dose_json(p_item_id);
  update item
  set dose_amount = p_dose_amount, dose_unit = v_du, dose_per = p_dose_per, dose_per_unit = v_pu,
      content_amount = p_content_amount, content_unit = v_cu, part_mode = v_mode, part_price_rule = v_rule,
      half_price = round(p_half_price), quarter_price = round(p_quarter_price), measure_price = round(p_measure_price, 2),
      dose_set_by = auth.uid(), dose_set_at = now(), updated_at = now()
  where id = p_item_id;
  insert into audit_event (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), 'update', 'item', p_item_id, v_before, item_dose_json(p_item_id));
  return item_dose_json(p_item_id);
end
$$;

-- guard_item (from 20261217090000_packaging_and_charging): + what one piece holds and its parts
-- change only through set_item_dose (0198). Every earlier rule kept.
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
  -- 0198
  if tg_op = 'UPDATE' and (
       new.dose_amount is distinct from old.dose_amount or new.dose_unit is distinct from old.dose_unit
       or new.dose_per is distinct from old.dose_per or new.dose_per_unit is distinct from old.dose_per_unit
       or new.content_amount is distinct from old.content_amount or new.content_unit is distinct from old.content_unit
       or new.part_mode is distinct from old.part_mode or new.part_price_rule is distinct from old.part_price_rule
       or new.half_price is distinct from old.half_price or new.quarter_price is distinct from old.quarter_price
       or new.measure_price is distinct from old.measure_price or new.dose_set_by is distinct from old.dose_set_by
       or new.dose_set_at is distinct from old.dose_set_at) then
    raise exception 'what one piece holds and its parts change only in Medicines and prices'
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- items_catalogue (from 20270115090000_clinic_price_lists): + what one piece holds, its parts and
-- the price of a part, appended (0198); part_mode_now: how it is given in parts now (through
-- item_part_mode, so the view holds no column of the box: sale_mode and pack_size stay free).
create or replace view items_catalogue with (security_invoker = true) as
  select i.id, i.code, i.name_generic, i.name_brand, i.strength, i.form, i.unit, i.selling_unit, i.controlled, i.active,
         (select pf.price from price_for(null, i.id, null) pf) as cash_price,
         i.atc_group, i.prescribing_rule,
         lp.price as list_price,
         own_cash_price(null, i.id) as own_price,
         lp.book_id as list_id,
         (select b.name from tariff_book b where b.id = lp.book_id) as list_name,
         -- 0198
         i.dose_amount, i.dose_unit, i.dose_per, i.dose_per_unit, i.content_amount, i.content_unit,
         i.part_mode, i.part_price_rule, i.half_price, i.quarter_price, i.measure_price,
         item_part_mode(i.id) as part_mode_now,
         i.dose_set_at
  from item i
  left join lateral (select cl.price, cl.book_id from clinic_list_price(null, i.id) cl) lp on true
  where i.deleted_at is null;
revoke all on items_catalogue from anon;
grant select on items_catalogue to authenticated;

-- ---------------------------------------------------------------- 4 parts of a piece: the stock
-- A part is taken from the opened pieces of that medicine in that store (the oldest first); what
-- they do not hold opens a new piece: one piece leaves the stock (earliest expiry first, never an
-- expired batch; none: MS003), linked to the order and its time. Internal.
create or replace function take_part(p_item_id uuid, p_location_id uuid, p_part numeric, p_dose_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_left numeric := p_part;
  v_p record;
  v_use numeric;
  v_order uuid := (select d.order_id from nurse_order_dose d where d.id = p_dose_id);
  v_batch uuid;
  v_mv uuid;
  v_piece uuid;
  v_tol constant numeric := 0.00001;
begin
  if p_part is null or p_part <= 0 or p_part > 1 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  perform lock_stock(p_item_id, p_location_id);
  for v_p in
    select * from open_piece
    where item_id = p_item_id and location_id = p_location_id and closed_at is null and left_part > 0
      and open_piece_usable(batch_id) -- review 0198: never from an expired batch
    order by opened_at, id
    for update
  loop
    exit when v_left <= v_tol;
    v_use := least(v_p.left_part, v_left);
    insert into open_piece_use (open_piece_id, dose_id, part) values (v_p.id, p_dose_id, v_use);
    update open_piece
    set left_part = greatest(left_part - v_use, 0),
        closed_at = case when left_part - v_use < v_tol then now() end,
        closed_by = case when left_part - v_use < v_tol then auth.uid() end,
        closed_reason = case when left_part - v_use < v_tol then 'used up' end
    where id = v_p.id;
    v_left := v_left - v_use;
  end loop;
  if v_left > v_tol then
    select s.batch_id into v_batch
    from stock_on_hand s
    where s.item_id = p_item_id and s.location_id = p_location_id and s.quantity > 0
      and (s.expiry is null or s.expiry >= current_date)
    order by s.expiry asc nulls last
    limit 1;
    if not found then
      raise exception 'not enough of this medicine (not expired) in the clinic''s stock'
        using errcode = 'MS003', hint = 'room_short';
    end if;
    insert into stock_movement (item_id, batch_id, from_location_id, quantity, type, reason, nurse_order_id,
                                nurse_order_dose_id)
    values (p_item_id, v_batch, p_location_id, 1, 'consumption', 'opened for a part', v_order, p_dose_id)
    returning id into v_mv;
    insert into open_piece (item_id, location_id, batch_id, left_part, opened_dose_id, movement_id,
                            closed_at, closed_by, closed_reason)
    values (p_item_id, p_location_id, v_batch, greatest(1 - v_left, 0), p_dose_id, v_mv,
            case when 1 - v_left < v_tol then now() end, case when 1 - v_left < v_tol then auth.uid() end,
            case when 1 - v_left < v_tol then 'used up' end)
    returning id into v_piece;
    insert into open_piece_use (open_piece_id, dose_id, part) values (v_piece, p_dose_id, least(v_left, 1));
  end if;
end
$$;

-- The parts of times undone go back to their pieces (a piece used up opens again; one thrown away
-- stays thrown away). A piece one of these times opened: nobody uses it any more → it goes back to
-- the stock whole (a 'return', as an Undo) and closes 'back in the stock'; another time still
-- uses it → it stays out and its stock movement follows the earliest of those times (the reports
-- keep counting it). Answers how many pieces went back to the stock. Internal.
create or replace function return_parts(p_doses uuid[])
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_u record;
  v_p record;
  v_live uuid;
  v_to uuid;
  v_back integer := 0;
begin
  for v_u in
    select u.* from open_piece_use u where u.dose_id = any (p_doses) and u.undone_at is null
    order by u.at, u.id
    for update
  loop
    update open_piece_use set undone_at = now() where id = v_u.id;
    update open_piece
    set left_part = least(1, left_part + v_u.part),
        closed_at = case when closed_reason = 'used up' then null else closed_at end,
        closed_by = case when closed_reason = 'used up' then null else closed_by end,
        closed_reason = case when closed_reason = 'used up' then null else closed_reason end
    where id = v_u.open_piece_id;
  end loop;
  for v_p in
    select p.* from open_piece p where p.opened_dose_id = any (p_doses) order by p.opened_at for update
  loop
    select u.dose_id into v_live
    from open_piece_use u
    where u.open_piece_id = v_p.id and u.undone_at is null
    order by u.at, u.id
    limit 1;
    if v_live is not null then
      update stock_movement
      set nurse_order_dose_id = v_live,
          nurse_order_id = (select d.order_id from nurse_order_dose d where d.id = v_live)
      where id = v_p.movement_id;
      update open_piece set opened_dose_id = v_live where id = v_p.id;
    elsif v_p.closed_at is null and v_p.movement_id is not null then
      v_to := case when exists (select 1 from stock_location l where l.id = v_p.location_id and l.active
                                  and l.deleted_at is null)
                   then v_p.location_id else main_pharmacy() end;
      insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason, nurse_order_id,
                                  nurse_order_dose_id)
      select m.item_id, m.batch_id, v_to, m.quantity, 'return', 'order undone', m.nurse_order_id, m.nurse_order_dose_id
      from stock_movement m where m.id = v_p.movement_id;
      v_back := v_back + 1;
      update open_piece set left_part = 1, closed_at = now(), closed_by = auth.uid(), closed_reason = 'back in the stock'
      where id = v_p.id;
    end if;
  end loop;
  return v_back;
end
$$;

-- "Throw away the rest" (an opened bottle gone off): the stock keeper, the manager, or whoever
-- works on the patients; with the reason. No stock movement: the piece left the stock when opened.
create or replace function close_open_piece(p_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_p open_piece%rowtype;
begin
  if auth.uid() is null or not (stock_manager() or is_manager() or has_perm('clinical.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why' using errcode = '22023';
  end if;
  select * into v_p from open_piece where id = p_id for update;
  if not found or v_p.closed_at is not null then
    raise exception 'this opened piece is not open any more' using errcode = 'P0002', hint = 'piece_gone';
  end if;
  update open_piece set closed_at = now(), closed_by = auth.uid(), closed_reason = 'thrown away: ' || trim(p_reason)
  where id = p_id;
  return jsonb_build_object('id', p_id, 'itemId', v_p.item_id, 'left', v_p.left_part,
                            'leftText', item_part_text(v_p.item_id, v_p.left_part),
                            'closedReason', 'thrown away: ' || trim(p_reason));
end
$$;

-- The opened pieces (of a store, or all) for the stock screens.
create or replace function open_pieces(p_location_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null
     or not (has_perm('stock.read') or has_perm('clinical.write') or stock_manager() or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', p.id, 'itemId', p.item_id, 'item', item_label(p.item_id), 'storeId', p.location_id, 'store', l.name,
        'left', p.left_part, 'leftText', item_part_text(p.item_id, p.left_part),
        'batchNo', b.batch_no, 'expiry', b.expiry, 'openedAt', p.opened_at,
        'openedBy', (select full_name from profiles where id = p.opened_by))
      order by item_label(p.item_id), p.opened_at)
    from open_piece p
    left join stock_location l on l.id = p.location_id
    left join batch b on b.id = p.batch_id
    where p.closed_at is null and (p_location_id is null or p.location_id = p_location_id)), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- 5 parts of a piece: the bill
-- A part on the bill: one piece is charged by every rule of the bill (add_charge_internal: price
-- list, insurer, coverage, exceptions, a closed bill MS001, no price P0002), then that line becomes
-- the part: quantity 1 × the price of the part, "… · ½ tablet", the part kept, the shares from the
-- line's coverage. The price of the part: changed on the order (typed, with who and why), else by
-- the medicine's rule: a whole piece; a price set (cash bills only); else the share of the piece
-- price of that bill (the insurer's own, or the cash price). Internal.
create or replace function add_part_charge_internal(
  p_encounter_id uuid,
  p_office station,
  p_item_id uuid,
  p_part numeric,
  p_part_text text,
  p_price numeric default null,
  p_price_reason text default null,
  p_price_by uuid default null,
  p_performed_by uuid default null,
  p_source_type text default null,
  p_source_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_line uuid;
  v_l invoice_line%rowtype;
  v_i item%rowtype;
  v_payer uuid;
  v_cash boolean;
  v_ml numeric;
  v_set numeric;
  v_price numeric;
  v_ins numeric;
begin
  if p_part is null or p_part <= 0 or p_part >= 1 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  v_line := add_charge_internal(p_encounter_id, p_office, null, p_item_id, 1, null, null, p_performed_by, null,
                                p_source_type, p_source_id);
  select * into v_l from invoice_line where id = v_line;
  select * into v_i from item where id = p_item_id;
  select inv.payer_id into v_payer from invoice inv where inv.id = v_l.invoice_id;
  v_cash := v_payer is null or coalesce((select pf.fallback from price_source_for(null, p_item_id, v_payer) pf), false);
  if p_price is not null then
    v_price := round(p_price);
  elsif v_i.part_price_rule = 'whole' then
    v_price := v_l.unit_price;
  else
    if v_i.part_price_rule = 'set' and v_cash then
      if item_part_mode(p_item_id) = 'measure' then
        v_ml := round(p_part * v_i.content_amount * case when v_i.content_unit = 'l' then 1000 else 1 end * 2) / 2;
        v_set := v_i.measure_price * v_ml;
      elsif p_part = 0.5 then
        v_set := coalesce(v_i.half_price, 2 * v_i.quarter_price);
      elsif p_part = 0.25 then
        v_set := v_i.quarter_price;
      elsif p_part = 0.75 then
        v_set := 3 * v_i.quarter_price;
      end if;
      if v_set is not null then
        v_price := round(v_set * (100 - coalesce(v_l.discount_pct, 0)) / 100);
      end if;
    end if;
    v_price := coalesce(v_price, round(v_l.unit_price * p_part));
  end if;
  v_ins := round(v_price * coalesce(v_l.coverage_pct, 0) / 100);
  update invoice_line
  set unit_price = v_price, part = round(p_part, 6),
      description = v_l.description || ' · ' || coalesce(nullif(trim(p_part_text), ''), item_part_text(p_item_id, p_part)),
      patient_share = v_price - v_ins, insurer_share = v_ins,
      price_origin = case when p_price is not null then 'manual'::price_origin else price_origin end,
      manual_reason = case when p_price is not null
                           then 'price of the part set on the order by '
                                || coalesce((select full_name from profiles where id = p_price_by), '—') || ': '
                                || coalesce(nullif(trim(p_price_reason), ''), '—')
                           else manual_reason end
  where id = v_line;
  perform recompute_invoice(v_l.invoice_id);
  return v_line;
end
$$;

-- ---------------------------------------------------------------- 6 the times of an order
-- The planned times of an order with the time recorded, if any: a repeated order every
-- every_minutes from first_at (all of them; until stopped: up to 24 hours from now, never after
-- it ended); a one-time order: one time, at first_at (or when it was written); an older order of
-- several times: its times, all at when it was written. A recorded time beyond the plan is listed
-- too. Internal.
create or replace function order_times(p_order_id uuid)
returns table (n integer, due_at timestamptz, dose_id uuid, given boolean, at timestamptz)
language sql stable security definer set search_path = public
as $$
  with o as (
    select x.*, coalesce(x.first_at, x.created_at) as t0 from nurse_order x where x.id = p_order_id
  ), plan as (
    select g.n,
           case when o.every_minutes is not null then o.t0 + make_interval(mins => (g.n - 1) * o.every_minutes)
                else o.t0 end as due_at
    from o
    cross join lateral generate_series(1,
      case when o.every_minutes is null then coalesce(o.doses_planned, 1)
           when o.doses_planned is not null then o.doses_planned
           else least(2000, greatest(1, floor(extract(epoch from
                  (least(now() + interval '24 hours', coalesce(o.ended_at, 'infinity'::timestamptz)) - o.t0))
                  / 60 / o.every_minutes)::integer + 1)) end) g(n)
  ), rec as (
    select d.id, d.n, d.given, d.at, d.due_at from nurse_order_dose d where d.order_id = p_order_id and d.deleted_at is null
  )
  select coalesce(p.n, r.n), coalesce(p.due_at, r.due_at, (select o.t0 from o)), r.id, r.given, r.at
  from plan p
  full join rec r on r.n = p.n
  order by 1
$$;

-- ---------------------------------------------------------------- 7 one order as the screens read it
-- nurse_order_json (from 20270213090000_orders_once_take_home): + the dose as a number and unit,
-- the part and its price, the time to give (firstAt: when it was written for the older orders),
-- the repeat, the next time due and "late" (more than an hour past, on orders written with a time),
-- each time's planned time and part, and the list of times of a repeated order (0198). Every 0193
-- field kept.
create or replace function nurse_order_json(p_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', o.id, 'encounterId', o.encounter_id, 'kind', o.kind, 'text', o.text,
    'serviceId', o.service_id, 'service', (select s.name_en from service s where s.id = o.service_id),
    'itemId', o.item_id, 'item', case when o.item_id is not null then item_label(o.item_id) end,
    'quantity', o.quantity, 'dose', o.dose, 'route', o.route, 'frequency', o.frequency,
    'dosesPlanned', o.doses_planned,
    'given', (select count(*) from nurse_order_dose d where d.order_id = o.id and d.deleted_at is null and d.given)::integer,
    'notGiven', (select count(*) from nurse_order_dose d where d.order_id = o.id and d.deleted_at is null and not d.given)::integer,
    'assignedTo', o.assigned_to, 'assignedName', (select full_name from profiles where id = o.assigned_to),
    'status', o.status, 'notes', o.notes, 'at', o.created_at,
    'by', (select full_name from profiles where id = o.created_by), 'byId', o.created_by,
    'endedAt', o.ended_at, 'endedBy', (select full_name from profiles where id = o.ended_by), 'endReason', o.end_reason,
    'mine', nurse_order_mine(o.assigned_to),
    -- 0193: the medicine's piece and box, and the part to take home
    'unit', coalesce(i.selling_unit, i.unit),
    'packSize', case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end,
    'packUnit', i.pack_unit, 'saleMode', i.sale_mode,
    'homeQuantity', o.home_quantity, 'homeDose', o.home_dose, 'homeFrequency', o.home_frequency,
    'homeDays', o.home_days, 'homeInstructions', o.home_instructions,
    'doses', coalesce((select jsonb_agg(jsonb_build_object(
        'n', d.n, 'given', d.given, 'at', d.at, 'by', (select full_name from profiles where id = d.by_id),
        'note', d.note, 'charged', d.charged,
        'store', (select l.name from stock_location l where l.id = d.location_id),
        -- 0193
        'id', d.id, 'byId', d.by_id, 'recordedAt', d.created_at,
        'quantity', case when d.given and o.kind = 'drug' then coalesce(d.quantity, o.quantity) end,
        'homeQuantity', d.home_quantity, 'office', d.office,
        'billed', (select coalesce(sum(round(l.quantity * l.unit_price)), 0) from invoice_line l
                   where l.nurse_order_dose_id = d.id and l.deleted_at is null),
        'onBill', exists (select 1 from invoice_line l where l.nurse_order_dose_id = d.id and l.deleted_at is null),
        'batches', coalesce((select jsonb_agg(jsonb_build_object('batchNo', b.batch_no, 'expiry', b.expiry, 'quantity', x.q)
                                              order by b.expiry nulls last, b.batch_no)
                             from (select m.batch_id, sum(m.quantity)::integer as q from stock_movement m
                                   where m.nurse_order_dose_id = d.id and m.type = 'consumption' and m.deleted_at is null
                                   group by m.batch_id) x
                             left join batch b on b.id = x.batch_id), '[]'::jsonb),
        -- 0198: the planned time, the part given
        'dueAt', d.due_at, 'part', d.part) order by d.n)
      from nurse_order_dose d where d.order_id = o.id and d.deleted_at is null), '[]'::jsonb),
    -- 0193: the times undone (back in the stock, off the bill): who, when, why
    'undone', coalesce((select jsonb_agg(jsonb_build_object(
        'n', d.n, 'at', d.at, 'by', (select full_name from profiles where id = d.by_id),
        'quantity', case when o.kind = 'drug' then coalesce(d.quantity, o.quantity) end,
        'homeQuantity', d.home_quantity, 'undoneAt', d.deleted_at,
        'undoneBy', (select full_name from profiles where id = d.undone_by), 'reason', d.undo_reason,
        -- 0198
        'given', d.given, 'part', d.part, 'dueAt', d.due_at)
        order by d.deleted_at)
      from nurse_order_dose d where d.order_id = o.id and d.deleted_at is not null and d.undo_reason is not null), '[]'::jsonb))
  || jsonb_build_object(
    -- 0198: the dose, the part and its price
    'doseAmount', o.dose_amount, 'doseUnit', o.dose_unit,
    'part', o.part, 'partText', o.part_text, 'partPrice', o.part_price,
    'partPriceBy', (select full_name from profiles where id = o.part_price_by), 'partPriceById', o.part_price_by,
    'partPriceReason', o.part_price_reason,
    'partMode', case when o.item_id is not null then item_part_mode(o.item_id) end,
    -- 0198: the time to give and the repeat
    'firstAt', coalesce(o.first_at, o.created_at), 'timed', o.first_at is not null,
    'everyMinutes', o.every_minutes,
    'untilStopped', o.every_minutes is not null and o.doses_planned is null,
    'nextDueAt', nd.next_due,
    'late', coalesce(o.status = 'open' and o.first_at is not null and nd.next_due < now() - interval '60 minutes', false),
    'times', case when o.every_minutes is not null then coalesce((
      select jsonb_agg(jsonb_build_object(
          'n', t.n, 'dueAt', t.due_at,
          'state', case when d.id is not null then case when d.given then 'given' else 'not_given' end
                        when o.status <> 'open' then 'stopped'
                        when t.due_at < now() - interval '60 minutes' then 'late'
                        when t.due_at <= now() + interval '30 minutes' then 'due'
                        else 'later' end,
          'doseId', d.id, 'at', d.at, 'by', (select full_name from profiles where id = d.by_id), 'byId', d.by_id,
          'recordedAt', d.created_at, 'note', d.note,
          'quantity', case when d.given and o.kind = 'drug' then coalesce(d.quantity, o.quantity) end,
          'part', case when d.given then d.part end,
          'billed', case when d.id is not null then
                      (select coalesce(sum(round(l.quantity * l.unit_price)), 0) from invoice_line l
                       where l.nurse_order_dose_id = d.id and l.deleted_at is null) end)
        order by t.n)
      from order_times(o.id) t
      left join nurse_order_dose d on d.id = t.dose_id), '[]'::jsonb) end)
  from nurse_order o
  left join item i on i.id = o.item_id
  left join lateral (select min(t.due_at) as next_due from order_times(o.id) t
                     where t.dose_id is null and o.status = 'open') nd on true
  where o.id = p_id
$$;

-- ---------------------------------------------------------------- 8 writing an order
-- The doctor writes one order (0198; the rules of create_order_here, from
-- 20270213090000_orders_once_take_home, all kept): a medical act, or a medicine of the clinic's
-- stock given here (whole pieces and/or a part of a piece) and/or taken home. New:
--   * the dose as a number and unit (the words are made from them when none are typed);
--   * a part of a piece (p_part_unit 'piece': ½, ¼, ¾ as the medicine allows; 'ml' or 'l': an
--     amount of the bottle by steps of 0.5 ml, less than one bottle), with its price changed on the
--     order (whoever may type a price on the bill, or the manager; with a reason);
--   * the time to give (now, or up to 7 days ahead);
--   * the repeat: every 60 … 10080 minutes, 2 … 200 times or until stopped. A repeated order with
--     a part to take home is written as two orders (the repeated one, and one to hand over once,
--     with the same nurse and notes): the answer is then {order, homeOrder}.
-- The stock is checked for the first time (the whole pieces, the part to take home, and one more
-- piece when the opened pieces do not hold the part); whole boxes as before.
create or replace function create_order_planned(
  p_encounter_id uuid,
  p_kind text,
  p_item_id uuid default null,
  p_service_id uuid default null,
  p_text text default null,
  p_quantity numeric default null,
  p_part_amount numeric default null,
  p_part_unit text default null,
  p_dose_amount numeric default null,
  p_dose_unit text default null,
  p_dose text default null,
  p_route text default null,
  p_part_price numeric default null,
  p_part_price_reason text default null,
  p_first_at timestamptz default null,
  p_every_minutes integer default null,
  p_times integer default null,
  p_until_stopped boolean default false,
  p_home_quantity numeric default null,
  p_home_dose text default null,
  p_home_frequency text default null,
  p_home_days integer default null,
  p_home_instructions text default null,
  p_assigned_to uuid default null,
  p_notes text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_e encounter%rowtype;
  v_i item%rowtype;
  v_text text := nullif(trim(coalesce(p_text, '')), '');
  v_qty numeric;
  v_here numeric := 0;
  v_home numeric := 0;
  v_part numeric;
  v_part_text text;
  v_mode text;
  v_unit text := lower(nullif(trim(coalesce(p_part_unit, '')), ''));
  v_ml numeric;
  v_content_ml numeric;
  v_repeat boolean := p_every_minutes is not null;
  v_planned integer := 1;
  v_first timestamptz;
  v_need integer := 0;
  v_dose_unit text := nullif(trim(coalesce(p_dose_unit, '')), '');
  v_dose text;
  v_reason text := nullif(trim(coalesce(p_part_price_reason, '')), '');
  v_here_any boolean;
  v_split boolean;
  v_id uuid;
  v_home_id uuid;
  v_params jsonb;
  v_link text;
  v_name text;
begin
  if auth.uid() is null or not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not is_doctor() then
    raise exception 'not allowed: the doctor gives the orders to the nurses' using errcode = '42501', hint = 'not_doctor';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  select * into v_e from encounter where id = p_encounter_id and deleted_at is null;
  if not found or v_e.status <> 'open' then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if coalesce(p_kind, '') not in ('act', 'drug') then
    raise exception 'say whether it is a medical act or a drug to give' using errcode = '22023';
  end if;
  -- 0198: the repeat
  if v_repeat then
    if p_every_minutes not between 60 and 10080 then
      raise exception 'repeat every 1 to 168 hours' using errcode = '22023', hint = 'bad_every';
    end if;
    if coalesce(p_until_stopped, false) then
      v_planned := null;
    elsif p_times is null or p_times not between 2 and 200 then
      raise exception 'say how many times: 2 to 200, or until stopped' using errcode = '22023', hint = 'bad_times';
    else
      v_planned := p_times;
    end if;
  elsif coalesce(p_until_stopped, false) or coalesce(p_times, 1) <> 1 then
    raise exception 'say every how many hours it is repeated' using errcode = '22023', hint = 'bad_every';
  end if;
  -- 0198: the time to give
  if p_first_at is not null and (p_first_at < now() - interval '5 minutes' or p_first_at > now() + interval '7 days') then
    raise exception 'the time to give is from now to 7 days ahead' using errcode = '22023', hint = 'bad_first_at';
  end if;
  if p_kind = 'act' then
    v_qty := coalesce(p_quantity, 1);
    if v_qty <= 0 then
      raise exception 'quantity must be more than zero' using errcode = '22023';
    end if;
    if p_service_id is not null
       and not exists (select 1 from service s where s.id = p_service_id and s.active and s.deleted_at is null) then
      raise exception 'unknown service' using errcode = '22023';
    end if;
    v_text := coalesce(v_text, (select s.name_en from service s where s.id = p_service_id));
  else
    select * into v_i from item i where i.id = p_item_id and i.active and i.deleted_at is null;
    if p_item_id is null or not found then
      raise exception 'choose the medicine from the stock' using errcode = '22023', hint = 'item_needed';
    end if;
    v_here := coalesce(p_quantity, 0);
    v_home := coalesce(p_home_quantity, 0);
    if v_here < 0 or v_home < 0 then
      raise exception 'quantity must be more than zero' using errcode = '22023';
    end if;
    if v_here <> trunc(v_here) or v_home <> trunc(v_home) then
      raise exception 'count whole pieces here; a part of a piece (½, ¼ or ml) is given apart'
        using errcode = '22023', hint = 'bad_part';
    end if;
    -- 0198: a part of a piece, as the medicine allows
    if coalesce(p_part_amount, 0) <> 0 then
      v_mode := item_part_mode(p_item_id);
      if v_mode = 'whole' then
        raise exception 'this medicine is given in whole pieces only' using errcode = '22023', hint = 'whole_only';
      end if;
      if p_part_amount < 0 then
        raise exception 'this part is not possible for this medicine (½ for halves; ¼, ½ or ¾ for quarters; ml for a bottle)'
          using errcode = '22023', hint = 'bad_part';
      end if;
      if v_unit is null or v_unit in ('piece', 'part') or v_unit = lower(coalesce(v_i.selling_unit, ''))
         or v_unit = lower(coalesce(v_i.unit, '')) or v_unit = lower(coalesce(v_i.form, '')) then
        if v_mode = 'measure' or p_part_amount not in (0.25, 0.5, 0.75) or (v_mode = 'half' and p_part_amount <> 0.5) then
          raise exception 'this part is not possible for this medicine (½ for halves; ¼, ½ or ¾ for quarters; ml for a bottle)'
            using errcode = '22023', hint = 'bad_part';
        end if;
        v_part := p_part_amount;
      elsif v_unit in ('ml', 'l') and v_mode = 'measure' then
        v_content_ml := v_i.content_amount * case when v_i.content_unit = 'l' then 1000 else 1 end;
        v_ml := p_part_amount * case when v_unit = 'l' then 1000 else 1 end;
        if v_ml * 2 <> trunc(v_ml * 2) or v_ml >= v_content_ml then
          raise exception 'this part is not possible for this medicine (½ for halves; ¼, ½ or ¾ for quarters; ml for a bottle)'
            using errcode = '22023', hint = 'bad_part';
        end if;
        v_part := round(v_ml / v_content_ml, 6);
      else
        raise exception 'this part is not possible for this medicine (½ for halves; ¼, ½ or ¾ for quarters; ml for a bottle)'
          using errcode = '22023', hint = 'bad_part';
      end if;
      v_part_text := item_part_text(p_item_id, v_part);
    end if;
    if v_here + v_home + coalesce(v_part, 0) = 0 then
      raise exception 'say how many are given here or taken home' using errcode = '22023';
    end if;
    if v_home > 0 and p_home_days is not null and p_home_days not between 1 and 365 then
      raise exception 'the number of days is between 1 and 365' using errcode = '22023';
    end if;
    if v_repeat and v_here + coalesce(v_part, 0) = 0 then
      raise exception 'a repeated order gives something here each time: say how many'
        using errcode = '22023', hint = 'repeat_here';
    end if;
    -- a medicine sold only by the whole box: whole boxes (each time, for a repeated order)
    if v_repeat then
      if v_here > 0 then
        perform assert_whole_packs(p_item_id, v_here);
      end if;
      if v_home > 0 then
        perform assert_whole_packs(p_item_id, v_home);
      end if;
    elsif v_here + v_home > 0 then
      perform assert_whole_packs(p_item_id, v_here + v_home);
    end if;
    -- the stock, for the first time: one more piece when the opened pieces do not hold the part
    if v_part is not null and open_part_left(p_item_id, main_pharmacy()) < v_part - 0.00001 then
      v_need := 1;
    end if;
    if v_here + v_home + v_need > 0
       and room_store_for(auth.uid(), p_item_id, (v_here + v_home + v_need)::integer, null, null) is null then
      raise exception 'not enough of this medicine (not expired) in the clinic''s stock'
        using errcode = 'MS003', hint = 'room_short';
    end if;
    -- 0198: the price of the part, changed on the order
    if p_part_price is not null then
      if v_part is null then
        raise exception 'this part is not possible for this medicine (½ for halves; ¼, ½ or ¾ for quarters; ml for a bottle)'
          using errcode = '22023', hint = 'bad_part';
      end if;
      if not (has_perm('charge.manual') or is_manager()) then
        raise exception 'only a person who may type a price on the bill (or the manager) changes the price of a part'
          using errcode = '42501', hint = 'part_price_right';
      end if;
      if p_part_price < 0 then
        raise exception 'the price must be zero or more' using errcode = '22023';
      end if;
      if length(coalesce(v_reason, '')) < 3 then
        raise exception 'say why the part has this price' using errcode = '22023', hint = 'part_price_reason';
      end if;
    end if;
    -- 0198: the dose as a number and its unit
    if (p_dose_amount is null) <> (v_dose_unit is null) or coalesce(p_dose_amount, 1) <= 0
       or length(coalesce(v_dose_unit, '')) > 40 then
      raise exception 'give the dose as a number and its unit' using errcode = '22023', hint = 'bad_dose';
    end if;
    v_dose := coalesce(nullif(trim(coalesce(p_dose, '')), ''),
                       case when p_dose_amount is not null then trim_scale(p_dose_amount)::text || ' ' || v_dose_unit end);
    v_text := item_label(p_item_id);
  end if;
  if length(coalesce(v_text, '')) < 2 then
    raise exception 'say what must be done' using errcode = '22023';
  end if;
  if p_assigned_to is not null and p_assigned_to <> auth.uid() and not is_nurse_role(p_assigned_to) then
    raise exception 'send it to a nurse, or to all the nurses' using errcode = '22023', hint = 'not_nurse';
  end if;
  v_here_any := p_kind = 'act' or v_here + coalesce(v_part, 0) > 0;
  -- the time: now when nothing is said; an order only to take home has none
  v_first := case when v_here_any then coalesce(p_first_at, now()) else p_first_at end;
  v_split := v_repeat and v_home > 0;
  insert into nurse_order (encounter_id, patient_id, kind, text, service_id, item_id, quantity, dose, route,
                           frequency, doses_planned, assigned_to, notes,
                           home_quantity, home_dose, home_frequency, home_days, home_instructions,
                           dose_amount, dose_unit, part, part_text, part_price, part_price_by, part_price_reason,
                           first_at, every_minutes)
  values (p_encounter_id, v_e.patient_id, p_kind, v_text,
          case when p_kind = 'act' then p_service_id end, case when p_kind = 'drug' then p_item_id end,
          case when p_kind = 'drug' then v_here else v_qty end,
          case when p_kind = 'drug' and v_here_any then v_dose end,
          case when p_kind = 'drug' and v_here_any then nullif(trim(coalesce(p_route, '')), '') end,
          null, v_planned, p_assigned_to, nullif(trim(coalesce(p_notes, '')), ''),
          case when v_home > 0 and not v_split then v_home end,
          case when v_home > 0 and not v_split then nullif(trim(coalesce(p_home_dose, '')), '') end,
          case when v_home > 0 and not v_split then nullif(trim(coalesce(p_home_frequency, '')), '') end,
          case when v_home > 0 and not v_split then p_home_days end,
          case when v_home > 0 and not v_split then nullif(trim(coalesce(p_home_instructions, '')), '') end,
          case when p_kind = 'drug' and v_here_any then p_dose_amount end,
          case when p_kind = 'drug' and v_here_any then v_dose_unit end,
          v_part, v_part_text,
          case when v_part is not null then round(p_part_price) end,
          case when v_part is not null and p_part_price is not null then auth.uid() end,
          case when v_part is not null and p_part_price is not null then v_reason end,
          v_first, p_every_minutes)
  returning id into v_id;
  if v_split then
    -- the part to take home: its own order, handed over once
    insert into nurse_order (encounter_id, patient_id, kind, text, service_id, item_id, quantity, dose, route,
                             frequency, doses_planned, assigned_to, notes,
                             home_quantity, home_dose, home_frequency, home_days, home_instructions)
    values (p_encounter_id, v_e.patient_id, 'drug', v_text, null, p_item_id, 0, null, null,
            null, 1, p_assigned_to, nullif(trim(coalesce(p_notes, '')), ''),
            v_home, nullif(trim(coalesce(p_home_dose, '')), ''), nullif(trim(coalesce(p_home_frequency, '')), ''),
            p_home_days, nullif(trim(coalesce(p_home_instructions, '')), ''))
    returning id into v_home_id;
  end if;
  -- the nurses are told (as create_order_here): the one named, else every employee whose role is
  -- Nurse; "Me": nobody. One notice per order.
  v_link := '/app/visit?encounter=' || p_encounter_id;
  v_name := (select p.surname || ' ' || p.given_names from patient p where p.id = v_e.patient_id);
  if p_assigned_to is distinct from auth.uid() then
    for v_params in
      select jsonb_build_object('orderId', x.id, 'kind', p_kind, 'title', v_text, 'name', v_name,
                                'by', (select full_name from profiles where id = auth.uid()),
                                'here', x.here, 'home', x.home, 'firstAt', x.first_at, 'every', x.every)
      from (values (v_id, v_here_any, v_home > 0 and not v_split, v_first, p_every_minutes),
                   (v_home_id, false, true, null::timestamptz, null::integer)) x(id, here, home, first_at, every)
      where x.id is not null
    loop
      if p_assigned_to is not null then
        insert into notification (kind, params, link, recipient_user, created_by)
        values ('nurse_order', v_params, v_link, p_assigned_to, auth.uid());
      else
        insert into notification (kind, params, link, recipient_user, created_by)
        select 'nurse_order', v_params, v_link, p.id, auth.uid()
        from profiles p
        where p.id <> auth.uid() and is_nurse_role(p.id);
      end if;
    end loop;
  end if;
  if v_split then
    return jsonb_build_object('order', nurse_order_json(v_id), 'homeOrder', nurse_order_json(v_home_id));
  end if;
  return nurse_order_json(v_id);
end
$$;

-- ---------------------------------------------------------------- 9 carrying out one time
-- One time of an order carried out (the body of give_nurse_order of
-- 20270213090000_orders_once_take_home, shared by give_nurse_order and give_order_time): a drug's
-- whole pieces leave the clinic's stock (earliest expiry first) and go on the bill in one call (a
-- whole box keeps the box price); its part comes from the opened pieces (a new piece is opened
-- when they do not hold it) and goes on the bill as its own line; an act is billed at its
-- treatment's price. The bill line goes to the desk of the person who presses. A closed bill, a
-- missing price or a written act leaves it unbilled (notBilled), never unrecorded. Internal.
create or replace function carry_out_time(
  p_o nurse_order, p_n integer, p_due timestamptz, p_at timestamptz, p_note text, p_location_id uuid,
  p_here numeric, p_home numeric
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_total numeric := coalesce(p_here, 0) + coalesce(p_home, 0);
  v_qty integer := ceil(coalesce(p_here, 0) + coalesce(p_home, 0))::integer;
  v_part numeric := case when p_o.kind = 'drug' then p_o.part end;
  v_loc uuid;
  v_need integer := 0;
  v_office station := order_office();
  v_dose uuid;
  v_why text;
  v_billed numeric;
begin
  if p_o.kind = 'drug' then
    -- 0173: one stock, the main pharmacy (an open store named explicitly is honoured)
    v_loc := coalesce((select l.id from stock_location l where l.id = p_location_id and l.deleted_at is null and l.active),
                      main_pharmacy());
    if v_part is not null and open_part_left(p_o.item_id, v_loc) < v_part - 0.00001 then
      v_need := 1;
    end if;
    if v_qty + v_need > 0 then
      v_loc := room_store_for(auth.uid(), p_o.item_id, v_qty + v_need, v_loc, 'nursing');
      if v_loc is null then
        raise exception 'not enough of this medicine (not expired) in the clinic''s stock'
          using errcode = 'MS003', hint = 'room_short';
      end if;
    end if;
  end if;
  insert into nurse_order_dose (order_id, n, given, at, by_id, note, location_id, charged, quantity, home_quantity,
                                office, due_at, part)
  values (p_o.id, p_n, true, p_at, auth.uid(), nullif(trim(coalesce(p_note, '')), ''), v_loc, false,
          case when p_o.kind = 'drug' then p_here end,
          case when p_o.kind = 'drug' then p_home end, v_office, p_due, v_part)
  returning id into v_dose;
  if p_o.kind = 'drug' then
    if v_qty > 0 then
      perform give_from_store(p_o.item_id, v_loc, v_qty, null, 'order given here');
      update stock_movement set nurse_order_id = p_o.id, nurse_order_dose_id = v_dose
      where medication_request_id is null and nurse_order_id is null and item_id = p_o.item_id
        and from_location_id = v_loc and type = 'consumption' and created_at = now();
    end if;
    if v_part is not null then
      perform take_part(p_o.item_id, v_loc, v_part, v_dose);
    end if;
    if v_total > 0 then
      begin
        perform add_charge_internal(p_o.encounter_id, v_office, null, p_o.item_id, v_total,
                                    null, null, auth.uid(), null, 'nurse_order', p_o.id);
      exception
        when sqlstate 'P0002' then v_why := 'no_price';
        when sqlstate 'MS001' then v_why := 'bill_closed';
      end;
    end if;
    if v_part is not null then
      begin
        perform add_part_charge_internal(p_o.encounter_id, v_office, p_o.item_id, v_part, p_o.part_text,
                                         p_o.part_price, p_o.part_price_reason, p_o.part_price_by, auth.uid(),
                                         'nurse_order', p_o.id);
      exception
        when sqlstate 'P0002' then v_why := 'no_price';
        when sqlstate 'MS001' then v_why := 'bill_closed';
      end;
    end if;
  elsif p_o.service_id is not null then
    begin
      perform add_charge_internal(p_o.encounter_id, v_office, p_o.service_id, null, p_here,
                                  null, null, auth.uid(), null, 'nurse_order', p_o.id);
    exception
      when sqlstate 'P0002' then v_why := 'no_price';
      when sqlstate 'MS001' then v_why := 'bill_closed';
    end;
  else
    v_why := 'not_in_price_list';
  end if;
  update invoice_line set nurse_order_dose_id = v_dose
  where source_type = 'nurse_order' and source_id = p_o.id and nurse_order_dose_id is null
    and created_at = now() and deleted_at is null;
  update nurse_order_dose set charged = (v_why is null) where id = v_dose;
  select coalesce(sum(round(l.quantity * l.unit_price)), 0) into v_billed
  from invoice_line l where l.nurse_order_dose_id = v_dose and l.deleted_at is null;
  return jsonb_build_object('charged', v_why is null, 'notBilled', v_why, 'doseId', v_dose, 'billed', v_billed);
end
$$;

-- give_nurse_order (from 20270213090000_orders_once_take_home): one press (0193), as before, + the
-- time to give (at most 2 hours early; the planned time kept on the time) and the part (0198). A
-- repeated order is given time by time (give_order_time). An older order of several times gives
-- one time's amount, as before.
create or replace function give_nurse_order(
  p_order_id uuid, p_note text default null, p_at timestamptz default null, p_location_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype;
  v_at timestamptz := coalesce(p_at, now());
  v_n integer;
  v_due timestamptz;
  v_r jsonb;
begin
  v_o := nurse_order_for_work(p_order_id);
  if v_o.every_minutes is not null then
    raise exception 'this order is repeated: record each time on its own line' using errcode = '22023', hint = 'use_time';
  end if;
  if v_at > now() + interval '5 minutes' or v_at < now() - interval '24 hours' then
    raise exception 'the time given is not possible' using errcode = '22023', hint = 'bad_time';
  end if;
  v_due := coalesce(v_o.first_at, v_o.created_at);
  if v_at < v_due - interval '2 hours' then
    raise exception 'too early: this is planned for more than 2 hours later' using errcode = '22023', hint = 'too_early';
  end if;
  -- the next number after the highest time standing: an Undo leaves gaps (time 1 undone, time 2
  -- not given still standing), so a count would give a number already taken
  v_n := coalesce((select max(n) from nurse_order_dose where order_id = v_o.id and deleted_at is null), 0) + 1;
  v_r := carry_out_time(v_o, v_n, v_due, v_at, p_note, p_location_id, v_o.quantity,
                        case when v_o.kind = 'drug' then v_o.home_quantity end);
  perform nurse_order_close_if_complete(v_o.id);
  return nurse_order_json(v_o.id) || v_r;
end
$$;

-- One time of a repeated order given (0198): the nurse it is for, the doctor who wrote it or the
-- manager; that time is planned and not recorded yet; at most 2 hours early; the time given within
-- the last day. Its whole pieces and its part leave the stock and go on the bill; an act is billed.
-- The order is over when every planned time is recorded.
create or replace function give_order_time(
  p_order_id uuid, p_n integer, p_note text default null, p_at timestamptz default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype;
  v_at timestamptz := coalesce(p_at, now());
  v_due timestamptz;
  v_r jsonb;
begin
  v_o := nurse_order_for_work(p_order_id);
  if v_o.every_minutes is null then
    -- a one-time order: its one time is the one press
    if p_n = 1 and v_o.doses_planned = 1 then
      return give_nurse_order(p_order_id, p_note, p_at);
    end if;
    raise exception 'this time is not planned on this order' using errcode = '22023', hint = 'no_such_time';
  end if;
  if p_n is null or p_n < 1 or (v_o.doses_planned is not null and p_n > v_o.doses_planned) then
    raise exception 'this time is not planned on this order' using errcode = '22023', hint = 'no_such_time';
  end if;
  if exists (select 1 from nurse_order_dose d where d.order_id = v_o.id and d.n = p_n and d.deleted_at is null) then
    raise exception 'this time is already recorded' using errcode = '22023', hint = 'time_done';
  end if;
  if v_at > now() + interval '5 minutes' or v_at < now() - interval '24 hours' then
    raise exception 'the time given is not possible' using errcode = '22023', hint = 'bad_time';
  end if;
  v_due := v_o.first_at + make_interval(mins => (p_n - 1) * v_o.every_minutes);
  if v_at < v_due - interval '2 hours' then
    raise exception 'too early: this is planned for more than 2 hours later' using errcode = '22023', hint = 'too_early';
  end if;
  v_r := carry_out_time(v_o, p_n, v_due, v_at, p_note, null, v_o.quantity, null);
  perform nurse_order_close_if_complete(v_o.id);
  return nurse_order_json(v_o.id) || v_r;
end
$$;

-- One time of a repeated order not given, with the reason (the patient refused, was asleep…):
-- recorded, the doctor told (0198). At most 2 hours early, as giving it.
create or replace function skip_order_time(p_order_id uuid, p_n integer, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype;
  v_due timestamptz;
  v_dose uuid;
begin
  v_o := nurse_order_for_work(p_order_id);
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why' using errcode = '22023';
  end if;
  if v_o.every_minutes is null or p_n is null or p_n < 1
     or (v_o.doses_planned is not null and p_n > v_o.doses_planned) then
    raise exception 'this time is not planned on this order' using errcode = '22023', hint = 'no_such_time';
  end if;
  if exists (select 1 from nurse_order_dose d where d.order_id = v_o.id and d.n = p_n and d.deleted_at is null) then
    raise exception 'this time is already recorded' using errcode = '22023', hint = 'time_done';
  end if;
  v_due := v_o.first_at + make_interval(mins => (p_n - 1) * v_o.every_minutes);
  if now() < v_due - interval '2 hours' then
    raise exception 'too early: this is planned for more than 2 hours later' using errcode = '22023', hint = 'too_early';
  end if;
  insert into nurse_order_dose (order_id, n, given, note, due_at)
  values (v_o.id, p_n, false, trim(p_reason), v_due)
  returning id into v_dose;
  perform nurse_order_tell(v_o.id, 'not_given', trim(p_reason));
  perform nurse_order_close_if_complete(v_o.id);
  return nurse_order_json(v_o.id) || jsonb_build_object('doseId', v_dose);
end
$$;

-- skip_nurse_dose (from 20270213090000_orders_once_take_home): + a repeated order is recorded time
-- by time (0198). Otherwise as before: numbered after the highest time standing.
create or replace function skip_nurse_dose(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype;
  v_n integer;
begin
  v_o := nurse_order_for_work(p_order_id);
  if v_o.every_minutes is not null then
    raise exception 'this order is repeated: record each time on its own line' using errcode = '22023', hint = 'use_time';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why' using errcode = '22023';
  end if;
  v_n := coalesce((select max(n) from nurse_order_dose where order_id = v_o.id and deleted_at is null), 0) + 1;
  insert into nurse_order_dose (order_id, n, given, note, due_at)
  values (v_o.id, v_n, false, trim(p_reason), coalesce(v_o.first_at, v_o.created_at));
  perform nurse_order_tell(v_o.id, 'not_given', trim(p_reason));
  perform nurse_order_close_if_complete(v_o.id);
  return nurse_order_json(v_o.id);
end
$$;

-- ---------------------------------------------------------------- 10 Undo
-- Undo times of an order (the body of undo_nurse_order of 20270213090000_orders_once_take_home,
-- every rule kept): the person who recorded them the same day, or the manager any day. The pieces
-- go back to the clinic's stock (a part goes back to its opened piece: return_parts; the stock
-- movement of an opened piece is never returned here), the lines leave the bill (a credit note
-- when the bill is closed; the cashier is told when money goes back), the times are kept as undone
-- (who, when, why). p_one_time: the order as 0193 (the doctor who wrote it or the manager: ended
-- cancelled; the nurse: to do again). Otherwise (a repeated order) the order stays as it is; one
-- over because every time was recorded is open again while the visit is open. Internal.
create or replace function undo_order_doses(p_o nurse_order, p_doses uuid[], p_reason text, p_one_time boolean)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype := p_o;
  v_reason text := trim(coalesce(p_reason, ''));
  v_doses uuid[] := p_doses;
  v_inv invoice%rowtype;
  v_mv record;
  v_to uuid;
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
  v_status text;
  v_over boolean;
  v_removed integer := 0;
begin
  if auth.uid() is null or not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(v_reason) < 3 then
    raise exception 'say why' using errcode = '22023';
  end if;
  perform 1 from nurse_order_dose d where d.id = any (v_doses) and d.deleted_at is null for update;
  -- review 0198: only the times still standing once they are locked (two Undo of the same time at
  -- once: the second finds it undone, and its pieces never go back to the stock twice)
  select coalesce(array_agg(d.id), '{}'::uuid[]) into v_doses
  from nurse_order_dose d where d.id = any (v_doses) and d.deleted_at is null;
  if cardinality(v_doses) = 0 then
    raise exception 'this time is not recorded (or already undone)' using errcode = 'P0002', hint = 'no_such_time';
  end if;
  if not is_manager() then
    if exists (select 1 from nurse_order_dose d where d.id = any (v_doses) and d.by_id is distinct from auth.uid()) then
      raise exception 'only the person who gave it (or the manager) can undo it' using errcode = '42501';
    end if;
    if exists (select 1 from nurse_order_dose d where d.id = any (v_doses)
               and (d.created_at at time zone 'Africa/Kigali')::date <> (now() at time zone 'Africa/Kigali')::date) then
      raise exception 'an order given on another day is undone by the manager' using errcode = '42501';
    end if;
  end if;
  -- the pieces go back into the store they came from (the main pharmacy when it is closed); an
  -- opened piece is handled by return_parts
  for v_mv in
    select m.nurse_order_dose_id, m.item_id, m.batch_id, m.from_location_id, sum(m.quantity)::integer as quantity
    from stock_movement m
    where m.nurse_order_dose_id = any (v_doses) and m.type = 'consumption' and m.from_location_id is not null
      and m.deleted_at is null
      and not exists (select 1 from open_piece p where p.movement_id = m.id)
    group by m.nurse_order_dose_id, m.item_id, m.batch_id, m.from_location_id
  loop
    v_to := case when exists (select 1 from stock_location l where l.id = v_mv.from_location_id and l.active
                                and l.deleted_at is null)
                 then v_mv.from_location_id else main_pharmacy() end;
    insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason, nurse_order_id,
                                nurse_order_dose_id)
    values (v_mv.item_id, v_mv.batch_id, v_to, v_mv.quantity, 'return', 'order undone', v_o.id,
            v_mv.nurse_order_dose_id);
    v_back := v_back + v_mv.quantity;
  end loop;
  -- 0198: the parts go back to their opened pieces (a piece nobody uses any more: to the stock)
  v_back := v_back + return_parts(v_doses);
  -- the bill: its lines come off (a line the manager already removed stays removed)
  select * into v_inv from invoice where encounter_id = v_o.encounter_id;
  if v_inv.id is null or v_inv.status = 'draft' then
    update invoice_line set deleted_at = now(),
           manual_reason = coalesce(manual_reason || ' · ', '') || 'order undone'
    where nurse_order_dose_id = any (v_doses) and deleted_at is null;
    get diagnostics v_removed = row_count;
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
    where l.invoice_id = v_inv.id and l.nurse_order_dose_id = any (v_doses) and l.deleted_at is null;
    if v_total > 0 then
      insert into credit_note (invoice_id, number, lines, total, reason, approver_id, patient_amount, insurer_amount,
                               source_type, source_id)
      values (v_inv.id, 'CN-' || v_year || '-' || lpad(next_number('credit_note', v_year)::text, 6, '0'),
              v_lines, v_total, 'order undone', auth.uid(), v_patient, v_insurer,
              'nurse_order', v_o.id)
      returning id into v_cn;
      if v_insurer > 0 then
        update claim set amount = greatest(0, amount - v_insurer)
        where invoice_id = v_inv.id and status = 'open' and batch_id is null;
      end if;
    end if;
  end if;
  -- the times: kept, as undone
  update nurse_order_dose set deleted_at = now(), undone_by = auth.uid(), undo_reason = v_reason
  where id = any (v_doses);
  -- the order (one already over, cancelled or not done, stays as it is with its reason)
  v_over := v_o.status in ('cancelled', 'not_done');
  if not p_one_time then
    -- 0198: a repeated order stays as it is; over only because every time was recorded: open again
    v_status := v_o.status;
    if v_o.status in ('done', 'not_done') and v_o.end_reason is null
       and exists (select 1 from encounter e where e.id = v_o.encounter_id and e.status = 'open' and e.deleted_at is null) then
      v_status := 'open';
      update nurse_order set status = 'open', ended_at = null, ended_by = null where id = v_o.id;
    end if;
  else
    if v_over then
      v_status := v_o.status;
    elsif v_o.created_by = auth.uid() or is_manager() then
      v_status := 'cancelled';
    elsif exists (select 1 from encounter e where e.id = v_o.encounter_id and e.status = 'open' and e.deleted_at is null) then
      v_status := 'open';
    else
      v_status := 'not_done';
    end if;
    if v_over then
      null;
    elsif v_status = 'open' then
      update nurse_order set status = 'open', ended_at = null, ended_by = null, end_reason = null where id = v_o.id;
    else
      update nurse_order set status = v_status, ended_at = now(), ended_by = auth.uid(), end_reason = 'undone: ' || v_reason
      where id = v_o.id;
    end if;
  end if;
  -- who is told: the doctor who wrote it (unless he undid it himself); the nurse it was for, when
  -- the order is cancelled now
  perform nurse_order_tell(v_o.id, 'undone', v_reason);
  if p_one_time and not v_over and v_status = 'cancelled' and v_o.assigned_to is not null
     and v_o.assigned_to <> auth.uid() and v_o.assigned_to is distinct from v_o.created_by then
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('nurse_order_done',
            jsonb_build_object('orderId', v_o.id, 'title', v_o.text, 'what', 'cancelled', 'reason', v_reason,
                               'name', (select p.surname || ' ' || p.given_names from patient p where p.id = v_o.patient_id),
                               'by', (select full_name from profiles where id = auth.uid())),
            '/app/visit?encounter=' || v_o.encounter_id, v_o.assigned_to, auth.uid());
  end if;
  v_balance := case when v_inv.id is not null then invoice_balance(v_inv.id) else 0 end;
  if v_balance < 0 then
    -- money to give back: the cashier is told
    select p.surname || ' ' || p.given_names into v_name from patient p where p.id = v_o.patient_id;
    insert into notification (kind, params, link, recipient_stations, created_by)
    values ('refund_due', jsonb_build_object('name', v_name, 'item', v_o.text, 'amount', -v_balance),
            '/app/visit?encounter=' || v_o.encounter_id, array['cashier'::station], auth.uid());
  end if;
  -- credit: the patient's part (as before); creditTotal: the credit note's whole amount
  return nurse_order_json(v_o.id)
    || jsonb_build_object('units', v_back, 'mode', v_mode, 'creditNoteId', v_cn,
                          'credit', case when v_cn is not null then v_patient else 0 end,
                          'creditTotal', case when v_cn is not null then v_total else 0 end,
                          'creditInsurer', case when v_cn is not null then v_insurer else 0 end,
                          'removed', v_removed, 'balance', v_balance, 'status', v_status);
end
$$;

-- undo_nurse_order (from 20270213090000_orders_once_take_home): the same arguments and answer; the
-- work is done by undo_order_doses (0198). A one-time order (and an older one of several times):
-- every time given, as 0193; a repeated order: every time recorded, the order left as it is.
create or replace function undo_nurse_order(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype;
  v_reason text := trim(coalesce(p_reason, ''));
  v_doses uuid[];
begin
  if auth.uid() is null or not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(v_reason) < 3 then
    raise exception 'say why' using errcode = '22023';
  end if;
  select * into v_o from nurse_order where id = p_order_id and deleted_at is null for update;
  if not found then
    raise exception 'order not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  perform 1 from nurse_order_dose d where d.order_id = v_o.id and d.deleted_at is null for update;
  select coalesce(array_agg(d.id order by d.n), '{}'::uuid[]) into v_doses
  from nurse_order_dose d
  where d.order_id = v_o.id and d.deleted_at is null and (d.given or v_o.every_minutes is not null);
  if cardinality(v_doses) = 0 then
    raise exception 'nothing was given or done on this order: there is nothing to undo' using errcode = '22023';
  end if;
  return undo_order_doses(v_o, v_doses, v_reason, v_o.every_minutes is null);
end
$$;

-- One time of a repeated order undone (0198): the person who recorded it the same day, or the
-- manager. A time given goes back to the stock and off the bill (a credit note on a closed bill);
-- a time not given is simply withdrawn. The order stays open (never cancelled by a time's Undo);
-- the doctor is told. A one-time order: undo_nurse_order.
create or replace function undo_order_time(p_dose_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_d nurse_order_dose%rowtype;
  v_o nurse_order%rowtype;
begin
  if auth.uid() is null or not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why' using errcode = '22023';
  end if;
  select * into v_d from nurse_order_dose where id = p_dose_id and deleted_at is null;
  if not found then
    raise exception 'this time is not recorded (or already undone)' using errcode = 'P0002', hint = 'no_such_time';
  end if;
  select * into v_o from nurse_order where id = v_d.order_id and deleted_at is null for update;
  if not found then
    raise exception 'order not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_o.every_minutes is null then
    return undo_nurse_order(v_o.id, p_reason);
  end if;
  return undo_order_doses(v_o, array[p_dose_id], p_reason, false);
end
$$;

-- ---------------------------------------------------------------- 11 stopping, over, the visit ends
-- stop_nurse_order (from 20270107090000_six_steps): + a repeated order (0198): the doctor who wrote
-- it or the manager stops the rest (done when a time was given, else cancelled; the reason kept as
-- "stopped: …"); the nurse records each time instead (hint doctor_stops). A one-time order as before.
create or replace function stop_nurse_order(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype;
  v_status text;
  v_reason text;
begin
  if auth.uid() is null or not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why' using errcode = '22023';
  end if;
  select * into v_o from nurse_order where id = p_order_id and deleted_at is null for update;
  if not found then
    raise exception 'order not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_o.status <> 'open' then
    raise exception 'this order is already over' using errcode = '22023', hint = 'order_over';
  end if;
  v_reason := trim(p_reason);
  if v_o.every_minutes is not null then
    -- 0198: a repeated order: the rest of its times
    if not (v_o.created_by = auth.uid() or is_manager()) then
      if nurse_order_mine(v_o.assigned_to) then
        raise exception 'the doctor who wrote it stops a repeated order: record each time as given or not given'
          using errcode = '42501', hint = 'doctor_stops';
      end if;
      raise exception 'not allowed: this order is for another nurse' using errcode = '42501', hint = 'not_yours';
    end if;
    v_status := case when exists (select 1 from nurse_order_dose d where d.order_id = v_o.id and d.deleted_at is null and d.given)
                     then 'done' else 'cancelled' end;
    v_reason := 'stopped: ' || v_reason;
  elsif v_o.created_by = auth.uid() or is_manager() then
    v_status := 'cancelled';
  elsif nurse_order_mine(v_o.assigned_to) then
    v_status := 'not_done';
  else
    raise exception 'not allowed: this order is for another nurse' using errcode = '42501', hint = 'not_yours';
  end if;
  update nurse_order set status = v_status, ended_at = now(), ended_by = auth.uid(), end_reason = v_reason
  where id = p_order_id;
  if v_status = 'not_done' then
    perform nurse_order_tell(p_order_id, 'not_done', trim(p_reason));
  elsif v_o.assigned_to is not null and v_o.assigned_to <> auth.uid() then
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('nurse_order_done',
            jsonb_build_object('orderId', v_o.id, 'title', v_o.text, 'what', 'cancelled', 'reason', trim(p_reason),
                               'name', (select p.surname || ' ' || p.given_names from patient p where p.id = v_o.patient_id),
                               'by', (select full_name from profiles where id = auth.uid()),
                               -- 0198: the rest of a repeated order
                               'rest', v_o.every_minutes is not null),
            '/app/visit?encounter=' || v_o.encounter_id, v_o.assigned_to, auth.uid());
  end if;
  return nurse_order_json(p_order_id);
end
$$;

-- nurse_order_close_if_complete (from 20270107090000_six_steps): + a repeated order until stopped
-- is never over by itself (0198). Otherwise over once every time is recorded: done when something
-- was given, else not done.
create or replace function nurse_order_close_if_complete(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype;
  v_n integer;
  v_given integer;
begin
  select * into v_o from nurse_order where id = p_id;
  if v_o.doses_planned is null then
    return;
  end if;
  select count(*), count(*) filter (where given) into v_n, v_given
  from nurse_order_dose where order_id = p_id and deleted_at is null;
  if v_n >= v_o.doses_planned then
    update nurse_order
    set status = case when v_given > 0 then 'done' else 'not_done' end, ended_at = now(), ended_by = auth.uid()
    where id = p_id;
    perform nurse_order_tell(p_id, case when v_given > 0 then 'done' else 'not_done' end);
  end if;
end
$$;

-- The visit ends (0198): its open repeated orders end too ("visit over": done when a time was
-- given, else not done); the times not yet given are not given. One-time orders as before.
create or replace function orders_follow_visit()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'closed' and old.status is distinct from 'closed' then
    update nurse_order o
    set status = case when exists (select 1 from nurse_order_dose d where d.order_id = o.id and d.deleted_at is null
                                     and d.given) then 'done' else 'not_done' end,
        ended_at = now(), ended_by = auth.uid(), end_reason = 'visit over'
    where o.encounter_id = new.id and o.status = 'open' and o.every_minutes is not null and o.deleted_at is null;
  end if;
  return new;
end
$$;
drop trigger if exists encounter_orders_done on encounter;
create trigger encounter_orders_done after update of status on encounter
  for each row execute function orders_follow_visit();

-- ---------------------------------------------------------------- 12 the lists, by time
-- nurse_orders_for_me (from 20270107090000_six_steps): + the bed the patient is in; ordered by the
-- next time due (0198), then as before (oldest first).
create or replace function nurse_orders_for_me()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(nurse_order_json(o.id) || jsonb_build_object(
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number, 'patientId', p.id,
      'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = e.id and q.deleted_at is null
                 order by q.created_at limit 1),
      -- 0198
      'bed', (select b.name from bed_stay s join bed b on b.id = s.bed_id
              where s.encounter_id = e.id and s.discharged_at is null and s.deleted_at is null
              order by s.admitted_at desc limit 1))
    order by nd.next_due nulls last, o.created_at), '[]'::jsonb)
  from nurse_order o
  join encounter e on e.id = o.encounter_id and e.status = 'open' and e.deleted_at is null
  join patient p on p.id = o.patient_id
  left join lateral (select min(t.due_at) as next_due from order_times(o.id) t where t.dose_id is null) nd on true
  where o.deleted_at is null and o.status = 'open' and has_perm('clinical.write')
    and nurse_order_mine(o.assigned_to)
$$;

-- visit_nurse_orders (from 20270107090000_six_steps): the open orders by their next time due, the
-- others when they were written (0198); who reads what as before.
create or replace function visit_nurse_orders(p_encounter_id uuid, p_desk boolean default false)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(nurse_order_json(o.id)
                            order by case when o.status = 'open' then coalesce(nd.next_due, o.created_at)
                                          else o.created_at end, o.created_at), '[]'::jsonb)
  from nurse_order o
  left join lateral (select min(t.due_at) as next_due from order_times(o.id) t
                     where t.dose_id is null and o.status = 'open') nd on true
  where o.encounter_id = p_encounter_id and o.deleted_at is null
    and (not p_desk or nurse_order_mine(o.assigned_to) or o.created_by = auth.uid())
$$;

-- ---------------------------------------------------------------- 13 late notices
-- The catch-up (nothing runs by itself; the web runs it from the nurse's Home and the beds board):
-- each time more than an hour late (within the last day, not recorded) of an open order on an open
-- visit written with a time (0198 onwards) sends one notice, never twice, to the nurse named or
-- every nurse. Anyone signed in may run it. Answers how many late times were told.
create or replace function order_times_catch_up()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_t record;
  v_n integer := 0;
  v_params jsonb;
  v_link text;
begin
  if auth.uid() is null or current_role_key() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  for v_t in
    select o.id as order_id, o.encounter_id, o.text, o.assigned_to, o.patient_id, o.kind, t.n, t.due_at
    from nurse_order o
    join encounter e on e.id = o.encounter_id and e.status = 'open' and e.deleted_at is null
    cross join lateral order_times(o.id) t
    where o.deleted_at is null and o.status = 'open' and o.first_at is not null
      and t.dose_id is null and t.due_at < now() - interval '60 minutes' and t.due_at >= now() - interval '24 hours'
      and not exists (select 1 from order_time_notice x where x.order_id = o.id and x.n = t.n and x.kind = 'late')
    order by t.due_at
  loop
    insert into order_time_notice (order_id, n, kind) values (v_t.order_id, v_t.n, 'late') on conflict do nothing;
    if not found then
      continue;
    end if;
    v_link := '/app/visit?encounter=' || v_t.encounter_id;
    v_params := jsonb_build_object(
      'orderId', v_t.order_id, 'kind', v_t.kind, 'title', v_t.text, 'n', v_t.n, 'dueAt', v_t.due_at,
      'time', to_char(v_t.due_at at time zone 'Africa/Kigali', 'HH24:MI'),
      'name', (select p.surname || ' ' || p.given_names from patient p where p.id = v_t.patient_id));
    if v_t.assigned_to is not null then
      insert into notification (kind, params, link, recipient_user, created_by)
      values ('nurse_order_late', v_params, v_link, v_t.assigned_to, null);
    else
      insert into notification (kind, params, link, recipient_user, created_by)
      select 'nurse_order_late', v_params, v_link, p.id, null
      from profiles p
      where p.active and p.deleted_at is null and is_nurse_role(p.id);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- ---------------------------------------------------------------- 14 the stock the order form sees
-- rx_stock (from 20270213090000_orders_once_take_home): + 'open': what is left of the opened pieces
-- of each medicine at the main pharmacy (of one piece; 0198). The web reads 'open' to know the
-- database has 0198.
create or replace function rx_stock()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_loc uuid := main_pharmacy();
begin
  if not (has_perm('clinical.write') or has_perm('stock.read') or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'locationId', v_loc,
    'items', coalesce((
      select jsonb_object_agg(x.item_id, x.n)
      from (select s.item_id, sum(s.quantity)::integer as n from stock_on_hand s
            where s.location_id = v_loc and s.quantity > 0 and (s.expiry is null or s.expiry >= current_date)
            group by s.item_id) x), '{}'::jsonb),
    -- 0193: the boxes
    'packs', coalesce((
      select jsonb_object_agg(i.id, jsonb_build_object('size', i.pack_size, 'packUnit', i.pack_unit,
                                                       'mode', coalesce(i.sale_mode, 'piece'), 'packPrice', i.pack_price))
      from item i
      where i.active and i.deleted_at is null and coalesce(i.pack_size, 1) >= 2), '{}'::jsonb),
    -- 0198: the opened pieces
    'open', coalesce((
      select jsonb_object_agg(x.item_id, x.left_part)
      from (select p.item_id, sum(p.left_part) as left_part from open_piece p
            where p.location_id = v_loc and p.closed_at is null and p.left_part > 0
              and open_piece_usable(p.batch_id) -- review 0198: not an expired batch
            group by p.item_id) x), '{}'::jsonb));
end
$$;

-- ---------------------------------------------------------------- 15 the sales report: parts
-- stock_sales (from 20270213090000_orders_once_take_home): a part of a piece counts as that part
-- (½ tablet = 0.5 piece; 0198). Everything else as before.
create or replace function stock_sales(p_from date, p_to date)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with sold as (
    select l.item_id, (l.quantity * coalesce(l.pack_size, 1) * coalesce(l.part, 1))::numeric as units, round(l.quantity * l.unit_price) as revenue
    from invoice_line l
    join invoice inv on inv.id = l.invoice_id and inv.status <> 'credited'
    where l.deleted_at is null and l.item_id is not null
      and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
      -- 0193: not an undone order time
      and not exists (select 1 from nurse_order_dose nd where nd.id = l.nurse_order_dose_id and nd.deleted_at is not null)
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
  ),
  -- 0174: every line, with who it was for and who sold or gave it
  lines as (
    select l.created_at as at, 'visit'::text as kind,
           i.name_generic || coalesce(' ' || i.strength, '') as item,
           (l.quantity * coalesce(l.pack_size, 1) * coalesce(l.part, 1))::numeric as units,
           round(l.quantity * l.unit_price) as amount,
           trim(coalesce(pt.surname, '') || ' ' || coalesce(pt.given_names, '')) as who,
           coalesce(l.performed_by, l.created_by) as by_id,
           inv.number as ref
    from invoice_line l
    join invoice inv on inv.id = l.invoice_id and inv.status <> 'credited'
    join item i on i.id = l.item_id
    left join encounter e on e.id = inv.encounter_id
    left join patient pt on pt.id = e.patient_id
    where l.deleted_at is null and l.item_id is not null
      and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
      -- 0193: not an undone order time
      and not exists (select 1 from nurse_order_dose nd where nd.id = l.nurse_order_dose_id and nd.deleted_at is not null)
    union all
    select s.handed_over_at, 'walkin', i.name_generic || coalesce(' ' || i.strength, ''),
           x.quantity, x.line_total, s.buyer_name,
           coalesce(s.handed_over_by, s.created_by), s.number
    from counter_sale_line x
    join counter_sale s on s.id = x.sale_id
    join item i on i.id = x.item_id
    where x.deleted_at is null and s.deleted_at is null and s.status = 'handed_over'
      and (s.handed_over_at at time zone 'Africa/Kigali')::date between p_from and p_to
  ),
  named as (
    select ln.*, pr.full_name as by_name from lines ln left join profiles pr on pr.id = ln.by_id
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
                   left join batch b on b.id = s.batch_id where s.quantity > 0),
    -- 0174: who sold or gave, and every line (the latest first, at most 2,000)
    'byPerson', coalesce((select jsonb_agg(jsonb_build_object(
        'id', n.by_id, 'name', coalesce(n.by_name, '—'), 'lines', n.lines, 'units', n.units, 'amount', n.amount,
        'given', n.given, 'sold', n.sold
      ) order by n.amount desc, n.by_name)
      from (select by_id, by_name, count(*)::int as lines, sum(units) as units, sum(amount) as amount,
                   sum(amount) filter (where kind = 'visit') as given, sum(amount) filter (where kind = 'walkin') as sold
            from named group by by_id, by_name) n), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
        'at', n.at, 'kind', n.kind, 'item', n.item, 'units', n.units, 'amount', n.amount,
        'who', n.who, 'by', coalesce(n.by_name, '—'), 'ref', n.ref
      ) order by n.at desc)
      from (select * from named order by at desc limit 2000) n), '[]'::jsonb)
  )
  -- 0174: the desk is enough (the role permission stock.read as well)
  where stock_admin() or has_perm('stock.read')
$$;

-- ---------------------------------------------------------------- 15b Sold & given: parts
-- report_stock_sold (from 20270213090000_orders_once_take_home): review 0198 — a time that takes its
-- part from a piece already open has no stock movement, so its money was missing from the report;
-- it now counts (its money, no piece). Everything else as before.
create or replace function report_stock_sold(
  p_from date, p_to date, p_location_id uuid default null, p_channel text default null, p_split boolean default false
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_admin boolean := stock_admin();
  v_vis uuid[] := visible_stores();
  v_split boolean := coalesce(p_split, false);
begin
  perform report_assert_stock(p_location_id);
  perform report_assert_period(p_from, p_to);
  return coalesce((
    with ev as (
      select d.item_id,
             (select m.from_location_id from stock_movement m
              where m.dispense_id = d.id and m.type = 'dispense' and m.deleted_at is null limit 1) as location_id,
             'handover'::text as channel, d.quantity::numeric as pieces,
             (select coalesce(sum(m.quantity * coalesce(m.unit_cost, b.unit_cost, 0)), 0)
              from stock_movement m left join batch b on b.id = m.batch_id
              where m.dispense_id = d.id and m.type = 'dispense' and m.deleted_at is null) as cost,
             (select coalesce(sum(round(l.quantity * l.unit_price)), 0)
              from invoice_line l join invoice inv on inv.id = l.invoice_id and inv.status <> 'credited'
              where l.source_type = 'medication_dispense' and l.source_id = d.id and l.deleted_at is null) as revenue
      from medication_dispense d
      where d.deleted_at is null and (d.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
      union all
      select g.item_id, g.location_id, 'here', g.pieces, g.cost,
             (select coalesce(sum(round(l.quantity * l.unit_price)), 0)
              from invoice_line l join invoice inv on inv.id = l.invoice_id and inv.status <> 'credited'
              where l.source_type = 'medication_request' and l.source_id = g.request_id and l.deleted_at is null)
      from (
        select m.medication_request_id as request_id, m.item_id, m.from_location_id as location_id,
               sum(m.quantity)::numeric as pieces, sum(m.quantity * coalesce(m.unit_cost, b.unit_cost, 0)) as cost
        from stock_movement m left join batch b on b.id = m.batch_id
        where m.deleted_at is null and m.type = 'consumption' and m.medication_request_id is not null
          and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to
          and not exists (select 1 from stock_movement r
                          where r.medication_request_id = m.medication_request_id and r.type = 'return'
                            and r.dispense_id is null and r.deleted_at is null)
        group by 1, 2, 3
      ) g
      union all
      -- 0193: the times of the orders (given here and taken home), not undone
      select o.item_id, o.location_id, 'here', o.pieces, o.cost,
             (select coalesce(sum(round(l.quantity * l.unit_price)), 0)
              from invoice_line l join invoice inv on inv.id = l.invoice_id and inv.status <> 'credited'
              where l.nurse_order_dose_id = o.dose_id and l.deleted_at is null)
      from (
        select m.nurse_order_dose_id as dose_id, m.item_id, m.from_location_id as location_id,
               sum(m.quantity)::numeric as pieces, sum(m.quantity * coalesce(m.unit_cost, b.unit_cost, 0)) as cost
        from stock_movement m
        join nurse_order_dose nd on nd.id = m.nurse_order_dose_id and nd.deleted_at is null
        left join batch b on b.id = m.batch_id
        where m.deleted_at is null and m.type = 'consumption' and m.nurse_order_dose_id is not null
          and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to
        group by 1, 2, 3
      ) o
      union all
      -- review 0198: a part taken from a piece already open leaves no stock movement: its money
      -- (no piece) counts all the same
      select o.item_id, nd.location_id, 'here', 0::numeric, 0::numeric,
             (select coalesce(sum(round(l.quantity * l.unit_price)), 0)
              from invoice_line l join invoice inv on inv.id = l.invoice_id and inv.status <> 'credited'
              where l.nurse_order_dose_id = nd.id and l.deleted_at is null)
      from nurse_order_dose nd
      join nurse_order o on o.id = nd.order_id and o.kind = 'drug' and o.item_id is not null
      where nd.deleted_at is null and nd.given and nd.part is not null
        and (nd.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
        and not exists (select 1 from stock_movement m
                        where m.nurse_order_dose_id = nd.id and m.type = 'consumption' and m.deleted_at is null)
      union all
      select x.item_id, s.location_id, 'walkin', x.pieces,
             (select coalesce(sum(h.quantity * coalesce(h.unit_cost, 0)), 0)
              from counter_sale_held(s.id) h where h.item_id = x.item_id),
             x.revenue
      from counter_sale s
      join (select sale_id, item_id, sum(quantity)::numeric as pieces, sum(line_total) as revenue
            from counter_sale_line where deleted_at is null group by 1, 2) x on x.sale_id = s.id
      where s.deleted_at is null and s.status = 'handed_over'
        and (s.handed_over_at at time zone 'Africa/Kigali')::date between p_from and p_to
    ), seen as (
      select * from ev
      where (v_vis is null or ev.location_id = any (v_vis))
        and (p_location_id is null or ev.location_id = p_location_id)
        and (p_channel is null or p_channel = '' or ev.channel = p_channel)
    ), agg as (
      select item_id, case when v_split then channel end as channel,
             case when v_split then location_id end as location_id,
             case when count(distinct location_id) = 1 then min(location_id::text)::uuid end as only_store,
             sum(pieces) as pieces,
             coalesce(sum(pieces) filter (where channel = 'handover'), 0) as handover,
             coalesce(sum(pieces) filter (where channel = 'here'), 0) as here,
             coalesce(sum(pieces) filter (where channel = 'walkin'), 0) as walkin,
             count(*)::integer as times,
             sum(revenue) as revenue, sum(cost) as cost
      from seen group by 1, 2, 3
    )
    select jsonb_agg(jsonb_build_object(
        'itemId', i.id, 'code', i.code, 'name', i.name_generic || coalesce(' ' || i.strength, ''),
        'unit', i.selling_unit, 'packSize', case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end,
        'packUnit', i.pack_unit, 'kind', i.kind, 'group', i.atc_group,
        'channel', a.channel, 'storeId', coalesce(a.location_id, a.only_store), 'store', l.name,
        'pieces', a.pieces, 'handover', a.handover, 'here', a.here, 'walkin', a.walkin, 'times', a.times,
        'revenue', round(a.revenue),
        'cost', case when v_admin then round(a.cost, 2) end,
        'margin', case when v_admin then round(a.revenue - a.cost, 2) end
      ) order by a.revenue desc, i.name_generic, l.name)
    from agg a
    join item i on i.id = a.item_id
    left join stock_location l on l.id = coalesce(a.location_id, a.only_store)
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- 16 the change log hides the words
-- audit_redact (from 20270213090000_orders_once_take_home): + the reason of a part's price (0198).
create or replace function audit_redact(p_entity text, p jsonb)
returns jsonb
language sql immutable
as $$
  select case
    when p is null or jsonb_typeof(p) <> 'object' or not audit_redacted_entity(p_entity) then p
    else p - array['text', 'icd10_code', 'value_text', 'findings', 'impression', 'reason', 'instructions',
                   'note', 'notes', 'detail', 'title', 'triage_reason', 'referral_note', 'no_diagnosis_kind',
                   'no_diagnosis_note', 'correction_reason', 'edit_reason', 'old_findings', 'old_impression',
                   'allergies', 'allergies_none', 'blood_group', 'answer_note', 'review_note',
                   'not_given_reason', 'cancel_reason', 'supply_reason', 'dose', 'frequency', 'route',
                   'result', 'conclusion', 'extra', 'flags', 'outcome', 'summary', 'end_reason',
                   -- 0193
                   'home_dose', 'home_frequency', 'home_instructions', 'undo_reason',
                   -- 0198
                   'part_price_reason']
  end
$$;

-- ---------------------------------------------------------------- 17 the menu counts
-- nav_counts (from 20270216090000_beds_stay): 0198 — the nurse's orders count what is due now or
-- late (not an order for later), + nurseOrdersLate. Everything else as before (the whole body of
-- 0197 kept).
create or replace function nav_counts()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_role role_key := current_role_key();
  v_manager boolean := is_manager();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_start timestamptz;
  v_end timestamptz;
  v_desks text[] := my_desk_list();
  v_station station;
  -- a doctor's or nurse's desk: consultation, dental, nursing, triage…
  v_treat boolean;
  v_pharmacy boolean;
  v_out jsonb := '{}'::jsonb;
  v_n integer;
  v_e integer;
  v_l integer; -- 0198
begin
  if v_me is null or v_role is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  v_start := (v_today::timestamp) at time zone 'Africa/Kigali';
  v_end := ((v_today + 1)::timestamp) at time zone 'Africa/Kigali';
  v_station := my_home_station();
  -- 0128: the manager counts the work of their own desks, like anyone of their profession
  v_treat := v_role not in ('receptionist', 'cashier', 'administrator')
             and v_desks && (treating_desks() || array['triage']);
  v_pharmacy := 'pharmacy' = any (v_desks);

  -- MY QUEUE and THE PATIENTS AT MY DESKS (the rule of my_summary's "Waiting for me"): an entry
  -- that joined the queue today is today's; an older one still open is from an earlier day.
  if v_treat and has_perm('queue.read') and has_perm('patient.read') then
    with mine as (
      select q.encounter_id, q.started_at, (q.created_at >= v_start or visit_in_bed(q.encounter_id)) as is_today
      from queue_entry q
      join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
      where q.deleted_at is null and q.finished_at is null
        and (q.assigned_to = v_me
             or q.taken_by = v_me
             or exists (select 1 from patient_handover h
                        where h.queue_id = q.id and h.status = 'pending' and h.to_user = v_me
                          and h.deleted_at is null)
             or (q.assigned_to is null and q.taken_by is null
                 and (serves_station(v_me, q.station, coalesce(q.service, e.service))
                      or q.station = v_station)
                 and (q.department_id is null
                      or exists (select 1 from profiles me where me.id = v_me and me.department_id = q.department_id)
                      or exists (select 1 from staff_department sd
                                 where sd.profile_id = v_me and sd.department_id = q.department_id))))
    ),
    -- a patient with an entry of today is today's, even when an older one is still open
    visits as (select encounter_id, bool_or(is_today) as is_today from mine group by encounter_id)
    select jsonb_build_object(
             'queue', (select count(*) from mine where started_at is null and is_today),
             'queueEarlier', (select count(*) from mine where started_at is null and not is_today),
             'inClinic', (select count(*) from visits where is_today),
             'inClinicEarlier', (select count(*) from visits where not is_today))
    into v_out;
  end if;
  -- the manager's In clinic is the whole clinic (oversight)
  if (v_manager or (not v_treat and v_role = 'receptionist')) and has_perm('patient.read') then
    select v_out || jsonb_build_object(
             'inClinic', count(*) filter (where e.arrived_at >= v_start or visit_in_bed(e.id)),
             'inClinicEarlier', count(*) filter (where e.arrived_at < v_start and not visit_in_bed(e.id)))
    into v_out
    from encounter e where e.status = 'open' and e.deleted_at is null;
  end if;

  -- RESULTS FOR ME and MY PRESCRIPTIONS AT THE PHARMACY: whoever has those menu entries (a doctor
  -- at a treating desk; anyone a department of theirs gives a doctor's desk; as the menu decides)
  if ((v_role = 'doctor' and v_desks && treating_desks())
          or exists (select 1 from unnest(array['consultation', 'dental', 'surgery', 'circ']) d(desk)
                     where desk_via(v_me, d.desk) = 'department')) then
    -- given today and not seen; given on one of the 6 days before and still not seen: earlier
    select count(*) filter (where d.updated_at >= v_start),
           count(*) filter (where d.updated_at < v_start)
    into v_n, v_e
    from diagnostic_report d
    join service_request r on r.id = d.service_request_id and r.deleted_at is null
    where d.deleted_at is null and d.reviewed_at is null
      and r.status in ('resulted', 'verified')
      and d.updated_at > now() - interval '7 days'
      -- cheap first: my own request, or a visit handed over to me
      and (r.requester_id = v_me
           or exists (select 1 from patient_handover h where h.encounter_id = r.encounter_id
                      and h.to_user = v_me and h.status = 'taken' and h.deleted_at is null))
      and result_recipient(r.encounter_id, r.requester_id) = v_me;
    -- 0126: results are records: counted for doctors
    if is_doctor() then
      v_out := v_out || jsonb_build_object('results', v_n, 'resultsEarlier', v_e);
    end if;

    -- written today and still waiting at the pharmacy; written earlier: apart
    select count(*) filter (where m.created_at >= v_start),
           count(*) filter (where m.created_at < v_start)
    into v_n, v_e
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open' and e.deleted_at is null
    where coalesce(m.prescriber_id, m.created_by) = v_me and rx_pending(m);
    v_out := v_out || jsonb_build_object('prescriptions', v_n, 'prescriptionsEarlier', v_e);
  end if;

  -- MY BOOKINGS STILL TO SEE, today to 3 weeks ahead (whoever keeps a calendar; 0124, 0125)
  if has_perm('appointment.accept') or v_manager then
    select count(*) into v_n
    from appointment a
    join practitioner pr on pr.id = a.practitioner_id and pr.user_id = v_me and pr.deleted_at is null
    where a.deleted_at is null
      -- still to be seen: booked, confirmed or arrived; once the visit is taken (in progress) or
      -- done it leaves the count, one by one
      and a.status in ('approved', 'confirmed', 'arrived')
      and a.starts_at >= v_start and a.starts_at < v_start + interval '22 days';
    if v_n > 0 or exists (select 1 from practitioner pr where pr.user_id = v_me and pr.deleted_at is null) then
      v_out := v_out || jsonb_build_object('myBookings', v_n);
    end if;
  end if;

  -- TODAY'S BOOKINGS + THE REQUESTS THAT CAME TODAY (reception's Bookings page); requests still
  -- unanswered from an earlier day: apart
  if v_manager or v_role = 'receptionist' or has_perm('appointment.approve') then
    -- still to come in: booked or confirmed for today (an arrival leaves the count), and the
    -- requests of today still to answer
    select count(*) filter (where (a.status in ('approved', 'confirmed')
                                   and a.starts_at >= v_start and a.starts_at < v_end)
                                  or (a.status = 'inquiry' and a.created_at >= v_start)),
           count(*) filter (where a.status = 'inquiry' and a.created_at < v_start)
    into v_n, v_e
    from appointment a
    where a.deleted_at is null;
    v_out := v_out || jsonb_build_object('bookings', v_n, 'bookingsEarlier', v_e);
  end if;

  -- THE LABORATORY / ULTRASOUND WORKLIST (the rule of lab_worklist, open): asked today; earlier
  if v_desks && array['laboratory', 'ultrasound'] and has_perm('orders.read') then
    select count(*) filter (where r.created_at >= v_start),
           count(*) filter (where r.created_at < v_start)
    into v_n, v_e
    from service_request r
    join encounter e on e.id = r.encounter_id and e.status = 'open'
    where r.deleted_at is null
      and r.status not in ('verified', 'cancelled')
      and r.category = any (my_test_categories())
      and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station
                                   else 'laboratory'::station end) in ('laboratory', 'ultrasound')
      and (has_perm('sensitive.read') or may_use_desk(request_desk(r.station, r.category))
           or not sensitive_service(r.service_id));
    v_out := v_out || jsonb_build_object('worklist', v_n, 'worklistEarlier', v_e);
  end if;

  -- THE PHARMACY: patients with medicines written today to hand over + walk-in sales of today
  -- paid and not handed over; a patient whose medicines all date from an earlier day, and older
  -- walk-in sales: apart
  if v_pharmacy then
    with pending as (
      select m.encounter_id, bool_or(m.created_at >= v_start) as is_today
      from medication_request m
      join encounter e on e.id = m.encounter_id and e.status = 'open'
      where rx_pending(m)
      group by m.encounter_id
    ), sales as (
      select (s.created_at >= v_start) as is_today
      from counter_sale s
      join stock_location l on l.id = s.location_id
      where s.deleted_at is null and s.status = 'paid' and not is_room_type(l.type)
    )
    select (select count(*) from pending where is_today) + (select count(*) from sales where is_today),
           (select count(*) from pending where not is_today) + (select count(*) from sales where not is_today)
    into v_n, v_e;
    v_out := v_out || jsonb_build_object('pharmacy', v_n, 'pharmacyEarlier', v_e);
  elsif exists (
      select 1 from stock_location l
      where l.active and l.deleted_at is null and is_room_type(l.type) and holds_store(v_me, l.id)) then
    -- A ROOM STORE (a doctor's office, the ward): delivery notes sent today to confirm + walk-in
    -- sales of today to give; older ones apart
    with w as (
      select (t.sent_at >= v_start) as is_today from stock_transfer t
      where t.deleted_at is null and t.status = 'in_transit' and t.direction = 'to_room'
        and holds_store(v_me, t.to_location_id)
      union all
      select (s.created_at >= v_start) from counter_sale s
      join stock_location l on l.id = s.location_id
      where s.deleted_at is null and s.status = 'paid' and is_room_type(l.type)
        and holds_store(v_me, s.location_id)
    )
    select count(*) filter (where is_today), count(*) filter (where not is_today) into v_n, v_e from w;
    v_out := v_out || jsonb_build_object('stock', v_n, 'stockEarlier', v_e);
  end if;

  -- MONEY: bills opened today with something still to pay (open visits), walk-in sales of today
  -- waiting to be paid; older ones apart
  if v_manager or v_role = 'cashier' or has_perm('payment.take') then
    select count(*) filter (where i.created_at >= v_start),
           count(*) filter (where i.created_at < v_start)
    into v_n, v_e
    from invoice i join encounter e on e.id = i.encounter_id
    where i.deleted_at is null and i.status = 'draft' and e.status = 'open'
      and invoice_balance(i.id) > 0;
    v_out := v_out || jsonb_build_object('bills', v_n, 'billsEarlier', v_e);
  end if;
  if not v_manager and (v_role = 'cashier' or has_perm('payment.take')) then
    select count(*) filter (where s.created_at >= v_start),
           count(*) filter (where s.created_at < v_start)
    into v_n, v_e
    from counter_sale s where s.deleted_at is null and s.status = 'open';
    v_out := v_out || jsonb_build_object('payments', v_n, 'paymentsEarlier', v_e);
  end if;

  -- RECORD ACCESS: requests waiting for an answer (record_access_requests 'pending'); not day-bound
  -- 0126: doctors only; the requests this doctor may answer
  if is_doctor() then
    v_n := (select count(*) from record_access_request r
            join encounter e on e.id = r.encounter_id and e.status = 'open'
            where r.kind = 'request' and r.status = 'pending' and r.requested_by <> v_me
              and r.created_at > now() - interval '90 days'
              and may_answer_request(r.patient_id, r.requested_by))
           + case when v_manager then
               (select count(*) from record_access_request r
                where r.kind = 'emergency' and r.reviewed_at is null
                  and r.created_at > now() - interval '90 days')
             else 0 end;
    if v_n > 0 or v_manager or has_perm('records.approve') then
      v_out := v_out || jsonb_build_object('recordAccess', v_n);
    end if;
  end if;

  -- STAFF DOCUMENTS expiring within 60 days, or expired (staff_documents_expiring); not day-bound
  if v_manager then
    v_out := v_out || jsonb_build_object('documents',
      (select count(*) from staff_document d
       join profiles p on p.id = d.profile_id and p.active
       where d.deleted_at is null and d.kind in ('licence', 'contract')
         and d.expires_on is not null and d.expires_on <= staff_doc_today() + 60));
  end if;

  -- FILES TO COMPLETE (reception): today's only (0123), as the list opens
  if v_role = 'receptionist' and has_perm('patient.read') then
    v_out := v_out || jsonb_build_object('filesToComplete',
      (with s as (select patient_builtins() as b, patient_fields() as f)
       select count(distinct p.id)
       from patient p
       cross join s
       left join encounter e on e.patient_id = p.id and e.status = 'open' and e.deleted_at is null
       where p.deleted_at is null and p.merged_into is null
         and (coalesce(e.arrived_at, p.created_at) at time zone 'Africa/Kigali')::date
             = (now() at time zone 'Africa/Kigali')::date
         and cardinality(patient_missing_with(p, s.b, s.f)) > 0));
  end if;

  -- 0127: THE ORDERS OF THE DOCTORS TO CARRY OUT (the nurse's Home): mine by name, and those for
  -- all the nurses when I work at the nursing desk. 0198: only those with a time due now or late (a
  -- time within the next 30 minutes, or past; an order written before 0198 since it was written):
  -- due today, due on an earlier day; + nurseOrdersLate: the times more than an hour late, on the
  -- orders written with a time (0198 onwards). An order for later is not counted until it is due.
  if has_perm('clinical.write') then
    with mine as (
      select case when o.every_minutes is null then coalesce(o.first_at, o.created_at)
                  else (select min(t.due_at) from order_times(o.id) t where t.dose_id is null) end as next_due,
             case when o.first_at is null then 0
                  when o.every_minutes is null then (o.first_at < now() - interval '60 minutes')::integer
                  else (select count(*)::integer from order_times(o.id) t
                        where t.dose_id is null and t.due_at < now() - interval '60 minutes') end as late_n
      from nurse_order o
      join encounter e on e.id = o.encounter_id and e.status = 'open' and e.deleted_at is null
      where o.deleted_at is null and o.status = 'open' and nurse_order_mine(o.assigned_to)
    )
    select count(*) filter (where next_due <= now() + interval '30 minutes' and next_due >= v_start),
           count(*) filter (where next_due <= now() + interval '30 minutes' and next_due < v_start),
           coalesce(sum(late_n), 0)
    into v_n, v_e, v_l
    from mine;
    if v_n + v_e > 0 or task_for_me('nurse') then
      v_out := v_out || jsonb_build_object('nurseOrders', v_n, 'nurseOrdersEarlier', v_e, 'nurseOrdersLate', v_l);
    end if;
  end if;

  -- 0197: PATIENTS IN BEDS now (information): whoever reads the beds
  if has_perm('queue.read') or has_perm('billing.write') or has_perm('payment.take') then
    v_out := v_out || jsonb_build_object('inBeds',
      (select count(distinct s.encounter_id) from bed_stay s
       join encounter e on e.id = s.encounter_id and e.status = 'open' and e.deleted_at is null
       where s.discharged_at is null and s.deleted_at is null));
  end if;

  -- an "earlier" count only when there is something from an earlier day
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_out
  from jsonb_each(v_out) x(k, v)
  where not (k like '%Earlier' and v = '0'::jsonb);

  return v_out;
end
$$;

-- ---------------------------------------------------------------- rights
-- (functions replaced with the same arguments keep their grants; the new ones need theirs)
revoke all on function
  part_mode_by(text, text, integer, text, text, numeric),
  item_part_text(uuid, numeric), open_part_left(uuid, uuid), open_piece_usable(uuid), item_dose_json(uuid),
  take_part(uuid, uuid, numeric, uuid), return_parts(uuid[]),
  add_part_charge_internal(uuid, station, uuid, numeric, text, numeric, text, uuid, uuid, text, uuid),
  order_times(uuid), carry_out_time(nurse_order, integer, timestamptz, timestamptz, text, uuid, numeric, numeric),
  undo_order_doses(nurse_order, uuid[], text, boolean), orders_follow_visit()
  from public, anon, authenticated;
-- the catalogue view (security invoker) works it out for the reader
revoke all on function item_part_mode(uuid) from public, anon;
grant execute on function item_part_mode(uuid) to authenticated;
revoke all on function
  set_item_dose(uuid, numeric, text, numeric, text, numeric, text, text, text, numeric, numeric, numeric),
  close_open_piece(uuid, text), open_pieces(uuid),
  create_order_planned(uuid, text, uuid, uuid, text, numeric, numeric, text, numeric, text, text, text, numeric, text,
                       timestamptz, integer, integer, boolean, numeric, text, text, integer, text, uuid, text),
  give_order_time(uuid, integer, text, timestamptz), skip_order_time(uuid, integer, text),
  undo_order_time(uuid, text), order_times_catch_up()
  from public, anon;
grant execute on function
  set_item_dose(uuid, numeric, text, numeric, text, numeric, text, text, text, numeric, numeric, numeric),
  close_open_piece(uuid, text), open_pieces(uuid),
  create_order_planned(uuid, text, uuid, uuid, text, numeric, numeric, text, numeric, text, text, text, numeric, text,
                       timestamptz, integer, integer, boolean, numeric, text, text, integer, text, uuid, text),
  give_order_time(uuid, integer, text, timestamptz), skip_order_time(uuid, integer, text),
  undo_order_time(uuid, text), order_times_catch_up()
  to authenticated;
