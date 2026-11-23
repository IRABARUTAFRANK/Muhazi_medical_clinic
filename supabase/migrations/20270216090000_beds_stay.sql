-- 0197 · Patients kept in a bed: given from the treatment plan, billed day by day, kept apart.
--
-- Frank (owner): "this can be well managed in the treatment plan where if it requires the patient
-- to be assigned to a certain bed for some period he may be assigned to it and the bill adds to the
-- bill daily as the day passes when his visit has not yet finished … those who may have an extended
-- period while being taken care of … must be saved to another part".
--
-- Before: a nurse of the Nursing desk put a patient in a bed for a number of nights said in advance;
-- the nights went on the bill at once (nights × the bed's price, or a price agreed for the period)
-- and "Extend" billed more nights the same way. The doctor could not give a bed from the visit, the
-- bill did not follow the days really spent, and a patient staying several days showed as a visit
-- "from earlier days" on the homes and as "forgotten" on the dashboards.
--
-- Now:
--   1 keep_in_bed        the treating doctor (step 6, Treatment plan), a nurse of the Nursing desk or
--                        the manager gives a free bed: for how many days it is expected (or not
--                        decided yet) and why. The nurses are told (notice 'bed_stay').
--   2 the days           one bed day is on the bill from the clinic's calendar day (Kigali) the
--                        patient is given the bed, and one more for each new day that starts while the
--                        stay is open, at the bed's price when the day is added, under the visit's
--                        payer rules (the insurer's own price for a bed day when it has one, the
--                        plan's coverage for beds, the insurer's exclusion). One line per
--                        stay and price: "Bed stay · Bed 3 · 21/11/2026 → 23/11/2026", the quantity is
--                        the number of days. Each day is written once in bed_day (one row per visit and
--                        day): never twice, also on the day the patient moves to another bed (the day
--                        stays with the bed the patient had when it began).
--                        Nobody presses anything: bed_days_catch_up adds the days that are due; the web
--                        runs it whenever the beds, a visit's bill or the cashier's figures are read;
--                        the end of a stay and the end of the visit run it one last time.
--   3 move_to_bed, set_bed_days, end_bed_stay   another free bed, the days expected (Extend), the end
--                        of the stay (the bed goes to cleaning; no more days).
--   4 finishing          finish_visit refuses while the patient is in a bed (hint in_bed: the screen
--                        asks to end the stay first); a patient who leaves (end_visit) or a visit closed
--                        otherwise ends the stay after its last day is on the bill.
--   5 kept apart         a patient in a bed is not "from earlier days" (my_summary, nav_counts) nor
--                        "forgotten" (queue_now, the dashboards); nav_counts gives 'inBeds' for the new
--                        menu entry "Patients in beds"; bed_board says the days, the amount and what is
--                        owed for each patient in a bed.
--   6 the old screen     admit_to_bed / extend_bed_stay / discharge_bed keep their arguments (a screen
--                        opened before the update) and follow the new rule: the nights become the days
--                        expected, nothing is billed in advance, a price agreed for the period is no
--                        longer used.
--   7 report             report_bed_stays: who stayed, in which beds, how many days, for how much.

-- ---------------------------------------------------------------- 1 the stay and its days
alter table bed_stay add column if not exists by_day boolean not null default false;
alter table bed_stay add column if not exists expected_days integer;
alter table bed_stay drop constraint if exists bed_stay_expected_days_check;
alter table bed_stay add constraint bed_stay_expected_days_check
  check (expected_days is null or expected_days between 1 and 365);
alter table bed_stay add column if not exists reason text;
alter table bed_stay add column if not exists given_by uuid;
alter table bed_stay add column if not exists ended_by uuid;
alter table bed_stay add column if not exists end_reason text;
comment on column bed_stay.by_day is
  '0197: billed one day at a time (bed_day); false = an older stay billed by nights in advance';

-- One row per visit and calendar day (Kigali) on the bill: the key makes a day count once.
create table if not exists bed_day (
  encounter_id uuid not null references encounter (id),
  day date not null,
  stay_id uuid not null references bed_stay (id),
  bed_id uuid not null references bed (id),
  price numeric(12, 0) not null default 0,
  line_id uuid references invoice_line (id),
  created_at timestamptz not null default now(),
  primary key (encounter_id, day)
);
create index if not exists bed_day_stay_idx on bed_day (stay_id);
create index if not exists bed_day_line_idx on bed_day (line_id);
alter table bed_day enable row level security;
revoke all on bed_day from public, anon, authenticated;

-- The clinic's calendar day of a moment.
create or replace function kigali_day(p_at timestamptz)
returns date
language sql stable set search_path = public
as $$
  select (p_at at time zone 'Africa/Kigali')::date
$$;

-- The stays open now were billed by nights in advance: those nights are on the bill already (their
-- days are written, with no line of their own), and the days after them are added one by one.
insert into bed_day (encounter_id, day, stay_id, bed_id, price)
select s.encounter_id, g.d::date, s.id, s.bed_id, coalesce(s.nightly_price, 0)
from bed_stay s
join encounter e on e.id = s.encounter_id and e.status = 'open'
cross join lateral generate_series(
  kigali_day(s.admitted_at)::timestamp,
  (kigali_day(s.admitted_at) + greatest(coalesce(s.planned_nights, 1), 1) - 1)::timestamp,
  interval '1 day') g(d)
where s.discharged_at is null and s.deleted_at is null and not s.by_day
on conflict do nothing;
update bed_stay s set by_day = true, expected_days = coalesce(s.expected_days, s.planned_nights)
from encounter e
where e.id = s.encounter_id and e.status = 'open'
  and s.discharged_at is null and s.deleted_at is null and not s.by_day;

-- A patient of this visit is in a bed now.
create or replace function visit_in_bed(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from bed_stay s
                 where s.encounter_id = p_encounter_id and s.discharged_at is null and s.deleted_at is null)
$$;

-- Who gives, moves, extends and ends a stay: the treating doctor (whoever may work on the visit at a
-- treating desk), a nurse of the Nursing desk, or the manager.
create or replace function assert_bed_rights(p_encounter_id uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if is_manager() then
    return;
  end if;
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if may_use_desk('nursing') then
    return;
  end if;
  if is_doctor() then
    perform assert_desk(treating_desks(), 'treatment');
    perform assert_may_work_on(p_encounter_id);
    return;
  end if;
  raise exception 'not allowed: a bed is given by the treating doctor, a nurse of the nursing desk or the manager'
    using errcode = '42501';
end
$$;

-- ---------------------------------------------------------------- 2 one day on the bill
-- Adds the day p_day of the stay to the visit's bill, once: false when the day is already counted
-- (this stay or another bed of the same visit) or the bill is closed. The price: the insurer's own
-- price for a bed day (Bed stay) when the visit's insurer has one, else the bed's price (a typed
-- price, as bed stays always were, so a change of insurer treats it the same way); the coverage of
-- the visit's plan for beds; none when the insurer excludes bed days. The day joins the stay's line
-- of the same price and coverage (one more day), or starts a line.
create or replace function bill_bed_day(p_stay_id uuid, p_day date)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v_s bed_stay%rowtype;
  v_bed bed%rowtype;
  v_inv invoice%rowtype;
  v_svc uuid;
  v_plan uuid;
  v_unit numeric;
  v_list numeric;
  v_pct numeric;
  v_origin price_origin := 'manual';
  v_reason text;
  v_ins_price numeric;
  v_src text;
  v_list_payer uuid;
  v_line invoice_line%rowtype;
  v_total numeric;
  v_insurer numeric;
begin
  select * into v_s from bed_stay where id = p_stay_id and deleted_at is null;
  if not found then
    return false;
  end if;
  select * into v_inv from invoice where encounter_id = v_s.encounter_id for update;
  if not found or v_inv.status <> 'draft' then
    return false;
  end if;
  select * into v_bed from bed where id = v_s.bed_id;
  -- the day is claimed first: a second call (another screen at the same moment) adds nothing
  insert into bed_day (encounter_id, day, stay_id, bed_id, price)
  values (v_s.encounter_id, p_day, v_s.id, v_s.bed_id, coalesce(v_bed.nightly_price, 0))
  on conflict (encounter_id, day) do nothing;
  if not found then
    return false;
  end if;

  select id into v_svc from service where code = 'BED-STAY';
  v_unit := coalesce(v_bed.nightly_price, 0);
  v_list := v_unit;
  v_reason := 'price of ' || v_bed.name;
  select c.plan_id into v_plan from coverage c where c.id = v_inv.coverage_id;
  v_pct := coalesce(coverage_pct_for(v_plan, 'bed'::service_group), 0);
  if v_inv.payer_id is not null and v_svc is not null then
    select pf.price, pf.source, pf.list_payer_id into v_ins_price, v_src, v_list_payer
    from price_source_for(v_svc, null, v_inv.payer_id, p_day) pf;
    if v_list_payer is not null and v_ins_price is not null then
      -- the insurer's own price for a bed day
      v_unit := v_ins_price;
      v_list := v_ins_price;
      v_origin := 'preset';
      v_reason := null;
    end if;
    if v_src = 'excluded' then
      -- the insurer excludes bed days: the patient pays them
      v_pct := 0;
    end if;
  end if;
  update bed_day set price = v_unit where encounter_id = v_s.encounter_id and day = p_day;
  if v_unit <= 0 or v_svc is null then
    -- a free bed: the day counts, there is nothing to pay
    return true;
  end if;

  select * into v_line from invoice_line l
  where l.invoice_id = v_inv.id and l.deleted_at is null and l.source_type = 'bed_stay'
    and l.source_id = v_s.id and l.unit_price = v_unit and l.coverage_pct = v_pct
    and l.cover_mode is null and coalesce(l.discount_pct, 0) = 0
    and exists (select 1 from bed_day d where d.line_id = l.id)
  order by l.created_at desc
  limit 1;
  if found then
    v_total := round(v_unit * (v_line.quantity + 1));
    v_insurer := round(v_total * v_pct / 100);
    update invoice_line
    set quantity = quantity + 1, patient_share = v_total - v_insurer, insurer_share = v_insurer
    where id = v_line.id;
  else
    v_insurer := round(v_unit * v_pct / 100);
    insert into invoice_line (
      invoice_id, service_id, description, quantity, unit_price, list_price, discount_pct,
      coverage_pct, patient_share, insurer_share, office, performed_by, entered_by,
      source_type, source_id, price_origin, manual_reason
    ) values (
      v_inv.id, v_svc, 'Bed stay · ' || v_bed.name, 1, v_unit, v_list, 0,
      v_pct, v_unit - v_insurer, v_insurer, 'beds', v_s.given_by, coalesce(v_s.given_by, auth.uid()),
      'bed_stay', v_s.id, v_origin, v_reason
    ) returning * into v_line;
  end if;
  update bed_day set line_id = v_line.id where encounter_id = v_s.encounter_id and day = p_day;
  -- the line says its bed and its days
  update invoice_line l
  set description = 'Bed stay · ' || v_bed.name || ' · ' || to_char(r.first_day, 'DD/MM/YYYY')
                    || case when r.last_day > r.first_day then ' → ' || to_char(r.last_day, 'DD/MM/YYYY') else '' end
  from (select min(d.day) as first_day, max(d.day) as last_day from bed_day d where d.line_id = v_line.id) r
  where l.id = v_line.id;
  perform recompute_invoice(v_inv.id);
  return true;
end
$$;

-- Every day due on the visit's bill: from the day each stay began to the day it ended (today while
-- it is open). A day two stays share (a move) goes to the stay that began first.
create or replace function bill_bed_days_of(p_encounter_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_r record;
  v_n integer := 0;
begin
  for v_r in
    select s.id as stay_id, g.d::date as day
    from bed_stay s
    cross join lateral generate_series(kigali_day(s.admitted_at)::timestamp,
                                       kigali_day(coalesce(s.discharged_at, now()))::timestamp,
                                       interval '1 day') g(d)
    where s.encounter_id = p_encounter_id and s.by_day and s.deleted_at is null
      and not exists (select 1 from bed_day b where b.encounter_id = s.encounter_id and b.day = g.d::date)
    order by g.d, s.admitted_at
  loop
    if bill_bed_day(v_r.stay_id, v_r.day) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end
$$;

-- The catch-up (nobody presses anything): the days due on one visit, or on every visit with a
-- patient in a bed. Anyone signed in may run it: it adds only what is due, once.
create or replace function bed_days_catch_up(p_encounter_id uuid default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer := 0;
  v_e uuid;
begin
  if auth.uid() is null or current_role_key() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_encounter_id is not null then
    return bill_bed_days_of(p_encounter_id);
  end if;
  for v_e in
    select distinct s.encounter_id
    from bed_stay s
    join encounter e on e.id = s.encounter_id and e.status = 'open' and e.deleted_at is null
    where s.by_day and s.discharged_at is null and s.deleted_at is null
  loop
    v_n := v_n + bill_bed_days_of(v_e);
  end loop;
  return v_n;
end
$$;

-- The bed time of a visit: the open stay (its bed, since when), the days on the bill, their amount.
create or replace function bed_stay_summary(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'stayId', s.id, 'bedId', s.bed_id, 'bed', b.name, 'since', s.admitted_at,
    'expectedDays', s.expected_days,
    'days', (select count(*) from bed_day d where d.encounter_id = p_encounter_id),
    'amount', (select coalesce(sum(round(l.unit_price * l.quantity)), 0)
               from invoice_line l join invoice i on i.id = l.invoice_id
               where i.encounter_id = p_encounter_id and l.deleted_at is null and l.source_type = 'bed_stay'))
  from bed_stay s
  join bed b on b.id = s.bed_id
  where s.encounter_id = p_encounter_id and s.deleted_at is null
  order by s.discharged_at is null desc, s.admitted_at desc
  limit 1
$$;

-- The nurses are told (every nurse but the one who did it): a patient given a bed, moved, or whose
-- stay ended (the bed is to be cleaned).
create or replace function bed_notice(p_stay_id uuid, p_what text, p_from_bed text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_s bed_stay%rowtype;
  v_params jsonb;
begin
  select * into v_s from bed_stay where id = p_stay_id;
  if not found then
    return;
  end if;
  v_params := jsonb_build_object(
    'what', p_what,
    'stayId', v_s.id,
    'bed', (select name from bed where id = v_s.bed_id),
    'fromBed', p_from_bed,
    'name', (select p.surname || ' ' || p.given_names from encounter e join patient p on p.id = e.patient_id
             where e.id = v_s.encounter_id),
    'by', (select full_name from profiles where id = auth.uid()),
    'days', v_s.expected_days,
    'reason', v_s.reason);
  insert into notification (kind, params, link, recipient_user, created_by)
  select 'bed_stay', v_params, '/app/visit?encounter=' || v_s.encounter_id, p.id, auth.uid()
  from profiles p
  where p.id is distinct from auth.uid() and is_nurse_role(p.id);
end
$$;

-- ---------------------------------------------------------------- 3 give, move, extend, end
-- The patient of an open visit goes to a free bed: p_days expected (null: not decided yet), why.
-- The first day is on the bill at once.
create or replace function keep_in_bed(
  p_encounter_id uuid,
  p_bed_id uuid,
  p_days integer default null,
  p_reason text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_e encounter%rowtype;
  v_bed bed%rowtype;
  v_stay uuid;
begin
  perform assert_bed_rights(p_encounter_id);
  select * into v_e from encounter where id = p_encounter_id and deleted_at is null;
  if not found or v_e.status <> 'open' then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if p_days is not null and p_days not between 1 and 365 then
    raise exception 'the number of days is between 1 and 365' using errcode = '22023';
  end if;
  if visit_in_bed(p_encounter_id) then
    raise exception 'this patient is already in a bed' using errcode = '23505';
  end if;
  if not exists (select 1 from invoice where encounter_id = p_encounter_id and status = 'draft') then
    raise exception 'no open bill for this visit: the bill was already closed' using errcode = 'MS001', hint = 'no_open_bill';
  end if;
  update bed set status = 'occupied'
  where id = p_bed_id and status = 'free' and deleted_at is null
  returning * into v_bed;
  if not found then
    raise exception 'this bed is not free' using errcode = 'P0002';
  end if;
  insert into bed_stay (encounter_id, bed_id, charge_mode, by_day, expected_days, planned_nights, planned_until,
                        nightly_price, reason, given_by)
  values (p_encounter_id, p_bed_id, 'day', true, p_days, p_days,
          case when p_days is not null then now() + make_interval(days => p_days) end,
          v_bed.nightly_price, nullif(trim(coalesce(p_reason, '')), ''), auth.uid())
  returning id into v_stay;
  perform bill_bed_days_of(p_encounter_id);
  perform bed_notice(v_stay, 'given');
  return bed_stay_summary(p_encounter_id);
end
$$;

-- To another free bed: the stay in the old bed ends (it goes to cleaning) and a stay in the new bed
-- begins, with the same days expected and reason (or the reason of the move). Today stays on the
-- old bed's line; the new bed's price counts from tomorrow.
create or replace function move_to_bed(p_encounter_id uuid, p_bed_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_old bed_stay%rowtype;
  v_bed bed%rowtype;
  v_from text;
  v_stay uuid;
begin
  perform assert_bed_rights(p_encounter_id);
  select * into v_old from bed_stay
  where encounter_id = p_encounter_id and discharged_at is null and deleted_at is null
  for update;
  if not found then
    raise exception 'this patient is not in a bed' using errcode = 'P0002';
  end if;
  if v_old.bed_id = p_bed_id then
    raise exception 'the patient is already in this bed' using errcode = '22023';
  end if;
  -- the days up to today on the old bed first
  perform bill_bed_days_of(p_encounter_id);
  update bed set status = 'occupied'
  where id = p_bed_id and status = 'free' and deleted_at is null
  returning * into v_bed;
  if not found then
    raise exception 'this bed is not free' using errcode = 'P0002';
  end if;
  select name into v_from from bed where id = v_old.bed_id;
  update bed_stay set discharged_at = now(), ended_by = auth.uid(), end_reason = 'moved'
  where id = v_old.id;
  update bed set status = 'cleaning' where id = v_old.bed_id;
  insert into bed_stay (encounter_id, bed_id, charge_mode, by_day, expected_days, planned_nights, planned_until,
                        nightly_price, reason, given_by)
  values (p_encounter_id, p_bed_id, 'day', true, v_old.expected_days, v_old.planned_nights, v_old.planned_until,
          v_bed.nightly_price, coalesce(nullif(trim(coalesce(p_reason, '')), ''), v_old.reason),
          coalesce(v_old.given_by, auth.uid()))
  returning id into v_stay;
  perform bill_bed_days_of(p_encounter_id);
  perform bed_notice(v_stay, 'moved', v_from);
  return bed_stay_summary(p_encounter_id);
end
$$;

-- Extend (or shorten): the days expected for the whole stay; null = not decided. Nothing is billed:
-- the days are billed as they pass.
create or replace function set_bed_days(p_encounter_id uuid, p_days integer)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_s bed_stay%rowtype;
  v_first timestamptz;
begin
  perform assert_bed_rights(p_encounter_id);
  if p_days is not null and p_days not between 1 and 365 then
    raise exception 'the number of days is between 1 and 365' using errcode = '22023';
  end if;
  select * into v_s from bed_stay
  where encounter_id = p_encounter_id and discharged_at is null and deleted_at is null
  for update;
  if not found then
    raise exception 'this patient is not in a bed' using errcode = 'P0002';
  end if;
  -- counted from the first day in a bed of this visit (a move keeps it)
  select coalesce(min(d.day)::timestamp at time zone 'Africa/Kigali', v_s.admitted_at) into v_first
  from bed_day d where d.encounter_id = p_encounter_id;
  update bed_stay
  set expected_days = p_days, planned_nights = p_days,
      planned_until = case when p_days is not null then v_first + make_interval(days => p_days) end
  where id = v_s.id;
  perform bill_bed_days_of(p_encounter_id);
  return bed_stay_summary(p_encounter_id);
end
$$;

-- End the stay: its last day is on the bill (today), the bed goes to cleaning, no more days.
create or replace function end_bed_stay(p_encounter_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_s bed_stay%rowtype;
begin
  perform assert_bed_rights(p_encounter_id);
  select * into v_s from bed_stay
  where encounter_id = p_encounter_id and discharged_at is null and deleted_at is null
  for update;
  if not found then
    raise exception 'this patient is not in a bed' using errcode = 'P0002';
  end if;
  perform bill_bed_days_of(p_encounter_id);
  update bed_stay
  set discharged_at = now(), ended_by = auth.uid(),
      end_reason = coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'ended')
  where id = v_s.id;
  update bed set status = 'cleaning' where id = v_s.bed_id;
  perform bed_notice(v_s.id, 'ended');
  return bed_stay_summary(p_encounter_id);
end
$$;

-- ---------------------------------------------------------------- 6 the old screen
-- admit_to_bed (from 20261126090000_departments_decide_desks): 0197 — the stay of keep_in_bed; the
-- nights become the days expected; nothing billed in advance (the agreed price is not used).
create or replace function admit_to_bed(
  p_encounter_id uuid,
  p_bed_id uuid,
  p_nights integer default 1,
  p_period_price numeric default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v jsonb;
begin
  v := keep_in_bed(p_encounter_id, p_bed_id, p_nights, null);
  return jsonb_build_object('stayId', v ->> 'stayId', 'nights', p_nights,
                            'total', coalesce((v ->> 'amount')::numeric, 0));
end
$$;

-- extend_bed_stay (from 20261126090000_departments_decide_desks): 0197 — more days expected; the
-- days are billed as they pass.
create or replace function extend_bed_stay(
  p_bed_id uuid,
  p_nights integer,
  p_period_price numeric default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_s bed_stay%rowtype;
  v_days integer;
begin
  select * into v_s from bed_stay
  where bed_id = p_bed_id and discharged_at is null and deleted_at is null;
  if not found then
    raise exception 'nobody is in this bed' using errcode = 'P0002';
  end if;
  if p_nights is null or p_nights < 1 or p_nights > 365 then
    raise exception 'the number of nights must be between 1 and 365' using errcode = '22023';
  end if;
  select count(*) into v_days from bed_day where encounter_id = v_s.encounter_id;
  perform set_bed_days(v_s.encounter_id, least(greatest(coalesce(v_s.expected_days, v_days), 1) + p_nights, 365));
  return jsonb_build_object('nights', p_nights, 'total', 0);
end
$$;

-- discharge_bed (from 20261126090000_departments_decide_desks): 0197 — end_bed_stay.
create or replace function discharge_bed(p_bed_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_enc uuid;
begin
  select encounter_id into v_enc from bed_stay
  where bed_id = p_bed_id and discharged_at is null and deleted_at is null;
  if v_enc is null then
    if auth.uid() is null or not (is_manager() or has_perm('clinical.write')) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    raise exception 'nobody is in this bed' using errcode = 'P0002';
  end if;
  perform end_bed_stay(v_enc, null);
end
$$;

-- ---------------------------------------------------------------- 4 a visit that ends ends its stay
-- bed_follows_visit (from 20261103090000_loose_ends): 0197 — the days up to today are on the bill
-- first; who ended it and why are kept.
create or replace function bed_follows_visit()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'closed' and old.status is distinct from 'closed' then
    perform bill_bed_days_of(new.id);
    with ended as (
      update bed_stay set discharged_at = now(), ended_by = auth.uid(),
                          end_reason = coalesce(end_reason, 'visit finished')
      where encounter_id = new.id and discharged_at is null and deleted_at is null
      returning bed_id
    )
    update bed set status = 'cleaning' where id in (select bed_id from ended);
  end if;
  return new;
end
$$;

-- finish_visit (from 20270107090000_six_steps): 0197 — refused while the patient is in a bed (hint
-- in_bed): the screen asks to end the stay first. Everything else as before.
create or replace function finish_visit(p_encounter_id uuid, p_no_diagnosis text default null,
                                        p_no_diagnosis_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_rx boolean;
  v_due boolean;
  v_ticket text;
  v_next station;
  v_keep queue_entry%rowtype;
begin
  perform assert_may_work_on(p_encounter_id);
  -- 0197: a patient in a bed: the stay is ended first (the bed is freed, the days stop)
  if visit_in_bed(p_encounter_id) then
    raise exception 'this patient is still in a bed: end the stay first (the bed is freed and no more days are added)'
      using errcode = '23514', hint = 'in_bed';
  end if;
  if p_no_diagnosis is not null then
    perform set_no_diagnosis(p_encounter_id, p_no_diagnosis, p_no_diagnosis_note);
  end if;
  v_rx := exists (select 1 from medication_request m where m.encounter_id = p_encounter_id and rx_pending(m));
  v_next := case when v_rx then 'pharmacy' else 'cashier' end;
  -- the patient already waits there (the doctor sent them on before finishing): keep that place
  select * into v_keep from queue_entry
  where encounter_id = p_encounter_id and station = v_next and finished_at is null and deleted_at is null
  order by created_at desc limit 1;
  perform close_encounter(p_encounter_id);
  -- 0127: step 1 — the chief complaint is written before the visit is finished
  if exists (select 1 from encounter e where e.id = p_encounter_id
             and e.type in ('opd', 'dental', 'procedure', 'observation'))
     and visit_complaint(p_encounter_id) is null then
    raise exception 'write the chief complaint (step 1) before finishing the visit'
      using errcode = '23514', hint = 'complaint_needed';
  end if;
  v_due := exists (select 1 from invoice i where i.encounter_id = p_encounter_id and invoice_balance(i.id) > 0);
  if v_rx or v_due then
    -- Treatment is over; the visit stays open until the medicines are handed over and the bill is paid.
    update encounter set status = 'open', closed_at = null, closed_by = null, clinical_done_at = now()
    where id = p_encounter_id;
    if v_keep.id is not null then
      update queue_entry set finished_at = null,
             referral_note = coalesce(referral_note, case when v_rx then 'Medicines to hand over' end)
      where id = v_keep.id
      returning * into v_keep;
      perform notify_queue_entry_row(v_keep);
      return;
    end if;
    select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
    -- medicines first (their price joins the bill), then the cashier
    if v_rx then
      insert into queue_entry (encounter_id, station, ticket_no, referred_by, referral_note)
      values (p_encounter_id, 'pharmacy', coalesce(v_ticket, 'A-000'), auth.uid(), 'Medicines to hand over');
    else
      insert into queue_entry (encounter_id, station, ticket_no)
      values (p_encounter_id, 'cashier', coalesce(v_ticket, 'A-000'));
    end if;
  else
    -- nothing left to hand over or to pay: the visit is closed, its bill posted (insurer's claim)
    perform post_drafts_of_visit(p_encounter_id);
  end if;
end
$$;

-- end_visit (from 20270123090000_leave_owing): 0197 — the bed days up to today are on the bill
-- before what is due is counted (the stay then ends with the visit, bed_follows_visit).
create or replace function end_visit(p_encounter_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_due numeric;
  v_role text;
  v_patient uuid;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select patient_id into v_patient from encounter where id = p_encounter_id and status = 'open';
  if v_patient is null then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  perform bill_bed_days_of(p_encounter_id);
  select coalesce(sum(invoice_balance(i.id)), 0) into v_due from invoice i
  where i.encounter_id = p_encounter_id and i.status <> 'credited';
  if v_due > 0 then
    select role::text into v_role from profiles where id = auth.uid();
    -- 0144: the manager, or whoever holds "Let a patient go with money due" (never the administrator)
    if not (is_manager() or (has_perm('visit.leave_owing') and coalesce(v_role, '') <> 'administrator')) then
      raise exception 'money is still due (% RWF): take the payment first, or someone allowed may let the patient go with a debt', round(v_due)
        using errcode = '23514', hint = 'leave_owing';
    end if;
    if nullif(trim(coalesce(p_reason, '')), '') is null then
      raise exception 'money is still due (% RWF): say why the patient left without paying', round(v_due)
        using errcode = '22023', hint = 'leave_reason';
    end if;
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and finished_at is null;
  update encounter
  set status = 'closed', closed_at = now(), closed_by = auth.uid(),
      left_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = p_encounter_id;
  -- the bill gets its number and the insurer's claim; what the patient owes stays on the unpaid list
  perform post_drafts_of_visit(p_encounter_id);
  if v_due > 0 then
    insert into audit_event (actor_id, action, entity, entity_id, after)
    values (auth.uid(), 'update', 'encounter', p_encounter_id,
            jsonb_build_object('key', 'left_owing', 'patient_id', v_patient, 'due', round(v_due),
                               'reason', nullif(trim(coalesce(p_reason, '')), '')));
  end if;
  return jsonb_build_object('due', v_due);
end
$$;

-- ---------------------------------------------------------------- 5 kept apart
-- queue_now (from 20261127090000_analytics): 0197 — a patient in a bed is never "forgotten": an
-- entry of an earlier day of such a visit still waits (counted as waiting).
create or replace function queue_now(p_stations station[] default null)
returns table (station text, waiting integer, busy integer, longest integer, forgotten integer)
language sql stable security definer set search_path = public
as $$
  with k as (select ((now() at time zone 'Africa/Kigali')::date)::timestamp at time zone 'Africa/Kigali' as midnight)
  select q.station::text,
         (count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open' and (q.created_at >= k.midnight or visit_in_bed(e.id))))::int,
         (count(*) filter (where q.finished_at is null and q.started_at is not null and e.status = 'open'))::int,
         round(max(extract(epoch from now() - q.created_at) / 60)
               filter (where q.finished_at is null and q.started_at is null and e.status = 'open' and q.created_at >= k.midnight))::int,
         (count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open' and q.created_at < k.midnight and not visit_in_bed(e.id)))::int
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  cross join k
  where q.deleted_at is null and (p_stations is null or q.station = any (p_stations))
    and ((q.finished_at is null and e.status = 'open') or q.created_at >= k.midnight)
  group by q.station
$$;

-- my_summary (from 20270108090000_profession_manager): 0197 — a patient in a bed is not "from
-- earlier days" (each row says 'in_bed'). Everything else as before.
create or replace function my_summary(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_role role_key := current_role_key();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_len integer;
  v_start timestamptz;
  v_end timestamptz;
  v_pstart timestamptz;
  v_pend timestamptz;
  -- today's first instant (Kigali): a queue entry before it is from an earlier day
  v_midnight timestamptz := (v_today::timestamp) at time zone 'Africa/Kigali';
  v_station station := my_home_station();
  v_manager boolean := is_manager();
  -- money is the business of whoever takes payments (and the manager)
  v_money boolean := has_perm('payment.take') or is_manager();
  -- the cash desk has no business with clinical kinds
  v_kinds text[] := case when v_role = 'cashier'
                         then array['registered', 'charges', 'payments', 'refunds', 'voided', 'handovers']
                         else null end;
  v_waiting jsonb;
  v_counts jsonb;
  v_work jsonb;
  v_prev jsonb;
  v_money_j jsonb := null;
begin
  if v_role is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  v_len := v_to - v_from + 1;
  v_start := (v_from::timestamp) at time zone 'Africa/Kigali';
  v_end := ((v_to + 1)::timestamp) at time zone 'Africa/Kigali';
  v_pstart := ((v_from - v_len)::timestamp) at time zone 'Africa/Kigali';
  v_pend := v_start;

  -- WAITING FOR ME: by name first (assigned to me, handed over to me and not answered yet), then
  -- my desks' queue (nobody named: the sections I serve, or the desk my profile names; a patient
  -- sent to a department only for its members), plus the patients I took and have not finished.
  -- The manager's queue: the desks of their departments, like anyone (0128).
  -- Today's first; what joined the queue on an earlier day and is still open comes last, marked
  -- 'earlier' (shown apart: "From earlier days").
  select coalesce(jsonb_agg(to_jsonb(b) || jsonb_build_object('by_name', x.by_name, 'earlier', x.earlier, 'in_bed', x.in_bed)
                            order by x.earlier, x.by_name desc, (b.started_at is not null) desc, b.priority, b.queued_at),
                  '[]'::jsonb)
  into v_waiting
  from queue_board b
  cross join lateral (
    select coalesce(b.assigned_to = v_me, false)
           or coalesce(b.handover_status = 'pending' and b.handover_to = v_me, false) as by_name,
           b.queued_at < v_midnight and not visit_in_bed(b.encounter_id) as earlier,
           visit_in_bed(b.encounter_id) as in_bed
  ) x
  where b.finished_at is null
    and (
      x.by_name
      or coalesce(b.taken_by = v_me, false)
      or (b.assigned_to is null and b.taken_by is null
          and (serves_station(v_me, b.station, b.service)
               or b.station = v_station)
          and (b.department_id is null
               or exists (select 1 from profiles me where me.id = v_me and me.department_id = b.department_id)
               or exists (select 1 from staff_department sd
                          where sd.profile_id = v_me and sd.department_id = b.department_id)))
    );

  -- today's counts; the rows from an earlier day apart
  select jsonb_build_object(
    'sentToMe', count(*) filter (where not (r ->> 'earlier')::boolean
                                   and (r ->> 'by_name')::boolean and r ->> 'started_at' is null),
    'atMyDesks', count(*) filter (where not (r ->> 'earlier')::boolean
                                    and not (r ->> 'by_name')::boolean and r ->> 'started_at' is null),
    'inProgress', count(*) filter (where not (r ->> 'earlier')::boolean and r ->> 'started_at' is not null),
    'earlier', count(*) filter (where (r ->> 'earlier')::boolean)
  ) into v_counts
  from jsonb_array_elements(v_waiting) r;

  -- MY WORK: the kinds of "Who did what", mine only, this period and the one before.
  select coalesce(jsonb_object_agg(k.kind, k.n), '{}'::jsonb) into v_work
  from (select kind, count(*) as n
        from analytics_staff_events(v_start, v_end, v_money)
        where user_id = v_me and (v_kinds is null or kind = any (v_kinds))
        group by kind) k;
  select coalesce(jsonb_object_agg(k.kind, k.n), '{}'::jsonb) into v_prev
  from (select kind, count(*) as n
        from analytics_staff_events(v_pstart, v_pend, v_money)
        where user_id = v_me and (v_kinds is null or kind = any (v_kinds))
        group by kind) k;
  -- the visits I opened (reception's work; not a kind of Who did what)
  v_work := v_work || jsonb_build_object('visitsStarted',
    (select count(*) from encounter e where e.deleted_at is null and e.created_by = v_me
      and e.arrived_at >= v_start and e.arrived_at < v_end));
  v_prev := v_prev || jsonb_build_object('visitsStarted',
    (select count(*) from encounter e where e.deleted_at is null and e.created_by = v_me
      and e.arrived_at >= v_pstart and e.arrived_at < v_pend));

  -- MY MONEY: what I took, by method; what I gave back; the walk-in sales I handed over.
  if v_money then
    select jsonb_build_object(
      'payments', jsonb_build_object(
        'count', (select count(*) from payment y where y.deleted_at is null and y.cashier_id = v_me and y.paid_at >= v_start and y.paid_at < v_end),
        'amount', (select coalesce(sum(y.amount), 0) from payment y where y.deleted_at is null and y.cashier_id = v_me and y.paid_at >= v_start and y.paid_at < v_end),
        'prevAmount', (select coalesce(sum(y.amount), 0) from payment y where y.deleted_at is null and y.cashier_id = v_me and y.paid_at >= v_pstart and y.paid_at < v_pend),
        'prevCount', (select count(*) from payment y where y.deleted_at is null and y.cashier_id = v_me and y.paid_at >= v_pstart and y.paid_at < v_pend)),
      'byMethod', coalesce((
        select jsonb_agg(jsonb_build_object('method', m.method, 'amount', m.amount, 'count', m.n) order by m.amount desc)
        from (select y.method::text as method, sum(y.amount) as amount, count(*) as n from payment y
              where y.deleted_at is null and y.cashier_id = v_me and y.paid_at >= v_start and y.paid_at < v_end
              group by y.method) m), '[]'::jsonb),
      'refunds', jsonb_build_object(
        'count', (select count(*) from refund r where r.deleted_at is null and r.cashier_id = v_me and r.refunded_at >= v_start and r.refunded_at < v_end),
        'amount', (select coalesce(sum(r.amount), 0) from refund r where r.deleted_at is null and r.cashier_id = v_me and r.refunded_at >= v_start and r.refunded_at < v_end)),
      'sales', jsonb_build_object(
        'count', (select count(*) from counter_sale s where s.deleted_at is null and s.handed_over_by = v_me and s.handed_over_at >= v_start and s.handed_over_at < v_end),
        'total', (select coalesce(sum(s.total), 0) from counter_sale s where s.deleted_at is null and s.handed_over_by = v_me and s.handed_over_at >= v_start and s.handed_over_at < v_end))
    ) into v_money_j;
  end if;

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'role', v_role,
    'station', v_station,
    'desks', to_jsonb(my_desk_list()),
    'waiting', v_waiting,
    'counts', v_counts,
    'work', v_work,
    'workPrev', v_prev,
    'money', v_money_j
  );
end
$$;

-- nav_counts (from 20270108090000_profession_manager): 0197 — a patient in a bed is today's (not
-- "from earlier days"); + 'inBeds': the patients in a bed now, for "Patients in beds" (whoever
-- reads the beds). Everything else as before.
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
  -- all the nurses when I work at the nursing desk; given today, given earlier
  if has_perm('clinical.write') then
    select count(*) filter (where o.created_at >= v_start), count(*) filter (where o.created_at < v_start)
    into v_n, v_e
    from nurse_order o
    join encounter e on e.id = o.encounter_id and e.status = 'open' and e.deleted_at is null
    where o.deleted_at is null and o.status = 'open' and nurse_order_mine(o.assigned_to);
    if v_n + v_e > 0 or task_for_me('nurse') then
      v_out := v_out || jsonb_build_object('nurseOrders', v_n, 'nurseOrdersEarlier', v_e);
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

-- dashboard_summary (from 20261203090000_guide_fixes): 0197 — a patient in a bed is not counted
-- as forgotten. Everything else as before.
create or replace function dashboard_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := is_manager();
  -- a head or assistant: the people of the departments they lead (null: the manager, everyone)
  v_members uuid[];
  v_days integer := greatest(1, p_to - p_from + 1);
  v_prev_from date := p_from - v_days;
  v_prev_to date := p_from - 1;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_midnight timestamptz := ((now() at time zone 'Africa/Kigali')::date)::timestamp at time zone 'Africa/Kigali';
  v_tiles jsonb;
  v_rev30 jsonb;
  v_rev_period jsonb;
  v_collections jsonb;
  v_receivables jsonb;
  v_visits jsonb;
  v_wait jsonb;
  v_top jsonb;
  v_staff jsonb;
  v_reorder jsonb;
  v_expiring jsonb;
  v_noshow jsonb;
  v_messages jsonb;
  v_claims jsonb;
  v_logins jsonb;
  v_services jsonb;
begin
  if not (v_manager or exists (select 1 from profiles where id = auth.uid() and active and dashboard is not null)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not v_manager then
    select coalesce(array_agg(distinct m.profile_id), '{}') into v_members
    from staff_department m
    join staff_department h on h.department_id = m.department_id
    join department d on d.id = m.department_id and d.deleted_at is null
    where h.profile_id = auth.uid() and h.position in ('head', 'assistant');
  end if;

  -- headline tiles
  select jsonb_build_object(
    'registered', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'registeredPrev', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'visits', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'visitsPrev', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    -- patients who joined a queue today and are not taken yet (one patient sent to several desks counts once)
    'waitingNow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
                   where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'
                     and q.created_at >= v_midnight),
    -- still open from an earlier day: forgotten in a queue (please close)
    'forgottenNow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
                     where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'
                       and q.created_at < v_midnight and not visit_in_bed(e.id)),
    'revenue', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to) end,
    'revenuePrev', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to) end,
    'refunded', case when v_manager then (select coalesce(sum(amount), 0) from refund where deleted_at is null and (refunded_at at time zone 'Africa/Kigali')::date between p_from and p_to) end,
    'openBills', case when v_manager then (select count(*) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'openBillsDue', case when v_manager then (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'debts', case when v_manager then (select count(*) from invoice i join encounter e on e.id = i.encounter_id
                                       where i.deleted_at is null and e.status <> 'open' and invoice_balance(i.id) > 0) end,
    'debtsDue', case when v_manager then (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id
                                          where i.deleted_at is null and e.status <> 'open' and invoice_balance(i.id) > 0) end,
    'bedsOccupied', (select count(*) from bed where deleted_at is null and status = 'occupied'),
    'bedsTotal', (select count(*) from bed where deleted_at is null and status <> 'out_of_service')
  ) into v_tiles;

  -- revenue per day, last 30 days ending today: collected, refunded and net
  select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'amount', coalesce(s.amount, 0),
                                               'refunds', coalesce(r.amount, 0),
                                               'net', coalesce(s.amount, 0) - coalesce(r.amount, 0)) order by d), '[]'::jsonb) into v_rev30
  from generate_series(v_today - 29, v_today, interval '1 day') d
  left join (
    select (paid_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
    from payment where deleted_at is null and paid_at >= (v_today - 29)::timestamp at time zone 'Africa/Kigali'
    group by 1
  ) s on s.day = d::date
  left join (
    select (refunded_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
    from refund where deleted_at is null and refunded_at >= (v_today - 29)::timestamp at time zone 'Africa/Kigali'
    group by 1
  ) r on r.day = d::date;

  -- the same for the chosen period (up to 92 days; longer: see Analytics)
  if v_days <= 92 then
    select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'amount', coalesce(s.amount, 0),
                                                 'refunds', coalesce(r.amount, 0),
                                                 'net', coalesce(s.amount, 0) - coalesce(r.amount, 0)) order by d), '[]'::jsonb)
    into v_rev_period
    from generate_series(p_from, p_to, interval '1 day') d
    left join (
      select (paid_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
      from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to
      group by 1
    ) s on s.day = d::date
    left join (
      select (refunded_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
      from refund where deleted_at is null and (refunded_at at time zone 'Africa/Kigali')::date between p_from and p_to
      group by 1
    ) r on r.day = d::date;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('method', m, 'amount', coalesce(s.amount, 0)) order by s.amount desc nulls last), '[]'::jsonb) into v_collections
  from unnest(array['cash', 'momo', 'airtel', 'card', 'bank']::payment_method[]) m
  left join (
    select method, sum(amount) as amount from payment
    where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by method
  ) s on s.method = m;

  select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'count', c.n, 'amount', c.amount) order by c.amount desc), '[]'::jsonb) into v_receivables
  from (
    select payer_id, count(*) as n, sum(amount) as amount from claim
    where deleted_at is null and status in ('open', 'batched', 'submitted', 'rejected', 'resubmitted')
    group by payer_id
  ) c join payer py on py.id = c.payer_id;

  -- visits by service group (charged lines in the range)
  select coalesce(jsonb_agg(jsonb_build_object('group', g.grp, 'categoryId', g.cat_id, 'name', g.name, 'nameKin', g.kin,
                                                'nameFr', g.fr, 'count', g.n) order by g.n desc), '[]'::jsonb) into v_visits
  from (
    -- by the clinic's own categories; medicines (no service) count as pharmacy
    select coalesce(c.base_group::text, case when s.id is null then 'pharmacy' else 'other' end) as grp,
           c.id as cat_id, c.name_en as name, c.name_kin as kin, c.name_fr as fr, count(distinct i.encounter_id) as n
    from invoice_line l
    join invoice i on i.id = l.invoice_id
    left join service s on s.id = l.service_id
    left join service_category c on c.id = s.category_id
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by c.id, 1, 3, 4, 5
  ) g;

  -- the queues right now (no average: see Analytics → Waiting times)
  select coalesce(jsonb_agg(jsonb_build_object('station', w.station, 'waiting', w.waiting, 'busy', w.busy,
                                               'longest', w.longest, 'forgotten', w.forgotten) order by w.station), '[]'::jsonb)
  into v_wait
  from queue_now(null) w;

  -- top treatments in the range
  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'count', x.n, 'amount', case when v_manager then x.amount end) order by x.n desc), '[]'::jsonb) into v_top
  from (
    select l.description as name, count(*) as n, sum(round(l.unit_price * l.quantity)) as amount
    from invoice_line l
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by l.description
    order by count(*) desc
    limit 10
  ) x;

  -- who did what (accountability): the same counts as Analytics → Who did what; a head sees the
  -- people of their own department only
  with ev as (
    select * from analytics_staff_events(p_from::timestamp at time zone 'Africa/Kigali',
                                         (p_to + 1)::timestamp at time zone 'Africa/Kigali', v_manager)
  ),
  a as (
    select ev.user_id,
           count(*) filter (where kind = 'registered') as registrations,
           count(*) filter (where kind = 'vitals') as vitals,
           count(*) filter (where kind = 'charges') as charges,
           count(*) filter (where kind = 'patientsSeen') as patients,
           count(*) filter (where kind = 'results') as results,
           count(*) filter (where kind = 'medicinesGiven') as dispensed,
           count(*) filter (where kind = 'payments') as payments,
           coalesce(sum(amount) filter (where kind = 'payments'), 0) as collected
    from ev group by ev.user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.full_name, 'role', p.role, 'staffId', p.staff_id,
      'active', p.active and p.deleted_at is null,
      'registrations', coalesce(a.registrations, 0), 'vitals', coalesce(a.vitals, 0), 'charges', coalesce(a.charges, 0),
      'patients', coalesce(a.patients, 0), 'results', coalesce(a.results, 0), 'dispensed', coalesce(a.dispensed, 0),
      'payments', case when v_manager then coalesce(a.payments, 0) end,
      'collected', case when v_manager then coalesce(a.collected, 0) end,
      'lastSignIn', p.last_sign_in_at
    ) order by (coalesce(a.registrations, 0) + coalesce(a.vitals, 0) + coalesce(a.charges, 0) + coalesce(a.payments, 0)
                + coalesce(a.patients, 0) + coalesce(a.results, 0) + coalesce(a.dispensed, 0)) desc, p.full_name), '[]'::jsonb) into v_staff
  from profiles p
  left join a on a.user_id = p.id
  where (v_members is null or p.id = any (v_members))
    and ((p.active and p.deleted_at is null)
         or (a.user_id is not null and (a.registrations + a.vitals + a.charges + a.patients + a.results + a.dispensed + a.payments) > 0));

  -- stock: the item's id and full name (with strength)
  select coalesce(jsonb_agg(jsonb_build_object('id', r.item_id, 'name', item_label(r.item_id), 'onHand', r.on_hand, 'min', r.reorder_level)
                            order by (r.on_hand::numeric / greatest(r.reorder_level, 1)), item_label(r.item_id)), '[]'::jsonb) into v_reorder
  from items_below_reorder r;

  select jsonb_build_object(
    'expired', count(distinct s.item_id) filter (where s.expiry < v_today),
    'd30', count(distinct s.item_id) filter (where s.expiry >= v_today and s.expiry <= v_today + 30),
    'd60', count(distinct s.item_id) filter (where s.expiry > v_today + 30 and s.expiry <= v_today + 60),
    'd90', count(distinct s.item_id) filter (where s.expiry > v_today + 60 and s.expiry <= v_today + 90)
  ) into v_expiring
  from (select item_id, batch_id, expiry, sum(quantity) as q from stock_on_hand where expiry is not null
        group by item_id, batch_id, expiry) s
  where s.q > 0;

  -- bookings
  select jsonb_build_object(
    'booked', count(*) filter (where status in ('confirmed', 'arrived', 'in_progress', 'completed', 'no_show')),
    'missed', count(*) filter (where status = 'no_show'),
    'pending', (select count(*) from appointment where deleted_at is null and status = 'inquiry')
  ) into v_noshow
  from appointment where deleted_at is null and (coalesce(starts_at, created_at) at time zone 'Africa/Kigali')::date between p_from and p_to;

  select coalesce(jsonb_agg(jsonb_build_object('channel', ch, 'sent', coalesce(s.sent, 0), 'failed', coalesce(s.failed, 0)) order by ch), '[]'::jsonb) into v_messages
  from unnest(array['whatsapp', 'sms', 'email']::message_channel[]) ch
  left join (
    select channel, count(*) filter (where status in ('sent', 'delivered')) as sent, count(*) filter (where status = 'failed') as failed
    from message where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by channel
  ) s on s.channel = ch;

  select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'count', c.n, 'amount', case when v_manager then c.amount end) order by c.amount desc), '[]'::jsonb) into v_claims
  from (select payer_id, count(*) as n, sum(amount) as amount from claim where deleted_at is null and status = 'open' group by payer_id) c
  join payer py on py.id = c.payer_id;

  -- sign-ins of the last 24 hours (a head: their department's people)
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'role', p.role, 'at', a.at, 'reason', a.reason) order by a.at desc), '[]'::jsonb) into v_logins
  from (select actor_id, at, reason from audit_event
        where action = 'login' and at > now() - interval '1 day'
          and (v_members is null or actor_id = any (v_members))
        order by at desc limit 12) a
  join profiles p on p.id = a.actor_id;

  select jsonb_build_object('active', count(*) filter (where active), 'total', count(*)) into v_services from service where deleted_at is null;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'manager', v_manager, 'generatedAt', now(),
    -- money for the manager only (heads of department see the activity, not the money)
    'tiles', v_tiles,
    'revenue30d', case when v_manager then v_rev30 else '[]'::jsonb end,
    'revenuePeriod', case when v_manager then v_rev_period end,
    'collections', case when v_manager then v_collections else '[]'::jsonb end,
    'receivables', case when v_manager then v_receivables else '[]'::jsonb end,
    'visitsByGroup', v_visits, 'waitByStation', v_wait, 'topTreatments', v_top, 'staff', v_staff,
    'reorder', v_reorder, 'expiring', v_expiring, 'bookings', v_noshow, 'messages', v_messages,
    'claims', v_claims, 'logins', v_logins, 'services', v_services
  );
end
$$;

-- department_summary (from 20261202090000_security_hardening): 0197 — a patient in a bed is not
-- counted as forgotten. Everything else as before.
create or replace function department_summary(p_department_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_dept department%rowtype;
  v_days integer := greatest(1, p_to - p_from + 1);
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_midnight timestamptz := ((now() at time zone 'Africa/Kigali')::date)::timestamp at time zone 'Africa/Kigali';
  v_stations station[];
  v_members jsonb;
  v_queue jsonb;
  v_tiles jsonb;
  v_services jsonb;
begin
  if not (is_manager() or exists (
    select 1 from staff_department sd join profiles p on p.id = sd.profile_id
    where sd.profile_id = auth.uid() and sd.department_id = p_department_id
      and sd.position in ('head', 'assistant') and p.active)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_dept from department where id = p_department_id and deleted_at is null;
  if not found then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(s), '{}') into v_stations
  from unnest(enum_range(null::station)) s
  where (cardinality(coalesce(v_dept.services, '{}')) > 0 and station_desks(s) && v_dept.services)
     or (cardinality(coalesce(v_dept.services, '{}')) = 0 and station_role(s) = any (v_dept.roles));

  -- the people of the department and what each did in the period
  with ev as (
    select ev.user_id, ev.kind
    from analytics_staff_events(p_from::timestamp at time zone 'Africa/Kigali',
                                (p_to + 1)::timestamp at time zone 'Africa/Kigali', false) ev
    where ev.user_id in (select sd.profile_id from staff_department sd where sd.department_id = p_department_id)
      and ev.kind in ('patientsSeen', 'registered', 'vitals', 'results', 'medicinesGiven', 'tasksDone')
  ),
  a as (
    select ev.user_id,
           count(*) filter (where kind = 'patientsSeen') as patients,
           count(*) filter (where kind = 'registered') as registrations,
           count(*) filter (where kind = 'vitals') as vitals,
           count(*) filter (where kind = 'results') as results,
           count(*) filter (where kind = 'medicinesGiven') as dispensed,
           count(*) filter (where kind = 'tasksDone') as tasks_done
    from ev group by ev.user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.full_name, 'role', p.role, 'position', sd.position, 'station', p.station,
      'lastSignIn', p.last_sign_in_at, 'active', p.active,
      'patients', coalesce(a.patients, 0),
      'registrations', coalesce(a.registrations, 0),
      'vitals', coalesce(a.vitals, 0),
      'results', coalesce(a.results, 0),
      'dispensed', coalesce(a.dispensed, 0),
      'payments', (select count(*) from payment y where y.deleted_at is null and y.cashier_id = p.id
                   and (y.paid_at at time zone 'Africa/Kigali')::date between p_from and p_to),
      'tasksDone', coalesce(a.tasks_done, 0),
      'busyNow', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                  where q.taken_by = p.id and q.deleted_at is null and q.finished_at is null and e.status = 'open')
    ) order by case sd.position when 'head' then 0 when 'assistant' then 1 else 2 end, p.full_name), '[]'::jsonb)
  into v_members
  from staff_department sd join profiles p on p.id = sd.profile_id
  left join a on a.user_id = p.id
  where sd.department_id = p_department_id;

  -- the department's desks right now
  select coalesce(jsonb_agg(jsonb_build_object('station', w.station, 'waiting', w.waiting, 'busy', w.busy,
                                               'longest', w.longest, 'forgotten', w.forgotten) order by w.station), '[]'::jsonb)
  into v_queue
  from queue_now(v_stations) w;

  select jsonb_build_object(
    'patients', (select count(distinct q.encounter_id) from queue_entry q
                 where q.deleted_at is null and q.station = any (v_stations) and q.finished_at is not null
                   and (q.finished_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'patientsPrev', (select count(distinct q.encounter_id) from queue_entry q
                     where q.deleted_at is null and q.station = any (v_stations) and q.finished_at is not null
                       and (q.finished_at at time zone 'Africa/Kigali')::date between p_from - v_days and p_from - 1),
    'waitingNow', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                   where q.deleted_at is null and q.station = any (v_stations) and q.finished_at is null
                     and q.started_at is null and e.status = 'open' and q.created_at >= v_midnight),
    'forgottenNow', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                     where q.deleted_at is null and q.station = any (v_stations) and q.finished_at is null
                       and q.started_at is null and e.status = 'open' and q.created_at < v_midnight
                       and not visit_in_bed(e.id)),
    'ordersOpen', (select count(*) from service_request r join encounter e on e.id = r.encounter_id
                   where r.deleted_at is null and e.status = 'open'
                     and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) = any (v_stations)
                     and r.status not in ('resulted', 'verified', 'cancelled')),
    'ordersNotDone', (select count(*) from service_request r
                      where r.deleted_at is null and r.status = 'cancelled'
                        and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) = any (v_stations)
                        and (r.updated_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'tasksOpen', (select count(*) from internal_task k join encounter e on e.id = k.encounter_id
                  where k.deleted_at is null and k.done_at is null and e.status = 'open'
                    and k.assigned_role = any (v_dept.roles)),
    'members', jsonb_array_length(v_members),
    'signedInToday', (select count(*) from staff_department sd join profiles p on p.id = sd.profile_id
                      where sd.department_id = p_department_id
                        and (p.last_sign_in_at at time zone 'Africa/Kigali')::date = v_today)
  ) into v_tiles;

  -- the department's treatments done in the period (count only)
  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'count', x.n) order by x.n desc), '[]'::jsonb) into v_services
  from (
    select l.description as name, count(*) as n
    from invoice_line l
    join service_department sv on sv.service_id = l.service_id and sv.department_id = p_department_id
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by l.description order by count(*) desc limit 10
  ) x;

  return jsonb_build_object('department', jsonb_build_object('id', v_dept.id, 'name', v_dept.name, 'roles', v_dept.roles),
                            'stations', to_jsonb(v_stations), 'tiles', v_tiles, 'members', v_members,
                            'queue', v_queue, 'services', v_services);
end
$$;

-- bed_board (from 20261021120000_beds_pricing): 0197 — + for a patient in a bed: the stay, the file,
-- the days on the bill, the days expected, why, who gave the bed, the visit's doctor, the amount of
-- the bed days and what the patient still owes on the bill; the cashier (payments) reads it too.
-- 'since' is the first moment of this visit in a bed (a move keeps it).
create or replace function bed_board()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'state', b.status,
      'nightlyPrice', b.nightly_price,
      'encounterId', s.encounter_id,
      'patient', case when s.id is not null then p.surname || ' ' || p.given_names end,
      'since', case when s.id is not null
                    then coalesce((select min(x.admitted_at) from bed_stay x
                                   where x.encounter_id = s.encounter_id and x.deleted_at is null and x.by_day
                                     and exists (select 1 from bed_day d where d.stay_id = x.id)),
                                  s.admitted_at) end,
      'nights', s.planned_nights,
      'until', s.planned_until,
      'stayId', s.id,
      'patientId', p.id,
      'fileNumber', p.file_number,
      'byDay', s.by_day,
      'days', case when s.id is not null then (select count(*) from bed_day d where d.encounter_id = s.encounter_id) end,
      'expectedDays', s.expected_days,
      'reason', s.reason,
      'givenBy', (select full_name from profiles where id = s.given_by),
      'doctor', case when s.id is not null then coalesce(
                  (select pr.full_name from queue_entry q join profiles pr on pr.id = q.taken_by
                   where q.encounter_id = s.encounter_id and q.deleted_at is null
                     and q.station in ('consultation', 'dental', 'theatre')
                   order by q.started_at desc nulls last limit 1),
                  (select full_name from profiles where id = s.given_by and is_doctor(id))) end,
      'amount', case when s.id is not null then
                  (select coalesce(sum(round(l.unit_price * l.quantity)), 0)
                   from invoice_line l join invoice i on i.id = l.invoice_id
                   where i.encounter_id = s.encounter_id and l.deleted_at is null and l.source_type = 'bed_stay') end,
      'owed', case when s.id is not null then
                (select invoice_balance(i.id) from invoice i where i.encounter_id = s.encounter_id limit 1) end
    ) order by b.sort_order, b.name), '[]'::jsonb)
  from bed b
  left join bed_stay s on s.bed_id = b.id and s.discharged_at is null and s.deleted_at is null
  left join encounter e on e.id = s.encounter_id
  left join patient p on p.id = e.patient_id
  where b.deleted_at is null
    and (has_perm('queue.read') or has_perm('billing.write') or has_perm('payment.take'))
$$;

-- ---------------------------------------------------------------- 7 who stayed
-- The visits with bed days in the period (by day, since 0197): the patient, the beds, the first
-- moment in a bed and the end (null: still in a bed), the days on the bill and their amount, who
-- gave the bed. For the "Patients in beds" page (the same readers as the board).
create or replace function report_bed_stays(p_from date, p_to date)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with v as (
    select s.encounter_id,
           min(s.admitted_at) as since,
           case when bool_or(s.discharged_at is null) then null else max(s.discharged_at) end as until,
           string_agg(distinct b.name, ', ') as beds,
           (array_agg(s.given_by order by s.admitted_at))[1] as given_by
    from bed_stay s
    join bed b on b.id = s.bed_id
    where s.deleted_at is null and s.by_day
    group by s.encounter_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'encounterId', v.encounter_id,
      'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names,
      'fileNumber', p.file_number,
      'beds', v.beds,
      'since', v.since,
      'until', v.until,
      'days', (select count(*) from bed_day d where d.encounter_id = v.encounter_id),
      'amount', (select coalesce(sum(round(l.unit_price * l.quantity)), 0)
                 from invoice_line l join invoice i on i.id = l.invoice_id
                 where i.encounter_id = v.encounter_id and l.deleted_at is null and l.source_type = 'bed_stay'),
      'givenBy', (select full_name from profiles where id = v.given_by)
    ) order by v.since desc), '[]'::jsonb)
  from v
  join encounter e on e.id = v.encounter_id
  join patient p on p.id = e.patient_id
  where (has_perm('queue.read') or has_perm('billing.write') or has_perm('payment.take'))
    and kigali_day(v.since) <= p_to
    and (v.until is null or kigali_day(v.until) >= p_from)
$$;

-- ---------------------------------------------------------------- rights
revoke all on function kigali_day(timestamptz), visit_in_bed(uuid), assert_bed_rights(uuid),
  bill_bed_day(uuid, date), bill_bed_days_of(uuid), bed_stay_summary(uuid), bed_notice(uuid, text, text)
  from public, anon, authenticated;
revoke all on function bed_days_catch_up(uuid), keep_in_bed(uuid, uuid, integer, text),
  move_to_bed(uuid, uuid, text), set_bed_days(uuid, integer), end_bed_stay(uuid, text),
  report_bed_stays(date, date)
  from public, anon;
grant execute on function bed_days_catch_up(uuid), keep_in_bed(uuid, uuid, integer, text),
  move_to_bed(uuid, uuid, text), set_bed_days(uuid, integer), end_bed_stay(uuid, text),
  report_bed_stays(date, date)
  to authenticated;
