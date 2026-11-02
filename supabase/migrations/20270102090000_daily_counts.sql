-- 0122 · The counts are for the day: today's work in the red count, yesterday's apart.
--
-- The owner: "Those notifications must be for a day, and tomorrow has its own."
--
-- The day is the clinic's (Africa/Kigali), from midnight to midnight.
--
--   my_notifications   'unread' (the bell's red count) = today's unread notices only. The list
--                      keeps its 30 days; each notice says whether it is of today ('today'), and
--                      'unreadEarlier' counts the older unread ones: they stay readable in the
--                      "Earlier" group with a small "unread" mark, never in the red count.
--   nav_counts         each day-bound count is today's: queue entries that joined today, results
--                      given today and not seen, prescriptions written today still waiting,
--                      today's bookings and the booking requests that came today, tests asked
--                      today, walk-in sales of today, delivery notes sent today, bills opened
--                      today. What is still open from an earlier day is not dropped: it comes as
--                      '<key>Earlier' (queueEarlier, inClinicEarlier…), present only when there is
--                      any, and the menu shows it apart ("From earlier days"). The forgotten
--                      entries of the manager's dashboard (0086: joined a queue on an earlier day
--                      and still open) are the same rule. Still plain numbers, no names.
--                      Not day-bound (unchanged): record access requests, staff documents
--                      expiring, files to complete.
--   my_summary         "Waiting for me": each row says whether it joined the queue on an earlier
--                      day ('earlier'); today's rows come first; the counts (sentToMe, atMyDesks,
--                      inProgress) are today's, and 'earlier' counts the others, shown apart.

-- ---------------------------------------------------------------- the clinic's midnight
-- Today's first instant, Kigali time.
create or replace function kigali_midnight()
returns timestamptz
language sql stable set search_path = public
as $$
  select ((now() at time zone 'Africa/Kigali')::date)::timestamp at time zone 'Africa/Kigali'
$$;
revoke all on function kigali_midnight() from public, anon;
grant execute on function kigali_midnight() to authenticated;

-- ---------------------------------------------------------------- the bell
create or replace function my_notifications(p_limit integer default 30)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with mine as (
    select n.*, (r.user_id is not null) as is_read, sender.full_name as sender,
           (n.created_at >= kigali_midnight()) as is_today
    from notification n
    left join notification_read r on r.notification_id = n.id and r.user_id = auth.uid()
    left join profiles sender on sender.id = n.created_by
    where n.created_at > now() - interval '30 days' and notification_is_mine(n, auth.uid())
      and r.hidden_at is null
  )
  select jsonb_build_object(
    -- the red count: today's unread only
    'unread', (select count(*) from mine where not is_read and is_today),
    -- older unread notices: listed under "Earlier", never in the red count
    'unreadEarlier', (select count(*) from mine where not is_read and not is_today),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'at', created_at, 'kind', kind, 'params', params, 'title', title, 'body', body,
        'link', link, 'urgent', urgent, 'read', is_read, 'sender', sender, 'today', is_today
      ) order by created_at desc)
      from (select * from mine order by created_at desc limit greatest(1, least(p_limit, 200))) x
    ), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------- the menu
create or replace function nav_counts()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_role role_key := current_role_key();
  v_manager boolean := is_manager();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_start timestamptz;
  v_end timestamptz;
  v_desks text[] := my_desk_list();
  v_station station;
  -- a doctor's or nurse's desk: consultation, dental, nursing, triage…
  v_treat boolean;
  v_pharmacy boolean;
  v_out jsonb := '{}'::jsonb;
  v_n integer;
  v_e integer;
begin
  if v_me is null or v_role is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  v_start := (v_today::timestamp) at time zone 'Africa/Kigali';
  v_end := ((v_today + 1)::timestamp) at time zone 'Africa/Kigali';
  v_station := my_home_station();
  v_treat := not v_manager and v_role not in ('receptionist', 'cashier')
             and v_desks && (treating_desks() || array['triage']);
  v_pharmacy := not v_manager and 'pharmacy' = any (v_desks);

  -- MY QUEUE and THE PATIENTS AT MY DESKS (the rule of my_summary's "Waiting for me"): an entry
  -- that joined the queue today is today's; an older one still open is from an earlier day.
  if v_treat and has_perm('queue.read') and has_perm('patient.read') then
    with mine as (
      select q.encounter_id, q.started_at, (q.created_at >= v_start) as is_today
      from queue_entry q
      join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
      where q.deleted_at is null and q.finished_at is null
        and (q.assigned_to = v_me
             or q.taken_by = v_me
             or exists (select 1 from patient_handover h
                        where h.queue_id = q.id and h.status = 'pending' and h.to_user = v_me
                          and h.deleted_at is null)
             or (q.assigned_to is null and q.taken_by is null
                 and (serves_station(v_me, q.station, coalesce(q.service, e.service))
                      or q.station = v_station)
                 and (q.department_id is null
                      or exists (select 1 from profiles me where me.id = v_me and me.department_id = q.department_id)
                      or exists (select 1 from staff_department sd
                                 where sd.profile_id = v_me and sd.department_id = q.department_id))))
    ),
    -- a patient with an entry of today is today's, even when an older one is still open
    visits as (select encounter_id, bool_or(is_today) as is_today from mine group by encounter_id)
    select jsonb_build_object(
             'queue', (select count(*) from mine where started_at is null and is_today),
             'queueEarlier', (select count(*) from mine where started_at is null and not is_today),
             'inClinic', (select count(*) from visits where is_today),
             'inClinicEarlier', (select count(*) from visits where not is_today))
    into v_out;
  elsif (v_manager or v_role = 'receptionist') and has_perm('patient.read') then
    select jsonb_build_object(
             'inClinic', count(*) filter (where e.arrived_at >= v_start),
             'inClinicEarlier', count(*) filter (where e.arrived_at < v_start))
    into v_out
    from encounter e where e.status = 'open' and e.deleted_at is null;
  end if;

  -- RESULTS FOR ME and MY PRESCRIPTIONS AT THE PHARMACY: whoever has those menu entries (a doctor
  -- at a treating desk; anyone a department of theirs gives a doctor's desk; as the menu decides)
  if not v_manager
     and ((v_role = 'doctor' and v_desks && treating_desks())
          or exists (select 1 from unnest(array['consultation', 'dental', 'surgery', 'circ']) d(desk)
                     where desk_via(v_me, d.desk) = 'department')) then
    -- given today and not seen; given on one of the 6 days before and still not seen: earlier
    select count(*) filter (where d.updated_at >= v_start),
           count(*) filter (where d.updated_at < v_start)
    into v_n, v_e
    from diagnostic_report d
    join service_request r on r.id = d.service_request_id and r.deleted_at is null
    where d.deleted_at is null and d.reviewed_at is null
      and r.status in ('resulted', 'verified')
      and d.updated_at > now() - interval '7 days'
      -- cheap first: my own request, or a visit handed over to me
      and (r.requester_id = v_me
           or exists (select 1 from patient_handover h where h.encounter_id = r.encounter_id
                      and h.to_user = v_me and h.status = 'taken' and h.deleted_at is null))
      and result_recipient(r.encounter_id, r.requester_id) = v_me;
    v_out := v_out || jsonb_build_object('results', v_n, 'resultsEarlier', v_e);

    -- written today and still waiting at the pharmacy; written earlier: apart
    select count(*) filter (where m.created_at >= v_start),
           count(*) filter (where m.created_at < v_start)
    into v_n, v_e
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open' and e.deleted_at is null
    where coalesce(m.prescriber_id, m.created_by) = v_me and rx_pending(m);
    v_out := v_out || jsonb_build_object('prescriptions', v_n, 'prescriptionsEarlier', v_e);
  end if;

  -- MY BOOKINGS TODAY (whoever keeps a calendar)
  if has_perm('appointment.accept') or v_manager then
    select count(*) into v_n
    from appointment a
    join practitioner pr on pr.id = a.practitioner_id and pr.user_id = v_me and pr.deleted_at is null
    where a.deleted_at is null
      and a.status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed')
      and a.starts_at >= v_start and a.starts_at < v_end;
    if v_n > 0 or exists (select 1 from practitioner pr where pr.user_id = v_me and pr.deleted_at is null) then
      v_out := v_out || jsonb_build_object('myBookings', v_n);
    end if;
  end if;

  -- TODAY'S BOOKINGS + THE REQUESTS THAT CAME TODAY (reception's Bookings page); requests still
  -- unanswered from an earlier day: apart
  if v_manager or v_role = 'receptionist' or has_perm('appointment.approve') then
    select count(*) filter (where (a.status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed')
                                   and a.starts_at >= v_start and a.starts_at < v_end)
                                  or (a.status = 'inquiry' and a.created_at >= v_start)),
           count(*) filter (where a.status = 'inquiry' and a.created_at < v_start)
    into v_n, v_e
    from appointment a
    where a.deleted_at is null;
    v_out := v_out || jsonb_build_object('bookings', v_n, 'bookingsEarlier', v_e);
  end if;

  -- THE LABORATORY / ULTRASOUND WORKLIST (the rule of lab_worklist, open): asked today; earlier
  if not v_manager and v_desks && array['laboratory', 'ultrasound'] and has_perm('orders.read') then
    select count(*) filter (where r.created_at >= v_start),
           count(*) filter (where r.created_at < v_start)
    into v_n, v_e
    from service_request r
    join encounter e on e.id = r.encounter_id and e.status = 'open'
    where r.deleted_at is null
      and r.status not in ('verified', 'cancelled')
      and r.category = any (my_test_categories())
      and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station
                                   else 'laboratory'::station end) in ('laboratory', 'ultrasound')
      and (has_perm('sensitive.read') or may_use_desk(request_desk(r.station, r.category))
           or not sensitive_service(r.service_id));
    v_out := v_out || jsonb_build_object('worklist', v_n, 'worklistEarlier', v_e);
  end if;

  -- THE PHARMACY: patients with medicines written today to hand over + walk-in sales of today
  -- paid and not handed over; a patient whose medicines all date from an earlier day, and older
  -- walk-in sales: apart
  if v_pharmacy then
    with pending as (
      select m.encounter_id, bool_or(m.created_at >= v_start) as is_today
      from medication_request m
      join encounter e on e.id = m.encounter_id and e.status = 'open'
      where rx_pending(m)
      group by m.encounter_id
    ), sales as (
      select (s.created_at >= v_start) as is_today
      from counter_sale s
      join stock_location l on l.id = s.location_id
      where s.deleted_at is null and s.status = 'paid' and not is_room_type(l.type)
    )
    select (select count(*) from pending where is_today) + (select count(*) from sales where is_today),
           (select count(*) from pending where not is_today) + (select count(*) from sales where not is_today)
    into v_n, v_e;
    v_out := v_out || jsonb_build_object('pharmacy', v_n, 'pharmacyEarlier', v_e);
  elsif not v_manager and exists (
      select 1 from stock_location l
      where l.active and l.deleted_at is null and is_room_type(l.type) and holds_store(v_me, l.id)) then
    -- A ROOM STORE (a doctor's office, the ward): delivery notes sent today to confirm + walk-in
    -- sales of today to give; older ones apart
    with w as (
      select (t.sent_at >= v_start) as is_today from stock_transfer t
      where t.deleted_at is null and t.status = 'in_transit' and t.direction = 'to_room'
        and holds_store(v_me, t.to_location_id)
      union all
      select (s.created_at >= v_start) from counter_sale s
      join stock_location l on l.id = s.location_id
      where s.deleted_at is null and s.status = 'paid' and is_room_type(l.type)
        and holds_store(v_me, s.location_id)
    )
    select count(*) filter (where is_today), count(*) filter (where not is_today) into v_n, v_e from w;
    v_out := v_out || jsonb_build_object('stock', v_n, 'stockEarlier', v_e);
  end if;

  -- MONEY: bills opened today with something still to pay (open visits), walk-in sales of today
  -- waiting to be paid; older ones apart
  if v_manager or v_role = 'cashier' or has_perm('payment.take') then
    select count(*) filter (where i.created_at >= v_start),
           count(*) filter (where i.created_at < v_start)
    into v_n, v_e
    from invoice i join encounter e on e.id = i.encounter_id
    where i.deleted_at is null and i.status = 'draft' and e.status = 'open'
      and invoice_balance(i.id) > 0;
    v_out := v_out || jsonb_build_object('bills', v_n, 'billsEarlier', v_e);
  end if;
  if not v_manager and (v_role = 'cashier' or has_perm('payment.take')) then
    select count(*) filter (where s.created_at >= v_start),
           count(*) filter (where s.created_at < v_start)
    into v_n, v_e
    from counter_sale s where s.deleted_at is null and s.status = 'open';
    v_out := v_out || jsonb_build_object('payments', v_n, 'paymentsEarlier', v_e);
  end if;

  -- RECORD ACCESS: requests waiting for an answer (record_access_requests 'pending'); not day-bound
  if v_manager or has_perm('records.approve') then
    v_out := v_out || jsonb_build_object('recordAccess',
      (select count(*) from record_access_request r
       join encounter e on e.id = r.encounter_id and e.status = 'open'
       where r.kind = 'request' and r.status = 'pending' and r.requested_by <> v_me
         and r.created_at > now() - interval '90 days')
      + case when v_manager then
          (select count(*) from record_access_request r
           where r.kind = 'emergency' and r.reviewed_at is null
             and r.created_at > now() - interval '90 days')
        else 0 end);
  end if;

  -- STAFF DOCUMENTS expiring within 60 days, or expired (staff_documents_expiring); not day-bound
  if v_manager then
    v_out := v_out || jsonb_build_object('documents',
      (select count(*) from staff_document d
       join profiles p on p.id = d.profile_id and p.active
       where d.deleted_at is null and d.kind in ('licence', 'contract')
         and d.expires_on is not null and d.expires_on <= staff_doc_today() + 60));
  end if;

  -- FILES TO COMPLETE (reception; the rule of files_to_complete); not day-bound
  if v_role = 'receptionist' and has_perm('patient.read') then
    v_out := v_out || jsonb_build_object('filesToComplete',
      (with s as (select patient_builtins() as b, patient_fields() as f)
       select count(distinct p.id)
       from patient p
       cross join s
       left join encounter e on e.patient_id = p.id and e.status = 'open' and e.deleted_at is null
       where p.deleted_at is null and p.merged_into is null
         and (e.id is not null or p.created_at > now() - interval '2 days')
         and cardinality(patient_missing_with(p, s.b, s.f)) > 0));
  end if;

  -- an "earlier" count only when there is something from an earlier day
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_out
  from jsonb_each(v_out) x(k, v)
  where not (k like '%Earlier' and v = '0'::jsonb);

  return v_out;
end
$$;
revoke all on function nav_counts() from public, anon;
grant execute on function nav_counts() to authenticated;

-- ---------------------------------------------------------------- my summary
create or replace function my_summary(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_role role_key := current_role_key();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_len integer;
  v_start timestamptz;
  v_end timestamptz;
  v_pstart timestamptz;
  v_pend timestamptz;
  -- today's first instant (Kigali): a queue entry before it is from an earlier day
  v_midnight timestamptz := (v_today::timestamp) at time zone 'Africa/Kigali';
  v_station station := my_home_station();
  v_manager boolean := is_manager();
  -- money is the business of whoever takes payments (and the manager)
  v_money boolean := has_perm('payment.take') or is_manager();
  -- the cash desk has no business with clinical kinds
  v_kinds text[] := case when v_role = 'cashier'
                         then array['registered', 'charges', 'payments', 'refunds', 'voided', 'handovers']
                         else null end;
  v_waiting jsonb;
  v_counts jsonb;
  v_work jsonb;
  v_prev jsonb;
  v_money_j jsonb := null;
begin
  if v_role is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  v_len := v_to - v_from + 1;
  v_start := (v_from::timestamp) at time zone 'Africa/Kigali';
  v_end := ((v_to + 1)::timestamp) at time zone 'Africa/Kigali';
  v_pstart := ((v_from - v_len)::timestamp) at time zone 'Africa/Kigali';
  v_pend := v_start;

  -- WAITING FOR ME: by name first (assigned to me, handed over to me and not answered yet), then
  -- my desks' queue (nobody named: the sections I serve, or the desk my profile names; a patient
  -- sent to a department only for its members), plus the patients I took and have not finished.
  -- The manager's queue is only what is sent to them by name and their own desk, never the clinic.
  -- Today's first; what joined the queue on an earlier day and is still open comes last, marked
  -- 'earlier' (shown apart: "From earlier days").
  select coalesce(jsonb_agg(to_jsonb(b) || jsonb_build_object('by_name', x.by_name, 'earlier', x.earlier)
                            order by x.earlier, x.by_name desc, (b.started_at is not null) desc, b.priority, b.queued_at),
                  '[]'::jsonb)
  into v_waiting
  from queue_board b
  cross join lateral (
    select coalesce(b.assigned_to = v_me, false)
           or coalesce(b.handover_status = 'pending' and b.handover_to = v_me, false) as by_name,
           b.queued_at < v_midnight as earlier
  ) x
  where b.finished_at is null
    and (
      x.by_name
      or coalesce(b.taken_by = v_me, false)
      or (b.assigned_to is null and b.taken_by is null
          and ((not v_manager and serves_station(v_me, b.station, b.service))
               or b.station = v_station)
          and (b.department_id is null
               or exists (select 1 from profiles me where me.id = v_me and me.department_id = b.department_id)
               or exists (select 1 from staff_department sd
                          where sd.profile_id = v_me and sd.department_id = b.department_id)))
    );

  -- today's counts; the rows from an earlier day apart
  select jsonb_build_object(
    'sentToMe', count(*) filter (where not (r ->> 'earlier')::boolean
                                   and (r ->> 'by_name')::boolean and r ->> 'started_at' is null),
    'atMyDesks', count(*) filter (where not (r ->> 'earlier')::boolean
                                    and not (r ->> 'by_name')::boolean and r ->> 'started_at' is null),
    'inProgress', count(*) filter (where not (r ->> 'earlier')::boolean and r ->> 'started_at' is not null),
    'earlier', count(*) filter (where (r ->> 'earlier')::boolean)
  ) into v_counts
  from jsonb_array_elements(v_waiting) r;

  -- MY WORK: the kinds of "Who did what", mine only, this period and the one before.
  select coalesce(jsonb_object_agg(k.kind, k.n), '{}'::jsonb) into v_work
  from (select kind, count(*) as n
        from analytics_staff_events(v_start, v_end, v_money)
        where user_id = v_me and (v_kinds is null or kind = any (v_kinds))
        group by kind) k;
  select coalesce(jsonb_object_agg(k.kind, k.n), '{}'::jsonb) into v_prev
  from (select kind, count(*) as n
        from analytics_staff_events(v_pstart, v_pend, v_money)
        where user_id = v_me and (v_kinds is null or kind = any (v_kinds))
        group by kind) k;
  -- the visits I opened (reception's work; not a kind of Who did what)
  v_work := v_work || jsonb_build_object('visitsStarted',
    (select count(*) from encounter e where e.deleted_at is null and e.created_by = v_me
      and e.arrived_at >= v_start and e.arrived_at < v_end));
  v_prev := v_prev || jsonb_build_object('visitsStarted',
    (select count(*) from encounter e where e.deleted_at is null and e.created_by = v_me
      and e.arrived_at >= v_pstart and e.arrived_at < v_pend));

  -- MY MONEY: what I took, by method; what I gave back; the walk-in sales I handed over.
  if v_money then
    select jsonb_build_object(
      'payments', jsonb_build_object(
        'count', (select count(*) from payment y where y.deleted_at is null and y.cashier_id = v_me and y.paid_at >= v_start and y.paid_at < v_end),
        'amount', (select coalesce(sum(y.amount), 0) from payment y where y.deleted_at is null and y.cashier_id = v_me and y.paid_at >= v_start and y.paid_at < v_end),
        'prevAmount', (select coalesce(sum(y.amount), 0) from payment y where y.deleted_at is null and y.cashier_id = v_me and y.paid_at >= v_pstart and y.paid_at < v_pend),
        'prevCount', (select count(*) from payment y where y.deleted_at is null and y.cashier_id = v_me and y.paid_at >= v_pstart and y.paid_at < v_pend)),
      'byMethod', coalesce((
        select jsonb_agg(jsonb_build_object('method', m.method, 'amount', m.amount, 'count', m.n) order by m.amount desc)
        from (select y.method::text as method, sum(y.amount) as amount, count(*) as n from payment y
              where y.deleted_at is null and y.cashier_id = v_me and y.paid_at >= v_start and y.paid_at < v_end
              group by y.method) m), '[]'::jsonb),
      'refunds', jsonb_build_object(
        'count', (select count(*) from refund r where r.deleted_at is null and r.cashier_id = v_me and r.refunded_at >= v_start and r.refunded_at < v_end),
        'amount', (select coalesce(sum(r.amount), 0) from refund r where r.deleted_at is null and r.cashier_id = v_me and r.refunded_at >= v_start and r.refunded_at < v_end)),
      'sales', jsonb_build_object(
        'count', (select count(*) from counter_sale s where s.deleted_at is null and s.handed_over_by = v_me and s.handed_over_at >= v_start and s.handed_over_at < v_end),
        'total', (select coalesce(sum(s.total), 0) from counter_sale s where s.deleted_at is null and s.handed_over_by = v_me and s.handed_over_at >= v_start and s.handed_over_at < v_end))
    ) into v_money_j;
  end if;

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'role', v_role,
    'station', v_station,
    'desks', to_jsonb(my_desk_list()),
    'waiting', v_waiting,
    'counts', v_counts,
    'work', v_work,
    'workPrev', v_prev,
    'money', v_money_j
  );
end
$$;
revoke all on function my_summary(date, date) from public, anon;
grant execute on function my_summary(date, date) to authenticated;
