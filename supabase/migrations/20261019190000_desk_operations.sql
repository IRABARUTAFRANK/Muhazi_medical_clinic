-- 0022 · Front-desk and nursing operations that link the stations together.
--
-- Reception → nurse → doctor, as the clinic works today:
--   * appointments_day(): the day's booked patients with what reception needs to act on them;
--   * appointment_arrived(): the booked patient is here → a visit opens and the patient is
--     queued at triage (the nurse sees them at once); no_show / cancel with a reason;
--   * create_task() / complete_task(): a doctor (or the manager) leaves the nurse a task on a
--     visit ("injection at 14:00"); the nurse ticks it off on her dashboard;
--   * admit_to_bed() / discharge_bed() / bed_ready(): the short-stay bed board.

-- ---------------------------------------------------------------- appointments
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
      'late', a.status in ('approved', 'confirmed') and a.starts_at < now() - interval '15 minutes'
    ) order by a.starts_at), '[]'::jsonb)
  from appointment a
  left join patient p on p.id = a.patient_id
  left join practitioner pr on pr.id = a.practitioner_id
  where has_perm('appointment.read') and a.deleted_at is null
    and a.status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed', 'no_show', 'cancelled')
    and (a.starts_at at time zone 'Africa/Kigali')::date = coalesce(p_day, (now() at time zone 'Africa/Kigali')::date)
$$;

create or replace function appointment_arrived(p_appointment_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_appt appointment%rowtype;
  v_visit jsonb;
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
  -- Already in the clinic (walked in earlier): keep that visit. Otherwise, MoH workflow:
  -- every arrival starts at triage with the nurse.
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
    v_visit := start_visit(v_appt.patient_id, false, 'triage');
  end if;
  update appointment set status = 'arrived' where id = p_appointment_id;
  return v_visit;
end
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
  update appointment set status = p_status, cancel_reason = coalesce(nullif(trim(p_reason), ''), cancel_reason)
  where id = p_appointment_id and deleted_at is null and status in ('approved', 'confirmed');
  if not found then
    raise exception 'this appointment can no longer be changed' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------- tasks
create or replace function create_task(
  p_encounter_id uuid,
  p_title text,
  p_due_at timestamptz default null,
  p_detail text default null,
  p_assigned_role role_key default 'nurse'
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_patient uuid;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_title, ''))) < 2 then
    raise exception 'say what must be done' using errcode = '22023';
  end if;
  select patient_id into v_patient from encounter where id = p_encounter_id and status = 'open';
  if not found then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into internal_task (encounter_id, patient_id, assigned_role, due_at, title, detail)
  values (p_encounter_id, v_patient, p_assigned_role, p_due_at, trim(p_title), nullif(trim(coalesce(p_detail, '')), ''))
  returning id into v_id;
  return v_id;
end
$$;

create or replace function complete_task(p_task_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update internal_task set done_at = now(), done_by = auth.uid()
  where id = p_task_id and deleted_at is null and done_at is null;
  if not found then
    raise exception 'task not found or already done' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------- beds
create or replace function admit_to_bed(p_encounter_id uuid, p_bed_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if exists (select 1 from bed_stay where encounter_id = p_encounter_id and discharged_at is null and deleted_at is null) then
    raise exception 'this patient is already in a bed' using errcode = '23505';
  end if;
  update bed set status = 'occupied' where id = p_bed_id and status = 'free' and deleted_at is null;
  if not found then
    raise exception 'this bed is not free' using errcode = 'P0002';
  end if;
  insert into bed_stay (encounter_id, bed_id) values (p_encounter_id, p_bed_id);
end
$$;

create or replace function discharge_bed(p_bed_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update bed_stay set discharged_at = now() where bed_id = p_bed_id and discharged_at is null and deleted_at is null;
  if not found then
    raise exception 'nobody is in this bed' using errcode = 'P0002';
  end if;
  update bed set status = 'cleaning' where id = p_bed_id;
end
$$;

create or replace function bed_ready(p_bed_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update bed set status = 'free' where id = p_bed_id and status in ('cleaning', 'out_of_service') and deleted_at is null;
  if not found then
    raise exception 'this bed cannot be marked ready' using errcode = 'P0002';
  end if;
end
$$;

-- Beds with ids (the home summary only carries names), for the board's actions.
create or replace function bed_board()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'state', b.status,
      'encounterId', s.encounter_id,
      'patient', case when s.id is not null then p.surname || ' ' || p.given_names end,
      'since', s.admitted_at
    ) order by b.sort_order, b.name), '[]'::jsonb)
  from bed b
  left join bed_stay s on s.bed_id = b.id and s.discharged_at is null and s.deleted_at is null
  left join encounter e on e.id = s.encounter_id
  left join patient p on p.id = e.patient_id
  where b.deleted_at is null and has_perm('queue.read')
$$;

-- Tasks with the patient and the visit, for the nurse's list (open ones, today and overdue).
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
  left join profiles pr on pr.id = k.created_by
  where k.deleted_at is null and k.done_at is null
    and (k.assigned_to = auth.uid() or k.assigned_role = current_role_key() or is_manager())
$$;

grant execute on function appointments_day(date), appointment_arrived(uuid),
  set_appointment_outcome(uuid, appointment_status, text), create_task(uuid, text, timestamptz, text, role_key),
  complete_task(uuid), admit_to_bed(uuid, uuid), discharge_bed(uuid), bed_ready(uuid), bed_board(), open_tasks()
  to authenticated;
revoke execute on function appointments_day(date), appointment_arrived(uuid),
  set_appointment_outcome(uuid, appointment_status, text), create_task(uuid, text, timestamptz, text, role_key),
  complete_task(uuid), admit_to_bed(uuid, uuid), discharge_bed(uuid), bed_ready(uuid), bed_board(), open_tasks()
  from anon;
