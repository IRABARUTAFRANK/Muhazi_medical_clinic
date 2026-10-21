-- 0049 · The clinic manages its own treatment categories.
--
-- Before: every treatment had one of ten fixed groups built into the code; a clinic could not
-- add one. Now the manager creates, renames and deletes categories (Prices → Categories). Each
-- category has a *kind* that tells the system how its treatments behave:
--   treatment — charged on the visit;
--   lab       — orderable test, goes to the Laboratory, has a result;
--   imaging   — orderable test, goes to Ultrasound, has a result;
--   bed       — bed stays (built in, cannot be changed or deleted).
-- The ten former groups become the first categories (renamable). service.service_group stays as
-- an internal field derived from the category, so tests, beds, insurers and older functions keep
-- working unchanged; a trigger keeps the two in step.

create type category_kind as enum ('treatment', 'lab', 'imaging', 'bed');

create table if not exists service_category (
  id uuid primary key default gen_random_uuid(),
  name_en text not null,
  name_kin text,
  name_fr text,
  kind category_kind not null default 'treatment',
  -- the former fixed group this category started as (null for the clinic's own)
  base_group service_group,
  sort integer not null default 100,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  deleted_at timestamptz
);
create unique index if not exists service_category_name_idx on service_category (lower(name_en)) where deleted_at is null;
alter table service_category enable row level security;
drop policy if exists service_category_select on service_category;
create policy service_category_select on service_category for select to authenticated using (true);
revoke all on service_category from anon;
grant select on service_category to authenticated;

insert into service_category (base_group, name_en, name_kin, name_fr, kind, sort) values
  ('consultation', 'Consultation & treatments', 'Gusuzuma no kuvura', 'Consultation et traitements', 'treatment', 1),
  ('dental', 'Dental', 'Amenyo', 'Dentaire', 'treatment', 2),
  ('lab', 'Laboratory', 'Ibizamini', 'Laboratoire', 'lab', 3),
  ('imaging', 'Ultrasound / imaging', 'Ekografi / amafoto', 'Échographie / imagerie', 'imaging', 4),
  ('procedure', 'Minor surgery & procedures', 'Kubaga byoroheje n''ibindi bikorwa', 'Petite chirurgie et actes', 'treatment', 5),
  ('nursing', 'Nursing care', 'Kwita ku barwayi', 'Soins infirmiers', 'treatment', 6),
  ('bed', 'Beds & observation', 'Ibitanda no gukurikiranwa', 'Lits et observation', 'bed', 7),
  ('registration', 'Registration', 'Kwandikwa', 'Enregistrement', 'treatment', 8),
  ('pharmacy', 'Pharmacy', 'Farumasi', 'Pharmacie', 'treatment', 9),
  ('other', 'Other', 'Ibindi', 'Autre', 'treatment', 10);

alter table service add column if not exists category_id uuid references service_category (id);
update service s set category_id = c.id from service_category c
where c.base_group = s.service_group and s.category_id is null;

-- The internal group follows the category (and the category follows a group set directly by
-- older functions such as bulk add with a "group").
create or replace function service_category_sync()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_kind category_kind;
  v_base service_group;
begin
  if new.category_id is null
     or (tg_op = 'UPDATE' and new.service_group is distinct from old.service_group
         and new.category_id is not distinct from old.category_id) then
    select id into new.category_id from service_category
    where base_group = new.service_group and deleted_at is null order by sort limit 1;
    return new;
  end if;
  select kind, base_group into v_kind, v_base from service_category where id = new.category_id;
  new.service_group := case v_kind
    when 'lab' then 'lab'::service_group
    when 'imaging' then 'imaging'::service_group
    when 'bed' then 'bed'::service_group
    else case when v_base in ('lab', 'imaging', 'bed') or v_base is null then 'other'::service_group else v_base end
  end;
  return new;
end
$$;
drop trigger if exists service_category_sync on service;
create trigger service_category_sync before insert or update of category_id, service_group on service
  for each row execute function service_category_sync();

-- ---------------------------------------------------------------- manager: categories
create or replace function save_category(
  p_id uuid,
  p_name_en text,
  p_name_kin text default null,
  p_name_fr text default null,
  p_kind category_kind default 'treatment'
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_old category_kind;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name_en, ''))) < 2 then
    raise exception 'give the category a name' using errcode = '22023';
  end if;
  if exists (select 1 from service_category where lower(name_en) = lower(trim(p_name_en))
             and deleted_at is null and id is distinct from p_id) then
    raise exception 'a category with this name already exists' using errcode = '23505';
  end if;
  if v_id is null then
    if p_kind = 'bed' then
      raise exception 'bed stays have their own built-in category' using errcode = '22023';
    end if;
    insert into service_category (name_en, name_kin, name_fr, kind)
    values (trim(p_name_en), nullif(trim(coalesce(p_name_kin, '')), ''), nullif(trim(coalesce(p_name_fr, '')), ''), p_kind)
    returning id into v_id;
  else
    select kind into v_old from service_category where id = v_id and deleted_at is null;
    if not found then
      raise exception 'category not found' using errcode = 'P0002';
    end if;
    if (v_old = 'bed') <> (p_kind = 'bed') then
      raise exception 'the bed category keeps its kind' using errcode = '22023';
    end if;
    update service_category
    set name_en = trim(p_name_en), name_kin = nullif(trim(coalesce(p_name_kin, '')), ''),
        name_fr = nullif(trim(coalesce(p_name_fr, '')), ''), kind = p_kind
    where id = v_id;
    -- a new kind: its treatments behave accordingly (tests become orderable, or stop being)
    if v_old <> p_kind then
      update service set category_id = category_id where category_id = v_id;
    end if;
  end if;
  return v_id;
end
$$;

create or replace function delete_category(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from service_category where id = p_id and kind = 'bed') then
    raise exception 'the bed category cannot be deleted' using errcode = '22023';
  end if;
  select count(*) into v_n from service where category_id = p_id and deleted_at is null;
  if v_n > 0 then
    raise exception 'this category still has % treatment(s): move them to another category first', v_n
      using errcode = '23503';
  end if;
  update service_category set deleted_at = now() where id = p_id and deleted_at is null;
  if not found then
    raise exception 'category not found' using errcode = 'P0002';
  end if;
end
$$;

create or replace function set_service_category(p_service_id uuid, p_category_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from service_category where id = p_category_id and deleted_at is null) then
    raise exception 'category not found' using errcode = 'P0002';
  end if;
  update service set category_id = p_category_id where id = p_service_id and deleted_at is null;
  if not found then
    raise exception 'treatment not found' using errcode = 'P0002';
  end if;
end
$$;

-- Every treatment of one category into a department (Catalogue tools).
create or replace function move_category_to_department(p_category_id uuid, p_department_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_department_id is not null and not exists (select 1 from department where id = p_department_id and deleted_at is null) then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  update service set department_id = p_department_id where category_id = p_category_id and deleted_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- Bulk add: an item may name its category (id) instead of a group.
create or replace function bulk_add_services(p_department_id uuid, p_items jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_item jsonb;
  v_id uuid;
  v_n integer := 0;
  v_group service_group;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_department_id is not null and not exists (select 1 from department where id = p_department_id and deleted_at is null) then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'give a list of treatments' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    if length(trim(coalesce(v_item ->> 'name_en', ''))) < 2 then
      continue;
    end if;
    begin
      v_group := coalesce(nullif(v_item ->> 'group', ''), 'consultation')::service_group;
    exception when others then
      v_group := 'other';
    end;
    v_id := upsert_service(null, v_item ->> 'name_en', v_group, coalesce((v_item ->> 'price')::numeric, 0),
                           v_item ->> 'name_kin', v_item ->> 'name_fr', 0, false, true, null, null);
    update service set department_id = p_department_id where id = v_id;
    if nullif(v_item ->> 'category', '') is not null then
      update service set category_id = (v_item ->> 'category')::uuid where id = v_id
        and exists (select 1 from service_category c where c.id = (v_item ->> 'category')::uuid and c.deleted_at is null);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- Adjust prices: one category (new p_category_id), or a former group, or everything.
drop function if exists adjust_prices(service_group, text, numeric, integer);
create or replace function adjust_prices(
  p_group service_group default null,
  p_mode text default 'multiply',
  p_value numeric default 1,
  p_round integer default 100,
  p_category_id uuid default null
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_list uuid;
  v_count integer := 0;
  v_step integer := greatest(coalesce(p_round, 1), 1);
  r record;
  v_new numeric;
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_mode not in ('multiply', 'percent', 'amount') or p_value is null then
    raise exception 'unknown adjustment' using errcode = '22023';
  end if;
  if p_mode = 'multiply' and (p_value <= 0 or p_value > 10) then
    raise exception 'the multiplier must be above 0 and at most 10' using errcode = '22023';
  end if;
  if p_mode = 'percent' and (p_value <= -100 or p_value > 900) then
    raise exception 'the percentage must be above -100 and at most 900' using errcode = '22023';
  end if;

  select id into v_list from price_list
  where payer_id is null and deleted_at is null and effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
  order by effective_from desc limit 1;
  if v_list is null then
    return 0;
  end if;

  for r in
    select pli.id, pli.price
    from price_list_item pli
    join service s on s.id = pli.service_id
    where pli.price_list_id = v_list and pli.deleted_at is null and s.deleted_at is null
      and (p_group is null or s.service_group = p_group)
      and (p_category_id is null or s.category_id = p_category_id)
      and pli.price > 0
  loop
    v_new := case p_mode
      when 'multiply' then r.price * p_value
      when 'percent' then r.price * (100 + p_value) / 100
      else r.price + p_value
    end;
    v_new := greatest(round(v_new / v_step) * v_step, 0);
    if v_new <> r.price then
      update price_list_item set price = v_new where id = r.id;
      v_count := v_count + 1;
    end if;
  end loop;

  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'update', 'price_list', v_list,
          jsonb_build_object('group', p_group, 'category', p_category_id, 'mode', p_mode, 'value', p_value,
                             'round', v_step, 'changed', v_count));
  return v_count;
end
$$;

revoke all on function save_category(uuid, text, text, text, category_kind), delete_category(uuid),
  set_service_category(uuid, uuid), move_category_to_department(uuid, uuid),
  adjust_prices(service_group, text, numeric, integer, uuid) from public, anon;
grant execute on function save_category(uuid, text, text, text, category_kind), delete_category(uuid),
  set_service_category(uuid, uuid), move_category_to_department(uuid, uuid),
  adjust_prices(service_group, text, numeric, integer, uuid) to authenticated;

-- ---------------------------------------------------------------- the catalogue with its category
create or replace view catalogue_services with (security_invoker = true) as
  select s.id, s.code, s.name_en, s.name_kin, s.name_fr, s.service_group, s.allow_manual_price,
         s.max_discount_pct, s.active, s.default_duration_min, s.booking_category,
         (select pf.price from price_for(s.id, null, null) pf) as cash_price,
         coalesce((
           select jsonb_object_agg(pl.payer_id::text, pli.price)
           from price_list pl
           join price_list_item pli on pli.price_list_id = pl.id
           where pl.payer_id is not null and pli.service_id = s.id
             and pl.deleted_at is null and pli.deleted_at is null
             and pl.effective_from <= current_date and (pl.effective_to is null or pl.effective_to >= current_date)
         ), '{}'::jsonb) as payer_prices,
         d.id as department_id,
         d.name as department_name,
         coalesce((select array_agg(sd.department_id order by (sd.department_id = s.department_id) desc, dd.name)
                   from service_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.service_id = s.id), '{}') as department_ids,
         coalesce((select array_agg(dd.name order by (sd.department_id = s.department_id) desc, dd.name)
                   from service_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.service_id = s.id), '{}') as department_names,
         s.category_id
  from service s
  left join department d on d.id = s.department_id and d.deleted_at is null
  where s.deleted_at is null;
revoke all on catalogue_services from anon;
grant select on catalogue_services to authenticated;

-- ---------------------------------------------------------------- dashboard: visits by category
create or replace function dashboard_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := is_manager();
  v_days integer := greatest(1, p_to - p_from + 1);
  v_prev_from date := p_from - v_days;
  v_prev_to date := p_from - 1;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_tiles jsonb;
  v_rev30 jsonb;
  v_collections jsonb;
  v_receivables jsonb;
  v_visits jsonb;
  v_wait jsonb;
  v_queue jsonb;
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

  -- headline tiles
  select jsonb_build_object(
    'registered', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'registeredPrev', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'visits', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'visitsPrev', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'waitingNow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'),
    'avgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date = v_today)), 0)
                   from queue_entry q where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'revenue', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to) end,
    'revenuePrev', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to) end,
    'openBills', case when v_manager then (select count(*) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'openBillsDue', case when v_manager then (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'bedsOccupied', (select count(*) from bed where deleted_at is null and status = 'occupied'),
    'bedsTotal', (select count(*) from bed where deleted_at is null and status <> 'out_of_service')
  ) into v_tiles;

  -- revenue per day, last 30 days ending today
  select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'amount', coalesce(s.amount, 0)) order by d), '[]'::jsonb) into v_rev30
  from generate_series(v_today - 29, v_today, interval '1 day') d
  left join (
    select (paid_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
    from payment where deleted_at is null and paid_at >= (v_today - 29)::timestamp
    group by 1
  ) s on s.day = d::date;

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
  select coalesce(jsonb_agg(jsonb_build_object('group', g.grp, 'name', g.name, 'nameKin', g.kin, 'nameFr', g.fr,
                                                'count', g.n) order by g.n desc), '[]'::jsonb) into v_visits
  from (
    -- by the clinic's own categories; medicines (no service) count as pharmacy
    select coalesce(c.base_group::text, case when s.id is null then 'pharmacy' else 'other' end) as grp,
           c.name_en as name, c.name_kin as kin, c.name_fr as fr, count(distinct i.encounter_id) as n
    from invoice_line l
    join invoice i on i.id = l.invoice_id
    left join service s on s.id = l.service_id
    left join service_category c on c.id = s.category_id
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by c.id, 1, 2, 3, 4
  ) g;

  -- waiting time and queue by station (today)
  select coalesce(jsonb_agg(jsonb_build_object('station', w.station, 'minutes', w.minutes, 'waiting', w.waiting, 'longest', w.longest) order by w.station), '[]'::jsonb) into v_wait
  from (
    select q.station::text as station,
           round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date = v_today)) as minutes,
           count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open') as waiting,
           round(max(extract(epoch from now() - q.created_at) / 60) filter (where q.finished_at is null and q.started_at is null and e.status = 'open')) as longest
    from queue_entry q
    join encounter e on e.id = q.encounter_id
    where q.deleted_at is null
      and ((q.finished_at is null and e.status = 'open') or (q.created_at at time zone 'Africa/Kigali')::date = v_today)
    group by q.station
  ) w;

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

  -- who did what (accountability)
  select coalesce(jsonb_agg(jsonb_build_object(
      'name', p.full_name, 'role', p.role, 'staffId', p.staff_id,
      'registrations', coalesce(r.n, 0), 'vitals', coalesce(v.n, 0), 'charges', coalesce(c.n, 0),
      'payments', case when v_manager then coalesce(pm.n, 0) end,
      'collected', case when v_manager then coalesce(pm.amount, 0) end,
      'lastSignIn', p.last_sign_in_at
    ) order by (coalesce(r.n, 0) + coalesce(v.n, 0) + coalesce(c.n, 0) + coalesce(pm.n, 0)) desc, p.full_name), '[]'::jsonb) into v_staff
  from profiles p
  left join (select created_by as id, count(*) as n from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) r on r.id = p.id
  left join (select performer_id as id, count(distinct encounter_id) as n from observation where deleted_at is null and (effective_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) v on v.id = p.id
  left join (select entered_by as id, count(*) as n from invoice_line where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) c on c.id = p.id
  left join (select cashier_id as id, count(*) as n, sum(amount) as amount from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) pm on pm.id = p.id
  where p.active;

  -- stock
  select coalesce(jsonb_agg(jsonb_build_object('name', name_generic, 'onHand', on_hand, 'min', reorder_level) order by (on_hand::numeric / greatest(reorder_level, 1))), '[]'::jsonb) into v_reorder
  from items_below_reorder where on_hand < reorder_level;

  select jsonb_build_object(
    'd30', count(*) filter (where s.expiry <= v_today + 30),
    'd60', count(*) filter (where s.expiry > v_today + 30 and s.expiry <= v_today + 60),
    'd90', count(*) filter (where s.expiry > v_today + 60 and s.expiry <= v_today + 90)
  ) into v_expiring
  from (select batch_id, expiry, sum(quantity) as q from stock_on_hand where expiry is not null group by batch_id, expiry) s
  where s.q > 0;

  -- bookings
  select jsonb_build_object(
    'booked', count(*) filter (where status in ('confirmed', 'arrived', 'in_progress', 'completed', 'no_show')),
    'missed', count(*) filter (where status = 'no_show'),
    'pending', count(*) filter (where status = 'inquiry')
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

  select coalesce(jsonb_agg(jsonb_build_object('name', p.full_name, 'role', p.role, 'at', a.at, 'reason', a.reason) order by a.at desc), '[]'::jsonb) into v_logins
  from (select actor_id, at, reason from audit_event where action = 'login' and at > now() - interval '1 day' order by at desc limit 12) a
  join profiles p on p.id = a.actor_id;

  select jsonb_build_object('active', count(*) filter (where active), 'total', count(*)) into v_services from service where deleted_at is null;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'manager', v_manager, 'generatedAt', now(),
    'tiles', v_tiles, 'revenue30d', v_rev30, 'collections', v_collections, 'receivables', v_receivables,
    'visitsByGroup', v_visits, 'waitByStation', v_wait, 'topTreatments', v_top, 'staff', v_staff,
    'reorder', v_reorder, 'expiring', v_expiring, 'bookings', v_noshow, 'messages', v_messages,
    'claims', v_claims, 'logins', v_logins, 'services', v_services
  );
end
$$;
