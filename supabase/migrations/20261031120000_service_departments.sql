-- 0048 · A treatment can be given by several departments; staff see their department's own.
--
-- The departments are the ones of the Employees page (one list for the clinic): a department
-- holds its employees and the treatments they give. service_department links a treatment to
-- every department that gives it; service.department_id stays as its first ("main") department
-- so older functions (bulk add, move a type) keep working — a trigger keeps the link in step.
-- my_placement() now also returns the employee's department id, so the visit screen can show
-- each employee the treatments of their own department first.

create table if not exists service_department (
  service_id uuid not null references service (id),
  department_id uuid not null references department (id),
  created_at timestamptz not null default now(),
  primary key (service_id, department_id)
);
create index if not exists service_department_dept_idx on service_department (department_id);
alter table service_department enable row level security;
drop policy if exists service_department_select on service_department;
create policy service_department_select on service_department for select to authenticated using (true);
revoke all on service_department from anon;
grant select on service_department to authenticated;

insert into service_department (service_id, department_id)
select id, department_id from service where department_id is not null
on conflict do nothing;

-- The main department moves (bulk add, "move a type", set_service_department): the link follows.
create or replace function sync_service_department()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.department_id is not null
     and old.department_id is distinct from new.department_id then
    delete from service_department where service_id = new.id and department_id = old.department_id;
  end if;
  if new.department_id is not null then
    insert into service_department (service_id, department_id)
    values (new.id, new.department_id) on conflict do nothing;
  end if;
  return new;
end
$$;
drop trigger if exists service_department_sync on service;
create trigger service_department_sync after insert or update of department_id on service
  for each row execute function sync_service_department();

-- Every department that gives this treatment (empty = none yet). The first is the main one.
create or replace function set_service_departments(p_service_id uuid, p_department_ids uuid[])
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_ids uuid[] := coalesce(p_department_ids, '{}');
begin
  if not has_perm('catalogue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(v_ids) x(id)
             where not exists (select 1 from department d where d.id = x.id and d.deleted_at is null)) then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  update service set department_id = v_ids[1] where id = p_service_id and deleted_at is null;
  if not found then
    raise exception 'treatment not found' using errcode = 'P0002';
  end if;
  delete from service_department where service_id = p_service_id and department_id <> all (v_ids);
  insert into service_department (service_id, department_id)
  select p_service_id, x.id from unnest(v_ids) x(id) on conflict do nothing;
end
$$;
revoke all on function set_service_departments(uuid, uuid[]) from public, anon;
grant execute on function set_service_departments(uuid, uuid[]) to authenticated;

-- The catalogue with every department of each treatment (new columns at the end).
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
                   where sd.service_id = s.id), '{}') as department_names
  from service s
  left join department d on d.id = s.department_id and d.deleted_at is null
  where s.deleted_at is null;
revoke all on catalogue_services from anon;
grant select on catalogue_services to authenticated;

create or replace function my_placement()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'position', p.position, 'department', d.name, 'departmentId', d.id,
    'specialty', p.specialty, 'station', p.station
  )
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null
  where p.id = auth.uid()
$$;
