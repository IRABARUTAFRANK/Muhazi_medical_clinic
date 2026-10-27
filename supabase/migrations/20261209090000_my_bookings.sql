-- 0099 · My bookings: the bookings made with a person who keeps a calendar.
--
-- Frank (owner): a booking made with a doctor, sonographer, nurse or the manager is accepted,
-- moved or declined by that person. They could only do it from the notice or from "Bookings to
-- accept" on Home; nothing listed THEIR OWN bookings over the coming weeks (the Bookings page is
-- reception's desk page, for booking other people).
--
--   * my_bookings(p_from, p_to, p_user default null): the caller's bookings (practitioner rows of
--     the caller) whose time falls on a day from p_from to p_to (Kigali days; default the last 30
--     days to 3 weeks ahead, at most 120 days), plus every booking still waiting for their answer
--     (approved, not more than a day past) whatever its day. The manager may pass p_user to see
--     another practitioner's. Each row carries the patient (or the contact of a website request),
--     the phone, the reason, who booked it and who accepted it, the visit opened on arrival and
--     the history of the booking (created, each change of state or of time, from audit_event).
--     Returns { userId, name, slotMinutes, rows: [...] }; no calendar yet: rows is empty.
--   * Who may: whoever answers bookings (appointment.accept: doctors, sonographers, nurses, the
--     manager) or the manager.

create or replace function my_bookings(p_from date default null, p_to date default null, p_user uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today - 30);
  v_to date := coalesce(p_to, v_today + 21);
  v_user uuid := coalesce(p_user, auth.uid());
  v_rows jsonb;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not (has_perm('appointment.accept') or is_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_user <> auth.uid() and not is_manager() then
    raise exception 'only the manager sees the bookings of a colleague' using errcode = '42501';
  end if;
  if v_to < v_from then
    raise exception 'the end of the period is before its start' using errcode = '22023';
  end if;
  if v_to - v_from > 120 then
    v_to := v_from + 120;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'status', a.status, 'startsAt', a.starts_at, 'endsAt', a.ends_at,
      'reason', a.reason, 'category', a.category, 'source', a.source, 'reference', a.reference,
      'channel', a.contact_channel, 'cancelReason', a.cancel_reason, 'createdAt', a.created_at,
      'patientId', p.id, 'fileNumber', p.file_number,
      'name', coalesce(p.surname || ' ' || p.given_names, a.contact_name, ''),
      'phone', coalesce(p.phone_1, a.contact_phone),
      'bookedBy', ap.full_name, 'bookedAt', a.approved_at,
      'acceptedBy', ac.full_name, 'acceptedAt', a.accepted_at,
      'encounterId', (select e.id from encounter e where e.appointment_id = a.id
                      order by e.created_at desc limit 1),
      'late', a.status in ('approved', 'confirmed') and a.starts_at < now() - interval '15 minutes',
      'history', coalesce((
        select jsonb_agg(jsonb_build_object(
            'at', h.at, 'by', who.full_name,
            'status', h.after ->> 'status',
            'startsAt', h.after ->> 'starts_at',
            'moved', h.action = 'update'
                     and (h.before ->> 'starts_at') is distinct from (h.after ->> 'starts_at')
          ) order by h.at)
        from audit_event h
        left join profiles who on who.id = h.actor_id
        where h.entity = 'appointment' and h.entity_id = a.id
          and (h.action = 'create'
               or (h.action = 'update'
                   and ((h.before ->> 'status') is distinct from (h.after ->> 'status')
                        or (h.before ->> 'starts_at') is distinct from (h.after ->> 'starts_at'))))
      ), '[]'::jsonb)
    ) order by a.starts_at), '[]'::jsonb)
  into v_rows
  from appointment a
  join practitioner pr on pr.id = a.practitioner_id and pr.user_id = v_user
  left join patient p on p.id = a.patient_id
  left join profiles ap on ap.id = a.approved_by
  left join profiles ac on ac.id = a.accepted_by
  where a.deleted_at is null
    and a.status not in ('inquiry', 'rejected')
    and a.starts_at is not null
    and (((a.starts_at at time zone 'Africa/Kigali')::date between v_from and v_to)
         or (a.status = 'approved' and a.starts_at > now() - interval '1 day'));

  return jsonb_build_object(
    'userId', v_user,
    'name', (select full_name from profiles where id = v_user),
    'slotMinutes', coalesce((select slot_minutes from practitioner
                             where user_id = v_user and deleted_at is null limit 1), 30),
    'from', v_from, 'to', v_to,
    'rows', v_rows
  );
end
$$;

revoke all on function my_bookings(date, date, uuid) from public, anon;
grant execute on function my_bookings(date, date, uuid) to authenticated;
