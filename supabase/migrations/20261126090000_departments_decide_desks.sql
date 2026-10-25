-- 0085 · The departments a person works in decide the desks they use; the role is the ceiling.
--
-- Frank: "the departments he will belong in will be the one to determine the type of services that
-- he may access and work on"; "doctors working at the lab or pharmacy … roles that he does or
-- access are determined by the departments that he is in"; "we must have one head of department
-- and assistant, the members are the one who may be many".
--
--   * A  DESKS. A desk is a group of features: reception (register, start visits), triage (vitals
--        at triage and sending on), nursing (nurse tasks, beds), the treating desks (consultation,
--        dental, surgery, circ, fp, hiv: the clinical record, prescribing, ordering tests),
--        laboratory and ultrasound (worklist, samples, results, verify, correct) and pharmacy
--        (hand over, counter sale, the pharmacy and main stores). The keys are the service keys of
--        department.services (0071) plus the new key 'reception'.
--   * B  THE ROLE IS THE CEILING (role_desk): what a person of that role may ever use. Defaults
--        below; the manager changes them (Settings → Who may do what: set_role_desk, audited).
--        The manager always has every desk and is not stored.
--   * C  THE DEPARTMENTS DECIDE. may_use_desk(desk): the manager; or the desk is in the person's
--        ceiling and one of their active departments gives it (reception, triage and the treating
--        desks also need the switch their functions check). SAFETY NET: when no active department
--        of the clinic gives a desk, the role alone decides it, as before (the desk's permission:
--        visit.start, vitals.write, clinical.write, stock.dispense; the worklists: the lab tech, the
--        sonographer and the ultrasound doctor; a clinician still types the result of his own test).
--        The manager's "not allowed" for one employee on that permission takes the desk away; an
--        "allowed" never adds a desk. A nurse covering a doctor uses his treating desks and triage
--        (never the pharmacy, reception or a department's worklist).
--   * D  MONEY STAYS WITH THE ROLE. Payments, bills, charges and refunds keep their permissions and
--        the manager's switches; departments never give money rights (a return on a posted bill is
--        the person's own right). Room stores ("My store") stay with their holders.
--   * E  EVERY DESK FUNCTION ASKS. Results, sample status, corrections, the lab list (lab and
--        imaging by desk), the pharmacy (queue, hand over, counter sale, returns, "not given",
--        store management), triage (vitals at triage, sending on, who measured), nursing (tasks,
--        beds), the treating desks (notes, diagnoses, prescriptions, tests, closing, help) and
--        reception (start a visit; an emergency: the people who treat). The action permissions the
--        manager switches (clinical.write, vitals.write, visit.start, orders.write to order) are
--        still checked as well. A refusal: 42501 with hint 'no_desk' ("you do not work in a
--        department that does this; ask the manager"). The clinical tables are no longer written
--        directly: only through these functions.
--   * F  DAY ONE. Every active employee who uses a desk today (their usual desk, or what they did in
--        the last 90 days) and is in no department giving it keeps it: placed, as a member, in a
--        department giving it when nothing else changes (the patients sent to anyone, room stores,
--        the department's roles); otherwise kept by the rule of before (staff_desk_keep) until the
--        manager places them. Later, a department giving a desk for the first time places the
--        people who work there as usual the same way. The manager is told (notice 'desks_placed');
--        each placement is in the history.
--   * G  ONE HEAD AND ONE ASSISTANT per department (members many). A new assistant makes the
--        previous assistant a member; a new head makes the previous head the assistant (0073), who
--        then replaces the previous assistant. Departments with several assistants today keep the
--        latest named.
--   * H  THE APP READS THE DESKS: my_desks(), desks_of(profile), my_session_profile().desks,
--        staff_directory.desks, role_desk_matrix().
--
-- Errcodes: 42501 not allowed (hint no_desk: not in a department that does this), 22023 bad input.

-- ---------------------------------------------------------------- A desks
-- Every desk key: the services departments give (0071) and reception.
create or replace function desk_key(p_desk text)
returns boolean
language sql immutable
as $$
  select p_desk is not null and (p_desk = 'reception' or service_station(p_desk) is not null)
$$;

create or replace function all_desks()
returns text[]
language sql immutable
as $$
  select array['reception', 'triage', 'consultation', 'dental', 'surgery', 'circ', 'nursing', 'fp', 'hiv',
               'laboratory', 'ultrasound', 'pharmacy']
$$;

-- The desks where patients are treated (the clinical record, prescribing, ordering).
create or replace function treating_desks()
returns text[]
language sql immutable
as $$
  select array['consultation', 'dental', 'surgery', 'circ', 'nursing', 'fp', 'hiv']
$$;

-- The permission that decided the desk before departments did (the safety net).
create or replace function desk_permission(p_desk text)
returns text
language sql immutable
as $$
  select case
    when p_desk = 'reception' then 'visit.start'
    when p_desk = 'triage' then 'vitals.write'
    when p_desk in ('laboratory', 'ultrasound') then 'orders.write'
    when p_desk = 'pharmacy' then 'stock.dispense'
    when desk_key(p_desk) then 'clinical.write'
  end
$$;

-- Before departments, the worklists were run by the roles that worked there: the laboratory by the
-- lab tech, the imaging by the sonographer and the doctor whose usual desk is the ultrasound (his
-- station or specialty). A clinician still types the result of his own test while no department
-- gives that desk (record_result). The other desks: the permission alone, as before.
create or replace function desk_role_rule(p_role role_key, p_station text, p_specialty text, p_desk text)
returns boolean
language sql immutable
as $$
  select case
    when p_desk = 'laboratory' then p_role = 'lab_tech'
    when p_desk = 'ultrasound' then
      p_role = 'sonographer' or coalesce(role_serves(p_role, p_station, 'ultrasound', p_specialty), false)
    else true
  end
$$;

-- The desks of a place where patients wait (Theatre: surgery and circumcision; Beds: nursing).
create or replace function station_desks(p_station station)
returns text[]
language sql immutable
as $$
  select case p_station
    when 'reception' then array['reception']
    when 'triage' then array['triage']
    when 'consultation' then array['consultation']
    when 'dental' then array['dental']
    when 'theatre' then array['surgery', 'circ']
    when 'nursing' then array['nursing', 'fp', 'hiv']
    when 'beds' then array['nursing']
    when 'laboratory' then array['laboratory']
    when 'ultrasound' then array['ultrasound']
    when 'pharmacy' then array['pharmacy']
    else '{}'::text[]
  end
$$;

-- The desk of a test: its station, else its category (imaging → ultrasound).
create or replace function request_desk(p_station station, p_category request_category)
returns text
language sql immutable
as $$
  select case
    when p_station = 'ultrasound' then 'ultrasound'
    when p_station = 'laboratory' then 'laboratory'
    when p_category = 'imaging' then 'ultrasound'
    else 'laboratory'
  end
$$;

-- ---------------------------------------------------------------- B the ceiling of each role
create table if not exists role_desk (
  role role_key not null check (role <> 'manager'),
  desk text not null check (desk_key(desk)),
  set_by uuid default auth.uid(),
  set_at timestamptz not null default now(),
  primary key (role, desk)
);
alter table role_desk enable row level security;
drop policy if exists role_desk_select on role_desk;
create policy role_desk_select on role_desk for select to authenticated using (true);
revoke all on role_desk from anon, authenticated;
grant select on role_desk to authenticated;

-- The clinic's defaults …
insert into role_desk (role, desk, set_by)
select x.role::role_key, unnest(x.desks), null
from (values
  ('doctor', array['reception', 'triage', 'consultation', 'dental', 'surgery', 'circ', 'nursing', 'fp', 'hiv',
                   'laboratory', 'ultrasound', 'pharmacy']),
  ('nurse', array['reception', 'triage', 'consultation', 'dental', 'surgery', 'circ', 'nursing', 'fp', 'hiv',
                  'laboratory', 'ultrasound', 'pharmacy']),
  ('lab_tech', array['laboratory', 'ultrasound']),
  ('sonographer', array['ultrasound']),
  ('pharmacist', array['pharmacy']),
  ('receptionist', array['reception', 'triage'])
  -- the cashier: none of the desks (a role the manager allowed to start visits gains reception
  -- below)
) as x(role, desks)
on conflict do nothing;

-- … and whatever a role does today (the manager may have switched permissions on), so nobody loses
-- a desk on day one.
insert into role_desk (role, desk, set_by)
select rp.role, d.desk, null
from role_permissions rp
cross join unnest(all_desks()) as d(desk)
where rp.role <> 'manager' and rp.permission = desk_permission(d.desk)
  and desk_role_rule(rp.role, null, null, d.desk)
on conflict do nothing;

-- Desks an employee kept on day one by the rule of before (F): placing them in a department would
-- have changed something else (the patients sent to them, a room store, the department's roles),
-- or they only did that work lately. The manager places them, or takes the desk away
-- (forget_kept_desk). Read by desk_via only.
create table if not exists staff_desk_keep (
  profile_id uuid not null references profiles (id) on delete cascade,
  desk text not null check (desk_key(desk)),
  reason text not null,
  created_at timestamptz not null default now(),
  primary key (profile_id, desk)
);
alter table staff_desk_keep enable row level security;
revoke all on staff_desk_keep from anon, authenticated;

-- ---------------------------------------------------------------- C who may use a desk
-- The person's own permission (their exception first, else their role), without cover.
create or replace function staff_perm(p_user uuid, p_permission text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select sp.allowed from staff_permission sp where sp.profile_id = p_user and sp.permission = p_permission),
    exists (select 1 from profiles p join role_permissions rp on rp.role = p.role
            where p.id = p_user and p.active and rp.permission = p_permission))
$$;

-- Does an active department of the clinic give this desk?
create or replace function desk_offered(p_desk text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from department d
                 where d.active and d.deleted_at is null and p_desk = any (d.services))
$$;

-- Is the person in an active department that gives this desk?
create or replace function in_desk_department(p_user uuid, p_desk text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from staff_department sd
                 join department d on d.id = sd.department_id and d.active and d.deleted_at is null
                 where sd.profile_id = p_user and p_desk = any (d.services))
$$;

-- Why the person may use the desk ('manager', 'department', 'kept', 'role'), or null.
--   * The manager's "not allowed" for this employee on the desk's permission takes the desk away.
--     An "allowed" exception never adds a desk outside the ceiling or the departments: it only
--     stands for the role's permission below.
--   * Reception, triage and the treating desks still need the switch their functions check
--     (visit.start, vitals.write, clinical.write), so a desk is not shown that cannot be used.
create or replace function desk_via(p_user uuid, p_desk text)
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when p.role = 'manager' then 'manager'
    when not desk_key(p_desk) then null
    when ex.allowed = false then null
    -- the role's ceiling
    when not exists (select 1 from role_desk rd where rd.role = p.role and rd.desk = p_desk) then null
    when in_desk_department(p.id, p_desk)
         and (p_desk in ('laboratory', 'ultrasound', 'pharmacy') or coalesce(ex.allowed, rl.has)) then 'department'
    -- kept on day one by the rule of before (F)
    when coalesce(ex.allowed, rl.has)
         and exists (select 1 from staff_desk_keep k where k.profile_id = p.id and k.desk = p_desk) then 'kept'
    -- no department gives it: the role decides, as before
    when not desk_offered(p_desk) and coalesce(ex.allowed, rl.has)
         and desk_role_rule(p.role, p.station::text, p.specialty::text, p_desk) then 'role'
  end
  from profiles p
  cross join lateral (
    select exists (select 1 from role_permissions rp
                   where rp.role = p.role and rp.permission = desk_permission(p_desk)) as has
  ) rl
  left join staff_permission ex on ex.profile_id = p.id and ex.permission = desk_permission(p_desk)
  where p.id = p_user and p.active and p.deleted_at is null
$$;

-- May the signed-in person use this desk? Their own desks; a nurse covering a doctor also uses
-- his treating desks and triage (and the worklist of his own tests while no department gives it,
-- as before). Cover never passes on the pharmacy, reception or a department's worklist: the
-- doctor alone sets up cover, without the manager.
create or replace function may_use_desk(p_desk text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select desk_via(auth.uid(), p_desk) is not null
         or coalesce(
              (p_desk = any (treating_desks() || array['triage'])
               and desk_via(covering_for(auth.uid()), p_desk) is not null)
              or (p_desk in ('laboratory', 'ultrasound')
                  and desk_via(covering_for(auth.uid()), p_desk) = 'role'), false)
$$;

create or replace function may_use_any_desk(p_desks text[])
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from unnest(coalesce(p_desks, '{}')) as d(desk) where may_use_desk(d.desk))
$$;

-- The refusal every desk function gives (the app shows "ask the manager").
create or replace function assert_desk(p_desks text[], p_what text default null)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if not may_use_any_desk(p_desks) then
    raise exception 'not allowed: you do not work in a department that does this (%); ask the manager',
      coalesce(p_what, array_to_string(p_desks, ', '))
      using errcode = '42501', hint = 'no_desk';
  end if;
end
$$;

-- A task given to a role: nurse tasks go to the people who give nursing care when a department
-- does; otherwise (and for the other roles) the role decides, as before.
create or replace function task_for_me(p_assigned_role role_key)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    when p_assigned_role is null then false
    when p_assigned_role = 'nurse' and desk_offered('nursing') then may_use_desk('nursing')
    else p_assigned_role = current_role_key()
  end
$$;

-- The desks of one employee (the staff list, the employee form) and of the signed-in person.
create or replace function desks_of(p_profile_id uuid)
returns text[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(d.desk order by d.n), '{}')
  from unnest(all_desks()) with ordinality as d(desk, n)
  where auth.uid() is not null and desk_via(p_profile_id, d.desk) is not null
$$;

create or replace function my_desk_list()
returns text[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(d.desk order by d.n), '{}')
  from unnest(all_desks()) with ordinality as d(desk, n)
  where may_use_desk(d.desk)
$$;

-- What the app needs to build menus and home pages:
--   desks    the desks the person may use now;
--   via      why, per desk: manager | department | kept (day one) | role (no department gives it) | cover;
--   offered  the desks some active department gives (the others follow the role);
--   ceiling  the desks the person's role may ever use.
create or replace function my_desks()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'desks', to_jsonb(my_desk_list()),
    'via', coalesce((
      select jsonb_object_agg(d.desk, coalesce(desk_via(auth.uid(), d.desk), 'cover'))
      from unnest(all_desks()) as d(desk) where may_use_desk(d.desk)), '{}'::jsonb),
    'offered', coalesce((
      select jsonb_agg(d.desk order by d.n) from unnest(all_desks()) with ordinality as d(desk, n)
      where desk_offered(d.desk)), '[]'::jsonb),
    'ceiling', case when is_manager() then to_jsonb(all_desks()) else coalesce((
      select jsonb_agg(d.desk order by d.n) from unnest(all_desks()) with ordinality as d(desk, n)
      where exists (select 1 from role_desk rd where rd.role = current_role_key() and rd.desk = d.desk)),
      '[]'::jsonb) end
  )
  where auth.uid() is not null
$$;

-- ---------------------------------------------------------------- B the manager sets the ceilings
create or replace function role_desk_matrix()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case when is_manager() then jsonb_build_object(
    'desks', to_jsonb(all_desks()),
    'roles', coalesce((select jsonb_object_agg(r.role, r.desks) from (
        select rd.role::text as role, jsonb_agg(rd.desk order by array_position(all_desks(), rd.desk)) as desks
        from role_desk rd group by rd.role) r), '{}'::jsonb),
    'offered', coalesce((
      select jsonb_agg(d.desk order by d.n) from unnest(all_desks()) with ordinality as d(desk, n)
      where desk_offered(d.desk)), '[]'::jsonb)
  ) end
$$;

create or replace function set_role_desk(p_role role_key, p_desk text, p_allowed boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not desk_key(p_desk) then
    raise exception 'unknown desk %', p_desk using errcode = '22023';
  end if;
  if p_role = 'manager' then
    raise exception 'the manager keeps every desk' using errcode = '22023';
  end if;
  if p_allowed then
    insert into role_desk (role, desk) values (p_role, p_desk) on conflict do nothing;
  else
    delete from role_desk where role = p_role and desk = p_desk;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'setting', null,
          jsonb_build_object('key', 'desks', 'role', p_role, 'desk', p_desk, 'allowed', p_allowed));
end
$$;

-- The manager takes away a desk kept on day one (F) — the employee then follows their departments.
create or replace function forget_kept_desk(p_profile_id uuid, p_desk text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from staff_desk_keep where profile_id = p_profile_id and desk = p_desk;
  if found then
    insert into audit_event (actor_id, action, entity, entity_id, after, reason)
    values (auth.uid(), 'update', 'profiles', p_profile_id,
            jsonb_build_object('key', 'desk_kept_removed', 'desk', p_desk),
            'a desk kept from before departments decided desks was taken away');
  end if;
end
$$;

-- The desks kept on day one, per employee (the employee form shows them to the manager).
create or replace function kept_desks_of(p_profile_id uuid)
returns text[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(k.desk order by array_position(all_desks(), k.desk)), '{}')
  from staff_desk_keep k
  where k.profile_id = p_profile_id and auth.uid() is not null
$$;

-- ---------------------------------------------------------------- departments may give reception
create or replace function upsert_department(
  p_id uuid,
  p_name text,
  p_description text,
  p_roles role_key[],
  p_services text[] default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_bad text;
  v_new text[];
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'the department needs a name' using errcode = '22023';
  end if;
  -- the services of 0071, and reception (0085)
  select s into v_bad from unnest(coalesce(p_services, '{}')) s where not desk_key(s) limit 1;
  if v_bad is not null then
    raise exception 'unknown service %', v_bad using errcode = '22023';
  end if;
  -- the desks no department gives yet: once this one does, only departments decide them
  select array_agg(s) into v_new from unnest(coalesce(p_services, '{}')) s where not desk_offered(s);
  if v_id is null then
    insert into department (name, description, roles, services)
    values (trim(p_name), nullif(trim(coalesce(p_description, '')), ''), coalesce(p_roles, '{}'),
            coalesce(p_services, '{}'))
    returning id into v_id;
  else
    update department set name = trim(p_name), description = nullif(trim(coalesce(p_description, '')), ''),
                          roles = coalesce(p_roles, '{}'), services = coalesce(p_services, services)
    where id = v_id and deleted_at is null;
    if not found then
      raise exception 'department not found' using errcode = 'P0002';
    end if;
    -- Heads follow the department's name on their dashboard.
    update profiles set head_of = trim(p_name)
    where id in (select profile_id from staff_department where department_id = v_id and position = 'head');
  end if;
  -- a desk now given for the first time: the people who work there as usual are placed in it when
  -- nothing else changes for them; the manager is told who lost it (F)
  if exists (select 1 from unnest(coalesce(v_new, '{}')) s where desk_offered(s)) then
    perform place_staff_for_desks(false, v_new);
  end if;
  return v_id;
end
$$;

-- ---------------------------------------------------------------- G one head, one assistant
-- Departments with several assistants: the latest named stays assistant, the others are members.
with ranked as (
  select profile_id, department_id,
         row_number() over (partition by department_id order by created_at desc, profile_id) as n
  from staff_department where position = 'assistant'
)
update staff_department sd set position = 'member'
from ranked r
where r.profile_id = sd.profile_id and r.department_id = sd.department_id and r.n > 1;

update profiles p set position = 'member'
where p.position = 'assistant' and p.department_id is not null
  and exists (select 1 from staff_department sd where sd.profile_id = p.id
              and sd.department_id = p.department_id and sd.position = 'member');

-- Checked at the end of the statement: promoting the assistant to head makes the previous head the
-- assistant while the row being promoted is still written as assistant.
alter table staff_department drop constraint if exists staff_department_one_assistant;
alter table staff_department add constraint staff_department_one_assistant
  exclude using btree (department_id with =) where (position = 'assistant') deferrable initially deferred;

-- A new head: the previous head becomes the assistant (0073). A new assistant (or a previous head
-- made assistant): the previous assistant becomes a member.
create or replace function staff_department_one_head()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- the changes made below fire this trigger again: they are already decided here
  if coalesce(current_setting('mmc.lead_cascade', true), '') = 'on' then
    return new;
  end if;
  if new.position in ('head', 'assistant') then
    perform set_config('mmc.lead_cascade', 'on', true);
    if new.position = 'assistant'
       or exists (select 1 from staff_department where department_id = new.department_id
                  and position = 'head' and profile_id <> new.profile_id) then
      update staff_department set position = 'member'
      where department_id = new.department_id and position = 'assistant' and profile_id <> new.profile_id;
      update profiles set position = 'member'
      where department_id = new.department_id and position = 'assistant' and id <> new.profile_id;
    end if;
    if new.position = 'head' then
      update staff_department set position = 'assistant'
      where department_id = new.department_id and position = 'head' and profile_id <> new.profile_id;
      update profiles set position = 'assistant'
      where department_id = new.department_id and position = 'head' and id <> new.profile_id;
    end if;
    perform set_config('mmc.lead_cascade', '', true);
  end if;
  return new;
end
$$;
drop trigger if exists staff_department_one_head on staff_department;
create trigger staff_department_one_head before insert or update of position, department_id on staff_department
  for each row execute function staff_department_one_head();

-- ---------------------------------------------------------------- E laboratory and ultrasound
-- record_result (from 20261104090000_desks_last_items): results: the laboratory or ultrasound desk (by the test), or the clinical staff of the desk that did it.
create or replace function record_result(
  p_request_id uuid,
  p_findings text,
  p_impression text,
  p_verify boolean default true
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req service_request%rowtype;
  v_test text;
  v_name text;
  v_station station;
  v_q queue_entry%rowtype;
  v_tests text;
begin
  select * into v_req from service_request where id = p_request_id and deleted_at is null;
  if not found then
    raise exception 'test order not found' using errcode = 'P0002';
  end if;
  -- Lab / ultrasound results: lab staff and clinicians who order; an order done at another desk
  -- (Nursing, Dental…): the clinical staff of that desk too.
  if not (may_use_desk(request_desk(v_req.station, v_req.category))
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound')
              and may_use_any_desk(station_desks(v_req.station)))
          -- the clinician's own test while no department gives that desk (as before 0085)
          or (has_perm('orders.write') and v_req.requester_id = auth.uid()
              and not desk_offered(request_desk(v_req.station, v_req.category)))) then
    perform assert_desk(array[request_desk(v_req.station, v_req.category)]);
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_req.status = 'cancelled' then
    raise exception 'this test was marked "not done": order it again if it is done after all' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_findings, '')), '') is null and nullif(trim(coalesce(p_impression, '')), '') is null then
    raise exception 'write the findings or the conclusion' using errcode = '22023';
  end if;
  if exists (select 1 from diagnostic_report where service_request_id = p_request_id
             and deleted_at is null and verified_at is not null) then
    raise exception 'this result is verified: correct it, giving the reason' using errcode = '22023';
  end if;
  insert into diagnostic_report (service_request_id, findings, impression, verified_by, verified_at)
  values (p_request_id, nullif(trim(coalesce(p_findings, '')), ''), nullif(trim(coalesce(p_impression, '')), ''),
          case when p_verify then auth.uid() end, case when p_verify then now() end)
  on conflict (service_request_id) do update
  set findings = excluded.findings, impression = excluded.impression,
      verified_by = excluded.verified_by, verified_at = excluded.verified_at, updated_at = now();
  update service_request set status = case when p_verify then 'verified'::request_status else 'resulted'::request_status end
  where id = p_request_id;
  -- Tell the doctor who ordered it.
  if v_req.requester_id is not null and v_req.requester_id is distinct from auth.uid() then
    select s.name_en into v_test from service s where s.id = v_req.service_id;
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_req.encounter_id;
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('result',
            jsonb_build_object('test', v_test, 'name', v_name,
                               'impression', nullif(trim(coalesce(p_impression, '')), ''),
                               'verified', p_verify),
            '/app/visit?encounter=' || v_req.encounter_id,
            v_req.requester_id, auth.uid());
  end if;
  -- Last result of this desk written: the patient goes back to the doctor.
  v_station := coalesce(v_req.station, case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end);
  perform after_desk_tests(v_req.encounter_id, v_station, v_req.requester_id);
end
$$;

-- set_request_status (from 20261102210000_desks_polished): sample taken, analysing, not done: as record_result.
create or replace function set_request_status(p_id uuid, p_status request_status, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req service_request%rowtype;
  v_test text;
  v_name text;
  v_line uuid;
  v_invoice uuid;
begin
  select * into v_req from service_request where id = p_id;
  -- the lab and imaging (orders.write); an order done at another desk (Nursing, Dental…): the
  -- clinical staff of that desk too
  if not (may_use_desk(request_desk(v_req.station, v_req.category))
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound')
              and may_use_any_desk(station_desks(v_req.station)))
          -- the clinician's own test while no department gives that desk (as before 0085)
          or (has_perm('orders.write') and v_req.requester_id = auth.uid()
              and not desk_offered(request_desk(v_req.station, v_req.category)))) then
    perform assert_desk(array[request_desk(v_req.station, v_req.category)]);
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_status not in ('collected', 'in_process', 'cancelled') then
    raise exception 'use record_result for results' using errcode = '22023';
  end if;
  if p_status = 'cancelled' and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'a reason is required to cancel a test' using errcode = '22023';
  end if;
  update service_request
  set status = p_status,
      reason = case when p_status = 'cancelled' then coalesce(reason || ' · ', '') || 'cancelled: ' || trim(p_reason) else reason end
  where id = p_id and deleted_at is null and status not in ('verified', 'cancelled');
  if not found then
    raise exception 'test not found or already finished' using errcode = 'P0002';
  end if;
  -- sample taken / analysing: the patient is being seen at that desk
  if p_status in ('collected', 'in_process') then
    update queue_entry q set started_at = coalesce(q.started_at, now()), called_at = coalesce(q.called_at, now()),
                             taken_by = coalesce(q.taken_by, auth.uid())
    where q.encounter_id = v_req.encounter_id and q.finished_at is null and q.deleted_at is null
      and q.station = coalesce(v_req.station, case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end);
  end if;
  if p_status = 'cancelled' then
    select * into v_req from service_request where id = p_id;
    -- not done, not paid: its charge leaves the bill while the bill is open
    update invoice_line l
    set deleted_at = now(), manual_reason = coalesce(l.manual_reason || ' · ', '') || 'removed: test not done: ' || trim(p_reason)
    from invoice i
    where l.source_type = 'service_request' and l.source_id = p_id and l.deleted_at is null
      and i.id = l.invoice_id and i.status = 'draft'
    returning l.id, l.invoice_id into v_line, v_invoice;
    if v_invoice is not null then
      perform recompute_invoice(v_invoice);
    end if;
    -- the doctor who ordered it is told
    if v_req.requester_id is not null and v_req.requester_id is distinct from auth.uid() then
      select s.name_en into v_test from service s where s.id = v_req.service_id;
      select p.surname || ' ' || p.given_names into v_name
      from encounter e join patient p on p.id = e.patient_id where e.id = v_req.encounter_id;
      insert into notification (kind, params, link, recipient_user, created_by)
      values ('test_cancelled', jsonb_build_object('test', v_test, 'name', v_name, 'reason', trim(p_reason)),
              '/app/visit?encounter=' || v_req.encounter_id, v_req.requester_id, auth.uid());
    end if;
    perform after_desk_tests(v_req.encounter_id,
      coalesce(v_req.station, case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end),
      v_req.requester_id);
  end if;
end
$$;

-- lab_worklist (from 20261125090000_document_details): the lab list: the tests of the desks the person uses (read once, not per test).
create or replace function lab_worklist(p_scope text default 'open')
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.prio, x.at), '[]'::jsonb)
  from (
    select r.priority as prio, r.created_at as at, doc_patient(p.id, e.id) || jsonb_build_object(
      'id', r.id, 'encounterId', r.encounter_id, 'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'sex', p.sex, 'birthDate', p.birth_date,
      'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = r.encounter_id order by q.created_at limit 1),
      'triage', e.triage_level,
      'test', s.name_en, 'category', r.category, 'status', r.status, 'priority', r.priority,
      'reason', r.reason, 'orderedAt', r.created_at,
      'orderedBy', (select full_name from profiles where id = r.requester_id),
      'findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
      'corrected', d.corrected_at is not null,
      'resultAt', coalesce(d.verified_at, d.updated_at),
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
      'resultByPerson', doc_person(coalesce(d.verified_by, d.created_by)),
      'visitReference', e.reference, 'visitAt', e.arrived_at
    ) as j
    from service_request r
    join encounter e on e.id = r.encounter_id and (p_scope = 'done' or e.status = 'open')
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and has_perm('orders.read')
      and r.category in (select unnest(my_test_categories())) and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) in ('laboratory', 'ultrasound')
      and case when p_scope = 'done'
            then r.status in ('resulted', 'verified')
                 and (coalesce(d.verified_at, d.updated_at) at time zone 'Africa/Kigali')::date
                     = (now() at time zone 'Africa/Kigali')::date
            else r.status not in ('verified', 'cancelled') end
  ) x
$$;

-- lab_summary (from 20261116090000_dashboards_by_period): the lab figures: as lab_worklist.
create or replace function lab_summary(p_from date default null, p_to date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with today as (
    select coalesce(p_from, k) as f, coalesce(p_to, p_from, k) as t
    from (select (now() at time zone 'Africa/Kigali')::date as k) z
  ),
  mine as (
    select r.*, d.verified_at, d.updated_at as result_at
    from service_request r
    join encounter e on e.id = r.encounter_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and r.category in (select unnest(my_test_categories()))
      -- a finished visit's open test is no longer on the bench
      and (e.status = 'open' or r.status in ('resulted', 'verified', 'cancelled')) and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) in ('laboratory', 'ultrasound') and has_perm('orders.read')
  )
  select jsonb_build_object(
    'waiting', (select count(*) from mine where status = 'ordered'),
    'inProcess', (select count(*) from mine where status in ('collected', 'in_process')),
    'toVerify', (select count(*) from mine where status = 'resulted'),
    'doneToday', (select count(*) from mine, today
                  where status = 'verified' and (verified_at at time zone 'Africa/Kigali')::date between today.f and today.t),
    'urgent', (select count(*) from mine where status not in ('verified', 'cancelled') and priority <= 2),
    'orderedToday', (select count(*) from mine, today where (created_at at time zone 'Africa/Kigali')::date between today.f and today.t),
    'turnaroundMin', (select coalesce(round(avg(extract(epoch from verified_at - created_at) / 60)), 0)
                      from mine, today
                      where verified_at is not null and (verified_at at time zone 'Africa/Kigali')::date between today.f and today.t),
    'notDone', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', m.id, 'test', s.name_en, 'at', m.updated_at, 'encounterId', m.encounter_id,
          'patient', p.surname || ' ' || p.given_names,
          'reason', nullif(regexp_replace(coalesce(m.reason, ''), '^.*cancelled: ', ''), '')
        ) order by m.updated_at desc)
      from mine m
      join service s on s.id = m.service_id
      join encounter e on e.id = m.encounter_id
      join patient p on p.id = e.patient_id, today
      where m.status = 'cancelled' and (m.updated_at at time zone 'Africa/Kigali')::date between today.f and today.t
    ), '[]'::jsonb),
    'served', (select count(distinct q.encounter_id) from queue_entry q, today
               where q.deleted_at is null and q.station in ('laboratory', 'ultrasound') and q.finished_at is not null
                 and (q.finished_at at time zone 'Africa/Kigali')::date between today.f and today.t),
    'byTest', coalesce((
      select jsonb_agg(jsonb_build_object('test', t.name, 'count', t.n) order by t.n desc)
      from (select s.name_en as name, count(*) as n
            from mine m join service s on s.id = m.service_id, today
            where (m.created_at at time zone 'Africa/Kigali')::date between today.f and today.t
            group by s.name_en order by count(*) desc limit 8) t
    ), '[]'::jsonb)
  )
$$;

-- correct_result (from 20261104090000_desks_last_items): a verified result corrected: as record_result, and the manager.
create or replace function correct_result(
  p_request_id uuid,
  p_findings text,
  p_impression text,
  p_reason text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req service_request%rowtype;
  v_rep diagnostic_report%rowtype;
  v_test text;
  v_name text;
begin
  select * into v_req from service_request where id = p_request_id and deleted_at is null;
  if not found then
    raise exception 'test order not found' using errcode = 'P0002';
  end if;
  if not (is_manager() or may_use_desk(request_desk(v_req.station, v_req.category))
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound')
              and may_use_any_desk(station_desks(v_req.station)))
          -- the clinician's own test while no department gives that desk (as before 0085)
          or (has_perm('orders.write') and v_req.requester_id = auth.uid()
              and not desk_offered(request_desk(v_req.station, v_req.category)))) then
    perform assert_desk(array[request_desk(v_req.station, v_req.category)]);
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the result is corrected' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_findings, '')), '') is null and nullif(trim(coalesce(p_impression, '')), '') is null then
    raise exception 'write the findings or the conclusion' using errcode = '22023';
  end if;
  select * into v_rep from diagnostic_report where service_request_id = p_request_id and deleted_at is null for update;
  if not found or v_rep.verified_at is null then
    raise exception 'only a verified result is corrected; edit the result instead' using errcode = '22023';
  end if;
  insert into report_correction (report_id, old_findings, old_impression, old_verified_by, old_verified_at, reason)
  values (v_rep.id, v_rep.findings, v_rep.impression, v_rep.verified_by, v_rep.verified_at, trim(p_reason));
  perform set_config('mmc.correcting_report', v_rep.id::text, true);
  update diagnostic_report
  set findings = nullif(trim(coalesce(p_findings, '')), ''), impression = nullif(trim(coalesce(p_impression, '')), ''),
      verified_by = auth.uid(), verified_at = now(), corrected_at = now(), correction_reason = trim(p_reason),
      updated_at = now()
  where id = v_rep.id;
  perform set_config('mmc.correcting_report', '', true);
  -- The doctor who ordered the test is told the result changed.
  if v_req.requester_id is not null and v_req.requester_id is distinct from auth.uid() then
    select s.name_en into v_test from service s where s.id = v_req.service_id;
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_req.encounter_id;
    insert into notification (kind, params, link, recipient_user, urgent, created_by)
    values ('result',
            jsonb_build_object('test', v_test, 'name', v_name,
                               'impression', nullif(trim(coalesce(p_impression, '')), ''),
                               'verified', true, 'corrected', true, 'reason', trim(p_reason)),
            '/app/visit?encounter=' || v_req.encounter_id,
            v_req.requester_id, true, auth.uid());
  end if;
end
$$;

-- ---------------------------------------------------------------- E pharmacy
-- dispense_fefo (from 20261123090000_dispensing_fixes): the batches taken for a hand-over: the pharmacy desk.
create or replace function dispense_fefo(
  p_encounter_id uuid,
  p_item_id uuid,
  p_quantity integer,
  p_location_id uuid,
  p_medication_request_id uuid default null,
  p_substitution_reason text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_remaining integer := p_quantity;
  v_row record;
  v_take integer;
  v_dispense_id uuid;
  v_first boolean := true;
begin
  perform assert_desk(array['pharmacy'], 'the pharmacy');
  if p_quantity <= 0 then
    raise exception 'quantity must be positive' using errcode = '22023';
  end if;
  -- handed over and sold from an open pharmacy store only (room stores give with give_from_store)
  if not exists (select 1 from stock_location where id = p_location_id and type = 'pharmacy'
                 and active and deleted_at is null) then
    raise exception 'choose an open pharmacy store' using errcode = '22023';
  end if;
  -- the balance is read after the lock: nobody else takes the same units meanwhile
  perform lock_stock(p_item_id, p_location_id);
  for v_row in
    select s.batch_id, s.quantity
    from stock_on_hand s
    where s.item_id = p_item_id and s.location_id = p_location_id and s.quantity > 0 and s.batch_id is not null
      and (s.expiry is null or s.expiry >= current_date)   -- never an expired batch
    order by s.expiry asc nulls last
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.quantity, v_remaining);
    if v_first then
      insert into medication_dispense (medication_request_id, encounter_id, item_id, batch_id, quantity, substitution_reason)
      values (p_medication_request_id, p_encounter_id, p_item_id, v_row.batch_id, p_quantity, p_substitution_reason)
      returning id into v_dispense_id;
      v_first := false;
    end if;
    insert into stock_movement (item_id, batch_id, from_location_id, quantity, type, dispense_id, medication_request_id)
    values (p_item_id, v_row.batch_id, p_location_id, v_take, 'dispense', v_dispense_id, p_medication_request_id);
    v_remaining := v_remaining - v_take;
  end loop;
  if v_remaining > 0 then
    if exists (select 1 from stock_on_hand s where s.item_id = p_item_id and s.location_id = p_location_id
               and s.quantity > 0 and s.expiry < current_date) then
      raise exception 'not enough stock that is not expired: % unit(s) short (write the expired stock off)', v_remaining
        using errcode = '23514', hint = 'expired_short';
    end if;
    raise exception 'insufficient stock: % unit(s) short', v_remaining using errcode = '23514', hint = 'short';
  end if;
  return v_dispense_id;
end
$$;

-- dispense_prescription (from 20261123090000_dispensing_fixes): hand over a prescription: the pharmacy desk.
create or replace function dispense_prescription(p_medication_request_id uuid, p_location_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_loc uuid;
  v_dispense uuid;
  v_charged boolean := false;
begin
  perform assert_desk(array['pharmacy'], 'the pharmacy');
  select * into v_m from medication_request where id = p_medication_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  if v_m.cancelled_at is not null then
    raise exception 'the doctor cancelled this medicine' using errcode = '23505';
  end if;
  if v_m.given_at is not null or exists (select 1 from medication_dispense d where d.medication_request_id = v_m.id and d.deleted_at is null) then
    raise exception 'already dispensed' using errcode = '23505';
  end if;
  if v_m.not_given_at is not null then
    raise exception 'this medicine was marked as not given' using errcode = '23505';
  end if;
  -- The prescription is final once the doctor has finished (or sent the patient on). A sale written
  -- by the pharmacist themself is not held.
  if coalesce(v_m.prescriber_id, v_m.created_by) is distinct from auth.uid() and doctor_holds(v_m.encounter_id) then
    raise exception 'the doctor is still seeing this patient: hand the medicines over when the doctor has finished'
      using errcode = 'MS002', hint = 'doctor_holds';
  end if;
  if p_location_id is not null then
    if not exists (select 1 from stock_location where id = p_location_id and type = 'pharmacy'
                   and active and deleted_at is null) then
      raise exception 'choose an open pharmacy store' using errcode = '22023';
    end if;
    v_loc := p_location_id;
  else
    v_loc := main_pharmacy();
  end if;
  if v_loc is null then
    raise exception 'no pharmacy store yet: create one under Stock' using errcode = 'P0002';
  end if;
  v_dispense := dispense_fefo(v_m.encounter_id, v_m.item_id, ceil(v_m.quantity)::integer, v_loc, v_m.id, null);
  -- no price: handed over free (charged = false); no open bill: refused (MS001)
  begin
    perform add_charge_internal(v_m.encounter_id, 'pharmacy'::station, null, v_m.item_id, v_m.quantity,
                       null, null, null, null, 'medication_dispense', v_dispense);
    v_charged := true;
  exception when sqlstate 'P0002' then
    v_charged := false;
  end;
  update medication_request set given_at = now(), given_by = auth.uid() where id = v_m.id;
  -- the last line handed over: on to the cashier (money due) or the visit closes
  perform after_pharmacy(v_m.encounter_id);
  return jsonb_build_object('dispenseId', v_dispense, 'charged', v_charged, 'locationId', v_loc);
end
$$;

-- rx_not_given (from 20261102090000_lab_pharmacy_desks): "not given": the pharmacy desk.
create or replace function rx_not_given(p_medication_request_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_item text;
  v_name text;
begin
  perform assert_desk(array['pharmacy'], 'the pharmacy');
  if length(trim(coalesce(p_reason, ''))) < 2 then
    raise exception 'say why the medicine is not given' using errcode = '22023';
  end if;
  select * into v_m from medication_request where id = p_medication_request_id for update;
  if not found or not rx_pending(v_m) then
    raise exception 'this medicine is no longer waiting at the pharmacy' using errcode = 'P0002';
  end if;
  update medication_request
  set not_given_at = now(), not_given_by = auth.uid(), not_given_reason = trim(p_reason)
  where id = v_m.id;
  select i.name_generic || coalesce(' ' || i.strength, '') into v_item from item i where i.id = v_m.item_id;
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
  if coalesce(v_m.prescriber_id, v_m.created_by) is not null
     and coalesce(v_m.prescriber_id, v_m.created_by) is distinct from auth.uid() then
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('rx_not_given', jsonb_build_object('item', v_item, 'name', v_name, 'reason', trim(p_reason)),
            '/app/visit?encounter=' || v_m.encounter_id, coalesce(v_m.prescriber_id, v_m.created_by), auth.uid());
  end if;
  perform after_pharmacy(v_m.encounter_id);
end
$$;

-- sell_medicine (from 20261123090000_dispensing_fixes): a counter sale line: the pharmacy desk.
create or replace function sell_medicine(
  p_encounter_id uuid,
  p_item_id uuid,
  p_quantity numeric,
  p_instructions text default null,
  p_location_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  perform assert_desk(array['pharmacy'], 'the pharmacy');
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'the quantity must be more than zero' using errcode = '22023';
  end if;
  if not exists (select 1 from item where id = p_item_id and deleted_at is null) then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  insert into medication_request (encounter_id, item_id, quantity, instructions, supply, prescriber_id)
  values (p_encounter_id, p_item_id, p_quantity,
          coalesce(nullif(trim(coalesce(p_instructions, '')), ''), 'Pharmacy sale'), 'pharmacy', auth.uid())
  returning id into v_id;
  return dispense_prescription(v_id, p_location_id) || jsonb_build_object('requestId', v_id);
end
$$;

-- return_medicine (from 20261123090000_dispensing_fixes): a medicine brought back: the pharmacy desk (the manager has every desk).
create or replace function return_medicine(p_medication_request_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_d medication_dispense%rowtype;
  v_inv invoice%rowtype;
  v_mv record;
  v_back integer := 0;
  v_patient numeric := 0;
  v_insurer numeric := 0;
  v_total numeric := 0;
  v_lines jsonb;
  v_cn uuid;
  v_year integer := extract(year from now())::integer;
  v_balance numeric;
  v_name text;
  v_item text;
begin
  perform assert_desk(array['pharmacy'], 'the pharmacy');
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the medicine comes back' using errcode = '22023';
  end if;
  select * into v_m from medication_request where id = p_medication_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  select * into v_d from medication_dispense
  where medication_request_id = v_m.id and deleted_at is null order by created_at desc limit 1;
  if not found then
    raise exception 'this medicine was not handed over by the pharmacy' using errcode = 'P0002';
  end if;
  if not is_manager()
     and (v_d.created_at at time zone 'Africa/Kigali')::date <> (now() at time zone 'Africa/Kigali')::date then
    raise exception 'a hand-over of another day is undone by the manager' using errcode = '42501';
  end if;
  select * into v_inv from invoice where encounter_id = v_m.encounter_id;
  -- On a posted bill the return is money (a credit note, a smaller insurer claim): the person's
  -- own right, which a department or cover never gives.
  if v_inv.id is not null and v_inv.status <> 'draft'
     and not (is_manager() or staff_perm(auth.uid(), 'stock.dispense') or has_perm('billing.write')) then
    raise exception 'a medicine on a posted bill is taken back by the pharmacist or the manager'
      using errcode = '42501';
  end if;
  -- the units go back where they came from
  for v_mv in
    select item_id, batch_id, from_location_id, quantity from stock_movement
    where dispense_id = v_d.id and type = 'dispense' and deleted_at is null
  loop
    insert into stock_movement (item_id, batch_id, to_location_id, quantity, type, reason, dispense_id, medication_request_id)
    values (v_mv.item_id, v_mv.batch_id, v_mv.from_location_id, v_mv.quantity, 'return', trim(p_reason), v_d.id, v_m.id);
    v_back := v_back + v_mv.quantity;
  end loop;
  update medication_dispense set deleted_at = now() where id = v_d.id;

  if v_inv.id is null or v_inv.status = 'draft' then
    -- the bill is still open: the line leaves it, and the medicine waits at the pharmacy again
    update invoice_line set deleted_at = now(),
           manual_reason = coalesce(manual_reason || ' · ', '') || 'returned: ' || trim(p_reason)
    where source_type = 'medication_dispense' and source_id = v_d.id and deleted_at is null;
    if v_inv.id is not null then
      perform recompute_invoice(v_inv.id);
    end if;
    update medication_request set given_at = null, given_by = null where id = v_m.id;
    if exists (select 1 from encounter where id = v_m.encounter_id and status = 'open')
       and not exists (select 1 from queue_entry where encounter_id = v_m.encounter_id and station = 'pharmacy'
                       and finished_at is null and deleted_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no)
      values (v_m.encounter_id, 'pharmacy',
              (select ticket_no from queue_entry where encounter_id = v_m.encounter_id order by created_at limit 1));
    end if;
    return jsonb_build_object('units', v_back, 'mode', 'bill', 'creditNoteId', null, 'credit', 0,
                              'balance', invoice_balance(v_inv.id));
  end if;

  -- The bill is posted: its lines never change. A credit note gives the line back: the patient's
  -- share lowers what they owe (or is money to give back at the cashier); the insurer's share
  -- leaves an open claim.
  select coalesce(sum(l.patient_share), 0), coalesce(sum(l.insurer_share), 0),
         coalesce(sum(round(l.unit_price * l.quantity)), 0),
         coalesce(jsonb_agg(jsonb_build_object('lineId', l.id, 'description', l.description, 'quantity', l.quantity,
                                               'unitPrice', l.unit_price, 'patientShare', l.patient_share,
                                               'insurerShare', l.insurer_share)), '[]'::jsonb)
  into v_patient, v_insurer, v_total, v_lines
  from invoice_line l
  where l.invoice_id = v_inv.id and l.source_type = 'medication_dispense' and l.source_id = v_d.id
    and l.deleted_at is null;
  if v_total > 0 then
    insert into credit_note (invoice_id, number, lines, total, reason, approver_id, patient_amount, insurer_amount,
                             source_type, source_id)
    values (v_inv.id, 'CN-' || v_year || '-' || lpad(next_number('credit_note', v_year)::text, 6, '0'),
            v_lines, v_total, 'returned: ' || trim(p_reason), auth.uid(), v_patient, v_insurer,
            'medication_dispense', v_d.id)
    returning id into v_cn;
    if v_insurer > 0 then
      update claim set amount = greatest(0, amount - v_insurer)
      where invoice_id = v_inv.id and status = 'open' and batch_id is null;
    end if;
  end if;
  -- the line is done: returned (it does not wait at the pharmacy again)
  update medication_request
  set given_at = null, given_by = null, not_given_at = now(), not_given_by = auth.uid(),
      not_given_reason = 'returned: ' || trim(p_reason)
  where id = v_m.id;
  v_balance := invoice_balance(v_inv.id);
  if v_balance < 0 then
    -- money to give back: the cashier is told
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
    select i.name_generic || coalesce(' ' || i.strength, '') into v_item from item i where i.id = v_m.item_id;
    insert into notification (kind, params, link, recipient_stations, created_by)
    values ('refund_due', jsonb_build_object('name', v_name, 'item', v_item, 'amount', -v_balance,
                                             'reason', trim(p_reason)),
            '/app/visit?encounter=' || v_m.encounter_id, array['cashier'::station], auth.uid());
  end if;
  return jsonb_build_object('units', v_back, 'mode', 'credit', 'creditNoteId', v_cn, 'credit', v_patient,
                            'balance', v_balance);
end
$$;

-- pharmacy_queue (from 20261123090000_dispensing_fixes): the pharmacy's list: the pharmacy desk.
create or replace function pharmacy_queue(p_location_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_loc uuid;
  v_stores jsonb;
  v_lines jsonb;
  v_patients jsonb;
begin
  -- the pharmacy and the manager only: the list carries allergies, prescriptions and bill amounts
  if not (may_use_desk('pharmacy') or is_manager()) then
    return jsonb_build_object('locationId', null, 'stores', '[]'::jsonb, 'lines', '[]'::jsonb, 'patients', '[]'::jsonb);
  end if;
  if p_location_id is not null then
    if not exists (select 1 from stock_location where id = p_location_id and type = 'pharmacy'
                   and active and deleted_at is null) then
      raise exception 'choose an open pharmacy store' using errcode = '22023';
    end if;
    v_loc := p_location_id;
  else
    v_loc := main_pharmacy();
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'isMain', l.id = main_pharmacy())
                            order by (l.id = main_pharmacy()) desc, l.created_at), '[]'::jsonb)
  into v_stores
  from stock_location l where l.type = 'pharmacy' and l.active and l.deleted_at is null;

  with lines as (
    select m.id, m.encounter_id, m.created_at, p.id as patient_id,
           p.surname || ' ' || p.given_names as patient, p.file_number, p.sex, p.birth_date, p.allergies,
           (select q.ticket_no from queue_entry q where q.encounter_id = m.encounter_id order by q.created_at limit 1) as ticket,
           m.item_id, i.name_generic || coalesce(' ' || i.strength, '') as item, i.selling_unit,
           i.prescribing_rule, m.quantity, m.dose, m.frequency, m.duration_days, m.instructions,
           pr.id as prescriber_id, pr.full_name as prescriber, pr.specialty,
           py.name as payer, cp.price as cash_price, pp.price as payer_price, pp.fallback,
           cov.pct,
           round(round(pp.price) * m.quantity) as line_total,
           doctor_holds(m.encounter_id) as holds
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open'
    join patient p on p.id = e.patient_id
    join item i on i.id = m.item_id
    left join invoice inv on inv.encounter_id = e.id
    left join payer py on py.id = inv.payer_id
    left join profiles pr on pr.id = coalesce(m.prescriber_id, m.created_by)
    left join lateral (select pf.price from price_for(null, m.item_id, null) pf) cp on true
    left join lateral (select pf.price, pf.fallback from price_for(null, m.item_id, inv.payer_id) pf) pp on true
    left join lateral (select coalesce(coverage_pct_for((select c.plan_id from coverage c where c.id = inv.coverage_id),
                                                        'pharmacy'::service_group), 0) as pct) cov on true
    where rx_pending(m)
  ), priced as (
    select l.*, round(coalesce(l.line_total, 0) * l.pct / 100) as insurer_share
    from lines l
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'requestId', x.id, 'encounterId', x.encounter_id, 'patientId', x.patient_id, 'patient', x.patient,
      'file', x.file_number, 'ticket', x.ticket,
      'itemId', x.item_id, 'item', x.item, 'unit', x.selling_unit,
      'quantity', x.quantity, 'dose', x.dose, 'frequency', x.frequency, 'days', x.duration_days,
      'instructions', x.instructions, 'prescriber', x.prescriber, 'prescriberId', x.prescriber_id, 'at', x.created_at,
      -- the cash price (as before) and what the bill will say
      'price', x.cash_price, 'cashPrice', x.cash_price, 'payerPrice', x.payer_price,
      'priced', x.payer_price is not null, 'payer', x.payer, 'coveragePct', x.pct,
      'lineTotal', coalesce(x.line_total, 0), 'insurerShare', x.insurer_share,
      'patientShare', coalesce(x.line_total, 0) - x.insurer_share,
      -- the stock of the store chosen at the desk
      'locationId', v_loc, 'pharmacyLocationId', v_loc,
      'onHandPharmacy', case when v_loc is null then 0 else usable_stock(x.item_id, v_loc) end,
      'expiredInPharmacy', (select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s
                            where s.item_id = x.item_id and s.location_id = v_loc and s.quantity > 0
                              and s.expiry < current_date),
      'onHandElsewhere', (select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s
                          join stock_location l on l.id = s.location_id
                          where s.item_id = x.item_id and l.id is distinct from v_loc and l.active and l.deleted_at is null
                            and s.quantity > 0 and (s.expiry is null or s.expiry >= current_date)),
      'doctorHolds', x.holds,
      -- the pharmacist's check
      'sex', x.sex, 'birthDate', x.birth_date,
      'ageYears', case when x.birth_date is not null then extract(year from age(current_date, x.birth_date))::integer end,
      'allergies', x.allergies,
      'prescribingRule', x.prescribing_rule, 'prescriberSpecialty', x.specialty,
      'ruleOk', rx_rule_ok(x.prescribing_rule, x.specialty)
    ) order by x.created_at), '[]'::jsonb)
  into v_lines
  from priced x;

  with lines as (
    select m.encounter_id, min(m.created_at) as first_at, count(*)::integer as n,
           sum(round(round(coalesce(pp.price, 0)) * m.quantity)) as total,
           sum(round(round(round(coalesce(pp.price, 0)) * m.quantity) * cov.pct / 100)) as insurer
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open'
    left join invoice inv on inv.encounter_id = e.id
    left join lateral (select pf.price from price_for(null, m.item_id, inv.payer_id) pf) pp on true
    left join lateral (select coalesce(coverage_pct_for((select c.plan_id from coverage c where c.id = inv.coverage_id),
                                                        'pharmacy'::service_group), 0) as pct) cov on true
    where rx_pending(m)
    group by m.encounter_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'encounterId', l.encounter_id, 'patientId', p.id, 'patient', p.surname || ' ' || p.given_names,
      'file', p.file_number,
      'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = l.encounter_id order by q.created_at limit 1),
      'sex', p.sex, 'birthDate', p.birth_date,
      'ageYears', case when p.birth_date is not null then extract(year from age(current_date, p.birth_date))::integer end,
      'ageMonths', case when p.birth_date is not null
                        then (extract(year from age(current_date, p.birth_date)) * 12
                              + extract(month from age(current_date, p.birth_date)))::integer end,
      'allergies', p.allergies, 'payer', py.name,
      'lines', l.n, 'total', l.total, 'insurerShare', l.insurer, 'patientShare', l.total - l.insurer,
      'balance', invoice_balance(inv.id),
      'doctorHolds', doctor_holds(l.encounter_id)
    ) order by l.first_at), '[]'::jsonb)
  into v_patients
  from lines l
  join encounter e on e.id = l.encounter_id
  join patient p on p.id = e.patient_id
  left join invoice inv on inv.encounter_id = e.id
  left join payer py on py.id = inv.payer_id;

  return jsonb_build_object('locationId', v_loc, 'stores', v_stores, 'lines', v_lines, 'patients', v_patients);
end
$$;

-- stock_admin (from 20261124090000_stores_and_stock): the pharmacy and main stores (and the counter sales): the manager and the pharmacy desk.
create or replace function stock_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select is_manager() or may_use_desk('pharmacy')
$$;

-- store_stock (from 20261124090000_stores_and_stock): a pharmacy store is managed by the pharmacy desk; a room store by its holders (unchanged).
create or replace function store_stock(p_location_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_l stock_location%rowtype;
  v_admin boolean := stock_admin();
  v_items jsonb;
  v_incoming jsonb;
begin
  select * into v_l from stock_location where id = p_location_id and deleted_at is null;
  if not found or v_l.type::text = 'transit' then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if not may_see_store(p_location_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'itemId', i.id, 'item', i.name_generic || coalesce(' ' || i.strength, ''), 'code', i.code,
      'unit', i.selling_unit, 'packSize', i.pack_size,
      'onHand', coalesce(t.on_hand, 0), 'usable', coalesce(t.usable, 0), 'expired', coalesce(t.expired, 0),
      'expiringSoon', coalesce(t.expiring, 0), 'earliestExpiry', t.next_expiry,
      'minLevel', m.min_level, 'low', m.min_level is not null and coalesce(t.usable, 0) < m.min_level,
      'price', (select pf.price from price_for(null, i.id, null) pf),
      'value', case when v_admin then coalesce(t.value, 0) end,
      'batches', coalesce(t.batches, '[]'::jsonb)
    ) order by i.name_generic), '[]'::jsonb)
  into v_items
  from item i
  left join store_item_level m on m.location_id = p_location_id and m.item_id = i.id
  left join lateral (
    select sum(s.quantity)::integer as on_hand,
           sum(s.quantity) filter (where s.expiry is null or s.expiry >= current_date)::integer as usable,
           sum(s.quantity) filter (where s.expiry < current_date)::integer as expired,
           sum(s.quantity) filter (where s.expiry between current_date and current_date + 90)::integer as expiring,
           min(s.expiry) filter (where s.expiry >= current_date) as next_expiry,
           sum(s.quantity * coalesce(b.unit_cost, 0)) as value,
           jsonb_agg(jsonb_build_object('batchId', s.batch_id, 'batchNo', b.batch_no, 'expiry', s.expiry,
                                        'quantity', s.quantity, 'expired', s.expiry < current_date,
                                        'unitCost', case when v_admin then b.unit_cost end)
                     order by s.expiry nulls last) as batches
    from stock_on_hand s left join batch b on b.id = s.batch_id
    where s.item_id = i.id and s.location_id = p_location_id and s.quantity > 0
  ) t on true
  where i.deleted_at is null and (t.on_hand is not null or m.min_level is not null);

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'number', t.number, 'direction', t.direction, 'sentAt', t.sent_at,
      'from', lf.name, 'to', lt.name,
      'lines', (select count(*) from stock_transfer_line x where x.transfer_id = t.id)::integer,
      'units', (select coalesce(sum(x.quantity), 0) from stock_transfer_line x where x.transfer_id = t.id)::integer
    ) order by t.sent_at), '[]'::jsonb)
  into v_incoming
  from stock_transfer t
  join stock_location lf on lf.id = t.from_location_id
  join stock_location lt on lt.id = t.to_location_id
  where t.status = 'in_transit' and (t.to_location_id = p_location_id or t.from_location_id = p_location_id);

  return jsonb_build_object(
    'store', jsonb_build_object('id', v_l.id, 'name', v_l.name, 'type', v_l.type, 'active', v_l.active,
                                'isMain', v_l.is_main, 'isRoom', is_room_type(v_l.type),
                                'holders', store_holders(v_l.id)),
    'held', holds_store(auth.uid(), v_l.id),
    -- count and write off: the holders (room store) or the pharmacy (pharmacy and main stores); the manager
    'canManage', is_manager() or case when is_room_type(v_l.type) then holds_store(auth.uid(), v_l.id)
                                       else may_use_desk('pharmacy') end,
    'items', v_items,
    'onTheWay', v_incoming,
    'value', case when v_admin then (select coalesce(sum(s.quantity * coalesce(b.unit_cost, 0)), 0)
                                     from stock_on_hand s left join batch b on b.id = s.batch_id
                                     where s.location_id = p_location_id and s.quantity > 0) end
  );
end
$$;

-- ---------------------------------------------------------------- E triage
-- record_vitals (from 20261119090000_audit_fixes): vitals of a patient waiting at triage: the triage desk (later measurements: vitals.write, as before).
create or replace function record_vitals(
  p_encounter_id uuid,
  p_vitals jsonb,
  p_triage triage_level default null,
  p_next_station station default null,
  p_reason text default null,
  p_measured_by uuid default null,
  p_measured_at timestamptz default null
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_key text;
  v_val numeric;
  v_count integer := 0;
  v_by uuid := coalesce(p_measured_by, auth.uid());
  v_at timestamptz := coalesce(p_measured_at, now());
  v_arrived timestamptz;
  v_at_triage boolean;
  v_units jsonb := '{"bp_sys":"mmHg","bp_dia":"mmHg","pulse":"bpm","temp":"°C","resp":"/min","spo2":"%","weight":"kg","height":"cm","muac":"cm"}'::jsonb;
begin
  if not has_perm('vitals.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select arrived_at into v_arrived from encounter where id = p_encounter_id and status = 'open';
  if not found then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  select exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'triage'
                 and finished_at is null and deleted_at is null) into v_at_triage;
  -- At triage: the people of a department that does triage (when none does, as before).
  if v_at_triage then
    perform assert_desk(array['triage'], 'triage');
  end if;
  -- Sending on from triage is for whoever may work on the patient (as with "Send on"): reception
  -- that sent the patient to triage, or a nurse other than the one named, records only.
  if v_at_triage and p_next_station is not null and not may_route(p_encounter_id) then
    if current_role_key() = 'receptionist' then
      raise exception 'this patient is with %: record the measurements without choosing where they go next; the nurse there sends them on',
        coalesce(patient_holder(p_encounter_id), 'triage') using errcode = '42501';
    end if;
    perform assert_may_work_on(p_encounter_id, true);
  end if;
  -- Without clinical rights the person typing must name who measured.
  if not has_perm('clinical.write') and (p_measured_by is null or p_measured_by = auth.uid()) then
    raise exception 'choose the nurse who took the measurements' using errcode = '22023';
  end if;
  if not exists (select 1 from profiles where id = v_by and active) then
    raise exception 'unknown staff member for "measured by"' using errcode = '22023';
  end if;
  if v_at > now() + interval '5 minutes' then
    raise exception 'the measurement time is in the future' using errcode = '22023';
  end if;
  if v_at < v_arrived - interval '1 hour' then
    raise exception 'the measurement time is before the patient arrived' using errcode = '22023';
  end if;

  for v_key, v_val in
    select key, nullif(value, '')::numeric from jsonb_each_text(coalesce(p_vitals, '{}'::jsonb))
  loop
    if v_val is not null and v_units ? v_key then
      insert into observation (encounter_id, code, value_num, unit, performer_id, effective_at)
      values (p_encounter_id, v_key, v_val, v_units ->> v_key, v_by, v_at);
      v_count := v_count + 1;
    end if;
  end loop;
  if v_count = 0 then
    raise exception 'enter at least one measurement' using errcode = '22023';
  end if;

  if v_by <> auth.uid() then
    insert into audit_event (actor_id, action, entity, entity_id, after, reason)
    values (auth.uid(), 'create', 'observation', p_encounter_id,
            jsonb_build_object('measured_by', v_by, 'measured_at', v_at, 'count', v_count),
            'vitals entered on behalf of the person who measured');
  end if;

  if p_triage is not null then
    update encounter set triage_level = p_triage, triage_reason = coalesce(p_reason, triage_reason)
    where id = p_encounter_id;
    -- the colour reorders the places where the patient waits (red first)
    update queue_entry set priority = case p_triage when 'red' then 1 when 'yellow' then 2 else 3 end
    where encounter_id = p_encounter_id and finished_at is null and started_at is null and deleted_at is null;
  end if;

  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;

  -- At triage: close the triage turn and send the patient on. Later (e.g. the doctor typing
  -- the nurse's paper sheet): measurements only, the patient stays where they are.
  if v_at_triage and p_next_station is not null then
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = 'triage' and finished_at is null;
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, p_next_station, v_ticket,
            case coalesce(p_triage, 'green') when 'red' then 1 when 'yellow' then 2 else 3 end);
  end if;
  return v_ticket;
end
$$;

-- send_from_triage (from 20261106090000_desks_wave8): send on from triage: the triage desk.
create or replace function send_from_triage(
  p_encounter_id uuid,
  p_triage triage_level,
  p_next_station station,
  p_reason text default null
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
begin
  if not (has_perm('clinical.write') or has_perm('vitals.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(array['triage'], 'triage');
  perform assert_may_work_on(p_encounter_id, true);
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if not exists (select 1 from observation where encounter_id = p_encounter_id and deleted_at is null) then
    raise exception 'take the vitals first' using errcode = '22023';
  end if;
  update encounter set triage_level = p_triage, triage_reason = coalesce(nullif(trim(coalesce(p_reason, '')), ''), triage_reason)
  where id = p_encounter_id;
  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = 'triage' and finished_at is null and deleted_at is null;
  if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = p_next_station
                 and finished_at is null and deleted_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, p_next_station, v_ticket,
            case p_triage when 'red' then 1 when 'yellow' then 2 else 3 end);
  end if;
  return v_ticket;
end
$$;

-- vitals_takers (from 20261019150000_vitals_on_behalf): who measured: the people who work at triage.
create or replace function vitals_takers()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'staffId', p.staff_id, 'role', p.role)
                            order by (p.role <> 'nurse'), p.full_name), '[]'::jsonb)
  from profiles p
  where p.active and p.role in ('nurse', 'doctor', 'manager')
    and (has_perm('vitals.write') or has_perm('clinical.write'))
    -- a department that does triage, or (when none does) the role, as before
    and desk_via(p.id, 'triage') is not null
$$;

-- ---------------------------------------------------------------- E nursing: tasks and beds
-- create_task (from 20261101180000_patients_belong_calls): a task for the nurses is given while treating.
create or replace function create_task(
  p_encounter_id uuid,
  p_title text,
  p_due_at timestamptz default null,
  p_detail text default null,
  p_assigned_role role_key default 'nurse'
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_patient uuid;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  if length(trim(coalesce(p_title, ''))) < 2 then
    raise exception 'say what must be done' using errcode = '22023';
  end if;
  select patient_id into v_patient from encounter where id = p_encounter_id and status = 'open';
  if not found then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into internal_task (encounter_id, patient_id, assigned_role, due_at, title, detail)
  values (p_encounter_id, v_patient, p_assigned_role, p_due_at, trim(p_title), nullif(trim(coalesce(p_detail, '')), ''))
  returning id into v_id;
  return v_id;
end
$$;

-- complete_task (from 20261030120000_cashier_tests_tasks): a nurse task is done by the nursing desk (when a department gives nursing care), the person named or the giver.
create or replace function complete_task(p_task_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_task internal_task%rowtype;
  v_name text;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if desk_offered('nursing') and exists (
       select 1 from internal_task k where k.id = p_task_id and k.assigned_role = 'nurse'
         and k.assigned_to is distinct from auth.uid() and k.created_by is distinct from auth.uid()) then
    perform assert_desk(array['nursing'], 'nursing care');
  end if;
  update internal_task set done_at = now(), done_by = auth.uid()
  where id = p_task_id and deleted_at is null and done_at is null
  returning * into v_task;
  if not found then
    raise exception 'task not found or already done' using errcode = 'P0002';
  end if;
  if v_task.created_by is not null and v_task.created_by is distinct from auth.uid() then
    select p.surname || ' ' || p.given_names into v_name from patient p where p.id = v_task.patient_id;
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('task_done',
            jsonb_build_object('title', v_task.title, 'name', v_name,
                               'by', (select full_name from profiles where id = auth.uid())),
            case when v_task.encounter_id is not null then '/app/visit?encounter=' || v_task.encounter_id end,
            v_task.created_by, auth.uid());
  end if;
end
$$;

-- cancel_task (from 20261104090000_desks_last_items): "not done": the giver, the manager, or the people the task is for.
create or replace function cancel_task(p_task_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_task internal_task%rowtype;
  v_name text;
  v_mine boolean;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why' using errcode = '22023';
  end if;
  select * into v_task from internal_task where id = p_task_id and deleted_at is null and done_at is null for update;
  if not found then
    raise exception 'task not found or already done' using errcode = 'P0002';
  end if;
  v_mine := v_task.created_by = auth.uid();
  -- the giver or the manager withdraws; otherwise only the nurses (to whom it was given) say "not done"
  if not (v_mine or is_manager()
          or task_for_me(v_task.assigned_role)
          or v_task.assigned_to = auth.uid()) then
    raise exception 'only the person who gave the task, the nurses or the manager' using errcode = '42501';
  end if;
  update internal_task set deleted_at = now(), cancel_reason = trim(p_reason), cancelled_by = auth.uid()
  where id = p_task_id;
  if v_task.created_by is not null and not v_mine then
    select p.surname || ' ' || p.given_names into v_name from patient p where p.id = v_task.patient_id;
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('task_done',
            jsonb_build_object('title', v_task.title, 'name', v_name, 'notDone', true, 'reason', trim(p_reason),
                               'by', (select full_name from profiles where id = auth.uid())),
            case when v_task.encounter_id is not null then '/app/visit?encounter=' || v_task.encounter_id end,
            v_task.created_by, auth.uid());
  end if;
end
$$;

-- open_tasks (from 20261103090000_loose_ends): the tasks for me: nurse tasks for the nursing desk.
create or replace function open_tasks()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', k.id, 'title', k.title, 'detail', k.detail, 'dueAt', k.due_at,
      'overdue', k.due_at is not null and k.due_at < now(),
      'encounterId', k.encounter_id,
      'patient', p.surname || ' ' || p.given_names,
      'by', pr.full_name
    ) order by k.due_at nulls last, k.created_at), '[]'::jsonb)
  from internal_task k
  left join patient p on p.id = k.patient_id
  -- a finished visit's task is over too
  left join encounter e on e.id = k.encounter_id
  left join profiles pr on pr.id = k.created_by
  where k.deleted_at is null and k.done_at is null and (k.encounter_id is null or e.status = 'open')
    and (k.assigned_to = auth.uid() or task_for_me(k.assigned_role) or is_manager())
$$;

-- home_summary (from 20261116090000_dashboards_by_period): the home page: nurse tasks for the nursing desk.
create or replace function home_summary(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_role role_key := current_role_key();
  v_practitioner uuid := (select id from practitioner where user_id = auth.uid() and active limit 1);
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_appts jsonb;
  v_inquiries jsonb;
  v_mine jsonb;
  v_to_accept jsonb;
  v_bills jsonb;
  v_paid jsonb;
  v_beds jsonb;
  v_tasks jsonb;
  v_results jsonb;
begin
  if v_role is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- today's booked patients (reception, doctors)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'time', to_char(a.starts_at at time zone 'Africa/Kigali', 'HH24:MI'),
      'name', coalesce(p.surname || ' ' || p.given_names, a.contact_name),
      'doctor', coalesce(pr.names, ''), 'station', coalesce(a.category, ''),
      'status', case when a.status in ('arrived', 'in_progress', 'completed') then 'arrived'
                     when a.starts_at < now() then 'late' else 'due' end,
      'mine', (a.practitioner_id = v_practitioner),
      'encounterId', (select e.id from encounter e where e.appointment_id = a.id order by e.arrived_at desc limit 1)
    ) order by a.starts_at), '[]'::jsonb) into v_appts
  from appointment a
  left join patient p on p.id = a.patient_id
  left join practitioner pr on pr.id = a.practitioner_id
  where a.deleted_at is null and a.status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed')
    and (a.starts_at at time zone 'Africa/Kigali')::date between v_from and v_to;

  -- public inquiries waiting for reception
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'name', a.contact_name, 'phone', a.contact_phone, 'reference', a.reference,
      'category', a.category, 'doctor', pr.names, 'channel', a.contact_channel,
      'when', case when a.starts_at is null then null else to_char(a.starts_at at time zone 'Africa/Kigali', 'DD/MM HH24:MI') end,
      'note', a.reason
    ) order by a.created_at), '[]'::jsonb) into v_inquiries
  from appointment a
  left join practitioner pr on pr.id = a.practitioner_id
  where a.deleted_at is null and a.status = 'inquiry';

  -- approved bookings this practitioner still has to accept
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'name', coalesce(p.surname || ' ' || p.given_names, a.contact_name),
      'when', to_char(a.starts_at at time zone 'Africa/Kigali', 'DD/MM HH24:MI'), 'note', a.reason,
      'category', a.category, 'startsAt', a.starts_at
    ) order by a.starts_at), '[]'::jsonb) into v_to_accept
  from appointment a
  left join patient p on p.id = a.patient_id
  where a.deleted_at is null and a.status = 'approved' and a.practitioner_id = v_practitioner
    and a.starts_at > now() - interval '1 day';

  -- open bills: visits with something charged and a patient balance (cashier)
  select coalesce(jsonb_agg(jsonb_build_object(
      'encounterId', i.encounter_id, 'name', p.surname || ' ' || p.given_names, 'file', p.file_number,
      'ticket', (select ticket_no from queue_entry q where q.encounter_id = i.encounter_id order by q.created_at limit 1),
      'station', (select station from queue_entry q where q.encounter_id = i.encounter_id and q.finished_at is null order by q.created_at desc limit 1),
      'amount', i.patient_share, 'balance', invoice_balance(i.id), 'status', i.status
    ) order by i.updated_at desc), '[]'::jsonb) into v_bills
  from invoice i
  join encounter e on e.id = i.encounter_id
  join patient p on p.id = e.patient_id
  where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0;

  select jsonb_build_object('count', count(*), 'amount', coalesce(sum(amount), 0)) into v_paid
  from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to;

  -- beds
  select coalesce(jsonb_agg(jsonb_build_object(
      'n', b.sort_order, 'name', b.name, 'state', b.status,
      'who', (select p.surname || ' ' || left(p.given_names, 1) || '.' from bed_stay s join encounter e on e.id = s.encounter_id join patient p on p.id = e.patient_id
              where s.bed_id = b.id and s.discharged_at is null limit 1)
    ) order by b.sort_order, b.name), '[]'::jsonb) into v_beds
  from bed b where b.deleted_at is null;

  -- tasks for my role or me
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', k.id, 'time', to_char(k.due_at at time zone 'Africa/Kigali', 'HH24:MI'), 'title', k.title,
      'detail', coalesce(k.detail, ''), 'overdue', (k.due_at < now()),
      'patient', (select p.surname || ' ' || p.given_names from patient p where p.id = k.patient_id)
    ) order by k.due_at), '[]'::jsonb) into v_tasks
  from internal_task k
  where k.deleted_at is null and k.done_at is null and (k.assigned_to = auth.uid() or task_for_me(k.assigned_role));

  -- lab / imaging results of the last two days (doctors)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'encounterId', sr.encounter_id, 'test', s.name_en,
      'name', p.surname || ' ' || p.given_names, 'impression', coalesce(r.impression, r.findings, ''),
      'verified', (r.verified_at is not null), 'at', to_char(r.updated_at at time zone 'Africa/Kigali', 'HH24:MI'),
      'reviewed', (r.reviewed_at is not null), 'corrected', (r.corrected_at is not null)
    ) order by (r.reviewed_at is null) desc, r.updated_at desc), '[]'::jsonb) into v_results
  from diagnostic_report r
  join service_request sr on sr.id = r.service_request_id
  join service s on s.id = sr.service_id
  join encounter e on e.id = sr.encounter_id
  join patient p on p.id = e.patient_id
  where r.deleted_at is null
    and (r.updated_at > now() - interval '2 days' or (r.reviewed_at is null and r.updated_at > now() - interval '7 days'))
    -- a doctor's results are the tests they ordered
    and (v_role is distinct from 'doctor' or sr.requester_id = auth.uid());

  return jsonb_build_object(
    'role', v_role,
    -- the patients this person took and finished today (a doctor's "Seen")
    'seenToday', (select count(distinct q.encounter_id) from queue_entry q
                  where q.taken_by = auth.uid() and q.deleted_at is null and q.finished_at is not null
                    and (q.finished_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'appointments', v_appts,
    'inquiries', v_inquiries,
    'toAccept', v_to_accept,
    'openBills', v_bills,
    'paidToday', v_paid,
    'beds', v_beds,
    'tasks', v_tasks,
    'results', v_results
  );
end
$$;

-- admit_to_bed (from 20261021120000_beds_pricing): beds: the nursing desk.
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
  perform assert_desk(array['nursing'], 'nursing care');
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

-- extend_bed_stay (from 20261021120000_beds_pricing): beds: the nursing desk.
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
  perform assert_desk(array['nursing'], 'nursing care');
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

-- discharge_bed (from 20261019190000_desk_operations): beds: the nursing desk.
create or replace function discharge_bed(p_bed_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(array['nursing'], 'nursing care');
  update bed_stay set discharged_at = now() where bed_id = p_bed_id and discharged_at is null and deleted_at is null;
  if not found then
    raise exception 'nobody is in this bed' using errcode = 'P0002';
  end if;
  update bed set status = 'cleaning' where id = p_bed_id;
end
$$;

-- bed_ready (from 20261019190000_desk_operations): beds: the nursing desk.
create or replace function bed_ready(p_bed_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(array['nursing'], 'nursing care');
  update bed set status = 'free' where id = p_bed_id and status in ('cleaning', 'out_of_service') and deleted_at is null;
  if not found then
    raise exception 'this bed cannot be marked ready' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------- E the treating desks (consultation, dental, surgery, circumcision, nursing, FP, HIV)
-- add_clinical_note (from 20261101180000_patients_belong_calls): a note: a treating desk.
create or replace function add_clinical_note(p_encounter_id uuid, p_text text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  if length(trim(coalesce(p_text, ''))) < 2 then
    raise exception 'the note is empty' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into observation (encounter_id, code, value_text) values (p_encounter_id, 'note', trim(p_text))
  returning id into v_id;
  return v_id;
end
$$;

-- add_diagnosis (from 20261101180000_patients_belong_calls): a diagnosis: a treating desk.
create or replace function add_diagnosis(p_encounter_id uuid, p_text text, p_icd10 text default null, p_type condition_type default 'primary', p_provisional boolean default false)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  if length(trim(coalesce(p_text, ''))) < 2 then
    raise exception 'the diagnosis needs a description' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into condition (encounter_id, text, icd10_code, type, provisional)
  values (p_encounter_id, trim(p_text), nullif(upper(trim(coalesce(p_icd10, ''))), ''), p_type, p_provisional)
  returning id into v_id;
  return v_id;
end
$$;

-- prescribe (from 20261123090000_dispensing_fixes): prescribing: a treating desk.
create or replace function prescribe(
  p_encounter_id uuid, p_item_id uuid, p_quantity numeric, p_dose text default null, p_route text default null,
  p_frequency text default null, p_duration_days integer default null, p_instructions text default null,
  p_supply text default 'pharmacy', p_station station default null, p_location_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_charged boolean := false;
  v_loc uuid;
  v_taken boolean := false;
  v_qty integer;
  v_supply text := coalesce(p_supply, 'pharmacy');
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if v_supply not in ('pharmacy', 'room') then
    raise exception 'unknown supply' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if not exists (select 1 from item where id = p_item_id and deleted_at is null) then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
  if v_supply = 'room' then
    -- Given here: only from a store that holds enough unexpired units; never given without stock.
    v_qty := ceil(p_quantity)::integer;
    v_loc := room_store_for(auth.uid(), p_item_id, v_qty, p_location_id, p_station);
    if v_loc is null then
      raise exception 'not enough of this medicine (not expired) in %: prescribe it for the pharmacy instead',
        case when p_location_id is null then 'a store you may give from' else 'that store' end
        using errcode = 'MS003', hint = 'room_short';
    end if;
  end if;
  insert into medication_request (encounter_id, item_id, dose, route, frequency, duration_days, quantity,
                                  instructions, supply, given_at, given_by)
  values (p_encounter_id, p_item_id, nullif(trim(coalesce(p_dose, '')), ''), nullif(trim(coalesce(p_route, '')), ''),
          nullif(trim(coalesce(p_frequency, '')), ''), p_duration_days, p_quantity,
          nullif(trim(coalesce(p_instructions, '')), ''), v_supply,
          case when v_supply = 'room' then now() end, case when v_supply = 'room' then auth.uid() end)
  returning id into v_id;
  if v_supply = 'room' then
    perform give_from_store(p_item_id, v_loc, v_qty, v_id, 'given in the room');
    v_taken := true;
    -- on the bill at the medicine's price (no price: given free); a closed bill refuses (MS001)
    begin
      perform add_charge_internal(p_encounter_id, coalesce(p_station, 'consultation'::station), null, p_item_id, p_quantity,
                         null, null, null, null, 'medication_request', v_id);
      v_charged := true;
    exception when sqlstate 'P0002' then
      v_charged := false;
    end;
  elsif not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'pharmacy'
                    and finished_at is null and deleted_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no)
    values (p_encounter_id, 'pharmacy', (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1));
  end if;
  return jsonb_build_object('id', v_id, 'supply', v_supply, 'charged', v_charged,
                            'stockTaken', v_taken, 'locationId', v_loc,
                            'warnings', coalesce(rx_warnings(p_item_id, auth.uid()), '[]'::jsonb));
end
$$;

-- cancel_prescription (from 20261123090000_dispensing_fixes): cancelling one's prescription: a treating desk (or the manager).
create or replace function cancel_prescription(p_request_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_m medication_request%rowtype;
  v_item text;
  v_name text;
  v_left integer;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the medicine is cancelled' using errcode = '22023';
  end if;
  select * into v_m from medication_request where id = p_request_id and deleted_at is null for update;
  if not found then
    raise exception 'prescription not found' using errcode = 'P0002';
  end if;
  if not (is_manager()
          or (has_perm('clinical.write') and coalesce(v_m.prescriber_id, v_m.created_by) = auth.uid())) then
    raise exception 'only the doctor who prescribed it (or the manager) can cancel it' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  if not rx_pending(v_m) then
    raise exception 'this medicine is no longer waiting at the pharmacy (handed over, not given or cancelled)'
      using errcode = 'P0002';
  end if;
  update medication_request
  set cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = trim(p_reason)
  where id = v_m.id;
  -- the pharmacy is told the line left its list
  select i.name_generic || coalesce(' ' || i.strength, '') into v_item from item i where i.id = v_m.item_id;
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = v_m.encounter_id;
  insert into notification (kind, params, link, recipient_stations, created_by)
  values ('rx_cancelled',
          jsonb_build_object('item', v_item, 'name', v_name, 'reason', trim(p_reason),
                             'by', (select full_name from profiles where id = auth.uid())),
          '/app/visit?encounter=' || v_m.encounter_id, array['pharmacy'::station], auth.uid());
  -- nothing left at the pharmacy: the patient goes on (back, cashier, or the visit closes)
  perform after_pharmacy(v_m.encounter_id);
  select count(*)::integer into v_left from medication_request m
  where m.encounter_id = v_m.encounter_id and rx_pending(m);
  return jsonb_build_object('id', v_m.id, 'pending', v_left,
                            'balance', invoice_balance((select id from invoice where encounter_id = v_m.encounter_id)));
end
$$;

-- order_tests (from 20261102210000_desks_polished): ordering tests: a treating desk, or the laboratory / ultrasound desk.
create or replace function order_tests(
  p_encounter_id uuid,
  p_service_ids uuid[],
  p_reason text default null,
  p_from station default null,
  p_priority integer default 3
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_service uuid;
  v_ids uuid[] := '{}';
begin
  if not has_perm('orders.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks() || array['laboratory', 'ultrasound'], 'ordering tests');
  perform assert_may_work_on(p_encounter_id);
  if coalesce(array_length(p_service_ids, 1), 0) = 0 then
    raise exception 'choose at least one test' using errcode = '22023';
  end if;
  foreach v_service in array p_service_ids loop
    -- urgent orders (1–2) go to the top of the lab's list
    v_ids := v_ids || order_test(p_encounter_id, v_service, p_reason, greatest(1, least(coalesce(p_priority, 3), 5)));
  end loop;
  -- Send the patient now: off the doctor's queue, onto the desks that do the orders, back after.
  if p_from is not null then
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = p_from and finished_at is null
      and p_from not in (select r.station from service_request r where r.id = any (v_ids));
    update queue_entry
    set referred_by = auth.uid(),
        referral_note = coalesce(nullif(trim(coalesce(p_reason, '')), ''), referral_note),
        return_station = p_from,
        return_to = auth.uid()
    where encounter_id = p_encounter_id and finished_at is null and deleted_at is null
      and station <> p_from
      and station in (select r.station from service_request r where r.id = any (v_ids));
  end if;
  return coalesce(array_length(v_ids, 1), 0);
end
$$;

-- order_test (from 20261102180000_desks_complete): ordering one test: as order_tests.
create or replace function order_test(p_encounter_id uuid, p_service_id uuid, p_reason text default null, p_priority integer default 3)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_group service_group;
  v_cat request_category;
  v_station station;
begin
  if not has_perm('orders.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks() || array['laboratory', 'ultrasound'], 'ordering tests');
  perform assert_may_work_on(p_encounter_id);
  select s.service_group,
         coalesce(c.order_station, case when s.service_group = 'imaging' then 'ultrasound'::station else 'laboratory'::station end)
  into v_group, v_station
  from service s left join service_category c on c.id = s.category_id
  where s.id = p_service_id and s.active and s.deleted_at is null;
  if v_group is null then
    raise exception 'unknown service' using errcode = '22023';
  end if;
  v_cat := case when v_station = 'ultrasound' then 'imaging'::request_category else 'lab'::request_category end;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into service_request (encounter_id, category, service_id, reason, priority, station)
  values (p_encounter_id, v_cat, p_service_id, nullif(trim(coalesce(p_reason, '')), ''), least(5, greatest(1, p_priority)), v_station)
  returning id into v_id;
  perform add_charge_internal(p_encounter_id, v_station, p_service_id, null, 1, null, null, null, null, 'service_request', v_id);
  if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = v_station and finished_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, v_station, (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1), least(5, greatest(1, p_priority)));
  end if;
  return v_id;
end
$$;

-- mark_result_reviewed (from 20261106090000_desks_wave8): a result seen: a treating desk (or the manager).
create or replace function mark_result_reviewed(p_report_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not (has_perm('clinical.write') or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  update diagnostic_report set reviewed_at = now(), reviewed_by = auth.uid()
  where id = p_report_id and deleted_at is null and reviewed_at is null;
end
$$;

-- close_encounter (from 20261015180300_visits): closing the visit: a treating desk.
create or replace function close_encounter(p_encounter_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_type encounter_type;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  select type into v_type from encounter where id = p_encounter_id and status = 'open';
  if not found then
    raise exception 'encounter not found or already closed' using errcode = 'P0002';
  end if;
  if v_type in ('opd', 'dental', 'procedure', 'observation')
     and not exists (select 1 from condition where encounter_id = p_encounter_id and type = 'primary' and deleted_at is null) then
    raise exception 'a primary diagnosis is required before closing the visit' using errcode = '23514';
  end if;
  update encounter set status = 'closed', closed_at = now(), closed_by = auth.uid() where id = p_encounter_id;
  update queue_entry set finished_at = coalesce(finished_at, now()) where encounter_id = p_encounter_id;
end
$$;

-- ask_help (from 20261101180000_patients_belong_calls): asking a colleague for help: a treating desk.
create or replace function ask_help(p_encounter_id uuid, p_to_user uuid default null, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_by text;
  v_name text;
  v_ticket text;
begin
  select full_name into v_by from profiles where id = auth.uid() and active;
  if v_by is null or not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  perform assert_may_work_on(p_encounter_id);
  if p_to_user is not null and (p_to_user = auth.uid()
      or not exists (select 1 from profiles where id = p_to_user and active)) then
    raise exception 'choose an active colleague' using errcode = '22023';
  end if;
  insert into staff_call (kind, target, to_user, encounter_id, note)
  values ('help', case when p_to_user is null then 'doctors' else 'person' end, p_to_user, p_encounter_id,
          nullif(trim(coalesce(p_note, '')), ''))
  returning id into v_id;
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id;
  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
  insert into notification (kind, params, link, recipient_user, recipient_role, urgent, created_by)
  values ('help', jsonb_build_object('call', v_id, 'by', v_by, 'name', v_name, 'ticket', v_ticket,
                                     'note', nullif(trim(coalesce(p_note, '')), '')),
          '/app/visit?encounter=' || p_encounter_id, p_to_user,
          case when p_to_user is null then 'doctor'::role_key end, true, auth.uid());
  return v_id;
end
$$;

-- ---------------------------------------------------------------- E reception
-- start_visit (from 20261101150000_who_may_do_what): starting a visit: the reception desk (and visit.start, as before).
create or replace function start_visit(
  p_patient_id uuid,
  p_emergency boolean default false,
  p_station station default 'consultation',
  p_type encounter_type default 'opd'
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_station station := case when p_emergency then p_station when triage_first() then 'triage'::station else p_station end;
  v_enc uuid;
  v_ticket text;
begin
  if not has_perm('queue.write') or not has_perm('visit.start') then
    raise exception 'you may not start visits (the manager has not allowed it)' using errcode = '42501';
  end if;
  -- A visit is started at reception; an emergency by the people who treat (at any treating desk,
  -- triage or reception), wherever reception is given.
  if not p_emergency then
    perform assert_desk(array['reception'], 'starting visits');
  else
    perform assert_desk(array['reception', 'triage'] || treating_desks(), 'emergency visits');
  end if;
  -- An emergency is treated on the spot, so only staff who treat may register one.
  if p_emergency and current_role_key() in ('receptionist', 'cashier') then
    raise exception 'only treating staff can register an emergency' using errcode = '42501';
  end if;
  if exists (select 1 from encounter where patient_id = p_patient_id and status = 'open') then
    raise exception 'this patient already has an open visit' using errcode = '23505';
  end if;
  perform set_config('mmc.visit_open', 'on', true);
  v_enc := open_encounter(p_patient_id, p_type, v_station);
  perform set_config('mmc.visit_open', '', true);
  if p_emergency then
    update encounter
    set triage_level = 'red', triage_reason = 'Emergency: registered directly at ' || p_station::text
    where id = v_enc;
    update queue_entry set priority = 1 where encounter_id = v_enc;
  end if;
  select ticket_no into v_ticket from queue_entry where encounter_id = v_enc order by created_at desc limit 1;
  return jsonb_build_object('encounter_id', v_enc, 'ticket_no', v_ticket, 'station', v_station);
end
$$;

-- begin_visit (from 20261111090000_triage_nurse_track): starting a visit: the reception desk; "I take the patient myself" also where a department of theirs gives that desk.
create or replace function begin_visit(
  p_patient_id uuid,
  p_station station default 'consultation',
  p_department_id uuid default null,
  p_note text default null,
  p_myself boolean default false,
  p_emergency boolean default false,
  p_service text default null,
  p_assigned_to uuid default null,
  p_triage_to uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_role role_key := current_role_key();
  v_desk station := coalesce(case when not p_myself then service_station(p_service) end, p_station);
  v_station station;
  v_enc uuid;
  v_q queue_entry%rowtype;
begin
  if not has_perm('queue.write') or not has_perm('visit.start') then
    raise exception 'you may not start visits (the manager has not allowed it)' using errcode = '42501';
  end if;
  -- A visit is started at reception. "I take the patient myself" is decided below (the person's
  -- own desk); an emergency by the people who treat, wherever reception is given.
  if not (p_myself or p_emergency) then
    perform assert_desk(array['reception'], 'starting visits');
  elsif p_emergency and not p_myself then
    perform assert_desk(array['reception', 'triage'] || treating_desks(), 'emergency visits');
  end if;
  if p_emergency and v_role in ('receptionist', 'cashier') then
    raise exception 'only treating staff can register an emergency' using errcode = '42501';
  end if;
  if p_service is not null and service_station(p_service) is null then
    raise exception 'unknown service' using errcode = '22023';
  end if;
  if p_myself and not (
       v_role = 'manager'
       or (v_role = 'doctor' and v_desk in ('consultation', 'dental', 'theatre', 'ultrasound'))
       or (v_role = 'nurse' and v_desk in ('triage', 'nursing', 'beds'))
       or (v_role = 'lab_tech' and v_desk = 'laboratory')
       or (v_role = 'sonographer' and v_desk = 'ultrasound')
       or (v_role = 'pharmacist' and v_desk = 'pharmacy')
       -- or a department of theirs gives that desk (a nurse of the Laboratory …)
       or exists (select 1 from unnest(station_desks(v_desk)) as d(desk)
                  where in_desk_department(auth.uid(), d.desk) and may_use_desk(d.desk))) then
    raise exception 'you do not work at % : send the patient there instead', initcap(v_desk::text)
      using errcode = '42501';
  end if;
  if p_assigned_to is not null and (p_service is null or not staff_serves(p_assigned_to, p_service)) then
    raise exception 'that person does not give this service' using errcode = '22023';
  end if;
  if p_triage_to is not null and not staff_serves(p_triage_to, 'triage') then
    raise exception 'that person does not work at triage' using errcode = '22023';
  end if;
  if p_department_id is not null and not exists (
       select 1 from department d where d.id = p_department_id and d.deleted_at is null
         and station_role(v_desk) = any (d.roles)) then
    raise exception 'that department does not work at %', initcap(v_desk::text) using errcode = '22023';
  end if;
  if exists (select 1 from encounter where patient_id = p_patient_id and status = 'open') then
    raise exception 'this patient already has an open visit' using errcode = '23505';
  end if;

  v_station := case
    when p_myself or p_emergency then v_desk
    when triage_first() then 'triage'::station
    else v_desk end;
  perform set_config('mmc.visit_open', 'on', true);
  v_enc := open_encounter(p_patient_id, 'opd', v_station);
  perform set_config('mmc.visit_open', '', true);
  -- the service and the person chosen stay with the visit (used after triage)
  update encounter
  set service = p_service, intended_to = case when p_myself then auth.uid() else p_assigned_to end,
      practitioner_id = case
        when p_assigned_to is not null and exists (select 1 from profiles where id = p_assigned_to and role = 'doctor')
        then ensure_practitioner(p_assigned_to) else practitioner_id end
  where id = v_enc;

  if p_emergency then
    update encounter
    set triage_level = 'red', triage_reason = 'Emergency: registered directly at ' || v_station::text
    where id = v_enc;
    update queue_entry set priority = 1 where encounter_id = v_enc;
  end if;

  select * into v_q from queue_entry
  where encounter_id = v_enc and station = v_station and finished_at is null and deleted_at is null
  order by created_at limit 1;
  update queue_entry
  set referral_note = coalesce(nullif(trim(coalesce(p_note, '')), ''), referral_note),
      service = p_service,
      department_id = case when v_station = v_desk and p_assigned_to is null then coalesce(p_department_id, department_id) else department_id end,
      assigned_to = case
        when v_station = 'triage' and not p_myself then coalesce(p_triage_to, assigned_to)
        when v_station = v_desk and not p_myself then coalesce(p_assigned_to, assigned_to)
        else assigned_to end,
      referred_by = auth.uid()
  where id = v_q.id
  returning * into v_q;
  if p_myself then
    perform take_patient(v_q.id);
    delete from notification where kind = 'queue' and params ->> 'queue' = v_q.id::text;
  elsif v_q.assigned_to is not null then
    -- the person chosen is told (instead of everyone at the desk)
    perform notify_queue_entry_row(v_q);
  end if;

  return jsonb_build_object(
    'encounter_id', v_enc,
    'ticket_no', v_q.ticket_no,
    'station', v_station,
    'myself', p_myself,
    'assigned', (select full_name from profiles where id = v_q.assigned_to),
    'department', (select name from department where id = p_department_id));
end
$$;

-- ---------------------------------------------------------------- E the lab list by desk
-- The tests of my list: laboratory for the laboratory desk, imaging for the ultrasound desk
-- (lab_worklist and lab_summary read it). Before: by role.
create or replace function my_test_categories()
returns request_category[]
language sql stable security definer set search_path = public
as $$
  select array_remove(array[
    case when may_use_desk('laboratory') then 'lab' end,
    case when may_use_desk('ultrasound') then 'imaging' end
  ]::request_category[], null)
$$;

-- The store tables (0083) ask stock_admin(), now the pharmacy desk: asked once per read, not per
-- row (the same rules as 0083).
drop policy if exists stock_movement_select on stock_movement;
create policy stock_movement_select on stock_movement for select to authenticated
  using ((select stock_admin()) or may_see_store(from_location_id) or may_see_store(to_location_id));
drop policy if exists batch_select on batch;
create policy batch_select on batch for select to authenticated using ((select stock_admin()));
drop policy if exists goods_receipt_select on goods_receipt;
create policy goods_receipt_select on goods_receipt for select to authenticated using ((select stock_admin()));
drop policy if exists goods_receipt_line_select on goods_receipt_line;
create policy goods_receipt_line_select on goods_receipt_line for select to authenticated
  using ((select stock_admin()));
drop policy if exists stock_transfer_line_select on stock_transfer_line;
create policy stock_transfer_line_select on stock_transfer_line for select to authenticated
  using ((select stock_admin()) or exists (select 1 from stock_transfer t where t.id = transfer_id
                                  and (may_see_store(t.from_location_id) or may_see_store(t.to_location_id))));
drop policy if exists counter_sale_select on counter_sale;
create policy counter_sale_select on counter_sale for select to authenticated
  using ((select stock_admin()) or (select has_perm('payment.take')));
drop policy if exists counter_sale_line_select on counter_sale_line;
create policy counter_sale_line_select on counter_sale_line for select to authenticated
  using ((select stock_admin()) or (select has_perm('payment.take')));

-- ---------------------------------------------------------------- H the app reads the desks
-- The employee list with the desks each person may use now (added at the end).
create or replace view staff_directory with (security_invoker = true) as
  select p.id, p.username, p.full_name, p.role, p.station, p.dashboard, p.head_of, p.language, p.phone,
         p.active, p.must_change_pin, p.last_sign_in_at, p.pin_changed_at, p.deactivated_at, p.created_at,
         p.staff_id, p.email, p.department_id, d.name as department_name, p.position, p.specialty,
         coalesce((select jsonb_agg(jsonb_build_object('id', dd.id, 'name', dd.name, 'position', sd.position)
                                    order by (sd.department_id = p.department_id) desc, dd.name)
                   from staff_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.profile_id = p.id), '[]'::jsonb) as departments,
         p.registration_no, p.registration_body,
         desks_of(p.id) as desks, kept_desks_of(p.id) as kept_desks
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null
  where p.deleted_at is null;

create or replace function my_session_profile()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v profiles%rowtype;
begin
  select * into v from profiles where id = auth.uid();
  if not found or not v.active then
    raise exception 'this account is deactivated; ask the manager' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'id', v.id, 'username', v.username, 'full_name', v.full_name, 'role', v.role,
    'station', v.station, 'dashboard', v.dashboard, 'head_of', v.head_of,
    'language', v.language, 'must_change_pin', v.must_change_pin,
    'staff_id', v.staff_id, 'email', v.email,
    'specialty', v.specialty, 'registration_no', v.registration_no, 'registration_body', v.registration_body,
    'desks', to_jsonb(my_desk_list())
  );
end
$$;

-- ---------------------------------------------------------------- F day one: nobody loses a desk
-- The desk a role works at as usual (the usual desk of 0071 / 0080; reception for reception; triage
-- for the nurse and the receptionist, who types the nurse's paper sheet).
create or replace function desk_usual(p_role role_key, p_station text, p_specialty text, p_desk text)
returns boolean
language sql immutable
as $$
  select case
    when p_desk = 'reception' then p_role = 'receptionist'
    when p_desk = 'triage' then p_role in ('receptionist', 'nurse')
      or coalesce(role_serves(p_role, p_station, p_desk, p_specialty), false)
    else coalesce(role_serves(p_role, p_station, p_desk, p_specialty), false)
  end
$$;

-- Did the person do this desk's work in the last 90 days?
create or replace function desk_used_recently(p_user uuid, p_desk text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    -- opened a visit
    when p_desk = 'reception' then exists (
      select 1 from encounter e where e.created_by = p_user and e.created_at > now() - interval '90 days')
    -- measured (or typed the measurements) while the patient waited at triage
    when p_desk = 'triage' then exists (
      select 1 from observation o
      join queue_entry q on q.encounter_id = o.encounter_id and q.station = 'triage' and q.deleted_at is null
        and q.created_at <= o.created_at and (q.finished_at is null or q.finished_at >= o.created_at)
      where (o.created_by = p_user or o.performer_id = p_user) and o.created_at > now() - interval '90 days')
    -- wrote or verified a result of that desk
    when p_desk in ('laboratory', 'ultrasound') then exists (
      select 1 from diagnostic_report d join service_request r on r.id = d.service_request_id
      where (d.created_by = p_user or d.verified_by = p_user) and d.created_at > now() - interval '90 days'
        and coalesce(r.station::text, request_desk(null, r.category)) = p_desk)
    -- handed over medicines
    when p_desk = 'pharmacy' then exists (
      select 1 from medication_dispense m
      where (m.dispenser_id = p_user or m.created_by = p_user) and m.created_at > now() - interval '90 days')
    else
      -- took patients of that service
      exists (
        select 1 from queue_entry q join encounter e on e.id = q.encounter_id
        where q.taken_by = p_user and q.created_at > now() - interval '90 days'
          and q.station = service_station(p_desk)
          and coalesce(q.service, case when service_station(e.service) = q.station then e.service end,
                       case q.station when 'theatre' then 'surgery' else q.station::text end) = p_desk)
      -- nursing care: did nurse tasks, put patients in beds
      or (p_desk = 'nursing' and (
        exists (select 1 from internal_task k where k.done_by = p_user and k.done_at > now() - interval '90 days')
        or exists (select 1 from bed_stay s where s.created_by = p_user and s.created_at > now() - interval '90 days')))
  end
$$;

-- What reaches each employee now (staff_serves, for every desk): a placement must not change it.
create or replace function routing_snapshot()
returns text[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(p.id::text || ':' || d.desk order by p.id, d.desk), '{}')
  from profiles p
  cross join unnest(all_desks()) as d(desk)
  where p.active and p.deleted_at is null and staff_serves(p.id, d.desk)
$$;

-- Every active employee who used a desk until now (the role's permission, and the rule of before)
-- but would lose it, because a department gives it and they are in none:
--   * their usual desk: placed, as a member, in an active department giving it that takes their
--     role (or every role) and holds no room store, only when nothing else changes: the patients
--     sent to anyone stay the same (routing_snapshot). A department's roles are never changed.
--   * otherwise (or when they only did that work lately): on day one (p_day_one) they keep the desk
--     by the rule of before (staff_desk_keep) until the manager places them; later (a department
--     giving a desk for the first time, upsert_department: p_desks) they lose it.
-- Each placement and kept desk is in the history; the manager gets one notice ('desks_placed')
-- listing who was placed, who keeps a desk and who lost one.
create or replace function place_staff_for_desks(p_day_one boolean default false, p_desks text[] default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  r record;
  v_desk text;
  v_dep department%rowtype;
  v_usual boolean;
  v_reason text;
  v_action text;
  v_before text[];
  v_lines jsonb := '[]'::jsonb;
  v_placed text;
  v_kept text;
  v_lost text;
begin
  if auth.uid() is not null and not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_before := routing_snapshot();
  for r in
    select p.id, p.full_name, p.role, p.station::text as station, p.specialty::text as specialty
    from profiles p
    where p.active and p.deleted_at is null and p.role <> 'manager'
    order by p.full_name, p.id
  loop
    foreach v_desk in array all_desks() loop
      continue when p_desks is not null and not (v_desk = any (p_desks));
      -- they keep it anyway, or never had it
      continue when desk_via(r.id, v_desk) is not null;
      continue when not desk_offered(v_desk);
      continue when not exists (select 1 from role_desk rd where rd.role = r.role and rd.desk = v_desk);
      continue when not (staff_perm(r.id, desk_permission(v_desk))
                         and desk_role_rule(r.role, r.station, r.specialty, v_desk));
      v_usual := desk_usual(r.role, r.station, r.specialty, v_desk);
      continue when not (v_usual or desk_used_recently(r.id, v_desk));
      v_reason := null;
      select * into v_dep from department where false;
      if not v_usual then
        v_reason := 'recent_only';
      else
        -- a department that takes the role, one holding no room store first
        select * into v_dep from department d
        where d.active and d.deleted_at is null and v_desk = any (d.services)
          and (cardinality(d.roles) = 0 or r.role = any (d.roles))
        order by exists (select 1 from stock_location_holder h
                         where h.department_id = d.id and h.deleted_at is null),
                 d.sort_order, d.name, d.id
        limit 1;
        if v_dep.id is null then
          v_reason := 'role_not_accepted';
        elsif exists (select 1 from stock_location_holder h
                      where h.department_id = v_dep.id and h.deleted_at is null) then
          -- a member would hold its room store: the manager decides
          v_reason := 'holds_store';
        else
          begin
            insert into staff_department (profile_id, department_id, position)
            values (r.id, v_dep.id, 'member')
            on conflict (profile_id, department_id) do nothing;
            -- no main department yet: this one (the membership follows, 0051)
            update profiles set department_id = v_dep.id, position = 'member'
            where id = r.id and department_id is null;
            if routing_snapshot() is distinct from v_before then
              raise exception 'mmc: placement changes routing' using errcode = 'P0001';
            end if;
          exception when raise_exception then
            if sqlerrm <> 'mmc: placement changes routing' then
              raise;
            end if;
            -- undone: the patients sent to someone would change
            v_reason := 'routing';
          end;
        end if;
      end if;
      v_action := case when v_reason is null then 'placed' when p_day_one then 'kept' else 'lost' end;
      if v_action = 'placed' then
        insert into audit_event (actor_id, action, entity, entity_id, after, reason)
        values (auth.uid(), 'update', 'profiles', r.id,
                jsonb_build_object('key', 'desk_placement', 'department', v_dep.name, 'departmentId', v_dep.id,
                                   'desk', v_desk),
                'placed in a department so the employee keeps the desk they use (0085)');
      elsif v_action = 'kept' then
        insert into staff_desk_keep (profile_id, desk, reason) values (r.id, v_desk, v_reason)
        on conflict do nothing;
        insert into audit_event (actor_id, action, entity, entity_id, after, reason)
        values (auth.uid(), 'update', 'profiles', r.id,
                jsonb_build_object('key', 'desk_kept', 'desk', v_desk, 'why', v_reason),
                'keeps the desk by the rule of before until the manager places them (0085)');
      end if;
      v_lines := v_lines || jsonb_build_object(
        'profileId', r.id, 'name', r.full_name, 'role', r.role, 'desk', v_desk, 'action', v_action,
        'reason', v_reason, 'departmentId', v_dep.id, 'department', v_dep.name);
    end loop;
  end loop;
  if jsonb_array_length(v_lines) > 0 then
    select string_agg(x ->> 'name' || ' → ' || (x ->> 'department') || ' (' || (x ->> 'desk') || ')', '; '
                      order by x ->> 'name', x ->> 'desk') filter (where x ->> 'action' = 'placed'),
           string_agg(x ->> 'name' || ' (' || (x ->> 'desk') || ')', '; '
                      order by x ->> 'name', x ->> 'desk') filter (where x ->> 'action' = 'kept'),
           string_agg(x ->> 'name' || ' (' || (x ->> 'desk') || ')', '; '
                      order by x ->> 'name', x ->> 'desk') filter (where x ->> 'action' = 'lost')
    into v_placed, v_kept, v_lost
    from jsonb_array_elements(v_lines) x;
    insert into notification (kind, params, title, body, link, recipient_role, created_by)
    values ('desks_placed',
            jsonb_build_object('count', jsonb_array_length(v_lines), 'lines', v_lines, 'dayOne', p_day_one),
            case when p_day_one then 'Employees placed in departments'
                 else 'A department now gives a desk' end,
            case when p_day_one then 'Departments now decide the desks each person uses. '
                 else 'Only the members of departments giving a desk now use it. ' end
              || coalesce('Added as members: ' || v_placed || '. ', '')
              || coalesce('Keep their desk as before until you place them in a department that gives it: '
                          || v_kept || '. ', '')
              || coalesce('No longer use the desk (add them to a department that gives it if they still '
                          || 'work there): ' || v_lost || '. ', '')
              || 'Check Employees → Departments.',
            '/app/staff', 'manager', auth.uid());
  end if;
  return v_lines;
end
$$;

-- ---------------------------------------------------------------- E the clinician's own test
-- visit_clinical (from 20261125090000_document_details): each test says whether the signed-in
-- person ordered it ('mine'): while no department gives its desk, the clinician who ordered it
-- still types its result (record_result), and the visit page shows the button.
create or replace function visit_clinical(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  -- clinicians; the lab and the pharmacy read the record too (their orders and prescriptions)
  select case when has_perm('clinical.read') or has_perm('orders.read') or has_perm('prescription.read')
              then jsonb_build_object(
    'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by)) order by c.created_at)
      from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.value_text, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id)) order by o.effective_at)
      from observation o where o.encounter_id = p_encounter_id and o.code = 'note' and o.deleted_at is null), '[]'::jsonb),
    'prescriptions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by)), 'item', i.name_generic || coalesce(' ' || i.strength, ''), 'dose', m.dose, 'route', m.route,
        'frequency', m.frequency, 'days', m.duration_days, 'quantity', m.quantity, 'instructions', m.instructions, 'at', m.created_at,
        'dispensed', m.supply = 'room' or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'supply', m.supply, 'givenAt', m.given_at, 'givenBy', (select full_name from profiles where id = m.given_by),
        'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason,
        'prescriberId', coalesce(m.prescriber_id, m.created_by), 'pending', rx_pending(m),
        'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
        'cancelledBy', (select full_name from profiles where id = m.cancelled_by),
        'prescriber', doc_person(coalesce(m.prescriber_id, m.created_by))) order by m.created_at)
      from medication_request m join item i on i.id = m.item_id where m.encounter_id = p_encounter_id and m.deleted_at is null), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end), 'status', r.status, 'reason', r.reason, 'at', r.created_at, 'mine', coalesce(r.requester_id = auth.uid(), false),
        'result', (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
          'corrected', d.corrected_at is not null, 'correctionReason', d.correction_reason,
          'at', coalesce(d.verified_at, d.updated_at), 'by', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
          'byPerson', doc_person(coalesce(d.verified_by, d.created_by)))
          from diagnostic_report d where d.service_request_id = r.id and d.deleted_at is null)) order by r.created_at)
      from service_request r join service s on s.id = r.service_id where r.encounter_id = p_encounter_id and r.deleted_at is null), '[]'::jsonb),
    'patient', (select jsonb_build_object('id', p.id, 'allergies', p.allergies, 'bloodGroup', p.blood_group, 'notes', p.notes, 'flags', p.flags)
                       || doc_patient(p.id, e.id)
      from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id),
    'visit', doc_visit(p_encounter_id)
  ) else null end
$$;

-- ---------------------------------------------------------------- E opening a visit
-- open_encounter (from 20261015180300_visits): start_visit and begin_visit open visits (they check
-- the desks, then open it); called directly it needs "start a visit" and the reception desk.
create or replace function open_encounter(
  p_patient_id uuid,
  p_type encounter_type default 'opd',
  p_station station default 'triage',
  p_coverage_id uuid default null,
  p_appointment_id uuid default null,
  p_practitioner_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_ticket text;
  v_prefix text := case p_station when 'dental' then 'D' when 'laboratory' then 'L' when 'ultrasound' then 'U' when 'pharmacy' then 'P' else 'A' end;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if coalesce(current_setting('mmc.visit_open', true), '') <> 'on' then
    if not has_perm('visit.start') then
      raise exception 'you may not start visits (the manager has not allowed it)' using errcode = '42501';
    end if;
    perform assert_desk(array['reception'], 'starting visits');
  end if;
  insert into encounter (patient_id, type, coverage_id, appointment_id, practitioner_id)
  values (p_patient_id, p_type, p_coverage_id, p_appointment_id, p_practitioner_id)
  returning id into v_id;
  v_ticket := v_prefix || '-' || lpad(next_number('ticket_' || v_prefix, to_char(now(), 'YYYYDDD')::integer)::text, 3, '0');
  insert into queue_entry (encounter_id, station, ticket_no) values (v_id, p_station, v_ticket);
  if p_appointment_id is not null then
    update appointment set status = 'arrived' where id = p_appointment_id and status in ('confirmed', 'approved');
  end if;
  return v_id;
end
$$;

-- ---------------------------------------------------------------- E nursing: who works on the patient, who is told
-- may_work_on (from 20261103090000_loose_ends): a task on the visit counts for the people it is for
-- (nurse tasks: the nursing desk once a department gives it, task_for_me).
create or replace function may_work_on(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select is_manager()
    or exists (select 1 from queue_entry q
               where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
                 and queue_entry_for_me(q.id))
    -- a task on this visit for me or the people it is for (the doctor asked the nurse for an injection…)
    or exists (select 1 from internal_task k
               where k.encounter_id = p_encounter_id and k.done_at is null and k.deleted_at is null
                 and (k.assigned_to = auth.uid() or task_for_me(k.assigned_role)))
    -- a colleague who accepted to help on this patient
    or exists (select 1 from staff_call c
               where c.encounter_id = p_encounter_id and c.kind = 'help' and c.status = 'accepted'
                 and c.answered_by = auth.uid())
    -- nobody holds the patient at a treating desk (e.g. now at the cashier): whoever treated
    -- them in this visit may still complete the record
    or (not exists (select 1 from queue_entry q
                    where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
                      and station_role(q.station) in ('doctor', 'nurse', 'lab_tech', 'sonographer'))
        and exists (select 1 from queue_entry q
                    where q.encounter_id = p_encounter_id and q.deleted_at is null
                      and (q.taken_by = auth.uid() or q.assigned_to = auth.uid())))
$$;

-- notify_task (from 20261020120000_departments_notifications): a nurse task is told to the people
-- who give nursing care once a department gives it (each by name); otherwise to the role, as before.
create or replace function notify_task()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_link text := case when new.encounter_id is not null then '/app/visit?encounter=' || new.encounter_id end;
begin
  select p.surname || ' ' || p.given_names into v_name from patient p where p.id = new.patient_id;
  if new.assigned_to is null and new.assigned_role = 'nurse' and desk_offered('nursing') then
    insert into notification (kind, params, link, recipient_user, created_by)
    select 'task', jsonb_build_object('title', new.title, 'name', v_name, 'due', new.due_at), v_link, p.id,
           auth.uid()
    from profiles p
    where p.active and p.deleted_at is null and p.role <> 'manager' and desk_via(p.id, 'nursing') is not null;
  else
    insert into notification (kind, params, link, recipient_role, recipient_user, created_by)
    values ('task',
            jsonb_build_object('title', new.title, 'name', v_name, 'due', new.due_at),
            v_link,
            case when new.assigned_to is null then new.assigned_role end,
            new.assigned_to,
            auth.uid());
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------- E no direct writes
-- The clinical tables are written by the desk functions only (they check the desks): the write
-- policies of 0015 (apply_rls) go, and the signed-in roles may no longer insert, change or delete
-- rows directly (reads are unchanged). The same rule as the store and money tables (0083).
do $$
declare
  t text;
begin
  foreach t in array array['service_request', 'diagnostic_report', 'observation', 'condition', 'procedure',
                           'bed', 'bed_stay', 'internal_task', 'encounter', 'queue_entry', 'vaccination',
                           'fp_event', 'hiv_test'] loop
    continue when to_regclass('public.' || quote_ident(t)) is null;
    execute format('revoke insert, update, delete on table %I from authenticated, anon', t);
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('drop policy if exists %I on %I', t || '_delete', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------- rights
revoke all on function staff_perm(uuid, text), desk_offered(text), in_desk_department(uuid, text),
  desk_via(uuid, text), desk_used_recently(uuid, text), routing_snapshot(), place_staff_for_desks(boolean, text[])
  from public, anon, authenticated;
revoke all on function desk_key(text), all_desks(), treating_desks(), desk_permission(text),
  desk_role_rule(role_key, text, text, text), station_desks(station), request_desk(station, request_category),
  desk_usual(role_key, text, text, text), may_use_desk(text), may_use_any_desk(text[]),
  assert_desk(text[], text), task_for_me(role_key), desks_of(uuid), my_desk_list(), my_desks(),
  role_desk_matrix(), set_role_desk(role_key, text, boolean), forget_kept_desk(uuid, text),
  kept_desks_of(uuid)
  from public, anon;
grant execute on function desk_key(text), all_desks(), treating_desks(), desk_permission(text),
  desk_role_rule(role_key, text, text, text), station_desks(station), request_desk(station, request_category),
  desk_usual(role_key, text, text, text), may_use_desk(text), may_use_any_desk(text[]),
  assert_desk(text[], text), task_for_me(role_key), desks_of(uuid), my_desk_list(), my_desks(),
  role_desk_matrix(), set_role_desk(role_key, text, boolean), forget_kept_desk(uuid, text),
  kept_desks_of(uuid)
  to authenticated;

-- ---------------------------------------------------------------- F day one
select place_staff_for_desks(true);
