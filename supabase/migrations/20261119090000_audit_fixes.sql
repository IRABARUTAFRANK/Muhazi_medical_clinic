-- 0078 · Fixes from the audit.
--
-- A check of Frank's recent requests found a few places where the database did not yet do what
-- the screens promise. Now:
--   * triage: whoever sends a patient on from triage while recording the measurements must be
--     allowed to work on the patient (as with "Send on" alone). Reception that already sent the
--     patient to triage, and a nurse other than the one named, may still record measurements
--     but no longer choose where the patient goes;
--   * deleting an employee: patients who were to come back to them (after the lab, the
--     ultrasound or the pharmacy) go back to the section instead, and a result or a medicine
--     handed over never sends a patient to someone who no longer works here (deactivated or
--     deleted): anyone in the section takes them; their calls still open ("send me the next
--     patient", requests for help) are withdrawn, and a call from someone who left cannot be
--     answered;
--   * before deleting, the manager sees what the delete touches: their notices, the bookings
--     still to come in their calendar, the patients waiting for them, their open tasks;
--   * the cashier's dashboard, My orders and My prescriptions take a period (Today, This week,
--     This month, All time, Custom) like the other dashboards;
--   * the pharmacy sees how much of a medicine short at the pharmacy is held in the other
--     stores, so it can be sent across instead of received again.

-- ---------------------------------------------------------------- someone who still works here
-- The person, if they still work at the clinic (active, not deleted); otherwise nobody, and the
-- patient goes to the section.
create or replace function active_staff_or_null(p_profile_id uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select id from profiles where id = p_profile_id and active and deleted_at is null
$$;
revoke all on function active_staff_or_null(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- vitals: sending on from triage
create or replace function record_vitals(
  p_encounter_id uuid,
  p_vitals jsonb,
  p_triage triage_level default null,
  p_next_station station default null,
  p_reason text default null,
  p_measured_by uuid default null,
  p_measured_at timestamptz default null
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_ticket text;
  v_key text;
  v_val numeric;
  v_count integer := 0;
  v_by uuid := coalesce(p_measured_by, auth.uid());
  v_at timestamptz := coalesce(p_measured_at, now());
  v_arrived timestamptz;
  v_at_triage boolean;
  v_units jsonb := '{"bp_sys":"mmHg","bp_dia":"mmHg","pulse":"bpm","temp":"°C","resp":"/min","spo2":"%","weight":"kg","height":"cm","muac":"cm"}'::jsonb;
begin
  if not has_perm('vitals.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select arrived_at into v_arrived from encounter where id = p_encounter_id and status = 'open';
  if not found then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  select exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'triage'
                 and finished_at is null and deleted_at is null) into v_at_triage;
  -- Sending on from triage is for whoever may work on the patient (as with "Send on"): reception
  -- that sent the patient to triage, or a nurse other than the one named, records only.
  if v_at_triage and p_next_station is not null and not may_route(p_encounter_id) then
    if current_role_key() = 'receptionist' then
      raise exception 'this patient is with %: record the measurements without choosing where they go next; the nurse there sends them on',
        coalesce(patient_holder(p_encounter_id), 'triage') using errcode = '42501';
    end if;
    perform assert_may_work_on(p_encounter_id, true);
  end if;
  -- Without clinical rights the person typing must name who measured.
  if not has_perm('clinical.write') and (p_measured_by is null or p_measured_by = auth.uid()) then
    raise exception 'choose the nurse who took the measurements' using errcode = '22023';
  end if;
  if not exists (select 1 from profiles where id = v_by and active) then
    raise exception 'unknown staff member for "measured by"' using errcode = '22023';
  end if;
  if v_at > now() + interval '5 minutes' then
    raise exception 'the measurement time is in the future' using errcode = '22023';
  end if;
  if v_at < v_arrived - interval '1 hour' then
    raise exception 'the measurement time is before the patient arrived' using errcode = '22023';
  end if;

  for v_key, v_val in
    select key, nullif(value, '')::numeric from jsonb_each_text(coalesce(p_vitals, '{}'::jsonb))
  loop
    if v_val is not null and v_units ? v_key then
      insert into observation (encounter_id, code, value_num, unit, performer_id, effective_at)
      values (p_encounter_id, v_key, v_val, v_units ->> v_key, v_by, v_at);
      v_count := v_count + 1;
    end if;
  end loop;
  if v_count = 0 then
    raise exception 'enter at least one measurement' using errcode = '22023';
  end if;

  if v_by <> auth.uid() then
    insert into audit_event (actor_id, action, entity, entity_id, after, reason)
    values (auth.uid(), 'create', 'observation', p_encounter_id,
            jsonb_build_object('measured_by', v_by, 'measured_at', v_at, 'count', v_count),
            'vitals entered on behalf of the person who measured');
  end if;

  if p_triage is not null then
    update encounter set triage_level = p_triage, triage_reason = coalesce(p_reason, triage_reason)
    where id = p_encounter_id;
    -- the colour reorders the places where the patient waits (red first)
    update queue_entry set priority = case p_triage when 'red' then 1 when 'yellow' then 2 else 3 end
    where encounter_id = p_encounter_id and finished_at is null and started_at is null and deleted_at is null;
  end if;

  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;

  -- At triage: close the triage turn and send the patient on. Later (e.g. the doctor typing
  -- the nurse's paper sheet): measurements only, the patient stays where they are.
  if v_at_triage and p_next_station is not null then
    update queue_entry set finished_at = now()
    where encounter_id = p_encounter_id and station = 'triage' and finished_at is null;
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, p_next_station, v_ticket,
            case coalesce(p_triage, 'green') when 'red' then 1 when 'yellow' then 2 else 3 end);
  end if;
  return v_ticket;
end
$$;

-- ---------------------------------------------------------------- back from the pharmacy
-- Nothing left to hand over: back to the colleague who asked for the patient (to the section if
-- they no longer work here); otherwise, when no desk holds the patient any more, on to the
-- cashier if money is due, or the visit ends.
create or replace function after_pharmacy(p_encounter_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_q queue_entry%rowtype;
  v_ticket text;
begin
  if exists (select 1 from medication_request m where m.encounter_id = p_encounter_id and rx_pending(m)) then
    return;
  end if;
  select * into v_q from queue_entry
  where encounter_id = p_encounter_id and station = 'pharmacy' and finished_at is null and deleted_at is null
  order by created_at desc limit 1;
  update queue_entry set finished_at = now()
  where encounter_id = p_encounter_id and station = 'pharmacy' and finished_at is null and deleted_at is null;
  select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
  if v_q.return_station is not null then
    if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = v_q.return_station
                   and finished_at is null and deleted_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no, priority, assigned_to, referred_by, referral_note)
      values (p_encounter_id, v_q.return_station, coalesce(v_ticket, 'A-000'), v_q.priority,
              active_staff_or_null(v_q.return_to), auth.uid(), 'Medicines handed over');
    end if;
    return;
  end if;
  -- a doctor, nurse or the lab still has the patient: they carry on
  if exists (select 1 from queue_entry q where q.encounter_id = p_encounter_id and q.finished_at is null
             and q.deleted_at is null and station_role(q.station) in ('doctor', 'nurse', 'lab_tech', 'sonographer')) then
    return;
  end if;
  if exists (select 1 from invoice i where i.encounter_id = p_encounter_id and invoice_balance(i.id) > 0) then
    if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'cashier'
                   and finished_at is null and deleted_at is null) then
      insert into queue_entry (encounter_id, station, ticket_no, referred_by, referral_note)
      values (p_encounter_id, 'cashier', coalesce(v_ticket, 'A-000'), auth.uid(), 'Medicines handed over');
    end if;
  else
    perform settle_visit(p_encounter_id);
  end if;
end
$$;

-- ---------------------------------------------------------------- back from the lab or ultrasound
-- The results go back to whoever asked; to the section when that person no longer works here.
create or replace function after_desk_tests(p_encounter_id uuid, p_station station, p_requester uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_q queue_entry%rowtype;
  v_back station;
  v_to uuid;
  v_tests text;
begin
  if exists (select 1 from service_request r
             where r.encounter_id = p_encounter_id and r.deleted_at is null
               and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) = p_station
               and r.status not in ('resulted', 'verified', 'cancelled')) then
    return;
  end if;
  select * into v_q from queue_entry
  where encounter_id = p_encounter_id and station = p_station and finished_at is null and deleted_at is null
  order by created_at desc limit 1;
  if not found then
    return;
  end if;
  v_back := v_q.return_station;
  v_to := v_q.return_to;
  if v_back is null and p_requester is not null then
    v_to := p_requester;
    select q.station into v_back from queue_entry q
    where q.encounter_id = p_encounter_id and q.station <> p_station
      and (q.taken_by = p_requester or q.assigned_to = p_requester)
    order by q.created_at desc limit 1;
    if v_back is null then
      select case p.role when 'doctor' then 'consultation'::station when 'nurse' then 'nursing'::station end
      into v_back from profiles p where p.id = p_requester;
    end if;
  end if;
  -- someone who left the clinic (deactivated or deleted): anyone in the section takes the patient
  v_to := active_staff_or_null(v_to);
  if v_back is null then
    -- nobody asked for the patient back (came straight to the lab): the lab's part is over;
    -- on to the cashier if money is due, otherwise the visit ends when nothing else is left
    update queue_entry set finished_at = now() where id = v_q.id;
    if exists (select 1 from queue_entry q where q.encounter_id = p_encounter_id and q.finished_at is null
               and q.deleted_at is null and station_role(q.station) in ('doctor', 'nurse', 'lab_tech', 'sonographer')) then
      return;
    end if;
    if exists (select 1 from invoice i where i.encounter_id = p_encounter_id and invoice_balance(i.id) > 0) then
      if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'cashier'
                     and finished_at is null and deleted_at is null) then
        insert into queue_entry (encounter_id, station, ticket_no, priority, referred_by, referral_note)
        values (p_encounter_id, 'cashier', v_q.ticket_no, v_q.priority, auth.uid(), 'Tests done');
      end if;
    else
      perform settle_visit(p_encounter_id);
    end if;
    return;
  end if;
  update queue_entry set finished_at = now() where id = v_q.id;
  if not exists (select 1 from queue_entry where encounter_id = p_encounter_id
                 and station = v_back and finished_at is null and deleted_at is null) then
    select string_agg(s.name_en || case when r.status = 'cancelled' then ' (not done)' else '' end, ', ' order by r.created_at)
    into v_tests
    from service_request r join service s on s.id = r.service_id
    where r.encounter_id = p_encounter_id and r.deleted_at is null
      and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) = p_station
      and (r.status in ('resulted', 'verified') or (r.status = 'cancelled' and r.updated_at > now() - interval '1 day'));
    insert into queue_entry (encounter_id, station, ticket_no, priority, assigned_to, referred_by, referral_note)
    values (p_encounter_id, v_back, v_q.ticket_no, v_q.priority, v_to, auth.uid(),
            'Results ready: ' || coalesce(v_tests, ''));
  end if;
end
$$;

-- ---------------------------------------------------------------- delete, keep the records
create or replace function retire_staff(p_profile_id uuid, p_by uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_p profiles%rowtype;
  v_waiting integer;
  v_returning integer;
begin
  select * into v_p from profiles where id = p_profile_id for update;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  if v_p.deleted_at is not null then
    raise exception 'this account is already deleted' using errcode = '23505';
  end if;
  if p_profile_id = p_by then
    raise exception 'you cannot delete your own account' using errcode = '42501';
  end if;
  if v_p.role = 'manager' and not exists (
       select 1 from profiles where role = 'manager' and active and deleted_at is null and id <> p_profile_id) then
    raise exception 'the clinic needs at least one manager' using errcode = '42501';
  end if;

  -- patients and work waiting for them go back to the desk (anyone there may take them)
  update queue_entry set assigned_to = null
  where assigned_to = p_profile_id and finished_at is null and deleted_at is null;
  get diagnostics v_waiting = row_count;
  update queue_entry set taken_by = null, started_at = null
  where taken_by = p_profile_id and finished_at is null and deleted_at is null;
  -- patients at the lab, ultrasound or pharmacy who were to come back to them: back to the section
  update queue_entry set return_to = null
  where return_to = p_profile_id and finished_at is null and deleted_at is null;
  get diagnostics v_returning = row_count;
  v_waiting := v_waiting + v_returning;
  update encounter set intended_to = null where intended_to = p_profile_id and status = 'open';
  -- their calls still open ("send me the next patient", a request for help, to or from them):
  -- withdrawn with their notices, so nobody sends a patient to them any more
  delete from notification where kind in ('call_next', 'help') and params ->> 'call' in (
    select id::text from staff_call
    where status in ('open', 'accepted')
      and (from_user = p_profile_id or to_user = p_profile_id or answered_by = p_profile_id));
  update staff_call
  set status = case when status = 'accepted' then 'done' else 'cancelled' end, closed_at = now()
  where status in ('open', 'accepted')
    and (from_user = p_profile_id or to_user = p_profile_id or answered_by = p_profile_id);
  update internal_task set assigned_to = null,
         assigned_role = coalesce(assigned_role, v_p.role::text::role_key)
  where assigned_to = p_profile_id and done_at is null and deleted_at is null;
  update clinician_cover set ended_at = now()
  where (doctor_id = p_profile_id or nurse_id = p_profile_id) and ended_at is null;
  -- their calendar leaves the website and the booking lists
  update practitioner set calendar_visibility = 'private', active = false where user_id = p_profile_id;

  -- what belonged to the account only
  delete from staff_department where profile_id = p_profile_id;
  delete from staff_permission where profile_id = p_profile_id;
  delete from trusted_device where user_id = p_profile_id;
  delete from staff_temp_pin where user_id = p_profile_id;
  delete from login_request where user_id = p_profile_id;
  delete from notification where recipient_user = p_profile_id;

  -- the former employee: name, role and staff ID stay on every record
  update profiles
  set active = false,
      deactivated_at = coalesce(deactivated_at, now()),
      deleted_at = now(),
      deleted_by = p_by,
      dashboard = null,
      head_of = null,
      department_id = null,
      position = 'member',
      email = null,
      username = 'former.' || lower(coalesce(staff_id, left(id::text, 8)))
  where id = p_profile_id;

  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (p_by, 'delete', 'profiles', p_profile_id,
          jsonb_build_object('name', v_p.full_name, 'staff_id', v_p.staff_id, 'role', v_p.role,
                             'patients_back_to_desk', v_waiting));
  return jsonb_build_object('name', v_p.full_name, 'staffId', v_p.staff_id, 'patientsBack', v_waiting);
end
$$;
revoke all on function retire_staff(uuid, uuid) from public, anon, authenticated;
grant execute on function retire_staff(uuid, uuid) to service_role;

-- ---------------------------------------------------------------- answering "send me the next patient"
-- A call left by someone who no longer works here (deactivated or deleted) cannot be answered:
-- the patient would wait for nobody.
create or replace function answer_call(p_call_id uuid, p_queue_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_c staff_call%rowtype;
  v_q queue_entry%rowtype;
  v_me role_key := current_role_key();
  v_id uuid;
begin
  select * into v_c from staff_call where id = p_call_id and kind = 'next' for update;
  if not found or v_c.status <> 'open' then
    raise exception 'this call was already answered or cancelled' using errcode = '23505';
  end if;
  if not (v_me = 'manager'
          or (v_c.target = 'reception' and v_me = 'receptionist')
          or (v_c.target = 'nurse' and v_me = 'nurse')
          or (v_c.target = 'person' and v_c.to_user = auth.uid())) then
    raise exception 'this call is not for you' using errcode = '42501';
  end if;
  if active_staff_or_null(v_c.from_user) is null then
    raise exception 'the colleague who called no longer works here' using errcode = '22023';
  end if;
  select * into v_q from queue_entry where id = p_queue_id and deleted_at is null and finished_at is null for update;
  if not found or not exists (select 1 from encounter where id = v_q.encounter_id and status = 'open') then
    raise exception 'that patient is no longer waiting' using errcode = 'P0002';
  end if;
  -- only a patient waiting for a doctor, at triage or reception: not one in the middle of a
  -- test, a treatment or the bill
  if v_c.station in ('laboratory', 'ultrasound', 'pharmacy', 'cashier', 'nursing', 'beds')
     and v_q.station <> v_c.station then
    raise exception 'only a patient already sent to % can be called there', initcap(v_c.station::text) using errcode = '22023';
  end if;
  if v_q.station <> coalesce(v_c.station, v_q.station)
     and v_q.station not in ('triage', 'reception', 'consultation', 'dental') then
    raise exception 'that patient is at % (not waiting for a doctor)', initcap(v_q.station::text) using errcode = '22023';
  end if;
  if v_q.taken_by is not null or (v_q.assigned_to is not null and v_q.assigned_to <> v_c.from_user) then
    raise exception 'that patient is already with %', coalesce(patient_holder(v_q.encounter_id), 'someone')
      using errcode = '23505';
  end if;
  if v_q.station = coalesce(v_c.station, v_q.station) then
    update queue_entry set assigned_to = v_c.from_user, department_id = null, referred_by = auth.uid()
    where id = v_q.id returning id into v_id;
  else
    -- waiting at another desk (e.g. triage done): they leave it for the caller's desk
    update queue_entry set finished_at = now() where id = v_q.id;
    update queue_entry set assigned_to = v_c.from_user, department_id = null, referred_by = auth.uid()
    where encounter_id = v_q.encounter_id and station = v_c.station and finished_at is null and deleted_at is null
    returning id into v_id;
    if v_id is null then
      insert into queue_entry (encounter_id, station, ticket_no, priority, assigned_to, referred_by)
      values (v_q.encounter_id, v_c.station, v_q.ticket_no, v_q.priority, v_c.from_user, auth.uid())
      returning id into v_id;
    end if;
  end if;
  -- a patient shared between several desks leaves the others
  if v_q.pool_id is not null then
    update queue_entry set finished_at = now()
    where pool_id = v_q.pool_id and id <> v_q.id and id <> v_id and finished_at is null;
  end if;
  update staff_call
  set status = 'answered', answered_by = auth.uid(), answered_at = now(), closed_at = now(),
      encounter_id = v_q.encounter_id
  where id = p_call_id;
  delete from notification where kind = 'call_next' and params ->> 'call' = p_call_id::text;
  return jsonb_build_object('encounterId', v_q.encounter_id, 'queueId', v_id);
end
$$;

-- What deleting this employee touches, for the manager to read before confirming.
create or replace function retire_staff_preview(p_profile_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if not is_manager() then
    raise exception 'managers only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    -- notices and messages addressed to them: deleted with the account
    'notices', (select count(*)::int from notification where recipient_user = p_profile_id),
    -- bookings in their calendar from today on: they stay booked to a calendar no longer shown
    'upcomingAppointments', (
      select count(*)::int from appointment a
      join practitioner pr on pr.id = a.practitioner_id
      where pr.user_id = p_profile_id and a.deleted_at is null
        and a.status not in ('cancelled', 'no_show', 'completed', 'rejected', 'declined')
        and (a.starts_at at time zone 'Africa/Kigali')::date >= (now() at time zone 'Africa/Kigali')::date),
    -- patients waiting for them, with them, or to come back to them: back to the section
    'waitingPatients', (
      select count(distinct q.encounter_id)::int from queue_entry q
      where q.finished_at is null and q.deleted_at is null
        and (q.assigned_to = p_profile_id or q.taken_by = p_profile_id or q.return_to = p_profile_id)),
    -- tasks still to do: back to their role
    'openTasks', (select count(*)::int from internal_task
                  where assigned_to = p_profile_id and done_at is null and deleted_at is null));
end
$$;
revoke all on function retire_staff_preview(uuid) from public, anon;
grant execute on function retire_staff_preview(uuid) to authenticated;

-- ---------------------------------------------------------------- the cashier's figures by period
-- The money of the period (p_from, p_to; both default to p_day, or today), compared with the
-- period just before, as long. The cash count (what I should hold, the counts) stays about one
-- day: p_day, or the end of the period. A call with p_day only works as before.
drop function if exists cashier_summary(date);

create or replace function cashier_summary(p_day date default null, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, p_day, v_today);
  v_to date := coalesce(p_to, p_day, p_from, v_today);
  v_day date;
  v_len integer;
begin
  if not has_perm('billing.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  v_day := coalesce(p_day, v_to);
  v_len := v_to - v_from + 1;
  return jsonb_build_object(
    'day', v_day,
    'from', v_from,
    'to', v_to,
    'total', (select coalesce(sum(amount), 0) from payment
              where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'count', (select count(*) from payment
              where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    -- the period just before, as long (up to the same time of day while the period runs to today)
    'previousTotal', (select coalesce(sum(amount), 0) from payment
                      where deleted_at is null
                        and (paid_at at time zone 'Africa/Kigali')::date between v_from - v_len and v_from - 1
                        and (v_to <> v_today or paid_at <= now() - make_interval(days => v_len))),
    -- patients the cashier desk finished with in the period
    'served', (select count(distinct q.encounter_id) from queue_entry q
               where q.deleted_at is null and q.station = 'cashier' and q.finished_at is not null
                 and (q.finished_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    -- money given back in the period
    'refunded', (select coalesce(sum(amount), 0) from refund
                 where deleted_at is null and (refunded_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'refunds', coalesce((
      select jsonb_agg(x.j order by x.at desc) from (
        select r.refunded_at as at, jsonb_build_object(
            'id', r.id, 'at', r.refunded_at, 'method', r.method, 'amount', r.amount, 'reference', r.reference,
            'reason', r.reason, 'patient', p.surname || ' ' || p.given_names,
            'cashier', (select full_name from profiles where id = r.cashier_id), 'mine', r.cashier_id = auth.uid()
          ) as j
        from refund r
        join invoice i on i.id = r.invoice_id
        join encounter e on e.id = i.encounter_id
        join patient p on p.id = e.patient_id
        where r.deleted_at is null and (r.refunded_at at time zone 'Africa/Kigali')::date between v_from and v_to
        order by r.refunded_at desc limit 500) x
    ), '[]'::jsonb),
    -- money still owed on visits already over
    'debts', (select count(*) from invoice i join encounter e on e.id = i.encounter_id
              where i.deleted_at is null and e.status <> 'open' and invoice_balance(i.id) > 0),
    'debtsDue', (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id
                 where i.deleted_at is null and e.status <> 'open' and invoice_balance(i.id) > 0),
    'mine', (select coalesce(sum(amount), 0) from payment
             where deleted_at is null and cashier_id = auth.uid()
               and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'byMethod', coalesce((
      select jsonb_agg(jsonb_build_object('method', m.method, 'amount', m.amount, 'count', m.n) order by m.amount desc)
      from (select method::text as method, sum(amount) as amount, count(*) as n from payment
            where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
            group by method) m
    ), '[]'::jsonb),
    'byCashier', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.name, 'amount', c.amount, 'count', c.n) order by c.amount desc)
      from (select coalesce(pr.full_name, '—') as name, sum(pa.amount) as amount, count(*) as n
            from payment pa left join profiles pr on pr.id = pa.cashier_id
            where pa.deleted_at is null and (pa.paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
            group by pr.full_name) c
    ), '[]'::jsonb),
    -- the payments of the period (the latest 500 over a long period; the totals count them all)
    'payments', coalesce((
      select jsonb_agg(x.j order by x.at desc) from (
        select pa.paid_at as at, jsonb_build_object(
            'id', pa.id, 'at', pa.paid_at, 'method', pa.method, 'amount', pa.amount, 'reference', pa.reference,
            'invoice', i.number, 'encounterId', i.encounter_id,
            'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
            'cashier', pr.full_name, 'receipt', pa.receipt_no,
            'mine', pa.cashier_id = auth.uid(), 'counted', pa.day_close_id is not null
          ) as j
        from payment pa
        join invoice i on i.id = pa.invoice_id
        join encounter e on e.id = i.encounter_id
        join patient p on p.id = e.patient_id
        left join profiles pr on pr.id = pa.cashier_id
        where pa.deleted_at is null and (pa.paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
        order by pa.paid_at desc limit 500) x
    ), '[]'::jsonb),
    -- payments of the period that were cancelled, and why
    'voided', coalesce((
      select jsonb_agg(x.j order by x.at desc) from (
        select pa.voided_at as at, jsonb_build_object(
            'id', pa.id, 'at', pa.paid_at, 'method', pa.method, 'amount', pa.amount, 'receipt', pa.receipt_no,
            'patient', p.surname || ' ' || p.given_names, 'reason', pa.void_reason,
            'by', (select full_name from profiles where id = pa.voided_by), 'voidedAt', pa.voided_at
          ) as j
        from payment pa
        join invoice i on i.id = pa.invoice_id
        join encounter e on e.id = i.encounter_id
        join patient p on p.id = e.patient_id
        where pa.deleted_at is not null and pa.voided_at is not null
          and (pa.paid_at at time zone 'Africa/Kigali')::date between v_from and v_to
        order by pa.voided_at desc limit 500) x
    ), '[]'::jsonb),
    -- the cash counted at the end of the day, per cashier
    'closes', coalesce((
      select jsonb_agg(jsonb_build_object(
          'cashier', pr.full_name, 'mine', d.cashier_id = auth.uid(), 'expected', d.expected,
          'counted', d.counted, 'variance', d.variance, 'note', d.note, 'at', d.updated_at
        ) order by pr.full_name)
      from day_close d left join profiles pr on pr.id = d.cashier_id
      where d.deleted_at is null and d.date = v_day
    ), '[]'::jsonb),
    -- what I should hold that day, per method
    'myExpected', coalesce((
      select jsonb_object_agg(n.method, n.amount) from (select m.method, sum(m.amount) as amount from (
          select method::text as method, amount from payment
          where deleted_at is null and cashier_id = auth.uid() and (paid_at at time zone 'Africa/Kigali')::date = v_day
          union all
          select method::text, -amount from refund
          where deleted_at is null and cashier_id = auth.uid() and (refunded_at at time zone 'Africa/Kigali')::date = v_day
        ) m group by m.method) n
    ), '{}'::jsonb),
    'openBills', (select count(*) from invoice i join encounter e on e.id = i.encounter_id
                  where i.deleted_at is null and i.status = 'draft' and e.status = 'open' and invoice_balance(i.id) > 0),
    'openDue', (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id
                where i.deleted_at is null and i.status = 'draft' and e.status = 'open' and invoice_balance(i.id) > 0)
  );
end
$$;
revoke all on function cashier_summary(date, date, date) from public, anon;
grant execute on function cashier_summary(date, date, date) to authenticated;

-- ---------------------------------------------------------------- the doctor's lists by period
-- With p_from: the tests ordered / prescriptions written from p_from to p_to (Kigali days; p_to
-- defaults to p_from); without: the last p_days days, as before.
drop function if exists my_orders(integer);
drop function if exists my_prescriptions(integer);

create or replace function my_orders(p_days integer default 7, p_from date default null, p_to date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb)
  from (
    select r.created_at as at, jsonb_build_object(
      'id', r.id, 'encounterId', r.encounter_id, 'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'test', s.name_en,
      'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end),
      'status', r.status, 'priority', r.priority, 'reason', r.reason, 'orderedAt', r.created_at,
      'findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
      'resultAt', coalesce(d.verified_at, d.updated_at),
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
      'visitOpen', e.status = 'open') as j
    from service_request r
    join encounter e on e.id = r.encounter_id
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and r.requester_id = auth.uid()
      and case when p_from is not null
            then (r.created_at at time zone 'Africa/Kigali')::date between p_from and coalesce(p_to, p_from)
            else r.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90))) end
    order by r.created_at desc
    limit 500
  ) x
$$;

create or replace function my_prescriptions(p_days integer default 7, p_from date default null, p_to date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb)
  from (
    select m.created_at as at, jsonb_build_object(
      'id', m.id, 'encounterId', m.encounter_id, 'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'item', i.name_generic || coalesce(' ' || i.strength, ''), 'quantity', m.quantity,
      'dose', m.dose, 'frequency', m.frequency, 'days', m.duration_days, 'instructions', m.instructions,
      'supply', m.supply, 'at', m.created_at,
      'state', case
                 when m.not_given_at is not null then 'not_given'
                 when m.supply = 'room' then 'room'
                 when m.given_at is not null
                      or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null)
                   then 'given'
                 else 'waiting' end,
      'givenAt', m.given_at, 'notGivenReason', m.not_given_reason,
      'visitOpen', e.status = 'open') as j
    from medication_request m
    join encounter e on e.id = m.encounter_id
    join patient p on p.id = e.patient_id
    join item i on i.id = m.item_id
    where m.deleted_at is null and coalesce(m.prescriber_id, m.created_by) = auth.uid()
      and case when p_from is not null
            then (m.created_at at time zone 'Africa/Kigali')::date between p_from and coalesce(p_to, p_from)
            else m.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90))) end
    order by m.created_at desc
    limit 500
  ) x
$$;

revoke all on function my_orders(integer, date, date), my_prescriptions(integer, date, date) from public, anon;
grant execute on function my_orders(integer, date, date), my_prescriptions(integer, date, date) to authenticated;

-- ---------------------------------------------------------------- the pharmacy: stock in other stores
-- Each line also says how much usable stock the other stores hold (to send it across instead of
-- receiving it again) and which store is the pharmacy.
create or replace function pharmacy_queue()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'requestId', m.id, 'encounterId', m.encounter_id, 'patientId', p.id, 'patient', p.surname || ' ' || p.given_names,
    'file', p.file_number,
    'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = m.encounter_id order by q.created_at limit 1),
    'itemId', m.item_id, 'item', i.name_generic || coalesce(' ' || i.strength, ''), 'unit', i.selling_unit,
    'quantity', m.quantity, 'dose', m.dose, 'frequency', m.frequency, 'days', m.duration_days,
    'instructions', m.instructions, 'prescriber', pr.full_name, 'at', m.created_at,
    'price', (select pf.price from price_for(null, m.item_id, null) pf),
    'onHandPharmacy', (select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s
                       join stock_location l on l.id = s.location_id
                       where s.item_id = m.item_id and l.type = 'pharmacy' and l.active and l.deleted_at is null
                         and (s.expiry is null or s.expiry >= current_date)),
    'expiredInPharmacy', (select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s
                          join stock_location l on l.id = s.location_id
                          where s.item_id = m.item_id and l.type = 'pharmacy' and s.expiry < current_date),
    'onHandElsewhere', (select coalesce(sum(s.quantity), 0)::integer from stock_on_hand s
                        join stock_location l on l.id = s.location_id
                        where s.item_id = m.item_id and l.type <> 'pharmacy' and l.active and l.deleted_at is null
                          and (s.expiry is null or s.expiry >= current_date)),
    'pharmacyLocationId', ph.id,
    'doctorHolds', exists (select 1 from queue_entry q where q.encounter_id = m.encounter_id and q.finished_at is null
                           and q.deleted_at is null and station_role(q.station) = 'doctor')
  ) order by m.created_at), '[]'::jsonb)
  from medication_request m
  join encounter e on e.id = m.encounter_id and e.status = 'open'
  join patient p on p.id = e.patient_id
  join item i on i.id = m.item_id
  left join profiles pr on pr.id = coalesce(m.prescriber_id, m.created_by)
  left join lateral (select l.id from stock_location l
                     where l.type = 'pharmacy' and l.active and l.deleted_at is null
                     order by l.created_at limit 1) ph on true
  where has_perm('stock.read') and rx_pending(m)
$$;
