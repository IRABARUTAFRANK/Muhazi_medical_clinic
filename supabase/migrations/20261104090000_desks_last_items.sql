-- 0063 · The desks' last open items (dashboard audit, wave 6).
-- Bookings: a booking the doctor declines stays on the day's list with the doctor's reason and
-- can be booked again; bookings of other days can be cancelled (and past ones marked no-show).

-- ---------------------------------------------------------------- corrected results
-- A verified result stays immutable (doc §10.4) except through correct_result: the old text is
-- kept in report_correction with the reason, the report shows it was corrected, and the doctor
-- who ordered the test is told.
alter table diagnostic_report add column if not exists corrected_at timestamptz;
alter table diagnostic_report add column if not exists correction_reason text;

create table if not exists report_correction (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references diagnostic_report (id) on delete cascade,
  old_findings text,
  old_impression text,
  old_verified_by uuid,
  old_verified_at timestamptz,
  reason text not null,
  corrected_by uuid default auth.uid(),
  corrected_at timestamptz not null default now()
);
create index if not exists report_correction_report_idx on report_correction (report_id);
alter table report_correction enable row level security;
revoke all on report_correction from anon, authenticated;

create or replace function guard_verified_report()
returns trigger
language plpgsql
as $$
begin
  if old.verified_at is not null and coalesce(current_setting('mmc.correcting_report', true), '') <> old.id::text
     and (new.findings is distinct from old.findings
      or new.impression is distinct from old.impression or new.attachments is distinct from old.attachments
      or new.verified_at is null) then
    raise exception 'verified report % is immutable; issue a corrected report instead', old.id using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function correct_result(
  p_request_id uuid,
  p_findings text,
  p_impression text,
  p_reason text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req service_request%rowtype;
  v_rep diagnostic_report%rowtype;
  v_test text;
  v_name text;
begin
  select * into v_req from service_request where id = p_request_id and deleted_at is null;
  if not found then
    raise exception 'test order not found' using errcode = 'P0002';
  end if;
  if not (is_manager() or has_perm('orders.write')
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound'))) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the result is corrected' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_findings, '')), '') is null and nullif(trim(coalesce(p_impression, '')), '') is null then
    raise exception 'write the findings or the conclusion' using errcode = '22023';
  end if;
  select * into v_rep from diagnostic_report where service_request_id = p_request_id and deleted_at is null for update;
  if not found or v_rep.verified_at is null then
    raise exception 'only a verified result is corrected; edit the result instead' using errcode = '22023';
  end if;
  insert into report_correction (report_id, old_findings, old_impression, old_verified_by, old_verified_at, reason)
  values (v_rep.id, v_rep.findings, v_rep.impression, v_rep.verified_by, v_rep.verified_at, trim(p_reason));
  perform set_config('mmc.correcting_report', v_rep.id::text, true);
  update diagnostic_report
  set findings = nullif(trim(coalesce(p_findings, '')), ''), impression = nullif(trim(coalesce(p_impression, '')), ''),
      verified_by = auth.uid(), verified_at = now(), corrected_at = now(), correction_reason = trim(p_reason),
      updated_at = now()
  where id = v_rep.id;
  perform set_config('mmc.correcting_report', '', true);
  -- The doctor who ordered the test is told the result changed.
  if v_req.requester_id is not null and v_req.requester_id is distinct from auth.uid() then
    select s.name_en into v_test from service s where s.id = v_req.service_id;
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_req.encounter_id;
    insert into notification (kind, params, link, recipient_user, urgent, created_by)
    values ('result',
            jsonb_build_object('test', v_test, 'name', v_name,
                               'impression', nullif(trim(coalesce(p_impression, '')), ''),
                               'verified', true, 'corrected', true, 'reason', trim(p_reason)),
            '/app/visit?encounter=' || v_req.encounter_id,
            v_req.requester_id, true, auth.uid());
  end if;
end
$$;

revoke all on function correct_result(uuid, text, text, text) from public, anon;
grant execute on function correct_result(uuid, text, text, text) to authenticated;


-- ---------------------------------------------------------------- reorder level
-- One rule everywhere: a medicine is low when a level is set and the stock reaches it.
create or replace view items_below_reorder as
  select i.id as item_id, i.code, i.name_generic, i.reorder_level, coalesce(sum(s.quantity), 0)::integer as on_hand
  from item i
  left join stock_on_hand s on s.item_id = i.id
  where i.active and i.deleted_at is null and i.reorder_level > 0
  group by i.id
  having coalesce(sum(s.quantity), 0) <= i.reorder_level;

-- The pharmacy and the manager set the level (0: never shown as low).
create or replace function set_reorder_level(p_item_id uuid, p_level integer)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not (has_perm('catalogue.write') or has_perm('item_price.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_level is null or p_level < 0 then
    raise exception 'the level must be zero or more' using errcode = '22023';
  end if;
  update item set reorder_level = p_level, updated_at = now() where id = p_item_id and deleted_at is null;
  if not found then
    raise exception 'medicine not found' using errcode = 'P0002';
  end if;
end
$$;

revoke all on function set_reorder_level(uuid, integer) from public, anon;
grant execute on function set_reorder_level(uuid, integer) to authenticated;


-- ---------------------------------------------------------------- bill totals
-- Removing the last line of a bill set nothing (the grouped sub-query had no row): the bill kept
-- its old total. The sums are now taken without grouping, so an empty bill comes to 0.
create or replace function recompute_invoice(p_invoice_id uuid)
returns void
language sql security definer set search_path = public
as $$
  update invoice i
  set total = s.total, patient_share = s.patient_share, insurer_share = s.insurer_share
  from (
    select coalesce(sum(round(unit_price * quantity)), 0) as total,
           coalesce(sum(patient_share), 0) as patient_share,
           coalesce(sum(insurer_share), 0) as insurer_share
    from invoice_line
    where invoice_id = p_invoice_id and deleted_at is null
  ) s
  where i.id = p_invoice_id and i.status = 'draft'
$$;

-- Bills left with a stale total by that bug.
update invoice i set total = 0, patient_share = 0, insurer_share = 0
where i.status = 'draft' and i.total <> 0
  and not exists (select 1 from invoice_line l where l.invoice_id = i.id and l.deleted_at is null);

-- Only cash, MTN MoMo and Airtel Money are taken at the desk.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_method_desk') then
    alter table payment add constraint payment_method_desk
      check (method::text in ('cash', 'momo', 'airtel')) not valid;
  end if;
end
$$;


-- ---------------------------------------------------------------- "vitals taken" on every desk's queue
-- queue_board runs with the caller's rights, and the lab, pharmacy, cashier and reception cannot
-- read observations: every patient showed "No vitals yet" to them. Only when and by whom the
-- vitals were taken is shared (no values), through a definer function.
create or replace function last_vitals_stamp(p_encounter_id uuid)
returns table (effective_at timestamptz, measured_by text)
language sql stable security definer set search_path = public
as $$
  select o.effective_at, pm.full_name
  from observation o
  left join profiles pm on pm.id = o.performer_id
  where o.encounter_id = p_encounter_id and o.deleted_at is null
    and o.code in ('bp_sys', 'bp_dia', 'pulse', 'temp', 'resp', 'spo2', 'weight', 'height', 'muac')
    and exists (select 1 from profiles me where me.id = auth.uid() and me.active)
  order by o.effective_at desc limit 1
$$;
revoke all on function last_vitals_stamp(uuid) from public, anon;
grant execute on function last_vitals_stamp(uuid) to authenticated;

create or replace view queue_board with (security_invoker = true) as
  select q.id as queue_id, q.encounter_id, q.station, q.ticket_no, q.priority,
         q.created_at as queued_at, q.called_at, q.started_at, q.finished_at,
         e.patient_id, e.triage_level, e.arrived_at, e.type as encounter_type,
         p.file_number, p.surname, p.given_names, p.sex, p.birth_date, p.phone_1,
         q.pool_id, tb.full_name as taken_by_name,
         q.assigned_to, asg.full_name as assigned_name, rb.full_name as referred_by_name,
         q.referral_note, q.return_station,
         v.effective_at as vitals_at, v.measured_by as vitals_by,
         q.department_id, dep.name as department_name, queue_entry_for_me(q.id) as can_work
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  join patient p on p.id = e.patient_id
  left join profiles tb on tb.id = q.taken_by
  left join profiles asg on asg.id = q.assigned_to
  left join profiles rb on rb.id = q.referred_by
  left join department dep on dep.id = q.department_id
  left join lateral last_vitals_stamp(q.encounter_id) v on true
  where q.deleted_at is null and e.status = 'open';


-- ---------------------------------------------------------------- nursing tasks: withdrawn or not done
-- The doctor who gave a task (or the manager) withdraws it; the nurse says it could not be done.
-- Either way it leaves the lists with its reason, and the other side is told.
alter table internal_task add column if not exists cancel_reason text;
alter table internal_task add column if not exists cancelled_by uuid references profiles (id) on delete set null;

create or replace function cancel_task(p_task_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_task internal_task%rowtype;
  v_name text;
  v_mine boolean;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why' using errcode = '22023';
  end if;
  select * into v_task from internal_task where id = p_task_id and deleted_at is null and done_at is null for update;
  if not found then
    raise exception 'task not found or already done' using errcode = 'P0002';
  end if;
  v_mine := v_task.created_by = auth.uid();
  -- the giver or the manager withdraws; otherwise only the nurses (to whom it was given) say "not done"
  if not (v_mine or is_manager()
          or (v_task.assigned_role is not null and current_role_key() = v_task.assigned_role)
          or v_task.assigned_to = auth.uid()) then
    raise exception 'only the person who gave the task, the nurses or the manager' using errcode = '42501';
  end if;
  update internal_task set deleted_at = now(), cancel_reason = trim(p_reason), cancelled_by = auth.uid()
  where id = p_task_id;
  if v_task.created_by is not null and not v_mine then
    select p.surname || ' ' || p.given_names into v_name from patient p where p.id = v_task.patient_id;
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('task_done',
            jsonb_build_object('title', v_task.title, 'name', v_name, 'notDone', true, 'reason', trim(p_reason),
                               'by', (select full_name from profiles where id = auth.uid())),
            case when v_task.encounter_id is not null then '/app/visit?encounter=' || v_task.encounter_id end,
            v_task.created_by, auth.uid());
  end if;
end
$$;

revoke all on function cancel_task(uuid, text) from public, anon;
grant execute on function cancel_task(uuid, text) to authenticated;


-- ---------------------------------------------------------------- the head of department's dashboard
-- A head (or assistant) sees their own department: its people and what each did in the period,
-- the queue at its desks now, the patients it handled and the work still open. No money.
-- The department's desks are those whose role is one of the department's roles.
create or replace function department_summary(p_department_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_dept department%rowtype;
  v_days integer := greatest(1, p_to - p_from + 1);
  v_today date := (now() at time zone 'Africa/Kigali')::date;
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
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.full_name, 'role', p.role, 'position', sd.position, 'station', p.station,
      'lastSignIn', p.last_sign_in_at, 'active', p.active,
      'patients', (select count(distinct q.encounter_id) from queue_entry q
                   where q.taken_by = p.id and q.deleted_at is null
                     and (coalesce(q.finished_at, q.started_at) at time zone 'Africa/Kigali')::date between p_from and p_to),
      'registrations', (select count(*) from patient x where x.deleted_at is null and x.created_by = p.id
                        and (x.created_at at time zone 'Africa/Kigali')::date between p_from and p_to),
      'vitals', (select count(distinct o.encounter_id) from observation o where o.deleted_at is null and o.code <> 'note'
                 and o.performer_id = p.id and (o.effective_at at time zone 'Africa/Kigali')::date between p_from and p_to),
      'results', (select count(*) from diagnostic_report d where d.deleted_at is null and coalesce(d.verified_by, d.created_by) = p.id
                  and (coalesce(d.verified_at, d.created_at) at time zone 'Africa/Kigali')::date between p_from and p_to),
      'dispensed', (select count(*) from medication_dispense m where m.deleted_at is null and m.dispenser_id = p.id
                    and (m.created_at at time zone 'Africa/Kigali')::date between p_from and p_to),
      'payments', (select count(*) from payment y where y.deleted_at is null and y.cashier_id = p.id
                   and (y.paid_at at time zone 'Africa/Kigali')::date between p_from and p_to),
      'tasksDone', (select count(*) from internal_task k where k.done_by = p.id
                    and (k.done_at at time zone 'Africa/Kigali')::date between p_from and p_to),
      'busyNow', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                  where q.taken_by = p.id and q.deleted_at is null and q.finished_at is null and e.status = 'open')
    ) order by case sd.position when 'head' then 0 when 'assistant' then 1 else 2 end, p.full_name), '[]'::jsonb)
  into v_members
  from staff_department sd join profiles p on p.id = sd.profile_id
  where sd.department_id = p_department_id;

  -- the department's desks right now
  select coalesce(jsonb_agg(jsonb_build_object('station', w.station, 'waiting', w.waiting, 'busy', w.busy,
                                               'minutes', w.minutes, 'longest', w.longest) order by w.station), '[]'::jsonb)
  into v_queue
  from (
    select q.station::text as station,
           count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open') as waiting,
           count(*) filter (where q.finished_at is null and q.started_at is not null and e.status = 'open') as busy,
           round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60)
                 filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date = v_today)) as minutes,
           round(max(extract(epoch from now() - q.created_at) / 60)
                 filter (where q.finished_at is null and q.started_at is null and e.status = 'open')) as longest
    from queue_entry q join encounter e on e.id = q.encounter_id
    where q.deleted_at is null and q.station = any (v_stations)
      and ((q.finished_at is null and e.status = 'open') or (q.created_at at time zone 'Africa/Kigali')::date = v_today)
    group by q.station
  ) w;

  select jsonb_build_object(
    'patients', (select count(distinct q.encounter_id) from queue_entry q
                 where q.deleted_at is null and q.station = any (v_stations) and q.finished_at is not null
                   and (q.finished_at at time zone 'Africa/Kigali')::date between p_from and p_to),
    'patientsPrev', (select count(distinct q.encounter_id) from queue_entry q
                     where q.deleted_at is null and q.station = any (v_stations) and q.finished_at is not null
                       and (q.finished_at at time zone 'Africa/Kigali')::date between p_from - v_days and p_from - 1),
    'waitingNow', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                   where q.deleted_at is null and q.station = any (v_stations) and q.finished_at is null
                     and q.started_at is null and e.status = 'open'),
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

revoke all on function department_summary(uuid, date, date) from public, anon;
grant execute on function department_summary(uuid, date, date) to authenticated;


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

create or replace function set_appointment_outcome(p_appointment_id uuid, p_status appointment_status, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('appointment.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_status not in ('no_show', 'cancelled') then
    raise exception 'only no-show or cancelled here' using errcode = '22023';
  end if;
  if p_status = 'cancelled' and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'give the reason for the cancellation' using errcode = '22023';
  end if;
  if p_status = 'no_show' and exists (
    select 1 from appointment where id = p_appointment_id and starts_at > now()
  ) then
    raise exception 'a booking still to come is cancelled, not marked as no-show' using errcode = '22023';
  end if;
  update appointment set status = p_status, cancel_reason = coalesce(nullif(trim(p_reason), ''), cancel_reason)
  where id = p_appointment_id and deleted_at is null and status in ('approved', 'confirmed');
  if not found then
    raise exception 'this appointment can no longer be changed' using errcode = 'P0002';
  end if;
end
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

create or replace function record_result(
  p_request_id uuid,
  p_findings text,
  p_impression text,
  p_verify boolean default true
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req service_request%rowtype;
  v_test text;
  v_name text;
  v_station station;
  v_q queue_entry%rowtype;
  v_tests text;
begin
  select * into v_req from service_request where id = p_request_id and deleted_at is null;
  if not found then
    raise exception 'test order not found' using errcode = 'P0002';
  end if;
  -- Lab / ultrasound results: lab staff and clinicians who order; an order done at another desk
  -- (Nursing, Dental…): the clinical staff of that desk too.
  if not (has_perm('orders.write')
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound'))) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_req.status = 'cancelled' then
    raise exception 'this test was marked "not done": order it again if it is done after all' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_findings, '')), '') is null and nullif(trim(coalesce(p_impression, '')), '') is null then
    raise exception 'write the findings or the conclusion' using errcode = '22023';
  end if;
  if exists (select 1 from diagnostic_report where service_request_id = p_request_id
             and deleted_at is null and verified_at is not null) then
    raise exception 'this result is verified: correct it, giving the reason' using errcode = '22023';
  end if;
  insert into diagnostic_report (service_request_id, findings, impression, verified_by, verified_at)
  values (p_request_id, nullif(trim(coalesce(p_findings, '')), ''), nullif(trim(coalesce(p_impression, '')), ''),
          case when p_verify then auth.uid() end, case when p_verify then now() end)
  on conflict (service_request_id) do update
  set findings = excluded.findings, impression = excluded.impression,
      verified_by = excluded.verified_by, verified_at = excluded.verified_at, updated_at = now();
  update service_request set status = case when p_verify then 'verified'::request_status else 'resulted'::request_status end
  where id = p_request_id;
  -- Tell the doctor who ordered it.
  if v_req.requester_id is not null and v_req.requester_id is distinct from auth.uid() then
    select s.name_en into v_test from service s where s.id = v_req.service_id;
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_req.encounter_id;
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('result',
            jsonb_build_object('test', v_test, 'name', v_name,
                               'impression', nullif(trim(coalesce(p_impression, '')), ''),
                               'verified', p_verify),
            '/app/visit?encounter=' || v_req.encounter_id,
            v_req.requester_id, auth.uid());
  end if;
  -- Last result of this desk written: the patient goes back to the doctor.
  v_station := coalesce(v_req.station, case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end);
  perform after_desk_tests(v_req.encounter_id, v_station, v_req.requester_id);
end
$$;

create or replace function visit_clinical(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  -- clinicians; the lab and the pharmacy read the record too (their orders and prescriptions)
  select case when has_perm('clinical.read') or has_perm('orders.read') or has_perm('prescription.read')
              then jsonb_build_object(
    'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by)) order by c.created_at)
      from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.value_text, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id)) order by o.effective_at)
      from observation o where o.encounter_id = p_encounter_id and o.code = 'note' and o.deleted_at is null), '[]'::jsonb),
    'prescriptions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by)), 'item', i.name_generic || coalesce(' ' || i.strength, ''), 'dose', m.dose, 'route', m.route,
        'frequency', m.frequency, 'days', m.duration_days, 'quantity', m.quantity, 'instructions', m.instructions, 'at', m.created_at,
        'dispensed', m.supply = 'room' or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'supply', m.supply, 'givenAt', m.given_at, 'givenBy', (select full_name from profiles where id = m.given_by),
        'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason) order by m.created_at)
      from medication_request m join item i on i.id = m.item_id where m.encounter_id = p_encounter_id and m.deleted_at is null), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end), 'status', r.status, 'reason', r.reason, 'at', r.created_at,
        'result', (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
          'corrected', d.corrected_at is not null, 'correctionReason', d.correction_reason,
          'at', coalesce(d.verified_at, d.updated_at), 'by', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)))
          from diagnostic_report d where d.service_request_id = r.id and d.deleted_at is null)) order by r.created_at)
      from service_request r join service s on s.id = r.service_id where r.encounter_id = p_encounter_id and r.deleted_at is null), '[]'::jsonb),
    'patient', (select jsonb_build_object('id', p.id, 'allergies', p.allergies, 'bloodGroup', p.blood_group, 'notes', p.notes, 'flags', p.flags)
      from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id)
  ) else null end
$$;

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
      'corrected', d.corrected_at is not null,
      'resultAt', coalesce(d.verified_at, d.updated_at),
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by))
    ) as j
    from service_request r
    join encounter e on e.id = r.encounter_id and (p_scope = 'done' or e.status = 'open')
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and has_perm('orders.read')
      and r.category = any (my_test_categories()) and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) in ('laboratory', 'ultrasound')
      and case when p_scope = 'done'
            then r.status in ('resulted', 'verified')
                 and (coalesce(d.verified_at, d.updated_at) at time zone 'Africa/Kigali')::date
                     = (now() at time zone 'Africa/Kigali')::date
            else r.status not in ('verified', 'cancelled') end
  ) x
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
    'avgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date = v_today)), 0)
                   from queue_entry q where q.deleted_at is null and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'triageWaiting', (select count(*) from queue_entry q join encounter e on e.id = q.encounter_id
                      where q.deleted_at is null and q.station = 'triage' and q.finished_at is null and e.status = 'open'),
    'triageRed', (select count(*) from encounter e where e.deleted_at is null and e.status = 'open' and e.triage_level = 'red'),
    'triageYellow', (select count(*) from encounter e where e.deleted_at is null and e.status = 'open' and e.triage_level = 'yellow'),
    'triageGreen', (select count(*) from encounter e where e.deleted_at is null and e.status = 'open' and e.triage_level = 'green'),
    'triageNone', (select count(*) from encounter e where e.deleted_at is null and e.status = 'open' and e.triage_level is null),
    -- patients still waiting for their first measurements (the Vitals page)
    'needVitals', (select count(*) from encounter e where e.deleted_at is null and e.status = 'open'
                   and not exists (select 1 from observation o where o.encounter_id = e.id and o.deleted_at is null and o.code <> 'note')),
    'triageAvgWaitMin', (select coalesce(round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date = v_today)), 0)
                         from queue_entry q where q.deleted_at is null and q.station = 'triage'
                           and (q.created_at at time zone 'Africa/Kigali')::date = v_today),
    'vitalsToday', (select count(distinct encounter_id) from observation where deleted_at is null and code <> 'note' and (effective_at at time zone 'Africa/Kigali')::date = v_today),
    'vitalsYesterday', (select count(distinct encounter_id) from observation where deleted_at is null and code <> 'note' and (effective_at at time zone 'Africa/Kigali')::date = v_today - 1),
    'apptsToday', (select count(*) from appointment where deleted_at is null
                   and status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed')
                   and (starts_at at time zone 'Africa/Kigali')::date = v_today),
    'inquiriesPending', (select count(*) from appointment where deleted_at is null and status = 'inquiry'),
    'bedsOccupied', (select count(*) from bed where deleted_at is null and status = 'occupied'),
    'bedsTotal', (select count(*) from bed where deleted_at is null and status <> 'out_of_service')
  ) into v_tiles;

  -- Where patients are right now: waiting / being seen per station, average wait today.
  select coalesce(jsonb_agg(jsonb_build_object('station', s.station, 'waiting', s.waiting, 'busy', s.busy, 'minutes', s.minutes, 'longest', s.longest)
                            order by s.station), '[]'::jsonb) into v_stations
  from (
    select q.station::text as station,
           count(*) filter (where q.finished_at is null and q.started_at is null and e.status = 'open') as waiting,
           count(*) filter (where q.finished_at is null and q.started_at is not null and e.status = 'open') as busy,
           round(avg(extract(epoch from coalesce(q.started_at, q.finished_at) - q.created_at) / 60) filter (where coalesce(q.started_at, q.finished_at) is not null and (q.created_at at time zone 'Africa/Kigali')::date = v_today)) as minutes,
           round(max(extract(epoch from now() - q.created_at) / 60) filter (where q.finished_at is null and q.started_at is null and e.status = 'open')) as longest
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
    'vitals', (select count(distinct encounter_id) from observation where deleted_at is null and code <> 'note' and performer_id = v_me and (effective_at at time zone 'Africa/Kigali')::date = v_today),
    'charges', (select count(*) from invoice_line where deleted_at is null and entered_by = v_me and (created_at at time zone 'Africa/Kigali')::date = v_today)
  ) into v_mine;

  return jsonb_build_object('tiles', v_tiles, 'stations', v_stations, 'arrivals', v_hours, 'mine', v_mine);
end
$$;

create or replace function take_payment(
  p_encounter_id uuid,
  p_method payment_method,
  p_amount numeric,
  p_reference text default null,
  p_payer_phone text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice invoice%rowtype;
  v_balance numeric;
  v_number text;
  v_closed boolean := false;
  v_pay uuid;
  v_receipt text;
begin
  if not has_perm('payment.take') then
    raise exception 'you may not take payments (the manager has not allowed it)' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'the amount must be more than zero' using errcode = '22023';
  end if;
  perform recompute_invoice((select id from invoice where encounter_id = p_encounter_id));
  select * into v_invoice from invoice where encounter_id = p_encounter_id for update;
  if not found then
    raise exception 'no bill for this visit' using errcode = 'P0002';
  end if;
  if v_invoice.status = 'credited' then
    raise exception 'this bill was credited' using errcode = '23514';
  end if;
  v_balance := invoice_balance(v_invoice.id);
  if p_amount > v_balance + 0.5 then
    raise exception 'the amount exceeds the balance due (%)', v_balance using errcode = '22023';
  end if;
  v_pay := record_payment(v_invoice.id, p_method, p_amount, p_reference, p_payer_phone);
  select receipt_no into v_receipt from payment where id = v_pay;
  v_balance := invoice_balance(v_invoice.id);
  if v_balance <= 0 then
    -- Paid so far: off the cashier's queue. The bill stays open while the visit goes on (a
    -- test or a medicine may still be added); it is posted when the visit ends.
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = 'cashier' and finished_at is null;
    v_closed := settle_visit(p_encounter_id);
  end if;
  select number into v_number from invoice where id = v_invoice.id;
  return jsonb_build_object('balance', v_balance, 'number', v_number, 'closed', v_closed,
                            'status', (select status from invoice where id = v_invoice.id),
                            'receipt', v_receipt, 'paymentId', v_pay);
end
$$;

create or replace function visit_tasks(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', k.id, 'title', k.title, 'detail', k.detail, 'dueAt', k.due_at,
      'overdue', k.due_at is not null and k.due_at < now(),
      'encounterId', k.encounter_id,
      'patient', p.surname || ' ' || p.given_names,
      'by', pr.full_name,
      'mine', k.created_by = auth.uid()
    ) order by k.due_at nulls last, k.created_at), '[]'::jsonb)
  from internal_task k
  left join patient p on p.id = k.patient_id
  left join profiles pr on pr.id = k.created_by
  where k.encounter_id = p_encounter_id and k.deleted_at is null and k.done_at is null
    and (has_perm('clinical.read') or has_perm('vitals.write'))
$$;

create or replace function notify_queue_entry()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
  v_triage text;
  v_by text;
  v_vitals boolean;
begin
  if new.pool_id is not null then
    return new;
  end if;
  select p.surname || ' ' || p.given_names, e.triage_level::text into v_name, v_triage
  from encounter e join patient p on p.id = e.patient_id where e.id = new.encounter_id;
  select exists (select 1 from observation o where o.encounter_id = new.encounter_id and o.deleted_at is null
                 and o.code in ('bp_sys', 'bp_dia', 'pulse', 'temp', 'resp', 'spo2', 'weight', 'height', 'muac'))
  into v_vitals;
  if new.referred_by is not null then
    select full_name into v_by from profiles where id = new.referred_by;
    insert into notification (kind, params, link, urgent, recipient_user, recipient_role, recipient_department, created_by)
    values ('referral',
            jsonb_build_object('ticket', new.ticket_no, 'name', v_name, 'station', new.station,
                               'by', v_by, 'note', new.referral_note, 'queue', new.id,
                               'back', new.return_station is not null, 'vitals', v_vitals),
            '/app/visit?encounter=' || new.encounter_id,
            coalesce(v_triage, '') = 'red' or new.priority = 1,
            new.assigned_to,
            case when new.assigned_to is null and new.department_id is null then station_role(new.station) end,
            case when new.assigned_to is null then new.department_id end,
            auth.uid());
    return new;
  end if;
  insert into notification (kind, params, link, urgent, recipient_role, created_by)
  values ('queue',
          jsonb_build_object('ticket', new.ticket_no, 'name', v_name, 'station', new.station,
                             'triage', v_triage, 'queue', new.id, 'vitals', v_vitals),
          case when new.station = 'triage' then '/app/vitals?encounter=' else '/app/visit?encounter=' end
            || new.encounter_id,
          coalesce(v_triage, '') = 'red' or new.priority = 1,
          station_role(new.station),
          auth.uid());
  return new;
end
$$;

create or replace function upsert_department(p_id uuid, p_name text, p_description text, p_roles role_key[])
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := p_id;
begin
  if not is_manager() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'the department needs a name' using errcode = '22023';
  end if;
  if v_id is null then
    insert into department (name, description, roles)
    values (trim(p_name), nullif(trim(coalesce(p_description, '')), ''), coalesce(p_roles, '{}'))
    returning id into v_id;
  else
    update department set name = trim(p_name), description = nullif(trim(coalesce(p_description, '')), ''),
                          roles = coalesce(p_roles, '{}')
    where id = v_id and deleted_at is null;
    if not found then
      raise exception 'department not found' using errcode = 'P0002';
    end if;
    -- Heads follow the department's name on their dashboard.
    update profiles set head_of = trim(p_name)
    where id in (select profile_id from staff_department where department_id = v_id and position = 'head');
  end if;
  return v_id;
end
$$;

create or replace function notification_is_mine(n notification, p_me uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles p
    where p.id = p_me and p.active and (
      (n.to_all and (not n.heads_only or exists (
          select 1 from staff_department sd where sd.profile_id = p.id and sd.position in ('head', 'assistant'))))
      or n.recipient_user = p_me
      or (n.recipient_role is not null and n.recipient_role = p.role and n.recipient_department is null)
      or (n.recipient_department is not null and exists (
            select 1 from staff_department sd
            where sd.profile_id = p.id and sd.department_id = n.recipient_department
              and (not n.heads_only or sd.position in ('head', 'assistant'))))
    )
  )
$$;

create or replace function send_notification(
  p_to text,              -- all | role | department | user
  p_target text,          -- role key, department id or user id (null for all)
  p_title text,
  p_body text,
  p_heads_only boolean default false,
  p_urgent boolean default false
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_me profiles%rowtype;
  v_id uuid;
begin
  select * into v_me from profiles where id = auth.uid() and active;
  if not found then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_title, ''))) < 2 then
    raise exception 'write a title' using errcode = '22023';
  end if;
  if not is_manager() then
    if not (p_to = 'department' and exists (
              select 1 from staff_department sd
              where sd.profile_id = v_me.id and sd.department_id = p_target::uuid
                and sd.position in ('head', 'assistant'))) then
      raise exception 'only the manager, or a head for their own department, can send messages' using errcode = '42501';
    end if;
  end if;
  insert into notification (kind, title, body, urgent, to_all, recipient_role, recipient_department,
                            recipient_user, heads_only, link)
  values ('message', trim(p_title), nullif(trim(coalesce(p_body, '')), ''), coalesce(p_urgent, false),
          p_to = 'all',
          case when p_to = 'role' then p_target::role_key end,
          case when p_to = 'department' then p_target::uuid end,
          case when p_to = 'user' then p_target::uuid end,
          p_to in ('department', 'all') and coalesce(p_heads_only, false), null)
  returning id into v_id;
  return v_id;
end
$$;
