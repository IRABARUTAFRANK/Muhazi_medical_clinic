-- 0065 · The manager, reception and doctor desks (dashboard audit, wave 8).

-- ---------------------------------------------------------------- a booked patient arrives
-- The arrival follows the clinic's flow: triage first when the setting says so, otherwise
-- straight to the booked doctor's desk, given to that doctor. A patient already in the clinic
-- keeps their visit (queued again if they were waiting nowhere). The booked doctor is told.
create or replace function appointment_arrived(p_appointment_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_appt appointment%rowtype;
  v_visit jsonb;
  v_enc uuid;
  v_doctor uuid;
  v_desk station;
  v_name text;
begin
  if not has_perm('appointment.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_appt from appointment where id = p_appointment_id and deleted_at is null for update;
  if not found or v_appt.status not in ('approved', 'confirmed') then
    raise exception 'this appointment is not waiting for the patient' using errcode = 'P0002';
  end if;
  if v_appt.patient_id is null then
    raise exception 'register the patient first, then mark the arrival' using errcode = 'P0002';
  end if;
  select user_id into v_doctor from practitioner where id = v_appt.practitioner_id;
  -- the booked doctor's desk (a dentist books at Dental)
  v_desk := case when exists (select 1 from profiles where id = v_doctor and lower(coalesce(station, '')) like '%dent%')
                 then 'dental'::station else 'consultation'::station end;

  select jsonb_build_object(
           'encounter_id', e.id,
           'ticket_no', (select q.ticket_no from queue_entry q where q.encounter_id = e.id order by q.created_at limit 1),
           'station', (select q.station from queue_entry q where q.encounter_id = e.id and q.finished_at is null
                       order by q.created_at desc limit 1),
           'existing', true)
  into v_visit
  from encounter e where e.patient_id = v_appt.patient_id and e.status = 'open' and e.deleted_at is null
  order by e.arrived_at desc limit 1;

  if v_visit is null then
    v_visit := start_visit(v_appt.patient_id, false, v_desk);
  end if;
  v_enc := (v_visit ->> 'encounter_id')::uuid;

  -- The visit belongs to the booking: the booked doctor has the patient, and the booking
  -- completes when the visit ends.
  update encounter
  set appointment_id = coalesce(appointment_id, v_appt.id),
      practitioner_id = coalesce(practitioner_id, v_appt.practitioner_id)
  where id = v_enc;

  -- already in the clinic but waiting nowhere: back in line (triage or the doctor's desk)
  if not exists (select 1 from queue_entry where encounter_id = v_enc and finished_at is null and deleted_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no)
    values (v_enc, case when triage_first() then 'triage'::station else v_desk end,
            (select ticket_no from queue_entry where encounter_id = v_enc order by created_at limit 1));
  end if;
  -- waiting at the doctor's desk, nobody has them yet: given to the booked doctor
  if v_doctor is not null then
    update queue_entry set assigned_to = v_doctor
    where encounter_id = v_enc and finished_at is null and deleted_at is null and taken_by is null
      and assigned_to is null and station in ('consultation', 'dental');
    select p.surname || ' ' || p.given_names into v_name from patient p where p.id = v_appt.patient_id;
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('booked_arrived',
            jsonb_build_object('name', v_name, 'when', v_appt.starts_at, 'triage', triage_first()),
            '/app/visit?encounter=' || v_enc, v_doctor, auth.uid());
  end if;

  update appointment set status = 'arrived' where id = p_appointment_id;
  return v_visit || jsonb_build_object('station',
    (select q.station from queue_entry q where q.encounter_id = v_enc and q.finished_at is null order by q.created_at desc limit 1));
end
$$;


-- ---------------------------------------------------------------- results seen by the doctor
-- The doctor who ordered a test marks its result as seen: "Results to review" counts only the
-- verified results not yet seen, and a result stays in the inbox until it is.
alter table diagnostic_report add column if not exists reviewed_at timestamptz;
alter table diagnostic_report add column if not exists reviewed_by uuid references profiles (id) on delete set null;

create or replace function mark_result_reviewed(p_report_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not (has_perm('clinical.write') or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update diagnostic_report set reviewed_at = now(), reviewed_by = auth.uid()
  where id = p_report_id and deleted_at is null and reviewed_at is null;
end
$$;

revoke all on function mark_result_reviewed(uuid) from public, anon;
grant execute on function mark_result_reviewed(uuid) to authenticated;

-- A phone written 07…, +250 7… or 2507… is the same number.
create or replace function phone_key(p_phone text)
returns text
language sql immutable
as $$
  select case
    when d ~ '^250[0-9]{9}$' then '0' || substr(d, 4)
    when d ~ '^[1-9][0-9]{8}$' then '0' || d
    else d end
  from (select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as d) x
$$;


-- ---------------------------------------------------------------- duplicate files merged
-- The manager merges a duplicate file into the one kept: its visits, bookings, documents,
-- vaccinations, tasks, messages and insurance move to the kept file; the old file number still
-- finds the patient (alias). Not while both files have a visit open.
drop function if exists merge_patients(uuid, uuid);
create or replace function merge_patients(p_keep uuid, p_merge uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_old_number text;
  v_table text;
  v_moved integer := 0;
  v_n integer;
begin
  if not is_manager() then
    raise exception 'only the manager can merge patient files' using errcode = '42501';
  end if;
  if p_keep is null or p_merge is null or p_keep = p_merge then
    raise exception 'choose two different files' using errcode = '22023';
  end if;
  if not exists (select 1 from patient where id = p_keep and deleted_at is null and merged_into is null) then
    raise exception 'the file to keep was not found' using errcode = 'P0002';
  end if;
  select file_number into v_old_number from patient where id = p_merge and deleted_at is null and merged_into is null;
  if not found then
    raise exception 'the duplicate file was not found or is already merged' using errcode = 'P0002';
  end if;
  if exists (select 1 from encounter where patient_id = p_keep and status = 'open')
     and exists (select 1 from encounter where patient_id = p_merge and status = 'open') then
    raise exception 'both files have a visit open: close one first' using errcode = '23514';
  end if;
  foreach v_table in array array['appointment', 'encounter', 'vaccination', 'fp_event', 'hiv_test',
                                  'document', 'message', 'internal_task', 'coverage'] loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = v_table and column_name = 'patient_id') then
      execute format('update %I set patient_id = $1 where patient_id = $2', v_table) using p_keep, p_merge;
      get diagnostics v_n = row_count;
      v_moved := v_moved + v_n;
    end if;
  end loop;
  update patient set guardian_patient_id = p_keep where guardian_patient_id = p_merge;
  update coverage set principal_patient_id = p_keep where principal_patient_id = p_merge;
  insert into patient_alias (file_number, patient_id) values (v_old_number, p_keep)
  on conflict (file_number) do update set patient_id = p_keep;
  update patient_alias set patient_id = p_keep where patient_id = p_merge;
  update patient set merged_into = p_keep, updated_at = now() where id = p_merge;
  insert into audit_event (actor_id, action, entity, entity_id, after, reason)
  values (auth.uid(), 'update', 'patient', p_keep,
          jsonb_build_object('merged', p_merge, 'fileNumber', v_old_number, 'moved', v_moved), 'files merged');
  return jsonb_build_object('moved', v_moved, 'oldNumber', v_old_number);
end
$$;

revoke all on function merge_patients(uuid, uuid) from public, anon;
grant execute on function merge_patients(uuid, uuid) to authenticated;


-- ---------------------------------------------------------------- who took each patient
-- The queue says who took the patient (their id, not only the name): a doctor's "Seen" counts
-- only the patients that doctor finished, not the whole desk's.
create or replace view queue_board with (security_invoker = true) as
  select q.id as queue_id, q.encounter_id, q.station, q.ticket_no, q.priority,
         q.created_at as queued_at, q.called_at, q.started_at, q.finished_at,
         e.patient_id, e.triage_level, e.arrived_at, e.type as encounter_type,
         p.file_number, p.surname, p.given_names, p.sex, p.birth_date, p.phone_1,
         q.pool_id, tb.full_name as taken_by_name,
         q.assigned_to, asg.full_name as assigned_name, rb.full_name as referred_by_name,
         q.referral_note, q.return_station,
         v.effective_at as vitals_at, v.measured_by as vitals_by,
         q.department_id, dep.name as department_name, queue_entry_for_me(q.id) as can_work,
         q.taken_by
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  join patient p on p.id = e.patient_id
  left join profiles tb on tb.id = q.taken_by
  left join profiles asg on asg.id = q.assigned_to
  left join profiles rb on rb.id = q.referred_by
  left join department dep on dep.id = q.department_id
  left join lateral last_vitals_stamp(q.encounter_id) v on true
  where q.deleted_at is null and e.status = 'open';


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
    'receivables', case when v_manager then v_receivables end,
    'visitsByGroup', v_visits, 'waitByStation', v_wait, 'topTreatments', v_top, 'staff', v_staff,
    'reorder', v_reorder, 'expiring', v_expiring, 'bookings', v_noshow, 'messages', v_messages,
    'claims', v_claims, 'logins', v_logins, 'services', v_services
  );
end
$$;

create or replace function end_visit(p_encounter_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_due numeric;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  select coalesce(sum(invoice_balance(i.id)), 0) into v_due from invoice i
  where i.encounter_id = p_encounter_id and i.status <> 'credited';
  if v_due > 0 then
    if current_role_key() <> 'manager' then
      raise exception 'money is still due (% RWF): take the payment first, or ask the manager', round(v_due)
        using errcode = '23514';
    end if;
    if nullif(trim(coalesce(p_reason, '')), '') is null then
      raise exception 'money is still due (% RWF): say why the patient left without paying', round(v_due)
        using errcode = '22023';
    end if;
  end if;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and finished_at is null;
  update encounter
  set status = 'closed', closed_at = now(), closed_by = auth.uid(),
      left_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = p_encounter_id;
  return jsonb_build_object('due', v_due);
end
$$;

create or replace function appointments_day(p_day date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id,
      'time', to_char(a.starts_at at time zone 'Africa/Kigali', 'HH24:MI'),
      'startsAt', a.starts_at,
      'status', a.status,
      'patientId', a.patient_id,
      'fileNumber', p.file_number,
      'name', coalesce(p.surname || ' ' || p.given_names, a.contact_name),
      'phone', coalesce(p.phone_1, a.contact_phone),
      'doctor', pr.names,
      'reason', a.reason,
      'reference', a.reference,
      'source', a.source,
      'channel', a.contact_channel,
      'late', a.status in ('approved', 'confirmed') and a.starts_at < now() - interval '15 minutes',
      'doctorUserId', pr.user_id,
      'encounterId', (select e.id from encounter e where e.appointment_id = a.id order by e.arrived_at desc limit 1),
      'declineReason', case when a.status = 'declined' then a.cancel_reason end,
      -- a declined booking already booked again (a later booking of the same patient)
      'rebooked', a.status = 'declined' and exists (
        select 1 from appointment b
        where b.patient_id = a.patient_id and b.id <> a.id and b.deleted_at is null
          and b.created_at > a.updated_at
          and b.status not in ('declined', 'rejected', 'cancelled'))
    ) order by a.starts_at), '[]'::jsonb)
  from appointment a
  left join patient p on p.id = a.patient_id
  left join practitioner pr on pr.id = a.practitioner_id
  where has_perm('appointment.read') and a.deleted_at is null
    and a.status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed', 'no_show', 'cancelled', 'declined')
    and (a.starts_at at time zone 'Africa/Kigali')::date = coalesce(p_day, (now() at time zone 'Africa/Kigali')::date)
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
      'category', a.category
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

create or replace function inquiries_open()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'name', a.contact_name, 'phone', a.contact_phone, 'reference', a.reference,
    'category', a.category, 'channel', a.contact_channel, 'note', a.reason,
    'doctor', pr.names, 'doctorUserId', pr.user_id,
    'startsAt', a.starts_at, 'preferredAt', a.preferred_at, 'createdAt', a.created_at,
    'insurer', a.insurer_text,
    'patientId', m.id, 'patientFile', m.file_number,
    'patientName', case when m.id is null then null else m.surname || ' ' || m.given_names end,
    'matches', m.n
  ) order by a.created_at), '[]'::jsonb)
  from appointment a
  left join practitioner pr on pr.id = a.practitioner_id
  left join lateral (
    select count(*)::integer as n,
           case when count(*) = 1 then (array_agg(p.id))[1] end as id,
           case when count(*) = 1 then (array_agg(p.file_number))[1] end as file_number,
           case when count(*) = 1 then (array_agg(p.surname))[1] end as surname,
           case when count(*) = 1 then (array_agg(p.given_names))[1] end as given_names
    from patient p
    where p.deleted_at is null and p.merged_into is null
      and phone_key(p.phone_1) = phone_key(a.contact_phone) and phone_key(a.contact_phone) <> ''
  ) m on true
  where has_perm('appointment.read') and a.deleted_at is null and a.status = 'inquiry'
$$;

create or replace function approve_inquiry_auto(
  p_appointment_id uuid,
  p_patient_id uuid default null,
  p_practitioner_user uuid default null,
  p_starts_at timestamptz default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_patient uuid := p_patient_id;
  v_phone text;
  v_matches integer;
begin
  if not has_perm('appointment.approve') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_patient is null then
    select contact_phone into v_phone from appointment where id = p_appointment_id and status = 'inquiry';
    if v_phone is null then
      raise exception 'inquiry not found or already handled' using errcode = 'P0002';
    end if;
    select count(*), (array_agg(id))[1] into v_matches, v_patient from patient
    where deleted_at is null and merged_into is null
      and phone_key(phone_1) = phone_key(v_phone);
    if v_matches <> 1 then
      raise exception 'register the patient first (no single file matches phone %)', v_phone using errcode = 'P0002';
    end if;
  end if;
  perform approve_inquiry(p_appointment_id, v_patient, p_practitioner_user, p_starts_at);
  return v_patient;
end
$$;

create or replace function send_from_triage(
  p_encounter_id uuid,
  p_triage triage_level,
  p_next_station station,
  p_reason text default null
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
begin
  if not (has_perm('clinical.write') or has_perm('vitals.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_may_work_on(p_encounter_id, true);
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if not exists (select 1 from observation where encounter_id = p_encounter_id and deleted_at is null) then
    raise exception 'take the vitals first' using errcode = '22023';
  end if;
  update encounter set triage_level = p_triage, triage_reason = coalesce(nullif(trim(coalesce(p_reason, '')), ''), triage_reason)
  where id = p_encounter_id;
  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = 'triage' and finished_at is null and deleted_at is null;
  if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = p_next_station
                 and finished_at is null and deleted_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, p_next_station, v_ticket,
            case p_triage when 'red' then 1 when 'yellow' then 2 else 3 end);
  end if;
  return v_ticket;
end
$$;

create or replace function activity_history(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_actor uuid default null,
  p_group text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '7 days');
  v_to timestamptz := coalesce(p_to, now());
  v_total integer;
  v_items jsonb;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- Everyone sees their own activity; only the manager sees everybody's (and may pick a person).
  if not is_manager() then
    p_actor := auth.uid();
  end if;

  select count(*) into v_total
  from audit_event a
  where a.at >= v_from and a.at < v_to and a.action <> 'read'
    and (p_actor is null or a.actor_id = p_actor)
    and (p_group is null or activity_group(a.entity, a.action) = p_group);

  with ev as (
    select a.*, activity_group(a.entity, a.action) as grp, coalesce(a.after, a.before) as row
    from audit_event a
    where a.at >= v_from and a.at < v_to and a.action <> 'read'
      and (p_actor is null or a.actor_id = p_actor)
      and (p_group is null or activity_group(a.entity, a.action) = p_group)
    order by a.at desc
    limit greatest(1, least(p_limit, 500)) offset greatest(p_offset, 0)
  ),
  -- The visit behind the record: directly, through its bill, or through its test order.
  ev2 as (
    select ev.*,
      case when ev.entity = 'encounter' then ev.entity_id
        else coalesce(
          nullif(ev.row ->> 'encounter_id', '')::uuid,
          (select i.encounter_id from invoice i where i.id = nullif(ev.row ->> 'invoice_id', '')::uuid),
          (select i.encounter_id from invoice i where ev.entity = 'invoice' and i.id = ev.entity_id),
          (select sr.encounter_id from service_request sr where sr.id = nullif(ev.row ->> 'service_request_id', '')::uuid),
          (select md.encounter_id from medication_request md where md.id = nullif(ev.row ->> 'medication_request_id', '')::uuid))
      end as enc_id
    from ev
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', ev2.id,
      'at', ev2.at,
      'action', ev2.action,
      'entity', ev2.entity,
      'group', ev2.grp,
      'actor', pr.full_name,
      'actorRole', pr.role,
      'actorStaffId', pr.staff_id,
      'encounterId', en.id,
      'patientId', coalesce(case when ev2.entity = 'patient' then ev2.entity_id end, en.patient_id, pp.id),
      'patient', coalesce(
        case when ev2.entity = 'patient' then (ev2.row ->> 'surname') || ' ' || (ev2.row ->> 'given_names') end,
        pe.surname || ' ' || pe.given_names,
        pp.surname || ' ' || pp.given_names,
        case when ev2.entity = 'appointment' then ev2.row ->> 'contact_name' end),
      'detail', null,
      'reason', ev2.reason,
      'row', audit_clean(ev2.row),
      'changes', case when ev2.action = 'update' then audit_changes(ev2.before, ev2.after) else '[]'::jsonb end,
      'names', jsonb_strip_nulls(jsonb_build_object(
        'file', coalesce(case when ev2.entity = 'patient' then ev2.row ->> 'file_number' end,
                         pe.file_number, pp.file_number),
        'target', case ev2.entity
          when 'profiles' then (select p.full_name || coalesce(' (' || p.staff_id || ')', '') from profiles p where p.id = ev2.entity_id)
          when 'practitioner' then ev2.row ->> 'names'
          when 'service' then coalesce(ev2.row ->> 'name_en', (select s.name_en from service s where s.id = ev2.entity_id))
          when 'payer' then coalesce(ev2.row ->> 'name', (select y.name from payer y where y.id = ev2.entity_id))
          when 'bed' then ev2.row ->> 'name'
          when 'item' then ev2.row ->> 'name_generic'
        end,
        'service', (select s.name_en from service s where s.id = coalesce(
          nullif(ev2.row ->> 'service_id', '')::uuid,
          (select sr.service_id from service_request sr where sr.id = nullif(ev2.row ->> 'service_request_id', '')::uuid))),
        'item', (select it.name_generic || coalesce(' ' || it.strength, '') from item it
                 where it.id = coalesce(nullif(ev2.row ->> 'item_id', '')::uuid,
                   (select md.item_id from medication_request md where md.id = nullif(ev2.row ->> 'medication_request_id', '')::uuid))),
        'staff', (select p.full_name from profiles p
                  where p.id = nullif(coalesce(ev2.after ->> 'assigned_to', ev2.after ->> 'taken_by',
                                               ev2.row ->> 'assigned_to', ev2.row ->> 'given_by'), '')::uuid),
        'referredBy', (select p.full_name from profiles p where p.id = nullif(ev2.row ->> 'referred_by', '')::uuid),
        'returnTo', (select p.full_name from profiles p where p.id = nullif(ev2.row ->> 'return_to', '')::uuid),
        'performer', (select p.full_name from profiles p where p.id = nullif(ev2.row ->> 'performer_id', '')::uuid),
        'practitioner', (select x.names from practitioner x where x.id = nullif(ev2.row ->> 'practitioner_id', '')::uuid),
        'bed', (select b.name from bed b where b.id = nullif(ev2.row ->> 'bed_id', '')::uuid),
        'invoice', coalesce(case when ev2.entity = 'invoice' then ev2.row ->> 'number' end,
                            (select i.number from invoice i where i.id = nullif(ev2.row ->> 'invoice_id', '')::uuid)),
        'department', (select d.name from department d where d.id = nullif(ev2.row ->> 'department_id', '')::uuid)
      ))
    ) order by ev2.at desc), '[]'::jsonb)
  into v_items
  from ev2
  left join profiles pr on pr.id = ev2.actor_id
  left join encounter en on en.id = ev2.enc_id
  left join patient pe on pe.id = en.patient_id
  left join patient pp on pp.id = nullif(ev2.row ->> 'patient_id', '')::uuid and en.id is null;

  return jsonb_build_object('total', v_total, 'items', v_items, 'from', v_from, 'to', v_to);
end
$$;
