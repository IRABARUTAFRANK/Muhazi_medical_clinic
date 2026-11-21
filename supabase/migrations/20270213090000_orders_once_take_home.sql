-- 0193 · Treatment plan orders: a medical act is done once, a medicine is given at once, medicines
-- to take home go on the bill with how to take them and a label, and a real Undo.
--
-- Frank (owner), Task 3: "work also on the treatment plan in the patient journey … i tried to
-- remove a drug and they told me that it comes from nurse that i undo it from there while it was a
-- drug that i marked as the one that i do myself and the medical act also there might be a kind of
-- issue there."
-- Task 5: "when i place order you see like 1/3 meaning 3 medical acts and i click there three times
-- to mark it as done … when i order a medical act … it must be only marked as done and it's over …
-- drugs also when i give the order of drugs and i specify the type of medicine the dose, quantity
-- and other specifications … it must be also not be like that like 1/5 he must give all of them to
-- him and then he marks all as done not doing it one on one, and also … the patient is given a drug
-- in the clinic and … some that he will be given and take them home and remember that we said that
-- we only prescribe the medicine which will be bought outside only so make so that we will have a
-- way to record the medicines and put them on the bill those that he will take home if it's that
-- pack that he was given the drugs on and also if it's another different medicine to record and add
-- to the bill and give him a way in which he will take it like those specifications …"
--
-- What this file does, in plain words:
--   * Every new order is ONE thing, carried out with ONE press (doses_planned = 1). A medical act
--     is done once and billed once ("How many on the bill", usually 1). A medicine is given at
--     once: the part given here and the part to take home leave the clinic's stock together and go
--     on the bill in one line set (so a whole box keeps the box price).
--   * A medicine order may have a take-home part (how many, dose each time, how often, for how many
--     days, instructions): printed on the dispensing label. A different medicine only for home is
--     an order with nothing given here.
--   * Pieces are whole (half a tablet is written in the dose); the stock and whole boxes are
--     checked when the order is written, not only when it is given.
--   * When the doctor carries out his own order, its bill line goes to his desk, not Nursing.
--   * Undo: the person who recorded it (the same day) or the manager (any day) undoes what was
--     given or done: the pieces go back to the clinic's stock and the line leaves the bill (a
--     credit note when the bill is closed). The doctor who wrote it or the manager: the order ends
--     cancelled; the nurse who gave it: the order is to do again (not done when the visit is over).
--   * Each time carried out is linked to its stock movements and bill lines (nurse_order_dose_id),
--     the old ones too (same transaction, same created_at).
--   * A bill line made by an order is refused to a non-manager in plain words; the bill can read
--     where a line comes from (visit_charge_sources).
--   * The stock reports count medicines given through orders as given here, never as written off;
--     an undone time is never sold (the sales report too, when the bill was closed).
--   * An order already over (cancelled or not done) stays so when its times are undone; the
--     reason of an undo stays on the order (hidden in the change log), not on the stock, the bill
--     or the cashier's notice. A screen of before keeps the medicine's "how often".
--   * The patient's safety summary lists medicines taken home from the clinic until their days are
--     over; past visits show the take-home part.
-- No existing function changes its arguments: new ones are create_order_here and undo_nurse_order.
-- Safe to run twice.

-- ---------------------------------------------------------------- 1 the columns
alter table nurse_order add column if not exists home_quantity numeric(10, 2);
alter table nurse_order add column if not exists home_dose text;
alter table nurse_order add column if not exists home_frequency text;
alter table nurse_order add column if not exists home_days integer;
alter table nurse_order add column if not exists home_instructions text;
-- a medicine only to take home has nothing given here
alter table nurse_order drop constraint if exists nurse_order_quantity_check;
alter table nurse_order add constraint nurse_order_quantity_check check (quantity >= 0);
alter table nurse_order drop constraint if exists nurse_order_amount_check;
alter table nurse_order add constraint nurse_order_amount_check check (
  case when kind = 'act' then quantity > 0 and home_quantity is null
       else coalesce(home_quantity, 0) >= 0 and quantity + coalesce(home_quantity, 0) > 0 end);
alter table nurse_order drop constraint if exists nurse_order_home_days_check;
alter table nurse_order add constraint nurse_order_home_days_check
  check (home_days is null or home_days between 1 and 365);
comment on column nurse_order.quantity is
  '0193: a drug: pieces given here at the one press (older orders: each time); an act: how many go on the bill';
comment on column nurse_order.home_quantity is
  '0193: a drug: pieces handed over to take home at the same press (null: none)';

alter table nurse_order_dose add column if not exists quantity numeric(10, 2);
alter table nurse_order_dose add column if not exists home_quantity numeric(10, 2);
alter table nurse_order_dose add column if not exists office station;
alter table nurse_order_dose add column if not exists undone_by uuid references profiles (id);
alter table nurse_order_dose add column if not exists undo_reason text;
create index if not exists nurse_order_dose_order_idx on nurse_order_dose (order_id);
comment on column nurse_order_dose.undo_reason is
  '0193: an undone time: deleted_at set, with who undid it and why';

alter table stock_movement add column if not exists nurse_order_dose_id uuid references nurse_order_dose (id);
create index if not exists stock_movement_nurse_order_dose_idx on stock_movement (nurse_order_dose_id)
  where nurse_order_dose_id is not null;
alter table invoice_line add column if not exists nurse_order_dose_id uuid references nurse_order_dose (id);
create index if not exists invoice_line_nurse_order_dose_idx on invoice_line (nurse_order_dose_id)
  where nurse_order_dose_id is not null;

-- ---------------------------------------------------------------- 2 the old times, linked
-- give_nurse_order has always written the time, its stock movements and its bill lines in one
-- transaction: they share created_at. Written as they were (no audit line, no "edited" mark; the
-- lines of a closed bill too). A second run finds nothing left to do.
alter table stock_movement disable trigger user;
update stock_movement m set nurse_order_dose_id = d.id
from nurse_order_dose d
where m.nurse_order_id = d.order_id and m.nurse_order_dose_id is null and m.type = 'consumption'
  and m.created_at = d.created_at and d.given;
alter table stock_movement enable trigger user;

alter table invoice_line disable trigger user;
update invoice_line l set nurse_order_dose_id = d.id
from nurse_order_dose d
where l.source_type = 'nurse_order' and l.source_id = d.order_id and l.nurse_order_dose_id is null
  and l.created_at = d.created_at and d.given;
alter table invoice_line enable trigger user;

alter table nurse_order_dose disable trigger user;
update nurse_order_dose d set quantity = o.quantity
from nurse_order o
where d.order_id = o.id and o.kind = 'drug' and d.given and d.quantity is null;
update nurse_order_dose d set office = (select l.office from invoice_line l where l.nurse_order_dose_id = d.id limit 1)
where d.office is null and d.given
  and exists (select 1 from invoice_line l where l.nurse_order_dose_id = d.id);
alter table nurse_order_dose enable trigger user;

-- ---------------------------------------------------------------- 3 the desk on the bill
-- The desk an order's bill line goes to: Nursing for a nurse or a midwife; otherwise the person's
-- own desk (a doctor: Consultation). Internal.
create or replace function order_office()
returns station
language sql stable security definer set search_path = public
as $$
  select case when is_nurse_role(auth.uid()) then 'nursing'::station
              else coalesce(my_home_station(), 'consultation'::station) end
$$;

-- ---------------------------------------------------------------- 4 one order as the screens read it
-- nurse_order_json (from 20270107090000_six_steps): + the medicine's unit and box, the take-home
-- part, each time's id, giver, pieces, desk, bill money and batches, and the times undone (0193).
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
                             left join batch b on b.id = x.batch_id), '[]'::jsonb)) order by d.n)
      from nurse_order_dose d where d.order_id = o.id and d.deleted_at is null), '[]'::jsonb),
    -- 0193: the times undone (back in the stock, off the bill): who, when, why
    'undone', coalesce((select jsonb_agg(jsonb_build_object(
        'n', d.n, 'at', d.at, 'by', (select full_name from profiles where id = d.by_id),
        'quantity', case when o.kind = 'drug' then coalesce(d.quantity, o.quantity) end,
        'homeQuantity', d.home_quantity, 'undoneAt', d.deleted_at,
        'undoneBy', (select full_name from profiles where id = d.undone_by), 'reason', d.undo_reason)
        order by d.deleted_at)
      from nurse_order_dose d where d.order_id = o.id and d.deleted_at is not null and d.undo_reason is not null), '[]'::jsonb))
  from nurse_order o
  left join item i on i.id = o.item_id
  where o.id = p_id
$$;

-- ---------------------------------------------------------------- 5 writing an order
-- The doctor writes one order (0193): a medical act (a treatment of the price list, billed once
-- when it is done; or written, not billed) or a medicine of the clinic's stock, given here and/or
-- taken home, all at one press. Whole pieces; the stock and whole boxes are checked now. For one
-- nurse, all the nurses, or himself ("Me": nobody is told).
create or replace function create_order_here(
  p_encounter_id uuid,
  p_kind text,
  p_item_id uuid default null,
  p_service_id uuid default null,
  p_text text default null,
  p_quantity numeric default null,
  p_dose text default null,
  p_route text default null,
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
  v_text text := nullif(trim(coalesce(p_text, '')), '');
  v_qty numeric;
  v_here numeric := 0;
  v_home numeric := 0;
  v_id uuid;
  v_params jsonb;
  v_link text;
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
    if p_item_id is null or not exists (select 1 from item i where i.id = p_item_id and i.active and i.deleted_at is null) then
      raise exception 'choose the medicine from the stock' using errcode = '22023', hint = 'item_needed';
    end if;
    v_here := coalesce(p_quantity, 0);
    v_home := coalesce(p_home_quantity, 0);
    if v_here < 0 or v_home < 0 then
      raise exception 'quantity must be more than zero' using errcode = '22023';
    end if;
    if v_here <> trunc(v_here) or v_home <> trunc(v_home) then
      raise exception 'a medicine is counted in whole pieces (tablets, capsules, bottles): write a half in the dose'
        using errcode = '22023';
    end if;
    if v_here + v_home = 0 then
      raise exception 'say how many are given here or taken home' using errcode = '22023';
    end if;
    if v_home > 0 and p_home_days is not null and p_home_days not between 1 and 365 then
      raise exception 'the number of days is between 1 and 365' using errcode = '22023';
    end if;
    -- a medicine sold only by the whole box: the total is whole boxes
    perform assert_whole_packs(p_item_id, v_here + v_home);
    if room_store_for(auth.uid(), p_item_id, (v_here + v_home)::integer, null, null) is null then
      raise exception 'not enough of this medicine (not expired) in the clinic''s stock'
        using errcode = 'MS003', hint = 'room_short';
    end if;
    v_text := item_label(p_item_id);
  end if;
  if length(coalesce(v_text, '')) < 2 then
    raise exception 'say what must be done' using errcode = '22023';
  end if;
  if p_assigned_to is not null and p_assigned_to <> auth.uid() and not is_nurse_role(p_assigned_to) then
    raise exception 'send it to a nurse, or to all the nurses' using errcode = '22023', hint = 'not_nurse';
  end if;
  insert into nurse_order (encounter_id, patient_id, kind, text, service_id, item_id, quantity, dose, route,
                           frequency, doses_planned, assigned_to, notes,
                           home_quantity, home_dose, home_frequency, home_days, home_instructions)
  values (p_encounter_id, v_e.patient_id, p_kind, v_text,
          case when p_kind = 'act' then p_service_id end, case when p_kind = 'drug' then p_item_id end,
          case when p_kind = 'drug' then v_here else v_qty end,
          case when p_kind = 'drug' and v_here > 0 then nullif(trim(coalesce(p_dose, '')), '') end,
          case when p_kind = 'drug' and v_here > 0 then nullif(trim(coalesce(p_route, '')), '') end,
          null, 1, p_assigned_to, nullif(trim(coalesce(p_notes, '')), ''),
          case when v_home > 0 then v_home end,
          case when v_home > 0 then nullif(trim(coalesce(p_home_dose, '')), '') end,
          case when v_home > 0 then nullif(trim(coalesce(p_home_frequency, '')), '') end,
          case when v_home > 0 then p_home_days end,
          case when v_home > 0 then nullif(trim(coalesce(p_home_instructions, '')), '') end)
  returning id into v_id;
  -- the nurses are told: the one named, else every employee whose role is Nurse (0132)
  v_link := '/app/visit?encounter=' || p_encounter_id;
  v_params := jsonb_build_object('orderId', v_id, 'kind', p_kind, 'title', v_text,
                                 'name', (select p.surname || ' ' || p.given_names from patient p where p.id = v_e.patient_id),
                                 'by', (select full_name from profiles where id = auth.uid()),
                                 'here', p_kind = 'act' or v_here > 0, 'home', v_home > 0);
  if p_assigned_to = auth.uid() then
    null; -- "Me, I do it myself": nobody to tell (0133)
  elsif p_assigned_to is not null then
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('nurse_order', v_params, v_link, p_assigned_to, auth.uid());
  else
    insert into notification (kind, params, link, recipient_user, created_by)
    select 'nurse_order', v_params, v_link, p.id, auth.uid()
    from profiles p
    where p.id <> auth.uid() and is_nurse_role(p.id);
  end if;
  return nurse_order_json(v_id);
end
$$;

-- create_nurse_order (from 20270113090000_doctor_does_it): the same arguments, now one order
-- carried out once (0193): a drug's total (each time × times) is given at once; an act is done
-- once. A screen opened before the update follows the same rule; the medicine keeps the "how
-- often" it sends (said beside the dose), so the nurse still sees it.
create or replace function create_nurse_order(
  p_encounter_id uuid, p_kind text, p_text text default null, p_service_id uuid default null,
  p_item_id uuid default null, p_quantity numeric default 1, p_dose text default null,
  p_route text default null, p_frequency text default null, p_doses integer default 1,
  p_assigned_to uuid default null, p_notes text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_j jsonb;
  v_freq text := nullif(trim(coalesce(p_frequency, '')), '');
begin
  if p_doses is null or p_doses < 1 or p_doses > 60 then
    raise exception 'the number of times is between 1 and 60' using errcode = '22023';
  end if;
  v_j := create_order_here(
    p_encounter_id => p_encounter_id, p_kind => p_kind, p_item_id => p_item_id,
    p_service_id => p_service_id, p_text => p_text,
    p_quantity => case when p_kind = 'drug' then coalesce(p_quantity, 1) * coalesce(p_doses, 1)
                       else coalesce(p_quantity, 1) end,
    p_dose => p_dose, p_route => p_route, p_assigned_to => p_assigned_to, p_notes => p_notes);
  if p_kind = 'drug' and v_freq is not null then
    update nurse_order set frequency = v_freq where id = (v_j ->> 'id')::uuid;
    v_j := nurse_order_json((v_j ->> 'id')::uuid);
  end if;
  return v_j;
end
$$;

-- ---------------------------------------------------------------- 6 carrying it out
-- give_nurse_order (from 20270113090000_doctor_does_it): one press (0193). A drug: everything
-- (here + to take home) leaves the clinic's stock (earliest expiry first) and goes on the bill in
-- one call, so a whole box keeps the box price; an act: billed once at its treatment's price. The
-- bill line goes to the desk of the person who presses (order_office). The time is linked to its
-- stock movements and bill lines. A closed bill, a missing price or a written act leaves it
-- unbilled (said: notBilled), never unrecorded. An older order of several times gives one time's
-- amount, as before.
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
  v_qty integer;
  v_total numeric;
  v_loc uuid;
  v_office station;
  v_dose uuid;
  v_why text;
  v_billed numeric;
begin
  v_o := nurse_order_for_work(p_order_id);
  if v_at > now() + interval '5 minutes' or v_at < now() - interval '24 hours' then
    raise exception 'the time given is not possible' using errcode = '22023', hint = 'bad_time';
  end if;
  v_n := (select count(*) from nurse_order_dose where order_id = v_o.id and deleted_at is null) + 1;
  v_office := order_office();
  if v_o.kind = 'drug' then
    v_total := v_o.quantity + coalesce(v_o.home_quantity, 0);
    v_qty := ceil(v_total)::integer;
    -- 0173: one stock, the main pharmacy (an open store named explicitly is honoured)
    v_loc := room_store_for(auth.uid(), v_o.item_id, v_qty, p_location_id, 'nursing');
    if v_loc is null then
      raise exception 'not enough of this medicine (not expired) in the clinic''s stock'
        using errcode = 'MS003', hint = 'room_short';
    end if;
  end if;
  insert into nurse_order_dose (order_id, n, given, at, by_id, note, location_id, charged, quantity, home_quantity, office)
  values (v_o.id, v_n, true, v_at, auth.uid(), nullif(trim(coalesce(p_note, '')), ''), v_loc, false,
          case when v_o.kind = 'drug' then v_o.quantity end,
          case when v_o.kind = 'drug' then v_o.home_quantity end, v_office)
  returning id into v_dose;
  if v_o.kind = 'drug' then
    perform give_from_store(v_o.item_id, v_loc, v_qty, null, 'order given here');
    update stock_movement set nurse_order_id = v_o.id, nurse_order_dose_id = v_dose
    where medication_request_id is null and nurse_order_id is null and item_id = v_o.item_id
      and from_location_id = v_loc and type = 'consumption' and created_at = now();
    begin
      perform add_charge_internal(v_o.encounter_id, v_office, null, v_o.item_id, v_total,
                                  null, null, auth.uid(), null, 'nurse_order', v_o.id);
    exception
      when sqlstate 'P0002' then v_why := 'no_price';
      when sqlstate 'MS001' then v_why := 'bill_closed';
    end;
  elsif v_o.service_id is not null then
    begin
      perform add_charge_internal(v_o.encounter_id, v_office, v_o.service_id, null, v_o.quantity,
                                  null, null, auth.uid(), null, 'nurse_order', v_o.id);
    exception
      when sqlstate 'P0002' then v_why := 'no_price';
      when sqlstate 'MS001' then v_why := 'bill_closed';
    end;
  else
    v_why := 'not_in_price_list';
  end if;
  update invoice_line set nurse_order_dose_id = v_dose
  where source_type = 'nurse_order' and source_id = v_o.id and nurse_order_dose_id is null
    and created_at = now() and deleted_at is null;
  update nurse_order_dose set charged = (v_why is null) where id = v_dose;
  perform nurse_order_close_if_complete(v_o.id);
  select coalesce(sum(round(l.quantity * l.unit_price)), 0) into v_billed
  from invoice_line l where l.nurse_order_dose_id = v_dose and l.deleted_at is null;
  return nurse_order_json(v_o.id)
    || jsonb_build_object('charged', v_why is null, 'notBilled', v_why, 'doseId', v_dose, 'billed', v_billed);
end
$$;

-- ---------------------------------------------------------------- 7 Undo
-- Undo what was given or done on an order (0193, as undo_given_here): the person who recorded it
-- the same day, or the manager any day, with the reason. The pieces go back to the clinic's stock,
-- the lines leave the bill (a credit note when the bill is closed; the cashier is told when money
-- goes back), the times are kept as undone (who, when, why). The doctor who wrote it or the
-- manager: the order ends cancelled; the nurse who gave it: it is to do again (not done when the
-- visit is finished) and the doctor is told. An order already over (cancelled, or not done) stays
-- as it is: only its times are undone. The reason typed is kept on the order only (the change log
-- hides it); the stock and the bill line say "order undone", the credit note too, and the
-- cashier's notice says only what came back and how much.
-- Answers the credit note's whole amount (creditTotal) and the patient's and insurer's parts.
create or replace function undo_nurse_order(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_o nurse_order%rowtype;
  v_reason text := trim(coalesce(p_reason, ''));
  v_doses uuid[];
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
  select * into v_o from nurse_order where id = p_order_id and deleted_at is null for update;
  if not found then
    raise exception 'order not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  perform 1 from nurse_order_dose d where d.order_id = v_o.id and d.deleted_at is null and d.given for update;
  select coalesce(array_agg(d.id order by d.n), '{}'::uuid[]) into v_doses
  from nurse_order_dose d where d.order_id = v_o.id and d.deleted_at is null and d.given;
  if cardinality(v_doses) = 0 then
    raise exception 'nothing was given or done on this order: there is nothing to undo' using errcode = '22023';
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
  -- the pieces go back into the store they came from (the main pharmacy when it is closed)
  for v_mv in
    select m.nurse_order_dose_id, m.item_id, m.batch_id, m.from_location_id, sum(m.quantity)::integer as quantity
    from stock_movement m
    where m.nurse_order_dose_id = any (v_doses) and m.type = 'consumption' and m.from_location_id is not null
      and m.deleted_at is null
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
  -- who is told: the doctor who wrote it (unless he undid it himself); the nurse it was for, when
  -- the order is cancelled now
  perform nurse_order_tell(v_o.id, 'undone', v_reason);
  if not v_over and v_status = 'cancelled' and v_o.assigned_to is not null and v_o.assigned_to <> auth.uid()
     and v_o.assigned_to is distinct from v_o.created_by then
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

-- ---------------------------------------------------------------- 8 the bin on the bill
-- void_charge (from 20261102210000_desks_polished): a line made by an order is refused to a
-- non-manager in plain words (0193); the other sources keep their sentence.
create or replace function void_charge(p_line_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice uuid;
  v_line invoice_line%rowtype;
  v_enc uuid;
begin
  if not has_perm('charge.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select l.* into v_line from invoice_line l where l.id = p_line_id;
  select i.encounter_id into v_enc from invoice i where i.id = v_line.invoice_id;
  if not is_manager() then
    -- only someone working on the patient (the cashier works on the bill)
    if current_role_key() <> 'cashier' then
      perform assert_may_work_on(v_enc);
    end if;
    -- 0193: a line made by an order of step 6: Undo on the order (the giver, or the manager)
    if v_line.source_type = 'nurse_order' then
      raise exception 'this line comes from an order given here (step 6 of the visit): the person who gave it undoes it there (the manager can remove it)'
        using errcode = '42501';
    end if;
    -- a line made by an order, a hand-over or a bed stay goes with it: cancel the order
    if v_line.source_type is not null then
      raise exception 'this line comes from % : undo it there (the manager can remove it)',
        case v_line.source_type when 'service_request' then 'a test or order ("Cannot do")'
                                when 'medication_dispense' then 'a medicine handed over'
                                when 'medication_request' then 'a medicine given here'
                                when 'bed_stay' then 'a bed stay'
                                else v_line.source_type end
        using errcode = '42501';
    end if;
  end if;
  update invoice_line l set deleted_at = now(), manual_reason = coalesce(l.manual_reason || ' · ', '') || 'removed: ' || trim(p_reason)
  from invoice i
  where l.id = p_line_id and i.id = l.invoice_id and i.status = 'draft' and l.deleted_at is null
  returning l.invoice_id into v_invoice;
  if v_invoice is null then
    raise exception 'charge not found or bill already posted' using errcode = 'P0002';
  end if;
  perform recompute_invoice(v_invoice);
end
$$;

-- ---------------------------------------------------------------- 9 where a bill line comes from
-- Beside visit_charges (whose columns cannot change, 0115): each live line's source (an order of
-- step 6, a test, a hand-over, a bed stay…), the time of the order it was made by, and who did it.
create or replace view visit_charge_sources with (security_invoker = true) as
  select l.id, l.invoice_id, i.encounter_id, l.source_type, l.source_id, l.nurse_order_dose_id, l.performed_by
  from invoice_line l
  join invoice i on i.id = l.invoice_id
  where l.deleted_at is null;
revoke all on visit_charge_sources from anon;
grant select on visit_charge_sources to authenticated;

-- ---------------------------------------------------------------- 10 the stock the order form sees
-- rx_stock (from 20261210090000_outside_prescriptions): + each boxed medicine's box (size, word,
-- how it is sold, box price), for the order form's price, "the rest of the box" and whole boxes.
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
      where i.active and i.deleted_at is null and coalesce(i.pack_size, 1) >= 2), '{}'::jsonb));
end
$$;

-- ---------------------------------------------------------------- 11 the safety summary
-- patient_safety_summary (from 20270107090000_six_steps): + the medicines taken home from the
-- clinic through an order (0193), until their days are over.
create or replace function patient_safety_summary(p_patient_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'allergies', p.allergies,
    'allergiesNone', coalesce(p.allergies_none, false) and p.allergies is null,
    'bloodGroup', p.blood_group,
    'alerts', p.notes,
    'flags', p.flags,
    -- long-lasting conditions: a chronic ICD-10 group, or the same diagnosis on two visits
    'chronic', coalesce((
      select jsonb_agg(jsonb_build_object('text', x.text, 'icd10', x.icd10_code, 'since', x.first_at, 'lastAt', x.created_at)
                       order by x.created_at desc)
      from (
        select distinct on (lower(c.text)) c.text, c.icd10_code, c.created_at,
               min(c.created_at) over (partition by lower(c.text)) as first_at
        from condition c join encounter e on e.id = c.encounter_id and e.deleted_at is null
        where e.patient_id = p.id and c.deleted_at is null and c.stage = 'definitive'
          and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or (has_perm('sensitive.read') and is_doctor()))
          and (coalesce(c.icd10_code, '') ~ '^(I1[0-5]|I25|I50|E0[3-5]|E1[0-4]|J4[45]|G40|N18|B18|B2[0-4]|F2[0-9]|F3[1-3])'
               or (select count(distinct c2.encounter_id) from condition c2
                   join encounter e2 on e2.id = c2.encounter_id and e2.deleted_at is null
                   where e2.patient_id = p.id and c2.deleted_at is null and c2.stage = 'definitive' and lower(c2.text) = lower(c.text)) >= 2)
        order by lower(c.text), c.created_at desc
      ) x), '[]'::jsonb),
    -- medicines of the open visit, and those still running (prescribed days not over); 0193: and
    -- those taken home from the clinic through an order
    'medications', coalesce((
      select jsonb_agg(md.j order by md.at desc)
      from (
        select m.created_at as at, jsonb_build_object(
            'item', rx_label(m), 'dose', m.dose, 'frequency', m.frequency,
            'days', m.duration_days, 'at', m.created_at, 'outside', m.supply = 'outside',
            'until', case when m.duration_days is not null then m.created_at + make_interval(days => m.duration_days) end,
            'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by))) as j
        from medication_request m
        join encounter e on e.id = m.encounter_id and e.deleted_at is null
        where e.patient_id = p.id and m.deleted_at is null and m.cancelled_at is null
          and (m.not_given_at is null or m.supply = 'outside')
          and m.created_at > now() - interval '180 days'
          and (e.status = 'open' or m.created_at + make_interval(days => coalesce(m.duration_days, 0)) >= now())
        union all
        select d.at, jsonb_build_object(
            'item', o.text, 'dose', o.home_dose, 'frequency', o.home_frequency,
            'days', o.home_days, 'at', d.at, 'outside', false, 'takeHome', true,
            'until', case when o.home_days is not null then d.at + make_interval(days => o.home_days) end,
            'by', (select full_name from profiles where id = d.by_id))
        from nurse_order_dose d
        join nurse_order o on o.id = d.order_id and o.deleted_at is null and o.kind = 'drug'
                           and coalesce(o.home_quantity, 0) > 0
        join encounter e on e.id = o.encounter_id and e.deleted_at is null
        where e.patient_id = p.id and d.deleted_at is null and d.given
          and d.at > now() - interval '180 days'
          and (e.status = 'open' or d.at + make_interval(days => coalesce(o.home_days, 0)) >= now())
      ) md), '[]'::jsonb),
    'lastVitals', coalesce((
      select jsonb_agg(jsonb_build_object('code', v.code, 'label', v.label, 'value', v.value_num, 'unit', v.unit, 'at', v.effective_at,
                                          'by', (select full_name from profiles where id = v.performer_id))
                       order by v.code)
      from (
        select distinct on (o.code) o.code, o.label, o.value_num, o.unit, o.effective_at, o.performer_id
        from observation o join encounter e on e.id = o.encounter_id and e.deleted_at is null
        where e.patient_id = p.id and o.deleted_at is null and o.code <> 'note' and o.value_num is not null
        order by o.code, o.effective_at desc
      ) v), '[]'::jsonb),
    'lastVisitAt', (select max(e.arrived_at) from encounter e where e.patient_id = p.id and e.deleted_at is null)
  )
  from patient p where p.id = p_patient_id
$$;

-- ---------------------------------------------------------------- 12 the patient's past visits
-- visit_past_history (from 20270107090000_six_steps): each order also says how many were given
-- here and what was taken home (0193).
create or replace function visit_past_history(p_encounter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_e encounter%rowtype;
  v_via text;
  v_count integer;
  v_on boolean := history_for_treating_doctor();
  v_sens boolean := has_perm('sensitive.read');
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_e from encounter where id = p_encounter_id and deleted_at is null;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  -- how many earlier visits: the list of visits is not a record (0126)
  select count(*) into v_count from encounter e
  where e.patient_id = v_e.patient_id and e.id <> v_e.id and e.deleted_at is null and e.arrived_at < v_e.arrived_at;
  if not is_doctor() or not clinical_reader() then
    return jsonb_build_object('allowed', false, 'reason', 'not_doctor', 'count', v_count, 'setting', v_on);
  end if;
  v_via := history_via(v_e.patient_id);
  if v_via is null then
    if v_on and v_e.status = 'open' and visit_working_on(v_e.id) then
      v_via := 'treating';
    else
      return jsonb_build_object('allowed', false, 'count', v_count, 'setting', v_on,
                                'reason', case when not v_on then 'setting_off' else 'not_treating' end,
                                'access', patient_access(v_e.patient_id));
    end if;
  end if;
  if v_count > 0 then
    perform log_record_access(v_e.patient_id, null, v_via, 'history');
  end if;
  return jsonb_build_object(
    'allowed', true, 'via', v_via, 'count', v_count, 'setting', v_on,
    'safety', (select jsonb_build_object('allergies', s -> 'allergies', 'allergiesNone', s -> 'allergiesNone',
                                         'alerts', s -> 'alerts', 'chronic', s -> 'chronic')
               from patient_safety_summary(v_e.patient_id) s),
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', e.id, 'reference', e.reference, 'at', e.arrived_at, 'status', e.status, 'service', e.service,
          'department', (select d.name from queue_entry q join department d on d.id = q.department_id
                         where q.encounter_id = e.id and q.deleted_at is null order by q.created_at desc limit 1),
          'desks', (select coalesce(jsonb_agg(distinct q.station::text), '[]'::jsonb) from queue_entry q
                    where q.encounter_id = e.id and q.deleted_at is null
                      and q.station not in ('reception', 'cashier', 'pharmacy')),
          'doctor', (select pr.full_name from profiles pr where pr.id = coalesce(
                       (select c.created_by from condition c where c.encounter_id = e.id and c.deleted_at is null
                        order by (c.stage = 'definitive') desc, c.created_at limit 1),
                       (select q.taken_by from queue_entry q where q.encounter_id = e.id and q.deleted_at is null
                          and q.taken_by is not null and station_desks(q.station) && treating_desks()
                        order by q.created_at limit 1))),
          'complaint', visit_complaint(e.id),
          'plan', (select s.text from visit_section s where s.encounter_id = e.id and s.section = 'plan' and s.deleted_at is null),
          'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('text', c.text, 'icd10', c.icd10_code, 'type', c.type)
                                                  order by (c.type = 'primary') desc, c.created_at)
                                 from condition c where c.encounter_id = e.id and c.deleted_at is null
                                   and c.stage = 'definitive'
                                   and (v_sens or coalesce(c.icd10_code, '') !~ '^B2[0-4]')), '[]'::jsonb),
          'noDiagnosis', case when e.no_diagnosis_kind is not null
                              then jsonb_build_object('kind', e.no_diagnosis_kind, 'note', e.no_diagnosis_note) end,
          'medicines', coalesce((select jsonb_agg(jsonb_build_object('item', rx_label(m), 'dose', m.dose,
                                   'frequency', m.frequency, 'days', m.duration_days, 'quantity', m.quantity,
                                   'supply', m.supply) order by m.created_at)
                                 from medication_request m where m.encounter_id = e.id and m.deleted_at is null
                                   and m.cancelled_at is null), '[]'::jsonb),
          'nurseOrders', coalesce((select jsonb_agg(jsonb_build_object('kind', o.kind, 'text', o.text, 'status', o.status,
                                     'dose', o.dose, 'frequency', o.frequency, 'planned', o.doses_planned,
                                     'given', (select count(*) from nurse_order_dose d where d.order_id = o.id
                                               and d.deleted_at is null and d.given),
                                     -- 0193: given here and to take home
                                     'quantity', o.quantity, 'homeQuantity', o.home_quantity,
                                     'homeDose', o.home_dose, 'homeFrequency', o.home_frequency,
                                     'homeDays', o.home_days) order by o.created_at)
                                   from nurse_order o where o.encounter_id = e.id and o.deleted_at is null), '[]'::jsonb),
          'tests', coalesce((select jsonb_agg(jsonb_build_object('test', s.name_en, 'status', r.status,
                               'findings', d.findings, 'impression', d.impression,
                               'verified', d.verified_at is not null) order by r.created_at)
                             from service_request r join service s on s.id = r.service_id
                             left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
                             where r.encounter_id = e.id and r.deleted_at is null
                               and (v_sens or not sensitive_service(s.id))), '[]'::jsonb)
        ) order by e.arrived_at desc)
      from (select * from encounter e0
            where e0.patient_id = v_e.patient_id and e0.id <> v_e.id and e0.deleted_at is null
              and e0.arrived_at < v_e.arrived_at
            order by e0.arrived_at desc limit 30) e), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------- 13 the change log hides the words
-- audit_redact (from 20270107090000_six_steps): + the take-home words and the reason of an undo (0193).
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
                   'home_dose', 'home_frequency', 'home_instructions', 'undo_reason']
  end
$$;

-- ---------------------------------------------------------------- 14 the stock reports
-- Since 0173 every medicine the clinic gives goes through an order (and from 0193 the medicines
-- taken home too): they count as given here, never as written off. An undone time is left out.

-- report_stock_sold (from 20261222090000_reports_stock_clinical): + the times of the orders in the
-- 'here' channel, with their bill money (0193).
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

-- report_stock_movements (from 20261222090000_reports_stock_clinical): an order's stock out is
-- given here, not written off (0193).
create or replace function report_stock_movements(
  p_from date, p_to date, p_location_id uuid default null, p_type text default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_admin boolean := stock_admin();
begin
  perform report_assert_stock(p_location_id);
  perform report_assert_period(p_from, p_to);
  return coalesce((
    select jsonb_agg(x.j order by x.at desc) from (
      select m.moved_at as at, jsonb_build_object(
          'id', m.id, 'at', m.moved_at, 'kind', k.kind, 'type', m.type,
          'itemId', m.item_id, 'name', i.name_generic || coalesce(' ' || i.strength, ''), 'code', i.code,
          'unit', i.selling_unit, 'packSize', case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end,
          'packUnit', i.pack_unit,
          'batch', b.batch_no, 'expiry', b.expiry,
          'fromId', m.from_location_id, 'from', lf.name, 'toId', m.to_location_id, 'to', lt.name,
          'quantity', m.quantity,
          'change', case when p_location_id is null then null
                         when m.to_location_id = p_location_id then m.quantity else -m.quantity end,
          'reason', nullif(regexp_replace(coalesce(m.reason, ''), '^count: ', ''), ''),
          'document', coalesce((select t.number from stock_transfer t where t.id = m.stock_transfer_id),
                               (select g.number from goods_receipt g where g.id = m.goods_receipt_id),
                               (select cs.number from counter_sale cs where cs.id = m.counter_sale_id)),
          'by', pr.full_name,
          'unitCost', case when v_admin then coalesce(m.unit_cost, b.unit_cost) end,
          'value', case when v_admin then round(m.quantity * coalesce(m.unit_cost, b.unit_cost, 0), 2) end
        ) as j
      from stock_movement m
      join item i on i.id = m.item_id
      left join batch b on b.id = m.batch_id
      left join stock_location lf on lf.id = m.from_location_id
      left join stock_location lt on lt.id = m.to_location_id
      left join profiles pr on pr.id = m.created_by
      cross join lateral (
        select case
                 when m.type = 'receipt' then 'received'
                 when m.type = 'transfer' then 'transfer'
                 when m.type = 'dispense' and m.counter_sale_id is not null then 'sold'
                 when m.type = 'dispense' then 'dispensed'
                 when m.type = 'return' then 'returned'
                 -- 0193: an order of step 6 is given here too
                 when m.type = 'consumption' and (m.medication_request_id is not null or m.nurse_order_id is not null)
                   then 'given_here'
                 when m.type = 'consumption' then 'written_off'
                 when m.type = 'adjustment' and coalesce(m.reason, '') like 'count:%' then 'count'
                 else 'written_off'
               end as kind
      ) k
      where m.deleted_at is null
        and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to
        and (p_location_id is null or m.from_location_id = p_location_id or m.to_location_id = p_location_id)
        and (p_type is null or p_type = '' or k.kind = p_type)
        and (v_admin or holds_store(auth.uid(), m.from_location_id) or holds_store(auth.uid(), m.to_location_id))
      order by m.moved_at desc
      limit 5000
    ) x
  ), '[]'::jsonb);
end
$$;

-- report_stock_write_offs (from 20261222090000_reports_stock_clinical): a medicine given to a
-- patient through an order is not written off (0193).
create or replace function report_stock_write_offs(p_from date, p_to date, p_location_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_admin boolean := stock_admin();
begin
  perform report_assert_stock(p_location_id);
  perform report_assert_period(p_from, p_to);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', m.id, 'at', m.moved_at,
        'kind', case when m.type = 'consumption' then 'written_off'
                     when coalesce(m.reason, '') like 'count:%' then 'count' else 'lost' end,
        'itemId', i.id, 'code', i.code, 'name', i.name_generic || coalesce(' ' || i.strength, ''),
        'unit', i.selling_unit, 'packSize', case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end,
        'packUnit', i.pack_unit, 'itemKind', i.kind,
        'batch', b.batch_no, 'expiry', b.expiry,
        'storeId', coalesce(m.from_location_id, m.to_location_id), 'store', l.name,
        'quantity', case when m.to_location_id is not null then m.quantity else -m.quantity end,
        'reason', nullif(regexp_replace(coalesce(m.reason, ''), '^count: ', ''), ''),
        'costValue', case when v_admin then round(case when m.to_location_id is not null then 1 else -1 end
                                                  * m.quantity * coalesce(m.unit_cost, b.unit_cost, 0), 2) end,
        'by', pr.full_name
      ) order by m.moved_at desc)
    from stock_movement m
    join item i on i.id = m.item_id
    left join batch b on b.id = m.batch_id
    left join stock_location l on l.id = coalesce(m.from_location_id, m.to_location_id)
    left join profiles pr on pr.id = m.created_by
    where m.deleted_at is null
      and ((m.type = 'consumption' and m.medication_request_id is null and m.nurse_order_id is null)
           or m.type = 'adjustment')
      and (m.moved_at at time zone 'Africa/Kigali')::date between p_from and p_to
      and (p_location_id is null or coalesce(m.from_location_id, m.to_location_id) = p_location_id)
      and (v_admin or holds_store(auth.uid(), coalesce(m.from_location_id, m.to_location_id)))
  ), '[]'::jsonb);
end
$$;

-- stock_sales (from 20270201090000_sales_by_person): a bill line of an order time that was undone
-- is not sold (0193). On a closed bill the line stays (a credit note answers for it), so it is
-- left out here, as the other stock reports do.
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
           (l.quantity * coalesce(l.pack_size, 1))::numeric as units,
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

-- ---------------------------------------------------------------- rights
-- (functions replaced with the same arguments keep their grants; the new ones need theirs)
revoke all on function order_office() from public, anon, authenticated;
revoke all on function
  create_order_here(uuid, text, uuid, uuid, text, numeric, text, text, numeric, text, text, integer, text, uuid, text),
  undo_nurse_order(uuid, text)
  from public, anon;
grant execute on function
  create_order_here(uuid, text, uuid, uuid, text, numeric, text, text, numeric, text, text, integer, text, uuid, text),
  undo_nurse_order(uuid, text)
  to authenticated;
