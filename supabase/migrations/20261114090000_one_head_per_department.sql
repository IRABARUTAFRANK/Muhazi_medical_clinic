-- 0073 · One head per department; the assistant head is the head's deputy.
--
-- Nothing stopped two people from being head of the same department (live: Pharmacist had
-- Logan and Jean marie). Now:
--   * a department has at most one head. Making someone head makes the previous head an
--     assistant head, whichever screen or function does it;
--   * the assistant heads (any number) stand in for the head: the same department dashboard
--     (no money), the same messages to the department. Before, the database let them read the
--     department's figures but their menu had no Dashboard;
--   * profiles.dashboard / head_of follow the memberships: 'head' for a head or an assistant,
--     head_of only for the head (the title "Head of …").

-- ---------------------------------------------------------------- the departments with two heads
-- The latest appointment is kept as head (the manager's most recent choice); the others become
-- assistant heads.
with ranked as (
  select profile_id, department_id,
         row_number() over (partition by department_id order by created_at desc, profile_id) as n
  from staff_department where position = 'head'
)
update staff_department sd set position = 'assistant'
from ranked r
where r.profile_id = sd.profile_id and r.department_id = sd.department_id and r.n > 1;

update profiles p set position = 'assistant'
where p.position = 'head' and p.department_id is not null
  and exists (select 1 from staff_department sd where sd.profile_id = p.id
              and sd.department_id = p.department_id and sd.position = 'assistant');

create unique index if not exists staff_department_one_head
  on staff_department (department_id) where position = 'head';

-- ---------------------------------------------------------------- dashboard and title follow
create or replace function refresh_lead(p_profile_id uuid)
returns void
language sql security definer set search_path = public
as $$
  update profiles p
  set dashboard = case
        when p.role = 'manager' or p.dashboard = 'manager' then p.dashboard
        when exists (select 1 from staff_department sd join department d on d.id = sd.department_id and d.deleted_at is null
                     where sd.profile_id = p.id and sd.position in ('head', 'assistant')) then 'head'
        else null end,
      head_of = (select d.name from staff_department sd join department d on d.id = sd.department_id and d.deleted_at is null
                 where sd.profile_id = p.id and sd.position = 'head'
                 order by (sd.department_id = p.department_id) desc, d.name limit 1)
  where p.id = p_profile_id
$$;

-- A new head: the previous head of that department becomes assistant head.
create or replace function staff_department_one_head()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.position = 'head' then
    update staff_department set position = 'assistant'
    where department_id = new.department_id and position = 'head' and profile_id <> new.profile_id;
    update profiles set position = 'assistant'
    where department_id = new.department_id and position = 'head' and id <> new.profile_id;
  end if;
  return new;
end
$$;
drop trigger if exists staff_department_one_head on staff_department;
create trigger staff_department_one_head before insert or update of position, department_id on staff_department
  for each row execute function staff_department_one_head();

create or replace function staff_department_lead_sync()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform refresh_lead(old.profile_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.profile_id <> old.profile_id) then
    perform refresh_lead(new.profile_id);
  end if;
  return null;
end
$$;
drop trigger if exists staff_department_lead_sync on staff_department;
create trigger staff_department_lead_sync after insert or update or delete on staff_department
  for each row execute function staff_department_lead_sync();

-- Deleting a department: the dashboards follow the memberships left.
create or replace function delete_department(p_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
  r record;
  v_next staff_department%rowtype;
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update department set deleted_at = now(), active = false where id = p_id and deleted_at is null;
  if not found then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  select count(*) into v_n from staff_department where department_id = p_id;
  delete from staff_department where department_id = p_id;
  for r in select id, dashboard from profiles where department_id = p_id loop
    select * into v_next from staff_department where profile_id = r.id
    order by (position = 'head') desc, created_at limit 1;
    update profiles
    set department_id = v_next.department_id,
        position = coalesce(v_next.position, 'member')
    where id = r.id;
  end loop;
  -- The department dashboard stays only for someone still head or assistant head somewhere.
  perform refresh_lead(p.id) from profiles p where p.dashboard = 'head';
  return v_n;
end
$$;

-- Everyone's dashboard and title as of now (assistant heads gain the department dashboard).
select refresh_lead(id) from profiles;

revoke all on function refresh_lead(uuid) from public, anon, authenticated;
