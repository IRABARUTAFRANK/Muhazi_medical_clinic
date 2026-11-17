-- 0182 · Reports by role. Frank: "they must access reports according to their roles, with the
-- manager having access to all, and the doctor to all on clinical records, patients and other
-- related data, excluding finance". On the web (lib/reports/access.ts) the finance desk's head no
-- longer reads the clinical, laboratory and visits reports; here the database follows the one
-- rule it did not yet: a DOCTOR reads the clinic's visits and files.
--
--   * report_visit_scope(): the scope of the patients reports. The manager and the heads as
--     before (analytics_scope: the manager the whole clinic or one department, a head their
--     department, anyone else refused); a doctor (is_doctor: the role, marked by the manager, or
--     appointed in a department) the whole clinic, or one department when asked — never money
--     (report_visits gives the money to is_manager / billing.read only, as before) and never
--     another person's records (visit_view decides per visit, as before).
--   * report_visit_set() reads that scope instead of analytics_scope (the staff and revenue
--     functions keep analytics_scope: a doctor does not read the staff's work or the money).
--   * report_registrations_reader(): + a doctor (the files created: identity only).
--   * report_patients_options(): a doctor is offered every department in the filter.
--
-- Reception and the nurses are unchanged: the registrations (reception), the vital signs and the
-- bookings; the visits lists still refuse them (0110).

create or replace function report_visit_scope(
  p_department uuid default null,
  out s_manager boolean,
  out s_department uuid,
  out s_desks text[],
  out s_stations station[],
  out s_members uuid[]
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if is_manager() or not is_doctor() then
    select a.s_manager, a.s_department, a.s_desks, a.s_stations, a.s_members
      into s_manager, s_department, s_desks, s_stations, s_members
    from analytics_scope(p_department) a;
    return;
  end if;
  -- a doctor: the whole clinic (or the department asked for), without money
  s_manager := false;
  s_department := p_department;
  if p_department is null then
    s_desks := null;
    s_stations := enum_range(null::station);
    s_members := null;
    return;
  end if;
  select coalesce(d.services, '{}') into s_desks
  from department d where d.id = p_department and d.deleted_at is null;
  if not found then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(st order by st), '{}') into s_stations
  from unnest(enum_range(null::station)) st
  where station_desks(st) && s_desks;
  select coalesce(array_agg(sd.profile_id), '{}') into s_members
  from staff_department sd where sd.department_id = p_department;
end
$$;
revoke all on function report_visit_scope(uuid) from public, anon, authenticated;

-- report_visit_set (20261220090000_reports_patients): the scope above
create or replace function report_visit_set(p_from date, p_to date, p_f jsonb)
returns table (
  encounter_id uuid,
  reference text,
  arrived_at timestamptz,
  closed_at timestamptz,
  status text,
  visit_type text,
  triage text,
  service text,
  patient_id uuid,
  department_id uuid,
  department text,
  doctor_id uuid,
  doctor text,
  insurer_id uuid,
  insurer text,
  stations text[],
  first_visit boolean
)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  s record;
  v_dep uuid := nullif(p_f ->> 'department', '')::uuid;
  v_desk text := nullif(p_f ->> 'desk', '');
  v_doctor uuid := nullif(p_f ->> 'doctor', '')::uuid;
  v_service text := nullif(p_f ->> 'service', '');
  v_insurer uuid := nullif(p_f ->> 'insurer', '')::uuid;
  v_status text := nullif(p_f ->> 'status', '');
begin
  select * into s from report_visit_scope(v_dep);
  return query
  with base as (
    select e.id as encounter_id, e.reference, e.arrived_at, e.closed_at,
           case when e.status = 'open' then 'open'
                when visit_was_seen(e.id) then 'finished'
                else 'left_unseen' end as status,
           e.type::text as visit_type, e.triage_level::text as triage, e.service, e.patient_id,
           d.id as department_id, d.name as department,
           doc.id as doctor_id, doc.full_name as doctor,
           ins.id as insurer_id, ins.name as insurer,
           coalesce((select array_agg(x.station::text order by x.first_at)
                     from (select q.station, min(q.created_at) as first_at from queue_entry q
                           where q.encounter_id = e.id and q.deleted_at is null
                           group by q.station) x), '{}'::text[]) as stations,
           not exists (select 1 from encounter e0
                       where e0.patient_id = e.patient_id and e0.deleted_at is null
                         and e0.arrived_at < e.arrived_at) as first_visit
    from encounter e
    left join lateral (
      select q.department_id from queue_entry q
      where q.encounter_id = e.id and q.deleted_at is null and q.department_id is not null
      order by q.created_at desc limit 1
    ) qd on true
    left join department d on d.id = qd.department_id
    left join lateral (
      select pr.id, pr.full_name from profiles pr
      where pr.id = coalesce(
        (select c0.created_by from condition c0 where c0.encounter_id = e.id and c0.deleted_at is null
         order by c0.created_at limit 1),
        (select q.taken_by from queue_entry q
         where q.encounter_id = e.id and q.deleted_at is null and q.taken_by is not null
           and q.station not in ('reception', 'triage', 'cashier', 'pharmacy')
         order by coalesce(q.started_at, q.created_at) limit 1))
    ) doc on true
    left join lateral (
      select py.id, py.name from coverage cv
      join payer py on py.id = cv.payer_id and py.type <> 'cash'
      where cv.id = coalesce((select i.coverage_id from invoice i where i.encounter_id = e.id and i.deleted_at is null limit 1),
                             e.coverage_id)
    ) ins on true
    where e.deleted_at is null
      and (e.arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to
      and (s.s_department is null or exists (
        select 1 from queue_entry q where q.encounter_id = e.id and q.deleted_at is null
          and (q.department_id = s.s_department or q.station = any (s.s_stations))))
  )
  select b.encounter_id, b.reference, b.arrived_at, b.closed_at, b.status, b.visit_type, b.triage,
         b.service, b.patient_id, b.department_id, b.department, b.doctor_id, b.doctor,
         b.insurer_id, b.insurer, b.stations, b.first_visit
  from base b
  where (v_desk is null or v_desk = any (b.stations))
    and (v_doctor is null or b.doctor_id = v_doctor)
    and (v_service is null or b.service = v_service)
    and (v_insurer is null or b.insurer_id = v_insurer)
    and (v_status is null or b.status = v_status);
end
$$;
revoke all on function report_visit_set(date, date, jsonb) from public, anon, authenticated;

-- the files created: + a doctor
create or replace function report_registrations_reader()
returns boolean
language sql stable security definer set search_path = public
as $$
  select auth.uid() is not null and (
    is_manager()
    or is_doctor()
    or current_role_key() = 'receptionist'
    or exists (select 1 from staff_department sd
               join department d on d.id = sd.department_id and d.deleted_at is null
               join profiles p on p.id = sd.profile_id and p.active
               where sd.profile_id = auth.uid() and sd.position in ('head', 'assistant')))
$$;
revoke all on function report_registrations_reader() from public, anon, authenticated;

-- report_patients_options (20261220090000_reports_patients): a doctor sees every department
create or replace function report_patients_options()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := is_manager();
begin
  if not report_registrations_reader() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    -- the manager and a doctor (0182): every department (a closed one still has its past
    -- visits), the active first; a head: their own (as analytics_scope reads them)
    'departments', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name)
                       order by d.active desc, d.sort_order, d.name)
      from department d
      where d.deleted_at is null
        and case when v_manager or is_doctor() then true
                 else exists (select 1 from staff_department sd
                              where sd.department_id = d.id and sd.profile_id = auth.uid()
                                and sd.position in ('head', 'assistant')) end), '[]'::jsonb),
    'doctors', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name) order by p.full_name)
      from profiles p
      where p.active and p.deleted_at is null and p.role in ('doctor', 'sonographer')), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(x.service order by x.service)
      from (select distinct e.service from encounter e
            where e.service is not null and e.deleted_at is null) x), '[]'::jsonb),
    'insurers', coalesce((
      select jsonb_agg(jsonb_build_object('id', py.id, 'name', py.name) order by py.name)
      from payer py where py.type <> 'cash' and py.deleted_at is null), '[]'::jsonb),
    'districts', coalesce((
      select jsonb_agg(x.district order by x.district)
      from (select distinct initcap(trim(p.district)) as district from patient p
            where nullif(trim(coalesce(p.district, '')), '') is not null and p.deleted_at is null) x), '[]'::jsonb),
    'registrars', coalesce((
      select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.full_name) order by pr.full_name)
      from profiles pr
      where pr.id in (select distinct p.created_by from patient p where p.created_by is not null)), '[]'::jsonb));
end
$$;
revoke all on function report_patients_options() from public, anon;
grant execute on function report_patients_options() to authenticated;
