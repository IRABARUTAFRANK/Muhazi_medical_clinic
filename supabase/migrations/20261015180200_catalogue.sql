-- Muhazi Medical Clinic System — 0003 catalogue and pricing
-- service (preset treatments), item (medicines and products), price lists per payer,
-- practitioners with calendars, and the price-resolution function used by every charge.
-- Source: doc §4.1 (three ways a price enters the bill), §5.2 (calendars), §10.2.

create table service (
  like mmc_base including all,
  code text not null unique,
  name_en text not null,
  name_kin text,
  name_fr text,
  service_group service_group not null,
  tax_type tax_type not null default 'exempt',
  hmis_mapping text,
  allow_manual_price boolean not null default false,
  default_duration_min integer,
  active boolean not null default true
);

create table item (
  like mmc_base including all,
  code text not null unique,
  name_generic text not null,
  name_brand text,
  strength text,
  form text,
  unit text,
  pack_size integer,
  selling_unit text,
  controlled boolean not null default false,
  reorder_level integer not null default 0,
  max_level integer,
  rwanda_fda_reg text,
  active boolean not null default true
);

-- A price list belongs to one payer; payer_id null = cash price list.
create table price_list (
  like mmc_base including all,
  payer_id uuid references payer (id),
  name text not null,
  effective_from date not null default current_date,
  effective_to date,
  check (effective_to is null or effective_to >= effective_from)
);
create index price_list_payer_idx on price_list (payer_id, effective_from desc);

create table price_list_item (
  like mmc_base including all,
  price_list_id uuid not null references price_list (id) on delete cascade,
  service_id uuid references service (id),
  item_id uuid references item (id),
  price numeric(12, 0) not null check (price >= 0),
  check ((service_id is null) <> (item_id is null))
);
create unique index price_list_item_service_uq on price_list_item (price_list_id, service_id)
  where service_id is not null;
create unique index price_list_item_item_uq on price_list_item (price_list_id, item_id)
  where item_id is not null;

create table practitioner (
  like mmc_base including all,
  code text unique,
  user_id uuid references profiles (id),
  names text not null,
  title text,
  specialty text,
  licence_number text,
  signature_blob_id uuid,
  slot_minutes integer not null default 60 check (slot_minutes between 5 and 240),
  working_hours jsonb not null default '{}'::jsonb,
  rooms jsonb not null default '[]'::jsonb,
  categories text[] not null default '{}',
  languages text,
  active boolean not null default true
);
comment on column practitioner.working_hours is
  'JS weekday keys (0 = Sunday) to [["HH:MM","HH:MM"], …], e.g. {"1":[["08:00","17:00"]]}.';

select install_common_triggers('service');
select install_common_triggers('item');
select install_common_triggers('price_list');
select install_common_triggers('price_list_item');
select install_common_triggers('practitioner');

-- Price lookup: latest effective list of the payer, else the cash list (flagged as fallback).
create or replace function price_for(
  p_service_id uuid,
  p_item_id uuid,
  p_payer_id uuid,
  p_at date default current_date
)
returns table (price numeric, list_payer_id uuid, fallback boolean)
language plpgsql stable
as $$
begin
  if p_payer_id is not null then
    return query
      select pli.price, pl.payer_id, false
      from price_list pl
      join price_list_item pli on pli.price_list_id = pl.id
      where pl.payer_id = p_payer_id
        and pl.deleted_at is null and pli.deleted_at is null
        and pl.effective_from <= p_at and (pl.effective_to is null or pl.effective_to >= p_at)
        and ((p_service_id is not null and pli.service_id = p_service_id)
          or (p_item_id is not null and pli.item_id = p_item_id))
      order by pl.effective_from desc
      limit 1;
    if found then
      return;
    end if;
  end if;
  return query
    select pli.price, null::uuid, (p_payer_id is not null)
    from price_list pl
    join price_list_item pli on pli.price_list_id = pl.id
    where pl.payer_id is null
      and pl.deleted_at is null and pli.deleted_at is null
      and pl.effective_from <= p_at and (pl.effective_to is null or pl.effective_to >= p_at)
      and ((p_service_id is not null and pli.service_id = p_service_id)
        or (p_item_id is not null and pli.item_id = p_item_id))
    order by pl.effective_from desc
    limit 1;
end
$$;

-- Coverage percentage for a plan and service group (per-group override, else the plan default).
create or replace function coverage_pct_for(p_plan_id uuid, p_group service_group)
returns numeric
language sql stable
as $$
  select coalesce((p.pct_by_group ->> p_group::text)::numeric, p.coverage_pct, 0)
  from plan p
  where p.id = p_plan_id
$$;

-- Is the practitioner working at this moment (working_hours in local clinic time)?
create or replace function practitioner_is_working(p_practitioner_id uuid, p_at timestamptz)
returns boolean
language plpgsql stable
as $$
declare
  v_hours jsonb;
  v_day text;
  v_span jsonb;
  v_time time;
begin
  select working_hours into v_hours from practitioner where id = p_practitioner_id and active and deleted_at is null;
  if v_hours is null then
    return false;
  end if;
  v_day := extract(dow from p_at at time zone 'Africa/Kigali')::int::text;
  v_time := (p_at at time zone 'Africa/Kigali')::time;
  for v_span in select * from jsonb_array_elements(coalesce(v_hours -> v_day, '[]'::jsonb)) loop
    if v_time >= (v_span ->> 0)::time and v_time < (v_span ->> 1)::time then
      return true;
    end if;
  end loop;
  return false;
end
$$;

-- Public, anonymous read for the booking page: no contact details, no licence numbers.
create view public_practitioners as
  select id, code, names, title, specialty, categories, languages, working_hours, slot_minutes
  from practitioner
  where active and deleted_at is null;
