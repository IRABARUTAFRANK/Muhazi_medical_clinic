-- 0071 · Sections, not roles.
--
-- "The first free doctor" went by role: a patient waiting at Consultation could be taken only by
-- an employee whose role is doctor, and only doctors were told. In the clinic a nurse may work in
-- Consultation and a doctor in Nursing; what counts is the section the person works in.
--
-- Who works in a section (one of the clinic's services, or triage):
--   * the services the person's calendar lists, and the services their departments give
--     (department.services, set by the manager on Employees → Departments);
--   * a person with neither (or a section nobody is set for yet) falls back to the usual desk of
--     their role, so a patient is never left with nobody who may take them.
-- A patient sent to a section (no named person) may be taken by anyone who works in it, whatever
-- their role, and only they are told. A patient sent to one person: only that person is told.

-- ---------------------------------------------------------------- departments give services
alter table department add column if not exists services text[] not null default '{}';

-- The departments the clinic already has: their names say the service (only where none is set).
update department d set services = x.s
from (
  select id, array_remove(array[
    case when lower(name) ~ '(consult|gusuzuma|general|médecine|medecine)' then 'consultation' end,
    case when lower(name) ~ '(dent|amenyo)' then 'dental' end,
    case when lower(name) ~ '(labo|ibizamini)' then 'laboratory' end,
    case when lower(name) ~ '(ultra|echo|écho|mucyuma|imag)' then 'ultrasound' end,
    case when lower(name) ~ '(nurs|infirm|kwita)' then 'nursing' end,
    case when lower(name) ~ '(surg|chirur|kubaga|theat)' then 'surgery' end,
    case when lower(name) ~ '(circ|gusiramura)' then 'circ' end,
    case when lower(name) ~ '(family|planning|planif|kuboneza)' then 'fp' end,
    case when lower(name) ~ '(hiv|vih|vacc|sida)' then 'hiv' end,
    case when lower(name) ~ '(pharm|farum)' then 'pharmacy' end,
    case when lower(name) ~ '(triage|gupima)' then 'triage' end
  ], null) as s
  from department where deleted_at is null and services = '{}'
) x
where d.id = x.id and cardinality(x.s) > 0;

drop function if exists upsert_department(uuid, text, text, role_key[]);
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
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'the department needs a name' using errcode = '22023';
  end if;
  select s into v_bad from unnest(coalesce(p_services, '{}')) s where service_station(s) is null limit 1;
  if v_bad is not null then
    raise exception 'unknown service %', v_bad using errcode = '22023';
  end if;
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
  return v_id;
end
$$;

-- ---------------------------------------------------------------- who works in a section
-- The services set for a person: their calendar's and their departments'.
create or replace function staff_services(p_user uuid)
returns text[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(distinct s), '{}')
  from (
    select unnest(pr.categories) as s
    from practitioner pr where pr.user_id = p_user and pr.deleted_at is null
    union
    select unnest(d.services)
    from staff_department sd join department d on d.id = sd.department_id and d.deleted_at is null
    where sd.profile_id = p_user
  ) x
$$;

-- Is anyone set for this service (by calendar or department)?
create or replace function service_has_staff(p_service text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles p
    where p.active and p.role in ('doctor', 'nurse', 'sonographer', 'lab_tech', 'pharmacist')
      and (exists (select 1 from practitioner pr where pr.user_id = p.id and pr.deleted_at is null
                   and p_service = any (pr.categories))
           or exists (select 1 from staff_department sd
                      join department d on d.id = sd.department_id and d.deleted_at is null
                      where sd.profile_id = p.id and p_service = any (d.services)))
  )
$$;

-- The usual desk of a role (the rule before 0071), for people and sections nobody set.
create or replace function role_serves(p_role role_key, p_station text, p_service text)
returns boolean
language sql immutable
as $$
  select case p_role
    when 'doctor' then
      (p_service = 'dental' and lower(coalesce(p_station, '')) ~ 'dent')
      or (p_service in ('surgery', 'circ') and lower(coalesce(p_station, '')) ~ '(theat|surg|circ)')
      or (p_service = 'ultrasound' and lower(coalesce(p_station, '')) ~ '(ultra|echo)')
      or (p_service = 'consultation' and lower(coalesce(p_station, '')) !~ '(dent|theat|surg|ultra|echo)')
    when 'sonographer' then p_service = 'ultrasound'
    when 'nurse' then p_service in ('nursing', 'fp', 'hiv', 'triage')
    when 'lab_tech' then p_service = 'laboratory'
    when 'pharmacist' then p_service = 'pharmacy'
    else false
  end
$$;

create or replace function staff_serves(p_user uuid, p_service text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles p
    cross join lateral (select staff_services(p.id) as mine) s
    where p.id = p_user and p.active
      and p.role in ('doctor', 'nurse', 'sonographer', 'lab_tech', 'pharmacist')
      and (
        -- the section the person is set in, whatever their role
        p_service = any (s.mine)
        -- nothing set for the person, or nobody set for this section: the role's usual desk
        or ((cardinality(s.mine) = 0 or not service_has_staff(p_service))
            and role_serves(p.role, p.station, p_service))
      )
  )
$$;

-- Does this person work at this desk? With the entry's service when it belongs to the desk
-- (Family planning at Nursing), else any service of the desk; desks that are no service
-- (reception, cashier, beds) keep their role.
create or replace function serves_station(p_user uuid, p_station station, p_service text default null)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    when p_service is not null and service_station(p_service) = p_station then staff_serves(p_user, p_service)
    when p_station in ('consultation', 'dental', 'laboratory', 'ultrasound', 'nursing', 'theatre', 'pharmacy', 'triage') then
      exists (select 1 from unnest(array['consultation', 'dental', 'laboratory', 'ultrasound', 'nursing', 'surgery',
                                         'circ', 'fp', 'hiv', 'pharmacy', 'triage']) as x(s)
              where service_station(x.s) = p_station and staff_serves(p_user, x.s))
    else exists (select 1 from profiles where id = p_user and active and role = station_role(p_station))
  end
$$;

-- ---------------------------------------------------------------- who may take a patient
create or replace function queue_entry_for_me(p_queue_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from queue_entry q
    join profiles me on me.id = auth.uid() and me.active
    left join lateral (select covering_for(me.id) as doc) cv on true
    where q.id = p_queue_id and q.deleted_at is null
      and (
        me.role = 'manager'
        or me.id = q.assigned_to or me.id = q.taken_by or me.id = q.return_to
        or (cv.doc is not null and (cv.doc = q.assigned_to or cv.doc = q.taken_by))
        -- sent to the section: anyone who works in it (or covers someone who does)
        or (q.assigned_to is null and q.taken_by is null
            and (serves_station(me.id, q.station, q.service)
                 or (cv.doc is not null and serves_station(cv.doc, q.station, q.service)))
            and (q.department_id is null
                 or me.department_id = q.department_id
                 or exists (select 1 from staff_department sd
                            where sd.profile_id = me.id and sd.department_id = q.department_id)))
      )
  )
$$;

-- ---------------------------------------------------------------- who is told
alter table notification add column if not exists recipient_stations station[];

create or replace function notification_is_mine(n notification, p_me uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles p
    where p.id = p_me and p.active and (
      (n.to_all and (not n.heads_only or exists (
          select 1 from staff_department sd where sd.profile_id = p.id and sd.position in ('head', 'assistant'))))
      or n.recipient_user = p_me
      or (n.recipient_role is not null and n.recipient_role = p.role and n.recipient_department is null)
      or (n.recipient_department is not null and exists (
            select 1 from staff_department sd
            where sd.profile_id = p.id and sd.department_id = n.recipient_department
              and (not n.heads_only or sd.position in ('head', 'assistant'))))
      -- a patient waiting at a section: the people who work in it
      or (n.recipient_stations is not null and n.recipient_department is null and n.recipient_user is null
          and exists (select 1 from unnest(n.recipient_stations) as x(s)
                      where serves_station(p_me, x.s, n.params ->> 'service')))
    )
  )
$$;

create or replace function notify_queue_entry()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_triage text;
  v_by text;
  v_vitals boolean;
begin
  if new.pool_id is not null then
    return new;
  end if;
  select p.surname || ' ' || p.given_names, e.triage_level::text into v_name, v_triage
  from encounter e join patient p on p.id = e.patient_id where e.id = new.encounter_id;
  select exists (select 1 from observation o where o.encounter_id = new.encounter_id and o.deleted_at is null
                 and o.code in ('bp_sys', 'bp_dia', 'pulse', 'temp', 'resp', 'spo2', 'weight', 'height', 'muac'))
  into v_vitals;
  if new.referred_by is not null then
    select full_name into v_by from profiles where id = new.referred_by;
    insert into notification (kind, params, link, urgent, recipient_user, recipient_stations, recipient_department, created_by)
    values ('referral',
            jsonb_build_object('ticket', new.ticket_no, 'name', v_name, 'station', new.station,
                               'by', v_by, 'note', new.referral_note, 'queue', new.id,
                               'back', new.return_station is not null, 'vitals', v_vitals,
                               'service', new.service),
            '/app/visit?encounter=' || new.encounter_id,
            coalesce(v_triage, '') = 'red' or new.priority = 1,
            new.assigned_to,
            case when new.assigned_to is null and new.department_id is null then array[new.station] end,
            case when new.assigned_to is null then new.department_id end,
            auth.uid());
    return new;
  end if;
  -- one person named: only them; else the people of the section
  insert into notification (kind, params, link, urgent, recipient_user, recipient_stations, created_by)
  values ('queue',
          jsonb_build_object('ticket', new.ticket_no, 'name', v_name, 'station', new.station,
                             'triage', v_triage, 'queue', new.id, 'vitals', v_vitals, 'service', new.service),
          case when new.station = 'triage' then '/app/vitals?encounter=' else '/app/visit?encounter=' end
            || new.encounter_id,
          coalesce(v_triage, '') = 'red' or new.priority = 1,
          new.assigned_to,
          case when new.assigned_to is null then array[new.station] end,
          auth.uid());
  return new;
end
$$;

-- The same, for an entry changed after it was added (begin_visit names a person).
create or replace function notify_queue_entry_row(q queue_entry)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_by text;
begin
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = q.encounter_id;
  select full_name into v_by from profiles where id = q.referred_by;
  delete from notification where kind in ('queue', 'referral') and params ->> 'queue' = q.id::text;
  insert into notification (kind, params, link, recipient_user, recipient_stations, recipient_department, created_by)
  values ('referral',
          jsonb_build_object('ticket', q.ticket_no, 'name', v_name, 'station', q.station, 'by', v_by,
                             'note', q.referral_note, 'queue', q.id, 'back', q.return_station is not null,
                             'service', q.service),
          '/app/visit?encounter=' || q.encounter_id,
          q.assigned_to,
          case when q.assigned_to is null and q.department_id is null then array[q.station] end,
          case when q.assigned_to is null then q.department_id end,
          auth.uid());
end
$$;

-- Several desks at once: one notice for the people who work in any of them.
create or replace function send_to_stations(
  p_encounter_id uuid,
  p_station station,
  p_next station[]
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_pool uuid;
  v_next station;
  v_name text;
  v_triage text;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_may_work_on(p_encounter_id, true);
  if p_next is null or cardinality(p_next) = 0 then
    raise exception 'choose where the patient goes' using errcode = '22023';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  perform leave_desk(p_encounter_id, p_station);
  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
  v_pool := case when cardinality(p_next) > 1 then gen_random_uuid() end;
  foreach v_next in array p_next loop
    if exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = v_next
               and finished_at is null and deleted_at is null) then
      update queue_entry set pool_id = coalesce(v_pool, pool_id)
      where encounter_id = p_encounter_id and station = v_next and finished_at is null;
    else
      insert into queue_entry (encounter_id, station, ticket_no, pool_id)
      values (p_encounter_id, v_next, coalesce(v_ticket, 'A-000'), v_pool);
    end if;
  end loop;
  if v_pool is not null then
    select p.surname || ' ' || p.given_names, e.triage_level::text into v_name, v_triage
    from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id;
    insert into notification (kind, params, link, urgent, recipient_stations, created_by)
    values ('queue_pool',
            jsonb_build_object('ticket', coalesce(v_ticket, 'A-000'), 'name', v_name,
                               'stations', to_jsonb(p_next), 'triage', v_triage, 'pool', v_pool),
            '/app/visit?encounter=' || p_encounter_id,
            coalesce(v_triage, '') = 'red',
            p_next,
            auth.uid());
  end if;
  return jsonb_build_object('pool', v_pool, 'stations', to_jsonb(p_next));
end
$$;

-- ---------------------------------------------------------------- send on to a section
-- refer_patient gains the service: "Family planning" goes to Nursing for those who give it.
drop function if exists refer_patient(uuid, station, station, uuid, text, boolean, uuid);
create or replace function refer_patient(
  p_encounter_id uuid,
  p_from station,
  p_to station,
  p_to_user uuid default null,
  p_note text default null,
  p_return boolean default false,
  p_department uuid default null,
  p_service text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_id uuid;
  v_service text := case when p_service is not null and service_station(p_service) = p_to then p_service end;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  perform assert_may_work_on(p_encounter_id, true);
  if p_service is not null and service_station(p_service) is distinct from p_to then
    raise exception 'that service is not given at %', initcap(p_to::text) using errcode = '22023';
  end if;
  if p_department is not null and not exists (select 1 from department where id = p_department and deleted_at is null) then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  -- A covered doctor keeps the patient: the covering nurse may work on it meanwhile
  -- (queue_entry_for_me), and it is still the doctor's when the cover ends.
  if p_to_user is not null and not exists (select 1 from profiles where id = p_to_user and active) then
    raise exception 'that colleague is not an active employee' using errcode = '22023';
  end if;
  perform leave_desk(p_encounter_id, p_from);
  -- Already waiting at that desk: update the waiting entry instead of adding a second one.
  update queue_entry
  set assigned_to = p_to_user, department_id = p_department, referred_by = auth.uid(),
      referral_note = nullif(trim(coalesce(p_note, '')), ''),
      return_station = case when p_return then p_from end,
      return_to = case when p_return then auth.uid() end,
      service = coalesce(v_service, service)
  where encounter_id = p_encounter_id and station = p_to and finished_at is null and deleted_at is null
  returning id into v_id;
  if v_id is null then
    select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
    insert into queue_entry (encounter_id, station, ticket_no, assigned_to, department_id, referred_by, referral_note,
                             return_station, return_to, service)
    values (p_encounter_id, p_to, coalesce(v_ticket, 'A-000'), p_to_user, p_department, auth.uid(),
            nullif(trim(coalesce(p_note, '')), ''),
            case when p_return then p_from end,
            case when p_return then auth.uid() end,
            v_service)
    returning id into v_id;
  end if;
  return jsonb_build_object('queueId', v_id, 'station', p_to);
end
$$;

revoke all on function upsert_department(uuid, text, text, role_key[], text[]),
  refer_patient(uuid, station, station, uuid, text, boolean, uuid, text),
  staff_services(uuid), service_has_staff(text), serves_station(uuid, station, text)
  from public, anon;
grant execute on function upsert_department(uuid, text, text, role_key[], text[]),
  refer_patient(uuid, station, station, uuid, text, boolean, uuid, text),
  staff_services(uuid), service_has_staff(text), serves_station(uuid, station, text)
  to authenticated;

-- ---------------------------------------------------------------- my queue across desks
-- for_me: sent to me by name, taken by me, or waiting for anyone in a section I work in; the
-- home queue shows these whatever the desk (a nurse of Consultation sees its patients).
create or replace view queue_board with (security_invoker = true) as
  select q.id as queue_id, q.encounter_id, q.station, q.ticket_no, q.priority,
         q.created_at as queued_at, q.called_at, q.started_at, q.finished_at,
         e.patient_id, e.triage_level, e.arrived_at, e.type as encounter_type,
         p.file_number, p.surname, p.given_names, p.sex, p.birth_date, p.phone_1,
         q.pool_id, tb.full_name as taken_by_name,
         q.assigned_to, asg.full_name as assigned_name, rb.full_name as referred_by_name,
         q.referral_note, q.return_station,
         v.effective_at as vitals_at, v.measured_by as vitals_by,
         q.department_id, dep.name as department_name, queue_entry_for_me(q.id) as can_work,
         q.taken_by, coalesce(q.service, e.service) as service,
         (q.assigned_to = auth.uid() or q.taken_by = auth.uid()
          or (q.assigned_to is null and q.taken_by is null
              and serves_station(auth.uid(), q.station, q.service))) as for_me
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  join patient p on p.id = e.patient_id
  left join profiles tb on tb.id = q.taken_by
  left join profiles asg on asg.id = q.assigned_to
  left join profiles rb on rb.id = q.referred_by
  left join department dep on dep.id = q.department_id
  left join lateral last_vitals_stamp(q.encounter_id) v on true
  where q.deleted_at is null and e.status = 'open';
