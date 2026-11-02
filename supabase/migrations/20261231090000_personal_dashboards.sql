-- 0120 · Every staff dashboard is personal: "Waiting for me" and "My work".
--
-- The owner stood at triage with one patient waiting and the home said "2 waiting": the tile was
-- the clinic's figure. The rule now: everyone's home shows THEIR OWN patients and THEIR OWN work;
-- the clinic's figures stay on the manager dashboard (and a head's department view).
--
-- my_summary(p_from, p_to) gives the signed-in person, and nobody else:
--   waiting   the patients that are theirs right now: sent to them by name (assigned, or a
--             handover waiting for their answer) FIRST, then the queue of their own desks (the
--             sections they serve, and the desk their profile names), nobody else's patient; the
--             rows are queue_board rows, so the home's Take / Call work unchanged;
--   counts    sentToMe · atMyDesks · inProgress (taken by me);
--   work      what they did in the period, by kind, as "Who did what" counts it
--             (analytics_staff_events, user_id = me): registered, vitals, patientsSeen,
--             diagnoses, prescriptions, orders, results, procedures, medicinesGiven, charges,
--             admissions, tasksDone…, plus visitsStarted (visits I opened); and the same for the
--             period before (workPrev) for the arrows;
--   money     only for the people who take payments (and the manager): my payments (count,
--             amount, by method), my refunds, my walk-in sales. A cashier gets no clinical kind.
-- The old functions (desk_summary, home_summary, lab_summary, cashier_summary, pharmacy_summary,
-- dashboard_summary) are unchanged: the manager keeps the clinic.
--
-- The manager also works at a desk sometimes (profiles.station = 'Triage'): their list is what is
-- sent to them by name and the queue of that desk only, so they see their own queue apart from the
-- clinic totals.

-- ---------------------------------------------------------------- the desk a profile names
-- "Consultation 1", "Triage", "Laboratoire", "Dental"… → the station, as the app reads it
-- (stationFor); null when the text names no desk.
create or replace function station_named(p_text text)
returns station
language sql immutable
as $$
  select case
    when p_text is null then null
    when p_text ilike '%dent%' then 'dental'
    when p_text ilike '%lab%' then 'laboratory'
    when p_text ilike '%ultra%' or p_text ilike '%echo%' then 'ultrasound'
    when p_text ilike '%pharm%' or p_text ilike '%farum%' then 'pharmacy'
    when p_text ilike '%theat%' or p_text ilike '%surg%' then 'theatre'
    when p_text ilike '%triage%' then 'triage'
    when p_text ilike '%nurs%' then 'nursing'
    when p_text ilike '%recep%' then 'reception'
    when p_text ilike '%cash%' or p_text ilike '%caiss%' then 'cashier'
    when p_text ilike '%consult%' then 'consultation'
    else null
  end::station
$$;

-- The signed-in person's own desk: the one their profile names, else their role's usual desk
-- (a doctor: consultation; a nurse: triage); the manager has none unless the profile names one.
create or replace function my_home_station()
returns station
language sql stable security definer set search_path = public
as $$
  select coalesce(
    station_named(p.station),
    case p.role
      when 'receptionist' then 'reception'
      when 'cashier' then 'cashier'
      when 'nurse' then 'triage'
      when 'doctor' then 'consultation'
      when 'lab_tech' then 'laboratory'
      when 'sonographer' then 'ultrasound'
      when 'pharmacist' then 'pharmacy'
      else null
    end::station)
  from profiles p where p.id = auth.uid() and p.active
$$;
revoke all on function station_named(text), my_home_station() from public, anon;
grant execute on function station_named(text), my_home_station() to authenticated;

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
  select coalesce(jsonb_agg(to_jsonb(b) || jsonb_build_object('by_name', x.by_name)
                            order by x.by_name desc, (b.started_at is not null) desc, b.priority, b.queued_at),
                  '[]'::jsonb)
  into v_waiting
  from queue_board b
  cross join lateral (
    select coalesce(b.assigned_to = v_me, false)
           or coalesce(b.handover_status = 'pending' and b.handover_to = v_me, false) as by_name
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

  select jsonb_build_object(
    'sentToMe', count(*) filter (where (r ->> 'by_name')::boolean and r ->> 'started_at' is null),
    'atMyDesks', count(*) filter (where not (r ->> 'by_name')::boolean and r ->> 'started_at' is null),
    'inProgress', count(*) filter (where r ->> 'started_at' is not null)
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
