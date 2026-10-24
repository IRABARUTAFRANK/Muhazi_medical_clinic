-- 0082 · Dispensing and money: the corrections of the pharmacy review.
--
-- Frank's decision: a patient on a visit gets everything first and pays ONCE, at the end of the
-- visit; an unpaid balance is never lost. The pharmacy is the main store (migration 0083 builds
-- the room stores on top of this one). This migration corrects the hand-over and the money:
--
--   * PRICE-1  pharmacy_queue prices each line on the visit's payer price list and splits it into
--              the patient's share and the insurer's share exactly as the bill will
--              (add_charge_internal); the cash price is kept too.
--   * STORE-1  stock_location.is_main marks the receiving (main) pharmacy store (the first-created
--              open pharmacy store by default). main_pharmacy() finds it; set_main_pharmacy()
--              (manager) changes it. pharmacy_queue(p_location_id) shows the stock of the store
--              chosen at the desk and lists the open pharmacy stores; dispense_prescription and
--              sell_medicine take that store (null = the main pharmacy store).
--   * ORD-2    dispense_prescription waits while a doctor still has the patient at their desk
--              (errcode MS002, hint doctor_holds). cancel_prescription(): the prescriber (or the
--              manager) cancels a line still waiting at the pharmacy, with a reason; the pharmacy is
--              told; when nothing is left, after_pharmacy sends the patient on.
--   * ROOM-1   "Given here" takes stock from a store holding enough UNEXPIRED units in total
--              (room_store_for, redefined by 0083 for the room stores), never an expired batch
--              (give_from_store), and refuses when no store has enough (errcode MS003, hint
--              room_short): nothing is marked given or charged without stock.
--   * RET-1    return_medicine on a posted bill: the stock goes back, the bill line stays, and a
--              credit note gives the patient's share back (invoice_balance counts credit notes):
--              the balance drops, or the cashier sees money to give back (and is told).
--   * NEG-1    every function that takes stock first locks (medicine, store) with
--              pg_advisory_xact_lock and reads the balance after the lock: two people can never
--              give out the same last units.
--   * RIGHTS-1 stock_movement, batch, medication_dispense and credit_note are written only by the
--              checked functions (no direct insert/update/delete through the API).
--              medication_request: no direct insert or delete; a direct update may not touch the
--              hand-over, not-given, cancel, supply, quantity, medicine, visit or deleted fields.
--              (Security definer functions run as their owner, so they pass; requests from the
--              API run as authenticated/anon and are refused.)
--   * CHG-1    add_charge_internal: "no open bill" now has its own errcode MS001 (hint
--              no_open_bill); the hand-over refuses instead of giving the medicine free.
--              "No price" stays P0002 (handed over free, as before).
--   * TRACK-1  visit_journey, visit_clinical and my_prescriptions say not given (with the reason)
--              or cancelled.
--   * CHK-1    pharmacy_queue gives the patient's sex, birth date, age, allergies and each line's
--              prescribing rule (and whether the prescriber's specialty fits it). prescribe never
--              refuses for the rule (RHIA rules are reimbursement rules): it returns warnings.
--   * PAY-END  unchanged order, checked by db-check: the last hand-over / not given / cancel sends
--              the patient to the cashier when money is due; finish_visit too (also for medicines
--              given in the room). unpaid_debts also lists old visits still open with money due
--              and says since when and whether the patient left, the visit was closed or is open.
--
-- Errcodes (SQLSTATE, with the same word in the hint):
--   MS001 no_open_bill   the visit's bill is no longer open: nothing can be charged to it
--   MS002 doctor_holds   a doctor still has the patient: hand over when the doctor has finished
--   MS003 room_short     not enough unexpired stock in an allowed store to give it here

-- ---------------------------------------------------------------- columns
alter table medication_request add column if not exists cancelled_at timestamptz;
alter table medication_request add column if not exists cancelled_by uuid references profiles (id) on delete set null;
alter table medication_request add column if not exists cancel_reason text;

alter table stock_location add column if not exists is_main boolean not null default false;
create unique index if not exists stock_location_one_main on stock_location (is_main)
  where is_main and deleted_at is null;
update stock_location set is_main = true
where id = (select id from stock_location where type = 'pharmacy' and active and deleted_at is null
            order by created_at limit 1)
  and not exists (select 1 from stock_location where is_main and deleted_at is null);

-- The medicine line a stock movement served (medicines given in a room).
alter table stock_movement add column if not exists medication_request_id uuid references medication_request (id);
create index if not exists stock_movement_request_idx on stock_movement (medication_request_id)
  where medication_request_id is not null;

-- A credit note gives back the patient's share (and the insurer's) of a line on a posted bill.
alter table credit_note add column if not exists patient_amount numeric(12, 0) not null default 0;
alter table credit_note add column if not exists insurer_amount numeric(12, 0) not null default 0;
alter table credit_note add column if not exists source_type text;
alter table credit_note add column if not exists source_id uuid;
create index if not exists credit_note_invoice_idx on credit_note (invoice_id);

-- ---------------------------------------------------------------- helpers: stores and locks
-- The receiving (main) pharmacy store: the one marked is_main, else the first-created open one.
create or replace function main_pharmacy()
returns uuid
language sql stable security definer set search_path = public
as $$
  select l.id from stock_location l
  where l.type = 'pharmacy' and l.active and l.deleted_at is null
  order by l.is_main desc, l.created_at
  limit 1
$$;

-- The manager marks which open pharmacy store receives deliveries and serves the desk by default.
create or replace function set_main_pharmacy(p_location_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_manager() then
    raise exception 'only the manager chooses the main pharmacy store' using errcode = '42501';
  end if;
  if not exists (select 1 from stock_location where id = p_location_id and type = 'pharmacy'
                 and active and deleted_at is null) then
    raise exception 'choose an open pharmacy store' using errcode = '22023';
  end if;
  update stock_location set is_main = false where is_main and id <> p_location_id;
  update stock_location set is_main = true, updated_at = now() where id = p_location_id;
end
$$;

-- Unexpired units of a medicine in a store.
create or replace function usable_stock(p_item_id uuid, p_location_id uuid)
returns integer
language sql stable security definer set search_path = public
as $$
  select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s
  where s.item_id = p_item_id and s.location_id = p_location_id and s.quantity > 0
    and (s.expiry is null or s.expiry >= current_date)
$$;

-- One person at a time takes a medicine out of a store (held until the end of the transaction).
create or replace function lock_stock(p_item_id uuid, p_location_id uuid)
returns void
language sql volatile security definer set search_path = public
as $$
  select pg_advisory_xact_lock(hashtextextended('stock:' || p_item_id::text || ':' || coalesce(p_location_id::text, ''), 0))
$$;

-- ---------------------------------------------------------------- NEG-1: functions that take stock
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
  -- handed over and sold from an open pharmacy store only (room stores give with give_from_store)
  if not exists (select 1 from stock_location where id = p_location_id and type = 'pharmacy'
                 and active and deleted_at is null) then
    raise exception 'choose an open pharmacy store' using errcode = '22023';
  end if;
  -- the balance is read after the lock: nobody else takes the same units meanwhile
  perform lock_stock(p_item_id, p_location_id);
  for v_row in
    select s.batch_id, s.quantity
    from stock_on_hand s
    where s.item_id = p_item_id and s.location_id = p_location_id and s.quantity > 0 and s.batch_id is not null
      and (s.expiry is null or s.expiry >= current_date)   -- never an expired batch
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
    insert into stock_movement (item_id, batch_id, from_location_id, quantity, type, dispense_id, medication_request_id)
    values (p_item_id, v_row.batch_id, p_location_id, v_take, 'dispense', v_dispense_id, p_medication_request_id);
    v_remaining := v_remaining - v_take;
  end loop;
  if v_remaining > 0 then
    if exists (select 1 from stock_on_hand s where s.item_id = p_item_id and s.location_id = p_location_id
               and s.quantity > 0 and s.expiry < current_date) then
      raise exception 'not enough stock that is not expired: % unit(s) short (write the expired stock off)', v_remaining
        using errcode = '23514', hint = 'expired_short';
    end if;
    raise exception 'insufficient stock: % unit(s) short', v_remaining using errcode = '23514', hint = 'short';
  end if;
  return v_dispense_id;
end
$$;

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
begin
  if not (has_perm('stock.write') or has_perm('stock.dispense') or has_perm('clinical.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
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
    values (p_item_id, v_row.batch_id, p_location_id, v_take, 'consumption',
            coalesce(nullif(trim(coalesce(p_reason, '')), ''), case when p_encounter_id is not null then 'visit ' || p_encounter_id::text end));
    v_remaining := v_remaining - v_take;
  end loop;
  if v_remaining > 0 then
    raise exception 'not enough stock in that store: % unit(s) short', v_remaining using errcode = '23514';
  end if;
  return p_quantity;
end
$$;

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
begin
  if not has_perm('stock.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'choose a different destination' using errcode = '22023';
  end if;
  perform lock_stock(p_item_id, p_from_location_id);
  for v_row in
    select s.batch_id, s.quantity from stock_on_hand s
    where s.item_id = p_item_id and s.location_id = p_from_location_id and s.quantity > 0
      and (s.expiry is null or s.expiry >= current_date)   -- expired stock is not sent on
    order by s.expiry asc nulls last
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.quantity, v_remaining);
    insert into stock_movement (item_id, batch_id, from_location_id, to_location_id, quantity, type, reason)
    values (p_item_id, v_row.batch_id, p_from_location_id, p_to_location_id, v_take, 'transfer', nullif(trim(coalesce(p_reason, '')), ''));
    v_remaining := v_remaining - v_take;
  end loop;
  if v_remaining > 0 then
    raise exception 'not enough stock in that store: % unit(s) short', v_remaining using errcode = '23514';
  end if;
  return p_quantity;
end
$$;

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
begin
  if not has_perm('stock.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_counted is null or p_counted < 0 then
    raise exception 'the count must be zero or more' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the count changes' using errcode = '22023';
  end if;
  if not exists (select 1 from stock_location where id = p_location_id and deleted_at is null) then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  -- the count is compared with the balance read after the lock (a hand-over made at the same
  -- moment is not overwritten)
  perform lock_stock(p_item_id, p_location_id);
  select coalesce(sum(quantity), 0)::integer into v_on_hand
  from stock_on_hand where item_id = p_item_id and location_id = p_location_id;
  v_diff := p_counted - v_on_hand;
  if v_diff < 0 then
    -- fewer on the shelf: the oldest (and expired) batches go first
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
  elsif v_diff > 0 then
    -- more on the shelf: added to the latest batch of the medicine
    select id into v_batch from batch where item_id = p_item_id and deleted_at is null order by received_on desc limit 1;
    if v_batch is null then
      raise exception 'no batch of this item yet: receive it instead' using errcode = 'P0002';
    end if;
    insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason)
    values (p_item_id, v_batch, p_location_id, v_diff, 'adjustment', 'count: ' || trim(p_reason));
  end if;
  return v_diff;
end
$$;

-- ---------------------------------------------------------------- ROOM-1: given here, from a store
-- The store a medicine given here comes out of: an open store that is not the pharmacy or the main
-- store and holds enough UNEXPIRED units in total (all batches together). p_location: the store
-- chosen (refused when it is not allowed or holds too little: null). Without a choice: the store
-- of the desk's kind first, then a store of the person's departments, then the oldest.
-- 0083 redefines it for the room stores (only the stores the person holds).
create or replace function room_store_for(
  p_staff uuid, p_item_id uuid, p_quantity integer, p_location uuid default null, p_station station default null
)
returns uuid
language sql stable security definer set search_path = public
as $$
  select l.id
  from stock_location l
  where l.deleted_at is null and l.active and l.type not in ('pharmacy', 'main_store')
    and (p_location is null or l.id = p_location)
    and (select coalesce(sum(s.quantity), 0) from stock_on_hand s
         where s.location_id = l.id and s.item_id = p_item_id and s.quantity > 0
           and (s.expiry is null or s.expiry >= current_date)) >= greatest(coalesce(p_quantity, 1), 1)
  order by
    (l.type = case when p_station in ('nursing', 'beds', 'triage') then 'nursing'::stock_location_type
                   when p_station = 'theatre' then 'theatre'::stock_location_type end) desc nulls last,
    (l.department_id in (select department_id from staff_department where profile_id = p_staff)) desc nulls last,
    l.created_at
  limit 1
$$;

-- Takes a medicine given here out of a store: earliest expiry first, never an expired batch, after
-- the lock. Recorded as used ('consumption') for that medicine line. Short: refused (MS003).
create or replace function give_from_store(
  p_item_id uuid, p_location_id uuid, p_quantity integer, p_medication_request_id uuid, p_reason text default null
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_remaining integer := p_quantity;
  v_row record;
  v_take integer;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  perform lock_stock(p_item_id, p_location_id);
  for v_row in
    select s.batch_id, s.quantity from stock_on_hand s
    where s.item_id = p_item_id and s.location_id = p_location_id and s.quantity > 0
      and (s.expiry is null or s.expiry >= current_date)
    order by s.expiry asc nulls last
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.quantity, v_remaining);
    insert into stock_movement (item_id, batch_id, from_location_id, quantity, type, reason, medication_request_id)
    values (p_item_id, v_row.batch_id, p_location_id, v_take, 'consumption',
            coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'given in the room'), p_medication_request_id);
    v_remaining := v_remaining - v_take;
  end loop;
  if v_remaining > 0 then
    raise exception 'not enough of this medicine (not expired) in that store: % unit(s) short. Prescribe it for the pharmacy instead', v_remaining
      using errcode = 'MS003', hint = 'room_short';
  end if;
  return p_quantity;
end
$$;

-- ---------------------------------------------------------------- CHK-1: the prescribing rule
-- Does the prescriber's specialty fit the RHIA prescribing rule ("PED", "IM or PED", "DT"…)?
-- null: the rule names no specialist (or there is no rule); true / false otherwise.
create or replace function rx_rule_ok(p_rule text, p_specialty text)
returns boolean
language sql immutable
as $$
  with codes as (
    select trim(c) as code
    from regexp_split_to_table(upper(trim(coalesce(p_rule, ''))), '\s+OR\s+|\s*/\s*|\s*,\s*') as c
    where trim(c) <> ''
  ), known as (
    select code, case code
      when 'DT' then '(dent|stomato|orthodon|amenyo)'
      when 'PED' then '(paediat|pediat|pédiat|child|enfant)'
      when 'IM' then '(internal|interne|internist)'
      when 'D' then 'derma'
      when 'GYN' then '(gyn|obst)'
      when 'GYNEC' then '(gyn|obst)'
      when 'UROL' then 'urolog'
      when 'OPHT' then '(ophtal|ophthal|eye)'
      when 'PSYCH' then 'psychiat'
      when 'NEUROL' then 'neuro'
      when 'ONCO' then '(onco|cancer)'
      when 'AC' then '(onco|cancer)'
      when 'ENT' then '(\ment\M|\morl\M|otorhin|oto-rhino)'
      when 'SURG' then '(surg|chirurg)'
      when 'SURGEON' then '(surg|chirurg)'
      when 'CARDIOL' then 'cardio'
      when 'NEPHRO' then 'nephro'
      when 'ORTH' then 'orthop'
      when 'ORTHO' then 'orthop'
      when 'SPEC' then '.'
    end as pattern
    from codes
  )
  select case
    when not exists (select 1 from known where pattern is not null) then null
    else exists (
      select 1 from known k
      where k.pattern is not null
        and lower(coalesce(p_specialty, '')) ~ k.pattern
        -- a "specialist" is anyone whose specialty is not general practice
        and (k.code <> 'SPEC' or lower(coalesce(p_specialty, '')) !~ '(general|g[ée]n[ée]ral|\mgp\M|family|famille)')
    )
  end
$$;

-- The warnings shown when prescribing (never a refusal).
create or replace function rx_warnings(p_item_id uuid, p_staff uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case
    when i.prescribing_rule is null or trim(i.prescribing_rule) = '' then '[]'::jsonb
    when upper(trim(i.prescribing_rule)) = 'HU' then
      jsonb_build_array(jsonb_build_object('kind', 'hospitalOnly', 'rule', i.prescribing_rule))
    when upper(trim(i.prescribing_rule)) = 'M' then
      jsonb_build_array(jsonb_build_object('kind', 'needsNote', 'rule', i.prescribing_rule))
    when rx_rule_ok(i.prescribing_rule, (select specialty from profiles where id = p_staff)) is false then
      jsonb_build_array(jsonb_build_object('kind', 'prescribingRule', 'rule', i.prescribing_rule,
                                           'specialty', (select specialty from profiles where id = p_staff)))
    else '[]'::jsonb
  end
  from item i where i.id = p_item_id
$$;

-- ---------------------------------------------------------------- CHG-1: "no open bill" apart
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

-- ---------------------------------------------------------------- RET-1: credit notes count
-- Balance due by the patient: their share, minus payments, plus money given back, minus credit
-- notes (a medicine returned after the bill was posted).
create or replace function invoice_balance(p_invoice_id uuid)
returns numeric
language sql stable security definer set search_path = public
as $$
  select i.patient_share
         - coalesce((select sum(p.amount) from payment p where p.invoice_id = i.id and p.deleted_at is null), 0)
         + coalesce((select sum(r.amount) from refund r where r.invoice_id = i.id and r.deleted_at is null), 0)
         - coalesce((select sum(c.patient_amount) from credit_note c where c.invoice_id = i.id and c.deleted_at is null), 0)
  from invoice i where i.id = p_invoice_id
$$;

-- ---------------------------------------------------------------- waiting at the pharmacy
-- A line waits at the pharmacy until handed over, marked not given, or cancelled by the doctor.
create or replace function rx_pending(m medication_request)
returns boolean
language sql stable security definer set search_path = public
as $$
  select m.deleted_at is null and m.supply = 'pharmacy' and m.given_at is null and m.not_given_at is null
    and m.cancelled_at is null
    and not exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null)
$$;

-- A doctor still has the patient at their desk (the desk's "with the doctor").
create or replace function doctor_holds(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from queue_entry q where q.encounter_id = p_encounter_id and q.finished_at is null
                 and q.deleted_at is null and station_role(q.station) = 'doctor')
$$;

-- ---------------------------------------------------------------- prescribe (ROOM-1, CHK-1)
drop function if exists prescribe(uuid, uuid, numeric, text, text, text, integer, text, text, station);
create or replace function prescribe(
  p_encounter_id uuid, p_item_id uuid, p_quantity numeric, p_dose text default null, p_route text default null,
  p_frequency text default null, p_duration_days integer default null, p_instructions text default null,
  p_supply text default 'pharmacy', p_station station default null, p_location_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_charged boolean := false;
  v_loc uuid;
  v_taken boolean := false;
  v_qty integer;
  v_supply text := coalesce(p_supply, 'pharmacy');
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_may_work_on(p_encounter_id);
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if v_supply not in ('pharmacy', 'room') then
    raise exception 'unknown supply' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if not exists (select 1 from item where id = p_item_id and deleted_at is null) then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  if v_supply = 'room' then
    -- Given here: only from a store that holds enough unexpired units; never given without stock.
    v_qty := ceil(p_quantity)::integer;
    v_loc := room_store_for(auth.uid(), p_item_id, v_qty, p_location_id, p_station);
    if v_loc is null then
      raise exception 'not enough of this medicine (not expired) in %: prescribe it for the pharmacy instead',
        case when p_location_id is null then 'a store you may give from' else 'that store' end
        using errcode = 'MS003', hint = 'room_short';
    end if;
  end if;
  insert into medication_request (encounter_id, item_id, dose, route, frequency, duration_days, quantity,
                                  instructions, supply, given_at, given_by)
  values (p_encounter_id, p_item_id, nullif(trim(coalesce(p_dose, '')), ''), nullif(trim(coalesce(p_route, '')), ''),
          nullif(trim(coalesce(p_frequency, '')), ''), p_duration_days, p_quantity,
          nullif(trim(coalesce(p_instructions, '')), ''), v_supply,
          case when v_supply = 'room' then now() end, case when v_supply = 'room' then auth.uid() end)
  returning id into v_id;
  if v_supply = 'room' then
    perform give_from_store(p_item_id, v_loc, v_qty, v_id, 'given in the room');
    v_taken := true;
    -- on the bill at the medicine's price (no price: given free); a closed bill refuses (MS001)
    begin
      perform add_charge_internal(p_encounter_id, coalesce(p_station, 'consultation'::station), null, p_item_id, p_quantity,
                         null, null, null, null, 'medication_request', v_id);
      v_charged := true;
    exception when sqlstate 'P0002' then
      v_charged := false;
    end;
  elsif not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'pharmacy'
                    and finished_at is null and deleted_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no)
    values (p_encounter_id, 'pharmacy', (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1));
  end if;
  return jsonb_build_object('id', v_id, 'supply', v_supply, 'charged', v_charged,
                            'stockTaken', v_taken, 'locationId', v_loc,
                            'warnings', coalesce(rx_warnings(p_item_id, auth.uid()), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------- the hand-over (STORE-1, ORD-2, CHG-1)
create or replace function dispense_prescription(p_medication_request_id uuid, p_location_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_loc uuid;
  v_dispense uuid;
  v_charged boolean := false;
begin
  if not has_perm('stock.dispense') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_m from medication_request where id = p_medication_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  if v_m.cancelled_at is not null then
    raise exception 'the doctor cancelled this medicine' using errcode = '23505';
  end if;
  if v_m.given_at is not null or exists (select 1 from medication_dispense d where d.medication_request_id = v_m.id and d.deleted_at is null) then
    raise exception 'already dispensed' using errcode = '23505';
  end if;
  if v_m.not_given_at is not null then
    raise exception 'this medicine was marked as not given' using errcode = '23505';
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
  v_dispense := dispense_fefo(v_m.encounter_id, v_m.item_id, ceil(v_m.quantity)::integer, v_loc, v_m.id, null);
  -- no price: handed over free (charged = false); no open bill: refused (MS001)
  begin
    perform add_charge_internal(v_m.encounter_id, 'pharmacy'::station, null, v_m.item_id, v_m.quantity,
                       null, null, null, null, 'medication_dispense', v_dispense);
    v_charged := true;
  exception when sqlstate 'P0002' then
    v_charged := false;
  end;
  update medication_request set given_at = now(), given_by = auth.uid() where id = v_m.id;
  -- the last line handed over: on to the cashier (money due) or the visit closes
  perform after_pharmacy(v_m.encounter_id);
  return jsonb_build_object('dispenseId', v_dispense, 'charged', v_charged, 'locationId', v_loc);
end
$$;

drop function if exists sell_medicine(uuid, uuid, numeric, text);
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
  if not has_perm('stock.dispense') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'the quantity must be more than zero' using errcode = '22023';
  end if;
  if not exists (select 1 from item where id = p_item_id and deleted_at is null) then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  insert into medication_request (encounter_id, item_id, quantity, instructions, supply, prescriber_id)
  values (p_encounter_id, p_item_id, p_quantity,
          coalesce(nullif(trim(coalesce(p_instructions, '')), ''), 'Pharmacy sale'), 'pharmacy', auth.uid())
  returning id into v_id;
  return dispense_prescription(v_id, p_location_id) || jsonb_build_object('requestId', v_id);
end
$$;

-- ---------------------------------------------------------------- ORD-2: the doctor cancels a line
create or replace function cancel_prescription(p_request_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_item text;
  v_name text;
  v_left integer;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the medicine is cancelled' using errcode = '22023';
  end if;
  select * into v_m from medication_request where id = p_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  if not (is_manager()
          or (has_perm('clinical.write') and coalesce(v_m.prescriber_id, v_m.created_by) = auth.uid())) then
    raise exception 'only the doctor who prescribed it (or the manager) can cancel it' using errcode = '42501';
  end if;
  if not rx_pending(v_m) then
    raise exception 'this medicine is no longer waiting at the pharmacy (handed over, not given or cancelled)'
      using errcode = 'P0002';
  end if;
  update medication_request
  set cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = trim(p_reason)
  where id = v_m.id;
  -- the pharmacy is told the line left its list
  select i.name_generic || coalesce(' ' || i.strength, '') into v_item from item i where i.id = v_m.item_id;
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
  insert into notification (kind, params, link, recipient_stations, created_by)
  values ('rx_cancelled',
          jsonb_build_object('item', v_item, 'name', v_name, 'reason', trim(p_reason),
                             'by', (select full_name from profiles where id = auth.uid())),
          '/app/visit?encounter=' || v_m.encounter_id, array['pharmacy'::station], auth.uid());
  -- nothing left at the pharmacy: the patient goes on (back, cashier, or the visit closes)
  perform after_pharmacy(v_m.encounter_id);
  select count(*)::integer into v_left from medication_request m
  where m.encounter_id = v_m.encounter_id and rx_pending(m);
  return jsonb_build_object('id', v_m.id, 'pending', v_left,
                            'balance', invoice_balance((select id from invoice where encounter_id = v_m.encounter_id)));
end
$$;

-- ---------------------------------------------------------------- RET-1: return after the bill is posted
create or replace function return_medicine(p_medication_request_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_d medication_dispense%rowtype;
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
  v_name text;
  v_item text;
begin
  if not (has_perm('stock.dispense') or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the medicine comes back' using errcode = '22023';
  end if;
  select * into v_m from medication_request where id = p_medication_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  select * into v_d from medication_dispense
  where medication_request_id = v_m.id and deleted_at is null order by created_at desc limit 1;
  if not found then
    raise exception 'this medicine was not handed over by the pharmacy' using errcode = 'P0002';
  end if;
  if not is_manager()
     and (v_d.created_at at time zone 'Africa/Kigali')::date <> (now() at time zone 'Africa/Kigali')::date then
    raise exception 'a hand-over of another day is undone by the manager' using errcode = '42501';
  end if;
  select * into v_inv from invoice where encounter_id = v_m.encounter_id;
  -- the units go back where they came from
  for v_mv in
    select item_id, batch_id, from_location_id, quantity from stock_movement
    where dispense_id = v_d.id and type = 'dispense' and deleted_at is null
  loop
    insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason, dispense_id, medication_request_id)
    values (v_mv.item_id, v_mv.batch_id, v_mv.from_location_id, v_mv.quantity, 'return', trim(p_reason), v_d.id, v_m.id);
    v_back := v_back + v_mv.quantity;
  end loop;
  update medication_dispense set deleted_at = now() where id = v_d.id;

  if v_inv.id is null or v_inv.status = 'draft' then
    -- the bill is still open: the line leaves it, and the medicine waits at the pharmacy again
    update invoice_line set deleted_at = now(),
           manual_reason = coalesce(manual_reason || ' · ', '') || 'returned: ' || trim(p_reason)
    where source_type = 'medication_dispense' and source_id = v_d.id and deleted_at is null;
    if v_inv.id is not null then
      perform recompute_invoice(v_inv.id);
    end if;
    update medication_request set given_at = null, given_by = null where id = v_m.id;
    if exists (select 1 from encounter where id = v_m.encounter_id and status = 'open')
       and not exists (select 1 from queue_entry where encounter_id = v_m.encounter_id and station = 'pharmacy'
                       and finished_at is null and deleted_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no)
      values (v_m.encounter_id, 'pharmacy',
              (select ticket_no from queue_entry where encounter_id = v_m.encounter_id order by created_at limit 1));
    end if;
    return jsonb_build_object('units', v_back, 'mode', 'bill', 'creditNoteId', null, 'credit', 0,
                              'balance', invoice_balance(v_inv.id));
  end if;

  -- The bill is posted: its lines never change. A credit note gives the line back: the patient's
  -- share lowers what they owe (or is money to give back at the cashier); the insurer's share
  -- leaves an open claim.
  select coalesce(sum(l.patient_share), 0), coalesce(sum(l.insurer_share), 0),
         coalesce(sum(round(l.unit_price * l.quantity)), 0),
         coalesce(jsonb_agg(jsonb_build_object('lineId', l.id, 'description', l.description, 'quantity', l.quantity,
                                               'unitPrice', l.unit_price, 'patientShare', l.patient_share,
                                               'insurerShare', l.insurer_share)), '[]'::jsonb)
  into v_patient, v_insurer, v_total, v_lines
  from invoice_line l
  where l.invoice_id = v_inv.id and l.source_type = 'medication_dispense' and l.source_id = v_d.id
    and l.deleted_at is null;
  if v_total > 0 then
    insert into credit_note (invoice_id, number, lines, total, reason, approver_id, patient_amount, insurer_amount,
                             source_type, source_id)
    values (v_inv.id, 'CN-' || v_year || '-' || lpad(next_number('credit_note', v_year)::text, 6, '0'),
            v_lines, v_total, 'returned: ' || trim(p_reason), auth.uid(), v_patient, v_insurer,
            'medication_dispense', v_d.id)
    returning id into v_cn;
    if v_insurer > 0 then
      update claim set amount = greatest(0, amount - v_insurer)
      where invoice_id = v_inv.id and status = 'open' and batch_id is null;
    end if;
  end if;
  -- the line is done: returned (it does not wait at the pharmacy again)
  update medication_request
  set given_at = null, given_by = null, not_given_at = now(), not_given_by = auth.uid(),
      not_given_reason = 'returned: ' || trim(p_reason)
  where id = v_m.id;
  v_balance := invoice_balance(v_inv.id);
  if v_balance < 0 then
    -- money to give back: the cashier is told
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
    select i.name_generic || coalesce(' ' || i.strength, '') into v_item from item i where i.id = v_m.item_id;
    insert into notification (kind, params, link, recipient_stations, created_by)
    values ('refund_due', jsonb_build_object('name', v_name, 'item', v_item, 'amount', -v_balance,
                                             'reason', trim(p_reason)),
            '/app/visit?encounter=' || v_m.encounter_id, array['cashier'::station], auth.uid());
  end if;
  return jsonb_build_object('units', v_back, 'mode', 'credit', 'creditNoteId', v_cn, 'credit', v_patient,
                            'balance', v_balance);
end
$$;

-- ---------------------------------------------------------------- the pharmacy list (PRICE-1, STORE-1, CHK-1)
drop function if exists pharmacy_queue();
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
  if not (has_perm('stock.dispense') or is_manager()) then
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
    select m.id, m.encounter_id, m.created_at, p.id as patient_id,
           p.surname || ' ' || p.given_names as patient, p.file_number, p.sex, p.birth_date, p.allergies,
           (select q.ticket_no from queue_entry q where q.encounter_id = m.encounter_id order by q.created_at limit 1) as ticket,
           m.item_id, i.name_generic || coalesce(' ' || i.strength, '') as item, i.selling_unit,
           i.prescribing_rule, m.quantity, m.dose, m.frequency, m.duration_days, m.instructions,
           pr.id as prescriber_id, pr.full_name as prescriber, pr.specialty,
           py.name as payer, cp.price as cash_price, pp.price as payer_price, pp.fallback,
           cov.pct,
           round(round(pp.price) * m.quantity) as line_total,
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
    where rx_pending(m)
  ), priced as (
    select l.*, round(coalesce(l.line_total, 0) * l.pct / 100) as insurer_share
    from lines l
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'requestId', x.id, 'encounterId', x.encounter_id, 'patientId', x.patient_id, 'patient', x.patient,
      'file', x.file_number, 'ticket', x.ticket,
      'itemId', x.item_id, 'item', x.item, 'unit', x.selling_unit,
      'quantity', x.quantity, 'dose', x.dose, 'frequency', x.frequency, 'days', x.duration_days,
      'instructions', x.instructions, 'prescriber', x.prescriber, 'prescriberId', x.prescriber_id, 'at', x.created_at,
      -- the cash price (as before) and what the bill will say
      'price', x.cash_price, 'cashPrice', x.cash_price, 'payerPrice', x.payer_price,
      'priced', x.payer_price is not null, 'payer', x.payer, 'coveragePct', x.pct,
      'lineTotal', coalesce(x.line_total, 0), 'insurerShare', x.insurer_share,
      'patientShare', coalesce(x.line_total, 0) - x.insurer_share,
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
           sum(round(round(coalesce(pp.price, 0)) * m.quantity)) as total,
           sum(round(round(round(coalesce(pp.price, 0)) * m.quantity) * cov.pct / 100)) as insurer
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open'
    left join invoice inv on inv.encounter_id = e.id
    left join lateral (select pf.price from price_for(null, m.item_id, inv.payer_id) pf) pp on true
    left join lateral (select coalesce(coverage_pct_for((select c.plan_id from coverage c where c.id = inv.coverage_id),
                                                        'pharmacy'::service_group), 0) as pct) cov on true
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

-- ---------------------------------------------------------------- TRACK-1: not given / cancelled shown
create or replace function visit_journey(p_encounter_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_steps jsonb;
  v_vitals jsonb;
  v_dx jsonb;
  v_meds jsonb;
  v_tests jsonb;
  v_charges jsonb;
  v_payments jsonb;
  v_bill jsonb;
  v_enc encounter%rowtype;
begin
  if not has_perm('patient.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_enc from encounter where id = p_encounter_id and deleted_at is null;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'station', q.station, 'queuedAt', q.created_at, 'calledAt', q.called_at, 'startedAt', q.started_at,
      'finishedAt', q.finished_at, 'takenBy', tb.full_name, 'assignedTo', asg.full_name,
      'referredBy', rb.full_name, 'note', q.referral_note, 'enteredBy', eb.full_name,
      'service', q.service, 'department', (select d.name from department d where d.id = q.department_id)
    ) order by q.created_at), '[]'::jsonb) into v_steps
  from queue_entry q
  left join profiles tb on tb.id = q.taken_by
  left join profiles asg on asg.id = q.assigned_to
  left join profiles rb on rb.id = q.referred_by
  left join profiles eb on eb.id = q.entered_by
  where q.encounter_id = p_encounter_id and q.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'code', o.code, 'value', o.value_num, 'unit', o.unit, 'at', o.effective_at,
      'by', (select full_name from profiles where id = o.performer_id)
    ) order by o.effective_at), '[]'::jsonb) into v_vitals
  from observation o where o.encounter_id = p_encounter_id and o.deleted_at is null and o.code <> 'note';

  select coalesce(jsonb_agg(jsonb_build_object(
      'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
      'by', (select full_name from profiles where id = c.created_by)
    ) order by c.created_at), '[]'::jsonb) into v_dx
  from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'item', i.name_generic || coalesce(' ' || i.strength, ''), 'quantity', m.quantity, 'dose', m.dose,
      'frequency', m.frequency, 'days', m.duration_days, 'supply', m.supply, 'givenAt', m.given_at,
      'givenBy', (select full_name from profiles where id = m.given_by), 'at', m.created_at,
      'by', (select full_name from profiles where id = m.created_by),
      'dispensed', exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
      'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason,
      'notGivenBy', (select full_name from profiles where id = m.not_given_by),
      'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
      'cancelledBy', (select full_name from profiles where id = m.cancelled_by)
    ) order by m.created_at), '[]'::jsonb) into v_meds
  from medication_request m join item i on i.id = m.item_id
  where m.encounter_id = p_encounter_id and m.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'test', s.name_en, 'status', r.status, 'priority', r.priority, 'at', r.created_at,
      'by', (select full_name from profiles where id = r.created_by),
      'result', (select coalesce(dr.impression, dr.findings) from diagnostic_report dr where dr.service_request_id = r.id and dr.deleted_at is null order by dr.created_at desc limit 1)
    ) order by r.created_at), '[]'::jsonb) into v_tests
  from service_request r left join service s on s.id = r.service_id
  where r.encounter_id = p_encounter_id and r.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'description', l.description, 'quantity', l.quantity, 'unitPrice', l.unit_price,
      'total', round(l.quantity * l.unit_price), 'office', l.office, 'at', l.created_at,
      'by', (select full_name from profiles where id = l.entered_by)
    ) order by l.created_at), '[]'::jsonb) into v_charges
  from invoice_line l join invoice i on i.id = l.invoice_id
  where i.encounter_id = p_encounter_id and l.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'amount', p.amount, 'method', p.method, 'reference', p.reference, 'at', p.paid_at,
      'by', (select full_name from profiles where id = p.cashier_id)
    ) order by p.paid_at), '[]'::jsonb) into v_payments
  from payment p join invoice i on i.id = p.invoice_id
  where i.encounter_id = p_encounter_id and p.deleted_at is null;

  select jsonb_build_object('status', b.status, 'total', b.total, 'balance', b.balance, 'paid', b.paid,
                            'number', b.number, 'settledBy', b.settled_by, 'settledAt', b.settled_at)
  into v_bill from visit_bill b where b.encounter_id = p_encounter_id;

  return jsonb_build_object(
    'encounterId', v_enc.id, 'arrivedAt', v_enc.arrived_at, 'status', v_enc.status, 'closedAt', v_enc.closed_at,
    'triage', v_enc.triage_level, 'triageReason', v_enc.triage_reason,
    'closedBy', (select full_name from profiles where id = v_enc.closed_by),
    -- the track: treatment finished, why the patient left, what they came for
    'treatmentDoneAt', v_enc.clinical_done_at, 'leftReason', v_enc.left_reason, 'service', v_enc.service,
    'steps', v_steps, 'vitals', v_vitals, 'diagnoses', v_dx, 'medicines', v_meds, 'tests', v_tests,
    'charges', v_charges, 'payments', v_payments, 'bill', v_bill
  );
end
$$;

-- The visit's clinical record: each prescription also says whether it still waits at the pharmacy,
-- who wrote it (the prescriber may cancel it) and whether it was cancelled.
create or replace function visit_clinical(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  -- clinicians; the lab and the pharmacy read the record too (their orders and prescriptions)
  select case when has_perm('clinical.read') or has_perm('orders.read') or has_perm('prescription.read')
              then jsonb_build_object(
    'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by)) order by c.created_at)
      from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.value_text, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id)) order by o.effective_at)
      from observation o where o.encounter_id = p_encounter_id and o.code = 'note' and o.deleted_at is null), '[]'::jsonb),
    'prescriptions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by)), 'item', i.name_generic || coalesce(' ' || i.strength, ''), 'dose', m.dose, 'route', m.route,
        'frequency', m.frequency, 'days', m.duration_days, 'quantity', m.quantity, 'instructions', m.instructions, 'at', m.created_at,
        'dispensed', m.supply = 'room' or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'supply', m.supply, 'givenAt', m.given_at, 'givenBy', (select full_name from profiles where id = m.given_by),
        'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason,
        'prescriberId', coalesce(m.prescriber_id, m.created_by), 'pending', rx_pending(m),
        'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
        'cancelledBy', (select full_name from profiles where id = m.cancelled_by)) order by m.created_at)
      from medication_request m join item i on i.id = m.item_id where m.encounter_id = p_encounter_id and m.deleted_at is null), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end), 'status', r.status, 'reason', r.reason, 'at', r.created_at,
        'result', (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
          'corrected', d.corrected_at is not null, 'correctionReason', d.correction_reason,
          'at', coalesce(d.verified_at, d.updated_at), 'by', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)))
          from diagnostic_report d where d.service_request_id = r.id and d.deleted_at is null)) order by r.created_at)
      from service_request r join service s on s.id = r.service_id where r.encounter_id = p_encounter_id and r.deleted_at is null), '[]'::jsonb),
    'patient', (select jsonb_build_object('id', p.id, 'allergies', p.allergies, 'bloodGroup', p.blood_group, 'notes', p.notes, 'flags', p.flags)
      from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id)
  ) else null end
$$;

create or replace function my_prescriptions(p_days integer default 7, p_from date default null, p_to date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb)
  from (
    select m.created_at as at, jsonb_build_object(
      'id', m.id, 'encounterId', m.encounter_id, 'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'item', i.name_generic || coalesce(' ' || i.strength, ''), 'quantity', m.quantity,
      'dose', m.dose, 'frequency', m.frequency, 'days', m.duration_days, 'instructions', m.instructions,
      'supply', m.supply, 'at', m.created_at,
      'state', case
                 when m.cancelled_at is not null then 'cancelled'
                 when m.not_given_at is not null then 'not_given'
                 when m.supply = 'room' then 'room'
                 when m.given_at is not null
                      or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null)
                   then 'given'
                 else 'waiting' end,
      'givenAt', m.given_at, 'notGivenReason', m.not_given_reason,
      'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
      'visitOpen', e.status = 'open') as j
    from medication_request m
    join encounter e on e.id = m.encounter_id
    join patient p on p.id = e.patient_id
    join item i on i.id = m.item_id
    where m.deleted_at is null and coalesce(m.prescriber_id, m.created_by) = auth.uid()
      and case when p_from is not null
            then (m.created_at at time zone 'Africa/Kigali')::date between p_from and coalesce(p_to, p_from)
            else m.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90))) end
    order by m.created_at desc
    limit 500
  ) x
$$;

-- ---------------------------------------------------------------- PAY-END: what is still owed
-- Visits that ended (closed, or the patient left) with money due, and visits of earlier days still
-- open with money due and nothing left to do but pay. Same keys as before, plus since / status /
-- billNumber / total / paid.
create or replace function unpaid_debts()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb)
  from (
    select coalesce(e.closed_at, e.arrived_at, e.created_at) as at, jsonb_build_object(
      'encounterId', e.id, 'patientId', p.id, 'patient', p.surname || ' ' || p.given_names,
      'fileNumber', p.file_number, 'phone', p.phone_1, 'amount', invoice_balance(i.id),
      'closedAt', e.closed_at, 'reason', e.left_reason, 'closedBy', pr.full_name,
      'since', coalesce(e.arrived_at, e.created_at),
      'status', case when e.status = 'open' then 'open'
                     when e.left_reason is not null then 'left'
                     else 'closed' end,
      'billNumber', i.number, 'total', i.patient_share,
      'paid', (select coalesce(sum(pa.amount), 0) from payment pa where pa.invoice_id = i.id and pa.deleted_at is null)
    ) as j
    from encounter e
    join invoice i on i.encounter_id = e.id and i.status <> 'credited'
    join patient p on p.id = e.patient_id
    left join profiles pr on pr.id = e.closed_by
    where e.deleted_at is null and invoice_balance(i.id) > 0
      and (e.status = 'closed'
           or (e.status = 'open'
               and (coalesce(e.arrived_at, e.created_at) at time zone 'Africa/Kigali')::date
                   < (now() at time zone 'Africa/Kigali')::date
               and not visit_work_left(e.id)))
  ) x
  where has_perm('billing.read') or has_perm('payment.take')
$$;

-- ---------------------------------------------------------------- RIGHTS-1: only the checked functions write
-- The ledger, batches, hand-overs and credit notes: never written directly through the API.
revoke insert, update, delete on stock_movement, batch, medication_dispense, credit_note from authenticated, anon;
drop policy if exists stock_movement_insert on stock_movement;
drop policy if exists stock_movement_update on stock_movement;
drop policy if exists stock_movement_delete on stock_movement;
drop policy if exists batch_insert on batch;
drop policy if exists batch_update on batch;
drop policy if exists batch_delete on batch;
drop policy if exists medication_dispense_insert on medication_dispense;
drop policy if exists medication_dispense_update on medication_dispense;
drop policy if exists medication_dispense_delete on medication_dispense;
drop policy if exists credit_note_insert on credit_note;
drop policy if exists credit_note_update on credit_note;
drop policy if exists credit_note_delete on credit_note;

-- Prescriptions: written by prescribe / sell_medicine; handed over, not given, cancelled and
-- returned only by their functions. A direct API request (role authenticated or anon) may still
-- correct the dose or the instructions, nothing that moves stock or money.
create or replace function guard_medication_request()
returns trigger
language plpgsql
as $$
begin
  -- the checked (security definer) functions run as their owner, not as the API roles
  if current_user::text not in ('authenticated', 'anon') then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    raise exception 'prescriptions are written with the prescription form only' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'a prescription is not deleted: the doctor cancels it' using errcode = '42501';
  end if;
  if new.given_at is distinct from old.given_at or new.given_by is distinct from old.given_by
     or new.not_given_at is distinct from old.not_given_at or new.not_given_by is distinct from old.not_given_by
     or new.not_given_reason is distinct from old.not_given_reason
     or new.cancelled_at is distinct from old.cancelled_at or new.cancelled_by is distinct from old.cancelled_by
     or new.cancel_reason is distinct from old.cancel_reason
     or new.supply is distinct from old.supply or new.quantity is distinct from old.quantity
     or new.item_id is distinct from old.item_id or new.encounter_id is distinct from old.encounter_id
     or new.prescriber_id is distinct from old.prescriber_id or new.deleted_at is distinct from old.deleted_at then
    raise exception 'handing over, not given, cancelling and the medicine or quantity change only through the pharmacy and prescription screens'
      using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists trg_medication_request_guard on medication_request;
create trigger trg_medication_request_guard before insert or update or delete on medication_request
  for each row execute function guard_medication_request();

-- ---------------------------------------------------------------- grants
-- (functions replaced with the same arguments keep their grants)
revoke all on function main_pharmacy(), set_main_pharmacy(uuid), usable_stock(uuid, uuid),
  rx_rule_ok(text, text), rx_warnings(uuid, uuid), doctor_holds(uuid),
  prescribe(uuid, uuid, numeric, text, text, text, integer, text, text, station, uuid),
  sell_medicine(uuid, uuid, numeric, text, uuid), cancel_prescription(uuid, text), pharmacy_queue(uuid)
  from public, anon;
grant execute on function main_pharmacy(), set_main_pharmacy(uuid), usable_stock(uuid, uuid),
  rx_rule_ok(text, text), rx_warnings(uuid, uuid), doctor_holds(uuid),
  prescribe(uuid, uuid, numeric, text, text, text, integer, text, text, station, uuid),
  sell_medicine(uuid, uuid, numeric, text, uuid), cancel_prescription(uuid, text), pharmacy_queue(uuid)
  to authenticated;
-- internal: only the checked functions call them
revoke all on function dispense_fefo(uuid, uuid, integer, uuid, uuid, text), lock_stock(uuid, uuid), give_from_store(uuid, uuid, integer, uuid, text),
  room_store_for(uuid, uuid, integer, uuid, station), add_charge_internal(uuid, station, uuid, uuid, numeric, numeric,
  text, uuid, uuid, text, uuid, numeric, text), guard_medication_request()
  from public, anon, authenticated;
