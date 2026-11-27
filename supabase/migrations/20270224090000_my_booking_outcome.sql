-- 0208 · My bookings: the doctor closes his own missed bookings (Frank, 2026-11-27: "for those who
-- did not come am unable to perform some actions like delete the booking for those who will not
-- come who have confirmed and also for those that we may book another time").
--
-- set_appointment_outcome (20261104090000_desks_last_items) marks a booking "did not come" (no_show) or
-- cancelled (with the reason). Until now only reception (appointment.write) could; the doctor got
-- "not allowed". Now the booking's own doctor (the person whose calendar holds it) and the manager
-- may too. Every other rule stays: only a booking still booked or confirmed, the reason for a
-- cancellation, no "did not come" for a booking still to come. A cancelled booking is kept in the
-- history (cancelled), never erased.
--
-- undo_no_show: a wrong "did not come" is taken back by the same people, while the booking's time
-- has passed and no visit was opened from it: the booking goes back to what it was before
-- (booked or confirmed, as its history says; confirmed when the history says nothing).
--
-- Moving a missed booking to a new time is change_booking (0125): already allowed to the booking's
-- doctor, reception and the manager, for a booked or confirmed booking, to a time still to come.

create or replace function set_appointment_outcome(p_appointment_id uuid, p_status appointment_status, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  -- reception, the manager, or the doctor whose calendar holds the booking
  if not (has_perm('appointment.write') or is_manager()
          or exists (select 1 from appointment a join practitioner pr on pr.id = a.practitioner_id
                     where a.id = p_appointment_id and a.deleted_at is null
                       and pr.user_id = auth.uid())) then
    raise exception 'not allowed: a booking is closed by its doctor, reception or the manager' using errcode = '42501';
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

create or replace function undo_no_show(p_appointment_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_a appointment%rowtype;
  v_owner uuid;
  v_back appointment_status;
begin
  select * into v_a from appointment where id = p_appointment_id and deleted_at is null for update;
  if not found then
    raise exception 'booking not found' using errcode = 'P0002';
  end if;
  select user_id into v_owner from practitioner where id = v_a.practitioner_id;
  if not (has_perm('appointment.write') or is_manager()
          or (auth.uid() is not null and v_owner = auth.uid())) then
    raise exception 'not allowed: a booking is closed by its doctor, reception or the manager' using errcode = '42501';
  end if;
  if v_a.status <> 'no_show' or coalesce(v_a.starts_at > now(), true) then
    raise exception 'only a past booking marked as not come can be taken back' using errcode = '22023';
  end if;
  if exists (select 1 from encounter e where e.appointment_id = p_appointment_id and e.deleted_at is null) then
    raise exception 'the patient came: a visit was opened from this booking' using errcode = '22023';
  end if;
  -- what it was before "did not come" (its history), confirmed when the history says nothing
  select (h.before ->> 'status')::appointment_status into v_back
  from audit_event h
  where h.entity = 'appointment' and h.entity_id = p_appointment_id and h.action = 'update'
    and h.after ->> 'status' = 'no_show' and h.before ->> 'status' in ('approved', 'confirmed')
  order by h.at desc
  limit 1;
  v_back := coalesce(v_back, 'confirmed');
  update appointment set status = v_back where id = p_appointment_id;
  return jsonb_build_object('id', p_appointment_id, 'status', v_back);
end
$$;

revoke all on function undo_no_show(uuid) from public, anon;
grant execute on function undo_no_show(uuid) to authenticated;
