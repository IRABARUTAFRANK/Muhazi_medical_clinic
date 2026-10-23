-- 0075 · Every dashboard by period.
--
-- The lab, pharmacy, reception / nurse and home dashboards counted today only. They now take a
-- period (p_from, p_to; both default to today), like the manager's dashboard: Today, This week,
-- This month, All time, Custom. Reception's arrows compare with the period just before, as long
-- (yesterday for today). Lists of what is waiting now are not affected by the period.

drop function if exists lab_summary();
drop function if exists pharmacy_summary();
drop function if exists desk_summary();
drop function if exists home_summary();

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
    where r.deleted_at is null and r.category = any (my_test_categories())
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

create or replace function pharmacy_summary(p_from date default null, p_to date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with today as (
    select coalesce(p_from, k) as f, coalesce(p_to, p_from, k) as t
    from (select (now() at time zone 'Africa/Kigali')::date as k) z
  ),
  pending as (
    select m.* from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open'
    where rx_pending(m)
  ),
  given as (
    select m.* from medication_request m, today
    where m.deleted_at is null and m.supply = 'pharmacy' and m.given_at is not null
      and (m.given_at at time zone 'Africa/Kigali')::date between today.f and today.t
  )
  select jsonb_build_object(
    'lines', (select count(*) from pending),
    'patients', (select count(distinct encounter_id) from pending),
    'dispensedToday', (select count(*) from given),
    'patientsServedToday', (select count(distinct encounter_id) from given),
    'notGivenToday', (select count(*) from medication_request m, today
                      where m.deleted_at is null and (m.not_given_at at time zone 'Africa/Kigali')::date between today.f and today.t),
    'salesToday', (select coalesce(sum(l.patient_share + l.insurer_share), 0) from invoice_line l, today
                   where l.deleted_at is null and l.source_type = 'medication_dispense'
                     and (l.created_at at time zone 'Africa/Kigali')::date between today.f and today.t),
    'topToday', coalesce((select jsonb_agg(x order by x.count desc, x.item) from (
                   select i.name_generic || coalesce(' ' || i.strength, '') as item, count(*)::int as count
                   from given g join item i on i.id = g.item_id group by 1 order by 2 desc limit 5) x), '[]'::jsonb),
    'notGiven', coalesce((select jsonb_agg(jsonb_build_object(
                   'item', i.name_generic || coalesce(' ' || i.strength, ''), 'patient', p.surname || ' ' || p.given_names,
                   'reason', m.not_given_reason, 'at', m.not_given_at) order by m.not_given_at desc)
                 from medication_request m, today, item i, encounter e, patient p
                 where m.deleted_at is null and i.id = m.item_id and e.id = m.encounter_id and p.id = e.patient_id
                   and (m.not_given_at at time zone 'Africa/Kigali')::date between today.f and today.t), '[]'::jsonb)
  )
  where has_perm('stock.read')
$$;

create or replace function desk_summary(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  -- the period just before, as long (yesterday for today), for the arrows
  v_prev_to date := v_from - 1;
  v_prev_from date := v_from - (v_to - v_from + 1);
  v_tiles jsonb;
  v_stations jsonb;
  v_hours jsonb;
  v_mine jsonb;
begin
  if not exists (select 1 from profiles where id = v_me and active) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'registeredToday', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'registeredYesterday', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'visitsToday', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'visitsYesterday', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'inClinic', (select count(*) from encounter where deleted_at is null and status = 'open'),
    'waitingNow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
                   where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'),
    'avgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date between v_from and v_to)), 0)
                   from queue_entry q where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'triageWaiting', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                      where q.deleted_at is null and q.station = 'triage' and q.finished_at is null and e.status = 'open'),
    'triageRed', (select count(*) from encounter e where e.deleted_at is null and e.status = 'open' and e.triage_level = 'red'),
    'triageYellow', (select count(*) from encounter e where e.deleted_at is null and e.status = 'open' and e.triage_level = 'yellow'),
    'triageGreen', (select count(*) from encounter e where e.deleted_at is null and e.status = 'open' and e.triage_level = 'green'),
    'triageNone', (select count(*) from encounter e where e.deleted_at is null and e.status = 'open' and e.triage_level is null),
    -- patients still waiting for their first measurements (the Vitals page)
    'needVitals', (select count(*) from encounter e where e.deleted_at is null and e.status = 'open'
                   and not exists (select 1 from observation o where o.encounter_id = e.id and o.deleted_at is null and o.code <> 'note')),
    'triageAvgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date between v_from and v_to)), 0)
                         from queue_entry q where q.deleted_at is null and q.station = 'triage'
                           and (q.created_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'vitalsToday', (select count(distinct encounter_id) from observation where deleted_at is null and code <> 'note' and (effective_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'vitalsYesterday', (select count(distinct encounter_id) from observation where deleted_at is null and code <> 'note' and (effective_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'apptsToday', (select count(*) from appointment where deleted_at is null
                   and status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed')
                   and (starts_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'inquiriesPending', (select count(*) from appointment where deleted_at is null and status = 'inquiry'),
    'bedsOccupied', (select count(*) from bed where deleted_at is null and status = 'occupied'),
    'bedsTotal', (select count(*) from bed where deleted_at is null and status <> 'out_of_service')
  ) into v_tiles;

  -- Where patients are right now: waiting / being seen per station, average wait today.
  select coalesce(jsonb_agg(jsonb_build_object('station', s.station, 'waiting', s.waiting, 'busy', s.busy, 'minutes', s.minutes, 'longest', s.longest)
                            order by s.station), '[]'::jsonb) into v_stations
  from (
    select q.station::text as station,
           count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open') as waiting,
           count(*) filter (where q.finished_at is null and q.started_at is not null and e.status = 'open') as busy,
           round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date between v_from and v_to)) as minutes,
           round(max(extract(epoch from now() - q.created_at) / 60) filter (where q.finished_at is null and q.started_at is null and e.status = 'open')) as longest
    from queue_entry q
    join encounter e on e.id = q.encounter_id
    where q.deleted_at is null
      and ((q.finished_at is null and e.status = 'open') or (q.created_at at time zone 'Africa/Kigali')::date between v_from and v_to)
    group by q.station
  ) s;

  -- Arrivals per hour today (06:00–21:00, plus any hour outside that had arrivals).
  select coalesce(jsonb_agg(jsonb_build_object('hour', h.hour, 'count', coalesce(a.n, 0)) order by h.hour), '[]'::jsonb) into v_hours
  from (
    select generate_series(6, 21) as hour
    union
    select extract(hour from arrived_at at time zone 'Africa/Kigali')::int
    from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between v_from and v_to
  ) h
  left join (
    select extract(hour from arrived_at at time zone 'Africa/Kigali')::int as hour, count(*) as n
    from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between v_from and v_to
    group by 1
  ) a on a.hour = h.hour;

  -- The caller's own work today (accountability, and a little motivation).
  select jsonb_build_object(
    'registrations', (select count(*) from patient where deleted_at is null and created_by = v_me and (created_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'visitsStarted', (select count(*) from encounter where deleted_at is null and created_by = v_me and (arrived_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'vitals', (select count(distinct encounter_id) from observation where deleted_at is null and code <> 'note' and performer_id = v_me and (effective_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'charges', (select count(*) from invoice_line where deleted_at is null and entered_by = v_me and (created_at at time zone 'Africa/Kigali')::date between v_from and v_to)
  ) into v_mine;

  return jsonb_build_object('tiles', v_tiles, 'stations', v_stations, 'arrivals', v_hours, 'mine', v_mine);
end
$$;

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
  where k.deleted_at is null and k.done_at is null and (k.assigned_to = auth.uid() or k.assigned_role = v_role);

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

revoke all on function lab_summary(date, date) from public, anon;
grant execute on function lab_summary(date, date) to authenticated;
revoke all on function pharmacy_summary(date, date) from public, anon;
grant execute on function pharmacy_summary(date, date) to authenticated;
revoke all on function desk_summary(date, date) from public, anon;
grant execute on function desk_summary(date, date) to authenticated;
revoke all on function home_summary(date, date) from public, anon;
grant execute on function home_summary(date, date) to authenticated;
