-- 0069 · Send by service, to the section or to one person.
-- The clinic's services (the same list as the website): medical consultation, dental services,
-- laboratory services, nursing care, minor surgery, ultrasound, circumcision, family planning,
-- HIV testing & vaccination (and the pharmacy, to buy medicines). Choosing the service chooses
-- its section (desk); under it the registering person sees who serves that service, whether they
-- work now, and how many patients wait for or are with each, and sends the patient to anyone in
-- the section or to one person. With "triage first", the service and the person chosen are kept
-- on the visit: after the measurements the patient goes there.

alter table encounter add column if not exists service text;
alter table encounter add column if not exists intended_to uuid references profiles (id) on delete set null;
alter table queue_entry add column if not exists service text;

-- the desk of each service
create or replace function service_station(p_service text)
returns station
language sql immutable
as $$
  select case p_service
    when 'consultation' then 'consultation'
    when 'dental' then 'dental'
    when 'laboratory' then 'laboratory'
    when 'ultrasound' then 'ultrasound'
    when 'nursing' then 'nursing'
    when 'surgery' then 'theatre'
    when 'circ' then 'theatre'
    when 'fp' then 'nursing'
    when 'hiv' then 'nursing'
    when 'pharmacy' then 'pharmacy'
  end::station
$$;

-- Who serves a service: a doctor or sonographer by the services of their calendar (or, with no
-- service set there, by their desk); nurses, the laboratory and the pharmacy by their role.
create or replace function staff_serves(p_user uuid, p_service text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles p
    left join practitioner pr on pr.user_id = p.id and pr.deleted_at is null
    where p.id = p_user and p.active and (
      -- the services written in the person's calendar
      (coalesce(array_length(pr.categories, 1), 0) > 0 and p_service = any (pr.categories)
       and p.role in ('doctor', 'sonographer', 'nurse'))
      -- no service in the calendar: the person's desk
      or (coalesce(array_length(pr.categories, 1), 0) = 0 and p.role = 'doctor' and (
            (p_service = 'dental' and lower(coalesce(p.station, '')) ~ 'dent')
            or (p_service in ('surgery', 'circ') and lower(coalesce(p.station, '')) ~ '(theat|surg|circ)')
            or (p_service = 'ultrasound' and lower(coalesce(p.station, '')) ~ '(ultra|echo)')
            or (p_service = 'consultation' and lower(coalesce(p.station, '')) !~ '(dent|theat|surg|ultra|echo)')))
      or (p.role = 'sonographer' and p_service = 'ultrasound')
      or (p.role = 'nurse' and p_service in ('nursing', 'fp', 'hiv'))
      or (p.role = 'lab_tech' and p_service = 'laboratory')
      or (p.role = 'pharmacist' and p_service = 'pharmacy')
    )
  )
$$;

-- The people of a service, with what they do now (for "send to whom?").
create or replace function service_staff(p_service text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_station station := service_station(p_service);
  v_today date := (now() at time zone 'Africa/Kigali')::date;
begin
  if not exists (select 1 from profiles where id = auth.uid() and active) then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_station is null then
    raise exception 'unknown service' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'service', p_service,
    'station', v_station,
    -- patients waiting at the section for anyone
    'sectionWaiting', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                       where q.deleted_at is null and q.station = v_station and q.finished_at is null
                         and q.started_at is null and q.assigned_to is null and e.status = 'open'),
    'staff', coalesce((
      select jsonb_agg(x.j order by (x.j ->> 'workingNow') = 'true' desc, (x.j ->> 'onDuty') = 'true' desc,
                                    (x.j ->> 'waiting')::int + (x.j ->> 'seeing')::int, x.j ->> 'name')
      from (
        select jsonb_build_object(
          'id', p.id, 'name', p.full_name, 'role', p.role, 'station', p.station,
          'departments', (select string_agg(d.name, ', ' order by d.name) from staff_department sd
                          join department d on d.id = sd.department_id and d.deleted_at is null
                          where sd.profile_id = p.id),
          'specialty', pr.title,
          -- by the calendar's hours (null: no calendar)
          'workingNow', case when pr.id is null or pr.working_hours = '{}'::jsonb then null
                             else practitioner_is_working(pr.id, now()) end,
          'onDuty', (p.last_sign_in_at at time zone 'Africa/Kigali')::date = v_today,
          'waiting', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                      where q.deleted_at is null and q.assigned_to = p.id and q.finished_at is null
                        and q.started_at is null and e.status = 'open'),
          'seeing', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                     where q.deleted_at is null and q.taken_by = p.id and q.finished_at is null
                       and e.status = 'open')
        ) as j
        from profiles p
        left join practitioner pr on pr.user_id = p.id and pr.deleted_at is null
        where p.active and staff_serves(p.id, p_service)
      ) x
    ), '[]'::jsonb)
  );
end
$$;

-- New queue entries carry the visit's service, and the person chosen at registration gets the
-- patient at that service's desk (after triage when triage comes first).
create or replace function queue_entry_defaults()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_enc encounter%rowtype;
  v_doc uuid;
begin
  select * into v_enc from encounter where id = new.encounter_id;
  if not found or v_enc.status <> 'open' then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  new.priority := least(coalesce(new.priority, 3),
                        case v_enc.triage_level when 'red' then 1 when 'yellow' then 2 else 3 end);
  new.service := coalesce(new.service, v_enc.service);
  if new.assigned_to is null and new.pool_id is null and new.department_id is null
     and v_enc.intended_to is not null and v_enc.service is not null
     and new.station = service_station(v_enc.service)
     and not exists (select 1 from queue_entry q where q.encounter_id = new.encounter_id
                     and q.station = new.station and q.deleted_at is null) then
    new.assigned_to := v_enc.intended_to;
  end if;
  if new.assigned_to is null and new.pool_id is null and new.department_id is null
     and station_role(new.station) = 'doctor' and v_enc.appointment_id is not null then
    select pr.user_id into v_doc
    from appointment a
    join practitioner pr on pr.id = a.practitioner_id
    join profiles p on p.id = pr.user_id and p.active
    where a.id = v_enc.appointment_id;
    new.assigned_to := v_doc;
  end if;
  return new;
end
$$;

drop function if exists begin_visit(uuid, station, uuid, text, boolean, boolean);
create or replace function begin_visit(
  p_patient_id uuid,
  p_station station default 'consultation',
  p_department_id uuid default null,
  p_note text default null,
  p_myself boolean default false,
  p_emergency boolean default false,
  p_service text default null,
  p_assigned_to uuid default null
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
       or (v_role = 'pharmacist' and v_desk = 'pharmacy')) then
    raise exception 'you do not work at % : send the patient there instead', initcap(v_desk::text)
      using errcode = '42501';
  end if;
  if p_assigned_to is not null and (p_service is null or not staff_serves(p_assigned_to, p_service)) then
    raise exception 'that person does not give this service' using errcode = '22023';
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
  v_enc := open_encounter(p_patient_id, 'opd', v_station);
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
      assigned_to = case when v_station = v_desk and not p_myself then coalesce(p_assigned_to, assigned_to) else assigned_to end,
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

-- the queue says which service the patient comes for
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
         q.taken_by, coalesce(q.service, e.service) as service
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  join patient p on p.id = e.patient_id
  left join profiles tb on tb.id = q.taken_by
  left join profiles asg on asg.id = q.assigned_to
  left join profiles rb on rb.id = q.referred_by
  left join department dep on dep.id = q.department_id
  left join lateral last_vitals_stamp(q.encounter_id) v on true
  where q.deleted_at is null and e.status = 'open';

revoke all on function begin_visit(uuid, station, uuid, text, boolean, boolean, text, uuid) from public, anon;
grant execute on function begin_visit(uuid, station, uuid, text, boolean, boolean, text, uuid) to authenticated;
revoke all on function service_staff(text), staff_serves(uuid, text) from public, anon;
grant execute on function service_staff(text), staff_serves(uuid, text) to authenticated;
