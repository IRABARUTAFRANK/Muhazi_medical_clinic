-- 0125 · Book from the patient and the visit, finish without a diagnosis, the employee profile.
--
-- Frank (owner): "1. Often a staff member — a doctor, nurse or anyone who can work on a patient —
-- treats a patient and finds he must come back next time; or, even without treating him, books an
-- appointment for tomorrow or any other time for that person. So a doctor, nurse or other person
-- in charge must be able to create an appointment at a certain time with a patient directly, not
-- only through the public website. 2. Sometimes a patient is treated but no diagnosis is found;
-- that must also work. 3. On the employees side, each employee must have a profile like a
-- patient's file, containing all his profile and his documents binding him to the medical
-- facility, and other notable information that may be needed and crucial."
--
--   * A  BOOKING BY A CLINICIAN (book_follow_up): anyone with a treating desk or the right to
--        record vital signs, the manager and reception book a patient with a doctor, nurse,
--        sonographer or manager who can keep a calendar, at a free time of that person's calendar
--        (working hours, not a day off, not in a break, not in the past, not taken). Booked for
--        oneself: confirmed at once (no accept step). Booked for a colleague: the colleague gets
--        the usual "to accept" notice, unless the manager set "confirmed at once" (setting
--        booking.colleague_accept = false; the colleague is then told). The booking keeps the
--        visit it was made from (appointment.from_encounter), a note, and source 'clinician'.
--        free_slots(user, day) lists the times of one day (free, taken, past) for the form;
--        patient_bookings(patient) the patient's bookings (upcoming and past) for the file.
--        my_bookings carries the note and the visit; doc_visit the next appointment (printed).
--   * B  NO DIAGNOSIS FOUND: a visit may be finished without a primary diagnosis when the
--        clinician says why (encounter.no_diagnosis_kind: no_disease, check_up, results_pending,
--        referred, other + a note; who and when). finish_visit(visit, kind, note) and
--        set_no_diagnosis(visit, kind, note); closing still needs a primary diagnosis OR that
--        reason; writing a primary diagnosis later clears the reason (trigger). A finished visit
--        under an edit window keeps one or the other (remove_condition_none_found removes the last
--        primary diagnosis with the reason; remove_condition still refuses it). The reports say "No diagnosis — <reason>" (the marker
--        '[no-dx:<kind>] <note>' the web translates); "Patients seen" no longer counts such a
--        visit as "left".
--   * C  THE EMPLOYEE PROFILE: staff_hr (one row per employee: emergency contact, address, date
--        of birth, sex, national ID, date hired, contract type and end, registration expiry) and
--        staff_note (the manager's dated private notes: note, warning, training, leave, praise).
--        staff_profile(id) gives the whole file to the manager (anyone) and to the employee
--        (their own, without the notes); nobody else. Each look of the manager at another
--        person's profile writes a 'read' line to the audit log (once per half hour).
--        save_staff_profile(...) (manager only, audited), add_staff_note / remove_staff_note
--        (manager only, audited). The role, e-mail, PIN and deactivation stay in the Employees
--        form (the e-mailed code). staff_activity_detail also opens to the person themselves
--        (the profile's Work tab).
--   * D  CHANGING A BOOKING (change_booking): its time (a free time, the same checks), its person
--        (another colleague is asked to accept), its reason and note; a reason is needed when it
--        moves; the id stays, the history keeps old → new and why. The booking's doctor,
--        reception and the manager; not once the patient came or the booking ended. The other
--        side is told (notice booking_changed).
--   * E  THE MENU: "My bookings" counts the bookings still to see from today to 3 weeks ahead
--        (it counted today's only: a booking confirmed for Wednesday showed nothing).
--
-- Errcodes: 42501 not allowed, 22023 bad input, 23505 the time is taken, P0002 not found.

-- ---------------------------------------------------------------- A the booking columns
alter type appointment_source add value if not exists 'clinician';
alter table appointment add column if not exists from_encounter uuid references encounter (id);
alter table appointment add column if not exists note text;
alter table appointment drop constraint if exists appointment_note_len;
alter table appointment add constraint appointment_note_len check (note is null or length(note) <= 1000);
-- why the booking was last moved (change_booking, D below)
alter table appointment add column if not exists change_reason text;
alter table appointment drop constraint if exists appointment_change_reason_len;
alter table appointment add constraint appointment_change_reason_len
  check (change_reason is null or length(change_reason) <= 500);
create index if not exists appointment_from_encounter_idx on appointment (from_encounter)
  where from_encounter is not null;
comment on column appointment.from_encounter is
  'The visit the booking was made from (a follow-up booked by the clinician, 0125).';

-- The manager's choice: a booking made for a colleague waits for the colleague's answer (true, the
-- default) or is confirmed at once (false).
create or replace function colleague_must_accept()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select (value #>> '{}')::boolean from setting
                   where key = 'booking.colleague_accept' and jsonb_typeof(value) = 'boolean'), true)
$$;

-- Who books a patient: a treating desk, the right to record vital signs, reception, the manager.
create or replace function may_book_follow_up()
returns boolean
language sql stable security definer set search_path = public
as $$
  select auth.uid() is not null and current_role_key() is not null
     and (is_manager() or has_perm('appointment.approve') or has_perm('vitals.write')
          or my_desk_list() && treating_desks())
$$;

-- A booking of this calendar already covers part of [p_at, p_at + slot).
create or replace function calendar_time_taken(p_practitioner uuid, p_at timestamptz, p_minutes integer,
                                               p_except uuid default null)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from appointment b
                 where b.practitioner_id = p_practitioner and b.deleted_at is null
                   and (p_except is null or b.id <> p_except)
                   and b.status in ('approved', 'confirmed', 'arrived', 'in_progress')
                   and b.starts_at < p_at + make_interval(mins => coalesce(p_minutes, 30))
                   and coalesce(b.ends_at, b.starts_at + interval '30 minutes') > p_at)
$$;

-- The times of one day in a person's calendar: every slot of their length inside their working
-- periods (the gaps between periods are their breaks), each free, taken or past. A day off has
-- none. No working hours saved: hasHours false and no slots (any time may then be chosen).
create or replace function free_slots(p_user uuid, p_day date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_pr practitioner%rowtype;
  v_slot integer;
  v_span jsonb;
  v_from integer;
  v_to integer;
  v_m integer;
  v_at timestamptz;
  v_out jsonb := '[]'::jsonb;
  v_off boolean;
begin
  if not may_book_follow_up() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_day is null then
    raise exception 'choose the day and time' using errcode = '22023';
  end if;
  if not calendar_role_ok(p_user) then
    raise exception 'only doctors, sonographers, nurses and managers can be booked' using errcode = '22023';
  end if;
  select * into v_pr from practitioner where user_id = p_user and deleted_at is null limit 1;
  v_slot := greatest(5, least(120, coalesce(v_pr.slot_minutes, 30)));
  v_off := p_day = any (coalesce(v_pr.days_off, '{}'));
  if v_pr.id is not null and coalesce(v_pr.working_hours, '{}'::jsonb) <> '{}'::jsonb and not v_off then
    for v_span in
      select * from jsonb_array_elements(coalesce(v_pr.working_hours -> extract(dow from p_day)::int::text, '[]'::jsonb))
    loop
      v_from := extract(hour from (v_span ->> 0)::time)::int * 60 + extract(minute from (v_span ->> 0)::time)::int;
      v_to := extract(hour from (v_span ->> 1)::time)::int * 60 + extract(minute from (v_span ->> 1)::time)::int;
      v_m := v_from;
      while v_m + v_slot <= v_to loop
        v_at := (p_day + make_interval(mins => v_m)) at time zone 'Africa/Kigali';
        v_out := v_out || jsonb_build_object(
          'at', v_at,
          'time', to_char((p_day + make_interval(mins => v_m)), 'HH24:MI'),
          'state', case when v_at < now() then 'past'
                        when calendar_time_taken(v_pr.id, v_at, v_slot) then 'taken'
                        else 'free' end);
        v_m := v_m + v_slot;
      end loop;
    end loop;
  end if;
  return jsonb_build_object(
    'userId', p_user,
    'name', (select full_name from profiles where id = p_user),
    'day', p_day,
    'hasHours', v_pr.id is not null and coalesce(v_pr.working_hours, '{}'::jsonb) <> '{}'::jsonb,
    'dayOff', coalesce(v_off, false),
    'slotMinutes', v_slot,
    'slots', (select coalesce(jsonb_agg(x order by x ->> 'at'), '[]'::jsonb) from jsonb_array_elements(v_out) x),
    -- without working hours: the times already booked that day, so the form can say so
    'booked', (select coalesce(jsonb_agg(to_char(b.starts_at at time zone 'Africa/Kigali', 'HH24:MI') order by b.starts_at), '[]'::jsonb)
               from appointment b
               where v_pr.id is not null and b.practitioner_id = v_pr.id and b.deleted_at is null
                 and b.status in ('approved', 'confirmed', 'arrived', 'in_progress')
                 and (b.starts_at at time zone 'Africa/Kigali')::date = p_day));
end
$$;

-- A clinician (or reception, or the manager) books the patient with someone at a time.
create or replace function book_follow_up(
  p_patient uuid,
  p_practitioner_user uuid,
  p_starts_at timestamptz,
  p_reason text default null,
  p_note text default null,
  p_encounter uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_name text;
  v_phone text;
  v_pr uuid;
  v_hours jsonb;
  v_slot integer;
  v_staff text;
  v_who text;
  v_self boolean;
  v_ask boolean;
  v_id uuid;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not may_book_follow_up() then
    raise exception 'not allowed: bookings are made by the people who treat patients, reception and the manager'
      using errcode = '42501';
  end if;
  select surname || ' ' || given_names, phone_1 into v_name, v_phone
  from patient where id = p_patient and deleted_at is null;
  if v_name is null then
    raise exception 'choose the patient file' using errcode = '22023';
  end if;
  if p_practitioner_user is null then
    raise exception 'choose the doctor' using errcode = '22023';
  end if;
  if not calendar_role_ok(p_practitioner_user) then
    raise exception 'only doctors, sonographers, nurses and managers can be booked' using errcode = '22023';
  end if;
  if p_starts_at is null then
    raise exception 'choose the day and time' using errcode = '22023';
  end if;
  if p_starts_at < now() then
    raise exception 'the chosen time is in the past' using errcode = '22023';
  end if;
  if length(coalesce(v_reason, '')) > 300 or length(coalesce(v_note, '')) > 1000 then
    raise exception 'the reason or the note is too long' using errcode = '22023';
  end if;
  if p_encounter is not null and not exists (
       select 1 from encounter where id = p_encounter and patient_id = p_patient and deleted_at is null) then
    raise exception 'this visit is not the patient''s' using errcode = '22023';
  end if;
  -- the person's calendar (made the first time they are booked, as reception does)
  select id into v_pr from practitioner where user_id = p_practitioner_user and deleted_at is null limit 1;
  if v_pr is null then
    select full_name, staff_id into v_who, v_staff from profiles where id = p_practitioner_user;
    insert into practitioner (code, user_id, names, slot_minutes, working_hours, calendar_visibility, active)
    values (lower(coalesce(v_staff, 'dr-' || left(p_practitioner_user::text, 8))), p_practitioner_user, v_who, 30,
            '{}'::jsonb, 'private', true)
    returning id into v_pr;
  else
    update practitioner set active = true where id = v_pr and not active;
  end if;
  select working_hours, slot_minutes into v_hours, v_slot from practitioner where id = v_pr;
  v_slot := coalesce(v_slot, 30);
  if coalesce(v_hours, '{}'::jsonb) <> '{}'::jsonb and not practitioner_is_working(v_pr, p_starts_at) then
    raise exception 'the doctor does not work at that time' using errcode = '22023';
  end if;
  if calendar_time_taken(v_pr, p_starts_at, v_slot) then
    raise exception 'the doctor already has a booking at that time' using errcode = '23505';
  end if;
  v_self := p_practitioner_user = v_me;
  v_ask := not v_self and colleague_must_accept();
  begin
    insert into appointment (patient_id, practitioner_id, starts_at, ends_at, status, source, reason, note,
                             contact_name, contact_phone, approved_by, approved_at, accepted_by, accepted_at,
                             from_encounter)
    values (p_patient, v_pr, p_starts_at, p_starts_at + make_interval(mins => v_slot),
            case when v_ask then 'approved' else 'confirmed' end::appointment_status,
            case when current_role_key() = 'receptionist' then 'reception' else 'clinician' end::appointment_source,
            v_reason, v_note, v_name, v_phone, v_me, now(),
            case when v_self then v_me end, case when not v_ask then now() end,
            p_encounter)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'the doctor already has a booking at that time' using errcode = '23505';
  end;
  -- the colleague is asked (the usual notice) or told
  if not v_self then
    insert into notification (kind, params, link, recipient_user, created_by)
    values (case when v_ask then 'to_accept' else 'booked_for_you' end,
            jsonb_build_object('name', v_name, 'when', p_starts_at, 'appointment', v_id,
                               'by', (select full_name from profiles where id = v_me)),
            case when v_ask then '/app' else '/app/my-bookings' end, p_practitioner_user, v_me);
  end if;
  return jsonb_build_object(
    'id', v_id,
    'status', case when v_ask then 'approved' else 'confirmed' end,
    'startsAt', p_starts_at,
    'with', (select full_name from profiles where id = p_practitioner_user),
    'self', v_self);
end
$$;

-- The patient's bookings for the file: every one still to come and the last 50 before.
create or replace function patient_bookings(p_patient uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  -- the cashier too: the receipt prints the next appointment
  if not (may_book_follow_up() or has_perm('appointment.read') or has_perm('payment.take')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(x.j order by x.starts_at desc)
    from (
      select a.starts_at, jsonb_build_object(
          'id', a.id, 'status', a.status, 'startsAt', a.starts_at, 'endsAt', a.ends_at,
          'reason', a.reason, 'note', a.note, 'source', a.source, 'category', a.category,
          'cancelReason', a.cancel_reason, 'changeReason', a.change_reason,
          'withUserId', pr.user_id, 'with', coalesce(wp.full_name, pr.names), 'withRole', wp.role, 'title', pr.title,
          'bookedBy', bb.full_name, 'bookedAt', coalesce(a.approved_at, a.created_at),
          'acceptedBy', ab.full_name, 'acceptedAt', a.accepted_at,
          'fromEncounter', a.from_encounter,
          'fromReference', (select e.reference from encounter e where e.id = a.from_encounter),
          'encounterId', (select e.id from encounter e where e.appointment_id = a.id and e.deleted_at is null
                          order by e.created_at desc limit 1),
          'mine', pr.user_id = auth.uid(),
          'upcoming', a.starts_at >= now() - interval '15 minutes'
                      and a.status in ('approved', 'confirmed', 'arrived', 'in_progress')) as j
      from appointment a
      left join practitioner pr on pr.id = a.practitioner_id
      left join profiles wp on wp.id = pr.user_id
      left join profiles bb on bb.id = coalesce(a.approved_by, a.created_by)
      left join profiles ab on ab.id = a.accepted_by
      where a.patient_id = p_patient and a.deleted_at is null and a.starts_at is not null
        and a.status not in ('inquiry', 'rejected')
        and (a.starts_at >= now() - interval '1 day'
             or a.id in (select b.id from appointment b
                         where b.patient_id = p_patient and b.deleted_at is null and b.starts_at < now() - interval '1 day'
                           and b.status not in ('inquiry', 'rejected')
                         order by b.starts_at desc limit 50))
    ) x), '[]'::jsonb);
end
$$;

-- The people a booking can be made with: also for the clinicians who book (not only reception).
create or replace function bookable_doctors()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', p.id, 'name', p.full_name, 'role', p.role, 'staffId', p.staff_id,
    'hasHours', coalesce(pr.working_hours, '{}'::jsonb) <> '{}'::jsonb,
    'slotMinutes', coalesce(pr.slot_minutes, 30),
    'title', pr.title
  ) order by p.full_name), '[]'::jsonb)
  from profiles p
  left join practitioner pr on pr.user_id = p.id and pr.deleted_at is null
  where (has_perm('appointment.read') or may_book_follow_up())
    and p.active and p.deleted_at is null and p.role in ('doctor', 'sonographer', 'nurse', 'manager')
$$;

-- ---------------------------------------------------------------- B no diagnosis found
alter table encounter add column if not exists no_diagnosis_kind text;
alter table encounter add column if not exists no_diagnosis_note text;
alter table encounter add column if not exists no_diagnosis_by uuid references profiles (id);
alter table encounter add column if not exists no_diagnosis_at timestamptz;
alter table encounter drop constraint if exists encounter_no_diagnosis_kind;
alter table encounter add constraint encounter_no_diagnosis_kind check (
  no_diagnosis_kind is null
  or (no_diagnosis_kind in ('no_disease', 'check_up', 'results_pending', 'referred', 'other')
      and (no_diagnosis_kind <> 'other' or length(trim(coalesce(no_diagnosis_note, ''))) >= 3)
      and length(coalesce(no_diagnosis_note, '')) <= 500));
comment on column encounter.no_diagnosis_kind is
  'The visit was finished with no diagnosis found, and why: no_disease, check_up, results_pending, referred, other (+ note) (0125).';

-- The reason in plain English, for the places that print text (the web translates the marker).
create or replace function no_diagnosis_marker(p_kind text, p_note text)
returns text
language sql immutable
as $$
  select case when p_kind is not null
              then '[no-dx:' || p_kind || ']' || coalesce(' ' || nullif(trim(p_note), ''), '') end
$$;

-- The clinician says no diagnosis was found (or, p_kind null, takes it back).
create or replace function set_no_diagnosis(p_encounter_id uuid, p_kind text, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_e encounter%rowtype;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  if not visit_open_or_editing(p_encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  select * into v_e from encounter where id = p_encounter_id for update;
  if p_kind is null then
    if v_e.status = 'closed' and v_e.type in ('opd', 'dental', 'procedure', 'observation')
       and not exists (select 1 from condition where encounter_id = p_encounter_id and type = 'primary' and deleted_at is null) then
      raise exception 'a finished visit keeps a primary diagnosis: write the new one first' using errcode = '23514';
    end if;
    update encounter set no_diagnosis_kind = null, no_diagnosis_note = null, no_diagnosis_by = null, no_diagnosis_at = null
    where id = p_encounter_id;
    perform note_visit_edit(p_encounter_id, 'update', 'encounter', p_encounter_id, jsonb_build_object('noDiagnosis', null));
    return;
  end if;
  if p_kind not in ('no_disease', 'check_up', 'results_pending', 'referred', 'other') then
    raise exception 'unknown reason for finishing without a diagnosis' using errcode = '22023';
  end if;
  if p_kind = 'other' and length(coalesce(v_note, '')) < 3 then
    raise exception 'say why no diagnosis was found' using errcode = '22023';
  end if;
  if length(coalesce(v_note, '')) > 500 then
    raise exception 'the reason or the note is too long' using errcode = '22023';
  end if;
  if exists (select 1 from condition where encounter_id = p_encounter_id and type = 'primary' and deleted_at is null) then
    raise exception 'this visit has a primary diagnosis: remove it before saying none was found' using errcode = '22023';
  end if;
  update encounter
  set no_diagnosis_kind = p_kind, no_diagnosis_note = v_note, no_diagnosis_by = auth.uid(), no_diagnosis_at = now()
  where id = p_encounter_id;
  perform note_visit_edit(p_encounter_id, 'update', 'encounter', p_encounter_id,
                          jsonb_build_object('noDiagnosis', p_kind, 'note', v_note));
end
$$;

-- A primary diagnosis written (or a diagnosis made primary) later: the "none found" goes.
create or replace function condition_clears_no_diagnosis()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.type = 'primary' and new.deleted_at is null then
    update encounter
    set no_diagnosis_kind = null, no_diagnosis_note = null, no_diagnosis_by = null, no_diagnosis_at = null
    where id = new.encounter_id and no_diagnosis_kind is not null;
  end if;
  return null;
end
$$;
drop trigger if exists trg_condition_clears_no_diagnosis on condition;
create trigger trg_condition_clears_no_diagnosis after insert or update of type, deleted_at on condition
  for each row execute function condition_clears_no_diagnosis();

-- Closing: a primary diagnosis, or the clinician's reason why none was found.
create or replace function close_encounter(p_encounter_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_type encounter_type;
  v_none text;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  select type, no_diagnosis_kind into v_type, v_none from encounter where id = p_encounter_id and status = 'open';
  if not found then
    raise exception 'encounter not found or already closed' using errcode = 'P0002';
  end if;
  if v_type in ('opd', 'dental', 'procedure', 'observation') and v_none is null
     and not exists (select 1 from condition where encounter_id = p_encounter_id and type = 'primary' and deleted_at is null) then
    raise exception 'a primary diagnosis is required before closing the visit' using errcode = '23514';
  end if;
  update encounter set status = 'closed', closed_at = now(), closed_by = auth.uid() where id = p_encounter_id;
  update queue_entry set finished_at = coalesce(finished_at, now()) where encounter_id = p_encounter_id;
end
$$;

-- Finish the visit; with p_no_diagnosis (no_disease, check_up, results_pending, referred, other +
-- a note) when no diagnosis was found.
drop function if exists finish_visit(uuid);
create or replace function finish_visit(p_encounter_id uuid, p_no_diagnosis text default null,
                                        p_no_diagnosis_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_rx boolean;
  v_due boolean;
  v_ticket text;
  v_next station;
  v_keep queue_entry%rowtype;
begin
  perform assert_may_work_on(p_encounter_id);
  if p_no_diagnosis is not null then
    perform set_no_diagnosis(p_encounter_id, p_no_diagnosis, p_no_diagnosis_note);
  end if;
  v_rx := exists (select 1 from medication_request m where m.encounter_id = p_encounter_id and rx_pending(m));
  v_next := case when v_rx then 'pharmacy' else 'cashier' end;
  -- the patient already waits there (the doctor sent them on before finishing): keep that place
  select * into v_keep from queue_entry
  where encounter_id = p_encounter_id and station = v_next and finished_at is null and deleted_at is null
  order by created_at desc limit 1;
  perform close_encounter(p_encounter_id);
  v_due := exists (select 1 from invoice i where i.encounter_id = p_encounter_id and invoice_balance(i.id) > 0);
  if v_rx or v_due then
    -- Treatment is over; the visit stays open until the medicines are handed over and the bill is paid.
    update encounter set status = 'open', closed_at = null, closed_by = null, clinical_done_at = now()
    where id = p_encounter_id;
    if v_keep.id is not null then
      update queue_entry set finished_at = null,
             referral_note = coalesce(referral_note, case when v_rx then 'Medicines to hand over' end)
      where id = v_keep.id
      returning * into v_keep;
      perform notify_queue_entry_row(v_keep);
      return;
    end if;
    select ticket_no into v_ticket from queue_entry where encounter_id = p_encounter_id order by created_at limit 1;
    -- medicines first (their price joins the bill), then the cashier
    if v_rx then
      insert into queue_entry (encounter_id, station, ticket_no, referred_by, referral_note)
      values (p_encounter_id, 'pharmacy', coalesce(v_ticket, 'A-000'), auth.uid(), 'Medicines to hand over');
    else
      insert into queue_entry (encounter_id, station, ticket_no)
      values (p_encounter_id, 'cashier', coalesce(v_ticket, 'A-000'));
    end if;
  else
    -- nothing left to hand over or to pay: the visit is closed, its bill posted (insurer's claim)
    perform post_drafts_of_visit(p_encounter_id);
  end if;
end
$$;

-- Removing a diagnosis and saying no diagnosis stands: the last primary one of a finished visit
-- (under an edit window) goes only this way, with the reason (remove_condition still refuses it).
create or replace function remove_condition_none_found(p_id uuid, p_reason text, p_no_diagnosis text,
                                                       p_no_diagnosis_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_c condition%rowtype;
  v_e encounter%rowtype;
  v_last boolean;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  select * into v_c from condition where id = p_id and deleted_at is null for update;
  if not found then
    raise exception 'diagnosis not found' using errcode = 'P0002';
  end if;
  select * into v_e from encounter where id = v_c.encounter_id;
  if not (is_manager() or v_c.created_by = auth.uid()) then
    raise exception 'only the clinician who wrote the diagnosis (or the manager) can change it' using errcode = '42501';
  end if;
  if not visit_open_or_editing(v_c.encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the diagnosis is removed' using errcode = '22023';
  end if;
  v_last := v_c.type = 'primary'
            and not exists (select 1 from condition x where x.encounter_id = v_c.encounter_id and x.id <> v_c.id
                            and x.type = 'primary' and x.deleted_at is null);
  if v_e.status = 'closed' and v_last and p_no_diagnosis is null
     and v_e.type in ('opd', 'dental', 'procedure', 'observation') then
    raise exception 'a finished visit keeps a primary diagnosis: write the new one first' using errcode = '23514';
  end if;
  update condition set deleted_at = now(), edit_reason = trim(p_reason) where id = p_id;
  perform note_visit_edit(v_c.encounter_id, 'delete', 'condition', p_id,
                          jsonb_build_object('text', v_c.text, 'icd10', v_c.icd10_code, 'type', v_c.type,
                                             'reason', trim(p_reason)));
  -- no primary diagnosis left: the reason none stands
  if v_last and p_no_diagnosis is not null then
    perform set_no_diagnosis(v_c.encounter_id, p_no_diagnosis, p_no_diagnosis_note);
  end if;
end
$$;

-- The visit for the record and the printed documents: + the reason no diagnosis was found and
-- the next appointment (the one booked from this visit first, else the next one after it).
create or replace function doc_visit(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', e.id, 'reference', e.reference, 'at', e.arrived_at, 'status', e.status, 'closedAt', e.closed_at,
    'service', e.service,
    'department', (select d.name from queue_entry q join department d on d.id = q.department_id
                   where q.encounter_id = e.id and q.deleted_at is null order by q.created_at desc limit 1),
    'referredBy', (select pr.full_name from queue_entry q join profiles pr on pr.id = q.referred_by
                   where q.encounter_id = e.id and q.deleted_at is null order by q.created_at desc limit 1),
    'noDiagnosis', case when e.no_diagnosis_kind is not null then jsonb_build_object(
                     'kind', e.no_diagnosis_kind, 'note', e.no_diagnosis_note, 'at', e.no_diagnosis_at,
                     'by', (select full_name from profiles where id = e.no_diagnosis_by)) end,
    'nextAppointment', (
      select jsonb_build_object('id', a.id, 'at', a.starts_at, 'status', a.status,
                                'with', coalesce(wp.full_name, pr.names), 'title', pr.title,
                                'reason', a.reason, 'fromThisVisit', a.from_encounter = e.id)
      from appointment a
      left join practitioner pr on pr.id = a.practitioner_id
      left join profiles wp on wp.id = pr.user_id
      where a.patient_id = e.patient_id and a.deleted_at is null
        and a.status in ('approved', 'confirmed')
        and a.id is distinct from e.appointment_id
        and (a.from_encounter = e.id or a.starts_at > greatest(e.arrived_at, now()))
      order by (a.from_encounter = e.id) desc nulls last, a.starts_at
      limit 1))
  from encounter e where e.id = p_encounter_id
$$;

-- The first diagnosis of a visit for the patients' reports; none: the reason (a marker the web
-- translates), when the clinician said none was found.
create or replace function report_visit_diagnosis(p_encounter_id uuid, p_sensitive boolean)
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select c.text || coalesce(' (' || c.icd10_code || ')', '')
     from condition c
     where c.encounter_id = p_encounter_id and c.deleted_at is null
       and (p_sensitive or coalesce(c.icd10_code, '') !~ '^B2[0-4]')
     order by (c.type = 'primary') desc, c.created_at
     limit 1),
    (select no_diagnosis_marker(e.no_diagnosis_kind, e.no_diagnosis_note) from encounter e where e.id = p_encounter_id))
$$;

-- ---------------------------------------------------------------- A my_bookings: + the note and the visit
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
      'reason', a.reason, 'note', a.note, 'fromEncounter', a.from_encounter, 'category', a.category, 'source', a.source, 'reference', a.reference,
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
            'why', case when (h.before ->> 'starts_at') is distinct from (h.after ->> 'starts_at')
                          or (h.before ->> 'practitioner_id') is distinct from (h.after ->> 'practitioner_id')
                        then h.after ->> 'change_reason' end,
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
                        or (h.before ->> 'starts_at') is distinct from (h.after ->> 'starts_at')
                        or (h.before ->> 'practitioner_id') is distinct from (h.after ->> 'practitioner_id'))))
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

-- ---------------------------------------------------------------- A the menu: My bookings counts what is coming
-- Frank: a booking confirmed for Wednesday showed no count. My bookings now counts every booking
-- still to see (booked, confirmed, arrived) from today to 3 weeks ahead: the page's "Coming" list.
create or replace function nav_counts()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_role role_key := current_role_key();
  v_manager boolean := is_manager();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_start timestamptz;
  v_end timestamptz;
  v_desks text[] := my_desk_list();
  v_station station;
  -- a doctor's or nurse's desk: consultation, dental, nursing, triage…
  v_treat boolean;
  v_pharmacy boolean;
  v_out jsonb := '{}'::jsonb;
  v_n integer;
  v_e integer;
begin
  if v_me is null or v_role is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  v_start := (v_today::timestamp) at time zone 'Africa/Kigali';
  v_end := ((v_today + 1)::timestamp) at time zone 'Africa/Kigali';
  v_station := my_home_station();
  v_treat := not v_manager and v_role not in ('receptionist', 'cashier')
             and v_desks && (treating_desks() || array['triage']);
  v_pharmacy := not v_manager and 'pharmacy' = any (v_desks);

  -- MY QUEUE and THE PATIENTS AT MY DESKS (the rule of my_summary's "Waiting for me"): an entry
  -- that joined the queue today is today's; an older one still open is from an earlier day.
  if v_treat and has_perm('queue.read') and has_perm('patient.read') then
    with mine as (
      select q.encounter_id, q.started_at, (q.created_at >= v_start) as is_today
      from queue_entry q
      join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
      where q.deleted_at is null and q.finished_at is null
        and (q.assigned_to = v_me
             or q.taken_by = v_me
             or exists (select 1 from patient_handover h
                        where h.queue_id = q.id and h.status = 'pending' and h.to_user = v_me
                          and h.deleted_at is null)
             or (q.assigned_to is null and q.taken_by is null
                 and (serves_station(v_me, q.station, coalesce(q.service, e.service))
                      or q.station = v_station)
                 and (q.department_id is null
                      or exists (select 1 from profiles me where me.id = v_me and me.department_id = q.department_id)
                      or exists (select 1 from staff_department sd
                                 where sd.profile_id = v_me and sd.department_id = q.department_id))))
    ),
    -- a patient with an entry of today is today's, even when an older one is still open
    visits as (select encounter_id, bool_or(is_today) as is_today from mine group by encounter_id)
    select jsonb_build_object(
             'queue', (select count(*) from mine where started_at is null and is_today),
             'queueEarlier', (select count(*) from mine where started_at is null and not is_today),
             'inClinic', (select count(*) from visits where is_today),
             'inClinicEarlier', (select count(*) from visits where not is_today))
    into v_out;
  elsif (v_manager or v_role = 'receptionist') and has_perm('patient.read') then
    select jsonb_build_object(
             'inClinic', count(*) filter (where e.arrived_at >= v_start),
             'inClinicEarlier', count(*) filter (where e.arrived_at < v_start))
    into v_out
    from encounter e where e.status = 'open' and e.deleted_at is null;
  end if;

  -- RESULTS FOR ME and MY PRESCRIPTIONS AT THE PHARMACY: whoever has those menu entries (a doctor
  -- at a treating desk; anyone a department of theirs gives a doctor's desk; as the menu decides)
  if not v_manager
     and ((v_role = 'doctor' and v_desks && treating_desks())
          or exists (select 1 from unnest(array['consultation', 'dental', 'surgery', 'circ']) d(desk)
                     where desk_via(v_me, d.desk) = 'department')) then
    -- given today and not seen; given on one of the 6 days before and still not seen: earlier
    select count(*) filter (where d.updated_at >= v_start),
           count(*) filter (where d.updated_at < v_start)
    into v_n, v_e
    from diagnostic_report d
    join service_request r on r.id = d.service_request_id and r.deleted_at is null
    where d.deleted_at is null and d.reviewed_at is null
      and r.status in ('resulted', 'verified')
      and d.updated_at > now() - interval '7 days'
      -- cheap first: my own request, or a visit handed over to me
      and (r.requester_id = v_me
           or exists (select 1 from patient_handover h where h.encounter_id = r.encounter_id
                      and h.to_user = v_me and h.status = 'taken' and h.deleted_at is null))
      and result_recipient(r.encounter_id, r.requester_id) = v_me;
    v_out := v_out || jsonb_build_object('results', v_n, 'resultsEarlier', v_e);

    -- written today and still waiting at the pharmacy; written earlier: apart
    select count(*) filter (where m.created_at >= v_start),
           count(*) filter (where m.created_at < v_start)
    into v_n, v_e
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.status = 'open' and e.deleted_at is null
    where coalesce(m.prescriber_id, m.created_by) = v_me and rx_pending(m);
    v_out := v_out || jsonb_build_object('prescriptions', v_n, 'prescriptionsEarlier', v_e);
  end if;

  -- MY BOOKINGS STILL TO SEE, today to 3 weeks ahead (whoever keeps a calendar; 0124, 0125)
  if has_perm('appointment.accept') or v_manager then
    select count(*) into v_n
    from appointment a
    join practitioner pr on pr.id = a.practitioner_id and pr.user_id = v_me and pr.deleted_at is null
    where a.deleted_at is null
      -- still to be seen: booked, confirmed or arrived; once the visit is taken (in progress) or
      -- done it leaves the count, one by one
      and a.status in ('approved', 'confirmed', 'arrived')
      and a.starts_at >= v_start and a.starts_at < v_start + interval '22 days';
    if v_n > 0 or exists (select 1 from practitioner pr where pr.user_id = v_me and pr.deleted_at is null) then
      v_out := v_out || jsonb_build_object('myBookings', v_n);
    end if;
  end if;

  -- TODAY'S BOOKINGS + THE REQUESTS THAT CAME TODAY (reception's Bookings page); requests still
  -- unanswered from an earlier day: apart
  if v_manager or v_role = 'receptionist' or has_perm('appointment.approve') then
    -- still to come in: booked or confirmed for today (an arrival leaves the count), and the
    -- requests of today still to answer
    select count(*) filter (where (a.status in ('approved', 'confirmed')
                                   and a.starts_at >= v_start and a.starts_at < v_end)
                                  or (a.status = 'inquiry' and a.created_at >= v_start)),
           count(*) filter (where a.status = 'inquiry' and a.created_at < v_start)
    into v_n, v_e
    from appointment a
    where a.deleted_at is null;
    v_out := v_out || jsonb_build_object('bookings', v_n, 'bookingsEarlier', v_e);
  end if;

  -- THE LABORATORY / ULTRASOUND WORKLIST (the rule of lab_worklist, open): asked today; earlier
  if not v_manager and v_desks && array['laboratory', 'ultrasound'] and has_perm('orders.read') then
    select count(*) filter (where r.created_at >= v_start),
           count(*) filter (where r.created_at < v_start)
    into v_n, v_e
    from service_request r
    join encounter e on e.id = r.encounter_id and e.status = 'open'
    where r.deleted_at is null
      and r.status not in ('verified', 'cancelled')
      and r.category = any (my_test_categories())
      and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station
                                   else 'laboratory'::station end) in ('laboratory', 'ultrasound')
      and (has_perm('sensitive.read') or may_use_desk(request_desk(r.station, r.category))
           or not sensitive_service(r.service_id));
    v_out := v_out || jsonb_build_object('worklist', v_n, 'worklistEarlier', v_e);
  end if;

  -- THE PHARMACY: patients with medicines written today to hand over + walk-in sales of today
  -- paid and not handed over; a patient whose medicines all date from an earlier day, and older
  -- walk-in sales: apart
  if v_pharmacy then
    with pending as (
      select m.encounter_id, bool_or(m.created_at >= v_start) as is_today
      from medication_request m
      join encounter e on e.id = m.encounter_id and e.status = 'open'
      where rx_pending(m)
      group by m.encounter_id
    ), sales as (
      select (s.created_at >= v_start) as is_today
      from counter_sale s
      join stock_location l on l.id = s.location_id
      where s.deleted_at is null and s.status = 'paid' and not is_room_type(l.type)
    )
    select (select count(*) from pending where is_today) + (select count(*) from sales where is_today),
           (select count(*) from pending where not is_today) + (select count(*) from sales where not is_today)
    into v_n, v_e;
    v_out := v_out || jsonb_build_object('pharmacy', v_n, 'pharmacyEarlier', v_e);
  elsif not v_manager and exists (
      select 1 from stock_location l
      where l.active and l.deleted_at is null and is_room_type(l.type) and holds_store(v_me, l.id)) then
    -- A ROOM STORE (a doctor's office, the ward): delivery notes sent today to confirm + walk-in
    -- sales of today to give; older ones apart
    with w as (
      select (t.sent_at >= v_start) as is_today from stock_transfer t
      where t.deleted_at is null and t.status = 'in_transit' and t.direction = 'to_room'
        and holds_store(v_me, t.to_location_id)
      union all
      select (s.created_at >= v_start) from counter_sale s
      join stock_location l on l.id = s.location_id
      where s.deleted_at is null and s.status = 'paid' and is_room_type(l.type)
        and holds_store(v_me, s.location_id)
    )
    select count(*) filter (where is_today), count(*) filter (where not is_today) into v_n, v_e from w;
    v_out := v_out || jsonb_build_object('stock', v_n, 'stockEarlier', v_e);
  end if;

  -- MONEY: bills opened today with something still to pay (open visits), walk-in sales of today
  -- waiting to be paid; older ones apart
  if v_manager or v_role = 'cashier' or has_perm('payment.take') then
    select count(*) filter (where i.created_at >= v_start),
           count(*) filter (where i.created_at < v_start)
    into v_n, v_e
    from invoice i join encounter e on e.id = i.encounter_id
    where i.deleted_at is null and i.status = 'draft' and e.status = 'open'
      and invoice_balance(i.id) > 0;
    v_out := v_out || jsonb_build_object('bills', v_n, 'billsEarlier', v_e);
  end if;
  if not v_manager and (v_role = 'cashier' or has_perm('payment.take')) then
    select count(*) filter (where s.created_at >= v_start),
           count(*) filter (where s.created_at < v_start)
    into v_n, v_e
    from counter_sale s where s.deleted_at is null and s.status = 'open';
    v_out := v_out || jsonb_build_object('payments', v_n, 'paymentsEarlier', v_e);
  end if;

  -- RECORD ACCESS: requests waiting for an answer (record_access_requests 'pending'); not day-bound
  if v_manager or has_perm('records.approve') then
    v_out := v_out || jsonb_build_object('recordAccess',
      (select count(*) from record_access_request r
       join encounter e on e.id = r.encounter_id and e.status = 'open'
       where r.kind = 'request' and r.status = 'pending' and r.requested_by <> v_me
         and r.created_at > now() - interval '90 days')
      + case when v_manager then
          (select count(*) from record_access_request r
           where r.kind = 'emergency' and r.reviewed_at is null
             and r.created_at > now() - interval '90 days')
        else 0 end);
  end if;

  -- STAFF DOCUMENTS expiring within 60 days, or expired (staff_documents_expiring); not day-bound
  if v_manager then
    v_out := v_out || jsonb_build_object('documents',
      (select count(*) from staff_document d
       join profiles p on p.id = d.profile_id and p.active
       where d.deleted_at is null and d.kind in ('licence', 'contract')
         and d.expires_on is not null and d.expires_on <= staff_doc_today() + 60));
  end if;

  -- FILES TO COMPLETE (reception): today's only (0123), as the list opens
  if v_role = 'receptionist' and has_perm('patient.read') then
    v_out := v_out || jsonb_build_object('filesToComplete',
      (with s as (select patient_builtins() as b, patient_fields() as f)
       select count(distinct p.id)
       from patient p
       cross join s
       left join encounter e on e.patient_id = p.id and e.status = 'open' and e.deleted_at is null
       where p.deleted_at is null and p.merged_into is null
         and (coalesce(e.arrived_at, p.created_at) at time zone 'Africa/Kigali')::date
             = (now() at time zone 'Africa/Kigali')::date
         and cardinality(patient_missing_with(p, s.b, s.f)) > 0));
  end if;

  -- an "earlier" count only when there is something from an earlier day
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_out
  from jsonb_each(v_out) x(k, v)
  where not (k like '%Earlier' and v = '0'::jsonb);

  return v_out;
end
$$;

-- ---------------------------------------------------------------- A the booking's detail: + the note and the last change
create or replace function appointment_detail(p_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', a.id, 'status', a.status, 'source', a.source, 'reference', a.reference,
    'startsAt', a.starts_at, 'endsAt', a.ends_at, 'preferredAt', a.preferred_at, 'createdAt', a.created_at,
    'reason', a.reason, 'note', a.note, 'changeReason', a.change_reason, 'fromEncounter', a.from_encounter,
    'cancelReason', a.cancel_reason, 'category', a.category, 'insurer', a.insurer_text,
    'channel', a.contact_channel, 'contactName', a.contact_name, 'contactPhone', a.contact_phone,
    'patientId', p.id, 'patientFile', p.file_number,
    'patientName', case when p.id is null then null else p.surname || ' ' || p.given_names end,
    'patientPhone', p.phone_1,
    'doctor', pr.names, 'doctorUserId', pr.user_id,
    'approvedBy', ap.full_name, 'approvedAt', a.approved_at,
    'acceptedBy', ac.full_name, 'acceptedAt', a.accepted_at,
    'encounterId', (select e.id from encounter e where e.appointment_id = a.id order by e.created_at desc limit 1),
    'late', a.status in ('approved', 'confirmed') and a.starts_at < now() - interval '15 minutes'
  )
  from appointment a
  left join patient p on p.id = a.patient_id
  left join practitioner pr on pr.id = a.practitioner_id
  left join profiles ap on ap.id = a.approved_by
  left join profiles ac on ac.id = a.accepted_by
  where (has_perm('appointment.read') or has_perm('appointment.approve')) and a.id = p_id and a.deleted_at is null
$$;

-- ---------------------------------------------------------------- A the manager's setting
create or replace function save_setting(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_hours numeric;
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_key not in ('clinic.profile', 'clinic.hours', 'clinic.features', 'patient.fields', 'security.lock', 'security.otp', 'security.session', 'flow', 'stock.expiry_days', 'insurance.enabled', 'booking.colleague_accept') then
    raise exception 'unknown setting %', p_key using errcode = '22023';
  end if;
  if p_key = 'security.session' then
    if not is_manager() then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if jsonb_typeof(p_value -> 'hours') is distinct from 'number' then
      raise exception 'hours must be a whole number between 1 and 12' using errcode = '22023';
    end if;
    v_hours := (p_value ->> 'hours')::numeric;
    if v_hours <> trunc(v_hours) or v_hours < 1 or v_hours > 12 then
      raise exception 'hours must be a whole number between 1 and 12' using errcode = '22023';
    end if;
  end if;
  if p_key = 'security.lock' then
    if jsonb_typeof(p_value -> 'idle_minutes') <> 'number'
       or (p_value ->> 'idle_minutes')::numeric < 1
       or (p_value ->> 'idle_minutes')::numeric > 480 then
      raise exception 'idle_minutes must be between 1 and 480' using errcode = '22023';
    end if;
  end if;
  if p_key = 'security.otp' then
    if jsonb_typeof(p_value -> 'trust_days') <> 'number'
       or (p_value ->> 'trust_days')::numeric < 0
       or (p_value ->> 'trust_days')::numeric > 90 then
      raise exception 'trust_days must be between 0 and 90' using errcode = '22023';
    end if;
  end if;
  if p_key = 'flow' and jsonb_typeof(p_value -> 'triage_first') <> 'boolean' then
    raise exception 'flow.triage_first must be true or false' using errcode = '22023';
  end if;
  if p_key = 'patient.fields' and jsonb_typeof(p_value) <> 'array' then
    raise exception 'patient.fields must be a list' using errcode = '22023';
  end if;
  if p_key = 'insurance.enabled' and jsonb_typeof(p_value) is distinct from 'boolean' then
    raise exception 'insurance.enabled must be true or false' using errcode = '22023';
  end if;
  if p_key = 'booking.colleague_accept' and jsonb_typeof(p_value) is distinct from 'boolean' then
    raise exception 'booking.colleague_accept must be true or false' using errcode = '22023';
  end if;
  if p_key = 'stock.expiry_days' then
    if jsonb_typeof(p_value) is distinct from 'number' then
      raise exception 'the expiry window is a whole number of days between 1 and 365' using errcode = '22023';
    end if;
    if (p_value #>> '{}')::numeric <> trunc((p_value #>> '{}')::numeric)
       or (p_value #>> '{}')::numeric < 1 or (p_value #>> '{}')::numeric > 365 then
      raise exception 'the expiry window is a whole number of days between 1 and 365' using errcode = '22023';
    end if;
  end if;
  insert into setting (key, value, changed_by, changed_at)
  values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, changed_by = auth.uid(), changed_at = now();
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'setting', null, jsonb_build_object('key', p_key));
end
$$;

create or replace function staff_settings()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'idle_minutes', coalesce(((select value from setting where key = 'security.lock') ->> 'idle_minutes')::int, 120),
    'trust_days', trust_days(),
    'triage_first', triage_first(),
    'session_hours', session_hours(),
    'insurance_enabled', insurance_enabled(),
    'colleague_accept', colleague_must_accept(),
    'insurance_active', insurance_enabled()
      and exists (select 1 from payer where active and deleted_at is null and type <> 'cash')
  )
$$;

-- ---------------------------------------------------------------- B the reports: "No diagnosis — <reason>"
create or replace function report_patients_seen(
  p_from date, p_to date, p_clinician uuid default null, p_department uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_mgr boolean := is_manager();
  v_heads uuid[] := report_head_departments();
begin
  perform report_assert_clinical();
  perform report_assert_period(p_from, p_to);
  return coalesce((
    with enc as (
      select e.id, e.patient_id, e.arrived_at, e.reference, e.status, e.clinical_done_at, e.left_reason,
             e.no_diagnosis_kind, e.no_diagnosis_note
      from encounter e
      where e.deleted_at is null and (e.arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to
    ), seen as (
      select q.encounter_id, q.taken_by as clinician_id, min(coalesce(q.started_at, q.created_at)) as seen_at,
             (array_agg(q.station::text order by q.created_at))[1] as station
      from queue_entry q join enc on enc.id = q.encounter_id
      where q.deleted_at is null and q.taken_by is not null
        and q.station in ('consultation', 'dental', 'theatre', 'nursing', 'beds', 'ultrasound')
      group by 1, 2
      union all
      select c.encounter_id, c.created_by, min(c.created_at), null
      from condition c join enc on enc.id = c.encounter_id
      where c.deleted_at is null and c.created_by is not null
        and not exists (select 1 from queue_entry q
                        where q.encounter_id = c.encounter_id and q.deleted_at is null and q.taken_by = c.created_by
                          and q.station in ('consultation', 'dental', 'theatre', 'nursing', 'beds', 'ultrasound'))
      group by 1, 2
    ), r as (
      select s.*, e.patient_id, e.arrived_at, e.reference, e.status, e.clinical_done_at, e.left_reason,
             e.no_diagnosis_kind, e.no_diagnosis_note,
             visit_departments(e.id) as depts
      from seen s join enc e on e.id = s.encounter_id
    )
    select jsonb_agg(jsonb_build_object(
        'encounterId', r.encounter_id, 'visitAt', r.arrived_at, 'seenAt', r.seen_at, 'reference', r.reference,
        'patientId', p.id, 'patient', p.surname || ' ' || p.given_names, 'fileNo', p.file_number, 'sex', p.sex,
        'age', case when p.birth_date is not null
                    then extract(year from age((r.arrived_at at time zone 'Africa/Kigali')::date, p.birth_date))::integer end,
        'clinicianId', r.clinician_id, 'clinician', pr.full_name, 'clinicianRole', pr.role, 'desk', r.station,
        'department', (select string_agg(d.name, ', ' order by d.name) from department d where d.id = any (r.depts)),
        'diagnosis', coalesce((select string_agg(coalesce(c.icd10_code || ' ', '') || c.text, '; '
                                        order by (c.type = 'primary') desc, c.created_at)
                      from condition c where c.encounter_id = r.encounter_id and c.deleted_at is null),
                      no_diagnosis_marker(r.no_diagnosis_kind, r.no_diagnosis_note)),
        'prescriptions', (select count(*) from medication_request m
                          where m.encounter_id = r.encounter_id and m.deleted_at is null and m.cancelled_at is null
                            and coalesce(m.prescriber_id, m.created_by) = r.clinician_id)::integer,
        'tests', (select count(*) from service_request x
                  where x.encounter_id = r.encounter_id and x.deleted_at is null
                    and x.requester_id = r.clinician_id)::integer,
        'outcome', case
            when exists (select 1 from queue_entry q2
                         where q2.encounter_id = r.encounter_id and q2.deleted_at is null
                           and q2.referred_by = r.clinician_id and q2.taken_by is distinct from r.clinician_id
                           and q2.station in ('consultation', 'dental', 'theatre', 'nursing', 'beds')) then 'referred'
            when r.status = 'open' and r.clinical_done_at is null then 'open'
            when r.left_reason is not null
                 or (r.clinical_done_at is null and r.no_diagnosis_kind is null
                     and not exists (select 1 from condition c where c.encounter_id = r.encounter_id
                                     and c.deleted_at is null and c.type = 'primary')) then 'left'
            else 'finished' end
      ) order by r.arrived_at desc, p.surname, pr.full_name)
    from r
    join patient p on p.id = r.patient_id
    join profiles pr on pr.id = r.clinician_id
    where (v_mgr or r.clinician_id = v_me or r.depts && v_heads)
      and (p_clinician is null or r.clinician_id = p_clinician)
      and (p_department is null or p_department = any (r.depts))
  ), '[]'::jsonb);
end
$$;

create or replace function report_diagnoses(
  p_from date, p_to date, p_department uuid default null, p_doctor uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_mgr boolean := is_manager();
  v_heads uuid[] := report_head_departments();
begin
  perform report_assert_clinical();
  perform report_assert_period(p_from, p_to);
  return coalesce((
    with c as (
      select c.encounter_id, upper(nullif(trim(c.icd10_code), '')) as code, trim(c.text) as text, c.type,
             c.created_by, e.patient_id, e.arrived_at, p.sex::text as sex,
             case when p.birth_date is not null
                  then extract(year from age((e.arrived_at at time zone 'Africa/Kigali')::date, p.birth_date))::integer end
               as age,
             visit_departments(e.id) as depts
      from condition c
      join encounter e on e.id = c.encounter_id and e.deleted_at is null
      join patient p on p.id = e.patient_id
      where c.deleted_at is null and (e.arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to
      -- 0125: a visit finished with no diagnosis found counts under its reason
      union all
      select e.id, null::text, no_diagnosis_marker(e.no_diagnosis_kind, null), 'primary'::condition_type,
             e.no_diagnosis_by, e.patient_id, e.arrived_at, p.sex::text,
             case when p.birth_date is not null
                  then extract(year from age((e.arrived_at at time zone 'Africa/Kigali')::date, p.birth_date))::integer end,
             visit_departments(e.id)
      from encounter e
      join patient p on p.id = e.patient_id
      where e.deleted_at is null and e.no_diagnosis_kind is not null
        and (e.arrived_at at time zone 'Africa/Kigali')::date between p_from and p_to
    ), v as (
      select c.*, coalesce(c.code, lower(c.text)) as k,
             exists (select 1 from condition c2 join encounter e2 on e2.id = c2.encounter_id and e2.deleted_at is null
                     where e2.patient_id = c.patient_id and e2.arrived_at < c.arrived_at and c2.deleted_at is null
                       and coalesce(upper(nullif(trim(c2.icd10_code), '')), lower(trim(c2.text)))
                           = coalesce(c.code, lower(c.text))) as follow_up
      from c
      where (v_mgr or c.created_by = v_me or c.depts && v_heads)
        and (p_doctor is null or c.created_by = p_doctor)
        and (p_department is null or p_department = any (c.depts))
    )
    select jsonb_agg(jsonb_build_object(
        'code', x.code, 'diagnosis', x.text, 'cases', x.cases, 'patients', x.patients,
        'newCases', x.new_cases, 'followUp', x.follow_up, 'primary', x.prim,
        'female', x.female, 'male', x.male, 'otherSex', x.cases - x.female - x.male,
        'age0to4', x.a0, 'age5to14', x.a5, 'age15to24', x.a15, 'age25to49', x.a25, 'age50plus', x.a50,
        'ageUnknown', x.au
      ) order by x.cases desc, x.text)
    from (
      select v.k, min(v.code) as code, mode() within group (order by v.text) as text,
             count(distinct v.encounter_id)::integer as cases,
             count(distinct v.patient_id)::integer as patients,
             count(distinct v.encounter_id) filter (where not v.follow_up)::integer as new_cases,
             count(distinct v.encounter_id) filter (where v.follow_up)::integer as follow_up,
             count(distinct v.encounter_id) filter (where v.type = 'primary')::integer as prim,
             count(distinct v.encounter_id) filter (where v.sex = 'female')::integer as female,
             count(distinct v.encounter_id) filter (where v.sex = 'male')::integer as male,
             count(distinct v.encounter_id) filter (where v.age < 5)::integer as a0,
             count(distinct v.encounter_id) filter (where v.age between 5 and 14)::integer as a5,
             count(distinct v.encounter_id) filter (where v.age between 15 and 24)::integer as a15,
             count(distinct v.encounter_id) filter (where v.age between 25 and 49)::integer as a25,
             count(distinct v.encounter_id) filter (where v.age >= 50)::integer as a50,
             count(distinct v.encounter_id) filter (where v.age is null)::integer as au
      from v group by v.k
    ) x
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- C Work tab: the person sees their own work
create or replace function staff_activity_detail(
  p_user uuid,
  p_from date default null,
  p_to date default null,
  p_kind text default null,
  p_limit integer default 500
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := is_manager();
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_start timestamptz;
  v_end timestamptz;
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 500);
  v_person jsonb;
  v_result jsonb;
begin
  if not v_manager and p_user is distinct from auth.uid() and not exists (
    select 1
    from staff_department mine
    join department d on d.id = mine.department_id and d.deleted_at is null
    join profiles me on me.id = mine.profile_id and me.active
    join staff_department theirs on theirs.department_id = mine.department_id
    where mine.profile_id = auth.uid() and mine.position in ('head', 'assistant') and theirs.profile_id = p_user) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_kind is not null and not (p_kind = any (analytics_kinds(v_manager))) then
    raise exception 'unknown kind of work' using errcode = '22023';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;
  v_start := v_from::timestamp at time zone 'Africa/Kigali';
  v_end := (v_to + 1)::timestamp at time zone 'Africa/Kigali';
  select jsonb_build_object('id', p.id, 'name', p.full_name, 'role', p.role, 'staffId', p.staff_id,
                            'active', p.active and p.deleted_at is null, 'lastSignIn', p.last_sign_in_at,
                            'departments', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) order by d.sort_order, d.name), '[]'::jsonb)
                                            from staff_department sd join department d on d.id = sd.department_id and d.deleted_at is null
                                            where sd.profile_id = p.id))
  into v_person
  from profiles p where p.id = p_user;
  if v_person is null then
    raise exception 'person not found' using errcode = 'P0002';
  end if;

  with ev as (
    select * from analytics_staff_events(v_start, v_end, v_manager) where user_id = p_user
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_to, 'person', v_person,
    'counts', (select coalesce(jsonb_object_agg(k, coalesce((select count(*) from ev where ev.kind = k), 0)), '{}'::jsonb)
               from unnest(analytics_kinds(v_manager)) k),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.day, 'kind', d.kind, 'n', d.n) order by d.day, d.kind)
      from (select (ev.at at time zone 'Africa/Kigali')::date as day, ev.kind, count(*) as n from ev group by 1, 2) d), '[]'::jsonb),
    'total', (select count(*) from ev where p_kind is null or ev.kind = p_kind),
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
          'at', r.at, 'kind', r.kind, 'encounterId', r.encounter_id, 'patientId', r.pid,
          'patientName', r.pname, 'fileNumber', r.file_number, 'what', r.what,
          'amount', case when v_manager then r.amount end) order by r.at desc)
      from (
        select ev.at, ev.kind, ev.encounter_id, ev.amount,
               -- 0088: what was written (a diagnosis, a medicine, a result…) only where the reader may
               -- see that visit's record; the manager and the person themselves always
               case when v_manager or ev.user_id = auth.uid()
                         or ev.kind in ('registered', 'patientsSeen', 'admissions',
                                        'payments', 'refunds', 'voided', 'handovers')
                         or (ev.encounter_id is not null and visit_view(ev.encounter_id) is not null)
                    then ev.what end as what,
               -- an HIV test names its patient to the manager only
               case when ev.kind = 'hivTests' and not v_manager then null else ev.patient_id end as pid,
               case when ev.kind = 'hivTests' and not v_manager then null else pt.surname || ' ' || pt.given_names end as pname,
               case when ev.kind = 'hivTests' and not v_manager then null else pt.file_number end as file_number
        from ev left join patient pt on pt.id = ev.patient_id
        where p_kind is null or ev.kind = p_kind
        order by ev.at desc
        limit v_limit) r), '[]'::jsonb),
    'signIns', coalesce((
      select jsonb_agg(jsonb_build_object('at', a.at, 'ok', a.reason is null or a.reason not like 'wrong PIN%', 'reason', a.reason)
                       order by a.at desc)
      from (select at, reason from audit_event
            where actor_id = p_user and action = 'login' and at >= v_start and at < v_end
            order by at desc limit 200) a), '[]'::jsonb),
    'money', case when v_manager then jsonb_build_object(
      'byMethod', coalesce((
        select jsonb_agg(jsonb_build_object('method', m.method, 'count', m.n, 'amount', m.amount) order by m.amount desc)
        from (select method, count(*) as n, sum(amount) as amount from payment
              where cashier_id = p_user and deleted_at is null and paid_at >= v_start and paid_at < v_end
              group by method) m), '[]'::jsonb),
      'refunds', coalesce((
        select jsonb_agg(jsonb_build_object('at', rf.refunded_at, 'amount', rf.amount, 'method', rf.method, 'reason', rf.reason,
                                            'patient', pt.surname || ' ' || pt.given_names, 'fileNumber', pt.file_number,
                                            'encounterId', i.encounter_id) order by rf.refunded_at desc)
        from refund rf
        join invoice i on i.id = rf.invoice_id
        left join encounter e on e.id = i.encounter_id
        left join patient pt on pt.id = e.patient_id
        where rf.cashier_id = p_user and rf.deleted_at is null and rf.refunded_at >= v_start and rf.refunded_at < v_end), '[]'::jsonb),
      'voided', coalesce((
        select jsonb_agg(jsonb_build_object('at', y.voided_at, 'paidAt', y.paid_at, 'amount', y.amount, 'method', y.method,
                                            'reason', y.void_reason, 'by', vb.full_name,
                                            'patient', coalesce(pt.surname || ' ' || pt.given_names, cs.buyer_name)) order by y.voided_at desc)
        from payment y
        left join profiles vb on vb.id = y.voided_by
        left join invoice i on i.id = y.invoice_id
        left join encounter e on e.id = i.encounter_id
        left join patient pt on pt.id = e.patient_id
        left join counter_sale cs on cs.id = y.counter_sale_id
        where y.cashier_id = p_user and y.voided_at is not null and y.voided_at >= v_start and y.voided_at < v_end), '[]'::jsonb),
      'closes', coalesce((
        select jsonb_agg(jsonb_build_object('day', c.date, 'expected', c.expected, 'counted', c.counted, 'variance', c.variance)
                         order by c.date desc)
        from day_close c
        where c.cashier_id = p_user and c.deleted_at is null and c.date between v_from and v_to), '[]'::jsonb))
    end
  ) into v_result;
  return v_result;
end
$$;

-- ---------------------------------------------------------------- C the employee profile
create table if not exists staff_hr (
  like mmc_base including all,
  profile_id uuid not null unique references profiles (id) on delete cascade,
  emergency_name text check (emergency_name is null or length(emergency_name) <= 120),
  emergency_phone text check (emergency_phone is null or length(emergency_phone) <= 30),
  address text check (address is null or length(address) <= 300),
  birth_date date,
  sex text check (sex is null or sex in ('female', 'male')),
  national_id text check (national_id is null or length(national_id) <= 40),
  hired_on date,
  contract_type text check (contract_type is null or contract_type in ('permanent', 'contract', 'intern', 'volunteer')),
  contract_end date,
  registration_expires_on date,
  check (contract_end is null or hired_on is null or contract_end >= hired_on)
);
comment on table staff_hr is
  'An employee''s personnel details (emergency contact, address, birth date, national ID, contract…); the manager writes them, the employee reads their own (0125).';
alter table staff_hr enable row level security;
-- read and written through the functions below only
revoke all on staff_hr from anon, authenticated;
select install_common_triggers('staff_hr');

create table if not exists staff_note (
  like mmc_base including all,
  profile_id uuid not null references profiles (id) on delete cascade,
  kind text not null check (kind in ('note', 'warning', 'training', 'leave', 'praise')),
  body text not null check (length(trim(body)) between 3 and 2000),
  noted_on date not null default ((now() at time zone 'Africa/Kigali')::date),
  deleted_by uuid references profiles (id),
  delete_reason text,
  check (deleted_at is null or length(trim(coalesce(delete_reason, ''))) >= 3)
);
create index if not exists staff_note_profile_idx on staff_note (profile_id, noted_on desc);
comment on table staff_note is
  'The manager''s private dated notes on an employee (warnings, training, leave…); the manager only (0125).';
alter table staff_note enable row level security;
revoke all on staff_note from anon, authenticated;
select install_common_triggers('staff_note');

-- A look of the manager at another person's profile: one 'read' line per half hour.
create or replace function log_staff_profile_access(p_profile uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or p_profile is null or p_profile = auth.uid() then
    return;
  end if;
  if exists (select 1 from audit_event a
             where a.actor_id = auth.uid() and a.entity = 'staff_profile' and a.action = 'read'
               and a.entity_id = p_profile and a.at > now() - interval '30 minutes') then
    return;
  end if;
  perform log_access('staff_profile', p_profile, 'read', 'profile');
end
$$;

-- The whole profile: the manager (anyone's), the employee (their own; not the manager's notes).
create or replace function staff_profile(p_profile uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid := coalesce(p_profile, auth.uid());
  v_mgr boolean := is_manager();
  v_p profiles%rowtype;
  v_h staff_hr%rowtype;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
begin
  if auth.uid() is null or current_role_key() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not (v_mgr or v_id = auth.uid()) then
    raise exception 'not allowed: an employee sees only their own profile' using errcode = '42501';
  end if;
  select * into v_p from profiles where id = v_id and deleted_at is null;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  perform log_staff_profile_access(v_id);
  select * into v_h from staff_hr where profile_id = v_id and deleted_at is null;
  return jsonb_build_object(
    'id', v_p.id, 'fullName', v_p.full_name, 'username', v_p.username, 'staffId', v_p.staff_id,
    'role', v_p.role, 'specialty', v_p.specialty, 'station', v_p.station, 'dashboard', v_p.dashboard,
    'email', v_p.email, 'phone', v_p.phone, 'language', v_p.language,
    'active', v_p.active, 'deactivatedAt', v_p.deactivated_at,
    'createdAt', v_p.created_at, 'createdBy', (select full_name from profiles where id = v_p.created_by),
    'lastSignInAt', v_p.last_sign_in_at, 'mustChangePin', v_p.must_change_pin, 'pinChangedAt', v_p.pin_changed_at,
    'registrationNo', v_p.registration_no, 'registrationBody', v_p.registration_body,
    'departments', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'position', sd.position)
                                              order by (sd.department_id = v_p.department_id) desc, d.name)
                             from staff_department sd join department d on d.id = sd.department_id and d.deleted_at is null
                             where sd.profile_id = v_id), '[]'::jsonb),
    'desks', to_jsonb(desks_of(v_id)),
    'hr', jsonb_build_object(
      'emergencyName', v_h.emergency_name, 'emergencyPhone', v_h.emergency_phone, 'address', v_h.address,
      'birthDate', v_h.birth_date, 'sex', v_h.sex, 'nationalId', v_h.national_id,
      'hiredOn', v_h.hired_on, 'contractType', v_h.contract_type, 'contractEnd', v_h.contract_end,
      'registrationExpiresOn', v_h.registration_expires_on,
      'updatedAt', case when v_h.id is not null then v_h.updated_at end,
      'updatedBy', (select full_name from profiles where id = coalesce(v_h.updated_by, v_h.created_by))),
    'access', jsonb_build_object(
      'permissions', (select coalesce(jsonb_agg(jsonb_build_object(
                          'key', k.p, 'allowed', staff_perm(v_id, k.p),
                          'byRole', exists (select 1 from role_permissions rp where rp.role = v_p.role and rp.permission = k.p),
                          'exception', sp.profile_id is not null,
                          'setAt', sp.set_at, 'setBy', (select full_name from profiles where id = sp.set_by))
                          order by k.n), '[]'::jsonb)
                      from unnest(array['payment.take', 'visit.start', 'vitals.write', 'charge.write', 'clinical.write',
                                        'orders.write', 'appointment.approve', 'stock.write', 'records.approve',
                                        'stock.sell_walkin']) with ordinality as k(p, n)
                      left join staff_permission sp on sp.profile_id = v_id and sp.permission = k.p),
      'trustedDevices', (select count(*)::integer from trusted_device t
                         where t.user_id = v_id and t.revoked_at is null and t.expires_at > now()),
      'signIns', coalesce((select jsonb_agg(jsonb_build_object('at', a.at, 'ok', a.reason is null or a.reason not like 'wrong PIN%',
                                                               'reason', a.reason) order by a.at desc)
                           from (select at, reason from audit_event
                                 where actor_id = v_id and action = 'login' and at > now() - interval '90 days'
                                 order by at desc limit 15) a), '[]'::jsonb),
      'failedSignIns30', (select count(*)::integer from audit_event
                          where actor_id = v_id and action = 'login' and reason like 'wrong PIN%'
                            and at > now() - interval '30 days')),
    'documents', (select jsonb_build_object(
                    'count', count(*)::integer,
                    'expired', count(*) filter (where d.expires_on < v_today)::integer,
                    'expiring', count(*) filter (where d.expires_on between v_today and v_today + 60)::integer)
                  from staff_document d where d.profile_id = v_id and d.deleted_at is null),
    'notes', case when v_mgr then coalesce((
               select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'body', n.body, 'notedOn', n.noted_on,
                                                   'at', n.created_at, 'by', (select full_name from profiles where id = n.created_by))
                                order by n.noted_on desc, n.created_at desc)
               from staff_note n where n.profile_id = v_id and n.deleted_at is null), '[]'::jsonb) end,
    'removedNotes', case when v_mgr then (select count(*)::integer from staff_note n
                                          where n.profile_id = v_id and n.deleted_at is not null) end,
    'canEdit', v_mgr,
    'self', v_id = auth.uid()
  );
end
$$;

-- The manager writes the personnel details (null clears a field). Role, e-mail, PIN and
-- deactivation stay in the Employees form (they need the e-mailed code).
create or replace function save_staff_profile(
  p_profile uuid,
  p_phone text default null,
  p_emergency_name text default null,
  p_emergency_phone text default null,
  p_address text default null,
  p_birth_date date default null,
  p_sex text default null,
  p_national_id text default null,
  p_hired_on date default null,
  p_contract_type text default null,
  p_contract_end date default null,
  p_registration_expires_on date default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_phone text := nullif(trim(coalesce(p_phone, '')), '');
  v_ephone text := nullif(trim(coalesce(p_emergency_phone, '')), '');
  v_old_phone text;
  v_before staff_hr%rowtype;
  v_changed text[] := '{}';
begin
  if not is_manager() then
    raise exception 'only the manager changes an employee''s profile' using errcode = '42501';
  end if;
  select phone into v_old_phone from profiles where id = p_profile and deleted_at is null;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if (v_phone is not null and v_phone !~ '^\+?[0-9][0-9 ()-]{5,19}$')
     or (v_ephone is not null and v_ephone !~ '^\+?[0-9][0-9 ()-]{5,19}$') then
    raise exception 'the phone number is not valid' using errcode = '22023';
  end if;
  if p_birth_date is not null and (p_birth_date > (now() at time zone 'Africa/Kigali')::date - 3650
                                   or p_birth_date < date '1920-01-01') then
    raise exception 'the date of birth is not valid' using errcode = '22023';
  end if;
  if p_sex is not null and p_sex not in ('female', 'male') then
    raise exception 'unknown sex' using errcode = '22023';
  end if;
  if p_contract_type is not null and p_contract_type not in ('permanent', 'contract', 'intern', 'volunteer') then
    raise exception 'unknown contract type' using errcode = '22023';
  end if;
  if p_contract_end is not null and p_hired_on is not null and p_contract_end < p_hired_on then
    raise exception 'the contract ends before the date hired' using errcode = '22023';
  end if;
  if length(coalesce(p_emergency_name, '')) > 120 or length(coalesce(p_address, '')) > 300
     or length(coalesce(p_national_id, '')) > 40 then
    raise exception 'the reason or the note is too long' using errcode = '22023';
  end if;
  select * into v_before from staff_hr where profile_id = p_profile;
  insert into staff_hr (profile_id, emergency_name, emergency_phone, address, birth_date, sex, national_id,
                        hired_on, contract_type, contract_end, registration_expires_on, updated_by)
  values (p_profile, nullif(trim(coalesce(p_emergency_name, '')), ''), v_ephone, nullif(trim(coalesce(p_address, '')), ''),
          p_birth_date, p_sex, nullif(trim(coalesce(p_national_id, '')), ''), p_hired_on, p_contract_type, p_contract_end,
          p_registration_expires_on, auth.uid())
  on conflict (profile_id) do update
  set emergency_name = excluded.emergency_name, emergency_phone = excluded.emergency_phone,
      address = excluded.address, birth_date = excluded.birth_date, sex = excluded.sex,
      national_id = excluded.national_id, hired_on = excluded.hired_on, contract_type = excluded.contract_type,
      contract_end = excluded.contract_end, registration_expires_on = excluded.registration_expires_on,
      updated_by = auth.uid(), deleted_at = null;
  if v_phone is distinct from v_old_phone then
    update profiles set phone = v_phone, updated_at = now() where id = p_profile;
    v_changed := array_append(v_changed, 'phone');
  end if;
  -- what changed, by name only (the values stay in the staff_hr audit rows, read by the manager)
  if v_before.emergency_name is distinct from nullif(trim(coalesce(p_emergency_name, '')), '')
     or v_before.emergency_phone is distinct from v_ephone then v_changed := array_append(v_changed, 'emergency'); end if;
  if v_before.address is distinct from nullif(trim(coalesce(p_address, '')), '') then v_changed := array_append(v_changed, 'address'); end if;
  if v_before.birth_date is distinct from p_birth_date then v_changed := array_append(v_changed, 'birthDate'); end if;
  if v_before.sex is distinct from p_sex then v_changed := array_append(v_changed, 'sex'); end if;
  if v_before.national_id is distinct from nullif(trim(coalesce(p_national_id, '')), '') then v_changed := array_append(v_changed, 'nationalId'); end if;
  if v_before.hired_on is distinct from p_hired_on or v_before.contract_type is distinct from p_contract_type
     or v_before.contract_end is distinct from p_contract_end then v_changed := array_append(v_changed, 'contract'); end if;
  if v_before.registration_expires_on is distinct from p_registration_expires_on then
    v_changed := array_append(v_changed, 'registrationExpiry');
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after, reason)
  values (auth.uid(), 'update', 'staff_profile', p_profile, jsonb_build_object('changed', to_jsonb(v_changed)), 'profile saved');
  return jsonb_build_object('profileId', p_profile, 'changed', to_jsonb(v_changed));
end
$$;

-- The manager's private notes on an employee.
create or replace function add_staff_note(p_profile uuid, p_kind text, p_body text, p_noted_on date default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if not is_manager() then
    raise exception 'only the manager keeps notes on an employee' using errcode = '42501';
  end if;
  if not exists (select 1 from profiles where id = p_profile and deleted_at is null) then
    raise exception 'employee not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if p_kind is null or p_kind not in ('note', 'warning', 'training', 'leave', 'praise') then
    raise exception 'unknown kind of note' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_body, ''))) < 3 then
    raise exception 'write the note' using errcode = '22023';
  end if;
  if length(p_body) > 2000 then
    raise exception 'the reason or the note is too long' using errcode = '22023';
  end if;
  if p_noted_on is not null and p_noted_on > (now() at time zone 'Africa/Kigali')::date + 366 then
    raise exception 'the date of the note is not valid' using errcode = '22023';
  end if;
  insert into staff_note (profile_id, kind, body, noted_on)
  values (p_profile, p_kind, trim(p_body), coalesce(p_noted_on, (now() at time zone 'Africa/Kigali')::date))
  returning id into v_id;
  return v_id;
end
$$;

create or replace function remove_staff_note(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_manager() then
    raise exception 'only the manager keeps notes on an employee' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the note is removed' using errcode = '22023';
  end if;
  update staff_note set deleted_at = now(), deleted_by = auth.uid(), delete_reason = trim(p_reason)
  where id = p_id and deleted_at is null;
  if not found then
    raise exception 'note not found' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------- D changing a booking
-- Frank: once a booking is accepted its details could not be changed. change_booking moves it
-- (a free time of the person's calendar, the same checks as a new booking), gives it to another
-- colleague (who is asked to accept, as for a new booking), or changes its reason and note. The
-- booking keeps its id; the audit history keeps old → new and why (appointment.change_reason).
-- Who: the booking's doctor (or nurse…), reception, the manager. Not once the patient came, nor
-- for a booking completed, cancelled, declined or not come. The other side is told: the doctor
-- moved it → reception; reception or the manager moved it → the doctor.
-- (appointment.change_reason is added with the other booking columns above)

-- The person's calendar, made the first time they are booked (no rights check: callers check).
create or replace function calendar_of(p_user uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_pr uuid;
  v_who text;
  v_staff text;
begin
  select id into v_pr from practitioner where user_id = p_user and deleted_at is null limit 1;
  if v_pr is null then
    select full_name, staff_id into v_who, v_staff from profiles where id = p_user;
    insert into practitioner (code, user_id, names, slot_minutes, working_hours, calendar_visibility, active)
    values (lower(coalesce(v_staff, 'dr-' || left(p_user::text, 8))), p_user, v_who, 30, '{}'::jsonb, 'private', true)
    returning id into v_pr;
  else
    update practitioner set active = true where id = v_pr and not active;
  end if;
  return v_pr;
end
$$;

create or replace function change_booking(
  p_id uuid,
  p_starts_at timestamptz default null,
  p_practitioner_user uuid default null,
  p_reason text default null,
  p_note text default null,
  p_why text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_a appointment%rowtype;
  v_old_user uuid;
  v_user uuid;
  v_pr uuid;
  v_at timestamptz;
  v_hours jsonb;
  v_slot integer;
  v_moved boolean;
  v_other boolean;
  v_status appointment_status;
  v_name text;
  v_why text := nullif(trim(coalesce(p_why, '')), '');
  v_params jsonb;
begin
  if v_me is null or current_role_key() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_a from appointment where id = p_id and deleted_at is null for update;
  if not found then
    raise exception 'booking not found' using errcode = 'P0002';
  end if;
  select user_id into v_old_user from practitioner where id = v_a.practitioner_id;
  if not (v_old_user = v_me or has_perm('appointment.approve') or is_manager()) then
    raise exception 'not allowed: a booking is changed by its doctor, reception or the manager' using errcode = '42501';
  end if;
  if v_a.status not in ('approved', 'confirmed') then
    raise exception 'this booking can no longer be changed' using errcode = '22023';
  end if;
  v_user := coalesce(p_practitioner_user, v_old_user);
  v_at := coalesce(p_starts_at, v_a.starts_at);
  v_other := v_user is distinct from v_old_user;
  v_moved := v_at is distinct from v_a.starts_at or v_other;
  if v_moved and length(coalesce(v_why, '')) < 3 then
    raise exception 'say why the booking is moved' using errcode = '22023';
  end if;
  if length(coalesce(v_why, '')) > 500 or length(coalesce(nullif(trim(coalesce(p_reason, '')), ''), '')) > 300
     or length(coalesce(nullif(trim(coalesce(p_note, '')), ''), '')) > 1000 then
    raise exception 'the reason or the note is too long' using errcode = '22023';
  end if;
  if v_other and not calendar_role_ok(v_user) then
    raise exception 'only doctors, sonographers, nurses and managers can be booked' using errcode = '22023';
  end if;
  v_pr := case when v_other then calendar_of(v_user) else v_a.practitioner_id end;
  select working_hours, coalesce(slot_minutes, 30) into v_hours, v_slot from practitioner where id = v_pr;
  if v_moved then
    if v_at < now() then
      raise exception 'the chosen time is in the past' using errcode = '22023';
    end if;
    if coalesce(v_hours, '{}'::jsonb) <> '{}'::jsonb and not practitioner_is_working(v_pr, v_at) then
      raise exception 'the doctor does not work at that time' using errcode = '22023';
    end if;
    if calendar_time_taken(v_pr, v_at, v_slot, p_id) then
      raise exception 'the doctor already has a booking at that time' using errcode = '23505';
    end if;
  end if;
  -- another person: asked to accept as for a new booking (unless it is me, or the manager's choice)
  v_status := case when not v_other then v_a.status
                   when v_user = v_me or not colleague_must_accept() then 'confirmed'
                   else 'approved' end;
  if v_other then
    delete from notification where kind = 'to_accept' and params ->> 'appointment' = p_id::text;
  end if;
  begin
    update appointment
    set starts_at = v_at,
        ends_at = case when v_moved then v_at + make_interval(mins => v_slot) else ends_at end,
        practitioner_id = v_pr,
        status = v_status,
        reason = case when p_reason is null then reason else nullif(trim(p_reason), '') end,
        note = case when p_note is null then note else nullif(trim(p_note), '') end,
        change_reason = coalesce(v_why, change_reason),
        accepted_by = case when v_other then case when v_status = 'confirmed' and v_user = v_me then v_me end
                           else accepted_by end,
        accepted_at = case when v_other then case when v_status = 'confirmed' then now() end else accepted_at end
    where id = p_id;
  exception when unique_violation then
    raise exception 'the doctor already has a booking at that time' using errcode = '23505';
  end;
  -- the other side is told (only when the time or the person changed)
  if v_moved then
    v_name := coalesce((select surname || ' ' || given_names from patient where id = v_a.patient_id), v_a.contact_name);
    v_params := jsonb_build_object('name', v_name, 'when', v_at, 'from', v_a.starts_at, 'appointment', p_id,
                                   'by', (select full_name from profiles where id = v_me), 'why', v_why);
    if v_old_user = v_me then
      insert into notification (kind, params, link, recipient_role, created_by)
      values ('booking_changed', v_params, '/app/appointments?day=' || to_char(v_at at time zone 'Africa/Kigali', 'YYYY-MM-DD'),
              'receptionist', v_me);
    elsif not v_other then
      insert into notification (kind, params, link, recipient_user, created_by)
      values ('booking_changed', v_params, '/app/my-bookings', v_old_user, v_me);
    end if;
    if v_other then
      -- the previous person: the booking left their calendar
      if v_old_user is not null and v_old_user <> v_me then
        insert into notification (kind, params, link, recipient_user, created_by)
        values ('booking_changed', v_params || jsonb_build_object('left', true), '/app/my-bookings', v_old_user, v_me);
      end if;
      -- the new person: asked (approved; the trigger asks when it was confirmed before) or told
      if v_user <> v_me then
        if v_status = 'approved' and v_a.status = 'approved' then
          insert into notification (kind, params, link, recipient_user, created_by)
          values ('to_accept', v_params, '/app', v_user, v_me);
        elsif v_status = 'confirmed' then
          insert into notification (kind, params, link, recipient_user, created_by)
          values ('booked_for_you', v_params, '/app/my-bookings', v_user, v_me);
        end if;
      end if;
    end if;
  end if;
  return jsonb_build_object('id', p_id, 'status', v_status, 'startsAt', v_at, 'moved', v_moved,
                            'with', (select full_name from profiles where id = v_user));
end
$$;

revoke all on function calendar_of(uuid) from public, anon, authenticated;
revoke all on function change_booking(uuid, timestamptz, uuid, text, text, text) from public, anon;
grant execute on function change_booking(uuid, timestamptz, uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------- grants
revoke all on function colleague_must_accept(), may_book_follow_up(),
  calendar_time_taken(uuid, timestamptz, integer, uuid), no_diagnosis_marker(text, text),
  condition_clears_no_diagnosis(), log_staff_profile_access(uuid)
  from public, anon, authenticated;
revoke all on function free_slots(uuid, date), book_follow_up(uuid, uuid, timestamptz, text, text, uuid),
  patient_bookings(uuid), set_no_diagnosis(uuid, text, text), finish_visit(uuid, text, text),
  remove_condition_none_found(uuid, text, text, text), staff_profile(uuid),
  save_staff_profile(uuid, text, text, text, text, date, text, text, date, text, date, date),
  add_staff_note(uuid, text, text, date), remove_staff_note(uuid, text)
  from public, anon;
grant execute on function free_slots(uuid, date), book_follow_up(uuid, uuid, timestamptz, text, text, uuid),
  patient_bookings(uuid), set_no_diagnosis(uuid, text, text), finish_visit(uuid, text, text),
  remove_condition_none_found(uuid, text, text, text), staff_profile(uuid),
  save_staff_profile(uuid, text, text, text, text, date, text, text, date, text, date, date),
  add_staff_note(uuid, text, text, date), remove_staff_note(uuid, text)
  to authenticated;
