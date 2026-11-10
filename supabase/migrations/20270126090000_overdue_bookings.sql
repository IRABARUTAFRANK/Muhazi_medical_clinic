-- 0153: overdue bookings. A booking request whose asked-for time has passed, and a booked
-- appointment whose time has passed (15 minutes) without the patient arriving, are "overdue":
-- reception is told once for each (notice appt_overdue), and the Bookings page lists them apart
-- in "Late and overdue" (left-hand side), with Book another time / Reject for a request and
-- Arrived / No-show / Cancel / Book again for a booking.

alter table appointment add column if not exists overdue_notified_at timestamptz;

-- a new time asked for or booked: the booking may become overdue (and be told) again
create or replace function appointment_overdue_reset()
returns trigger
language plpgsql
as $$
begin
  if new.starts_at is distinct from old.starts_at
     or new.preferred_at is distinct from old.preferred_at then
    new.overdue_notified_at := null;
  end if;
  return new;
end
$$;
drop trigger if exists appointment_overdue_reset on appointment;
create trigger appointment_overdue_reset
  before update on appointment
  for each row execute function appointment_overdue_reset();

-- Booked appointments past their time (15 minutes) that nobody answered yet: any day, latest
-- first, at most 100. The same row shape as appointments_day, plus the day.
create or replace function appointments_overdue()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id,
      'day', to_char(a.starts_at at time zone 'Africa/Kigali', 'YYYY-MM-DD'),
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
      'late', true,
      'doctorUserId', pr.user_id,
      'encounterId', null,
      'missing', case when p.id is not null then to_jsonb(patient_missing(p)) end
    ) order by a.starts_at desc), '[]'::jsonb)
  from (
    select * from appointment x
    where x.deleted_at is null and x.status in ('approved', 'confirmed')
      and x.starts_at < now() - interval '15 minutes'
    order by x.starts_at desc
    limit 100
  ) a
  left join patient p on p.id = a.patient_id
  left join practitioner pr on pr.id = a.practitioner_id
  where has_perm('appointment.read') or has_perm('appointment.approve')
$$;
revoke all on function appointments_overdue() from public, anon;
grant execute on function appointments_overdue() to authenticated;

-- Reception is told once of each overdue request or booking. Asked by the Bookings page and the
-- front-desk home while they are open (no scheduler on the database). Returns how many were told.
create or replace function overdue_booking_notices()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer := 0;
  r record;
begin
  if not (has_perm('appointment.approve') or has_perm('appointment.write')) then
    return 0;
  end if;
  for r in
    select a.id, a.status, a.reference, a.starts_at, a.preferred_at,
           coalesce(p.surname || ' ' || p.given_names, a.contact_name) as name,
           pr.names as doctor
    from appointment a
    left join patient p on p.id = a.patient_id
    left join practitioner pr on pr.id = a.practitioner_id
    where a.deleted_at is null and a.overdue_notified_at is null
      and ((a.status = 'inquiry' and coalesce(a.starts_at, a.preferred_at) < now())
        or (a.status in ('approved', 'confirmed') and a.starts_at < now() - interval '15 minutes'))
    order by coalesce(a.starts_at, a.preferred_at)
    limit 50
  loop
    insert into notification (kind, params, link, recipient_role, created_by)
    values ('appt_overdue',
            jsonb_build_object('name', r.name, 'when', coalesce(r.starts_at, r.preferred_at),
                               'doctor', r.doctor, 'reference', r.reference,
                               'appointment', r.id, 'request', r.status = 'inquiry'),
            '/app/appointments', 'receptionist', auth.uid());
    update appointment set overdue_notified_at = now() where id = r.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;
revoke all on function overdue_booking_notices() from public, anon;
grant execute on function overdue_booking_notices() to authenticated;
