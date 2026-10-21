-- 0051 · An employee may belong to several departments.
--
-- A doctor can work in Consultation and in Minor surgery; a nurse in Nursing care and in
-- Maternity. staff_department holds every department of an employee with the position held
-- there (head, assistant or member — a head of one may be a member of another).
-- profiles.department_id / position stay as the main (first) department, kept in step by a
-- trigger, so older code keeps working. The employee's departments decide:
--   · the treatments they see first on a visit (their departments' treatments);
--   · the department messages they receive (and which ones they may send, as head/assistant);
--   · the people listed on each department card of the Employees page.
-- Memberships are written by the manage-staff function after the manager's e-mailed code.

create table if not exists staff_department (
  profile_id uuid not null references profiles (id) on delete cascade,
  department_id uuid not null references department (id),
  position text not null default 'member' check (position in ('head', 'assistant', 'member')),
  created_at timestamptz not null default now(),
  primary key (profile_id, department_id)
);
create index if not exists staff_department_dept_idx on staff_department (department_id);
alter table staff_department enable row level security;
drop policy if exists staff_department_select on staff_department;
create policy staff_department_select on staff_department for select to authenticated using (true);
revoke all on staff_department from anon;
grant select on staff_department to authenticated;

insert into staff_department (profile_id, department_id, position)
select id, department_id, position from profiles where department_id is not null
on conflict do nothing;

-- The main department moves (older code, a single-department update): the membership follows.
create or replace function sync_staff_department()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.department_id is not null
     and old.department_id is distinct from new.department_id then
    delete from staff_department where profile_id = new.id and department_id = old.department_id;
  end if;
  if new.department_id is not null then
    insert into staff_department (profile_id, department_id, position)
    values (new.id, new.department_id, new.position)
    on conflict (profile_id, department_id) do update set position = excluded.position;
  end if;
  return new;
end
$$;
drop trigger if exists staff_department_sync on profiles;
create trigger staff_department_sync after insert or update of department_id, position on profiles
  for each row execute function sync_staff_department();

-- Every department of an employee, replaced at once (manage-staff only, after the e-mailed
-- code). p_items: [{"department_id": "…", "position": "head|assistant|member"}], main first.
create or replace function set_staff_departments(p_profile_id uuid, p_items jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_first jsonb := case when jsonb_typeof(p_items) = 'array' then p_items -> 0 end;
begin
  update profiles
  set department_id = nullif(v_first ->> 'department_id', '')::uuid,
      position = coalesce(nullif(v_first ->> 'position', ''), 'member')
  where id = p_profile_id;
  delete from staff_department sd
  where sd.profile_id = p_profile_id
    and not exists (select 1 from jsonb_array_elements(coalesce(p_items, '[]')) x
                    where (x ->> 'department_id')::uuid = sd.department_id);
  insert into staff_department (profile_id, department_id, position)
  select p_profile_id, (x ->> 'department_id')::uuid, coalesce(nullif(x ->> 'position', ''), 'member')
  from jsonb_array_elements(coalesce(p_items, '[]')) x
  on conflict (profile_id, department_id) do update set position = excluded.position;
end
$$;
revoke all on function set_staff_departments(uuid, jsonb) from public, anon, authenticated;
grant execute on function set_staff_departments(uuid, jsonb) to service_role;

-- The employee list with every department ({id, name, position}, main first).
create or replace view staff_directory with (security_invoker = true) as
  select p.id, p.username, p.full_name, p.role, p.station, p.dashboard, p.head_of, p.language, p.phone,
         p.active, p.must_change_pin, p.last_sign_in_at, p.pin_changed_at, p.deactivated_at, p.created_at,
         p.staff_id, p.email, p.department_id, d.name as department_name, p.position, p.specialty,
         coalesce((select jsonb_agg(jsonb_build_object('id', dd.id, 'name', dd.name, 'position', sd.position)
                                    order by (sd.department_id = p.department_id) desc, dd.name)
                   from staff_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.profile_id = p.id), '[]'::jsonb) as departments
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null;

create or replace function my_placement()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'position', p.position, 'department', d.name, 'departmentId', d.id,
    'specialty', p.specialty, 'station', p.station,
    'departments', coalesce((select jsonb_agg(jsonb_build_object('id', dd.id, 'name', dd.name, 'position', sd.position)
                                              order by (sd.department_id = p.department_id) desc, dd.name)
                             from staff_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                             where sd.profile_id = p.id), '[]'::jsonb)
  )
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null
  where p.id = auth.uid()
$$;

-- Deleting a department: its members keep their other departments (the next one becomes main).
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
  -- The head dashboard stays only for someone still head of a department.
  update profiles p
  set dashboard = case when exists (select 1 from staff_department sd where sd.profile_id = p.id and sd.position = 'head')
                       then 'head' else null end,
      head_of = (select dd.name from staff_department sd join department dd on dd.id = sd.department_id
                 where sd.profile_id = p.id and sd.position = 'head' order by dd.name limit 1)
  where p.dashboard = 'head';
  return v_n;
end
$$;

-- ---------------------------------------------------------------- messages to a department
create or replace function notification_is_mine(n notification, p_me uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles p
    where p.id = p_me and p.active and (
      n.to_all
      or n.recipient_user = p_me
      or (n.recipient_role is not null and n.recipient_role = p.role and n.recipient_department is null)
      or (n.recipient_department is not null and exists (
            select 1 from staff_department sd
            where sd.profile_id = p.id and sd.department_id = n.recipient_department
              and (not n.heads_only or sd.position in ('head', 'assistant'))))
    )
  )
$$;

create or replace function send_notification(
  p_to text,              -- all | role | department | user
  p_target text,          -- role key, department id or user id (null for all)
  p_title text,
  p_body text,
  p_heads_only boolean default false,
  p_urgent boolean default false
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_me profiles%rowtype;
  v_id uuid;
begin
  select * into v_me from profiles where id = auth.uid() and active;
  if not found then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_title, ''))) < 2 then
    raise exception 'write a title' using errcode = '22023';
  end if;
  if not is_manager() then
    if not (p_to = 'department' and exists (
              select 1 from staff_department sd
              where sd.profile_id = v_me.id and sd.department_id = p_target::uuid
                and sd.position in ('head', 'assistant'))) then
      raise exception 'only the manager, or a head for their own department, can send messages' using errcode = '42501';
    end if;
  end if;
  insert into notification (kind, title, body, urgent, to_all, recipient_role, recipient_department,
                            recipient_user, heads_only, link)
  values ('message', trim(p_title), nullif(trim(coalesce(p_body, '')), ''), coalesce(p_urgent, false),
          p_to = 'all',
          case when p_to = 'role' then p_target::role_key end,
          case when p_to = 'department' then p_target::uuid end,
          case when p_to = 'user' then p_target::uuid end,
          p_to = 'department' and coalesce(p_heads_only, false), null)
  returning id into v_id;
  return v_id;
end
$$;
