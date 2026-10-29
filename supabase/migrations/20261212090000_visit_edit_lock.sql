-- 0104 · A finished visit is locked; editing it needs an e-mailed code. Diagnoses and notes can
-- be corrected with a reason (history kept). Results are entered only by the desk that does the
-- test, never by the clinician who asked for it.
--
-- 1. A closed visit is not editable as such. To change it the clinician presses "Edit this
--    visit", gives a reason and receives a 6-digit code by e-mail (edge function
--    `visit-edit-code`, which calls request_visit_edit with the service role: the code never
--    reaches the browser). verify_visit_edit checks the code (5 tries, valid 10 minutes) and
--    opens a 30-minute edit window (visit_edit_grant). While the window is open, the paths that
--    refuse a closed visit accept it, and every change is written in the audit with the grant.
--    No code is needed while the visit is open (also when the patient is at the lab, the pharmacy
--    or the cashier: the visit stays open then). The manager uses the code too (no bypass); a
--    verified result is still corrected with correct_result as before.
-- 2. update_condition / remove_condition / update_note: the author (or the manager) changes or
--    removes a diagnosis, or changes a note, with a reason, while the visit is open or in an edit
--    window. The audit trigger of the tables keeps every previous version (audit_event rows with
--    before / after); the row itself carries the reason (edit_reason). The record shows "edited
--    by … on …" and the previous versions. A finished visit keeps its primary diagnosis.
-- 3. record_result / correct_result: the requester fallback ("my own test while no department
--    gives the laboratory") is gone: a doctor never enters the result of a test they asked for.

-- ---------------------------------------------------------------- the grants
create table if not exists visit_edit_grant (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references encounter (id),
  user_id uuid not null references profiles (id),
  reason text not null,
  code_hash text not null,
  requested_at timestamptz not null default now(),
  verified_at timestamptz,
  expires_at timestamptz,
  attempts integer not null default 0
);
create index if not exists visit_edit_grant_user_idx on visit_edit_grant (user_id, encounter_id, requested_at desc);
create index if not exists visit_edit_grant_encounter_idx on visit_edit_grant (encounter_id, expires_at desc);
comment on table visit_edit_grant is 'An e-mailed code to edit a finished visit: hashed code, 5 tries, valid 10 minutes; once verified a 30-minute edit window. Written and read through functions only.';
alter table visit_edit_grant enable row level security;
revoke all on visit_edit_grant from anon, authenticated;

alter table condition add column if not exists edit_reason text;
alter table observation add column if not exists edit_reason text;
comment on column condition.edit_reason is 'Why the diagnosis was last changed or removed (0104); the previous versions are in audit_event.';
comment on column observation.edit_reason is 'Why the note was last changed (0104); the previous versions are in audit_event.';

/** The hash kept for a code: salted with the grant id, so equal codes never hash the same. */
create or replace function visit_edit_hash(p_grant uuid, p_code text)
returns text
language sql immutable
as $$
  select encode(sha256(convert_to(p_grant::text || ':' || coalesce(p_code, ''), 'UTF8')), 'hex')
$$;

/** The edit window of a person on a visit, when one is open now (verified and not expired). */
create or replace function visit_edit_grant_id(p_encounter_id uuid, p_user uuid default auth.uid())
returns uuid
language sql stable security definer set search_path = public
as $$
  select g.id from visit_edit_grant g
  where g.encounter_id = p_encounter_id and g.user_id = p_user
    and g.verified_at is not null and g.expires_at > now()
  order by g.expires_at desc limit 1
$$;

/** True while the signed-in person holds an open edit window on this visit. */
create or replace function visit_edit_active(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select visit_edit_grant_id(p_encounter_id) is not null
$$;

/** The visit takes changes: open, or finished and inside the person's edit window. */
create or replace function visit_open_or_editing(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from encounter e
                 where e.id = p_encounter_id and e.deleted_at is null
                   and (e.status = 'open' or visit_edit_active(e.id)))
$$;

/** Who may ask to edit a finished visit: the manager, or a clinician who took part in it. */
create or replace function may_request_visit_edit(p_encounter_id uuid, p_user uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from profiles p
                 where p.id = p_user and p.active
                   and (p.role = 'manager'
                        or (staff_perm(p_user, 'clinical.write') and took_part(p_encounter_id, p_user))))
$$;

/** What an audit row of a change made inside an edit window carries. */
create or replace function visit_edit_tag(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce((select jsonb_build_object('visit_edit_grant', g.id, 'afterClose', true, 'editReason', g.reason)
                   from visit_edit_grant g where g.id = visit_edit_grant_id(p_encounter_id)), '{}'::jsonb)
$$;

/**
 * A change made to a finished visit inside an edit window is written in the audit with the
 * grant (the person, the reason given for the code, what changed). Nothing while the visit is
 * open: the tables' own audit trigger records the ordinary work.
 */
create or replace function note_visit_edit(p_encounter_id uuid, p_action audit_action, p_entity text, p_entity_id uuid, p_after jsonb default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_g visit_edit_grant%rowtype;
begin
  if exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    return;
  end if;
  select * into v_g from visit_edit_grant where id = visit_edit_grant_id(p_encounter_id);
  if not found then
    return;
  end if;
  insert into audit_event (actor_id, action, entity, entity_id, after, reason)
  values (auth.uid(), p_action, p_entity, p_entity_id,
          coalesce(p_after, '{}'::jsonb) || jsonb_build_object('visit_edit_grant', v_g.id, 'afterClose', true, 'encounter', p_encounter_id),
          'finished visit edited under grant ' || v_g.id || ': ' || v_g.reason);
end
$$;

/**
 * Step 1 of editing a finished visit: a 6-digit code is made for the caller and its hash kept.
 * The plain code is returned ONLY to the service role (the `visit-edit-code` edge function,
 * which verified the caller's session and e-mails it to them); the browser never sees it. The
 * service role names the person (p_user_id); anyone else is auth.uid(). At most 5 codes per
 * person and visit in 10 minutes.
 */
create or replace function request_visit_edit(p_encounter_id uuid, p_reason text, p_user_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_service boolean := current_user = 'service_role' or auth.role() = 'service_role';
  v_user uuid := case when v_service then p_user_id else auth.uid() end;
  v_e encounter%rowtype;
  v_code text;
  v_id uuid := gen_random_uuid();
  v_email text;
  v_recent integer;
begin
  if v_user is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_e from encounter where id = p_encounter_id and deleted_at is null;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_e.status = 'open' then
    raise exception 'this visit is still open: it is edited without a code' using errcode = '22023';
  end if;
  if not may_request_visit_edit(p_encounter_id, v_user) then
    raise exception 'only a clinician who treated the patient in this visit (or the manager) may edit it after it is finished'
      using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the finished visit is edited' using errcode = '22023';
  end if;
  select count(*) into v_recent from visit_edit_grant
  where user_id = v_user and encounter_id = p_encounter_id and requested_at > now() - interval '10 minutes';
  if v_recent >= 5 then
    raise exception 'too many codes were asked for this visit: wait ten minutes' using errcode = '42501';
  end if;
  -- six digits from the random bits of a uuid (gen_random_uuid draws from the strong source)
  v_code := lpad(((('x' || left(replace(gen_random_uuid()::text, '-', ''), 8))::bit(32)::bigint) % 1000000)::text, 6, '0');
  insert into visit_edit_grant (id, encounter_id, user_id, reason, code_hash)
  values (v_id, p_encounter_id, v_user, trim(p_reason), visit_edit_hash(v_id, v_code));
  select email into v_email from profiles where id = v_user;
  insert into audit_event (actor_id, action, entity, entity_id, after, reason)
  values (v_user, 'update', 'encounter', p_encounter_id,
          jsonb_build_object('visit_edit_grant', v_id, 'step', 'code_requested'),
          'edit of a finished visit asked: ' || trim(p_reason));
  return jsonb_build_object('id', v_id, 'codeUntil', now() + interval '10 minutes',
                            'email', case when v_service then v_email end,
                            'code', case when v_service then v_code end);
end
$$;
-- the edge function calls it with the service role
grant execute on function request_visit_edit(uuid, text, uuid) to service_role;

/**
 * Step 2: the person types the code they received. The latest code asked (not older than 10
 * minutes) is checked; 5 wrong tries end it. Right: a 30-minute edit window on the visit opens.
 * A wrong code answers {ok: false, triesLeft} instead of raising, so the try is counted (an
 * exception would roll the count back); no code waiting, or the tries spent, is refused.
 */
create or replace function verify_visit_edit(p_encounter_id uuid, p_code text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_g visit_edit_grant%rowtype;
  v_until timestamptz;
  v_left integer;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_g from visit_edit_grant
  where encounter_id = p_encounter_id and user_id = auth.uid() and verified_at is null
  order by requested_at desc limit 1
  for update;
  if not found or v_g.requested_at < now() - interval '10 minutes' then
    raise exception 'no code was asked for this visit, or it has expired: ask for a new one' using errcode = 'P0002';
  end if;
  if v_g.attempts >= 5 then
    raise exception 'too many wrong codes: ask for a new one' using errcode = '42501';
  end if;
  if v_g.code_hash <> visit_edit_hash(v_g.id, regexp_replace(coalesce(p_code, ''), '\s', '', 'g')) then
    update visit_edit_grant set attempts = attempts + 1 where id = v_g.id;
    v_left := 5 - v_g.attempts - 1;
    insert into audit_event (actor_id, action, entity, entity_id, after, reason)
    values (auth.uid(), 'update', 'encounter', p_encounter_id,
            jsonb_build_object('visit_edit_grant', v_g.id, 'step', 'wrong_code', 'triesLeft', v_left),
            'wrong code for the edit of a finished visit');
    return jsonb_build_object('ok', false, 'triesLeft', v_left);
  end if;
  v_until := now() + interval '30 minutes';
  update visit_edit_grant set verified_at = now(), expires_at = v_until, attempts = attempts + 1 where id = v_g.id;
  insert into audit_event (actor_id, action, entity, entity_id, after, reason)
  values (auth.uid(), 'update', 'encounter', p_encounter_id,
          jsonb_build_object('visit_edit_grant', v_g.id, 'step', 'window_opened', 'until', v_until),
          'edit window opened on a finished visit: ' || v_g.reason);
  return jsonb_build_object('ok', true, 'grantId', v_g.id, 'expiresAt', v_until);
end
$$;

/** The lock as the screen shows it: closed?, my window (until when), may I ask, a code waiting. */
create or replace function visit_edit_status(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'closed', e.status = 'closed',
    'closedAt', e.closed_at,
    'closedBy', (select full_name from profiles where id = e.closed_by),
    'active', g.id is not null,
    'expiresAt', g.expires_at,
    'grantId', g.id,
    'reason', g.reason,
    'canRequest', e.status = 'closed' and may_request_visit_edit(e.id, auth.uid()),
    -- a code e-mailed and not typed yet (none while a window is open)
    'pending', (select jsonb_build_object('requestedAt', p.requested_at,
                                          'codeUntil', p.requested_at + interval '10 minutes',
                                          'triesLeft', 5 - p.attempts, 'reason', p.reason)
                from visit_edit_grant p
                where g.id is null
                  and p.encounter_id = e.id and p.user_id = auth.uid() and p.verified_at is null
                  and p.requested_at > now() - interval '10 minutes' and p.attempts < 5
                order by p.requested_at desc limit 1))
  from encounter e
  left join visit_edit_grant g on g.id = visit_edit_grant_id(e.id)
  where e.id = p_encounter_id and e.deleted_at is null and auth.uid() is not null
$$;

-- ---------------------------------------------------------------- the paths that refused a closed visit
-- Who holds the patient: in an edit window the grant holder works on the visit (the grant was
-- given only to someone who treated the patient, or the manager).
create or replace function assert_may_work_on(p_encounter_id uuid, p_routing boolean default false)
returns void
language plpgsql stable security definer set search_path = public
as $$
declare
  v_ok boolean := case when p_routing then may_route(p_encounter_id) else may_work_on(p_encounter_id) end;
begin
  if v_ok then
    return;
  end if;
  if visit_edit_active(p_encounter_id) then
    return;
  end if;
  -- a missing or finished visit is reported by the caller
  if not exists (select 1 from encounter where id = p_encounter_id and status = 'open') then
    return;
  end if;
  raise exception 'this patient is with %: they must send the patient to you, or ask for your help',
    coalesce(patient_holder(p_encounter_id), 'another desk') using errcode = '42501';
end
$$;

create or replace function add_clinical_note(p_encounter_id uuid, p_text text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  if length(trim(coalesce(p_text, ''))) < 2 then
    raise exception 'the note is empty' using errcode = '22023';
  end if;
  if not visit_open_or_editing(p_encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into observation (encounter_id, code, value_text) values (p_encounter_id, 'note', trim(p_text))
  returning id into v_id;
  perform note_visit_edit(p_encounter_id, 'create', 'observation', v_id, jsonb_build_object('text', trim(p_text)));
  return v_id;
end
$$;

create or replace function add_diagnosis(p_encounter_id uuid, p_text text, p_icd10 text default null, p_type condition_type default 'primary', p_provisional boolean default false)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  if length(trim(coalesce(p_text, ''))) < 2 then
    raise exception 'the diagnosis needs a description' using errcode = '22023';
  end if;
  -- an HIV diagnosis (ICD-10 B20–B24) is written by the people allowed to see HIV results
  if upper(trim(coalesce(p_icd10, ''))) ~ '^B2[0-4]' and not has_perm('sensitive.read') then
    raise exception 'an HIV diagnosis is recorded by the people allowed to see HIV results'
      using errcode = '42501', hint = 'not_permitted';
  end if;
  if not visit_open_or_editing(p_encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into condition (encounter_id, text, icd10_code, type, provisional)
  values (p_encounter_id, trim(p_text), nullif(upper(trim(coalesce(p_icd10, ''))), ''), p_type, p_provisional)
  returning id into v_id;
  perform note_visit_edit(p_encounter_id, 'create', 'condition', v_id,
                          jsonb_build_object('text', trim(p_text), 'icd10', nullif(upper(trim(coalesce(p_icd10, ''))), ''),
                                             'type', p_type, 'provisional', p_provisional));
  return v_id;
end
$$;

/**
 * The author of a diagnosis (or the manager) changes it with a reason, while the visit is open
 * or inside an edit window. A null argument keeps the value (an empty ICD-10 clears it). The
 * previous version stays in the audit (the table's trigger); the row says why it changed.
 */
create or replace function update_condition(p_id uuid, p_text text default null, p_icd10 text default null, p_type condition_type default null, p_provisional boolean default null, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_c condition%rowtype;
  v_e encounter%rowtype;
  v_text text;
  v_icd text;
  v_type condition_type;
  v_prov boolean;
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
    raise exception 'say why the diagnosis is changed' using errcode = '22023';
  end if;
  v_text := trim(coalesce(p_text, v_c.text));
  if length(v_text) < 2 then
    raise exception 'the diagnosis needs a description' using errcode = '22023';
  end if;
  v_icd := case when p_icd10 is null then v_c.icd10_code else nullif(upper(trim(p_icd10)), '') end;
  if coalesce(v_icd, '') ~ '^B2[0-4]' and not has_perm('sensitive.read') then
    raise exception 'an HIV diagnosis is recorded by the people allowed to see HIV results'
      using errcode = '42501', hint = 'not_permitted';
  end if;
  v_type := coalesce(p_type, v_c.type);
  v_prov := coalesce(p_provisional, v_c.provisional);
  if v_text = v_c.text and v_icd is not distinct from v_c.icd10_code and v_type = v_c.type and v_prov = v_c.provisional then
    raise exception 'nothing changed' using errcode = '22023';
  end if;
  -- a finished visit keeps a primary diagnosis (the rule for closing still holds)
  if v_e.status = 'closed' and v_c.type = 'primary' and v_type <> 'primary'
     and v_e.type in ('opd', 'dental', 'procedure', 'observation')
     and not exists (select 1 from condition x where x.encounter_id = v_c.encounter_id and x.id <> v_c.id
                     and x.type = 'primary' and x.deleted_at is null) then
    raise exception 'a finished visit keeps a primary diagnosis: write the new one first' using errcode = '23514';
  end if;
  update condition
  set text = v_text, icd10_code = v_icd, type = v_type, provisional = v_prov, edit_reason = trim(p_reason)
  where id = p_id;
  perform note_visit_edit(v_c.encounter_id, 'update', 'condition', p_id,
                          jsonb_build_object('text', v_text, 'icd10', v_icd, 'type', v_type, 'provisional', v_prov,
                                             'reason', trim(p_reason)));
  return jsonb_build_object('id', p_id, 'text', v_text, 'icd10', v_icd, 'type', v_type, 'provisional', v_prov);
end
$$;

/** The author (or the manager) removes a diagnosis with a reason: hidden, kept in the record's history. */
create or replace function remove_condition(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_c condition%rowtype;
  v_e encounter%rowtype;
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
  if v_e.status = 'closed' and v_c.type = 'primary'
     and v_e.type in ('opd', 'dental', 'procedure', 'observation')
     and not exists (select 1 from condition x where x.encounter_id = v_c.encounter_id and x.id <> v_c.id
                     and x.type = 'primary' and x.deleted_at is null) then
    raise exception 'a finished visit keeps a primary diagnosis: write the new one first' using errcode = '23514';
  end if;
  update condition set deleted_at = now(), edit_reason = trim(p_reason) where id = p_id;
  perform note_visit_edit(v_c.encounter_id, 'delete', 'condition', p_id,
                          jsonb_build_object('text', v_c.text, 'icd10', v_c.icd10_code, 'type', v_c.type,
                                             'reason', trim(p_reason)));
end
$$;

/** The author of a note (or the manager) changes its text with a reason; the old text is kept. */
create or replace function update_note(p_id uuid, p_text text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_o observation%rowtype;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  select * into v_o from observation where id = p_id and code = 'note' and deleted_at is null for update;
  if not found then
    raise exception 'note not found' using errcode = 'P0002';
  end if;
  if not (is_manager() or coalesce(v_o.performer_id, v_o.created_by) = auth.uid() or v_o.created_by = auth.uid()) then
    raise exception 'only the clinician who wrote the note (or the manager) can change it' using errcode = '42501';
  end if;
  if not visit_open_or_editing(v_o.encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why the note is changed' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_text, ''))) < 2 then
    raise exception 'the note is empty' using errcode = '22023';
  end if;
  if trim(p_text) = v_o.value_text then
    raise exception 'nothing changed' using errcode = '22023';
  end if;
  update observation set value_text = trim(p_text), edit_reason = trim(p_reason) where id = p_id;
  perform note_visit_edit(v_o.encounter_id, 'update', 'observation', p_id,
                          jsonb_build_object('text', trim(p_text), 'reason', trim(p_reason)));
  return jsonb_build_object('id', p_id, 'text', trim(p_text));
end
$$;

-- Prescribing: a closed visit (in an edit window) takes only medicines bought outside: nothing
-- is charged to the posted bill, nothing waits at the pharmacy, nothing is taken from a store.
create or replace function prescribe(
  p_encounter_id uuid, p_item_id uuid, p_quantity numeric, p_dose text default null, p_route text default null,
  p_frequency text default null, p_duration_days integer default null, p_instructions text default null,
  p_supply text default 'pharmacy', p_station station default null, p_location_id uuid default null,
  p_medicine_name text default null, p_reference_code text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_charged boolean := false;
  v_loc uuid;
  v_taken boolean := false;
  v_qty integer;
  v_supply text := coalesce(p_supply, 'pharmacy');
  v_code text := nullif(trim(coalesce(p_reference_code, '')), '');
  v_name text;
  v_generic text;
  v_rule text;
  v_warn jsonb := '[]'::jsonb;
  v_closed boolean;
begin
  if not has_perm('clinical.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks(), 'treatment');
  perform assert_may_work_on(p_encounter_id);
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be more than zero' using errcode = '22023';
  end if;
  if v_supply not in ('pharmacy', 'room', 'outside') then
    raise exception 'unknown supply' using errcode = '22023';
  end if;
  if not visit_open_or_editing(p_encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  select e.status = 'closed' into v_closed from encounter e where e.id = p_encounter_id;
  if v_closed and v_supply <> 'outside' then
    raise exception 'the visit is finished: a medicine added now can only be bought outside' using errcode = '22023';
  end if;
  if p_item_id is null then
    -- not a clinic medicine: only for an outside pharmacy, named (or taken from the official list)
    if v_supply <> 'outside' then
      raise exception 'this medicine is not sold at the clinic: it can only be bought outside' using errcode = '22023';
    end if;
    if v_code is not null then
      select r.generic, r.prescribing_rule into v_generic, v_rule from medicine_reference r where r.code = v_code;
      if not found then
        raise exception 'medicine not found' using errcode = 'P0002';
      end if;
      v_warn := coalesce(rx_rule_warnings(v_rule, auth.uid()), '[]'::jsonb);
    end if;
    v_name := coalesce(nullif(trim(coalesce(p_medicine_name, '')), ''), v_generic);
    if v_name is null then
      raise exception 'write the name of the medicine to buy outside' using errcode = '22023';
    end if;
  else
    if not exists (select 1 from item where id = p_item_id and deleted_at is null) then
      raise exception 'medicine not found' using errcode = 'P0002';
    end if;
    v_warn := coalesce(rx_warnings(p_item_id, auth.uid()), '[]'::jsonb);
    if v_supply = 'outside' then
      -- the print keeps its name even if the catalogue changes
      v_name := item_label(p_item_id);
      v_code := coalesce(v_code, (select i.code from item i where i.id = p_item_id
                                    and exists (select 1 from medicine_reference r where r.code = i.code)));
    else
      v_code := null;
    end if;
  end if;
  if v_supply = 'room' then
    -- Given here: only from a store that holds enough unexpired units; never given without stock.
    v_qty := ceil(p_quantity)::integer;
    v_loc := room_store_for(auth.uid(), p_item_id, v_qty, p_location_id, p_station);
    if v_loc is null then
      raise exception 'not enough of this medicine (not expired) in %: prescribe it for the pharmacy instead',
        case when p_location_id is null then 'a store you may give from' else 'that store' end
        using errcode = 'MS003', hint = 'room_short';
    end if;
  end if;
  insert into medication_request (encounter_id, item_id, dose, route, frequency, duration_days, quantity,
                                  instructions, supply, given_at, given_by, medicine_name, reference_code,
                                  supply_set_at, supply_set_by)
  values (p_encounter_id, p_item_id, nullif(trim(coalesce(p_dose, '')), ''), nullif(trim(coalesce(p_route, '')), ''),
          nullif(trim(coalesce(p_frequency, '')), ''), p_duration_days, p_quantity,
          nullif(trim(coalesce(p_instructions, '')), ''), v_supply,
          case when v_supply = 'room' then now() end, case when v_supply = 'room' then auth.uid() end,
          v_name, v_code, now(), auth.uid())
  returning id into v_id;
  if v_supply = 'room' then
    perform give_from_store(p_item_id, v_loc, v_qty, v_id, 'given in the room');
    v_taken := true;
    -- on the bill at the medicine's price (no price: given free); a closed bill refuses (MS001)
    begin
      perform add_charge_internal(p_encounter_id, coalesce(p_station, 'consultation'::station), null, p_item_id, p_quantity,
                         null, null, null, null, 'medication_request', v_id);
      v_charged := true;
    exception when sqlstate 'P0002' then
      v_charged := false;
    end;
  elsif v_supply = 'pharmacy'
        and not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = 'pharmacy'
                        and finished_at is null and deleted_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no)
    values (p_encounter_id, 'pharmacy', (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1));
  end if;
  -- 'outside': nothing charged, nothing taken, nothing queued
  perform note_visit_edit(p_encounter_id, 'create', 'medication_request', v_id,
                          jsonb_build_object('item', v_name, 'itemId', p_item_id, 'quantity', p_quantity, 'supply', v_supply));
  return jsonb_build_object('id', v_id, 'supply', v_supply, 'charged', v_charged,
                            'stockTaken', v_taken, 'locationId', v_loc, 'medicineName', v_name,
                            'warnings', v_warn);
end
$$;

-- A test on a finished visit (edit window): the order is written and charged as usual; a bill
-- already posted refuses the charge (MS001), as for any charge after the visit.
create or replace function order_test(p_encounter_id uuid, p_service_id uuid, p_reason text default null, p_priority integer default 3)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_group service_group;
  v_cat request_category;
  v_station station;
begin
  if not has_perm('orders.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform assert_desk(treating_desks() || array['laboratory', 'ultrasound'], 'ordering tests');
  perform assert_may_work_on(p_encounter_id);
  select s.service_group,
         coalesce(c.order_station, case when s.service_group = 'imaging' then 'ultrasound'::station else 'laboratory'::station end)
  into v_group, v_station
  from service s left join service_category c on c.id = s.category_id
  where s.id = p_service_id and s.active and s.deleted_at is null;
  if v_group is null then
    raise exception 'unknown service' using errcode = '22023';
  end if;
  v_cat := case when v_station = 'ultrasound' then 'imaging'::request_category else 'lab'::request_category end;
  if not visit_open_or_editing(p_encounter_id) then
    raise exception 'visit not found or already closed' using errcode = 'P0002';
  end if;
  insert into service_request (encounter_id, category, service_id, reason, priority, station)
  values (p_encounter_id, v_cat, p_service_id, nullif(trim(coalesce(p_reason, '')), ''), least(5, greatest(1, p_priority)), v_station)
  returning id into v_id;
  perform add_charge_internal(p_encounter_id, v_station, p_service_id, null, 1, null, null, null, null, 'service_request', v_id);
  if not exists (select 1 from queue_entry where encounter_id = p_encounter_id and station = v_station and finished_at is null) then
    insert into queue_entry (encounter_id, station, ticket_no, priority)
    values (p_encounter_id, v_station, (select ticket_no from queue_entry where encounter_id = p_encounter_id order by created_at limit 1), least(5, greatest(1, p_priority)));
  end if;
  perform note_visit_edit(p_encounter_id, 'create', 'service_request', v_id,
                          jsonb_build_object('serviceId', p_service_id, 'station', v_station));
  return v_id;
end
$$;

-- record_vitals: redefined in 20261213090000_vitals_custom.sql with the edit window (visit_edit_active).

-- Files: added while the visit is open, or inside an edit window.
create or replace function may_attach_file(p_encounter_id uuid, p_service_request_id uuid default null)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(auth.uid() is not null
    and exists (select 1 from encounter e
                where e.id = p_encounter_id and e.deleted_at is null
                  and (e.status = 'open' or visit_edit_active(e.id)))
    and (p_service_request_id is null
         or exists (select 1 from service_request r
                    where r.id = p_service_request_id and r.encounter_id = p_encounter_id
                      and r.deleted_at is null and r.status <> 'cancelled'))
    and (
      ((has_perm('clinical.write') or has_perm('orders.write')) and clinical_reader()
       and (may_work_on(p_encounter_id) or visit_edit_active(p_encounter_id)))
      or (has_perm('orders.write')
          and exists (select 1 from service_request r
                      where r.encounter_id = p_encounter_id and r.deleted_at is null
                        and r.status <> 'cancelled'
                        and (p_service_request_id is null or r.id = p_service_request_id)
                        and may_use_desk(request_desk(r.station, r.category))))
    ), false)
$$;

create or replace function attach_file(
  p_encounter_id uuid,
  p_path text,
  p_kind text,
  p_title text,
  p_mime text,
  p_size integer,
  p_service_request_id uuid default null,
  p_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_e encounter%rowtype;
  v_ext text := lower(substring(coalesce(p_path, '') from '\.([a-zA-Z]+)$'));
  v_obj_found boolean := false;
  v_obj_size bigint;
  v_obj_mime text;
  v_f patient_file_doc%rowtype;
  v_req service_request%rowtype;
  v_to uuid;
  v_name text;
  v_file text;
  v_me text;
  v_test text;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_e from encounter where id = p_encounter_id and deleted_at is null;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_e.status <> 'open' and not visit_edit_active(v_e.id) then
    raise exception 'files are added while the visit is open' using errcode = '22023', hint = 'file_visit_closed';
  end if;
  if coalesce(p_kind, '') not in ('ultrasound', 'lab', 'scan', 'referral', 'photo', 'other') then
    raise exception 'unknown kind of file' using errcode = '22023', hint = 'file_kind';
  end if;
  if length(trim(coalesce(p_title, ''))) = 0 or length(trim(p_title)) > 200 then
    raise exception 'give the file a title' using errcode = '22023', hint = 'title_needed';
  end if;
  if not file_mime_ok(p_mime) then
    raise exception 'only photos (JPEG, PNG, WebP) and PDF files' using errcode = '22023', hint = 'file_type';
  end if;
  if p_size is null or p_size <= 0 or p_size > file_max_bytes() then
    raise exception 'the file is larger than 10 MB' using errcode = '22023', hint = 'file_too_big';
  end if;
  if file_path_encounter(p_path) is distinct from p_encounter_id
     or split_part(p_path, '/', 1) <> v_e.patient_id::text
     or not file_ext_ok(p_mime, v_ext) then
    raise exception 'the file is not stored where this visit''s files go' using errcode = '22023', hint = 'file_path';
  end if;
  if p_service_request_id is not null then
    select * into v_req from service_request
    where id = p_service_request_id and encounter_id = p_encounter_id and deleted_at is null;
    if not found or v_req.status = 'cancelled' then
      raise exception 'this test is not one of the visit' using errcode = '22023', hint = 'wrong_test';
    end if;
  end if;
  if not may_attach_file(p_encounter_id, p_service_request_id) then
    raise exception 'not allowed: only the people working on the visit add files'
      using errcode = '42501', hint = 'not_on_visit';
  end if;
  -- On Supabase: the file must be in the bucket, with the size and type said.
  if to_regclass('storage.objects') is not null then
    execute 'select true, (metadata ->> ''size'')::bigint, metadata ->> ''mimetype''
             from storage.objects where bucket_id = ''patient-files'' and name = $1'
      into v_obj_found, v_obj_size, v_obj_mime using p_path;
    if not coalesce(v_obj_found, false) then
      raise exception 'the file did not arrive: send it again' using errcode = '22023', hint = 'not_uploaded';
    end if;
    if v_obj_size is not null and v_obj_size > file_max_bytes() then
      raise exception 'the file is larger than 10 MB' using errcode = '22023', hint = 'file_too_big';
    end if;
    if v_obj_mime is not null and not file_mime_ok(v_obj_mime) then
      raise exception 'only photos (JPEG, PNG, WebP) and PDF files' using errcode = '22023', hint = 'file_type';
    end if;
  end if;
  insert into patient_file_doc (patient_id, encounter_id, service_request_id, kind, title, note,
                                storage_path, mime_type, size_bytes, uploaded_by)
  values (v_e.patient_id, p_encounter_id, p_service_request_id, p_kind, trim(p_title),
          nullif(trim(coalesce(p_note, '')), ''), p_path, p_mime,
          coalesce(v_obj_size::integer, p_size), auth.uid())
  returning * into v_f;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'create', 'patient_file_doc', v_f.id,
          jsonb_build_object('patient', v_f.patient_id, 'encounter', v_f.encounter_id, 'kind', v_f.kind,
                             'title', v_f.title, 'mime', v_f.mime_type, 'size', v_f.size_bytes)
          || visit_edit_tag(p_encounter_id));
  -- the laboratory or ultrasound added a file to a test: its requester is told, or the colleague
  -- who took the patient over since (as the result notices do)
  if v_req.id is not null and v_req.requester_id is not null then
    v_to := result_recipient(v_req.encounter_id, v_req.requester_id);
  end if;
  if v_to is not null and v_to <> auth.uid() then
    select p.surname || ' ' || p.given_names, p.file_number into v_name, v_file
    from patient p where p.id = v_e.patient_id;
    select full_name into v_me from profiles where id = auth.uid();
    select s.name_en into v_test from service s where s.id = v_req.service_id;
    insert into notification (kind, params, title, body, link, urgent, recipient_user, created_by)
    values ('file_attached',
            jsonb_build_object('fileId', v_f.id, 'patientId', v_e.patient_id, 'encounterId', v_e.id,
                               'name', v_name, 'file', v_file, 'by', v_me, 'title', v_f.title,
                               'kind', v_f.kind, 'test', v_test),
            'File added to a test',
            coalesce(v_me, '') || ' added "' || v_f.title || '" to ' || coalesce(v_test, 'a test') || ' of ' || coalesce(v_name, ''),
            '/app/visit?encounter=' || v_e.id, false, v_to, auth.uid());
  end if;
  return file_doc_json(v_f, 'visit');
end
$$;

-- ---------------------------------------------------------------- results: never by the requester
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
  -- Lab / ultrasound results: the laboratory or ultrasound desk; an order done at another desk
  -- (Nursing, Dental…): the clinical staff of that desk too. Never the clinician who asked for
  -- the test (0104).
  if not ((may_use_desk(request_desk(v_req.station, v_req.category))
               and (request_desk(v_req.station, v_req.category) not in ('laboratory', 'ultrasound')
                    or has_perm('orders.write')))
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound')
              and may_use_any_desk(station_desks(v_req.station)))) then
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
  -- the manager, the desk of the test, or the clinical staff of a desk that did it itself;
  -- never the clinician who asked for the test (0104)
  if not (is_manager() or (may_use_desk(request_desk(v_req.station, v_req.category))
               and (request_desk(v_req.station, v_req.category) not in ('laboratory', 'ultrasound')
                    or has_perm('orders.write')))
          or (has_perm('clinical.write') and coalesce(v_req.station, 'laboratory') not in ('laboratory', 'ultrasound')
              and may_use_any_desk(station_desks(v_req.station)))) then
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

-- ---------------------------------------------------------------- the record, with its history
/**
 * The previous versions of a diagnosis or a note, from the table's audit trigger: one entry per
 * change of the text (or code, type, provisional), newest first: what it said, who wrote that
 * version and when, who replaced it, when and why.
 */
create or replace function record_history(p_entity text, p_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'text', coalesce(a.before ->> 'text', a.before ->> 'value_text'),
      'icd10', a.before ->> 'icd10_code',
      'type', a.before ->> 'type',
      'provisional', (a.before ->> 'provisional')::boolean,
      'since', coalesce(a.before ->> 'updated_at', a.before ->> 'created_at'),
      'wroteBy', (select full_name from profiles
                  where id = coalesce(nullif(a.before ->> 'updated_by', '')::uuid, nullif(a.before ->> 'created_by', '')::uuid)),
      'replacedAt', a.at,
      'replacedBy', (select full_name from profiles where id = a.actor_id),
      'reason', a.after ->> 'edit_reason') order by a.at desc), '[]'::jsonb)
  from audit_event a
  where a.entity = p_entity and a.entity_id = p_id and a.action = 'update'
    and (a.after ->> 'deleted_at') is null
    and (a.before ->> 'text' is distinct from a.after ->> 'text'
         or a.before ->> 'value_text' is distinct from a.after ->> 'value_text'
         or a.before ->> 'icd10_code' is distinct from a.after ->> 'icd10_code'
         or a.before ->> 'type' is distinct from a.after ->> 'type'
         or a.before ->> 'provisional' is distinct from a.after ->> 'provisional')
$$;

create or replace function visit_clinical(p_encounter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_view text;
  v_patient uuid;
  v_closed boolean;
  v_safe boolean;
begin
  -- clinicians; the lab and the pharmacy read the record too (their orders and prescriptions)
  if not clinical_reader() then
    return null;
  end if;
  select e.patient_id, e.status = 'closed' into v_patient, v_closed
  from encounter e where e.id = p_encounter_id and e.deleted_at is null;
  if v_patient is null then
    return null;
  end if;
  v_view := visit_view(p_encounter_id);
  if v_view is null then
    v_safe := patient_level(v_patient) <> 'identity';
    return jsonb_build_object(
      'diagnoses', '[]'::jsonb, 'notes', '[]'::jsonb, 'prescriptions', '[]'::jsonb, 'orders', '[]'::jsonb,
      'patient', (select jsonb_build_object('id', p.id,
                    'allergies', case when v_safe then p.allergies end,
                    'bloodGroup', case when v_safe then p.blood_group end,
                    'notes', case when v_safe then p.notes end,
                    'flags', case when v_safe then p.flags else '{}'::jsonb end)
                  || case when v_safe then doc_patient(p.id, p_encounter_id)
                          else doc_patient(p.id, p_encounter_id) - 'allergies' - 'allergiesNone' - 'bloodGroup'
                               - 'weightKg' - 'weightAt' end
                  from patient p where p.id = v_patient),
      'visit', doc_visit(p_encounter_id),
      'private', true,
      'view', null,
      'access', patient_access(v_patient));
  end if;
  if v_closed then
    perform log_record_access(v_patient, p_encounter_id, v_view, 'visit');
  end if;
  return jsonb_build_object(
    -- removed diagnoses stay, marked (removedAt), so the record shows what was written and withdrawn
    'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by), 'byId', c.created_by,
        'editedAt', case when c.deleted_at is null and c.edit_reason is not null then c.updated_at end,
        'editedBy', case when c.deleted_at is null and c.edit_reason is not null then (select full_name from profiles where id = c.updated_by) end,
        'editReason', case when c.deleted_at is null then c.edit_reason end,
        'removedAt', c.deleted_at,
        'removedBy', case when c.deleted_at is not null then (select full_name from profiles where id = c.updated_by) end,
        'removeReason', case when c.deleted_at is not null then c.edit_reason end,
        'history', record_history('condition', c.id)) order by c.created_at)
      from condition c where c.encounter_id = p_encounter_id and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'))), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.value_text, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id), 'byId', coalesce(o.performer_id, o.created_by),
        'editedAt', case when o.edit_reason is not null then o.updated_at end,
        'editedBy', case when o.edit_reason is not null then (select full_name from profiles where id = o.updated_by) end,
        'editReason', o.edit_reason,
        'history', record_history('observation', o.id)) order by o.effective_at)
      from observation o where o.encounter_id = p_encounter_id and o.code = 'note' and o.deleted_at is null), '[]'::jsonb),
    'prescriptions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by)), 'item', rx_label(m), 'dose', m.dose, 'route', m.route,
        'frequency', m.frequency, 'days', m.duration_days, 'quantity', m.quantity, 'instructions', m.instructions, 'at', m.created_at,
        'dispensed', m.supply = 'room' or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'supply', m.supply, 'givenAt', m.given_at, 'givenBy', (select full_name from profiles where id = m.given_by),
        'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason,
        'prescriberId', coalesce(m.prescriber_id, m.created_by), 'pending', rx_pending(m),
        'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
        'cancelledBy', (select full_name from profiles where id = m.cancelled_by),
        'itemId', m.item_id, 'referenceCode', m.reference_code, 'quantityGiven', coalesce(m.quantity_given, 0),
        'supplySetAt', m.supply_set_at, 'supplySetBy', (select full_name from profiles where id = m.supply_set_by),
        'supplyReason', m.supply_reason,
        -- 0104: the remainder of a partly given line sent outside points at the original (split_from)
        'splitFrom', m.split_from,
        'prescriber', doc_person(coalesce(m.prescriber_id, m.created_by))) order by m.created_at)
      from medication_request m where m.encounter_id = p_encounter_id and m.deleted_at is null), '[]'::jsonb),
    -- HIV tests (like the diagnoses above) only for the people allowed to see them
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end), 'status', r.status, 'reason', r.reason, 'at', r.created_at, 'mine', coalesce(r.requester_id = auth.uid(), false),
        'result', (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
          'corrected', d.corrected_at is not null, 'correctionReason', d.correction_reason,
          'at', coalesce(d.verified_at, d.updated_at), 'by', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
          'byPerson', doc_person(coalesce(d.verified_by, d.created_by)))
          from diagnostic_report d where d.service_request_id = r.id and d.deleted_at is null)) order by r.created_at)
      from service_request r join service s on s.id = r.service_id
      where r.encounter_id = p_encounter_id and r.deleted_at is null
        and (has_perm('sensitive.read') or not sensitive_service(s.id))), '[]'::jsonb),
    'patient', (select jsonb_build_object('id', p.id, 'allergies', p.allergies, 'bloodGroup', p.blood_group, 'notes', p.notes, 'flags', p.flags)
                       || doc_patient(p.id, e.id)
      from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id),
    'visit', doc_visit(p_encounter_id),
    'private', false,
    'view', v_view,
    -- 0104: the lock of a finished visit and the reader's edit window
    'editLock', visit_edit_status(p_encounter_id)
  );
end
$$;
