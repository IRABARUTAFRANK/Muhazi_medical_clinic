-- Muhazi Medical Clinic System — 0009 public read surface
-- What the anonymous public site may read so that the landing and booking pages show live data:
-- service lines with real "from" prices, accepted insurers, clinic profile and hours, and an
-- aggregate "clinic now" status. No patient data, no staff contact details.

-- Each preset service maps to one public booking category (null = internal only).
alter table service add column booking_category text
  check (booking_category in ('consultation', 'dental', 'laboratory', 'ultrasound', 'nursing', 'surgery', 'fp', 'hiv', 'circ'));
create index service_booking_category_idx on service (booking_category) where booking_category is not null;

-- Cheapest cash price per category today ("From RWF 8,000"); free services flagged.
create view public_service_lines as
  select
    s.booking_category as category,
    min(case when pli.price > 0 then pli.price end)::numeric(12, 0) as price_from,
    bool_or(pli.price = 0) as has_free,
    count(*)::integer as services
  from service s
  join price_list pl
    on pl.payer_id is null and pl.deleted_at is null
   and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
  join price_list_item pli
    on pli.price_list_id = pl.id and pli.service_id = s.id and pli.deleted_at is null
  where s.active and s.deleted_at is null and s.booking_category is not null
  group by s.booking_category;

create view public_payers as
  select code, name, type
  from payer
  where active and deleted_at is null and type <> 'cash'
  order by name;

-- Clinic profile (name, address, phone, email) and opening hours from settings.
create or replace function public_clinic_info()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'profile', coalesce((select value from setting where key = 'clinic.profile'), '{}'::jsonb),
    'hours', coalesce((select value from setting where key = 'clinic.hours'), '{}'::jsonb)
  )
$$;

-- Aggregate "clinic now": people waiting, average wait today, open/closed. Never a name.
create or replace function public_clinic_status()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_local timestamp := now() at time zone 'Africa/Kigali';
  v_hours jsonb := coalesce((select value -> 'days' from setting where key = 'clinic.hours'), '{}'::jsonb);
  v_span jsonb := v_hours -> extract(dow from v_local)::int::text;
  v_waiting integer;
  v_avg numeric;
  v_open boolean := false;
begin
  select count(*) into v_waiting
  from queue_entry
  where finished_at is null and deleted_at is null
    and (created_at at time zone 'Africa/Kigali')::date = v_local::date;
  select round(avg(extract(epoch from (called_at - created_at)) / 60)) into v_avg
  from queue_entry
  where called_at is not null and deleted_at is null
    and (created_at at time zone 'Africa/Kigali')::date = v_local::date;
  if v_span is not null and jsonb_array_length(v_span) = 2 then
    v_open := v_local::time >= (v_span ->> 0)::time and v_local::time < (v_span ->> 1)::time;
  end if;
  return jsonb_build_object(
    'waiting', coalesce(v_waiting, 0),
    'avg_wait_min', coalesce(v_avg, 0),
    'open', v_open,
    'opens_at', v_span ->> 0,
    'closes_at', v_span ->> 1,
    'as_of', now()
  );
end
$$;

grant select on public_service_lines, public_payers to anon, authenticated;
grant execute on function public_clinic_info(), public_clinic_status() to anon, authenticated;
