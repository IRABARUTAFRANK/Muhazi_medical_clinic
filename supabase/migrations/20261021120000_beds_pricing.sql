-- 0028 — Beds: how many, the price of a night, and priced stays.
-- The manager decides how many beds the clinic has and what one night costs (one price for all,
-- or per bed). When a nurse or doctor puts a patient in a bed they say for how many nights; the
-- stay goes on the patient's bill at once: nights × the bed's price, or a price agreed for that
-- period (typed, with the reason recorded). "Extend" adds more nights the same way.

alter table bed add column if not exists nightly_price numeric(12, 0) not null default 0
  check (nightly_price >= 0);

alter table bed_stay add column if not exists planned_nights integer
  check (planned_nights is null or planned_nights between 1 and 365);
alter table bed_stay add column if not exists planned_until timestamptz;
alter table bed_stay add column if not exists nightly_price numeric(12, 0);
alter table bed_stay add column if not exists period_price numeric(12, 0);

-- The catalogue line a bed stay is billed under (price typed per stay, so allow_manual_price).
insert into service (code, name_en, name_kin, name_fr, service_group, allow_manual_price)
values ('BED-STAY', 'Bed stay', 'Kurara ku buriri', 'Séjour au lit', 'bed', true)
on conflict (code) do update set allow_manual_price = true, active = true;

-- ---------------------------------------------------------------- manager: beds and prices

-- Sets the number of beds: adds "Bed n" up to p_count, or removes free beds from the end.
-- p_nightly_price (optional) becomes the price of every bed.
create or replace function set_bed_count(p_count integer, p_nightly_price numeric default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_have integer;
  v_next integer;
  v_bed record;
begin
  if not is_manager() then
    raise exception 'only the manager can change the beds' using errcode = '42501';
  end if;
  if p_count is null or p_count < 0 or p_count > 200 then
    raise exception 'the number of beds must be between 0 and 200' using errcode = '22023';
  end if;
  if p_nightly_price is not null and p_nightly_price < 0 then
    raise exception 'the price of a night cannot be negative' using errcode = '22023';
  end if;
  select count(*) into v_have from bed where deleted_at is null;
  -- Fewer beds: remove the last ones, never an occupied bed.
  for v_bed in
    select id, status from bed where deleted_at is null
    order by sort_order desc, name desc limit greatest(v_have - p_count, 0)
  loop
    if v_bed.status = 'occupied' then
      raise exception 'a bed that would be removed is occupied; discharge the patient first'
        using errcode = '23514';
    end if;
    update bed set deleted_at = now(), name = name || ' · removed ' || left(id::text, 8)
    where id = v_bed.id;
  end loop;
  -- More beds: "Bed n" with the next free number.
  while (select count(*) from bed where deleted_at is null) < p_count loop
    select coalesce(max(sort_order), 0) + 1 into v_next from bed where deleted_at is null;
    while exists (select 1 from bed where name = 'Bed ' || v_next) loop
      v_next := v_next + 1;
    end loop;
    insert into bed (name, sort_order, nightly_price)
    values ('Bed ' || v_next, v_next, coalesce(p_nightly_price, 0));
  end loop;
  if p_nightly_price is not null then
    update bed set nightly_price = p_nightly_price where deleted_at is null;
  end if;
  return jsonb_build_object(
    'beds', (select count(*) from bed where deleted_at is null),
    'occupied', (select count(*) from bed where deleted_at is null and status = 'occupied')
  );
end
$$;

-- Renames one bed and/or sets its own price of a night.
create or replace function save_bed(p_id uuid, p_name text, p_nightly_price numeric)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_manager() then
    raise exception 'only the manager can change the beds' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'a bed needs a name' using errcode = '22023';
  end if;
  if p_nightly_price is null or p_nightly_price < 0 then
    raise exception 'the price of a night cannot be negative' using errcode = '22023';
  end if;
  if exists (select 1 from bed where lower(name) = lower(trim(p_name)) and id <> p_id) then
    raise exception 'another bed already has this name' using errcode = '23505';
  end if;
  update bed set name = trim(p_name), nightly_price = p_nightly_price
  where id = p_id and deleted_at is null;
  if not found then
    raise exception 'bed not found' using errcode = 'P0002';
  end if;
end
$$;

create or replace function remove_bed(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_manager() then
    raise exception 'only the manager can change the beds' using errcode = '42501';
  end if;
  if exists (select 1 from bed where id = p_id and status = 'occupied') then
    raise exception 'this bed is occupied; discharge the patient first' using errcode = '23514';
  end if;
  update bed set deleted_at = now(), name = name || ' · removed ' || left(id::text, 8)
  where id = p_id and deleted_at is null;
  if not found then
    raise exception 'bed not found' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------- staff: priced stays

-- Bills p_nights on the visit: nights × the bed's price, or p_period_price agreed for the period.
create or replace function bill_bed_nights(
  p_stay_id uuid,
  p_nights integer,
  p_period_price numeric
)
returns numeric
language plpgsql security definer set search_path = public
as $$
declare
  v_stay bed_stay%rowtype;
  v_bed bed%rowtype;
  v_service uuid;
  v_total numeric;
  v_line uuid;
  v_agreed boolean := p_period_price is not null;
begin
  select * into v_stay from bed_stay where id = p_stay_id;
  select * into v_bed from bed where id = v_stay.bed_id;
  select id into v_service from service where code = 'BED-STAY';
  if p_nights is null or p_nights < 1 or p_nights > 365 then
    raise exception 'the number of nights must be between 1 and 365' using errcode = '22023';
  end if;
  if v_agreed and p_period_price < 0 then
    raise exception 'the price cannot be negative' using errcode = '22023';
  end if;
  v_total := case when v_agreed then p_period_price else v_bed.nightly_price * p_nights end;
  if v_total > 0 then
    v_line := add_charge(
      p_encounter_id => v_stay.encounter_id,
      p_office => 'beds',
      p_service_id => v_service,
      p_quantity => 1,
      p_manual_price => v_total,
      p_manual_reason => case when v_agreed then 'price agreed for the period'
                              else p_nights || ' × ' || v_bed.nightly_price end,
      p_source_type => 'bed_stay',
      p_source_id => p_stay_id
    );
    update invoice_line
    set description = 'Bed stay · ' || v_bed.name || ' · ' || p_nights
                      || case when p_nights = 1 then ' night' else ' nights' end
    where id = v_line;
  end if;
  return v_total;
end
$$;

drop function if exists admit_to_bed(uuid, uuid);
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
  v_stay uuid;
  v_total numeric;
  v_price numeric;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if exists (select 1 from bed_stay where encounter_id = p_encounter_id and discharged_at is null and deleted_at is null) then
    raise exception 'this patient is already in a bed' using errcode = '23505';
  end if;
  update bed set status = 'occupied' where id = p_bed_id and status = 'free' and deleted_at is null
  returning nightly_price into v_price;
  if not found then
    raise exception 'this bed is not free' using errcode = 'P0002';
  end if;
  insert into bed_stay (encounter_id, bed_id, charge_mode, planned_nights, planned_until,
                        nightly_price, period_price)
  values (p_encounter_id, p_bed_id, 'day', p_nights, now() + make_interval(days => p_nights),
          v_price, p_period_price)
  returning id into v_stay;
  v_total := bill_bed_nights(v_stay, p_nights, p_period_price);
  return jsonb_build_object('stayId', v_stay, 'nights', p_nights, 'total', v_total);
end
$$;

-- More nights for the patient in this bed, billed the same way.
create or replace function extend_bed_stay(
  p_bed_id uuid,
  p_nights integer,
  p_period_price numeric default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_stay bed_stay%rowtype;
  v_total numeric;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_stay from bed_stay
  where bed_id = p_bed_id and discharged_at is null and deleted_at is null;
  if not found then
    raise exception 'nobody is in this bed' using errcode = 'P0002';
  end if;
  v_total := bill_bed_nights(v_stay.id, p_nights, p_period_price);
  update bed_stay
  set planned_nights = coalesce(planned_nights, 0) + p_nights,
      planned_until = coalesce(planned_until, now()) + make_interval(days => p_nights),
      period_price = case when p_period_price is null then period_price
                          else coalesce(period_price, 0) + p_period_price end
  where id = v_stay.id;
  return jsonb_build_object('nights', p_nights, 'total', v_total);
end
$$;

-- Beds with ids, price and the stay's period, for the board's actions and the manager.
create or replace function bed_board()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'state', b.status,
      'nightlyPrice', b.nightly_price,
      'encounterId', s.encounter_id,
      'patient', case when s.id is not null then p.surname || ' ' || p.given_names end,
      'since', s.admitted_at,
      'nights', s.planned_nights,
      'until', s.planned_until
    ) order by b.sort_order, b.name), '[]'::jsonb)
  from bed b
  left join bed_stay s on s.bed_id = b.id and s.discharged_at is null and s.deleted_at is null
  left join encounter e on e.id = s.encounter_id
  left join patient p on p.id = e.patient_id
  where b.deleted_at is null and has_perm('queue.read')
$$;

grant execute on function set_bed_count(integer, numeric), save_bed(uuid, text, numeric),
  remove_bed(uuid), admit_to_bed(uuid, uuid, integer, numeric),
  extend_bed_stay(uuid, integer, numeric), bed_board() to authenticated;
revoke execute on function set_bed_count(integer, numeric), save_bed(uuid, text, numeric),
  remove_bed(uuid), admit_to_bed(uuid, uuid, integer, numeric),
  extend_bed_stay(uuid, integer, numeric), bed_board(), bill_bed_nights(uuid, integer, numeric)
  from anon, public;
