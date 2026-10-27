-- 0101 · A booking is "Seen" only when the patient really was seen.
--
-- Before: any visit that closed marked its booking completed ("Seen"), also a visit closed with
-- "Patient has left" before any clinician took the patient. The owner saw bookings marked Seen
-- although nobody had treated the patient.
--
-- Now, when a booked visit closes:
--   * seen (a diagnosis was written, the clinical part was finished, or someone took the patient
--     at a treating desk)            → the booking is completed ("Seen");
--   * not seen (left before any of that) → the booking is cancelled with the reason
--     "left_unseen" (the screens say "Left before being seen", with the reason given if any).
-- Bookings already marked completed without such a visit are corrected the same way; one with
-- no visit at all goes back to confirmed (today or later) or to "did not come" (past days).

-- ---------------------------------------------------------------- the rule
create or replace function visit_was_seen(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from encounter e where e.id = p_encounter_id and e.clinical_done_at is not null)
      or exists (select 1 from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null)
      or exists (select 1 from queue_entry q
                 where q.encounter_id = p_encounter_id and q.deleted_at is null and q.started_at is not null
                   and q.station not in ('reception', 'triage', 'cashier', 'pharmacy'))
$$;
revoke all on function visit_was_seen(uuid) from public, anon;
grant execute on function visit_was_seen(uuid) to authenticated;

-- appointment_follows_visit (from 20261102120000_desks_connected): completed only when seen.
create or replace function appointment_follows_visit()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'closed' and old.status is distinct from 'closed' and new.appointment_id is not null then
    if visit_was_seen(new.id) then
      update appointment set status = 'completed'
      where id = new.appointment_id and status in ('approved', 'confirmed', 'arrived', 'in_progress');
    else
      update appointment
      set status = 'cancelled',
          cancel_reason = 'left_unseen' || coalesce(': ' || nullif(trim(new.left_reason), ''), '')
      where id = new.appointment_id and status in ('approved', 'confirmed', 'arrived', 'in_progress');
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists encounter_appointment_done on encounter;
create trigger encounter_appointment_done after update of status on encounter
  for each row execute function appointment_follows_visit();

-- ---------------------------------------------------------------- the bookings already wrong
-- completed, its visit closed without being seen
update appointment a
set status = 'cancelled',
    cancel_reason = 'left_unseen' || coalesce(': ' || nullif(trim(e.left_reason), ''), '')
from encounter e
where e.appointment_id = a.id and a.status = 'completed' and a.deleted_at is null
  and e.status = 'closed' and not visit_was_seen(e.id);

-- completed while its visit is still open: back to where the visit is
update appointment a
set status = case when visit_was_seen(e.id) then 'in_progress'::appointment_status else 'arrived'::appointment_status end
from encounter e
where e.appointment_id = a.id and a.status = 'completed' and a.deleted_at is null and e.status = 'open';

-- completed with no visit at all
update appointment a
set status = case when (a.starts_at at time zone 'Africa/Kigali')::date >= (now() at time zone 'Africa/Kigali')::date
                  then 'confirmed'::appointment_status
                  else 'no_show'::appointment_status end
where a.status = 'completed' and a.deleted_at is null
  and not exists (select 1 from encounter e where e.appointment_id = a.id);

-- ---------------------------------------------------------------- the day list says why
-- appointments_day (from 20261128090000_switches_enforced): a cancelled booking carries its reason,
-- so "left before being seen" shows on the Bookings day list too.
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
      'cancelReason', case when a.status = 'cancelled' then a.cancel_reason end,
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
  where (has_perm('appointment.read') or has_perm('appointment.approve')) and a.deleted_at is null
    and a.status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed', 'no_show', 'cancelled', 'declined')
    and (a.starts_at at time zone 'Africa/Kigali')::date = coalesce(p_day, (now() at time zone 'Africa/Kigali')::date)
$$;

-- ---------------------------------------------------------------- "with the clinician"
-- take_patient (from 20261102210000_desks_polished): a booking turns "in progress" only when a
-- clinician takes the patient at a treating desk, not at triage, reception, the cashier or the pharmacy.
create or replace function take_patient(p_queue_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_q queue_entry%rowtype;
  v_by text;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_q from queue_entry where id = p_queue_id and deleted_at is null;
  if not found then
    raise exception 'queue entry not found' using errcode = 'P0002';
  end if;
  -- Lock the whole pool so two doctors cannot take the same patient at the same moment.
  perform 1 from queue_entry
  where (pool_id is not null and pool_id = v_q.pool_id) or id = v_q.id
  for update;
  select * into v_q from queue_entry where id = p_queue_id;
  if v_q.finished_at is not null then
    select pr.full_name into v_by from queue_entry q join profiles pr on pr.id = q.taken_by
    where q.pool_id = v_q.pool_id and q.taken_by is not null limit 1;
    raise exception 'already taken by %', coalesce(v_by, 'another desk') using errcode = '23505';
  end if;
  if v_q.taken_by is not null and v_q.taken_by <> auth.uid() then
    select full_name into v_by from profiles where id = v_q.taken_by;
    raise exception 'already taken by %', coalesce(v_by, 'another doctor') using errcode = '23505';
  end if;
  if not queue_entry_for_me(p_queue_id) then
    raise exception 'this patient was sent to %', coalesce(patient_holder(v_q.encounter_id), 'another desk')
      using errcode = '42501';
  end if;
  update queue_entry
  set called_at = coalesce(called_at, now()), started_at = coalesce(started_at, now()),
      taken_by = auth.uid()
  where id = p_queue_id;
  if v_q.pool_id is not null then
    update queue_entry set finished_at = now()
    where pool_id = v_q.pool_id and id <> p_queue_id and finished_at is null;
  end if;
  -- the doctor who takes the patient is the visit's treating doctor; a booking is now in progress
  if current_role_key() = 'doctor' then
    update encounter set practitioner_id = coalesce(practitioner_id, ensure_practitioner(auth.uid()))
    where id = v_q.encounter_id;
  end if;
  update appointment set status = 'in_progress'
  where id = (select appointment_id from encounter where id = v_q.encounter_id) and status = 'arrived'
    and v_q.station not in ('reception', 'triage', 'cashier', 'pharmacy');
  return jsonb_build_object('encounterId', v_q.encounter_id, 'station', v_q.station);
end
$$;
