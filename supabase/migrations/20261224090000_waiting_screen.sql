-- 0114 · The waiting-room screen: a TV at the waiting side shows who was just called and where to
-- go, who is next at each desk, and whose results are ready.
--
-- Frank: "a screen at the waiting side that shows which patient is next, per department/desk, with
-- the doctor assigned or any doctor available. When a doctor finishes a patient and clicks Finish,
-- the system must find the patient waiting for his department and offer him; when he takes or
-- calls him, the screen tells that person to come to this area. Patients wait in the order they
-- came if they are all green; red and yellow are urgent in their department."
--
-- * display_screen: one row per screen the manager registers (Settings › Display › Waiting-room
--   screens): a name, the desks it shows (none = every desk with patients), whether it shows the
--   patients' full names, whether it dings, its languages and a message line. The TV opens
--   /display?key=… with a key the manager gets ONCE at creation (only its SHA-256 is kept);
--   revoking the screen ends the key. display_screens() lists them, save_display_screen(…) creates
--   (returning the key) or changes one, revoke_display_screen(id) ends one. Audited.
-- * display_board(p_key): what the TV shows, readable by anyone who holds a valid key (anon):
--   per desk "now" (called or started today, not finished: ticket, name or null, the room and
--   the person who called), "next" (waiting: red and yellow first, then arrival; the first 5),
--   and at the top "results" (laboratory / ultrasound results verified in the last 60 minutes for
--   open visits: ticket and name or null; never an HIV test); the clinic's name, the time at the
--   clinic, the message, chime, languages, and a `version` that changes whenever the board does.
--   Nothing clinical leaves the function: no triage reason, no test name, no result.
-- * queue_entry.called_by; call_patient(p_queue_id): "come to …" on the screen (called_at = now(),
--   called_by = me), callable again ("Call again"); allowed to whoever may take the patient, as
--   take_patient. call_patient_at(p_encounter_id, p_station): the same from a list that knows the
--   visit, not the queue entry (the laboratory worklist). take_patient
--   (20261211090000_booking_seen_rule) already sets called_at when it is still empty, so "Take"
--   shows on the screen too; nothing changes there.
-- * next_for_me(p_station): the patient to offer after Finish / send-on: assigned to me first,
--   then my department's, then anyone waiting at my desk; red and yellow first, then arrival.

-- ---------------------------------------------------------------- 1. the screens
create table if not exists display_screen (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  key_hash text not null unique,
  desks text[] not null default '{}',
  show_names boolean not null default true,
  chime boolean not null default true,
  languages text[] not null default '{rw,en,fr}',
  message text,
  active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  revoked_at timestamptz
);
comment on table display_screen is 'A waiting-room screen (TV): its key is kept as a SHA-256 only; the manager sees the key once.';
alter table display_screen enable row level security;
revoke all on display_screen from anon, authenticated;
-- audited like the departments (no version column: the audit trigger alone)
drop trigger if exists trg_audit on display_screen;
create trigger trg_audit after insert or update or delete on display_screen
  for each row execute function audit_row();

alter table queue_entry add column if not exists called_by uuid references profiles (id) on delete set null;
grant select (called_by) on queue_entry to authenticated;

/** The screens the manager registered, newest first (never the key). */
create or replace function display_screens()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'name', s.name, 'desks', to_jsonb(s.desks), 'showNames', s.show_names,
      'chime', s.chime, 'languages', to_jsonb(s.languages), 'message', s.message,
      'active', s.active and s.revoked_at is null, 'createdAt', s.created_at,
      'createdBy', (select full_name from profiles where id = s.created_by),
      'revokedAt', s.revoked_at
    ) order by (s.active and s.revoked_at is null) desc, s.created_at desc)
    from display_screen s
  ), '[]'::jsonb);
end
$$;

/**
 * Creates a screen (p_id null: the answer carries the plain key, shown once) or changes one.
 * Desks are station names (none = every desk with patients); languages among rw, en, fr.
 */
create or replace function save_display_screen(
  p_id uuid,
  p_name text,
  p_desks text[] default '{}',
  p_show_names boolean default true,
  p_chime boolean default true,
  p_languages text[] default '{rw,en,fr}',
  p_message text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_desks text[] := '{}';
  v_langs text[] := '{}';
  v_d text;
  v_key text;
  v_id uuid;
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_name is null or length(v_name) > 60 then
    raise exception 'give the screen a name' using errcode = '22023', hint = 'screen_name';
  end if;
  foreach v_d in array coalesce(p_desks, '{}') loop
    if not exists (select 1 from unnest(enum_range(null::station)) as x(s) where x.s::text = v_d) then
      raise exception 'unknown desk %', coalesce(v_d, '?') using errcode = '22023', hint = 'screen_desk';
    end if;
    if not (v_d = any (v_desks)) then
      v_desks := v_desks || v_d;
    end if;
  end loop;
  foreach v_d in array coalesce(p_languages, '{}') loop
    if v_d is null or v_d not in ('rw', 'en', 'fr') then
      raise exception 'unknown language %', coalesce(v_d, '?') using errcode = '22023', hint = 'screen_language';
    end if;
    if not (v_d = any (v_langs)) then
      v_langs := v_langs || v_d;
    end if;
  end loop;
  if cardinality(v_langs) = 0 then
    raise exception 'choose at least one language' using errcode = '22023', hint = 'screen_language';
  end if;
  if length(coalesce(p_message, '')) > 300 then
    raise exception 'the message is too long' using errcode = '22023', hint = 'screen_message';
  end if;
  if p_id is null then
    -- 256 random bits; only the hash is kept, so the key cannot be read back later
    v_key := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    insert into display_screen (name, key_hash, desks, show_names, chime, languages, message)
    values (v_name, encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), v_desks,
            coalesce(p_show_names, true), coalesce(p_chime, true), v_langs,
            nullif(trim(coalesce(p_message, '')), ''))
    returning id into v_id;
    return jsonb_build_object('id', v_id, 'key', v_key);
  end if;
  update display_screen
  set name = v_name, desks = v_desks, show_names = coalesce(p_show_names, true),
      chime = coalesce(p_chime, true), languages = v_langs,
      message = nullif(trim(coalesce(p_message, '')), ''), updated_at = now(), updated_by = auth.uid()
  where id = p_id and active and revoked_at is null;
  if not found then
    raise exception 'this screen is not known or was revoked' using errcode = 'P0002', hint = 'screen_unknown';
  end if;
  return jsonb_build_object('id', p_id);
end
$$;

/** Ends a screen: its key stops working at once (the TV shows "ask the manager"). */
create or replace function revoke_display_screen(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not has_perm('settings.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update display_screen set active = false, revoked_at = now(), updated_at = now(), updated_by = auth.uid()
  where id = p_id and active and revoked_at is null;
  if not found then
    raise exception 'this screen is not known or was revoked' using errcode = 'P0002', hint = 'screen_unknown';
  end if;
end
$$;

revoke all on function display_screens(), revoke_display_screen(uuid),
  save_display_screen(uuid, text, text[], boolean, boolean, text[], text) from public, anon;
grant execute on function display_screens(), revoke_display_screen(uuid),
  save_display_screen(uuid, text, text[], boolean, boolean, text[], text) to authenticated;

-- ---------------------------------------------------------------- 2. what the TV shows
/**
 * The board of one screen, for its key. Per desk: "now" (called or started today and still at
 * the desk, newest first, at most 4), "next" (waiting, red and yellow first then arrival, the
 * first 5) and how many wait; at the top the results verified in the last hour for open visits.
 * Names only when the screen shows them. `version` changes with the board; `now` is the time.
 */
create or replace function display_board(p_key text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_s display_screen%rowtype;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_desks text[];
  v_board jsonb;
  v_results jsonb;
  v_payload jsonb;
begin
  select * into v_s from display_screen
  where key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
    and active and revoked_at is null;
  if not found then
    raise exception 'this screen key is not known or was revoked' using errcode = '42501', hint = 'screen_unknown';
  end if;
  -- the desks shown: the ones chosen, else every desk with a patient now
  if cardinality(v_s.desks) > 0 then
    v_desks := v_s.desks;
  else
    select coalesce(array_agg(x.station::text order by x.station), '{}') into v_desks
    from (select distinct q.station
          from queue_entry q
          join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
          where q.deleted_at is null and q.finished_at is null) x;
  end if;
  select coalesce(jsonb_agg(d.j order by d.ord), '[]'::jsonb) into v_board
  from (
    select u.ord, jsonb_build_object(
      'station', u.s,
      'now', (
        select coalesce(jsonb_agg(n.j order by n.at desc), '[]'::jsonb)
        from (
          select coalesce(q.called_at, q.started_at) as at, jsonb_build_object(
                   'id', q.id, 'ticket', q.ticket_no,
                   'name', case when v_s.show_names then p.surname || ' ' || p.given_names end,
                   'room', pr.station, 'person', pr.full_name,
                   'calledAt', coalesce(q.called_at, q.started_at),
                   'started', q.started_at is not null
                 ) as j
          from queue_entry q
          join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
          join patient p on p.id = e.patient_id
          left join profiles pr on pr.id = coalesce(q.taken_by, q.called_by, q.assigned_to)
          where q.station::text = u.s and q.deleted_at is null and q.finished_at is null
            and coalesce(q.called_at, q.started_at) is not null
            and (coalesce(q.called_at, q.started_at) at time zone 'Africa/Kigali')::date = v_today
          order by coalesce(q.called_at, q.started_at) desc
          limit 4
        ) n
      ),
      'next', (
        select coalesce(jsonb_agg(x.j order by x.pri, x.at), '[]'::jsonb)
        from (
          select case when q.priority <= 2 then q.priority else 3 end as pri, q.created_at as at,
                 jsonb_build_object(
                   'id', q.id, 'ticket', q.ticket_no,
                   'name', case when v_s.show_names then p.surname || ' ' || p.given_names end,
                   'priority', least(q.priority, 3)
                 ) as j
          from queue_entry q
          join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
          join patient p on p.id = e.patient_id
          where q.station::text = u.s and q.deleted_at is null and q.finished_at is null
            and q.called_at is null and q.started_at is null
          order by 1, 2
          limit 5
        ) x
      ),
      'waiting', (
        select count(*)
        from queue_entry q
        join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
        where q.station::text = u.s and q.deleted_at is null and q.finished_at is null
          and q.called_at is null and q.started_at is null
      )
    ) as j
    from unnest(v_desks) with ordinality as u(s, ord)
  ) d;
  -- results verified in the last hour, one line per visit; never a sensitive (HIV) test
  select coalesce(jsonb_agg(r.j order by r.at desc), '[]'::jsonb) into v_results
  from (
    select max(d.verified_at) as at, jsonb_build_object(
             'id', e.id,
             'ticket', (select ticket_no from queue_entry where encounter_id = e.id order by created_at limit 1),
             'name', case when v_s.show_names then p.surname || ' ' || p.given_names end,
             'at', max(d.verified_at)
           ) as j
    from diagnostic_report d
    join service_request r on r.id = d.service_request_id and r.deleted_at is null
    join encounter e on e.id = r.encounter_id and e.status = 'open' and e.deleted_at is null
    join patient p on p.id = e.patient_id
    where d.deleted_at is null and d.verified_at > now() - interval '60 minutes'
      and r.category in ('lab', 'imaging') and not sensitive_service(r.service_id)
    group by e.id, p.surname, p.given_names
  ) r;
  v_payload := jsonb_build_object(
    'name', v_s.name, 'desks', v_board, 'results', v_results, 'message', v_s.message,
    'chime', v_s.chime, 'languages', to_jsonb(v_s.languages), 'showNames', v_s.show_names,
    'clinic', coalesce((select value ->> 'name' from setting where key = 'clinic.profile'), 'Muhazi Medical Clinic')
  );
  return v_payload || jsonb_build_object(
    'version', ('x' || left(md5(v_payload::text), 7))::bit(28)::int,
    'now', now()
  );
end
$$;
revoke all on function display_board(text) from public;
grant execute on function display_board(text) to anon, authenticated;

-- ---------------------------------------------------------------- 3. calling a patient
/** "Come to …" on the waiting-room screen; again as often as needed. Rights as take_patient. */
create or replace function call_patient(p_queue_id uuid)
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
  select * into v_q from queue_entry where id = p_queue_id and deleted_at is null for update;
  if not found then
    raise exception 'queue entry not found' using errcode = 'P0002';
  end if;
  if v_q.finished_at is not null then
    raise exception 'this patient has already left this desk' using errcode = '23505', hint = 'call_finished';
  end if;
  if v_q.taken_by is not null and v_q.taken_by <> auth.uid() and not is_manager() then
    select full_name into v_by from profiles where id = v_q.taken_by;
    raise exception 'already taken by %', coalesce(v_by, 'another doctor') using errcode = '23505';
  end if;
  if not queue_entry_for_me(p_queue_id) then
    raise exception 'this patient was sent to %', coalesce(patient_holder(v_q.encounter_id), 'another desk')
      using errcode = '42501';
  end if;
  update queue_entry set called_at = now(), called_by = auth.uid() where id = p_queue_id;
  return jsonb_build_object('queueId', p_queue_id, 'ticket', v_q.ticket_no, 'station', v_q.station,
                            'calledAt', now());
end
$$;

/** The same from a list that knows the visit and the desk (the laboratory worklist). */
create or replace function call_patient_at(p_encounter_id uuid, p_station station)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if not has_perm('queue.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select id into v_id from queue_entry
  where encounter_id = p_encounter_id and station = p_station and finished_at is null and deleted_at is null
  order by created_at desc
  limit 1;
  if v_id is null then
    raise exception 'this patient is not waiting at %', initcap(p_station::text)
      using errcode = 'P0002', hint = 'call_not_waiting';
  end if;
  return call_patient(v_id);
end
$$;

-- ---------------------------------------------------------------- 4. the next patient for me
/**
 * The patient to offer after Finish / send-on: waiting (not taken), assigned to me first, then my
 * department's, then anyone waiting at my desk (p_station); red and yellow first, then arrival.
 * Null when nobody waits. The row is what the queue board gives (no triage reason, no note).
 */
create or replace function next_for_me(p_station station default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select (
    select jsonb_build_object(
      'queueId', q.id, 'encounterId', q.encounter_id, 'ticket', q.ticket_no,
      'name', p.surname || ' ' || p.given_names, 'priority', least(q.priority, 3),
      'triage', e.triage_level, 'station', q.station, 'queuedAt', q.created_at,
      'calledAt', q.called_at, 'assignedToMe', coalesce(q.assigned_to = auth.uid(), false),
      'department', d.name,
      'waiting', (select count(*) from queue_entry q2
                  join encounter e2 on e2.id = q2.encounter_id and e2.status = 'open'
                  where q2.station = q.station and q2.finished_at is null and q2.started_at is null
                    and q2.deleted_at is null)
    )
    from queue_entry q
    join encounter e on e.id = q.encounter_id and e.status = 'open' and e.deleted_at is null
    join patient p on p.id = e.patient_id
    left join department d on d.id = q.department_id and d.deleted_at is null
    where has_perm('queue.read') and has_perm('patient.read')
      and q.deleted_at is null and q.finished_at is null and q.started_at is null and q.taken_by is null
      and (q.assigned_to = auth.uid()
           or (p_station is not null and q.station = p_station)
           or (q.assigned_to is null and q.department_id is not null
               and q.department_id in (select sd.department_id from staff_department sd where sd.profile_id = auth.uid())))
      and queue_entry_for_me(q.id)
    order by case when q.assigned_to = auth.uid() then 0
                  when q.department_id is not null
                       and q.department_id in (select sd.department_id from staff_department sd where sd.profile_id = auth.uid()) then 1
                  else 2 end,
             case when q.priority <= 2 then q.priority else 3 end,
             q.created_at
    limit 1
  )
$$;

revoke all on function call_patient(uuid), call_patient_at(uuid, station), next_for_me(station) from public, anon;
grant execute on function call_patient(uuid), call_patient_at(uuid, station), next_for_me(station) to authenticated;
