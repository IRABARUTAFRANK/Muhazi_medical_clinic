-- 0088 · Hand one patient over to a colleague; "Cover for me" retired.
--
-- Frank: "for that to happen the patient must come to doctor X and when he feels like he wants
-- another doctor to cover for him and treat him, he sends through the system the patient to that
-- doctor to continue with him ... avoid any missing security".
--
--   * A  HAND OVER. The clinician who has the patient at a treating desk (taken by them, or sent to
--        them by name and not yet taken) picks a colleague who works at the same desk (serves the
--        section, uses the desk through their department or role, in the patient's department when
--        the patient was sent to one, may write clinical notes, active, not themselves) and writes
--        why and what is still to do. The colleague is told. Until they answer, the patient stays
--        with the sender, who keeps working and may cancel.
--   * B  TAKE. The colleague takes the patient: the queue entry becomes theirs (sent to and taken
--        by them), patients expected back by the sender (a test sent to the laboratory…) come back
--        to them, and a doctor becomes the visit's treating doctor when the sender was. The sender
--        loses the patient (unless they are in the visit for another reason: a task, a help
--        accepted). The sender is told. A patient at the laboratory or ultrasound whose result is
--        due back to the sender (return_to) is handed over too ("via return"): on Take only who
--        the patient comes back to moves. Result notices (and the way back without a return
--        asked) follow the handovers taken: result_recipient; "ordered by" stays.
--   * C  DECLINE, with a reason: nothing moves; the sender is told why.
--   * D  CANCEL: the sender (or the manager) withdraws a handover still waiting; the colleague is
--        told. A handover still waiting lapses by itself when the patient leaves the sender (sent
--        on, finished, taken by someone else), and ends when either colleague leaves the clinic
--        (deactivated or deleted); the other one is told. Every answer removes the colleague's
--        "hands over to you" notice.
--   * E  Everything is kept: patient_handover rows (who, when, the note, the answer, the reason)
--        with the audit trigger; the visit's track (visit_journey.handovers), the queue
--        (queue_board.handover_*), visit_access (canHandOver, handover), my_handovers().
--   * F  "COVER FOR ME" RETIRED (doctor and nurse cover). has_perm, may_use_desk and
--        queue_entry_for_me no longer look at clinician_cover; covering_for() is always null;
--        start_cover and end_cover refuse (hint cover_retired); my_cover() is empty; covers still
--        running end now; no new cover row can be written. The old rows stay readable (history).
--
-- Hints (the app translates them): handover_not_holder, handover_not_colleague, handover_note,
-- handover_reason, handover_pending, handover_not_yours, handover_gone, cover_retired,
-- not_permitted. Errcodes: 42501 not allowed, 22023 bad input, 23505 already done / changed,
-- P0002 not found.

-- ---------------------------------------------------------------- A the record
create table if not exists patient_handover (
  like mmc_base including all,
  encounter_id uuid not null references encounter (id),
  queue_id uuid not null references queue_entry (id),
  station station not null,
  -- true: the sender had no entry of their own at the desk but the patient was to come back to
  -- them (sent to the laboratory or ultrasound with the result due back): queue_id is that entry
  -- and only "who the patient comes back to" moves on Take
  via_return boolean not null default false,
  from_user uuid not null references profiles (id),
  to_user uuid not null references profiles (id),
  note text not null,
  -- pending → taken | declined | cancelled (by the sender or the manager) | lapsed (the patient left the sender)
  status text not null default 'pending'
    check (status in ('pending', 'taken', 'declined', 'cancelled', 'lapsed')),
  answered_at timestamptz,
  answered_by uuid references profiles (id),
  reason text,
  check (from_user <> to_user)
);
create unique index if not exists patient_handover_one_pending on patient_handover (queue_id)
  where status = 'pending' and deleted_at is null;
create index if not exists patient_handover_to_idx on patient_handover (to_user, status);
create index if not exists patient_handover_from_idx on patient_handover (from_user, status);
create index if not exists patient_handover_encounter_idx on patient_handover (encounter_id, created_at);
select install_common_triggers('patient_handover');

-- Read by the two colleagues, the manager and whoever reads clinical records (the queue badge,
-- the track); written through the functions below only.
alter table patient_handover enable row level security;
drop policy if exists patient_handover_read on patient_handover;
create policy patient_handover_read on patient_handover for select to authenticated
  using (from_user = auth.uid() or to_user = auth.uid() or is_manager() or has_perm('clinical.read'));
revoke insert, update, delete on patient_handover from anon, authenticated;
grant select on patient_handover to authenticated;

-- ---------------------------------------------------------------- F cover retired
-- The person's own rights only (the manager's exception first, else the role): no cover.
create or replace function has_perm(p_permission text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((
    select sp.allowed from staff_permission sp
    join profiles me on me.id = sp.profile_id and me.active
    where sp.profile_id = auth.uid() and sp.permission = p_permission
  ), exists (
    select 1
    from profiles p
    join role_permissions rp on rp.role = p.role
    where p.id = auth.uid() and p.active and rp.permission = p_permission
  ))
$$;

-- Kept for the functions that still ask: nobody covers anyone any more.
create or replace function covering_for(p_user uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select null::uuid
$$;

-- may_use_desk (from 20261126090000_departments_decide_desks): the person's own desks only.
create or replace function may_use_desk(p_desk text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select desk_via(auth.uid(), p_desk) is not null
$$;

-- queue_entry_for_me (from 20261112090000_sections_not_roles): without cover. A patient handed
-- over to me is mine only once I take them (take_handover).
create or replace function queue_entry_for_me(p_queue_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from queue_entry q
    join profiles me on me.id = auth.uid() and me.active
    where q.id = p_queue_id and q.deleted_at is null
      and (
        me.role = 'manager'
        or me.id = q.assigned_to or me.id = q.taken_by or me.id = q.return_to
        -- sent to the section: anyone who works in it
        or (q.assigned_to is null and q.taken_by is null
            and serves_station(me.id, q.station, q.service)
            and (q.department_id is null
                 or me.department_id = q.department_id
                 or exists (select 1 from staff_department sd
                            where sd.profile_id = me.id and sd.department_id = q.department_id)))
      )
  )
$$;

create or replace function start_cover(
  p_nurse uuid,
  p_until timestamptz,
  p_note text default null,
  p_doctor uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
begin
  raise exception 'cover is no longer used: hand the patient over to a colleague from the visit'
    using errcode = '42501', hint = 'cover_retired';
end
$$;

create or replace function end_cover(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  raise exception 'cover is no longer used: every cover has ended'
    using errcode = '42501', hint = 'cover_retired';
end
$$;

create or replace function my_cover()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object('covering', '[]'::jsonb, 'coveredBy', '[]'::jsonb)
$$;

-- Covers still running end now (patients an early version moved to the nurse go back).
do $$
declare
  v_id uuid;
begin
  for v_id in update clinician_cover set ended_at = now()
              where ended_at is null returning id loop
    perform give_back_covered(v_id);
  end loop;
end
$$;

-- No new cover row, whoever writes it.
create or replace function clinician_cover_retired()
returns trigger
language plpgsql
as $$
begin
  raise exception 'cover is no longer used: hand the patient over to a colleague from the visit'
    using errcode = '42501', hint = 'cover_retired';
end
$$;
drop trigger if exists trg_cover_retired on clinician_cover;
create trigger trg_cover_retired before insert on clinician_cover
  for each row execute function clinician_cover_retired();

-- ---------------------------------------------------------------- A who may hand over, to whom
-- The open queue entry by which this person has the patient: first an entry at a treating desk
-- taken by them, or sent to them by name and not taken yet (the latest one); else an open entry
-- elsewhere that brings the patient back to them (at the laboratory or ultrasound, the result
-- due back to them: return_to).
create or replace function handover_held_queue(p_encounter_id uuid, p_user uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select x.id from (
    select q.id, 0 as rank, q.created_at
    from queue_entry q
    where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
      and exists (select 1 from unnest(station_desks(q.station)) as d(desk) where d.desk = any (treating_desks()))
      and (q.taken_by = p_user or (q.taken_by is null and q.assigned_to = p_user))
    union all
    select q.id, 1 as rank, q.created_at
    from queue_entry q
    where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
      and q.return_to = p_user
  ) x
  join encounter e on e.id = p_encounter_id and e.status = 'open' and e.deleted_at is null
  where p_user is not null
  order by x.rank, x.created_at desc
  limit 1
$$;

-- Does the person have the patient by this entry itself (taken, or sent to them by name), or only
-- because the patient comes back to them (return_to)?
create or replace function handover_via_return(p_queue_id uuid, p_user uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select not coalesce((select q.taken_by = p_user or (q.taken_by is null and q.assigned_to = p_user)
                       from queue_entry q where q.id = p_queue_id), false)
$$;

-- The desk the handover is about: the entry's own desk, or (via return) the treating desk the
-- patient comes back to, with the service and department of the sender's entry there.
create or replace function handover_desk(p_queue_id uuid, p_return boolean)
returns table (station station, service text, department_id uuid)
language sql stable security definer set search_path = public
as $$
  select q.station, q.service, q.department_id
  from queue_entry q where q.id = p_queue_id and not p_return
  union all
  select coalesce(q.return_station, x.station), x.service, x.department_id
  from queue_entry q
  left join lateral (
    select x.station, x.service, x.department_id from queue_entry x
    where x.encounter_id = q.encounter_id and x.id <> q.id and x.deleted_at is null
      and (x.taken_by = q.return_to or x.assigned_to = q.return_to)
      and (q.return_station is null or x.station = q.return_station)
      and exists (select 1 from unnest(station_desks(x.station)) as d(desk) where d.desk = any (treating_desks()))
    order by x.created_at desc limit 1) x on true
  where q.id = p_queue_id and p_return
$$;

-- Does this colleague work where the patient is? Active, may write clinical notes, serves the
-- section (staff_serves), uses the desk (their department, or their role while no department
-- gives it; the manager's "not allowed" takes it away), and is in the patient's department when
-- the patient was sent to one.
create or replace function handover_colleague_ok(p_queue_id uuid, p_user uuid, p_return boolean default false)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from handover_desk(p_queue_id, p_return) k
    join profiles y on y.id = p_user and y.active and y.deleted_at is null
    where k.station is not null
      and staff_perm(y.id, 'clinical.write')
      and serves_station(y.id, k.station, k.service)
      and exists (select 1 from unnest(station_desks(k.station)) as d(desk)
                  where d.desk = any (treating_desks())
                    and (k.service is null or not (k.service = any (station_desks(k.station)))
                         or d.desk = k.service)
                    and desk_via(y.id, d.desk) is not null)
      and (k.department_id is null
           or y.department_id = k.department_id
           or exists (select 1 from staff_department sd
                      where sd.profile_id = y.id and sd.department_id = k.department_id))
  )
$$;

-- One handover as the screens show it.
create or replace function handover_json(h patient_handover)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', h.id, 'status', h.status, 'encounterId', h.encounter_id, 'queueId', h.queue_id,
    'station', h.station, 'service', q.service,
    'patientId', p.id, 'name', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
    'ticket', q.ticket_no,
    'fromId', h.from_user, 'fromName', f.full_name, 'toId', h.to_user, 'toName', t.full_name,
    'note', h.note, 'at', h.created_at, 'answeredAt', h.answered_at,
    'answeredBy', (select full_name from profiles where id = h.answered_by), 'reason', h.reason)
  from encounter e
  join patient p on p.id = e.patient_id
  join queue_entry q on q.id = h.queue_id
  join profiles f on f.id = h.from_user
  join profiles t on t.id = h.to_user
  where e.id = h.encounter_id
$$;

-- ---------------------------------------------------------------- A the colleagues to choose from
create or replace function handover_colleagues(p_encounter_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_qid uuid := handover_held_queue(p_encounter_id, auth.uid());
  v_return boolean;
begin
  if v_qid is null or not exists (select 1 from profiles where id = auth.uid() and active) then
    raise exception 'only the clinician who has the patient can hand them over'
      using errcode = '42501', hint = 'handover_not_holder';
  end if;
  v_return := handover_via_return(v_qid, auth.uid());
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', y.id, 'name', y.full_name, 'role', y.role, 'station', y.station,
             'specialty', y.specialty,
             -- patients they have now (taken, not finished)
             'patients', (select count(*) from queue_entry q2
                          join encounter e2 on e2.id = q2.encounter_id and e2.status = 'open'
                          where q2.taken_by = y.id and q2.finished_at is null and q2.deleted_at is null))
           order by y.full_name)
    from profiles y
    where y.id <> auth.uid() and y.active and y.deleted_at is null
      and handover_colleague_ok(v_qid, y.id, v_return)), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- A hand over
create or replace function handover_patient(p_encounter_id uuid, p_to uuid, p_note text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_me text;
  v_qid uuid;
  v_q queue_entry%rowtype;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_id uuid;
  v_name text;
  v_return boolean;
  v_station station;
begin
  select full_name into v_me from profiles where id = auth.uid() and active;
  if v_me is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not has_perm('clinical.write') then
    raise exception 'you may not hand patients over (the manager has not allowed it)'
      using errcode = '42501', hint = 'not_permitted';
  end if;
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open' and deleted_at is null) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  v_qid := handover_held_queue(p_encounter_id, auth.uid());
  if v_qid is null then
    raise exception 'only the clinician who has the patient can hand them over'
      using errcode = '42501', hint = 'handover_not_holder';
  end if;
  select * into v_q from queue_entry where id = v_qid for update;
  v_return := handover_via_return(v_qid, auth.uid());
  select k.station into v_station from handover_desk(v_qid, v_return) k;
  if v_note is null or length(v_note) < 3 then
    raise exception 'say why you hand the patient over and what is still to do'
      using errcode = '22023', hint = 'handover_note';
  end if;
  if length(v_note) > 1000 then
    raise exception 'the note is too long (1000 characters at most)' using errcode = '22023', hint = 'handover_note';
  end if;
  if p_to is null or p_to = auth.uid() or v_station is null
     or not handover_colleague_ok(v_qid, p_to, v_return) then
    raise exception 'choose an active colleague who works at this desk'
      using errcode = '42501', hint = 'handover_not_colleague';
  end if;
  if exists (select 1 from patient_handover
             where queue_id = v_qid and status = 'pending' and deleted_at is null) then
    raise exception 'this patient is already being handed over: cancel that first'
      using errcode = '23505', hint = 'handover_pending';
  end if;
  insert into patient_handover (encounter_id, queue_id, station, via_return, from_user, to_user, note)
  values (p_encounter_id, v_qid, v_station, v_return, auth.uid(), p_to, v_note)
  returning id into v_id;
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id;
  insert into notification (kind, params, link, recipient_user, urgent, created_by)
  values ('handover',
          jsonb_build_object('handover', v_id, 'by', v_me, 'name', v_name, 'ticket', v_q.ticket_no,
                             'station', v_station, 'note', v_note),
          '/app/visit?encounter=' || p_encounter_id, p_to, true, auth.uid());
  return v_id;
end
$$;

-- ---------------------------------------------------------------- B take
create or replace function take_handover(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_me text;
  v_h patient_handover%rowtype;
  v_q queue_entry%rowtype;
  v_name text;
  v_from_name text;
  v_qid uuid;
begin
  select full_name into v_me from profiles where id = auth.uid() and active;
  if v_me is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- Lock the queue entry before the handover, in the order of a queue change (whose trigger
  -- handover_follow_queue then updates the handover): no deadlock between the two.
  select queue_id into v_qid from patient_handover where id = p_id and deleted_at is null;
  if v_qid is null then
    raise exception 'handover not found' using errcode = 'P0002', hint = 'handover_gone';
  end if;
  select * into v_q from queue_entry where id = v_qid for update;
  select * into v_h from patient_handover where id = p_id and deleted_at is null for update;
  if not found then
    raise exception 'handover not found' using errcode = 'P0002', hint = 'handover_gone';
  end if;
  if v_h.to_user <> auth.uid() then
    raise exception 'this patient was not handed over to you' using errcode = '42501', hint = 'handover_not_yours';
  end if;
  if v_h.status <> 'pending' then
    raise exception 'this handover is no longer waiting (%)', v_h.status using errcode = '23505', hint = 'handover_gone';
  end if;
  if not has_perm('clinical.write') then
    raise exception 'you may not take patients over (the manager has not allowed it)'
      using errcode = '42501', hint = 'not_permitted';
  end if;
  select full_name into v_from_name from profiles where id = v_h.from_user;
  if v_q.finished_at is not null or v_q.deleted_at is not null
     or (v_h.via_return and v_q.return_to is distinct from v_h.from_user)
     or (not v_h.via_return
         and not coalesce(v_q.taken_by = v_h.from_user
                          or (v_q.taken_by is null and v_q.assigned_to = v_h.from_user), false)) then
    raise exception 'the patient is no longer with %', coalesce(v_from_name, 'the colleague')
      using errcode = '23505', hint = 'handover_gone';
  end if;
  if not handover_colleague_ok(v_q.id, auth.uid(), v_h.via_return) then
    raise exception 'you no longer work at this desk' using errcode = '42501', hint = 'handover_not_colleague';
  end if;
  -- the answer first, so the queue change below does not count as the patient leaving the sender
  update patient_handover set status = 'taken', answered_at = now(), answered_by = auth.uid()
  where id = p_id;
  -- the notice "X hands … over to you" has been answered
  delete from notification where kind = 'handover' and params ->> 'handover' = p_id::text;
  if not v_h.via_return then
    if v_q.pool_id is not null then
      perform 1 from queue_entry where pool_id = v_q.pool_id for update;
    end if;
    update queue_entry
    set assigned_to = auth.uid(), taken_by = auth.uid(),
        called_at = coalesce(called_at, now()), started_at = coalesce(started_at, now())
    where id = v_q.id;
    if v_q.pool_id is not null then
      update queue_entry set finished_at = now()
      where pool_id = v_q.pool_id and id <> v_q.id and finished_at is null;
    end if;
    -- the change of hands above is not a new referral (trg_notify_referral_update would tell me
    -- the patient was "sent" to me by the triage or reception, with their old note)
    delete from notification where kind in ('queue', 'referral') and params ->> 'queue' = v_q.id::text;
  end if;
  -- patients expected back by the sender come back to me (via return: this is the handover;
  -- the laboratory or ultrasound entry itself stays with whoever does the test)
  update queue_entry set return_to = auth.uid()
  where encounter_id = v_q.encounter_id and return_to = v_h.from_user
    and finished_at is null and deleted_at is null;
  -- the treating doctor of the visit, when it was the sender (or nobody yet)
  if current_role_key() = 'doctor' then
    update encounter set practitioner_id = ensure_practitioner(auth.uid())
    where id = v_q.encounter_id
      and (practitioner_id is null
           or practitioner_id in (select id from practitioner where user_id = v_h.from_user));
  end if;
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = v_q.encounter_id;
  insert into notification (kind, params, link, recipient_user, urgent, created_by)
  values ('handover_answer',
          jsonb_build_object('handover', p_id, 'taken', true, 'by', v_me, 'name', v_name,
                             'ticket', v_q.ticket_no),
          '/app/visit?encounter=' || v_q.encounter_id, v_h.from_user, false, auth.uid());
  return jsonb_build_object('encounterId', v_q.encounter_id, 'queueId', v_q.id, 'station', v_q.station);
end
$$;

-- ---------------------------------------------------------------- C decline
create or replace function decline_handover(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_me text;
  v_h patient_handover%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_name text;
  v_ticket text;
begin
  select full_name into v_me from profiles where id = auth.uid() and active;
  if v_me is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_h from patient_handover where id = p_id and deleted_at is null for update;
  if not found then
    raise exception 'handover not found' using errcode = 'P0002', hint = 'handover_gone';
  end if;
  if v_h.to_user <> auth.uid() then
    raise exception 'this patient was not handed over to you' using errcode = '42501', hint = 'handover_not_yours';
  end if;
  if v_h.status <> 'pending' then
    raise exception 'this handover is no longer waiting (%)', v_h.status using errcode = '23505', hint = 'handover_gone';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'say why you cannot take the patient' using errcode = '22023', hint = 'handover_reason';
  end if;
  update patient_handover
  set status = 'declined', answered_at = now(), answered_by = auth.uid(), reason = left(v_reason, 1000)
  where id = p_id;
  delete from notification where kind = 'handover' and params ->> 'handover' = p_id::text;
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = v_h.encounter_id;
  select ticket_no into v_ticket from queue_entry where id = v_h.queue_id;
  insert into notification (kind, params, link, recipient_user, urgent, created_by)
  values ('handover_answer',
          jsonb_build_object('handover', p_id, 'taken', false, 'by', v_me, 'name', v_name,
                             'ticket', v_ticket, 'reason', left(v_reason, 1000)),
          '/app/visit?encounter=' || v_h.encounter_id, v_h.from_user, true, auth.uid());
end
$$;

-- ---------------------------------------------------------------- D cancel
create or replace function cancel_handover(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_me text;
  v_h patient_handover%rowtype;
  v_name text;
  v_ticket text;
begin
  select full_name into v_me from profiles where id = auth.uid() and active;
  if v_me is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_h from patient_handover where id = p_id and deleted_at is null for update;
  if not found then
    raise exception 'handover not found' using errcode = 'P0002', hint = 'handover_gone';
  end if;
  if v_h.from_user <> auth.uid() and not is_manager() then
    raise exception 'only the colleague who handed the patient over can cancel it'
      using errcode = '42501', hint = 'handover_not_yours';
  end if;
  if v_h.status <> 'pending' then
    raise exception 'this handover is no longer waiting (%)', v_h.status using errcode = '23505', hint = 'handover_gone';
  end if;
  update patient_handover set status = 'cancelled', answered_at = now(), answered_by = auth.uid()
  where id = p_id;
  -- the colleague's notice "X hands … over to you" goes; the cancel notice below replaces it
  delete from notification where kind = 'handover' and params ->> 'handover' = p_id::text;
  select p.surname || ' ' || p.given_names into v_name
  from encounter e join patient p on p.id = e.patient_id where e.id = v_h.encounter_id;
  select ticket_no into v_ticket from queue_entry where id = v_h.queue_id;
  insert into notification (kind, params, link, recipient_user, urgent, created_by)
  values ('handover_cancelled',
          jsonb_build_object('handover', p_id, 'by', v_me, 'name', v_name, 'ticket', v_ticket),
          '/app/visit?encounter=' || v_h.encounter_id, v_h.to_user, false, auth.uid());
  -- the manager cancelled it: the sender is told too
  if v_h.from_user <> auth.uid() then
    insert into notification (kind, params, link, recipient_user, urgent, created_by)
    values ('handover_cancelled',
            jsonb_build_object('handover', p_id, 'by', v_me, 'name', v_name, 'ticket', v_ticket),
            '/app/visit?encounter=' || v_h.encounter_id, v_h.from_user, false, auth.uid());
  end if;
end
$$;

-- ---------------------------------------------------------------- D lapse: the patient left the sender
create or replace function handover_follow_queue()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r record;
begin
  for r in
    update patient_handover h
    set status = 'lapsed', answered_at = now()
    where h.queue_id = new.id and h.status = 'pending' and h.deleted_at is null
      and (new.finished_at is not null or new.deleted_at is not null
           or (h.via_return and new.return_to is distinct from h.from_user)
           or (not h.via_return
               and not coalesce(new.taken_by = h.from_user
                                or (new.taken_by is null and new.assigned_to = h.from_user), false)))
    returning h.id, h.to_user, h.from_user, h.encounter_id
  loop
    -- the colleague's notice goes, and they are told the patient moved on
    delete from notification where kind = 'handover' and params ->> 'handover' = r.id::text;
    insert into notification (kind, params, link, recipient_user, urgent, created_by)
    select 'handover_cancelled',
           jsonb_build_object('handover', r.id, 'by', f.full_name,
                              'name', p.surname || ' ' || p.given_names, 'ticket', new.ticket_no,
                              'lapsed', true),
           '/app/visit?encounter=' || r.encounter_id, r.to_user, false, auth.uid()
    from encounter e
    join patient p on p.id = e.patient_id
    join profiles f on f.id = r.from_user
    where e.id = r.encounter_id;
  end loop;
  return null;
end
$$;
drop trigger if exists trg_handover_follow on queue_entry;
create trigger trg_handover_follow
  after update of finished_at, deleted_at, taken_by, assigned_to, return_to on queue_entry
  for each row execute function handover_follow_queue();

-- A colleague who leaves the clinic (deactivated, or deleted: retire_staff deactivates too): the
-- handovers still waiting from or to them end, and the other colleague is told.
create or replace function handover_follow_profile()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r record;
begin
  for r in
    update patient_handover h
    set status = 'cancelled', answered_at = now(), answered_by = auth.uid(),
        reason = 'colleague no longer works here'
    where h.status = 'pending' and h.deleted_at is null
      and (h.from_user = new.id or h.to_user = new.id)
    returning h.id, h.to_user, h.from_user, h.encounter_id, h.queue_id
  loop
    delete from notification where kind = 'handover' and params ->> 'handover' = r.id::text;
    insert into notification (kind, params, link, recipient_user, urgent, created_by)
    select 'handover_cancelled',
           jsonb_build_object('handover', r.id, 'by', f.full_name,
                              'name', p.surname || ' ' || p.given_names, 'ticket', q.ticket_no,
                              'left', true, 'toName', t.full_name,
                              'leftName', case when r.from_user = new.id then f.full_name else t.full_name end),
           '/app/visit?encounter=' || r.encounter_id,
           case when r.from_user = new.id then r.to_user else r.from_user end, true, auth.uid()
    from encounter e
    join patient p on p.id = e.patient_id
    join profiles f on f.id = r.from_user
    join profiles t on t.id = r.to_user
    left join queue_entry q on q.id = r.queue_id
    where e.id = r.encounter_id;
  end loop;
  return null;
end
$$;
drop trigger if exists trg_handover_follow_profile on profiles;
create trigger trg_handover_follow_profile
  after update of active on profiles
  for each row when (old.active and not new.active)
  execute function handover_follow_profile();

-- ---------------------------------------------------------------- E my handovers
--   incoming  patients handed over to me, waiting for my answer;
--   outgoing  my handovers still waiting, and those answered in the last 12 hours.
create or replace function my_handovers()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'incoming', coalesce((
      select jsonb_agg(handover_json(h) order by h.created_at)
      from patient_handover h
      where h.to_user = auth.uid() and h.status = 'pending' and h.deleted_at is null), '[]'::jsonb),
    'outgoing', coalesce((
      select jsonb_agg(handover_json(h) order by h.created_at desc)
      from patient_handover h
      where h.from_user = auth.uid() and h.deleted_at is null
        and (h.status = 'pending' or h.answered_at > now() - interval '12 hours')), '[]'::jsonb)
  )
  where exists (select 1 from profiles where id = auth.uid() and active)
$$;

-- ---------------------------------------------------------------- E the visit page
-- visit_access (from 20261101180000_patients_belong_calls) + canHandOver and the handover waiting.
create or replace function visit_access(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'canWork', may_work_on(p_encounter_id),
    'canRoute', may_route(p_encounter_id),
    'holder', patient_holder(p_encounter_id),
    'helping', exists (select 1 from staff_call c
                       where c.encounter_id = p_encounter_id and c.kind = 'help'
                         and c.status = 'accepted' and c.answered_by = auth.uid()),
    'help', coalesce((
      select jsonb_agg(jsonb_build_object(
               'callId', c.id, 'status', c.status, 'asker', a.full_name,
               'helper', coalesce(h.full_name, t.full_name), 'mine', c.from_user = auth.uid(),
               'helperIsMe', c.answered_by = auth.uid(),
               'note', c.note) order by c.created_at)
      from staff_call c
      join profiles a on a.id = c.from_user
      left join profiles h on h.id = c.answered_by
      left join profiles t on t.id = c.to_user
      where c.encounter_id = p_encounter_id and c.kind = 'help' and c.status in ('open', 'accepted')), '[]'::jsonb),
    -- 0088: I have the patient at a treating desk and may hand them over
    'canHandOver', handover_held_queue(p_encounter_id, auth.uid()) is not null and has_perm('clinical.write'),
    -- 0088: the handover waiting for an answer on this visit (to me, from me, or anyone's for
    -- those who read clinical records: the note is clinical)
    'handover', (
      select handover_json(h) || jsonb_build_object('mine', h.from_user = auth.uid(), 'forMe', h.to_user = auth.uid())
      from patient_handover h
      where h.encounter_id = p_encounter_id and h.status = 'pending' and h.deleted_at is null
        and (h.from_user = auth.uid() or h.to_user = auth.uid() or has_perm('clinical.read'))
      order by h.created_at desc limit 1)
  )
  where exists (select 1 from profiles where id = auth.uid() and active)
$$;

-- queue_board (from 20261112090000_sections_not_roles): + the latest handover of the entry
-- (waiting or taken); a patient handed over to me counts as mine to look at (for_me) though I
-- work on them only once I take them (can_work).
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
         q.taken_by, coalesce(q.service, e.service) as service,
         (q.assigned_to = auth.uid() or q.taken_by = auth.uid()
          or (q.assigned_to is null and q.taken_by is null
              and serves_station(auth.uid(), q.station, q.service))
          or coalesce(ho.status = 'pending' and ho.to_user = auth.uid(), false)) as for_me,
         ho.id as handover_id, ho.status as handover_status,
         ho.from_user as handover_from, hf.full_name as handover_from_name,
         ho.to_user as handover_to, ht.full_name as handover_to_name,
         ho.note as handover_note, ho.created_at as handover_at, ho.answered_at as handover_answered_at
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  join patient p on p.id = e.patient_id
  left join profiles tb on tb.id = q.taken_by
  left join profiles asg on asg.id = q.assigned_to
  left join profiles rb on rb.id = q.referred_by
  left join department dep on dep.id = q.department_id
  left join lateral last_vitals_stamp(q.encounter_id) v on true
  left join lateral (select h.* from patient_handover h
                     where h.queue_id = q.id and h.status in ('pending', 'taken') and h.deleted_at is null
                     order by h.created_at desc limit 1) ho on true
  left join profiles hf on hf.id = ho.from_user
  left join profiles ht on ht.id = ho.to_user
  where q.deleted_at is null and e.status = 'open';

-- visit_journey (from 20261123090000_dispensing_fixes): + the handovers of the visit.
create or replace function visit_journey(p_encounter_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_steps jsonb;
  v_vitals jsonb;
  v_dx jsonb;
  v_meds jsonb;
  v_tests jsonb;
  v_charges jsonb;
  v_payments jsonb;
  v_bill jsonb;
  v_handovers jsonb;
  v_clinical boolean := has_perm('clinical.read');
  v_enc encounter%rowtype;
begin
  if not has_perm('patient.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_enc from encounter where id = p_encounter_id and deleted_at is null;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'station', q.station, 'queuedAt', q.created_at, 'calledAt', q.called_at, 'startedAt', q.started_at,
      'finishedAt', q.finished_at, 'takenBy', tb.full_name, 'assignedTo', asg.full_name,
      'referredBy', rb.full_name, 'note', q.referral_note, 'enteredBy', eb.full_name,
      'service', q.service, 'department', (select d.name from department d where d.id = q.department_id)
    ) order by q.created_at), '[]'::jsonb) into v_steps
  from queue_entry q
  left join profiles tb on tb.id = q.taken_by
  left join profiles asg on asg.id = q.assigned_to
  left join profiles rb on rb.id = q.referred_by
  left join profiles eb on eb.id = q.entered_by
  where q.encounter_id = p_encounter_id and q.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'code', o.code, 'value', o.value_num, 'unit', o.unit, 'at', o.effective_at,
      'by', (select full_name from profiles where id = o.performer_id)
    ) order by o.effective_at), '[]'::jsonb) into v_vitals
  from observation o where o.encounter_id = p_encounter_id and o.deleted_at is null and o.code <> 'note';

  select coalesce(jsonb_agg(jsonb_build_object(
      'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
      'by', (select full_name from profiles where id = c.created_by)
    ) order by c.created_at), '[]'::jsonb) into v_dx
  from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'item', i.name_generic || coalesce(' ' || i.strength, ''), 'quantity', m.quantity, 'dose', m.dose,
      'frequency', m.frequency, 'days', m.duration_days, 'supply', m.supply, 'givenAt', m.given_at,
      'givenBy', (select full_name from profiles where id = m.given_by), 'at', m.created_at,
      'by', (select full_name from profiles where id = m.created_by),
      'dispensed', exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
      'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason,
      'notGivenBy', (select full_name from profiles where id = m.not_given_by),
      'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
      'cancelledBy', (select full_name from profiles where id = m.cancelled_by)
    ) order by m.created_at), '[]'::jsonb) into v_meds
  from medication_request m join item i on i.id = m.item_id
  where m.encounter_id = p_encounter_id and m.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'test', s.name_en, 'status', r.status, 'priority', r.priority, 'at', r.created_at,
      'by', (select full_name from profiles where id = r.created_by),
      'result', (select coalesce(dr.impression, dr.findings) from diagnostic_report dr where dr.service_request_id = r.id and dr.deleted_at is null order by dr.created_at desc limit 1)
    ) order by r.created_at), '[]'::jsonb) into v_tests
  from service_request r left join service s on s.id = r.service_id
  where r.encounter_id = p_encounter_id and r.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'description', l.description, 'quantity', l.quantity, 'unitPrice', l.unit_price,
      'total', round(l.quantity * l.unit_price), 'office', l.office, 'at', l.created_at,
      'by', (select full_name from profiles where id = l.entered_by)
    ) order by l.created_at), '[]'::jsonb) into v_charges
  from invoice_line l join invoice i on i.id = l.invoice_id
  where i.encounter_id = p_encounter_id and l.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'amount', p.amount, 'method', p.method, 'reference', p.reference, 'at', p.paid_at,
      'by', (select full_name from profiles where id = p.cashier_id)
    ) order by p.paid_at), '[]'::jsonb) into v_payments
  from payment p join invoice i on i.id = p.invoice_id
  where i.encounter_id = p_encounter_id and p.deleted_at is null;

  select jsonb_build_object('status', b.status, 'total', b.total, 'balance', b.balance, 'paid', b.paid,
                            'number', b.number, 'settledBy', b.settled_by, 'settledAt', b.settled_at)
  into v_bill from visit_bill b where b.encounter_id = p_encounter_id;

  -- 0088: who handed the patient over to whom, when, why, and the answer (the note and the
  -- reason are clinical: for the two colleagues and those who read clinical records)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', h.id, 'station', h.station, 'at', h.created_at, 'from', f.full_name, 'to', t.full_name,
      'note', case when v_clinical or auth.uid() in (h.from_user, h.to_user) then h.note end,
      'status', h.status, 'answeredAt', h.answered_at,
      'answeredBy', (select full_name from profiles where id = h.answered_by),
      'reason', case when v_clinical or auth.uid() in (h.from_user, h.to_user) then h.reason end
    ) order by h.created_at), '[]'::jsonb) into v_handovers
  from patient_handover h
  join profiles f on f.id = h.from_user
  join profiles t on t.id = h.to_user
  where h.encounter_id = p_encounter_id and h.deleted_at is null;

  return jsonb_build_object(
    'encounterId', v_enc.id, 'arrivedAt', v_enc.arrived_at, 'status', v_enc.status, 'closedAt', v_enc.closed_at,
    'triage', v_enc.triage_level, 'triageReason', v_enc.triage_reason,
    'closedBy', (select full_name from profiles where id = v_enc.closed_by),
    -- the track: treatment finished, why the patient left, what they came for
    'treatmentDoneAt', v_enc.clinical_done_at, 'leftReason', v_enc.left_reason, 'service', v_enc.service,
    'steps', v_steps, 'vitals', v_vitals, 'diagnoses', v_dx, 'medicines', v_meds, 'tests', v_tests,
    'charges', v_charges, 'payments', v_payments, 'bill', v_bill, 'handovers', v_handovers
  );
end
$$;

-- ---------------------------------------------------------------- B results follow the handover
-- Who is told about a test result (and who the patient goes back to without a return asked):
-- the person who ordered it, or the colleague they handed the patient over to and who took them
-- (and so on, each handover taken after the one before). service_request.requester_id stays as
-- it is: "ordered by" is history.
create or replace function result_recipient(p_encounter uuid, p_requester uuid)
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare
  v_user uuid := p_requester;
  v_at timestamptz := '-infinity';
  v_next uuid;
  v_next_at timestamptz;
  v_hops integer := 0;
begin
  while v_user is not null and v_hops < 20 loop
    select h.to_user, h.answered_at into v_next, v_next_at
    from patient_handover h
    where h.encounter_id = p_encounter and h.from_user = v_user and h.status = 'taken'
      and h.deleted_at is null and h.answered_at > v_at
    order by h.answered_at
    limit 1;
    exit when v_next is null;
    v_user := v_next;
    v_at := v_next_at;
    v_next := null;
    v_hops := v_hops + 1;
  end loop;
  return v_user;
end
$$;

-- record_result (from 20261128090000_switches_enforced): the result notice goes to whoever
-- has the patient now (result_recipient).
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
  v_to uuid;
begin
  select * into v_req from service_request where id = p_request_id and deleted_at is null;
  if not found then
    raise exception 'test order not found' using errcode = 'P0002';
  end if;
  -- Lab / ultrasound results: lab staff and clinicians who order; an order done at another desk
  -- (Nursing, Dental…): the clinical staff of that desk too.
  if not ((may_use_desk(request_desk(v_req.station, v_req.category))
               and (request_desk(v_req.station, v_req.category) not in ('laboratory', 'ultrasound')
                    or has_perm('orders.write')))
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound')
              and may_use_any_desk(station_desks(v_req.station)))
          -- the clinician's own test while no department gives that desk (as before 0085)
          or (has_perm('orders.write') and v_req.requester_id = auth.uid()
              and not desk_offered(request_desk(v_req.station, v_req.category)))) then
    if may_use_desk(request_desk(v_req.station, v_req.category)) and not has_perm('orders.write') then
      raise exception 'you may not work on tests (the manager has not allowed it)'
        using errcode = '42501', hint = 'not_permitted';
    end if;
    perform assert_desk(array[request_desk(v_req.station, v_req.category)]);
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
  -- Tell the doctor who ordered it (0088: or the colleague they handed the patient over to).
  v_to := result_recipient(v_req.encounter_id, v_req.requester_id);
  if v_to is not null and v_to is distinct from auth.uid() then
    select s.name_en into v_test from service s where s.id = v_req.service_id;
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_req.encounter_id;
    insert into notification (kind, params, link, recipient_user, created_by)
    values ('result',
            jsonb_build_object('test', v_test, 'name', v_name,
                               'impression', nullif(trim(coalesce(p_impression, '')), ''),
                               'verified', p_verify),
            '/app/visit?encounter=' || v_req.encounter_id,
            v_to, auth.uid());
  end if;
  -- Last result of this desk written: the patient goes back to the doctor.
  v_station := coalesce(v_req.station, case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end);
  perform after_desk_tests(v_req.encounter_id, v_station, v_req.requester_id);
end
$$;


-- set_request_status (from 20261128090000_switches_enforced): "test not done" goes to whoever
-- has the patient now (result_recipient).
create or replace function set_request_status(p_id uuid, p_status request_status, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req service_request%rowtype;
  v_test text;
  v_name text;
  v_line uuid;
  v_invoice uuid;
  v_to uuid;
begin
  select * into v_req from service_request where id = p_id;
  -- the lab and imaging (orders.write); an order done at another desk (Nursing, Dental…): the
  -- clinical staff of that desk too
  if not ((may_use_desk(request_desk(v_req.station, v_req.category))
               and (request_desk(v_req.station, v_req.category) not in ('laboratory', 'ultrasound')
                    or has_perm('orders.write')))
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound')
              and may_use_any_desk(station_desks(v_req.station)))
          -- the clinician's own test while no department gives that desk (as before 0085)
          or (has_perm('orders.write') and v_req.requester_id = auth.uid()
              and not desk_offered(request_desk(v_req.station, v_req.category)))) then
    if may_use_desk(request_desk(v_req.station, v_req.category)) and not has_perm('orders.write') then
      raise exception 'you may not work on tests (the manager has not allowed it)'
        using errcode = '42501', hint = 'not_permitted';
    end if;
    perform assert_desk(array[request_desk(v_req.station, v_req.category)]);
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_status not in ('collected', 'in_process', 'cancelled') then
    raise exception 'use record_result for results' using errcode = '22023';
  end if;
  if p_status = 'cancelled' and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'a reason is required to cancel a test' using errcode = '22023';
  end if;
  update service_request
  set status = p_status,
      reason = case when p_status = 'cancelled' then coalesce(reason || ' · ', '') || 'cancelled: ' || trim(p_reason) else reason end
  where id = p_id and deleted_at is null and status not in ('verified', 'cancelled');
  if not found then
    raise exception 'test not found or already finished' using errcode = 'P0002';
  end if;
  -- sample taken / analysing: the patient is being seen at that desk
  if p_status in ('collected', 'in_process') then
    update queue_entry q set started_at = coalesce(q.started_at, now()), called_at = coalesce(q.called_at, now()),
                             taken_by = coalesce(q.taken_by, auth.uid())
    where q.encounter_id = v_req.encounter_id and q.finished_at is null and q.deleted_at is null
      and q.station = coalesce(v_req.station, case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end);
  end if;
  if p_status = 'cancelled' then
    select * into v_req from service_request where id = p_id;
    -- not done, not paid: its charge leaves the bill while the bill is open
    update invoice_line l
    set deleted_at = now(), manual_reason = coalesce(l.manual_reason || ' · ', '') || 'removed: test not done: ' || trim(p_reason)
    from invoice i
    where l.source_type = 'service_request' and l.source_id = p_id and l.deleted_at is null
      and i.id = l.invoice_id and i.status = 'draft'
    returning l.id, l.invoice_id into v_line, v_invoice;
    if v_invoice is not null then
      perform recompute_invoice(v_invoice);
    end if;
    -- the doctor who ordered it is told (0088: or the colleague they handed the patient over to)
    v_to := result_recipient(v_req.encounter_id, v_req.requester_id);
    if v_to is not null and v_to is distinct from auth.uid() then
      select s.name_en into v_test from service s where s.id = v_req.service_id;
      select p.surname || ' ' || p.given_names into v_name
      from encounter e join patient p on p.id = e.patient_id where e.id = v_req.encounter_id;
      insert into notification (kind, params, link, recipient_user, created_by)
      values ('test_cancelled', jsonb_build_object('test', v_test, 'name', v_name, 'reason', trim(p_reason)),
              '/app/visit?encounter=' || v_req.encounter_id, v_to, auth.uid());
    end if;
    perform after_desk_tests(v_req.encounter_id,
      coalesce(v_req.station, case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end),
      v_req.requester_id);
  end if;
end
$$;


-- correct_result (from 20261128090000_switches_enforced): the corrected result goes to whoever
-- has the patient now (result_recipient).
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
  v_to uuid;
begin
  select * into v_req from service_request where id = p_request_id and deleted_at is null;
  if not found then
    raise exception 'test order not found' using errcode = 'P0002';
  end if;
  if not (is_manager() or (may_use_desk(request_desk(v_req.station, v_req.category))
               and (request_desk(v_req.station, v_req.category) not in ('laboratory', 'ultrasound')
                    or has_perm('orders.write')))
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound')
              and may_use_any_desk(station_desks(v_req.station)))
          -- the clinician's own test while no department gives that desk (as before 0085)
          or (has_perm('orders.write') and v_req.requester_id = auth.uid()
              and not desk_offered(request_desk(v_req.station, v_req.category)))) then
    if may_use_desk(request_desk(v_req.station, v_req.category)) and not has_perm('orders.write') then
      raise exception 'you may not work on tests (the manager has not allowed it)'
        using errcode = '42501', hint = 'not_permitted';
    end if;
    perform assert_desk(array[request_desk(v_req.station, v_req.category)]);
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
  -- The doctor who ordered the test is told the result changed (0088: or the colleague they
  -- handed the patient over to).
  v_to := result_recipient(v_req.encounter_id, v_req.requester_id);
  if v_to is not null and v_to is distinct from auth.uid() then
    select s.name_en into v_test from service s where s.id = v_req.service_id;
    select p.surname || ' ' || p.given_names into v_name
    from encounter e join patient p on p.id = e.patient_id where e.id = v_req.encounter_id;
    insert into notification (kind, params, link, recipient_user, urgent, created_by)
    values ('result',
            jsonb_build_object('test', v_test, 'name', v_name,
                               'impression', nullif(trim(coalesce(p_impression, '')), ''),
                               'verified', true, 'corrected', true, 'reason', trim(p_reason)),
            '/app/visit?encounter=' || v_req.encounter_id,
            v_to, true, auth.uid());
  end if;
end
$$;


-- after_desk_tests (from 20261119090000_audit_fixes): with no return asked, the patient goes back
-- to whoever has them now (result_recipient), not always to who ordered the tests.
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
    -- 0088: the colleague the requester handed the patient over to, when they took them
    v_to := result_recipient(p_encounter_id, p_requester);
    select q.station into v_back from queue_entry q
    where q.encounter_id = p_encounter_id and q.station <> p_station
      and (q.taken_by = v_to or q.assigned_to = v_to)
    order by q.created_at desc limit 1;
    if v_back is null then
      select case p.role when 'doctor' then 'consultation'::station when 'nurse' then 'nursing'::station end
      into v_back from profiles p where p.id = v_to;
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


-- ---------------------------------------------------------------- grants
revoke all on function handover_held_queue(uuid, uuid), handover_colleague_ok(uuid, uuid, boolean),
  handover_via_return(uuid, uuid), handover_desk(uuid, boolean), handover_follow_profile(),
  result_recipient(uuid, uuid),
  handover_json(patient_handover), handover_follow_queue(), clinician_cover_retired()
  from public, anon, authenticated;
revoke all on function handover_colleagues(uuid), handover_patient(uuid, uuid, text), take_handover(uuid),
  decline_handover(uuid, text), cancel_handover(uuid), my_handovers()
  from public, anon;
grant execute on function handover_colleagues(uuid), handover_patient(uuid, uuid, text), take_handover(uuid),
  decline_handover(uuid, text), cancel_handover(uuid), my_handovers()
  to authenticated;
grant select on queue_board to authenticated;
