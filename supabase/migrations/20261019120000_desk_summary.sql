-- 0019 · Front-desk and nursing dashboards.
--
-- desk_summary(): today's figures every signed-in staff member may see (no money): patients
-- registered, visits, who is waiting where and for how long, the triage queue by colour,
-- vitals taken, appointments and inquiries, beds, arrivals per hour and the caller's own work.
-- The receptionist and nurse home dashboards are built from it; dashboard_summary() stays for
-- managers and heads of station.

create or replace function desk_summary()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_tiles jsonb;
  v_stations jsonb;
  v_hours jsonb;
  v_mine jsonb;
begin
  if not exists (select 1 from profiles where id = v_me and active) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'registeredToday', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date = v_today),
    'registeredYesterday', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date = v_today - 1),
    'visitsToday', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date = v_today),
    'visitsYesterday', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date = v_today - 1),
    'inClinic', (select count(*) from encounter where deleted_at is null and status = 'open'),
    'waitingNow', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                   where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'),
    'avgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at, now()) - q.created_at) / 60)), 0)
                   from queue_entry q where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'triageWaiting', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                      where q.deleted_at is null and q.station = 'triage' and q.finished_at is null and e.status = 'open'),
    'triageRed', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                  where q.deleted_at is null and q.finished_at is null and e.status = 'open' and e.triage_level = 'red'),
    'triageYellow', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                     where q.deleted_at is null and q.finished_at is null and e.status = 'open' and e.triage_level = 'yellow'),
    'triageAvgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at, now()) - q.created_at) / 60)), 0)
                         from queue_entry q where q.deleted_at is null and q.station = 'triage'
                           and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'vitalsToday', (select count(distinct encounter_id) from observation where deleted_at is null and (effective_at at time zone 'Africa/Kigali')::date = v_today),
    'vitalsYesterday', (select count(distinct encounter_id) from observation where deleted_at is null and (effective_at at time zone 'Africa/Kigali')::date = v_today - 1),
    'apptsToday', (select count(*) from appointment where deleted_at is null
                   and status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed')
                   and (starts_at at time zone 'Africa/Kigali')::date = v_today),
    'inquiriesPending', (select count(*) from appointment where deleted_at is null and status = 'inquiry'),
    'bedsOccupied', (select count(*) from bed where deleted_at is null and status = 'occupied'),
    'bedsTotal', (select count(*) from bed where deleted_at is null and status <> 'out_of_service')
  ) into v_tiles;

  -- Where patients are right now: waiting / being seen per station, average wait today.
  select coalesce(jsonb_agg(jsonb_build_object('station', s.station, 'waiting', s.waiting, 'busy', s.busy, 'minutes', s.minutes)
                            order by s.station), '[]'::jsonb) into v_stations
  from (
    select q.station::text as station,
           count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open') as waiting,
           count(*) filter (where q.finished_at is null and q.started_at is not null and e.status = 'open') as busy,
           round(avg(extract(epoch from coalesce(q.started_at, q.finished_at, now()) - q.created_at) / 60)) as minutes
    from queue_entry q
    join encounter e on e.id = q.encounter_id
    where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date = v_today
    group by q.station
  ) s;

  -- Arrivals per hour today (06:00–21:00, plus any hour outside that had arrivals).
  select coalesce(jsonb_agg(jsonb_build_object('hour', h.hour, 'count', coalesce(a.n, 0)) order by h.hour), '[]'::jsonb) into v_hours
  from (
    select generate_series(6, 21) as hour
    union
    select extract(hour from arrived_at at time zone 'Africa/Kigali')::int
    from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date = v_today
  ) h
  left join (
    select extract(hour from arrived_at at time zone 'Africa/Kigali')::int as hour, count(*) as n
    from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date = v_today
    group by 1
  ) a on a.hour = h.hour;

  -- The caller's own work today (accountability, and a little motivation).
  select jsonb_build_object(
    'registrations', (select count(*) from patient where deleted_at is null and created_by = v_me and (created_at at time zone 'Africa/Kigali')::date = v_today),
    'visitsStarted', (select count(*) from encounter where deleted_at is null and created_by = v_me and (arrived_at at time zone 'Africa/Kigali')::date = v_today),
    'vitals', (select count(distinct encounter_id) from observation where deleted_at is null and performer_id = v_me and (effective_at at time zone 'Africa/Kigali')::date = v_today),
    'charges', (select count(*) from invoice_line where deleted_at is null and entered_by = v_me and (created_at at time zone 'Africa/Kigali')::date = v_today)
  ) into v_mine;

  return jsonb_build_object('tiles', v_tiles, 'stations', v_stations, 'arrivals', v_hours, 'mine', v_mine);
end
$$;

grant execute on function desk_summary() to authenticated;
revoke execute on function desk_summary() from anon;
