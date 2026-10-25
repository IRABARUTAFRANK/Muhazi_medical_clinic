-- 0086 · Analytics: the detailed views behind the dashboard cards, and an honest waiting time.
--
-- Frank: "on this part of who did what this month … when clicked it's seen in a detailed view and
-- also on that revenue by day"; "the average waiting time … it's not accurate … remove its
-- representation on the cards"; "create a page for analysis where when I click those highlighted
-- information that is in dashboard I am directed to a detailed view".
--
--   * A  WHO MAY LOOK. analytics_scope(): the manager sees the whole clinic (or one department he
--        picks), with money. The head or assistant of a department sees that department only (its
--        people, its desks, its visits) and never money. Anyone else: 42501. analytics_access()
--        tells the app which views a person may open.
--   * B  WHO DID WHAT. One list of work (analytics_staff_events) feeds staff_activity (everyone),
--        staff_activity_detail (one person: records, sign-ins, money) and the dashboard's
--        "Who did what". Patients seen: the visits where the person took the patient from a queue
--        or wrote a note, diagnosis, prescription, test order or procedure (taking the queue entry
--        alone was rarely recorded, so doctors showed close to 0). Medicines given: handed over at
--        the pharmacy and given from a room store (medication_request.given_by). Retired staff
--        keep the work they did.
--   * C  REVENUE. revenue_analysis(): collected, refunded, net, cancelled, per day and method,
--        against the period before; by source, service category, department (each bill's payments
--        spread over its lines, an estimate), payer, cashier; discounts, refunds, credit notes,
--        cancelled payments and debts. The manager only.
--   * D  PATIENTS AND VISITS. visits_analysis(): registrations, visits, new and returning,
--        bookings, by day, type, service group and hour; the treatments given.
--   * E  WAITING TIME, CORRECTED. wait_time_stats(): one wait is one queue entry at one desk, from
--        joining that desk's queue to being taken there (consultation, dental, theatre, nursing:
--        taken; laboratory, ultrasound: sample collected; triage: the first vitals measured;
--        cashier: the first payment; pharmacy: the first medicine handed over or given). Only
--        finished waits count, so a visit closed without anyone taking the patient, an entry left,
--        and the copies of a patient sent to several desks at once count nowhere (a pooled send
--        counts once, at the desk that took the patient). Waits over 12 hours or across midnight
--        are data errors, counted apart. Median and 90th percentile, never a mean on a card.
--   * F  THE CARDS. No average waiting time on any card any more (dashboard_summary, desk_summary,
--        department_summary, public_clinic_status lose it). "Waiting now" counts the patients who
--        joined a queue today; older entries still open are "forgotten" (please close them).
--        dashboard_summary: the staff rows carry the person's id and the corrected counts; the
--        reorder rows the item's id and full name with strength; revenue per day carries refunds
--        and net.
--
-- Errcodes: 42501 not allowed, 22023 bad input, P0002 not found.

-- ---------------------------------------------------------------- A who may look
-- The caller's scope. The manager: everything (or the department he picks). A head or assistant:
-- their department (the first one when none is given). Internal: not granted.
create or replace function analytics_scope(
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
  s_manager := is_manager();
  s_department := p_department;
  if not s_manager then
    if p_department is null then
      select sd.department_id into s_department
      from staff_department sd
      join department d on d.id = sd.department_id and d.deleted_at is null
      join profiles p on p.id = sd.profile_id and p.active
      where sd.profile_id = auth.uid() and sd.position in ('head', 'assistant')
      order by d.active desc, d.sort_order, d.name
      limit 1;
    end if;
    if s_department is null or not exists (
      select 1 from staff_department sd
      join department d on d.id = sd.department_id and d.deleted_at is null
      join profiles p on p.id = sd.profile_id and p.active
      where sd.profile_id = auth.uid() and sd.department_id = s_department
        and sd.position in ('head', 'assistant')) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  end if;
  if s_department is null then
    -- the manager, the whole clinic
    s_desks := null;
    s_stations := enum_range(null::station);
    s_members := null;
    return;
  end if;
  select coalesce(d.services, '{}') into s_desks from department d where d.id = s_department and d.deleted_at is null;
  if not found then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(st order by st), '{}') into s_stations
  from unnest(enum_range(null::station)) st
  where station_desks(st) && s_desks;
  select coalesce(array_agg(sd.profile_id), '{}') into s_members
  from staff_department sd where sd.department_id = s_department;
end
$$;
revoke all on function analytics_scope(uuid) from public, anon, authenticated;

-- What the signed-in person may open on the Analytics page.
create or replace function analytics_access()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := is_manager();
  v_deps jsonb;
  v_desks text[];
  v_views text[] := '{}';
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_manager then
    select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'desks', to_jsonb(coalesce(d.services, '{}')))
                              order by d.sort_order, d.name), '[]'::jsonb)
    into v_deps
    from department d where d.deleted_at is null and d.active;
    v_views := array['revenue', 'staff', 'visits', 'treatments', 'lab', 'pharmacy', 'triage', 'stock', 'waiting'];
  else
    select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'desks', to_jsonb(coalesce(d.services, '{}')))
                              order by d.sort_order, d.name), '[]'::jsonb)
    into v_deps
    from staff_department sd
    join department d on d.id = sd.department_id and d.deleted_at is null
    join profiles p on p.id = sd.profile_id and p.active
    where sd.profile_id = auth.uid() and sd.position in ('head', 'assistant');
    if jsonb_array_length(v_deps) > 0 then
      select coalesce(array_agg(distinct x), '{}') into v_desks
      from jsonb_array_elements(v_deps) dep, jsonb_array_elements_text(dep -> 'desks') x;
      v_views := array['staff', 'visits', 'treatments']
        || case when v_desks && array['laboratory', 'ultrasound'] then array['lab'] else '{}'::text[] end
        || case when 'pharmacy' = any (v_desks) then array['pharmacy'] else '{}'::text[] end
        || case when 'triage' = any (v_desks) then array['triage'] else '{}'::text[] end
        || case when 'pharmacy' = any (v_desks) then array['stock'] else '{}'::text[] end
        || array['waiting'];
    end if;
  end if;
  return jsonb_build_object('manager', v_manager, 'departments', v_deps, 'views', to_jsonb(v_views));
end
$$;
revoke all on function analytics_access() from public, anon;
grant execute on function analytics_access() to authenticated;

-- ---------------------------------------------------------------- B who did what
-- Every piece of work a person did between two moments, one row each (internal: not granted).
--   patientsSeen: one row per person and visit (the first act in the window).
--   vitals: one row per person and visit (the first measurement in the window).
--   Money kinds (payments, refunds, voided, handovers) only when p_money.
create or replace function analytics_staff_events(p_start timestamptz, p_end timestamptz, p_money boolean)
returns table (user_id uuid, at timestamptz, kind text, encounter_id uuid, patient_id uuid, amount numeric, what text)
language sql stable security definer set search_path = public
as $$
  -- registered
  select x.created_by, x.created_at, 'registered', null::uuid, x.id, null::numeric, null::text
  from patient x
  where x.deleted_at is null and x.created_by is not null and x.created_at >= p_start and x.created_at < p_end
  union all
  -- vitals, one per visit
  select v.u, v.at, 'vitals', v.enc, e.patient_id, null, null
  from (select o.performer_id as u, o.encounter_id as enc, min(o.effective_at) as at
        from observation o
        where o.deleted_at is null and o.code <> 'note' and o.performer_id is not null
          and o.effective_at >= p_start and o.effective_at < p_end
        group by 1, 2) v
  join encounter e on e.id = v.enc
  union all
  -- patients seen: took the patient from a queue, or wrote on the visit
  select s.u, s.at, 'patientsSeen', s.enc, e.patient_id, null, e.reference
  from (select a.u, a.enc, min(a.at) as at
        from (
          select q.taken_by as u, q.encounter_id as enc, coalesce(q.started_at, q.finished_at, q.created_at) as at
          from queue_entry q where q.deleted_at is null and q.taken_by is not null
          union all
          select c.created_by, c.encounter_id, c.created_at from condition c where c.deleted_at is null
          union all
          select m.prescriber_id, m.encounter_id, m.created_at from medication_request m where m.deleted_at is null
          union all
          select r.requester_id, r.encounter_id, r.created_at from service_request r where r.deleted_at is null
          union all
          select o.performer_id, o.encounter_id, o.effective_at from observation o where o.deleted_at is null and o.code = 'note'
          union all
          select x.performer_id, x.encounter_id, coalesce(x.performed_at, x.created_at) from procedure x where x.deleted_at is null
        ) a
        where a.u is not null and a.enc is not null and a.at >= p_start and a.at < p_end
        group by 1, 2) s
  join encounter e on e.id = s.enc
  union all
  -- diagnoses
  select c.created_by, c.created_at, 'diagnoses', c.encounter_id, e.patient_id, null,
         trim(coalesce(c.icd10_code || ' ', '') || coalesce(c.text, ''))
  from condition c join encounter e on e.id = c.encounter_id
  where c.deleted_at is null and c.created_by is not null and c.created_at >= p_start and c.created_at < p_end
  union all
  -- prescriptions
  select m.prescriber_id, m.created_at, 'prescriptions', m.encounter_id, e.patient_id, null,
         item_label(m.item_id) || coalesce(' · ' || nullif(m.dose, ''), '')
  from medication_request m join encounter e on e.id = m.encounter_id
  where m.deleted_at is null and m.prescriber_id is not null and m.created_at >= p_start and m.created_at < p_end
  union all
  -- test orders
  select r.requester_id, r.created_at, 'orders', r.encounter_id, e.patient_id, null, sv.name_en
  from service_request r join encounter e on e.id = r.encounter_id left join service sv on sv.id = r.service_id
  where r.deleted_at is null and r.requester_id is not null and r.created_at >= p_start and r.created_at < p_end
  union all
  -- results (verified, else typed)
  select coalesce(d.verified_by, d.created_by), coalesce(d.verified_at, d.created_at), 'results', r.encounter_id, e.patient_id, null, sv.name_en
  from diagnostic_report d
  join service_request r on r.id = d.service_request_id
  join encounter e on e.id = r.encounter_id
  left join service sv on sv.id = r.service_id
  where d.deleted_at is null and coalesce(d.verified_by, d.created_by) is not null
    and coalesce(d.verified_at, d.created_at) >= p_start and coalesce(d.verified_at, d.created_at) < p_end
  union all
  -- procedures
  select x.performer_id, coalesce(x.performed_at, x.created_at), 'procedures', x.encounter_id, e.patient_id, null, sv.name_en
  from procedure x join encounter e on e.id = x.encounter_id left join service sv on sv.id = x.service_id
  where x.deleted_at is null and x.performer_id is not null
    and coalesce(x.performed_at, x.created_at) >= p_start and coalesce(x.performed_at, x.created_at) < p_end
  union all
  -- medicines given: handed over at the pharmacy …
  select md.dispenser_id, md.created_at, 'medicinesGiven', md.encounter_id, e.patient_id, null,
         item_label(md.item_id) || ' × ' || trim_scale(md.quantity)::text
  from medication_dispense md left join encounter e on e.id = md.encounter_id
  where md.deleted_at is null and md.dispenser_id is not null and md.created_at >= p_start and md.created_at < p_end
  union all
  -- … and given from a room store (a pharmacy hand-over also sets given_by: it is counted above,
  -- through its medication_dispense row, so only requests without one come from here)
  select m.given_by, m.given_at, 'medicinesGiven', m.encounter_id, e.patient_id, null, item_label(m.item_id)
  from medication_request m join encounter e on e.id = m.encounter_id
  where m.deleted_at is null and m.given_by is not null and m.given_at >= p_start and m.given_at < p_end
    and not exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null)
  union all
  -- charges
  select l.entered_by, l.created_at, 'charges', i.encounter_id, e.patient_id, round(l.unit_price * l.quantity), l.description
  from invoice_line l join invoice i on i.id = l.invoice_id left join encounter e on e.id = i.encounter_id
  where l.deleted_at is null and l.entered_by is not null and l.created_at >= p_start and l.created_at < p_end
  union all
  -- admissions
  select b.created_by, coalesce(b.admitted_at, b.created_at), 'admissions', b.encounter_id, e.patient_id, null, bd.name
  from bed_stay b join encounter e on e.id = b.encounter_id left join bed bd on bd.id = b.bed_id
  where b.deleted_at is null and b.created_by is not null
    and coalesce(b.admitted_at, b.created_at) >= p_start and coalesce(b.admitted_at, b.created_at) < p_end
  union all
  -- tasks done
  select k.done_by, k.done_at, 'tasksDone', k.encounter_id, k.patient_id, null, k.title
  from internal_task k
  where k.deleted_at is null and k.done_by is not null and k.done_at >= p_start and k.done_at < p_end
  union all
  select v.created_by, v.created_at, 'vaccinations', v.encounter_id, v.patient_id, null, v.vaccine
  from vaccination v
  where v.deleted_at is null and v.created_by is not null and v.created_at >= p_start and v.created_at < p_end
  union all
  -- an HIV test: never its result
  select h.created_by, coalesce(h.tested_at, h.created_at), 'hivTests', h.encounter_id, h.patient_id, null, null
  from hiv_test h
  where h.deleted_at is null and h.created_by is not null
    and coalesce(h.tested_at, h.created_at) >= p_start and coalesce(h.tested_at, h.created_at) < p_end
  union all
  select f.created_by, f.created_at, 'familyPlanning', f.encounter_id, f.patient_id, null, f.method
  from fp_event f
  where f.deleted_at is null and f.created_by is not null and f.created_at >= p_start and f.created_at < p_end
  union all
  -- money (the manager only)
  select y.cashier_id, y.paid_at, 'payments', i.encounter_id, e.patient_id, y.amount, y.method::text
  from payment y left join invoice i on i.id = y.invoice_id left join encounter e on e.id = i.encounter_id
  where p_money and y.deleted_at is null and y.cashier_id is not null and y.paid_at >= p_start and y.paid_at < p_end
  union all
  select rf.cashier_id, rf.refunded_at, 'refunds', i.encounter_id, e.patient_id, rf.amount, rf.reason
  from refund rf join invoice i on i.id = rf.invoice_id left join encounter e on e.id = i.encounter_id
  where p_money and rf.deleted_at is null and rf.cashier_id is not null and rf.refunded_at >= p_start and rf.refunded_at < p_end
  union all
  select y.voided_by, y.voided_at, 'voided', i.encounter_id, e.patient_id, y.amount, y.void_reason
  from payment y left join invoice i on i.id = y.invoice_id left join encounter e on e.id = i.encounter_id
  where p_money and y.voided_by is not null and y.voided_at >= p_start and y.voided_at < p_end
  union all
  select cs.handed_over_by, cs.handed_over_at, 'handovers', null, null, cs.total, cs.number
  from counter_sale cs
  where p_money and cs.deleted_at is null and cs.handed_over_by is not null
    and cs.handed_over_at >= p_start and cs.handed_over_at < p_end
$$;
revoke all on function analytics_staff_events(timestamptz, timestamptz, boolean) from public, anon, authenticated;

-- The kinds of work in display order (money last, the manager only).
create or replace function analytics_kinds(p_money boolean)
returns text[]
language sql immutable
as $$
  select array['registered', 'vitals', 'patientsSeen', 'diagnoses', 'prescriptions', 'orders', 'results',
               'procedures', 'medicinesGiven', 'charges', 'admissions', 'tasksDone', 'vaccinations',
               'hivTests', 'familyPlanning']
         || case when p_money then array['payments', 'refunds', 'voided', 'handovers'] else '{}'::text[] end
$$;

-- Everyone's work in the period: per person, per day and kind, and the totals.
create or replace function staff_activity(p_from date default null, p_to date default null, p_department uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  s record;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_kinds text[];
  v_result jsonb;
begin
  select * into s from analytics_scope(p_department);
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  v_kinds := analytics_kinds(s.s_manager);
  with ev as (
    select * from analytics_staff_events(v_from::timestamp at time zone 'Africa/Kigali',
                                         (v_to + 1)::timestamp at time zone 'Africa/Kigali', s.s_manager)
    where s.s_members is null or user_id = any (s.s_members)
  ),
  per as (
    select ev.user_id, ev.kind, count(*) as n, sum(ev.amount) as amount from ev group by 1, 2
  ),
  people as (
    select p.id, p.full_name, p.role, p.staff_id, p.active and p.deleted_at is null as active, p.last_sign_in_at,
           (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) order by d.sort_order, d.name), '[]'::jsonb)
            from staff_department sd join department d on d.id = sd.department_id and d.deleted_at is null
            where sd.profile_id = p.id) as departments,
           (select coalesce(jsonb_object_agg(k, coalesce((select per.n from per where per.user_id = p.id and per.kind = k), 0)), '{}'::jsonb)
            from unnest(v_kinds) k) as counts,
           (select coalesce(sum(per.n), 0) from per
            where per.user_id = p.id and per.kind not in ('patientsSeen', 'payments', 'refunds', 'voided', 'handovers')) as records,
           (select per.amount from per where per.user_id = p.id and per.kind = 'payments') as collected
    from profiles p
    where (s.s_members is null or p.id = any (s.s_members))
      and ((p.active and p.deleted_at is null) or exists (select 1 from per where per.user_id = p.id))
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_to, 'manager', s.s_manager, 'department', s.s_department,
    'kinds', to_jsonb(v_kinds),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', x.id, 'name', x.full_name, 'role', x.role, 'staffId', x.staff_id, 'departments', x.departments,
          'active', x.active, 'lastSignIn', x.last_sign_in_at, 'counts', x.counts, 'records', x.records,
          'amount', case when s.s_manager then coalesce(x.collected, 0) end)
        order by x.records desc, x.full_name)
      from people x), '[]'::jsonb),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.day, 'userId', d.user_id, 'kind', d.kind, 'n', d.n,
                                          'amount', case when s.s_manager then d.amount end)
                       order by d.day, d.user_id, d.kind)
      from (select (ev.at at time zone 'Africa/Kigali')::date as day, ev.user_id, ev.kind, count(*) as n, sum(ev.amount) as amount
            from ev group by 1, 2, 3) d), '[]'::jsonb),
    'totals', (select coalesce(jsonb_object_agg(k, coalesce((select sum(per.n) from per where per.kind = k), 0)), '{}'::jsonb)
               from unnest(v_kinds) k),
    'summary', jsonb_build_object(
      'peopleActive', (select count(distinct ev.user_id) from ev),
      'patientsSeen', (select count(distinct ev.encounter_id) from ev where ev.kind = 'patientsSeen'),
      'records', (select count(*) from ev where ev.kind not in ('patientsSeen', 'payments', 'refunds', 'voided', 'handovers')),
      'collected', case when s.s_manager then (select coalesce(sum(ev.amount), 0) from ev where ev.kind = 'payments') end)
  ) into v_result;
  return v_result;
end
$$;
revoke all on function staff_activity(date, date, uuid) from public, anon;
grant execute on function staff_activity(date, date, uuid) to authenticated;

-- One person's work: records (newest first), sign-ins and, for the manager, money.
create or replace function staff_activity_detail(
  p_user uuid,
  p_from date default null,
  p_to date default null,
  p_kind text default null,
  p_limit integer default 500
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := is_manager();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_start timestamptz;
  v_end timestamptz;
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 500);
  v_person jsonb;
  v_result jsonb;
begin
  if not v_manager and not exists (
    select 1
    from staff_department mine
    join department d on d.id = mine.department_id and d.deleted_at is null
    join profiles me on me.id = mine.profile_id and me.active
    join staff_department theirs on theirs.department_id = mine.department_id
    where mine.profile_id = auth.uid() and mine.position in ('head', 'assistant') and theirs.profile_id = p_user) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_kind is not null and not (p_kind = any (analytics_kinds(v_manager))) then
    raise exception 'unknown kind of work' using errcode = '22023';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  v_start := v_from::timestamp at time zone 'Africa/Kigali';
  v_end := (v_to + 1)::timestamp at time zone 'Africa/Kigali';
  select jsonb_build_object('id', p.id, 'name', p.full_name, 'role', p.role, 'staffId', p.staff_id,
                            'active', p.active and p.deleted_at is null, 'lastSignIn', p.last_sign_in_at,
                            'departments', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) order by d.sort_order, d.name), '[]'::jsonb)
                                            from staff_department sd join department d on d.id = sd.department_id and d.deleted_at is null
                                            where sd.profile_id = p.id))
  into v_person
  from profiles p where p.id = p_user;
  if v_person is null then
    raise exception 'person not found' using errcode = 'P0002';
  end if;

  with ev as (
    select * from analytics_staff_events(v_start, v_end, v_manager) where user_id = p_user
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_to, 'person', v_person,
    'counts', (select coalesce(jsonb_object_agg(k, coalesce((select count(*) from ev where ev.kind = k), 0)), '{}'::jsonb)
               from unnest(analytics_kinds(v_manager)) k),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.day, 'kind', d.kind, 'n', d.n) order by d.day, d.kind)
      from (select (ev.at at time zone 'Africa/Kigali')::date as day, ev.kind, count(*) as n from ev group by 1, 2) d), '[]'::jsonb),
    'total', (select count(*) from ev where p_kind is null or ev.kind = p_kind),
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
          'at', r.at, 'kind', r.kind, 'encounterId', r.encounter_id, 'patientId', r.pid,
          'patientName', r.pname, 'fileNumber', r.file_number, 'what', r.what,
          'amount', case when v_manager then r.amount end) order by r.at desc)
      from (
        select ev.at, ev.kind, ev.encounter_id, ev.what, ev.amount,
               -- an HIV test names its patient to the manager only
               case when ev.kind = 'hivTests' and not v_manager then null else ev.patient_id end as pid,
               case when ev.kind = 'hivTests' and not v_manager then null else pt.surname || ' ' || pt.given_names end as pname,
               case when ev.kind = 'hivTests' and not v_manager then null else pt.file_number end as file_number
        from ev left join patient pt on pt.id = ev.patient_id
        where p_kind is null or ev.kind = p_kind
        order by ev.at desc
        limit v_limit) r), '[]'::jsonb),
    'signIns', coalesce((
      select jsonb_agg(jsonb_build_object('at', a.at, 'ok', a.reason is null or a.reason not like 'wrong PIN%', 'reason', a.reason)
                       order by a.at desc)
      from (select at, reason from audit_event
            where actor_id = p_user and action = 'login' and at >= v_start and at < v_end
            order by at desc limit 200) a), '[]'::jsonb),
    'money', case when v_manager then jsonb_build_object(
      'byMethod', coalesce((
        select jsonb_agg(jsonb_build_object('method', m.method, 'count', m.n, 'amount', m.amount) order by m.amount desc)
        from (select method, count(*) as n, sum(amount) as amount from payment
              where cashier_id = p_user and deleted_at is null and paid_at >= v_start and paid_at < v_end
              group by method) m), '[]'::jsonb),
      'refunds', coalesce((
        select jsonb_agg(jsonb_build_object('at', rf.refunded_at, 'amount', rf.amount, 'method', rf.method, 'reason', rf.reason,
                                            'patient', pt.surname || ' ' || pt.given_names, 'fileNumber', pt.file_number,
                                            'encounterId', i.encounter_id) order by rf.refunded_at desc)
        from refund rf
        join invoice i on i.id = rf.invoice_id
        left join encounter e on e.id = i.encounter_id
        left join patient pt on pt.id = e.patient_id
        where rf.cashier_id = p_user and rf.deleted_at is null and rf.refunded_at >= v_start and rf.refunded_at < v_end), '[]'::jsonb),
      'voided', coalesce((
        select jsonb_agg(jsonb_build_object('at', y.voided_at, 'paidAt', y.paid_at, 'amount', y.amount, 'method', y.method,
                                            'reason', y.void_reason, 'by', vb.full_name,
                                            'patient', coalesce(pt.surname || ' ' || pt.given_names, cs.buyer_name)) order by y.voided_at desc)
        from payment y
        left join profiles vb on vb.id = y.voided_by
        left join invoice i on i.id = y.invoice_id
        left join encounter e on e.id = i.encounter_id
        left join patient pt on pt.id = e.patient_id
        left join counter_sale cs on cs.id = y.counter_sale_id
        where y.cashier_id = p_user and y.voided_at is not null and y.voided_at >= v_start and y.voided_at < v_end), '[]'::jsonb),
      'closes', coalesce((
        select jsonb_agg(jsonb_build_object('day', c.date, 'expected', c.expected, 'counted', c.counted, 'variance', c.variance)
                         order by c.date desc)
        from day_close c
        where c.cashier_id = p_user and c.deleted_at is null and c.date between v_from and v_to), '[]'::jsonb))
    end
  ) into v_result;
  return v_result;
end
$$;
revoke all on function staff_activity_detail(uuid, date, date, text, integer) from public, anon;
grant execute on function staff_activity_detail(uuid, date, date, text, integer) to authenticated;

-- ---------------------------------------------------------------- C revenue
-- The money figures of a window (internal: the period and the one before).
create or replace function revenue_totals(p_start timestamptz, p_end timestamptz)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with ok as (
    select y.* from payment y where y.deleted_at is null and y.paid_at >= p_start and y.paid_at < p_end
  ),
  rf as (
    select r.* from refund r where r.deleted_at is null and r.refunded_at >= p_start and r.refunded_at < p_end
  ),
  -- what was charged: visit bill lines and walk-in (counter) sale lines, a cancelled sale left out
  ln as (
    select round(l.unit_price * l.quantity) as amount, l.list_price, l.unit_price, l.quantity
    from invoice_line l where l.deleted_at is null and l.created_at >= p_start and l.created_at < p_end
    union all
    select x.line_total, x.unit_price, x.unit_price, x.quantity
    from counter_sale_line x join counter_sale s on s.id = x.sale_id
    where x.deleted_at is null and s.deleted_at is null and s.status <> 'cancelled'
      and x.created_at >= p_start and x.created_at < p_end
  ),
  t as (
    select
      (select coalesce(sum(amount), 0) from ok) as collected,
      (select count(*) from ok) as payments,
      (select coalesce(sum(amount), 0) from ok where invoice_id is not null) as bills,
      (select coalesce(sum(amount), 0) from ok where counter_sale_id is not null) as counter_sales,
      (select count(distinct i.encounter_id) from ok join invoice i on i.id = ok.invoice_id) as paid_visits,
      (select coalesce(sum(amount), 0) from rf) as refunded,
      (select count(*) from rf) as refunds,
      (select coalesce(sum(amount), 0) from payment y
       where y.voided_at is not null and y.voided_at >= p_start and y.voided_at < p_end) as voided,
      (select count(*) from payment y
       where y.voided_at is not null and y.voided_at >= p_start and y.voided_at < p_end) as voided_count,
      (select coalesce(sum(amount), 0) from ln) as charged,
      (select coalesce(sum(round((list_price - unit_price) * quantity)), 0) from ln where list_price > unit_price) as discounts,
      (select coalesce(sum(total), 0) from credit_note c
       where c.deleted_at is null and c.created_at >= p_start and c.created_at < p_end) as credit_notes
  )
  select jsonb_build_object(
    'collected', t.collected, 'refunded', t.refunded, 'net', t.collected - t.refunded,
    'refunds', t.refunds, 'voided', t.voided, 'voidedCount', t.voided_count,
    'payments', t.payments, 'paidVisits', t.paid_visits,
    'avgPerVisit', case when t.paid_visits > 0 then round(t.bills / t.paid_visits) end,
    'bills', t.bills, 'counterSales', t.counter_sales,
    'charged', t.charged, 'discounts', t.discounts, 'creditNotes', t.credit_notes)
  from t
$$;
revoke all on function revenue_totals(timestamptz, timestamptz) from public, anon, authenticated;

create or replace function revenue_analysis(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_len integer;
  v_start timestamptz;
  v_end timestamptz;
  v_pharmacy uuid;
  v_result jsonb;
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  v_len := v_to - v_from + 1;
  v_start := v_from::timestamp at time zone 'Africa/Kigali';
  v_end := (v_to + 1)::timestamp at time zone 'Africa/Kigali';
  -- medicines count as the pharmacy's
  select d.id into v_pharmacy from department d
  where d.active and d.deleted_at is null and 'pharmacy' = any (d.services)
  order by d.sort_order, d.name limit 1;

  with ok as (
    select y.* from payment y where y.deleted_at is null and y.paid_at >= v_start and y.paid_at < v_end
  ),
  rf as (
    select r.* from refund r where r.deleted_at is null and r.refunded_at >= v_start and r.refunded_at < v_end
  ),
  vd as (
    select y.* from payment y where y.voided_at is not null and y.voided_at >= v_start and y.voided_at < v_end
  ),
  -- every bill line with its category and department; bill = the visit bill or the counter sale
  lk as (
    select l.id, l.invoice_id as bill_id, l.created_at, round(l.unit_price * l.quantity) as amount,
           l.list_price, l.unit_price, l.quantity::numeric as quantity, l.discount_reason,
           c.id as cat_id, coalesce(c.base_group::text, case when sv.id is null then 'pharmacy' else 'other' end) as cat_group,
           c.name_en, c.name_kin, c.name_fr,
           case when sv.id is null then v_pharmacy else sv.department_id end as dept_id,
           case when sv.id is null then 'pharmacy' when sv.department_id is null then 'none' else 'department' end as dept_key
    from invoice_line l
    left join service sv on sv.id = l.service_id
    left join service_category c on c.id = sv.category_id
    where l.deleted_at is null
    union all
    -- walk-in medicine sales (counter sales) are the pharmacy's; a cancelled sale is left out
    select x.id, x.sale_id, x.created_at, x.line_total, x.unit_price, x.unit_price, x.quantity::numeric, null::text,
           null::uuid, 'pharmacy', null::text, null::text, null::text, v_pharmacy, 'pharmacy'
    from counter_sale_line x join counter_sale s on s.id = x.sale_id
    where x.deleted_at is null and s.deleted_at is null and s.status <> 'cancelled'
  ),
  ln as (select * from lk where lk.created_at >= v_start and lk.created_at < v_end),
  -- each bill's payments in the period spread over its lines by their amount (an estimate)
  est as (
    select lk.*, ok.amount * lk.amount / bt.total as collected
    from ok
    join (select bill_id, sum(amount) as total from lk group by bill_id having sum(amount) > 0) bt
      on bt.bill_id = coalesce(ok.invoice_id, ok.counter_sale_id)
    join lk on lk.bill_id = bt.bill_id
  ),
  dd as (
    select d::date as day from generate_series(v_from, v_to, interval '1 day') d
    where v_len <= 400
    union
    select (paid_at at time zone 'Africa/Kigali')::date from ok
    union
    select (refunded_at at time zone 'Africa/Kigali')::date from rf
    union
    select (voided_at at time zone 'Africa/Kigali')::date from vd
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_to,
    'totals', revenue_totals(v_start, v_end),
    'prev', revenue_totals((v_from - v_len)::timestamp at time zone 'Africa/Kigali', v_start),
    'prevFrom', v_from - v_len, 'prevTo', v_from - 1,
    'days', coalesce((
      select jsonb_agg(jsonb_build_object(
          'day', dd.day,
          'cash', coalesce(p.cash, 0), 'momo', coalesce(p.momo, 0), 'airtel', coalesce(p.airtel, 0), 'other', coalesce(p.other, 0),
          'payments', coalesce(p.n, 0), 'refunds', coalesce(r.amount, 0), 'voided', coalesce(v.amount, 0),
          'net', coalesce(p.total, 0) - coalesce(r.amount, 0), 'visits', coalesce(p.visits, 0),
          'counterSales', coalesce(p.counter, 0)) order by dd.day)
      from dd
      left join (
        select (ok.paid_at at time zone 'Africa/Kigali')::date as day,
               sum(ok.amount) filter (where ok.method = 'cash') as cash,
               sum(ok.amount) filter (where ok.method = 'momo') as momo,
               sum(ok.amount) filter (where ok.method = 'airtel') as airtel,
               sum(ok.amount) filter (where ok.method not in ('cash', 'momo', 'airtel')) as other,
               sum(ok.amount) as total, count(*) as n,
               sum(ok.amount) filter (where ok.counter_sale_id is not null) as counter,
               count(distinct i.encounter_id) as visits
        from ok left join invoice i on i.id = ok.invoice_id
        group by 1) p on p.day = dd.day
      left join (select (refunded_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount from rf group by 1) r on r.day = dd.day
      left join (select (voided_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount from vd group by 1) v on v.day = dd.day
    ), '[]'::jsonb),
    'byMethod', coalesce((
      select jsonb_agg(jsonb_build_object('method', m.method, 'amount', m.amount, 'count', m.n,
                                          'share', round(100.0 * m.amount / nullif((select sum(amount) from ok), 0), 1))
                       order by m.amount desc)
      from (select method, sum(amount) as amount, count(*) as n from ok group by method) m), '[]'::jsonb),
    'bySource', jsonb_build_object(
      'bills', jsonb_build_object('amount', (select coalesce(sum(amount), 0) from ok where invoice_id is not null),
                                  'count', (select count(*) from ok where invoice_id is not null)),
      'counterSales', jsonb_build_object('amount', (select coalesce(sum(amount), 0) from ok where counter_sale_id is not null),
                                         'count', (select count(*) from ok where counter_sale_id is not null))),
    'byCategory', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.cat_id, 'group', g.cat_group, 'name', g.name_en, 'nameKin', g.name_kin,
                                          'nameFr', g.name_fr, 'charged', g.charged, 'collectedEst', round(g.collected),
                                          'lines', g.lines) order by g.charged desc, g.collected desc)
      from (
        select k.cat_id, k.cat_group, max(k.name_en) as name_en, max(k.name_kin) as name_kin, max(k.name_fr) as name_fr,
               coalesce(sum(k.charged), 0) as charged, coalesce(sum(k.collected), 0) as collected, coalesce(sum(k.lines), 0) as lines
        from (
          select cat_id, cat_group, name_en, name_kin, name_fr, amount as charged, 0::numeric as collected, 1 as lines from ln
          union all
          select cat_id, cat_group, name_en, name_kin, name_fr, 0, collected, 0 from est
        ) k
        group by k.cat_id, k.cat_group) g), '[]'::jsonb),
    'byDepartment', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.dept_id, 'key', g.dept_key, 'name', d.name, 'charged', g.charged,
                                          'collectedEst', round(g.collected), 'lines', g.lines) order by g.charged desc, g.collected desc)
      from (
        select k.dept_id, case when k.dept_id is not null then 'department' else max(k.dept_key) end as dept_key,
               coalesce(sum(k.charged), 0) as charged, coalesce(sum(k.collected), 0) as collected, coalesce(sum(k.lines), 0) as lines
        from (
          select dept_id, dept_key, amount as charged, 0::numeric as collected, 1 as lines from ln
          union all
          select dept_id, dept_key, 0, collected, 0 from est
        ) k
        group by k.dept_id, case when k.dept_id is null then k.dept_key end) g
      left join department d on d.id = g.dept_id), '[]'::jsonb),
    'byPayer', coalesce((
      select jsonb_agg(jsonb_build_object('payerId', b.payer_id, 'name', py.name, 'type', coalesce(py.type::text, 'cash'),
                                          'bills', b.bills, 'patientShare', b.patient_share, 'insurerShare', b.insurer_share,
                                          'paid', b.paid, 'owed', b.owed) order by b.bills desc)
      from (
        select i.payer_id, count(*) as bills, sum(i.patient_share) as patient_share, sum(i.insurer_share) as insurer_share,
               sum((select coalesce(sum(y.amount), 0) from payment y where y.invoice_id = i.id and y.deleted_at is null)) as paid,
               sum(greatest(invoice_balance(i.id), 0)) as owed
        from invoice i
        where i.deleted_at is null and i.total > 0 and i.created_at >= v_start and i.created_at < v_end
        group by i.payer_id) b
      left join payer py on py.id = b.payer_id), '[]'::jsonb),
    'byCashier', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', pr.full_name,
                                          'payments', (select count(*) from ok where ok.cashier_id = c.id),
                                          'amount', (select coalesce(sum(amount), 0) from ok where ok.cashier_id = c.id),
                                          'refunds', (select coalesce(sum(amount), 0) from rf where rf.cashier_id = c.id),
                                          'voided', (select count(*) from vd where vd.cashier_id = c.id),
                                          'variance', (select sum(dc.variance) from day_close dc
                                                       where dc.cashier_id = c.id and dc.deleted_at is null
                                                         and dc.date between v_from and v_to))
                       order by pr.full_name)
      from (select cashier_id as id from ok union select cashier_id from rf union select cashier_id from vd
            union select cashier_id from day_close where deleted_at is null and date between v_from and v_to) c
      join profiles pr on pr.id = c.id), '[]'::jsonb),
    'discounts', jsonb_build_object(
      'lines', (select count(*) from ln where list_price > unit_price),
      'amount', (select coalesce(sum(round((list_price - unit_price) * quantity)), 0) from ln where list_price > unit_price),
      'byReason', coalesce((
        select jsonb_agg(jsonb_build_object('reason', x.reason, 'lines', x.n, 'amount', x.amount) order by x.amount desc)
        from (select nullif(trim(coalesce(discount_reason, '')), '') as reason, count(*) as n,
                     sum(round((list_price - unit_price) * quantity)) as amount
              from ln where list_price > unit_price group by 1) x), '[]'::jsonb)),
    'refunds', coalesce((
      select jsonb_agg(x.j order by x.at desc) from (
        select rf.refunded_at as at,
               jsonb_build_object('id', rf.id, 'at', rf.refunded_at, 'amount', rf.amount, 'method', rf.method, 'reason', rf.reason,
                                  'by', pr.full_name, 'invoiceId', rf.invoice_id, 'encounterId', i.encounter_id,
                                  'patient', pt.surname || ' ' || pt.given_names, 'fileNumber', pt.file_number) as j
        from rf
        join invoice i on i.id = rf.invoice_id
        left join encounter e on e.id = i.encounter_id
        left join patient pt on pt.id = e.patient_id
        left join profiles pr on pr.id = rf.cashier_id
        order by rf.refunded_at desc limit 200) x), '[]'::jsonb),
    'creditNotes', coalesce((
      select jsonb_agg(x.j order by x.at desc) from (
        select c.created_at as at,
               jsonb_build_object('id', c.id, 'at', c.created_at, 'number', c.number, 'amount', c.total,
                                  'patientAmount', c.patient_amount, 'insurerAmount', c.insurer_amount, 'reason', c.reason,
                                  'by', pr.full_name, 'invoiceId', c.invoice_id, 'encounterId', i.encounter_id,
                                  'patient', pt.surname || ' ' || pt.given_names, 'fileNumber', pt.file_number) as j
        from credit_note c
        join invoice i on i.id = c.invoice_id
        left join encounter e on e.id = i.encounter_id
        left join patient pt on pt.id = e.patient_id
        left join profiles pr on pr.id = coalesce(c.approver_id, c.created_by)
        where c.deleted_at is null and c.created_at >= v_start and c.created_at < v_end
        order by c.created_at desc limit 200) x), '[]'::jsonb),
    'voided', coalesce((
      select jsonb_agg(x.j order by x.at desc) from (
        select vd.voided_at as at,
               jsonb_build_object('id', vd.id, 'at', vd.voided_at, 'paidAt', vd.paid_at, 'amount', vd.amount, 'method', vd.method,
                                  'reason', vd.void_reason, 'by', vb.full_name, 'cashier', cb.full_name, 'receiptNo', vd.receipt_no,
                                  'encounterId', i.encounter_id,
                                  'patient', coalesce(pt.surname || ' ' || pt.given_names, cs.buyer_name),
                                  'fileNumber', pt.file_number) as j
        from vd
        left join profiles vb on vb.id = vd.voided_by
        left join profiles cb on cb.id = vd.cashier_id
        left join invoice i on i.id = vd.invoice_id
        left join encounter e on e.id = i.encounter_id
        left join patient pt on pt.id = e.patient_id
        left join counter_sale cs on cs.id = vd.counter_sale_id
        order by vd.voided_at desc limit 200) x), '[]'::jsonb),
    -- what is owed now (not a period figure)
    'debts', (
      select jsonb_build_object(
        'openCount', count(*) filter (where b.open), 'openDue', coalesce(sum(b.due) filter (where b.open), 0),
        'closedCount', count(*) filter (where not b.open), 'closedDue', coalesce(sum(b.due) filter (where not b.open), 0),
        'top', coalesce((
          select jsonb_agg(jsonb_build_object('invoiceId', t.id, 'number', coalesce(t.number, t.provisional_no),
                                              'encounterId', t.encounter_id, 'patient', t.patient, 'fileNumber', t.file_number,
                                              'due', t.due, 'open', t.open, 'arrivedAt', t.arrived_at) order by t.due desc)
          from (select * from (
                  select i.id, i.number, i.provisional_no, i.encounter_id, invoice_balance(i.id) as due, e.status = 'open' as open,
                         e.arrived_at, pt.surname || ' ' || pt.given_names as patient, pt.file_number
                  from invoice i join encounter e on e.id = i.encounter_id join patient pt on pt.id = e.patient_id
                  where i.deleted_at is null and i.total > 0) z
                where z.due > 0 order by z.due desc limit 20) t), '[]'::jsonb))
      from (select invoice_balance(i.id) as due, e.status = 'open' as open
            from invoice i join encounter e on e.id = i.encounter_id
            where i.deleted_at is null and i.total > 0) b
      where b.due > 0)
  ) into v_result;
  return v_result;
end
$$;
revoke all on function revenue_analysis(date, date) from public, anon;
grant execute on function revenue_analysis(date, date) to authenticated;

-- ---------------------------------------------------------------- D patients and visits
-- The visits of a window in scope (all, or those with a queue entry at one of the stations).
create or replace function analytics_visits(p_start timestamptz, p_end timestamptz, p_stations station[])
returns table (id uuid, patient_id uuid, type encounter_type, arrived_at timestamptz, is_new boolean)
language sql stable security definer set search_path = public
as $$
  select e.id, e.patient_id, e.type, e.arrived_at,
         not exists (select 1 from encounter x where x.patient_id = e.patient_id and x.deleted_at is null
                     and (x.arrived_at < e.arrived_at or (x.arrived_at = e.arrived_at and x.id < e.id)))
  from encounter e
  where e.deleted_at is null and e.arrived_at >= p_start and e.arrived_at < p_end
    and (p_stations is null or exists (select 1 from queue_entry q where q.encounter_id = e.id and q.deleted_at is null
                                       and q.station = any (p_stations)))
$$;
revoke all on function analytics_visits(timestamptz, timestamptz, station[]) from public, anon, authenticated;

create or replace function visits_totals(p_start timestamptz, p_end timestamptz, p_stations station[], p_members uuid[])
returns jsonb
language sql stable security definer set search_path = public
as $$
  with v as (select * from analytics_visits(p_start, p_end, p_stations)),
  ap as (
    select a.status from appointment a
    left join practitioner pr on pr.id = a.practitioner_id
    where a.deleted_at is null and coalesce(a.starts_at, a.created_at) >= p_start and coalesce(a.starts_at, a.created_at) < p_end
      and (p_members is null or pr.user_id = any (p_members))
  )
  select jsonb_build_object(
    'registered', (select count(*) from patient x
                   where x.deleted_at is null and x.created_at >= p_start and x.created_at < p_end
                     and (p_stations is null or exists (select 1 from v where v.patient_id = x.id))),
    'visits', (select count(*) from v),
    'newPatients', (select count(*) from v where v.is_new),
    'returning', (select count(*) from v where not v.is_new),
    'booked', (select count(*) from ap where status in ('confirmed', 'arrived', 'in_progress', 'completed', 'no_show')),
    'kept', (select count(*) from ap where status in ('arrived', 'in_progress', 'completed')),
    'missed', (select count(*) from ap where status = 'no_show'),
    'pending', (select count(*) from ap where status = 'inquiry'))
$$;
revoke all on function visits_totals(timestamptz, timestamptz, station[], uuid[]) from public, anon, authenticated;

create or replace function visits_analysis(p_from date default null, p_to date default null, p_department uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  s record;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_len integer;
  v_start timestamptz;
  v_end timestamptz;
  v_stations station[];
  v_result jsonb;
begin
  select * into s from analytics_scope(p_department);
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  v_len := v_to - v_from + 1;
  v_start := v_from::timestamp at time zone 'Africa/Kigali';
  v_end := (v_to + 1)::timestamp at time zone 'Africa/Kigali';
  v_stations := case when s.s_department is null then null else s.s_stations end;

  with v as (select * from analytics_visits(v_start, v_end, v_stations)),
  -- the bill lines of the window (a department: its own services)
  ln as (
    select l.*, sv.category_id, sv.department_id as service_department
    from invoice_line l
    join invoice i on i.id = l.invoice_id
    left join service sv on sv.id = l.service_id
    where l.deleted_at is null and l.created_at >= v_start and l.created_at < v_end
      and (s.s_department is null
           or sv.department_id = s.s_department
           or exists (select 1 from service_department sd where sd.service_id = sv.id and sd.department_id = s.s_department))
  ),
  dd as (
    select d::date as day from generate_series(v_from, v_to, interval '1 day') d where v_len <= 400
    union
    select (arrived_at at time zone 'Africa/Kigali')::date from v
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_to, 'manager', s.s_manager, 'department', s.s_department,
    'totals', visits_totals(v_start, v_end, v_stations, s.s_members),
    'prev', visits_totals((v_from - v_len)::timestamp at time zone 'Africa/Kigali', v_start, v_stations, s.s_members),
    'prevFrom', v_from - v_len, 'prevTo', v_from - 1,
    'days', coalesce((
      select jsonb_agg(jsonb_build_object(
          'day', dd.day, 'visits', coalesce(a.visits, 0), 'newPatients', coalesce(a.new_patients, 0),
          'returning', coalesce(a.visits, 0) - coalesce(a.new_patients, 0),
          'registered', (select count(*) from patient x
                         where x.deleted_at is null and (x.created_at at time zone 'Africa/Kigali')::date = dd.day
                           and (v_stations is null or exists (select 1 from v where v.patient_id = x.id))),
          'byType', coalesce(a.by_type, '{}'::jsonb)) order by dd.day)
      from dd
      left join (
        select t.day, sum(t.n) as visits, sum(t.new_patients) as new_patients, jsonb_object_agg(t.type, t.n) as by_type
        from (select (arrived_at at time zone 'Africa/Kigali')::date as day, type::text as type, count(*) as n,
                     count(*) filter (where is_new) as new_patients
              from v group by 1, 2) t
        group by t.day) a on a.day = dd.day), '[]'::jsonb),
    'byGroup', coalesce((
      select jsonb_agg(jsonb_build_object('group', g.grp, 'categoryId', g.cat_id, 'name', g.name, 'nameKin', g.kin,
                                          'nameFr', g.fr, 'count', g.n) order by g.n desc)
      from (
        select coalesce(c.base_group::text, case when ln.service_id is null then 'pharmacy' else 'other' end) as grp,
               c.id as cat_id, c.name_en as name, c.name_kin as kin, c.name_fr as fr, count(distinct i.encounter_id) as n
        from ln
        join invoice i on i.id = ln.invoice_id
        left join service_category c on c.id = ln.category_id
        group by c.id, 1, 3, 4, 5) g), '[]'::jsonb),
    'byType', coalesce((
      select jsonb_agg(jsonb_build_object('type', t.type, 'count', t.n) order by t.n desc)
      from (select type::text as type, count(*) as n from v group by 1) t), '[]'::jsonb),
    'byHour', (
      select jsonb_agg(coalesce(h.n, 0) order by g.hour)
      from generate_series(0, 23) g(hour)
      left join (select extract(hour from arrived_at at time zone 'Africa/Kigali')::int as hour, count(*) as n from v group by 1) h
        on h.hour = g.hour),
    'treatmentTotals', jsonb_build_object(
      'lines', (select count(*) from ln),
      'distinct', (select count(distinct ln.description) from ln),
      'charged', case when s.s_manager then (select coalesce(sum(round(ln.unit_price * ln.quantity)), 0) from ln) end),
    'treatments', coalesce((
      select jsonb_agg(jsonb_build_object('description', t.description, 'categoryId', t.cat_id, 'category', t.cat_name,
                                          'categoryKin', t.cat_kin, 'categoryFr', t.cat_fr,
                                          'count', t.n, 'amount', case when s.s_manager then t.amount end)
                       order by t.n desc, t.description)
      from (select ln.description, c.id as cat_id, c.name_en as cat_name, c.name_kin as cat_kin, c.name_fr as cat_fr,
                   count(*) as n, sum(round(ln.unit_price * ln.quantity)) as amount
            from ln left join service_category c on c.id = ln.category_id
            group by ln.description, c.id, c.name_en, c.name_kin, c.name_fr
            order by count(*) desc, ln.description
            limit 300) t), '[]'::jsonb)
  ) into v_result;
  return v_result;
end
$$;
revoke all on function visits_analysis(date, date, uuid) from public, anon;
grant execute on function visits_analysis(date, date, uuid) to authenticated;

-- ---------------------------------------------------------------- E waiting time, corrected
-- The queues right now: waiting = joined today (Kigali) and not yet taken; forgotten = still open
-- from an earlier day (please close); busy = being seen. Internal: not granted.
create or replace function queue_now(p_stations station[] default null)
returns table (station text, waiting integer, busy integer, longest integer, forgotten integer)
language sql stable security definer set search_path = public
as $$
  with k as (select ((now() at time zone 'Africa/Kigali')::date)::timestamp at time zone 'Africa/Kigali' as midnight)
  select q.station::text,
         (count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open' and q.created_at >= k.midnight))::int,
         (count(*) filter (where q.finished_at is null and q.started_at is not null and e.status = 'open'))::int,
         round(max(extract(epoch from now() - q.created_at) / 60)
               filter (where q.finished_at is null and q.started_at is null and e.status = 'open' and q.created_at >= k.midnight))::int,
         (count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open' and q.created_at < k.midnight))::int
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  cross join k
  where q.deleted_at is null and (p_stations is null or q.station = any (p_stations))
    and ((q.finished_at is null and e.status = 'open') or q.created_at >= k.midnight)
  group by q.station
$$;
revoke all on function queue_now(station[]) from public, anon, authenticated;

create or replace function wait_time_stats(p_from date default null, p_to date default null, p_department uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  s record;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_len integer;
  v_start timestamptz;
  v_end timestamptz;
  -- the desks where a wait is measured (reception and beds: not)
  v_measured station[] := array['triage', 'consultation', 'dental', 'theatre', 'nursing', 'laboratory', 'ultrasound',
                                'pharmacy', 'cashier']::station[];
  v_stations station[];
  v_result jsonb;
begin
  select * into s from analytics_scope(p_department);
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  v_len := v_to - v_from + 1;
  v_start := v_from::timestamp at time zone 'Africa/Kigali';
  v_end := (v_to + 1)::timestamp at time zone 'Africa/Kigali';
  select coalesce(array_agg(x order by array_position(v_measured, x)), '{}') into v_stations
  from unnest(v_measured) x where x = any (s.s_stations);

  with w as (
    -- one wait per queue entry: from joining the desk's queue to the desk's end event
    select q.id, q.station, q.encounter_id, q.created_at as start_at,
           case
             when q.station in ('consultation', 'dental', 'theatre', 'nursing', 'laboratory', 'ultrasound') then q.started_at
             when q.station = 'triage' then (
               select min(o.effective_at) from observation o
               where o.encounter_id = q.encounter_id and o.deleted_at is null and o.code <> 'note'
                 and o.effective_at >= q.created_at and o.effective_at <= coalesce(q.finished_at, now()))
             when q.station = 'cashier' then (
               select min(y.paid_at) from payment y join invoice i on i.id = y.invoice_id
               where i.encounter_id = q.encounter_id and y.paid_at >= q.created_at and y.paid_at <= coalesce(q.finished_at, now()))
             when q.station = 'pharmacy' then (
               select min(x.at) from (
                 select md.created_at as at from medication_dispense md
                 where md.encounter_id = q.encounter_id and md.deleted_at is null
                 union all
                 select m.given_at from medication_request m
                 where m.encounter_id = q.encounter_id and m.deleted_at is null and m.given_at is not null) x
               where x.at >= q.created_at and x.at <= coalesce(q.finished_at, now()))
           end as end_at
    from queue_entry q
    where q.deleted_at is null and q.station = any (v_stations)
      and q.created_at < v_end and q.created_at >= v_start - interval '2 days'
  ),
  d as (
    select w.*, extract(epoch from w.end_at - w.start_at)::float8 / 60 as minutes,
           (w.end_at at time zone 'Africa/Kigali')::date as day,
           (w.end_at - w.start_at > interval '12 hours'
            or (w.start_at at time zone 'Africa/Kigali')::date <> (w.end_at at time zone 'Africa/Kigali')::date) as excluded
    from w
    where w.end_at is not null and w.end_at >= w.start_at and w.end_at >= v_start and w.end_at < v_end
  ),
  -- arrival to the first desk where a patient is seen (triage, consultation, dental)
  fe as (
    select w.encounter_id, min(w.end_at) as end_at from w
    where w.station in ('triage', 'consultation', 'dental') and w.end_at is not null and w.end_at >= w.start_at
    group by w.encounter_id
  ),
  ar as (
    select extract(epoch from fe.end_at - e.arrived_at)::float8 / 60 as minutes,
           (fe.end_at - e.arrived_at > interval '12 hours'
            or (e.arrived_at at time zone 'Africa/Kigali')::date <> (fe.end_at at time zone 'Africa/Kigali')::date) as excluded
    from fe join encounter e on e.id = fe.encounter_id and e.deleted_at is null
    where fe.end_at >= v_start and fe.end_at < v_end and fe.end_at >= e.arrived_at
  ),
  per as (
    select d.station,
           count(*) filter (where not d.excluded) as n,
           round((percentile_cont(0.5) within group (order by d.minutes) filter (where not d.excluded))::numeric, 1) as median,
           round((percentile_cont(0.9) within group (order by d.minutes) filter (where not d.excluded))::numeric, 1) as p90,
           round((avg(d.minutes) filter (where not d.excluded))::numeric, 1) as mean,
           count(*) filter (where d.excluded) as excluded
    from d group by d.station
  ),
  dd as (
    select g::date as day from generate_series(v_from, v_to, interval '1 day') g where v_len <= 400
    union
    select d.day from d where not d.excluded
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_to, 'department', s.s_department,
    'rules', jsonb_build_object('minN', 5, 'maxHours', 12),
    'desks', coalesce((
      select jsonb_agg(jsonb_build_object(
          'station', st::text, 'n', coalesce(per.n, 0), 'median', per.median, 'p90', per.p90, 'mean', per.mean,
          'excluded', coalesce(per.excluded, 0), 'waitingNow', coalesce(l.waiting, 0), 'longestNow', l.longest,
          'forgotten', coalesce(l.forgotten, 0)) order by array_position(v_stations, st))
      from unnest(v_stations) st
      left join per on per.station = st
      left join queue_now(v_stations) l on l.station = st::text), '[]'::jsonb),
    'overall', (
      select jsonb_build_object(
        'n', count(*) filter (where not d.excluded),
        'median', round((percentile_cont(0.5) within group (order by d.minutes) filter (where not d.excluded))::numeric, 1),
        'p90', round((percentile_cont(0.9) within group (order by d.minutes) filter (where not d.excluded))::numeric, 1),
        'excluded', count(*) filter (where d.excluded))
      from d),
    'arrival', (
      select jsonb_build_object(
        'n', count(*) filter (where not ar.excluded),
        'median', round((percentile_cont(0.5) within group (order by ar.minutes) filter (where not ar.excluded))::numeric, 1),
        'p90', round((percentile_cont(0.9) within group (order by ar.minutes) filter (where not ar.excluded))::numeric, 1),
        'excluded', count(*) filter (where ar.excluded))
      from ar),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', dd.day, 'n', coalesce(x.n, 0), 'median', x.median) order by dd.day)
      from dd
      left join (select d.day, count(*) as n,
                        round((percentile_cont(0.5) within group (order by d.minutes))::numeric, 1) as median
                 from d where not d.excluded group by d.day) x on x.day = dd.day), '[]'::jsonb),
    -- tests: from the order to the verified result (turnaround, not waiting)
    'turnaround', coalesce((
      select jsonb_agg(jsonb_build_object('station', t.desk, 'n', t.n, 'median', t.median, 'p90', t.p90) order by t.desk)
      from (
        select request_desk(r.station, r.category) as desk, count(*) as n,
               round((percentile_cont(0.5) within group (order by extract(epoch from rep.verified_at - r.created_at)::float8 / 60))::numeric, 1) as median,
               round((percentile_cont(0.9) within group (order by extract(epoch from rep.verified_at - r.created_at)::float8 / 60))::numeric, 1) as p90
        from service_request r
        join diagnostic_report rep on rep.service_request_id = r.id and rep.deleted_at is null
        where r.deleted_at is null and rep.verified_at >= v_start and rep.verified_at < v_end and rep.verified_at >= r.created_at
          and (s.s_desks is null or request_desk(r.station, r.category) = any (s.s_desks))
        group by 1) t), '[]'::jsonb)
  ) into v_result;
  return v_result;
end
$$;
revoke all on function wait_time_stats(date, date, uuid) from public, anon;
grant execute on function wait_time_stats(date, date, uuid) to authenticated;

-- ---------------------------------------------------------------- F the cards
-- dashboard_summary (from 20261109090000_bookings_by_role): no average wait; waiting today only,
-- forgotten apart; staff rows by id with the corrected counts (retired staff keep their work);
-- reorder rows by id with the full name; revenue per day with refunds and net.
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
  v_midnight timestamptz := ((now() at time zone 'Africa/Kigali')::date)::timestamp at time zone 'Africa/Kigali';
  v_tiles jsonb;
  v_rev30 jsonb;
  v_rev_period jsonb;
  v_collections jsonb;
  v_receivables jsonb;
  v_visits jsonb;
  v_wait jsonb;
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
    -- patients who joined a queue today and are not taken yet (one patient sent to several desks counts once)
    'waitingNow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
                   where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'
                     and q.created_at >= v_midnight),
    -- still open from an earlier day: forgotten in a queue (please close)
    'forgottenNow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
                     where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'
                       and q.created_at < v_midnight),
    'revenue', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to) end,
    'revenuePrev', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to) end,
    'refunded', case when v_manager then (select coalesce(sum(amount), 0) from refund where deleted_at is null and (refunded_at at time zone 'Africa/Kigali')::date between p_from and p_to) end,
    'openBills', case when v_manager then (select count(*) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'openBillsDue', case when v_manager then (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'debts', case when v_manager then (select count(*) from invoice i join encounter e on e.id = i.encounter_id
                                       where i.deleted_at is null and e.status <> 'open' and invoice_balance(i.id) > 0) end,
    'debtsDue', case when v_manager then (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id
                                          where i.deleted_at is null and e.status <> 'open' and invoice_balance(i.id) > 0) end,
    'bedsOccupied', (select count(*) from bed where deleted_at is null and status = 'occupied'),
    'bedsTotal', (select count(*) from bed where deleted_at is null and status <> 'out_of_service')
  ) into v_tiles;

  -- revenue per day, last 30 days ending today: collected, refunded and net
  select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'amount', coalesce(s.amount, 0),
                                               'refunds', coalesce(r.amount, 0),
                                               'net', coalesce(s.amount, 0) - coalesce(r.amount, 0)) order by d), '[]'::jsonb) into v_rev30
  from generate_series(v_today - 29, v_today, interval '1 day') d
  left join (
    select (paid_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
    from payment where deleted_at is null and paid_at >= (v_today - 29)::timestamp at time zone 'Africa/Kigali'
    group by 1
  ) s on s.day = d::date
  left join (
    select (refunded_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
    from refund where deleted_at is null and refunded_at >= (v_today - 29)::timestamp at time zone 'Africa/Kigali'
    group by 1
  ) r on r.day = d::date;

  -- the same for the chosen period (up to 92 days; longer: see Analytics)
  if v_days <= 92 then
    select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'amount', coalesce(s.amount, 0),
                                                 'refunds', coalesce(r.amount, 0),
                                                 'net', coalesce(s.amount, 0) - coalesce(r.amount, 0)) order by d), '[]'::jsonb)
    into v_rev_period
    from generate_series(p_from, p_to, interval '1 day') d
    left join (
      select (paid_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
      from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to
      group by 1
    ) s on s.day = d::date
    left join (
      select (refunded_at at time zone 'Africa/Kigali')::date as day, sum(amount) as amount
      from refund where deleted_at is null and (refunded_at at time zone 'Africa/Kigali')::date between p_from and p_to
      group by 1
    ) r on r.day = d::date;
  end if;

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
  select coalesce(jsonb_agg(jsonb_build_object('group', g.grp, 'categoryId', g.cat_id, 'name', g.name, 'nameKin', g.kin,
                                                'nameFr', g.fr, 'count', g.n) order by g.n desc), '[]'::jsonb) into v_visits
  from (
    -- by the clinic's own categories; medicines (no service) count as pharmacy
    select coalesce(c.base_group::text, case when s.id is null then 'pharmacy' else 'other' end) as grp,
           c.id as cat_id, c.name_en as name, c.name_kin as kin, c.name_fr as fr, count(distinct i.encounter_id) as n
    from invoice_line l
    join invoice i on i.id = l.invoice_id
    left join service s on s.id = l.service_id
    left join service_category c on c.id = s.category_id
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by c.id, 1, 3, 4, 5
  ) g;

  -- the queues right now (no average: see Analytics → Waiting times)
  select coalesce(jsonb_agg(jsonb_build_object('station', w.station, 'waiting', w.waiting, 'busy', w.busy,
                                               'longest', w.longest, 'forgotten', w.forgotten) order by w.station), '[]'::jsonb)
  into v_wait
  from queue_now(null) w;

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

  -- who did what (accountability): the same counts as Analytics → Who did what
  with ev as (
    select * from analytics_staff_events(p_from::timestamp at time zone 'Africa/Kigali',
                                         (p_to + 1)::timestamp at time zone 'Africa/Kigali', v_manager)
  ),
  a as (
    select ev.user_id,
           count(*) filter (where kind = 'registered') as registrations,
           count(*) filter (where kind = 'vitals') as vitals,
           count(*) filter (where kind = 'charges') as charges,
           count(*) filter (where kind = 'patientsSeen') as patients,
           count(*) filter (where kind = 'results') as results,
           count(*) filter (where kind = 'medicinesGiven') as dispensed,
           count(*) filter (where kind = 'payments') as payments,
           coalesce(sum(amount) filter (where kind = 'payments'), 0) as collected
    from ev group by ev.user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.full_name, 'role', p.role, 'staffId', p.staff_id,
      'active', p.active and p.deleted_at is null,
      'registrations', coalesce(a.registrations, 0), 'vitals', coalesce(a.vitals, 0), 'charges', coalesce(a.charges, 0),
      'patients', coalesce(a.patients, 0), 'results', coalesce(a.results, 0), 'dispensed', coalesce(a.dispensed, 0),
      'payments', case when v_manager then coalesce(a.payments, 0) end,
      'collected', case when v_manager then coalesce(a.collected, 0) end,
      'lastSignIn', p.last_sign_in_at
    ) order by (coalesce(a.registrations, 0) + coalesce(a.vitals, 0) + coalesce(a.charges, 0) + coalesce(a.payments, 0)
                + coalesce(a.patients, 0) + coalesce(a.results, 0) + coalesce(a.dispensed, 0)) desc, p.full_name), '[]'::jsonb) into v_staff
  from profiles p
  left join a on a.user_id = p.id
  where (p.active and p.deleted_at is null)
     or (a.user_id is not null and (a.registrations + a.vitals + a.charges + a.patients + a.results + a.dispensed + a.payments) > 0);

  -- stock: the item's id and full name (with strength)
  select coalesce(jsonb_agg(jsonb_build_object('id', r.item_id, 'name', item_label(r.item_id), 'onHand', r.on_hand, 'min', r.reorder_level)
                            order by (r.on_hand::numeric / greatest(r.reorder_level, 1)), item_label(r.item_id)), '[]'::jsonb) into v_reorder
  from items_below_reorder r;

  select jsonb_build_object(
    'expired', count(distinct s.item_id) filter (where s.expiry < v_today),
    'd30', count(distinct s.item_id) filter (where s.expiry >= v_today and s.expiry <= v_today + 30),
    'd60', count(distinct s.item_id) filter (where s.expiry > v_today + 30 and s.expiry <= v_today + 60),
    'd90', count(distinct s.item_id) filter (where s.expiry > v_today + 60 and s.expiry <= v_today + 90)
  ) into v_expiring
  from (select item_id, batch_id, expiry, sum(quantity) as q from stock_on_hand where expiry is not null
        group by item_id, batch_id, expiry) s
  where s.q > 0;

  -- bookings
  select jsonb_build_object(
    'booked', count(*) filter (where status in ('confirmed', 'arrived', 'in_progress', 'completed', 'no_show')),
    'missed', count(*) filter (where status = 'no_show'),
    'pending', (select count(*) from appointment where deleted_at is null and status = 'inquiry')
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

  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'role', p.role, 'at', a.at, 'reason', a.reason) order by a.at desc), '[]'::jsonb) into v_logins
  from (select actor_id, at, reason from audit_event where action = 'login' and at > now() - interval '1 day' order by at desc limit 12) a
  join profiles p on p.id = a.actor_id;

  select jsonb_build_object('active', count(*) filter (where active), 'total', count(*)) into v_services from service where deleted_at is null;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'manager', v_manager, 'generatedAt', now(),
    -- money for the manager only (heads of department see the activity, not the money)
    'tiles', v_tiles,
    'revenue30d', case when v_manager then v_rev30 else '[]'::jsonb end,
    'revenuePeriod', case when v_manager then v_rev_period end,
    'collections', case when v_manager then v_collections else '[]'::jsonb end,
    'receivables', case when v_manager then v_receivables else '[]'::jsonb end,
    'visitsByGroup', v_visits, 'waitByStation', v_wait, 'topTreatments', v_top, 'staff', v_staff,
    'reorder', v_reorder, 'expiring', v_expiring, 'bookings', v_noshow, 'messages', v_messages,
    'claims', v_claims, 'logins', v_logins, 'services', v_services
  );
end
$$;

-- desk_summary (from 20261116090000_dashboards_by_period): no average waits; waiting today only.
create or replace function desk_summary(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_midnight timestamptz := ((now() at time zone 'Africa/Kigali')::date)::timestamp at time zone 'Africa/Kigali';
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
                   where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'
                     and q.created_at >= v_midnight),
    'forgottenNow', (select count(distinct q.encounter_id) from queue_entry q join encounter e on e.id = q.encounter_id
                     where q.deleted_at is null and q.finished_at is null and q.started_at is null and e.status = 'open'
                       and q.created_at < v_midnight),
    'triageWaiting', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                      where q.deleted_at is null and q.station = 'triage' and q.finished_at is null and e.status = 'open'
                        and q.created_at >= v_midnight),
    'triageRed', (select count(*) from encounter e where e.deleted_at is null and e.status = 'open' and e.triage_level = 'red'),
    'triageYellow', (select count(*) from encounter e where e.deleted_at is null and e.status = 'open' and e.triage_level = 'yellow'),
    'triageGreen', (select count(*) from encounter e where e.deleted_at is null and e.status = 'open' and e.triage_level = 'green'),
    'triageNone', (select count(*) from encounter e where e.deleted_at is null and e.status = 'open' and e.triage_level is null),
    -- patients still waiting for their first measurements (the Vitals page)
    'needVitals', (select count(*) from encounter e where e.deleted_at is null and e.status = 'open'
                   and not exists (select 1 from observation o where o.encounter_id = e.id and o.deleted_at is null and o.code <> 'note')),
    'vitalsToday', (select count(distinct encounter_id) from observation where deleted_at is null and code <> 'note' and (effective_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'vitalsYesterday', (select count(distinct encounter_id) from observation where deleted_at is null and code <> 'note' and (effective_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to),
    'apptsToday', (select count(*) from appointment where deleted_at is null
                   and status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed')
                   and (starts_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'inquiriesPending', (select count(*) from appointment where deleted_at is null and status = 'inquiry'),
    'bedsOccupied', (select count(*) from bed where deleted_at is null and status = 'occupied'),
    'bedsTotal', (select count(*) from bed where deleted_at is null and status <> 'out_of_service')
  ) into v_tiles;

  -- Where patients are right now: waiting (joined today) / being seen / forgotten per station.
  select coalesce(jsonb_agg(jsonb_build_object('station', s.station, 'waiting', s.waiting, 'busy', s.busy,
                                               'longest', s.longest, 'forgotten', s.forgotten)
                            order by s.station), '[]'::jsonb) into v_stations
  from queue_now(null) s;

  -- Arrivals per hour (06:00–21:00, plus any hour outside that had arrivals).
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

  -- The caller's own work (accountability, and a little motivation).
  select jsonb_build_object(
    'registrations', (select count(*) from patient where deleted_at is null and created_by = v_me and (created_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'visitsStarted', (select count(*) from encounter where deleted_at is null and created_by = v_me and (arrived_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'vitals', (select count(distinct encounter_id) from observation where deleted_at is null and code <> 'note' and performer_id = v_me and (effective_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'charges', (select count(*) from invoice_line where deleted_at is null and entered_by = v_me and (created_at at time zone 'Africa/Kigali')::date between v_from and v_to)
  ) into v_mine;

  return jsonb_build_object('tiles', v_tiles, 'stations', v_stations, 'arrivals', v_hours, 'mine', v_mine);
end
$$;

-- department_summary (from 20261104090000_desks_last_items): no average wait; waiting today only;
-- the people's counts as in Who did what (patients seen, medicines given from room stores too).
create or replace function department_summary(p_department_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_dept department%rowtype;
  v_days integer := greatest(1, p_to - p_from + 1);
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_midnight timestamptz := ((now() at time zone 'Africa/Kigali')::date)::timestamp at time zone 'Africa/Kigali';
  v_stations station[];
  v_members jsonb;
  v_queue jsonb;
  v_tiles jsonb;
  v_services jsonb;
begin
  if not (is_manager() or exists (
    select 1 from staff_department sd join profiles p on p.id = sd.profile_id
    where sd.profile_id = auth.uid() and sd.department_id = p_department_id
      and sd.position in ('head', 'assistant') and p.active)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_dept from department where id = p_department_id and deleted_at is null;
  if not found then
    raise exception 'department not found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(s), '{}') into v_stations
  from unnest(enum_range(null::station)) s
  where station_role(s) = any (v_dept.roles);

  -- the people of the department and what each did in the period
  with ev as (
    select ev.user_id, ev.kind
    from analytics_staff_events(p_from::timestamp at time zone 'Africa/Kigali',
                                (p_to + 1)::timestamp at time zone 'Africa/Kigali', false) ev
    where ev.user_id in (select sd.profile_id from staff_department sd where sd.department_id = p_department_id)
      and ev.kind in ('patientsSeen', 'registered', 'vitals', 'results', 'medicinesGiven', 'tasksDone')
  ),
  a as (
    select ev.user_id,
           count(*) filter (where kind = 'patientsSeen') as patients,
           count(*) filter (where kind = 'registered') as registrations,
           count(*) filter (where kind = 'vitals') as vitals,
           count(*) filter (where kind = 'results') as results,
           count(*) filter (where kind = 'medicinesGiven') as dispensed,
           count(*) filter (where kind = 'tasksDone') as tasks_done
    from ev group by ev.user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.full_name, 'role', p.role, 'position', sd.position, 'station', p.station,
      'lastSignIn', p.last_sign_in_at, 'active', p.active,
      'patients', coalesce(a.patients, 0),
      'registrations', coalesce(a.registrations, 0),
      'vitals', coalesce(a.vitals, 0),
      'results', coalesce(a.results, 0),
      'dispensed', coalesce(a.dispensed, 0),
      'payments', (select count(*) from payment y where y.deleted_at is null and y.cashier_id = p.id
                   and (y.paid_at at time zone 'Africa/Kigali')::date between p_from and p_to),
      'tasksDone', coalesce(a.tasks_done, 0),
      'busyNow', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                  where q.taken_by = p.id and q.deleted_at is null and q.finished_at is null and e.status = 'open')
    ) order by case sd.position when 'head' then 0 when 'assistant' then 1 else 2 end, p.full_name), '[]'::jsonb)
  into v_members
  from staff_department sd join profiles p on p.id = sd.profile_id
  left join a on a.user_id = p.id
  where sd.department_id = p_department_id;

  -- the department's desks right now
  select coalesce(jsonb_agg(jsonb_build_object('station', w.station, 'waiting', w.waiting, 'busy', w.busy,
                                               'longest', w.longest, 'forgotten', w.forgotten) order by w.station), '[]'::jsonb)
  into v_queue
  from queue_now(v_stations) w;

  select jsonb_build_object(
    'patients', (select count(distinct q.encounter_id) from queue_entry q
                 where q.deleted_at is null and q.station = any (v_stations) and q.finished_at is not null
                   and (q.finished_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'patientsPrev', (select count(distinct q.encounter_id) from queue_entry q
                     where q.deleted_at is null and q.station = any (v_stations) and q.finished_at is not null
                       and (q.finished_at at time zone 'Africa/Kigali')::date between p_from - v_days and p_from - 1),
    'waitingNow', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                   where q.deleted_at is null and q.station = any (v_stations) and q.finished_at is null
                     and q.started_at is null and e.status = 'open' and q.created_at >= v_midnight),
    'forgottenNow', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                     where q.deleted_at is null and q.station = any (v_stations) and q.finished_at is null
                       and q.started_at is null and e.status = 'open' and q.created_at < v_midnight),
    'ordersOpen', (select count(*) from service_request r join encounter e on e.id = r.encounter_id
                   where r.deleted_at is null and e.status = 'open'
                     and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) = any (v_stations)
                     and r.status not in ('resulted', 'verified', 'cancelled')),
    'ordersNotDone', (select count(*) from service_request r
                      where r.deleted_at is null and r.status = 'cancelled'
                        and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) = any (v_stations)
                        and (r.updated_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'tasksOpen', (select count(*) from internal_task k join encounter e on e.id = k.encounter_id
                  where k.deleted_at is null and k.done_at is null and e.status = 'open'
                    and k.assigned_role = any (v_dept.roles)),
    'members', jsonb_array_length(v_members),
    'signedInToday', (select count(*) from staff_department sd join profiles p on p.id = sd.profile_id
                      where sd.department_id = p_department_id
                        and (p.last_sign_in_at at time zone 'Africa/Kigali')::date = v_today)
  ) into v_tiles;

  -- the department's treatments done in the period (count only)
  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'count', x.n) order by x.n desc), '[]'::jsonb) into v_services
  from (
    select l.description as name, count(*) as n
    from invoice_line l
    join service_department sv on sv.service_id = l.service_id and sv.department_id = p_department_id
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by l.description order by count(*) desc limit 10
  ) x;

  return jsonb_build_object('department', jsonb_build_object('id', v_dept.id, 'name', v_dept.name, 'roles', v_dept.roles),
                            'stations', to_jsonb(v_stations), 'tiles', v_tiles, 'members', v_members,
                            'queue', v_queue, 'services', v_services);
end
$$;

-- public_clinic_status (from 20261107090000_desks_wave9): no "current wait about X"; waiting =
-- patients who joined a queue today and are still in it (one patient counts once).
create or replace function public_clinic_status()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_local timestamp := now() at time zone 'Africa/Kigali';
  v_midnight timestamptz := (v_local::date)::timestamp at time zone 'Africa/Kigali';
  v_hours jsonb := coalesce((select value -> 'days' from setting where key = 'clinic.hours'), '{}'::jsonb);
  v_span jsonb := v_hours -> extract(dow from v_local)::int::text;
  v_waiting integer;
  v_open boolean := false;
  v_next_day date;
  v_next jsonb;
  i integer;
begin
  select count(distinct q.encounter_id) into v_waiting
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  where q.finished_at is null and q.deleted_at is null and e.status = 'open' and q.created_at >= v_midnight;
  if v_span is not null and jsonb_array_length(v_span) = 2 then
    v_open := v_local::time >= (v_span ->> 0)::time and v_local::time < (v_span ->> 1)::time;
  end if;
  -- the next opening: today if not open yet, else the next day with hours
  if not v_open then
    for i in 0..7 loop
      v_next_day := v_local::date + i;
      v_next := v_hours -> extract(dow from v_next_day)::int::text;
      if v_next is not null and jsonb_array_length(v_next) = 2
         and (i > 0 or v_local::time < (v_next ->> 0)::time) then
        exit;
      end if;
      v_next := null;
    end loop;
  end if;
  return jsonb_build_object(
    'waiting', coalesce(v_waiting, 0),
    'open', v_open,
    'opens_at', case when v_open then v_span ->> 0 else v_next ->> 0 end,
    'opens_on', case when v_open or v_next is null then null else v_next_day end,
    'closes_at', case when v_open then v_span ->> 1 end,
    'as_of', now()
  );
end
$$;
