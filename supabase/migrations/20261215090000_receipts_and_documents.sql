-- 0105 · Receipts of a period, patients' documents of a period, analytics per dashboard.
--
-- The owner asked for three things:
--   * A  RECEIPTS. The cashier's home and the manager's dashboard show how many receipts were
--        given in the period and for how much, print them all in one document and export the
--        list. receipts_in_period() returns every payment of the period with what the receipt
--        builder needs (the same lines, shares and totals as the receipt printed at the cash
--        desk), sorted by time, filtered by cashier and payment method. The manager and anyone
--        who reads the bills see the whole desk; someone who only takes payments sees their own.
--   * B  PATIENTS' DOCUMENTS. The manager prints the medical reports of every patient treated in
--        a period. visits_in_period() lists the visits with the filters of the page (department,
--        doctor, service, insurer, only closed visits, a search); visit_documents() returns what
--        each report needs. It reads every visit through visit_clinical(), the same function the
--        visit screen uses, so every opening of a closed visit is logged in record_access_entry
--        exactly as a single opening is (0088). The manager sees everything; a head of department
--        the visits of their department (analytics_scope, as the Analytics page already does).
--   * C  ANALYTICS PER DASHBOARD. analytics_access() now lists views for every dashboard, not
--        only the manager's and the heads': the cashier's money, the pharmacy's hand-overs and
--        stock, the laboratory's tests, the doctor's and nurse's own work, reception's arrivals
--        and bookings. desk_analytics() gives those dashboards their figures: the signed-in
--        person's own work (no money, their own records only), and the desk's bookings, arrivals
--        and registrations by day. Money and other people's work stay with the manager.
--
-- Errcodes: 42501 not allowed.

-- ---------------------------------------------------------------- A receipts of a period
create or replace function receipts_in_period(
  p_from date default null,
  p_to date default null,
  p_cashier uuid default null,
  p_method text default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_me uuid := auth.uid();
  v_all boolean := is_manager() or has_perm('billing.read');
  v_take boolean := has_perm('payment.take');
  v_cashier uuid := p_cashier;
  v_rows jsonb;
  v_by_method jsonb;
  v_by_cashier jsonb;
  v_cashiers jsonb;
begin
  if v_me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not (v_all or v_take) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- someone who only takes payments (reception by exception) sees the receipts they gave
  if not v_all then
    v_cashier := v_me;
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;

  select coalesce(jsonb_agg(r.j order by r.at, r.id), '[]'::jsonb) into v_rows
  from (
    select pa.paid_at as at, pa.id, jsonb_build_object(
        'id', pa.id,
        'receiptNo', pa.receipt_no,
        'invoiceNo', coalesce(i.number, cs.number),
        'visitNo', e.reference,
        'encounterId', e.id,
        'counterSaleId', cs.id,
        'at', pa.paid_at,
        'method', pa.method::text,
        'amount', pa.amount,
        'reference', pa.reference,
        'cashierId', pa.cashier_id,
        'cashier', pr.full_name,
        'counted', pa.day_close_id is not null,
        'patient', jsonb_build_object(
          'name', coalesce(p.surname || ' ' || p.given_names, cs.buyer_name, ''),
          'fileNumber', coalesce(p.file_number, ''),
          'insurer', py.name,
          'memberNo', cv.member_number),
        'lines', case when i.id is not null then
            coalesce((select jsonb_agg(jsonb_build_object(
                        'description', l.description, 'quantity', l.quantity, 'unitPrice', l.unit_price,
                        'fullAmount', round(l.unit_price * l.quantity), 'amount', l.patient_share)
                      order by l.created_at)
                      from invoice_line l where l.invoice_id = i.id and l.deleted_at is null), '[]'::jsonb)
          else
            coalesce((select jsonb_agg(jsonb_build_object(
                        'description', it.name_generic || coalesce(' ' || it.strength, ''), 'quantity', x.quantity,
                        'unitPrice', x.unit_price, 'fullAmount', x.line_total, 'amount', x.line_total)
                      order by x.created_at)
                      from counter_sale_line x join item it on it.id = x.item_id
                      where x.sale_id = cs.id and x.deleted_at is null), '[]'::jsonb)
          end,
        'subtotal', coalesce(i.total, cs.total, 0),
        'total', coalesce(i.patient_share, cs.total, 0),
        'insurerAmount', coalesce(i.insurer_share, 0),
        'insurerPct', pl.coverage_pct,
        -- what was paid on the bill up to this payment, and what was still due after it
        'paid', paid.amount,
        'balance', coalesce(i.patient_share, cs.total, 0) - paid.amount
      ) as j
    from payment pa
    left join invoice i on i.id = pa.invoice_id
    left join encounter e on e.id = i.encounter_id
    left join patient p on p.id = e.patient_id
    left join payer py on py.id = i.payer_id and py.type <> 'cash'
    left join coverage cv on cv.id = i.coverage_id
    left join plan pl on pl.id = cv.plan_id
    left join counter_sale cs on cs.id = pa.counter_sale_id
    left join profiles pr on pr.id = pa.cashier_id
    cross join lateral (
      select coalesce(sum(p2.amount), 0) as amount from payment p2
      where p2.deleted_at is null
        and ((pa.invoice_id is not null and p2.invoice_id = pa.invoice_id)
             or (pa.counter_sale_id is not null and p2.counter_sale_id = pa.counter_sale_id))
        and (p2.paid_at < pa.paid_at or (p2.paid_at = pa.paid_at and p2.id <= pa.id))
    ) paid
    where pa.deleted_at is null
      and (pa.paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
      and (v_cashier is null or pa.cashier_id = v_cashier)
      and (p_method is null or pa.method::text = p_method)
    order by pa.paid_at, pa.id
    limit 2000
  ) r;

  select coalesce(jsonb_agg(jsonb_build_object('method', m.method, 'count', m.n, 'amount', m.amount) order by m.amount desc), '[]'::jsonb)
  into v_by_method
  from (select pa.method::text as method, count(*) as n, sum(pa.amount) as amount
        from payment pa
        where pa.deleted_at is null
          and (pa.paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
          and (v_cashier is null or pa.cashier_id = v_cashier)
          and (p_method is null or pa.method::text = p_method)
        group by pa.method) m;

  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'count', c.n, 'amount', c.amount) order by c.amount desc), '[]'::jsonb)
  into v_by_cashier
  from (select pa.cashier_id as id, coalesce(pr.full_name, '—') as name, count(*) as n, sum(pa.amount) as amount
        from payment pa left join profiles pr on pr.id = pa.cashier_id
        where pa.deleted_at is null
          and (pa.paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
          and (v_cashier is null or pa.cashier_id = v_cashier)
          and (p_method is null or pa.method::text = p_method)
        group by pa.cashier_id, pr.full_name) c;

  -- the cashiers of the period (for the filter), before the cashier filter is applied
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name), '[]'::jsonb)
  into v_cashiers
  from (select distinct pa.cashier_id as id, pr.full_name as name
        from payment pa join profiles pr on pr.id = pa.cashier_id
        where pa.deleted_at is null
          and (pa.paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
          and (v_all or pa.cashier_id = v_me)) c;

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'scope', case when v_all then 'desk' else 'mine' end,
    'count', jsonb_array_length(v_rows),
    'total', (select coalesce(sum((x ->> 'amount')::numeric), 0) from jsonb_array_elements(v_rows) x),
    'byMethod', v_by_method,
    'byCashier', v_by_cashier,
    'cashiers', v_cashiers,
    'receipts', v_rows);
end
$$;
revoke all on function receipts_in_period(date, date, uuid, text) from public, anon;
grant execute on function receipts_in_period(date, date, uuid, text) to authenticated;

-- ---------------------------------------------------------------- B patients' documents
-- The visits of a period with the page's filters. The manager: the whole clinic or one
-- department; a head or assistant of a department: that department (analytics_scope refuses
-- everyone else). The options list what the period holds, before the other filters.
create or replace function visits_in_period(
  p_from date default null,
  p_to date default null,
  p_department uuid default null,
  p_doctor uuid default null,
  p_service text default null,
  p_insurer uuid default null,
  p_closed_only boolean default false,
  p_search text default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  s record;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_q text := nullif(trim(coalesce(p_search, '')), '');
  v_result jsonb;
  v_rows jsonb;
  v_options jsonb;
begin
  select * into s from analytics_scope(p_department);
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;

  with base as (
  select e.id, e.reference, e.arrived_at, e.closed_at, e.status::text as status, e.service,
         p.id as patient_id, p.surname || ' ' || p.given_names as patient, p.file_number,
         d.id as department_id, d.name as department,
         doc.id as doctor_id, doc.full_name as doctor,
         c.text as diagnosis, c.icd10_code as icd10,
         ins.id as insurer_id, ins.name as insurer
  from encounter e
  join patient p on p.id = e.patient_id
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
    select c1.text, c1.icd10_code from condition c1
    where c1.encounter_id = e.id and c1.deleted_at is null
    order by (c1.type = 'primary') desc, c1.created_at limit 1
  ) c on true
  left join lateral (
    select py.id, py.name from coverage cv
    join payer py on py.id = cv.payer_id and py.type <> 'cash'
    where cv.id = coalesce((select i.coverage_id from invoice i where i.encounter_id = e.id and i.deleted_at is null limit 1),
                           e.coverage_id)
  ) ins on true
  where e.deleted_at is null
    and (e.arrived_at at time zone 'Africa/Kigali')::date between v_from and v_to
    and (s.s_department is null or exists (
      select 1 from queue_entry q where q.encounter_id = e.id and q.deleted_at is null
        and (q.department_id = s.s_department or q.station = any (s.s_stations))))
  )
  select jsonb_build_object(
    'options', jsonb_build_object(
      'departments', coalesce((select jsonb_agg(jsonb_build_object('id', x.department_id, 'name', x.department) order by x.department)
                               from (select distinct department_id, department from base where department_id is not null) x), '[]'::jsonb),
      'doctors', coalesce((select jsonb_agg(jsonb_build_object('id', x.doctor_id, 'name', x.doctor) order by x.doctor)
                           from (select distinct doctor_id, doctor from base where doctor_id is not null) x), '[]'::jsonb),
      'services', coalesce((select jsonb_agg(x.service order by x.service)
                            from (select distinct service from base where service is not null) x), '[]'::jsonb),
      'insurers', coalesce((select jsonb_agg(jsonb_build_object('id', x.insurer_id, 'name', x.insurer) order by x.insurer)
                            from (select distinct insurer_id, insurer from base where insurer_id is not null) x), '[]'::jsonb)),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', b.id, 'reference', b.reference, 'at', b.arrived_at, 'closedAt', b.closed_at, 'status', b.status,
        'service', b.service,
        'patient', jsonb_build_object('id', b.patient_id, 'name', b.patient, 'fileNumber', b.file_number),
        'doctor', case when b.doctor_id is null then null else jsonb_build_object('id', b.doctor_id, 'name', b.doctor) end,
        'department', case when b.department_id is null then null else jsonb_build_object('id', b.department_id, 'name', b.department) end,
        'diagnosis', b.diagnosis, 'icd10', b.icd10,
        'insurer', b.insurer
      ) order by b.arrived_at, b.id)
      from (select * from base b
            where (p_doctor is null or b.doctor_id = p_doctor)
              and (p_service is null or b.service = p_service)
              and (p_insurer is null or b.insurer_id = p_insurer)
              and (not p_closed_only or b.status = 'closed')
              and (v_q is null or b.patient ilike '%' || v_q || '%' or b.file_number ilike '%' || v_q || '%'
                   or coalesce(b.reference, '') ilike '%' || v_q || '%' or coalesce(b.diagnosis, '') ilike '%' || v_q || '%')
            order by b.arrived_at, b.id
            limit 2000) b), '[]'::jsonb))
  into v_result;
  v_options := v_result -> 'options';
  v_rows := v_result -> 'rows';

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'manager', s.s_manager,
    'department', s.s_department,
    'count', jsonb_array_length(v_rows),
    'closed', (select count(*) from jsonb_array_elements(v_rows) x where x ->> 'status' = 'closed'),
    'open', (select count(*) from jsonb_array_elements(v_rows) x where x ->> 'status' = 'open'),
    'options', v_options,
    'visits', v_rows);
end
$$;
revoke all on function visits_in_period(date, date, uuid, uuid, text, uuid, boolean, text) from public, anon;
grant execute on function visits_in_period(date, date, uuid, uuid, text, uuid, boolean, text) to authenticated;

-- What the medical report of each visit needs, at most 300 visits at a time. Each visit is read
-- with visit_clinical(): the record the reader is allowed to see, and the opening of a closed
-- visit logged the way a single opening is (0088). A visit the reader may not see comes back
-- private (its lists empty), as on the visit screen; the page says how many were left out.
create or replace function visit_documents(p_encounter_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_out jsonb := '[]'::jsonb;
  v_c jsonb;
  v_private boolean;
  v_n integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not clinical_reader() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  foreach v_id in array coalesce(p_encounter_ids, '{}'::uuid[]) loop
    v_n := v_n + 1;
    exit when v_n > 300;
    v_c := visit_clinical(v_id);
    if v_c is null then
      continue;
    end if;
    v_private := coalesce((v_c ->> 'private')::boolean, false);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_id,
      'clinical', v_c,
      'private', v_private,
      'patient', (select jsonb_build_object('id', p.id, 'name', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number)
                  from encounter e join patient p on p.id = e.patient_id where e.id = v_id),
      'vitals', case when v_private then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('code', v.code, 'label', v.label, 'value', v.value_num, 'text', v.value_text,
                                            'unit', v.unit, 'at', v.effective_at, 'by', v.by) order by v.effective_at)
        from (select distinct on (o.code) o.code, o.label, o.value_num, o.value_text, o.unit, o.effective_at, pr.full_name as by
              from observation o left join profiles pr on pr.id = o.performer_id
              where o.encounter_id = v_id and o.deleted_at is null and o.code <> 'note'
              order by o.code, o.effective_at desc) v), '[]'::jsonb) end,
      'charges', case when v_private then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('description', l.description, 'quantity', l.quantity) order by l.created_at)
        from invoice i join invoice_line l on l.invoice_id = i.id
        where i.encounter_id = v_id and i.deleted_at is null and l.deleted_at is null), '[]'::jsonb) end));
  end loop;
  return v_out;
end
$$;
revoke all on function visit_documents(uuid[]) from public, anon;
grant execute on function visit_documents(uuid[]) to authenticated;

-- ---------------------------------------------------------------- C analytics per dashboard
-- The figures of the desk dashboards' analytics: the signed-in person's own work (their own
-- records, no money, HIV tests without the patient), and the desk's registrations, visits,
-- arrivals by hour, bookings and tasks. Any active employee, for their own dashboard.
create or replace function desk_analytics(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_me uuid := auth.uid();
  v_start timestamptz;
  v_end timestamptz;
  v_result jsonb;
begin
  if v_me is null or not exists (select 1 from profiles where id = v_me and active) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  v_start := (v_from::timestamp) at time zone 'Africa/Kigali';
  v_end := ((v_to + 1)::timestamp) at time zone 'Africa/Kigali';

  with ev as (
    select x.at, x.kind, x.encounter_id, case when x.kind = 'hivTests' then null else x.patient_id end as patient_id, x.what
    from analytics_staff_events(v_start, v_end, false) x
    where x.user_id = v_me
  )
  select jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'counts', coalesce((select jsonb_object_agg(k.kind, k.n) from (select kind, count(*) as n from ev group by kind) k), '{}'::jsonb),
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'kind', d.kind, 'n', d.n) order by d.day, d.kind)
                      from (select (at at time zone 'Africa/Kigali')::date as day, kind, count(*) as n
                            from ev group by 1, 2) d), '[]'::jsonb),
    'records', coalesce((select jsonb_agg(jsonb_build_object(
                           'at', x.at, 'kind', x.kind, 'encounterId', x.encounter_id,
                           'patientName', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number, 'what', x.what)
                         order by x.at desc)
                         from (select * from ev order by at desc limit 500) x
                         left join patient p on p.id = x.patient_id), '[]'::jsonb),
    'registrations', coalesce((select jsonb_agg(jsonb_build_object('day', r.day, 'n', r.n) order by r.day)
                               from (select (x.created_at at time zone 'Africa/Kigali')::date as day, count(*) as n
                                     from patient x where x.deleted_at is null and x.created_at >= v_start and x.created_at < v_end
                                     group by 1) r), '[]'::jsonb),
    'visits', coalesce((select jsonb_agg(jsonb_build_object('day', r.day, 'n', r.n) order by r.day)
                        from (select (e.arrived_at at time zone 'Africa/Kigali')::date as day, count(*) as n
                              from encounter e where e.deleted_at is null and e.arrived_at >= v_start and e.arrived_at < v_end
                              group by 1) r), '[]'::jsonb),
    'arrivals', coalesce((select jsonb_agg(jsonb_build_object('hour', h.h, 'count', h.n) order by h.h)
                          from (select extract(hour from e.arrived_at at time zone 'Africa/Kigali')::int as h, count(*) as n
                                from encounter e where e.deleted_at is null and e.arrived_at >= v_start and e.arrived_at < v_end
                                group by 1) h), '[]'::jsonb),
    'bookings', (with ap as (
                   select a.status::text as status, (coalesce(a.starts_at, a.created_at) at time zone 'Africa/Kigali')::date as day
                   from appointment a
                   where a.deleted_at is null and coalesce(a.starts_at, a.created_at) >= v_start and coalesce(a.starts_at, a.created_at) < v_end)
                 select jsonb_build_object(
                   'booked', (select count(*) from ap where status in ('confirmed', 'arrived', 'in_progress', 'completed', 'no_show')),
                   'kept', (select count(*) from ap where status in ('arrived', 'in_progress', 'completed')),
                   'missed', (select count(*) from ap where status = 'no_show'),
                   'pending', (select count(*) from ap where status = 'inquiry'),
                   'cancelled', (select count(*) from ap where status in ('cancelled', 'declined', 'rejected')),
                   'byDay', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'booked', d.booked, 'kept', d.kept, 'missed', d.missed) order by d.day)
                                      from (select day,
                                                   count(*) filter (where status in ('confirmed', 'arrived', 'in_progress', 'completed', 'no_show')) as booked,
                                                   count(*) filter (where status in ('arrived', 'in_progress', 'completed')) as kept,
                                                   count(*) filter (where status = 'no_show') as missed
                                            from ap group by day) d), '[]'::jsonb))),
    'tasks', (select jsonb_build_object(
                'open', count(*) filter (where k.done_at is null),
                'overdue', count(*) filter (where k.done_at is null and k.due_at is not null and k.due_at < now()),
                'done', count(*) filter (where k.done_at is not null and k.done_at >= v_start and k.done_at < v_end),
                'doneByMe', count(*) filter (where k.done_by = v_me and k.done_at >= v_start and k.done_at < v_end))
              from internal_task k
              where k.deleted_at is null
                and (k.assigned_to = v_me or k.created_by = v_me or k.done_by = v_me
                     or (k.assigned_to is null and k.assigned_role is not null and task_for_me(k.assigned_role)))))
  into v_result;
  return v_result;
end
$$;
revoke all on function desk_analytics(date, date) from public, anon;
grant execute on function desk_analytics(date, date) to authenticated;

-- What the signed-in person may open on the Analytics page. "views" stays what it was (the
-- manager's views, a head's views of their department; nobody else's), so the links and the
-- checks of 0086 keep working. "dashboard" names the dashboard the person has and
-- "dashboardViews" lists that dashboard's views in the dashboard's order: the Analytics page
-- takes its structure from them. The desk views read desk_analytics() and the desk summaries,
-- which check their own rights; money and other people's work stay with the manager.
create or replace function analytics_access()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := is_manager();
  v_deps jsonb;
  v_desks text[];
  v_views text[] := '{}';
  v_dash text;
  v_dash_views text[] := '{}';
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_manager then
    select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'desks', to_jsonb(coalesce(d.services, '{}')))
                              order by d.sort_order, d.name), '[]'::jsonb)
    into v_deps
    from department d where d.deleted_at is null and d.active;
    v_views := array['revenue', 'staff', 'visits', 'treatments', 'lab', 'pharmacy', 'triage', 'stock', 'waiting', 'receipts', 'documents'];
    v_dash := 'manager';
    -- the manager dashboard's order: patients, waiting, money, people, treatments, stock, the desks, documents
    v_dash_views := array['visits', 'waiting', 'revenue', 'receipts', 'staff', 'treatments', 'stock', 'lab', 'pharmacy', 'triage', 'documents'];
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
      v_dash := 'head';
      -- the department section's order: patients, waiting, orders (the lab), people, services
      v_dash_views := array['visits', 'waiting']
        || case when v_desks && array['laboratory', 'ultrasound'] then array['lab'] else '{}'::text[] end
        || array['staff', 'treatments']
        || case when 'pharmacy' = any (v_desks) then array['pharmacy', 'stock'] else '{}'::text[] end
        || case when 'triage' = any (v_desks) then array['triage'] else '{}'::text[] end
        || array['documents'];
    else
      select p.role::text into v_role from profiles p where p.id = auth.uid() and p.active;
      v_dash := case v_role
        when 'cashier' then 'cashier'
        when 'pharmacist' then 'pharmacy'
        when 'lab_tech' then 'lab'
        when 'sonographer' then 'lab'
        when 'doctor' then 'doctor'
        when 'nurse' then 'nurse'
        when 'receptionist' then 'reception'
        else null
      end;
      v_dash_views := case v_dash
        when 'cashier' then array['collections', 'receipts', 'methods', 'openBills', 'refunds']
        when 'pharmacy' then array['handovers', 'walkIn', 'stock', 'expiry', 'outside']
        when 'lab' then array['tests', 'turnaround', 'verification', 'byTest']
        when 'doctor' then array['myPatients', 'waitingNow', 'diagnoses', 'prescriptions', 'orders', 'tasks']
        when 'nurse' then array['myPatients', 'vitals', 'waitingNow', 'tasks']
        when 'reception' then array['registrations', 'bookings', 'waitingNow', 'arrivals']
        else '{}'::text[]
      end;
    end if;
  end if;
  return jsonb_build_object(
    'manager', v_manager,
    'departments', v_deps,
    'views', to_jsonb(v_views),
    'dashboard', v_dash,
    'dashboardViews', to_jsonb(v_dash_views));
end
$$;
revoke all on function analytics_access() from public, anon;
grant execute on function analytics_access() to authenticated;
