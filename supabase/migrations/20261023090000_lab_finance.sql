-- 0036 — Laboratory and finance dashboards.
-- Laboratory: the worklist of tests ordered (lab for lab technicians, imaging for sonographers,
-- both for the manager), sample taken / in process, the day's figures.
-- Finance: what the cashier collected (by method, by person), the payments of a day, open bills.

-- Which test categories this person works on.
create or replace function my_test_categories()
returns request_category[]
language sql stable security definer set search_path = public
as $$
  select case current_role_key()
    when 'lab_tech' then array['lab']::request_category[]
    when 'sonographer' then array['imaging']::request_category[]
    else array['lab', 'imaging']::request_category[]
  end
$$;

-- p_scope: 'open' (not verified, not cancelled) or 'done' (resulted or verified today).
create or replace function lab_worklist(p_scope text default 'open')
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.prio, x.at), '[]'::jsonb)
  from (
    select r.priority as prio, r.created_at as at, jsonb_build_object(
      'id', r.id, 'encounterId', r.encounter_id, 'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'sex', p.sex, 'birthDate', p.birth_date,
      'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = r.encounter_id order by q.created_at limit 1),
      'triage', e.triage_level,
      'test', s.name_en, 'category', r.category, 'status', r.status, 'priority', r.priority,
      'reason', r.reason, 'orderedAt', r.created_at,
      'orderedBy', (select full_name from profiles where id = r.requester_id),
      'findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
      'resultAt', coalesce(d.verified_at, d.updated_at),
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by))
    ) as j
    from service_request r
    join encounter e on e.id = r.encounter_id
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and has_perm('orders.read')
      and r.category = any (my_test_categories())
      and case when p_scope = 'done'
            then r.status in ('resulted', 'verified')
                 and (coalesce(d.verified_at, d.updated_at) at time zone 'Africa/Kigali')::date
                     = (now() at time zone 'Africa/Kigali')::date
            else r.status not in ('verified', 'cancelled') end
  ) x
$$;

-- Sample taken / in process (or cancelled with a reason).
create or replace function set_request_status(p_id uuid, p_status request_status, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('orders.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_status not in ('collected', 'in_process', 'cancelled') then
    raise exception 'use record_result for results' using errcode = '22023';
  end if;
  if p_status = 'cancelled' and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'a reason is required to cancel a test' using errcode = '22023';
  end if;
  update service_request
  set status = p_status,
      reason = case when p_status = 'cancelled' then coalesce(reason || ' · ', '') || 'cancelled: ' || trim(p_reason) else reason end
  where id = p_id and deleted_at is null and status not in ('verified', 'cancelled');
  if not found then
    raise exception 'test not found or already finished' using errcode = 'P0002';
  end if;
end
$$;

create or replace function lab_summary()
returns jsonb
language sql stable security definer set search_path = public
as $$
  with today as (select (now() at time zone 'Africa/Kigali')::date as d),
  mine as (
    select r.*, d.verified_at, d.updated_at as result_at
    from service_request r
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and r.category = any (my_test_categories()) and has_perm('orders.read')
  )
  select jsonb_build_object(
    'waiting', (select count(*) from mine where status = 'ordered'),
    'inProcess', (select count(*) from mine where status in ('collected', 'in_process')),
    'toVerify', (select count(*) from mine where status = 'resulted'),
    'doneToday', (select count(*) from mine, today
                  where status = 'verified' and (verified_at at time zone 'Africa/Kigali')::date = today.d),
    'urgent', (select count(*) from mine where status not in ('verified', 'cancelled') and priority <= 2),
    'orderedToday', (select count(*) from mine, today where (created_at at time zone 'Africa/Kigali')::date = today.d),
    'turnaroundMin', (select coalesce(round(avg(extract(epoch from verified_at - created_at) / 60)), 0)
                      from mine, today
                      where verified_at is not null and (verified_at at time zone 'Africa/Kigali')::date = today.d),
    'byTest', coalesce((
      select jsonb_agg(jsonb_build_object('test', t.name, 'count', t.n) order by t.n desc)
      from (select s.name_en as name, count(*) as n
            from mine m join service s on s.id = m.service_id, today
            where (m.created_at at time zone 'Africa/Kigali')::date = today.d
            group by s.name_en order by count(*) desc limit 8) t
    ), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------- finance
-- One day of money: totals by method, by cashier, the payments, open bills (p_day: Kigali date).
create or replace function cashier_summary(p_day date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_day date := coalesce(p_day, (now() at time zone 'Africa/Kigali')::date);
begin
  if not has_perm('billing.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'day', v_day,
    'total', (select coalesce(sum(amount), 0) from payment
              where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date = v_day),
    'count', (select count(*) from payment
              where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date = v_day),
    'previousTotal', (select coalesce(sum(amount), 0) from payment
                      where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date = v_day - 1),
    'mine', (select coalesce(sum(amount), 0) from payment
             where deleted_at is null and cashier_id = auth.uid()
               and (paid_at at time zone 'Africa/Kigali')::date = v_day),
    'byMethod', coalesce((
      select jsonb_agg(jsonb_build_object('method', m.method, 'amount', m.amount, 'count', m.n) order by m.amount desc)
      from (select method::text as method, sum(amount) as amount, count(*) as n from payment
            where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date = v_day
            group by method) m
    ), '[]'::jsonb),
    'byCashier', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.name, 'amount', c.amount, 'count', c.n) order by c.amount desc)
      from (select coalesce(pr.full_name, '—') as name, sum(pa.amount) as amount, count(*) as n
            from payment pa left join profiles pr on pr.id = pa.cashier_id
            where pa.deleted_at is null and (pa.paid_at at time zone 'Africa/Kigali')::date = v_day
            group by pr.full_name) c
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', pa.id, 'at', pa.paid_at, 'method', pa.method, 'amount', pa.amount, 'reference', pa.reference,
          'invoice', i.number, 'encounterId', i.encounter_id,
          'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
          'cashier', pr.full_name
        ) order by pa.paid_at desc)
      from payment pa
      join invoice i on i.id = pa.invoice_id
      join encounter e on e.id = i.encounter_id
      join patient p on p.id = e.patient_id
      left join profiles pr on pr.id = pa.cashier_id
      where pa.deleted_at is null and (pa.paid_at at time zone 'Africa/Kigali')::date = v_day
    ), '[]'::jsonb),
    'openBills', (select count(*) from invoice i join encounter e on e.id = i.encounter_id
                  where i.deleted_at is null and i.status = 'draft' and e.status = 'open' and invoice_balance(i.id) > 0),
    'openDue', (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id
                where i.deleted_at is null and i.status = 'draft' and e.status = 'open' and invoice_balance(i.id) > 0)
  );
end
$$;

grant execute on function my_test_categories(), lab_worklist(text), set_request_status(uuid, request_status, text),
  lab_summary(), cashier_summary(date) to authenticated;
revoke execute on function my_test_categories(), lab_worklist(text), set_request_status(uuid, request_status, text),
  lab_summary(), cashier_summary(date) from anon, public;
