-- 0026 · Departments, positions, and notifications.
--
-- Departments: the manager creates them (name, description, which roles belong) and places
-- each employee in one with a position: head, assistant head or member. A head gets the head
-- dashboard of that department. Nothing is pre-filled: the clinic defines its own departments.
--
-- Notifications: one row per message, addressed to a person, a role, a department (optionally
-- its heads only) or everyone. Automatic ones are written by triggers as a kind + params so each
-- reader sees them in their own language; manager / head messages carry their own text.
-- Read state is per person.

-- ---------------------------------------------------------------- departments
create table if not exists department (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  roles role_key[] not null default '{}',
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  deleted_at timestamptz
);
create unique index if not exists department_name_uq on department (lower(name)) where deleted_at is null;
alter table department enable row level security;
drop policy if exists department_read on department;
create policy department_read on department for select to authenticated using (deleted_at is null);

alter table profiles add column if not exists department_id uuid references department (id);
alter table profiles add column if not exists position text not null default 'member'
  check (position in ('head', 'assistant', 'member'));

create or replace view staff_directory with (security_invoker = true) as
  select p.id, p.username, p.full_name, p.role, p.station, p.dashboard, p.head_of, p.language, p.phone,
         p.active, p.must_change_pin, p.last_sign_in_at, p.pin_changed_at, p.deactivated_at, p.created_at,
         p.staff_id, p.email, p.department_id, d.name as department_name, p.position
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null;

create or replace function upsert_department(p_id uuid, p_name text, p_description text, p_roles role_key[])
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'the department needs a name' using errcode = '22023';
  end if;
  if v_id is null then
    insert into department (name, description, roles)
    values (trim(p_name), nullif(trim(coalesce(p_description, '')), ''), coalesce(p_roles, '{}'))
    returning id into v_id;
  else
    update department set name = trim(p_name), description = nullif(trim(coalesce(p_description, '')), ''),
                          roles = coalesce(p_roles, '{}')
    where id = v_id and deleted_at is null;
    if not found then
      raise exception 'department not found' using errcode = 'P0002';
    end if;
    -- Heads follow the department's name on their dashboard.
    update profiles set head_of = trim(p_name) where department_id = v_id and position = 'head';
  end if;
  return v_id;
end
$$;

create or replace function delete_department(p_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update department set deleted_at = now(), active = false where id = p_id and deleted_at is null;
  if not found then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  -- Its staff stay employed, without a department; heads lose the head dashboard.
  update profiles set department_id = null, position = 'member',
         dashboard = case when dashboard = 'head' then null else dashboard end,
         head_of = case when dashboard = 'head' then null else head_of end
  where department_id = p_id;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- ---------------------------------------------------------------- notifications
create table if not exists notification (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  kind text not null,                     -- queue, task, inquiry, to_accept, message
  params jsonb not null default '{}',     -- for automatic kinds (rendered in the reader's language)
  title text,                             -- for messages written by a person
  body text,
  link text,                              -- in-app path, e.g. /app/visit?encounter=…
  urgent boolean not null default false,
  recipient_user uuid references profiles (id) on delete cascade,
  recipient_role role_key,
  recipient_department uuid references department (id) on delete cascade,
  heads_only boolean not null default false,
  to_all boolean not null default false
);
create index if not exists notification_created_idx on notification (created_at desc);
alter table notification enable row level security;

create table if not exists notification_read (
  notification_id uuid not null references notification (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);
alter table notification_read enable row level security;

-- Is this notification for the signed-in person? (Managers also see role/department messages.)
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
      or (n.recipient_department is not null and n.recipient_department = p.department_id
          and (not n.heads_only or p.position in ('head', 'assistant')))
    )
  )
$$;

create or replace function my_notifications(p_limit integer default 30)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with mine as (
    select n.*, (r.user_id is not null) as is_read, sender.full_name as sender
    from notification n
    left join notification_read r on r.notification_id = n.id and r.user_id = auth.uid()
    left join profiles sender on sender.id = n.created_by
    where n.created_at > now() - interval '14 days' and notification_is_mine(n, auth.uid())
  )
  select jsonb_build_object(
    'unread', (select count(*) from mine where not is_read),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'at', created_at, 'kind', kind, 'params', params, 'title', title, 'body', body,
        'link', link, 'urgent', urgent, 'read', is_read, 'sender', sender
      ) order by created_at desc)
      from (select * from mine order by created_at desc limit greatest(1, least(p_limit, 100))) x
    ), '[]'::jsonb)
  )
$$;

create or replace function mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  insert into notification_read (notification_id, user_id)
  select n.id, auth.uid() from notification n
  where (p_ids is null or n.id = any (p_ids))
    and n.created_at > now() - interval '14 days'
    and notification_is_mine(n, auth.uid())
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- Manager: to anyone. Department head / assistant: to their own department.
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
    if not (v_me.position in ('head', 'assistant') and p_to = 'department'
            and p_target::uuid = v_me.department_id) then
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

-- ---------------------------------------------------------------- automatic notifications
-- Which role works at a station.
create or replace function station_role(p_station station)
returns role_key
language sql immutable
as $$
  select case p_station
    when 'reception' then 'receptionist'
    when 'triage' then 'nurse'
    when 'nursing' then 'nurse'
    when 'beds' then 'nurse'
    when 'consultation' then 'doctor'
    when 'dental' then 'doctor'
    when 'theatre' then 'doctor'
    when 'laboratory' then 'lab_tech'
    when 'ultrasound' then 'sonographer'
    when 'pharmacy' then 'pharmacist'
    when 'cashier' then 'cashier'
  end::role_key
$$;

create or replace function notify_queue_entry()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_triage text;
begin
  select p.surname || ' ' || p.given_names, e.triage_level::text into v_name, v_triage
  from encounter e join patient p on p.id = e.patient_id where e.id = new.encounter_id;
  insert into notification (kind, params, link, urgent, recipient_role, created_by)
  values ('queue',
          jsonb_build_object('ticket', new.ticket_no, 'name', v_name, 'station', new.station, 'triage', v_triage),
          '/app/visit?encounter=' || new.encounter_id,
          coalesce(v_triage, '') = 'red' or new.priority = 1,
          station_role(new.station),
          auth.uid());
  return new;
end
$$;
drop trigger if exists queue_entry_notify on queue_entry;
create trigger queue_entry_notify after insert on queue_entry
  for each row execute function notify_queue_entry();

create or replace function notify_task()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
begin
  select p.surname || ' ' || p.given_names into v_name from patient p where p.id = new.patient_id;
  insert into notification (kind, params, link, recipient_role, recipient_user, created_by)
  values ('task',
          jsonb_build_object('title', new.title, 'name', v_name, 'due', new.due_at),
          case when new.encounter_id is not null then '/app/visit?encounter=' || new.encounter_id end,
          case when new.assigned_to is null then new.assigned_role end,
          new.assigned_to,
          auth.uid());
  return new;
end
$$;
drop trigger if exists internal_task_notify on internal_task;
create trigger internal_task_notify after insert on internal_task
  for each row execute function notify_task();

create or replace function notify_appointment()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_doctor uuid;
begin
  v_name := coalesce((select p.surname || ' ' || p.given_names from patient p where p.id = new.patient_id), new.contact_name);
  if tg_op = 'INSERT' and new.status = 'inquiry' then
    insert into notification (kind, params, link, recipient_role, created_by)
    values ('inquiry', jsonb_build_object('name', v_name, 'when', new.starts_at), '/app/appointments',
            'receptionist', auth.uid());
  elsif tg_op = 'UPDATE' and new.status = 'approved' and old.status is distinct from 'approved' then
    select user_id into v_doctor from practitioner where id = new.practitioner_id;
    if v_doctor is not null then
      insert into notification (kind, params, link, recipient_user, created_by)
      values ('to_accept', jsonb_build_object('name', v_name, 'when', new.starts_at), '/app',
              v_doctor, auth.uid());
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists appointment_notify on appointment;
create trigger appointment_notify after insert or update of status on appointment
  for each row execute function notify_appointment();

grant execute on function upsert_department(uuid, text, text, role_key[]), delete_department(uuid),
  my_notifications(integer), mark_notifications_read(uuid[]),
  send_notification(text, text, text, text, boolean, boolean) to authenticated;
revoke execute on function upsert_department(uuid, text, text, role_key[]), delete_department(uuid),
  my_notifications(integer), mark_notifications_read(uuid[]),
  send_notification(text, text, text, text, boolean, boolean) from anon;
revoke execute on function notification_is_mine(notification, uuid) from anon, authenticated;
