-- 0030 — Patients waiting overnight no longer vanish at midnight.
-- The queue counts only looked at entries created today, so a visit still open from yesterday
-- (e.g. sent to "any available doctor" in the evening) disappeared from "In the clinic", the
-- station tiles and the waiting counts. Waiting / being-seen now means: an unfinished entry of an
-- open visit, whatever day it started; averages stay "today". A patient shared between several
-- desks (first free doctor) counts once in the totals.

create or replace function public_clinic_status()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_local timestamp := now() at time zone 'Africa/Kigali';
  v_hours jsonb := coalesce((select value -> 'days' from setting where key = 'clinic.hours'), '{}'::jsonb);
  v_span jsonb := v_hours -> extract(dow from v_local)::int::text;
  v_waiting integer;
  v_avg numeric;
  v_open boolean := false;
begin
  -- Patients still waiting, whatever day they arrived; one patient shared by several desks counts once.
  select count(distinct q.encounter_id) into v_waiting
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  where q.finished_at is null and q.deleted_at is null and e.status = 'open';
  select round(avg(extract(epoch from (called_at - created_at)) / 60)) into v_avg
  from queue_entry
  where called_at is not null and deleted_at is null
    and (created_at at time zone 'Africa/Kigali')::date = v_local::date;
  if v_span is not null and jsonb_array_length(v_span) = 2 then
    v_open := v_local::time >= (v_span ->> 0)::time and v_local::time < (v_span ->> 1)::time;
  end if;
  return jsonb_build_object(
    'waiting', coalesce(v_waiting, 0),
    'avg_wait_min', coalesce(v_avg, 0),
    'open', v_open,
    'opens_at', v_span ->> 0,
    'closes_at', v_span ->> 1,
    'as_of', now()
  );
end
$$;

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
    'waitingNow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
                   where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'),
    'avgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at, now()) - q.created_at) / 60)), 0)
                   from queue_entry q where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'triageWaiting', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                      where q.deleted_at is null and q.station = 'triage' and q.finished_at is null and e.status = 'open'),
    'triageRed', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
                  where q.deleted_at is null and q.finished_at is null and e.status = 'open' and e.triage_level = 'red'),
    'triageYellow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
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
    where q.deleted_at is null
      and ((q.finished_at is null and e.status = 'open') or (q.created_at at time zone 'Africa/Kigali')::date = v_today)
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

create or replace function dashboard_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := is_manager();
  v_days integer := greatest(1, p_to - p_from + 1);
  v_prev_from date := p_from - v_days;
  v_prev_to date := p_from - 1;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_tiles jsonb;
  v_rev30 jsonb;
  v_collections jsonb;
  v_receivables jsonb;
  v_visits jsonb;
  v_wait jsonb;
  v_queue jsonb;
  v_top jsonb;
  v_staff jsonb;
  v_reorder jsonb;
  v_expiring jsonb;
  v_noshow jsonb;
  v_messages jsonb;
  v_claims jsonb;
  v_logins jsonb;
  v_services jsonb;
begin
  if not (v_manager or exists (select 1 from profiles where id = auth.uid() and active and dashboard is not null)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  -- headline tiles
  select jsonb_build_object(
    'registered', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'registeredPrev', (select count(*) from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'visits', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'visitsPrev', (select count(*) from encounter where deleted_at is null and (arrived_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'waitingNow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'),
    'avgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at, now()) - q.created_at) / 60)), 0)
                   from queue_entry q where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'revenue', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to) end,
    'revenuePrev', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to) end,
    'openBills', case when v_manager then (select count(*) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'openBillsDue', case when v_manager then (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'bedsOccupied', (select count(*) from bed where deleted_at is null and status = 'occupied'),
    'bedsTotal', (select count(*) from bed where deleted_at is null and status <> 'out_of_service')
  ) into v_tiles;

  -- revenue per day, last 30 days ending today
  select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'amount', coalesce(s.amount, 0)) order by d), '[]'::jsonb) into v_rev30
  from generate_series(v_today - 29, v_today, interval '1 day') d
  left join (
    select (paid_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
    from payment where deleted_at is null and paid_at >= (v_today - 29)::timestamp
    group by 1
  ) s on s.day = d::date;

  select coalesce(jsonb_agg(jsonb_build_object('method', m, 'amount', coalesce(s.amount, 0)) order by s.amount desc nulls last), '[]'::jsonb) into v_collections
  from unnest(array['cash', 'momo', 'airtel', 'card', 'bank']::payment_method[]) m
  left join (
    select method, sum(amount) as amount from payment
    where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by method
  ) s on s.method = m;

  select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'count', c.n, 'amount', c.amount) order by c.amount desc), '[]'::jsonb) into v_receivables
  from (
    select payer_id, count(*) as n, sum(amount) as amount from claim
    where deleted_at is null and status in ('open', 'batched', 'submitted', 'rejected', 'resubmitted')
    group by payer_id
  ) c join payer py on py.id = c.payer_id;

  -- visits by service group (charged lines in the range)
  select coalesce(jsonb_agg(jsonb_build_object('group', g.grp, 'count', g.n) order by g.n desc), '[]'::jsonb) into v_visits
  from (
    select coalesce(s.service_group::text, 'pharmacy') as grp, count(distinct i.encounter_id) as n
    from invoice_line l
    join invoice i on i.id = l.invoice_id
    left join service s on s.id = l.service_id
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by 1
  ) g;

  -- waiting time and queue by station (today)
  select coalesce(jsonb_agg(jsonb_build_object('station', w.station, 'minutes', w.minutes, 'waiting', w.waiting) order by w.station), '[]'::jsonb) into v_wait
  from (
    select q.station::text as station,
           round(avg(extract(epoch from coalesce(q.started_at, q.finished_at, now()) - q.created_at) / 60)) as minutes,
           count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open') as waiting
    from queue_entry q
    join encounter e on e.id = q.encounter_id
    where q.deleted_at is null
      and ((q.finished_at is null and e.status = 'open') or (q.created_at at time zone 'Africa/Kigali')::date = v_today)
    group by q.station
  ) w;

  -- top treatments in the range
  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'count', x.n, 'amount', case when v_manager then x.amount end) order by x.n desc), '[]'::jsonb) into v_top
  from (
    select l.description as name, count(*) as n, sum(round(l.unit_price * l.quantity)) as amount
    from invoice_line l
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by l.description
    order by count(*) desc
    limit 10
  ) x;

  -- who did what (accountability)
  select coalesce(jsonb_agg(jsonb_build_object(
      'name', p.full_name, 'role', p.role, 'staffId', p.staff_id,
      'registrations', coalesce(r.n, 0), 'vitals', coalesce(v.n, 0), 'charges', coalesce(c.n, 0),
      'payments', case when v_manager then coalesce(pm.n, 0) end,
      'collected', case when v_manager then coalesce(pm.amount, 0) end,
      'lastSignIn', p.last_sign_in_at
    ) order by (coalesce(r.n, 0) + coalesce(v.n, 0) + coalesce(c.n, 0) + coalesce(pm.n, 0)) desc, p.full_name), '[]'::jsonb) into v_staff
  from profiles p
  left join (select created_by as id, count(*) as n from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) r on r.id = p.id
  left join (select performer_id as id, count(distinct encounter_id) as n from observation where deleted_at is null and (effective_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) v on v.id = p.id
  left join (select entered_by as id, count(*) as n from invoice_line where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) c on c.id = p.id
  left join (select cashier_id as id, count(*) as n, sum(amount) as amount from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) pm on pm.id = p.id
  where p.active;

  -- stock
  select coalesce(jsonb_agg(jsonb_build_object('name', name_generic, 'onHand', on_hand, 'min', reorder_level) order by (on_hand::numeric / greatest(reorder_level, 1))), '[]'::jsonb) into v_reorder
  from items_below_reorder where on_hand < reorder_level;

  select jsonb_build_object(
    'd30', count(*) filter (where s.expiry <= v_today + 30),
    'd60', count(*) filter (where s.expiry > v_today + 30 and s.expiry <= v_today + 60),
    'd90', count(*) filter (where s.expiry > v_today + 60 and s.expiry <= v_today + 90)
  ) into v_expiring
  from (select batch_id, expiry, sum(quantity) as q from stock_on_hand where expiry is not null group by batch_id, expiry) s
  where s.q > 0;

  -- bookings
  select jsonb_build_object(
    'booked', count(*) filter (where status in ('confirmed', 'arrived', 'in_progress', 'completed', 'no_show')),
    'missed', count(*) filter (where status = 'no_show'),
    'pending', count(*) filter (where status = 'inquiry')
  ) into v_noshow
  from appointment where deleted_at is null and (coalesce(starts_at, created_at) at time zone 'Africa/Kigali')::date between p_from and p_to;

  select coalesce(jsonb_agg(jsonb_build_object('channel', ch, 'sent', coalesce(s.sent, 0), 'failed', coalesce(s.failed, 0)) order by ch), '[]'::jsonb) into v_messages
  from unnest(array['whatsapp', 'sms', 'email']::message_channel[]) ch
  left join (
    select channel, count(*) filter (where status in ('sent', 'delivered')) as sent, count(*) filter (where status = 'failed') as failed
    from message where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by channel
  ) s on s.channel = ch;

  select coalesce(jsonb_agg(jsonb_build_object('payer', py.name, 'count', c.n, 'amount', case when v_manager then c.amount end) order by c.amount desc), '[]'::jsonb) into v_claims
  from (select payer_id, count(*) as n, sum(amount) as amount from claim where deleted_at is null and status = 'open' group by payer_id) c
  join payer py on py.id = c.payer_id;

  select coalesce(jsonb_agg(jsonb_build_object('name', p.full_name, 'role', p.role, 'at', a.at, 'reason', a.reason) order by a.at desc), '[]'::jsonb) into v_logins
  from (select actor_id, at, reason from audit_event where action = 'login' and at > now() - interval '1 day' order by at desc limit 12) a
  join profiles p on p.id = a.actor_id;

  select jsonb_build_object('active', count(*) filter (where active), 'total', count(*)) into v_services from service where deleted_at is null;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'manager', v_manager, 'generatedAt', now(),
    'tiles', v_tiles, 'revenue30d', v_rev30, 'collections', v_collections, 'receivables', v_receivables,
    'visitsByGroup', v_visits, 'waitByStation', v_wait, 'topTreatments', v_top, 'staff', v_staff,
    'reorder', v_reorder, 'expiring', v_expiring, 'bookings', v_noshow, 'messages', v_messages,
    'claims', v_claims, 'logins', v_logins, 'services', v_services
  );
end
$$;
