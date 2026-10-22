-- 0068 · Bookings and calendars by role.
-- Booking requests are reception's work (the scheduling desk): reception books the time, the
-- doctor whose calendar it is accepts it, and may move it to arrange the day by priority. The
-- manager oversees (sees every booking and request) but no longer books or answers requests.
-- A request does not hold its time: several people may ask for the same time, and reception and
-- the doctor arrange them; only a booking reception has made (and the doctor's own) is busy.
-- Calendars on the dashboards follow the role: everyone sees their own; doctors and sonographers
-- also the colleagues of their departments; the desks that book (reception, nurses) and the
-- manager every calendar shared with the staff.

-- the manager no longer books or answers requests (Who may do what does not list the manager)
delete from role_permissions where role = 'manager' and permission = 'appointment.approve';

-- a request is not a booking: it does not make the time busy
create or replace view public_booked_slots as
  select practitioner_id, starts_at, ends_at
  from appointment
  where deleted_at is null and practitioner_id is not null and starts_at is not null
    and status in ('approved', 'confirmed', 'arrived', 'in_progress');

-- The doctor accepts a booking on their own calendar, at the time reception gave or at another
-- time the doctor chooses (to arrange the day by priority). Reception is told (the trigger).
drop function if exists accept_appointment(uuid);
create or replace function accept_appointment(p_appointment_id uuid, p_starts_at timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_a appointment%rowtype;
  v_slot integer;
  v_at timestamptz;
begin
  if not has_perm('appointment.accept') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_a from appointment where id = p_appointment_id and deleted_at is null for update;
  if not found or v_a.status <> 'approved' then
    raise exception 'appointment not found or not waiting for the doctor' using errcode = 'P0002';
  end if;
  if not exists (select 1 from practitioner where id = v_a.practitioner_id and user_id = auth.uid()) then
    raise exception 'only the doctor of this calendar accepts the booking' using errcode = '42501';
  end if;
  v_at := coalesce(p_starts_at, v_a.starts_at);
  if v_at < now() then
    raise exception 'the chosen time is in the past' using errcode = '22023';
  end if;
  select slot_minutes into v_slot from practitioner where id = v_a.practitioner_id;
  if v_at is distinct from v_a.starts_at and exists (
       select 1 from appointment b
       where b.practitioner_id = v_a.practitioner_id and b.id <> v_a.id and b.deleted_at is null
         and b.status in ('approved', 'confirmed', 'arrived', 'in_progress')
         and b.starts_at < v_at + make_interval(mins => coalesce(v_slot, 30))
         and coalesce(b.ends_at, b.starts_at + interval '30 minutes') > v_at) then
    raise exception 'you already have a booking at that time' using errcode = '23505';
  end if;
  update appointment
  set status = 'confirmed', accepted_by = auth.uid(), accepted_at = now(),
      starts_at = v_at, ends_at = v_at + make_interval(mins => coalesce(v_slot, 30))
  where id = p_appointment_id;
  return jsonb_build_object('startsAt', v_at, 'moved', v_at is distinct from v_a.starts_at);
end
$$;
revoke all on function accept_appointment(uuid, timestamptz) from public, anon;
grant execute on function accept_appointment(uuid, timestamptz) to authenticated;

-- Calendars on the dashboards, by role (see above).
create or replace function staff_doctor_calendars()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(calendar_json(pr) order by (pr.user_id = auth.uid()) desc, pr.names), '[]'::jsonb)
  from practitioner pr
  join profiles p on p.id = pr.user_id and p.active
  where auth.uid() is not null and pr.active and pr.deleted_at is null
    and (
      pr.user_id = auth.uid()
      or (pr.calendar_visibility in ('staff', 'public') and (
            is_manager()
            or current_role_key() not in ('doctor', 'sonographer')
            -- a doctor or sonographer: the colleagues of their departments
            or exists (select 1 from staff_department mine
                        join staff_department theirs on theirs.department_id = mine.department_id
                        where mine.profile_id = auth.uid() and theirs.profile_id = pr.user_id)))
    )
$$;

create or replace function notify_appointment()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_doctor uuid;
  v_doctor_name text;
begin
  v_name := coalesce((select p.surname || ' ' || p.given_names from patient p where p.id = new.patient_id), new.contact_name);
  select user_id, names into v_doctor, v_doctor_name from practitioner where id = new.practitioner_id;
  if tg_op = 'INSERT' and new.status = 'inquiry' then
    insert into notification (kind, params, link, recipient_role, created_by)
    values ('inquiry', jsonb_build_object('name', v_name, 'when', coalesce(new.starts_at, new.preferred_at), 'appointment', new.id),
            '/app/appointments', 'receptionist', auth.uid());
    if v_doctor is not null then
      insert into notification (kind, params, link, recipient_user, created_by)
      values ('inquiry', jsonb_build_object('name', v_name, 'when', new.starts_at, 'appointment', new.id, 'forDoctor', true),
              '/app', v_doctor, auth.uid());
    end if;
    return new;
  end if;
  -- The request was handled (booked, rejected, cancelled): its notice is no longer needed.
  if tg_op = 'UPDATE' and old.status = 'inquiry' and new.status <> 'inquiry' then
    delete from notification where kind = 'inquiry' and params ->> 'appointment' = new.id::text;
  end if;
  if tg_op = 'UPDATE' and new.status = 'approved' and old.status is distinct from 'approved' then
    if v_doctor is not null then
      insert into notification (kind, params, link, recipient_user, created_by)
      values ('to_accept', jsonb_build_object('name', v_name, 'when', new.starts_at, 'appointment', new.id), '/app', v_doctor, auth.uid());
    end if;
  elsif tg_op = 'UPDATE' and new.status in ('confirmed', 'declined') and old.status = 'approved' then
    -- The doctor answered: the "to accept" notice goes away.
    delete from notification where kind = 'to_accept' and params ->> 'appointment' = new.id::text;
    if new.status = 'confirmed' then
      insert into notification (kind, params, link, recipient_role, created_by)
      values ('appt_confirmed', jsonb_build_object('name', v_name, 'when', new.starts_at, 'doctor', v_doctor_name),
              '/app/appointments', 'receptionist', auth.uid());
    else
      insert into notification (kind, params, link, recipient_role, urgent, created_by)
      values ('appt_declined', jsonb_build_object('name', v_name, 'when', new.starts_at, 'doctor', v_doctor_name, 'reason', new.cancel_reason),
              '/app/appointments?day=' || to_char(new.starts_at at time zone 'Africa/Kigali', 'YYYY-MM-DD'),
              'receptionist', true, auth.uid());
    end if;
  end if;
  return new;
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
    'avgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date = v_today)), 0)
                   from queue_entry q where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'revenue', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to) end,
    'revenuePrev', case when v_manager then (select coalesce(sum(amount), 0) from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_prev_from and v_prev_to) end,
    'openBills', case when v_manager then (select count(*) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'openBillsDue', case when v_manager then (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0) end,
    'debts', case when v_manager then (select count(*) from invoice i join encounter e on e.id = i.encounter_id
                                       where i.deleted_at is null and e.status <> 'open' and invoice_balance(i.id) > 0) end,
    'debtsDue', case when v_manager then (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id
                                          where i.deleted_at is null and e.status <> 'open' and invoice_balance(i.id) > 0) end,
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
      'patients', coalesce(sn.n, 0), 'results', coalesce(rs.n, 0), 'dispensed', coalesce(ds.n, 0),
      'payments', case when v_manager then coalesce(pm.n, 0) end,
      'collected', case when v_manager then coalesce(pm.amount, 0) end,
      'lastSignIn', p.last_sign_in_at
    ) order by (coalesce(r.n, 0) + coalesce(v.n, 0) + coalesce(c.n, 0) + coalesce(pm.n, 0)
                + coalesce(sn.n, 0) + coalesce(rs.n, 0) + coalesce(ds.n, 0)) desc, p.full_name), '[]'::jsonb) into v_staff
  from profiles p
  left join (select created_by as id, count(*) as n from patient where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) r on r.id = p.id
  left join (select performer_id as id, count(distinct encounter_id) as n from observation where deleted_at is null and code <> 'note' and (effective_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) v on v.id = p.id
  left join (select entered_by as id, count(*) as n from invoice_line where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) c on c.id = p.id
  left join (select cashier_id as id, count(*) as n, sum(amount) as amount from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) pm on pm.id = p.id
  left join (select taken_by as id, count(distinct encounter_id) as n from queue_entry
             where deleted_at is null and taken_by is not null
               and (coalesce(finished_at, started_at) at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) sn on sn.id = p.id
  left join (select coalesce(verified_by, created_by) as id, count(*) as n from diagnostic_report
             where deleted_at is null and (coalesce(verified_at, created_at) at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) rs on rs.id = p.id
  left join (select dispenser_id as id, count(*) as n from medication_dispense
             where deleted_at is null and (created_at at time zone 'Africa/Kigali')::date between p_from and p_to group by 1) ds on ds.id = p.id
  where p.active;

  -- stock
  select coalesce(jsonb_agg(jsonb_build_object('name', name_generic, 'onHand', on_hand, 'min', reorder_level) order by (on_hand::numeric / greatest(reorder_level, 1))), '[]'::jsonb) into v_reorder
  from items_below_reorder;

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
    'receivables', case when v_manager then v_receivables else '[]'::jsonb end,
    'visitsByGroup', v_visits, 'waitByStation', v_wait, 'topTreatments', v_top, 'staff', v_staff,
    'reorder', v_reorder, 'expiring', v_expiring, 'bookings', v_noshow, 'messages', v_messages,
    'claims', v_claims, 'logins', v_logins, 'services', v_services
  );
end
$$;

create or replace function home_summary()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_role role_key := current_role_key();
  v_practitioner uuid := (select id from practitioner where user_id = auth.uid() and active limit 1);
  v_today date := (now() at time zone 'Africa/Kigali')::date;
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
    and (a.starts_at at time zone 'Africa/Kigali')::date = v_today;

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
  from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date = v_today;

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
                    and (q.finished_at at time zone 'Africa/Kigali')::date = v_today),
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
