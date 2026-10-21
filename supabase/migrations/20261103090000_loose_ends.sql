-- 0061 · Loose ends (dashboard audit, wave 4).
-- Heads of department see the dashboard without the clinic's money (the revenue series, the
-- collections and the receivables were sent to them). Nursing tasks of a finished visit leave
-- the lists. Someone given a task on a visit (the nurse) may work on that visit while the task is
-- open. When a visit ends, its bed stay ends too (the bed goes to cleaning).


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
    'avgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date = v_today)), 0)
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
  select coalesce(jsonb_agg(jsonb_build_object('group', g.grp, 'name', g.name, 'nameKin', g.kin, 'nameFr', g.fr,
                                                'count', g.n) order by g.n desc), '[]'::jsonb) into v_visits
  from (
    -- by the clinic's own categories; medicines (no service) count as pharmacy
    select coalesce(c.base_group::text, case when s.id is null then 'pharmacy' else 'other' end) as grp,
           c.name_en as name, c.name_kin as kin, c.name_fr as fr, count(distinct i.encounter_id) as n
    from invoice_line l
    join invoice i on i.id = l.invoice_id
    left join service s on s.id = l.service_id
    left join service_category c on c.id = s.category_id
    where l.deleted_at is null and (l.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
    group by c.id, 1, 2, 3, 4
  ) g;

  -- waiting time and queue by station (today)
  select coalesce(jsonb_agg(jsonb_build_object('station', w.station, 'minutes', w.minutes, 'waiting', w.waiting, 'longest', w.longest) order by w.station), '[]'::jsonb) into v_wait
  from (
    select q.station::text as station,
           round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date = v_today)) as minutes,
           count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open') as waiting,
           round(max(extract(epoch from now() - q.created_at) / 60) filter (where q.finished_at is null and q.started_at is null and e.status = 'open')) as longest
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
    -- money for the manager only (heads of department see the activity, not the money)
    'tiles', v_tiles,
    'revenue30d', case when v_manager then v_rev30 else '[]'::jsonb end,
    'collections', case when v_manager then v_collections else '[]'::jsonb end,
    'receivables', case when v_manager then v_receivables end,
    'visitsByGroup', v_visits, 'waitByStation', v_wait, 'topTreatments', v_top, 'staff', v_staff,
    'reorder', v_reorder, 'expiring', v_expiring, 'bookings', v_noshow, 'messages', v_messages,
    'claims', v_claims, 'logins', v_logins, 'services', v_services
  );
end
$$;

create or replace function open_tasks()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', k.id, 'title', k.title, 'detail', k.detail, 'dueAt', k.due_at,
      'overdue', k.due_at is not null and k.due_at < now(),
      'encounterId', k.encounter_id,
      'patient', p.surname || ' ' || p.given_names,
      'by', pr.full_name
    ) order by k.due_at nulls last, k.created_at), '[]'::jsonb)
  from internal_task k
  left join patient p on p.id = k.patient_id
  -- a finished visit's task is over too
  left join encounter e on e.id = k.encounter_id
  left join profiles pr on pr.id = k.created_by
  where k.deleted_at is null and k.done_at is null and (k.encounter_id is null or e.status = 'open')
    and (k.assigned_to = auth.uid() or k.assigned_role = current_role_key() or is_manager())
$$;

create or replace function may_work_on(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select is_manager()
    or exists (select 1 from queue_entry q
               where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
                 and queue_entry_for_me(q.id))
    -- a task on this visit for me or my role (the doctor asked the nurse for an injection…)
    or exists (select 1 from internal_task k
               where k.encounter_id = p_encounter_id and k.done_at is null and k.deleted_at is null
                 and (k.assigned_to = auth.uid() or k.assigned_role = current_role_key()))
    -- a colleague who accepted to help on this patient
    or exists (select 1 from staff_call c
               where c.encounter_id = p_encounter_id and c.kind = 'help' and c.status = 'accepted'
                 and c.answered_by = auth.uid())
    -- nobody holds the patient at a treating desk (e.g. now at the cashier): whoever treated
    -- them in this visit may still complete the record
    or (not exists (select 1 from queue_entry q
                    where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
                      and station_role(q.station) in ('doctor', 'nurse', 'lab_tech', 'sonographer'))
        and exists (select 1 from queue_entry q
                    where q.encounter_id = p_encounter_id and q.deleted_at is null
                      and (q.taken_by = auth.uid() or q.assigned_to = auth.uid())))
$$;


-- A visit that ends ends its bed stay: the bed goes to cleaning (it stayed "occupied" before).
create or replace function bed_follows_visit()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'closed' and old.status is distinct from 'closed' then
    with ended as (
      update bed_stay set discharged_at = now()
      where encounter_id = new.id and discharged_at is null and deleted_at is null
      returning bed_id
    )
    update bed set status = 'cleaning' where id in (select bed_id from ended);
  end if;
  return new;
end
$$;
drop trigger if exists encounter_bed_done on encounter;
create trigger encounter_bed_done after update of status on encounter
  for each row execute function bed_follows_visit();
-- beds still held by visits that are already over
with ended as (
  update bed_stay s set discharged_at = now()
  from encounter e
  where e.id = s.encounter_id and e.status = 'closed' and s.discharged_at is null and s.deleted_at is null
  returning s.bed_id
)
update bed set status = 'cleaning' where id in (select bed_id from ended);
revoke all on function bed_follows_visit() from public, anon, authenticated;

