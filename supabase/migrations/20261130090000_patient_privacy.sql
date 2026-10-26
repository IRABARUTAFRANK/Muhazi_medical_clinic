-- 0088 · Patient record privacy: four levels, access requests, emergency access, the access log.
--
-- Frank: "when a patient is marked as left or finished treatment ... manager and the heads of
-- departments in charge may be the ones to view sensitive information ... when a person treating
-- needs data or view to previous treatments ... when he is not the head he may request access to
-- the head and approves him or the manager depending on who is available". Decided with him:
-- assistant heads neither see full records nor approve; an approved access lasts until the
-- patient's current visit closes; emergency access exists; a doctor always sees the visits they
-- treated; the safety summary as proposed.
--
--   * A  FOUR LEVELS.
--        1 identity    name, file number, age, sex, phone, payer: every employee (patient.read).
--        2 summary     allergies, chronic conditions, current medicines, blood group, last vital
--                      signs, alerts (patient notes and flags): whoever treats the patient now
--                      (treating_visit: a clinical reader holding the patient at a desk other
--                      than reception or the cashier, with a task or help call on the visit, or
--                      who took part in it).
--        3 this visit  the open visit's clinical record (visit_view = 'visit'): the people working
--                      on it (may_work_on, took part, the visit waits at a desk they use, a test of
--                      the visit is open at their laboratory/ultrasound desk, a medicine waits at
--                      their pharmacy desk) and the manager.
--        4 history     every past visit's notes, diagnoses, results, prescriptions, documents:
--                      the manager; the HEAD (not the assistant) of a department in charge of one
--                      of the patient's visits (visit_departments: a treating desk, laboratory or
--                      ultrasound served the visit); the clinician for the visits they treated
--                      themselves (treated: 'own'); anyone with an approved request or an emergency
--                      access for this patient while the visit it was asked in stays open.
--        The reading functions return only what the level allows: patient_file, visit_clinical,
--        patient_results, visit_journey; the clinical tables' read policies too (observation,
--        condition, service_request, diagnostic_report, procedure, medication_request,
--        medication_dispense, prescription_doc, vaccination, fp_event, hiv_test, document).
--        The desks keep their worklists (lab_worklist, desk_orders, pharmacy_queue…): they read
--        what their work needs and are unchanged. The current visit's documents still print.
--   * B  REQUEST ACCESS (request_record_access): only while treating the patient, with a reason.
--        The manager and the heads in charge are told (notice 'access_request'); the first to
--        answer approves or refuses with a reason (answer_record_access); the requester is told
--        ('access_answer'). The access ends when the visit closes. record_access_requests() lists
--        them for the approvers and the requester.
--   * C  EMERGENCY ACCESS (emergency_record_access): while treating the patient, opened at once
--        with a reason; urgent notice to the manager and the heads in charge ('access_emergency');
--        a red entry in the access log; the manager reviews it (review_emergency_access).
--   * D  THE ACCESS LOG (record_access_entry): every opening of past records (who, patient, visit,
--        when, how: own visit / head / approved request / emergency / manager), once per half
--        hour for the same person, patient, visit and way (the screens refresh). The manager's
--        page reads record_access_log(); the patient file shows who looked (patient_access_log).
--   * E  THE SAFETY FIELDS stay safe at level 1: update_patient no longer clears or replaces the
--        allergies, "no known allergies", blood group or notes someone at level 1 cannot see (the
--        patient form sends them empty); they may still add one where none is recorded.
--
--   * H  THE OTHER WAYS IN: visit_vitals shows a closed visit's vital signs only where its record
--        may be seen; the patient, encounter and queue_entry tables no longer give the safety
--        fields, the triage reason or the referral note when read directly (column privileges;
--        queue_board reads them with its owner's rights); the patient search gives the allergy
--        mark to clinical readers only; a colleague's analytics hide what was written in visits
--        one may not see; a request still waiting when its visit closes is cancelled.
--   'Own' visit (closed) = treated it (treated()): took the patient at a treating desk, diagnosis,
--   clinical note, prescription, test ordered, ultrasound report, procedure, help. The wider
--   took_part (vital signs, results…) counts only while the visit is open.
--   A department is in charge of a visit when the visit was sent to it; only a visit sent to no
--   department falls to every department giving that desk.
--
-- Errcodes: 42501 not allowed (hints: not_treating, not_approver, not_manager), 22023 bad input
-- (hints: reason_needed, already_answered, already_allowed, visit_closed), P0002 not found (hint:
-- not_found).

-- ---------------------------------------------------------------- tables
create table if not exists record_access_request (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patient (id),
  -- the open visit the requester treats: the access ends when it closes
  encounter_id uuid not null references encounter (id),
  requested_by uuid not null default auth.uid() references profiles (id),
  kind text not null default 'request' check (kind in ('request', 'emergency')),
  reason text not null check (length(trim(reason)) >= 3),
  status text not null default 'pending' check (status in ('pending', 'approved', 'refused', 'cancelled')),
  answered_by uuid references profiles (id) on delete set null,
  answered_at timestamptz,
  answer_note text,
  -- emergencies: the manager's review
  reviewed_by uuid references profiles (id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);
create index if not exists record_access_request_patient_idx
  on record_access_request (patient_id, requested_by, status);
create index if not exists record_access_request_status_idx on record_access_request (status, created_at desc);
comment on table record_access_request is
  'Requests to see a patient''s past records (and emergency accesses), answered by the manager or a head in charge (0088).';
alter table record_access_request enable row level security;
revoke all on record_access_request from anon, authenticated;

create table if not exists record_access_entry (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor_id uuid not null references profiles (id),
  patient_id uuid not null references patient (id),
  -- the past visit opened (null: the patient file or the results of every visit)
  encounter_id uuid references encounter (id),
  via text not null check (via in ('own', 'head', 'request', 'emergency', 'manager')),
  what text not null default 'file' check (what in ('file', 'visit', 'results', 'journey', 'emergency')),
  request_id uuid references record_access_request (id)
);
create index if not exists record_access_entry_at_idx on record_access_entry (at desc);
create index if not exists record_access_entry_patient_idx on record_access_entry (patient_id, at desc);
create index if not exists record_access_entry_actor_idx on record_access_entry (actor_id, patient_id, at desc);
comment on table record_access_entry is
  'Who opened a patient''s past records, when and how (0088). Written by the reading functions only.';
alter table record_access_entry enable row level security;
revoke all on record_access_entry from anon, authenticated;

-- ---------------------------------------------------------------- helpers
-- Reads clinical records at all (as visit_clinical asked before).
create or replace function clinical_reader()
returns boolean
language sql stable security definer set search_path = public
as $$
  select has_perm('clinical.read') or has_perm('orders.read') or has_perm('prescription.read')
$$;

-- Did this person take part in the visit (their own visit)? Took the patient, wrote a diagnosis,
-- a note or a vital sign, prescribed, ordered a test, entered or validated a result, performed a
-- procedure, or helped on the patient.
create or replace function took_part(p_encounter_id uuid, p_user uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_user is not null and (
    exists (select 1 from queue_entry q
            where q.encounter_id = p_encounter_id and q.deleted_at is null and q.taken_by = p_user
              and q.station not in ('reception', 'cashier'))
    or exists (select 1 from condition c
               where c.encounter_id = p_encounter_id and c.deleted_at is null and c.created_by = p_user)
    or exists (select 1 from observation o
               where o.encounter_id = p_encounter_id and o.deleted_at is null
                 and (o.performer_id = p_user or o.created_by = p_user))
    or exists (select 1 from medication_request m
               where m.encounter_id = p_encounter_id and m.deleted_at is null
                 and coalesce(m.prescriber_id, m.created_by) = p_user)
    or exists (select 1 from service_request r
               where r.encounter_id = p_encounter_id and r.deleted_at is null and r.requester_id = p_user)
    or exists (select 1 from service_request r
               join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
               where r.encounter_id = p_encounter_id and (d.created_by = p_user or d.verified_by = p_user))
    or exists (select 1 from procedure pr
               where pr.encounter_id = p_encounter_id and pr.deleted_at is null and pr.performer_id = p_user)
    or exists (select 1 from staff_call c
               where c.encounter_id = p_encounter_id and c.kind = 'help' and c.answered_by = p_user
                 and c.status in ('accepted', 'done'))
  )
$$;

-- Did this person TREAT the visit (a closed visit stays theirs: 'own')? Narrower than took_part:
-- took the patient at a treating desk, wrote a diagnosis or a clinical note, prescribed, ordered a
-- test, wrote an ultrasound report, performed a procedure, or helped on the patient. Measuring
-- vital signs, typing the nurse's sheet, entering a laboratory result or dispensing does not open
-- the whole closed visit: the desks' own lists keep that part.
create or replace function treated(p_encounter_id uuid, p_user uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_user is not null and (
    exists (select 1 from queue_entry q
            where q.encounter_id = p_encounter_id and q.deleted_at is null and q.taken_by = p_user
              and station_desks(q.station) && treating_desks())
    or exists (select 1 from condition c
               where c.encounter_id = p_encounter_id and c.deleted_at is null and c.created_by = p_user)
    or exists (select 1 from observation o
               where o.encounter_id = p_encounter_id and o.deleted_at is null and o.code = 'note'
                 and coalesce(o.performer_id, o.created_by) = p_user)
    or exists (select 1 from medication_request m
               where m.encounter_id = p_encounter_id and m.deleted_at is null
                 and coalesce(m.prescriber_id, m.created_by) = p_user)
    or exists (select 1 from service_request r
               where r.encounter_id = p_encounter_id and r.deleted_at is null and r.requester_id = p_user)
    or exists (select 1 from service_request r
               join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
               where r.encounter_id = p_encounter_id and r.category = 'imaging'
                 and (d.created_by = p_user or d.verified_by = p_user))
    or exists (select 1 from procedure pr
               where pr.encounter_id = p_encounter_id and pr.deleted_at is null and pr.performer_id = p_user)
    or exists (select 1 from staff_call c
               where c.encounter_id = p_encounter_id and c.kind = 'help' and c.answered_by = p_user
                 and c.status in ('accepted', 'done'))
  )
$$;

-- The departments in charge of a visit: those of the places where it was treated (a treating desk,
-- the laboratory or ultrasound): the department it was sent to; only when none was named, the
-- departments giving that desk. Reception, triage and the pharmacy see every patient pass and are
-- not "in charge".
create or replace function visit_departments(p_encounter_id uuid)
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(distinct d.id), '{}')
  from queue_entry q
  join department d on d.active and d.deleted_at is null
    and (d.id = q.department_id or (q.department_id is null and station_desks(q.station) && d.services))
  where q.encounter_id = p_encounter_id and q.deleted_at is null
    and station_desks(q.station) && (treating_desks() || array['laboratory', 'ultrasound'])
$$;

-- The heads (not the assistants) of the departments in charge of any visit of the patient.
create or replace function heads_in_charge(p_patient_id uuid)
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(distinct sd.profile_id), '{}')
  from encounter e
  cross join lateral unnest(visit_departments(e.id)) as vd(id)
  join staff_department sd on sd.department_id = vd.id and sd.position = 'head'
  join profiles p on p.id = sd.profile_id and p.active and p.deleted_at is null
  where e.patient_id = p_patient_id and e.deleted_at is null
$$;

-- The approved request (or emergency access) of the signed-in person for this patient, while
-- the visit it was asked in stays open.
create or replace function access_in_force(p_patient_id uuid)
returns record_access_request
language sql stable security definer set search_path = public
as $$
  select r.*
  from record_access_request r
  join encounter e on e.id = r.encounter_id and e.status = 'open' and e.deleted_at is null
  where r.patient_id = p_patient_id and r.requested_by = auth.uid() and r.status = 'approved'
  order by r.answered_at desc nulls last, r.created_at desc
  limit 1
$$;

-- How the signed-in person sees the patient's whole history, or null:
-- 'manager', 'head' (of a department in charge), 'emergency' or 'request' (in force).
create or replace function history_via(p_patient_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when auth.uid() is null then null
    when is_manager() then 'manager'
    when auth.uid() = any (heads_in_charge(p_patient_id)) then 'head'
    else (select a.kind from access_in_force(p_patient_id) a where a.id is not null)
  end
$$;

-- How the signed-in person sees one visit's clinical record, or null:
--   open visit:   'visit' (working on it, the manager), else history_via
--   closed visit: 'manager', 'own' (treated it), else history_via
-- p_via_known: the caller already worked out history_via (p_via) for the patient; the loops over
-- a patient's visits pass it so it is not worked out again for every visit.
create or replace function visit_view_with(p_encounter_id uuid, p_via text, p_via_known boolean)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  v_e encounter%rowtype;
begin
  if auth.uid() is null then
    return null;
  end if;
  select * into v_e from encounter where id = p_encounter_id and deleted_at is null;
  if not found then
    return null;
  end if;
  if v_e.status = 'open' then
    if may_work_on(v_e.id) or took_part(v_e.id) then
      return 'visit';
    end if;
    -- the visit waits, not yet taken, at a desk this person uses (they may take the patient)
    if exists (select 1 from queue_entry q
               where q.encounter_id = v_e.id and q.finished_at is null and q.deleted_at is null
                 and q.taken_by is null and (q.assigned_to is null or q.assigned_to = auth.uid())
                 and q.station <> 'reception' and may_use_any_desk(station_desks(q.station))) then
      return 'visit';
    end if;
    -- a test of the visit is open at their laboratory or ultrasound desk
    if exists (select 1 from service_request r
               where r.encounter_id = v_e.id and r.deleted_at is null
                 and r.status not in ('verified', 'cancelled')
                 and may_use_desk(request_desk(r.station, r.category))) then
      return 'visit';
    end if;
    -- a medicine of the visit waits at the pharmacy
    if may_use_desk('pharmacy')
       and exists (select 1 from medication_request m
                   where m.encounter_id = v_e.id and m.deleted_at is null and rx_pending(m)) then
      return 'visit';
    end if;
    return case when p_via_known then p_via else history_via(v_e.patient_id) end;
  end if;
  if is_manager() then
    return 'manager';
  end if;
  if treated(v_e.id) then
    return 'own';
  end if;
  return case when p_via_known then p_via else history_via(v_e.patient_id) end;
end
$$;

create or replace function visit_view(p_encounter_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select visit_view_with(p_encounter_id, null, false)
$$;

-- The open visit the signed-in person treats now, or null: someone who reads clinical records and
-- is linked to the visit clinically: the patient is theirs at a desk other than reception or the
-- cashier, a task or an accepted help call of the visit is theirs, or they took part in it.
create or replace function treating_visit(p_patient_id uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select e.id
  from encounter e
  where e.patient_id = p_patient_id and e.status = 'open' and e.deleted_at is null
    and auth.uid() is not null and clinical_reader()
    and (exists (select 1 from queue_entry q
                 where q.encounter_id = e.id and q.finished_at is null and q.deleted_at is null
                   and q.station not in ('reception', 'cashier') and queue_entry_for_me(q.id))
         or exists (select 1 from internal_task k
                    where k.encounter_id = e.id and k.done_at is null and k.deleted_at is null
                      and (k.assigned_to = auth.uid() or task_for_me(k.assigned_role)))
         or exists (select 1 from staff_call c
                    where c.encounter_id = e.id and c.kind = 'help' and c.status = 'accepted'
                      and c.answered_by = auth.uid())
         or took_part(e.id))
  order by e.arrived_at desc
  limit 1
$$;

-- The level of the signed-in person for the patient: 'full' (history), 'summary' (treating now)
-- or 'identity'.
create or replace function patient_level(p_patient_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when history_via(p_patient_id) is not null then 'full'
    when treating_visit(p_patient_id) is not null then 'summary'
    else 'identity'
  end
$$;

-- One line in the access log; the same person, patient, visit and way once per half hour.
create or replace function log_record_access(p_patient_id uuid, p_encounter_id uuid, p_via text, p_what text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req uuid;
begin
  if auth.uid() is null or p_via is null or p_patient_id is null then
    return;
  end if;
  if exists (select 1 from record_access_entry a
             where a.actor_id = auth.uid() and a.patient_id = p_patient_id
               and a.encounter_id is not distinct from p_encounter_id and a.via = p_via
               and a.at > now() - interval '30 minutes') then
    return;
  end if;
  if p_via in ('request', 'emergency') then
    select a.id into v_req from access_in_force(p_patient_id) a;
  end if;
  insert into record_access_entry (actor_id, patient_id, encounter_id, via, what, request_id)
  values (auth.uid(), p_patient_id, p_encounter_id, p_via, p_what, v_req);
end
$$;

-- The safety summary (level 2): allergies, blood group, alerts, chronic conditions, the medicines
-- being taken and the last vital signs.
create or replace function patient_safety_summary(p_patient_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'allergies', p.allergies,
    'allergiesNone', coalesce(p.allergies_none, false) and p.allergies is null,
    'bloodGroup', p.blood_group,
    'alerts', p.notes,
    'flags', p.flags,
    -- long-lasting conditions: a chronic ICD-10 group, or the same diagnosis on two visits
    'chronic', coalesce((
      select jsonb_agg(jsonb_build_object('text', x.text, 'icd10', x.icd10_code, 'since', x.first_at, 'lastAt', x.created_at)
                       order by x.created_at desc)
      from (
        select distinct on (lower(c.text)) c.text, c.icd10_code, c.created_at,
               min(c.created_at) over (partition by lower(c.text)) as first_at
        from condition c join encounter e on e.id = c.encounter_id and e.deleted_at is null
        where e.patient_id = p.id and c.deleted_at is null
          and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'))
          and (coalesce(c.icd10_code, '') ~ '^(I1[0-5]|I25|I50|E0[3-5]|E1[0-4]|J4[45]|G40|N18|B18|B2[0-4]|F2[0-9]|F3[1-3])'
               or (select count(distinct c2.encounter_id) from condition c2
                   join encounter e2 on e2.id = c2.encounter_id and e2.deleted_at is null
                   where e2.patient_id = p.id and c2.deleted_at is null and lower(c2.text) = lower(c.text)) >= 2)
        order by lower(c.text), c.created_at desc
      ) x), '[]'::jsonb),
    -- medicines of the open visit, and those still running (prescribed days not over)
    'medications', coalesce((
      select jsonb_agg(jsonb_build_object(
          'item', i.name_generic || coalesce(' ' || i.strength, ''), 'dose', m.dose, 'frequency', m.frequency,
          'days', m.duration_days, 'at', m.created_at,
          'until', case when m.duration_days is not null then m.created_at + make_interval(days => m.duration_days) end,
          'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by)))
        order by m.created_at desc)
      from medication_request m
      join encounter e on e.id = m.encounter_id and e.deleted_at is null
      join item i on i.id = m.item_id
      where e.patient_id = p.id and m.deleted_at is null and m.cancelled_at is null and m.not_given_at is null
        and m.created_at > now() - interval '180 days'
        and (e.status = 'open' or m.created_at + make_interval(days => coalesce(m.duration_days, 0)) >= now())), '[]'::jsonb),
    'lastVitals', coalesce((
      select jsonb_agg(jsonb_build_object('code', v.code, 'value', v.value_num, 'unit', v.unit, 'at', v.effective_at,
                                          'by', (select full_name from profiles where id = v.performer_id))
                       order by v.code)
      from (
        select distinct on (o.code) o.code, o.value_num, o.unit, o.effective_at, o.performer_id
        from observation o join encounter e on e.id = o.encounter_id and e.deleted_at is null
        where e.patient_id = p.id and o.deleted_at is null and o.code <> 'note' and o.value_num is not null
        order by o.code, o.effective_at desc
      ) v), '[]'::jsonb),
    'lastVisitAt', (select max(e.arrived_at) from encounter e where e.patient_id = p.id and e.deleted_at is null)
  )
  from patient p where p.id = p_patient_id
$$;

-- What the signed-in person may see of the patient, and may ask for (the patient file's banner
-- and its Request / Emergency buttons). patient_access_with: history_via and treating_visit
-- already worked out by the caller (internal).
create or replace function patient_access_with(p_patient_id uuid, p_via text, p_treating uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_via text := p_via;
  v_treating uuid := p_treating;
  v_reader boolean := clinical_reader();
  v_past integer;
  v_own integer;
  v_hidden integer;
  v_req record_access_request%rowtype;
  v_level text;
begin
  if auth.uid() is null or not has_perm('patient.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_level := case when v_via is not null then 'full' when v_treating is not null then 'summary' else 'identity' end;
  select count(*),
         count(*) filter (where treated(e.id)),
         count(*) filter (where not v_reader or visit_view_with(e.id, v_via, true) is null)
  into v_past, v_own, v_hidden
  from encounter e
  where e.patient_id = p_patient_id and e.deleted_at is null and e.status = 'closed';
  -- my latest request for the visit I treat now
  if v_treating is not null then
    select * into v_req from record_access_request r
    where r.patient_id = p_patient_id and r.encounter_id = v_treating and r.requested_by = auth.uid()
    order by r.created_at desc limit 1;
  end if;
  return jsonb_build_object(
    'level', v_level,
    'via', v_via,
    'treatingEncounterId', v_treating,
    'pastVisits', v_past,
    'ownVisits', v_own,
    'hiddenVisits', v_hidden,
    'canRequest', v_reader and v_treating is not null and v_via is null and v_hidden > 0
                  and (v_req.id is null or v_req.status in ('refused', 'cancelled')),
    'canEmergency', v_reader and v_treating is not null and v_via is null and v_hidden > 0,
    -- the manager and the heads in charge (history_via says so)
    'canSeeLog', coalesce(v_via in ('manager', 'head'), false),
    'request', case when v_req.id is not null then jsonb_build_object(
        'id', v_req.id, 'kind', v_req.kind, 'status', v_req.status, 'reason', v_req.reason,
        'at', v_req.created_at, 'answeredAt', v_req.answered_at, 'answerNote', v_req.answer_note,
        'answeredBy', (select full_name from profiles where id = v_req.answered_by)) end
  );
end
$$;

create or replace function patient_access(p_patient_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select patient_access_with(p_patient_id, history_via(p_patient_id), treating_visit(p_patient_id))
$$;

-- ---------------------------------------------------------------- A the reading functions
-- The patient file (0084) by level: every visit is listed (date, reference, places, bill), but
-- its diagnosis, triage reason, vital signs and diagnoses only where the record may be seen
-- ('private' otherwise); the safety summary from level 2; the safety fields of the patient row
-- and of the printed details hidden at level 1. Opening past records is logged.
-- The extra fields the manager marked "medical" in Settings → Patient file fields
-- (setting patient.fields: [{key, label, type, private: true}]): private like the safety
-- summary — shown to whoever treats the patient now and to full-history readers only.
create or replace function private_extra_keys()
returns text[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(f ->> 'key'), '{}'::text[])
  from setting s
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(s.value) = 'array' then s.value else '[]'::jsonb end) f
  where s.key = 'patient.fields' and jsonb_typeof(f) = 'object' and f ->> 'private' = 'true'
$$;
revoke all on function private_extra_keys() from public, anon, authenticated;

create or replace function patient_file(p_patient_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_patient jsonb;
  v_visits jsonb;
  v_vitals jsonb;
  v_conditions jsonb;
  v_bills jsonb;
  v_doc jsonb;
  v_reader boolean := clinical_reader();
  v_via text;
  v_treating uuid;
  v_level text;
  v_past_seen boolean;
  v_views jsonb;
begin
  if not has_perm('patient.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select to_jsonb(p) - 'photo_blob_id' - 'merged_into' - 'guardian_patient_id' into v_patient
  from patient p where p.id = p_patient_id and p.deleted_at is null;
  if v_patient is null then
    raise exception 'patient not found' using errcode = 'P0002';
  end if;
  -- worked out once for the whole file (the visits' loop reuses them)
  v_via := history_via(p_patient_id);
  v_treating := treating_visit(p_patient_id);
  v_level := case when v_via is not null then 'full' when v_treating is not null then 'summary' else 'identity' end;

  -- how each visit may be seen (null: private)
  select coalesce(jsonb_object_agg(e.id::text, s.view) filter (where s.view is not null), '{}'::jsonb),
         coalesce(bool_or(s.view is not null and e.status = 'closed'), false)
  into v_views, v_past_seen
  from encounter e
  cross join lateral (select case when v_reader then visit_view_with(e.id, v_via, true) end as view) s
  where e.patient_id = p_patient_id and e.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'reference', e.reference, 'arrivedAt', e.arrived_at, 'status', e.status, 'type', e.type,
      'triage', e.triage_level,
      'triageReason', case when s.view is not null then e.triage_reason end,
      'practitioner', (select names from practitioner where id = e.practitioner_id),
      'stations', (select coalesce(jsonb_agg(distinct q.station::text), '[]'::jsonb) from queue_entry q where q.encounter_id = e.id and q.deleted_at is null),
      'currentStation', (select q.station from queue_entry q where q.encounter_id = e.id and q.finished_at is null and q.deleted_at is null order by q.created_at desc limit 1),
      'diagnosis', case when s.view is not null then
        (select c.text from condition c where c.encounter_id = e.id and c.type = 'primary' and c.deleted_at is null order by c.created_at desc limit 1) end,
      'total', (select i.total from invoice i where i.encounter_id = e.id),
      'balance', (select invoice_balance(i.id) from invoice i where i.encounter_id = e.id),
      'billStatus', (select i.status from invoice i where i.encounter_id = e.id),
      'closedAt', e.closed_at,
      'private', s.view is null,
      'view', s.view
    ) order by e.arrived_at desc), '[]'::jsonb) into v_visits
  from encounter e cross join lateral (select v_views ->> e.id::text as view) s
  where e.patient_id = p_patient_id and e.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'encounterId', o.encounter_id, 'code', o.code, 'value', o.value_num, 'text', o.value_text,
      'unit', o.unit, 'at', o.effective_at, 'by', (select full_name from profiles where id = o.performer_id)
    ) order by o.effective_at desc), '[]'::jsonb) into v_vitals
  -- the visits one may see; whoever types the nurse's sheet (vitals.write) also sees what is
  -- recorded on the open visit (0019), never a past one
  from observation o
  where o.deleted_at is null and o.code <> 'note'
    and (v_views ? o.encounter_id::text
         or (has_perm('vitals.write')
             and o.encounter_id in (select e.id from encounter e
                                    where e.patient_id = p_patient_id and e.status = 'open' and e.deleted_at is null)));

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'encounterId', c.encounter_id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type,
      'provisional', c.provisional, 'at', c.created_at, 'by', (select full_name from profiles where id = c.created_by)
    ) order by c.created_at desc), '[]'::jsonb) into v_conditions
  from condition c
  where v_views ? c.encounter_id::text and c.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'invoiceId', i.id, 'encounterId', i.encounter_id, 'number', i.number, 'status', i.status,
      'total', i.total, 'patientShare', i.patient_share, 'insurerShare', i.insurer_share,
      'balance', invoice_balance(i.id), 'payer', (select name from payer where id = i.payer_id),
      'at', i.created_at
    ) order by i.created_at desc), '[]'::jsonb) into v_bills
  from invoice i join encounter e on e.id = i.encounter_id
  where e.patient_id = p_patient_id and i.deleted_at is null;

  v_doc := doc_patient(p_patient_id, null);
  if v_level = 'identity' then
    v_patient := v_patient || jsonb_build_object('allergies', null, 'allergies_none', null,
                                                 'blood_group', null, 'notes', null,
                                                 -- the manager's "medical" extra fields go too
                                                 'extra', coalesce(v_patient -> 'extra', '{}'::jsonb) - private_extra_keys(),
                                                 -- the safety marks go; "VIP" is not one
                                                 'flags', jsonb_strip_nulls(jsonb_build_object('vip', v_patient -> 'flags' -> 'vip')));
    v_doc := v_doc - 'allergies' - 'allergiesNone' - 'bloodGroup' - 'weightKg' - 'weightAt';
  end if;

  if v_past_seen then
    perform log_record_access(p_patient_id, null, coalesce(v_via, 'own'), 'file');
  end if;

  return jsonb_build_object('patient', v_patient, 'visits', v_visits, 'vitals', v_vitals,
                            'conditions', v_conditions, 'bills', v_bills,
                            'document', v_doc,
                            'safetyHidden', v_level = 'identity',
                            'summary', case when v_level <> 'identity' then patient_safety_summary(p_patient_id) end,
                            'access', patient_access_with(p_patient_id, v_via, v_treating));
end
$$;

-- One visit's clinical record (0085) when the person may see it (visit_view); otherwise the
-- same shape, empty, with private = true and what may be asked (access). A past visit opened is
-- logged.
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
    'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by)) order by c.created_at)
      from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.value_text, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id)) order by o.effective_at)
      from observation o where o.encounter_id = p_encounter_id and o.code = 'note' and o.deleted_at is null), '[]'::jsonb),
    'prescriptions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by)), 'item', i.name_generic || coalesce(' ' || i.strength, ''), 'dose', m.dose, 'route', m.route,
        'frequency', m.frequency, 'days', m.duration_days, 'quantity', m.quantity, 'instructions', m.instructions, 'at', m.created_at,
        'dispensed', m.supply = 'room' or exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'supply', m.supply, 'givenAt', m.given_at, 'givenBy', (select full_name from profiles where id = m.given_by),
        'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason,
        'prescriberId', coalesce(m.prescriber_id, m.created_by), 'pending', rx_pending(m),
        'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
        'cancelledBy', (select full_name from profiles where id = m.cancelled_by),
        'prescriber', doc_person(coalesce(m.prescriber_id, m.created_by))) order by m.created_at)
      from medication_request m join item i on i.id = m.item_id where m.encounter_id = p_encounter_id and m.deleted_at is null), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end), 'status', r.status, 'reason', r.reason, 'at', r.created_at, 'mine', coalesce(r.requester_id = auth.uid(), false),
        'result', (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
          'corrected', d.corrected_at is not null, 'correctionReason', d.correction_reason,
          'at', coalesce(d.verified_at, d.updated_at), 'by', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
          'byPerson', doc_person(coalesce(d.verified_by, d.created_by)))
          from diagnostic_report d where d.service_request_id = r.id and d.deleted_at is null)) order by r.created_at)
      from service_request r join service s on s.id = r.service_id where r.encounter_id = p_encounter_id and r.deleted_at is null), '[]'::jsonb),
    'patient', (select jsonb_build_object('id', p.id, 'allergies', p.allergies, 'bloodGroup', p.blood_group, 'notes', p.notes, 'flags', p.flags)
                       || doc_patient(p.id, e.id)
      from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id),
    'visit', doc_visit(p_encounter_id),
    'private', false,
    'view', v_view
  );
end
$$;

-- The tests of every visit of the patient (0063), only of the visits that may be seen.
create or replace function patient_results(p_patient_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_rows jsonb;
  v_past boolean;
  v_via text;
begin
  if not (has_perm('clinical.read') or has_perm('orders.read')) then
    return '[]'::jsonb;
  end if;
  v_via := history_via(p_patient_id);
  with seen as (
    select e.id, e.status, visit_view_with(e.id, v_via, true) as view
    from encounter e where e.patient_id = p_patient_id and e.deleted_at is null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'encounterId', r.encounter_id, 'test', s.name_en, 'category', r.category,
      'status', r.status, 'reason', r.reason, 'orderedAt', r.created_at,
      'orderedBy', (select full_name from profiles where id = r.requester_id),
      'findings', d.findings, 'impression', d.impression,
      'verified', d.verified_at is not null, 'resultAt', coalesce(d.verified_at, d.updated_at),
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by))
    ) order by r.created_at desc), '[]'::jsonb),
    coalesce(bool_or(v.status = 'closed'), false)
  into v_rows, v_past
  from service_request r
  join seen v on v.id = r.encounter_id and v.view is not null
  join service s on s.id = r.service_id
  left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
  where r.deleted_at is null;
  if v_past then
    perform log_record_access(p_patient_id, null, coalesce(v_via, 'own'), 'results');
  end if;
  return v_rows;
end
$$;

-- The track of a visit (0083): the steps, bill and payments for whoever reads patients; its
-- vital signs, diagnoses, medicines and tests only where the record may be seen (private = true
-- otherwise). A past visit opened is logged.
create or replace function visit_journey(p_encounter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_steps jsonb;
  v_vitals jsonb := '[]'::jsonb;
  v_dx jsonb := '[]'::jsonb;
  v_meds jsonb := '[]'::jsonb;
  v_tests jsonb := '[]'::jsonb;
  v_charges jsonb;
  v_payments jsonb;
  v_bill jsonb;
  v_enc encounter%rowtype;
  v_view text;
  v_handovers jsonb;
begin
  if not has_perm('patient.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_enc from encounter where id = p_encounter_id and deleted_at is null;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002';
  end if;
  v_view := case when clinical_reader() then visit_view(p_encounter_id) end;

  select coalesce(jsonb_agg(jsonb_build_object(
      'station', q.station, 'queuedAt', q.created_at, 'calledAt', q.called_at, 'startedAt', q.started_at,
      'finishedAt', q.finished_at, 'takenBy', tb.full_name, 'assignedTo', asg.full_name,
      'referredBy', rb.full_name, 'note', case when v_view is not null then q.referral_note end,
      'enteredBy', eb.full_name,
      'service', q.service, 'department', (select d.name from department d where d.id = q.department_id)
    ) order by q.created_at), '[]'::jsonb) into v_steps
  from queue_entry q
  left join profiles tb on tb.id = q.taken_by
  left join profiles asg on asg.id = q.assigned_to
  left join profiles rb on rb.id = q.referred_by
  left join profiles eb on eb.id = q.entered_by
  where q.encounter_id = p_encounter_id and q.deleted_at is null;

  if v_view is not null then
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

    if v_enc.status = 'closed' then
      perform log_record_access(v_enc.patient_id, p_encounter_id, v_view, 'journey');
    end if;
  end if;

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

  -- who handed the patient over to whom (20261129090000_handover); the note and the reason are
  -- clinical: for the two colleagues and those who may see this visit's record
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', h.id, 'station', h.station, 'at', h.created_at, 'from', f.full_name, 'to', t.full_name,
      'note', case when v_view is not null or auth.uid() in (h.from_user, h.to_user) then h.note end,
      'status', h.status, 'answeredAt', h.answered_at,
      'answeredBy', (select full_name from profiles where id = h.answered_by),
      'reason', case when v_view is not null or auth.uid() in (h.from_user, h.to_user) then h.reason end
    ) order by h.created_at), '[]'::jsonb) into v_handovers
  from patient_handover h
  join profiles f on f.id = h.from_user
  join profiles t on t.id = h.to_user
  where h.encounter_id = p_encounter_id and h.deleted_at is null;

  return jsonb_build_object(
    'encounterId', v_enc.id, 'arrivedAt', v_enc.arrived_at, 'status', v_enc.status, 'closedAt', v_enc.closed_at,
    'triage', v_enc.triage_level,
    'triageReason', case when v_view is not null then v_enc.triage_reason end,
    'closedBy', (select full_name from profiles where id = v_enc.closed_by),
    -- the track: treatment finished, why the patient left, what they came for
    'treatmentDoneAt', v_enc.clinical_done_at, 'leftReason', v_enc.left_reason, 'service', v_enc.service,
    'steps', v_steps, 'vitals', v_vitals, 'diagnoses', v_dx, 'medicines', v_meds, 'tests', v_tests,
    'charges', v_charges, 'payments', v_payments, 'bill', v_bill, 'handovers', v_handovers,
    'private', v_view is null
  );
end
$$;

-- update_patient (0084), plus E: at level 1 the safety fields the person cannot see are neither
-- cleared nor replaced (the form sends them empty); one may be added where none is recorded.
create or replace function update_patient(p_patient_id uuid, p_fields jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_birth date := nullif(p_fields ->> 'birth_date', '')::date;
  v_age integer := nullif(p_fields ->> 'age_years', '')::integer;
  v_allergies text;
  v_none boolean;
  v_old patient%rowtype;
begin
  if not has_perm('patient.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_fields ? 'extra' and jsonb_typeof(p_fields -> 'extra') <> 'object' then
    raise exception 'extra must be an object' using errcode = '22023';
  end if;
  if p_fields ? 'allergies_none' and jsonb_typeof(p_fields -> 'allergies_none') not in ('boolean', 'null') then
    raise exception 'allergies_none must be true or false' using errcode = '22023';
  end if;
  if patient_level(p_patient_id) = 'identity' then
    select * into v_old from patient where id = p_patient_id;
    p_fields := p_fields - 'allergies_none';
    if v_old.allergies is not null or v_old.allergies_none
       or nullif(trim(coalesce(p_fields ->> 'allergies', '')), '') is null then
      p_fields := p_fields - 'allergies';
    end if;
    if v_old.blood_group is not null or nullif(trim(coalesce(p_fields ->> 'blood_group', '')), '') is null then
      p_fields := p_fields - 'blood_group';
    end if;
    if v_old.notes is not null or nullif(trim(coalesce(p_fields ->> 'notes', '')), '') is null then
      p_fields := p_fields - 'notes';
    end if;
    -- the manager's "medical" extra fields: never shown at this level, so a value already there
    -- is kept as it is; an empty one may be filled in (like the allergies above)
    if p_fields ? 'extra' then
      p_fields := jsonb_set(p_fields, '{extra}',
        ((p_fields -> 'extra') - private_extra_keys())
        || coalesce((select jsonb_object_agg(k,
                              case when nullif(trim(coalesce(v_old.extra ->> k, '')), '') is not null
                                   then v_old.extra -> k else p_fields -> 'extra' -> k end)
                     from unnest(private_extra_keys()) k
                     where coalesce(v_old.extra, '{}'::jsonb) ? k or (p_fields -> 'extra') ? k), '{}'::jsonb));
    end if;
  end if;
  v_allergies := nullif(trim(coalesce(p_fields ->> 'allergies', '')), '');
  v_none := coalesce((p_fields ->> 'allergies_none')::boolean, false);
  if v_birth is null and v_age is not null then
    v_birth := (current_date - make_interval(years => v_age))::date;
  end if;
  update patient set
    surname = coalesce(nullif(trim(p_fields ->> 'surname'), ''), surname),
    given_names = coalesce(nullif(trim(p_fields ->> 'given_names'), ''), given_names),
    sex = coalesce((p_fields ->> 'sex')::sex, sex),
    birth_date = coalesce(v_birth, birth_date),
    age_estimated = case when v_birth is not null then (v_age is not null and (p_fields ->> 'birth_date') is null) else age_estimated end,
    national_id = case when p_fields ? 'national_id' then nullif(regexp_replace(coalesce(p_fields ->> 'national_id', ''), '[^0-9]', '', 'g'), '') else national_id end,
    phone_1 = case when p_fields ? 'phone_1' then nullif(trim(p_fields ->> 'phone_1'), '') else phone_1 end,
    phone_2 = case when p_fields ? 'phone_2' then nullif(trim(p_fields ->> 'phone_2'), '') else phone_2 end,
    district = case when p_fields ? 'district' then nullif(trim(p_fields ->> 'district'), '') else district end,
    sector = case when p_fields ? 'sector' then nullif(trim(p_fields ->> 'sector'), '') else sector end,
    cell = case when p_fields ? 'cell' then nullif(trim(p_fields ->> 'cell'), '') else cell end,
    village = case when p_fields ? 'village' then nullif(trim(p_fields ->> 'village'), '') else village end,
    occupation = case when p_fields ? 'occupation' then nullif(trim(p_fields ->> 'occupation'), '') else occupation end,
    emergency_name = case when p_fields ? 'emergency_name' then nullif(trim(p_fields ->> 'emergency_name'), '') else emergency_name end,
    emergency_phone = case when p_fields ? 'emergency_phone' then nullif(trim(p_fields ->> 'emergency_phone'), '') else emergency_phone end,
    blood_group = case when p_fields ? 'blood_group' then nullif(trim(p_fields ->> 'blood_group'), '') else blood_group end,
    -- an allergy written wins; "no known allergies" clears the text
    allergies = case when v_allergies is not null then v_allergies
                     when p_fields ? 'allergies' then null
                     when v_none then null
                     else allergies end,
    allergies_none = case when v_allergies is not null then false
                          when p_fields ? 'allergies_none' then v_none
                          else allergies_none end,
    notes = case when p_fields ? 'notes' then nullif(trim(p_fields ->> 'notes'), '') else notes end,
    ubudehe_category = case when p_fields ? 'ubudehe_category' then nullif(p_fields ->> 'ubudehe_category', '')::smallint else ubudehe_category end,
    language = coalesce((p_fields ->> 'language')::lang, language),
    preferred_channel = coalesce((p_fields ->> 'preferred_channel')::contact_channel, preferred_channel),
    -- Replace the whole map; the app always sends the full set of extra values.
    extra = case when p_fields ? 'extra' then p_fields -> 'extra' else extra end
  where id = p_patient_id and deleted_at is null;
  if not found then
    raise exception 'patient not found' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------- the table policies
-- Reading a clinical table directly gives the rows of the visits the person may see.
drop policy if exists observation_select on observation;
create policy observation_select on observation for select to authenticated
  using (has_perm('clinical.read') and visit_view(encounter_id) is not null);
drop policy if exists condition_select on condition;
create policy condition_select on condition for select to authenticated
  using (has_perm('clinical.read') and visit_view(encounter_id) is not null);
drop policy if exists procedure_select on procedure;
create policy procedure_select on procedure for select to authenticated
  using (has_perm('clinical.read') and visit_view(encounter_id) is not null);
drop policy if exists service_request_select on service_request;
create policy service_request_select on service_request for select to authenticated
  using (has_perm('orders.read') and visit_view(encounter_id) is not null);
drop policy if exists diagnostic_report_select on diagnostic_report;
create policy diagnostic_report_select on diagnostic_report for select to authenticated
  using (has_perm('orders.read') and exists (
    select 1 from service_request r
    where r.id = diagnostic_report.service_request_id and visit_view(r.encounter_id) is not null));
drop policy if exists medication_request_select on medication_request;
create policy medication_request_select on medication_request for select to authenticated
  using (has_perm('prescription.read') and visit_view(encounter_id) is not null);
drop policy if exists medication_dispense_select on medication_dispense;
create policy medication_dispense_select on medication_dispense for select to authenticated
  using (has_perm('prescription.read') and visit_view(encounter_id) is not null);
drop policy if exists prescription_doc_read on prescription_doc;
create policy prescription_doc_read on prescription_doc for select
  using ((has_perm('prescription.read') or has_perm('clinical.read')) and visit_view(encounter_id) is not null);
drop policy if exists vaccination_select on vaccination;
create policy vaccination_select on vaccination for select to authenticated
  using (has_perm('clinical.read') and case when encounter_id is not null then visit_view(encounter_id) is not null
                                          else history_via(patient_id) is not null end);
drop policy if exists fp_event_select on fp_event;
create policy fp_event_select on fp_event for select to authenticated
  using (has_perm('clinical.read') and case when encounter_id is not null then visit_view(encounter_id) is not null
                                          else history_via(patient_id) is not null end);
drop policy if exists hiv_test_select on hiv_test;
create policy hiv_test_select on hiv_test for select to authenticated
  using (has_perm('sensitive.read') and case when encounter_id is not null then visit_view(encounter_id) is not null
                                            else history_via(patient_id) is not null end);
drop policy if exists document_select on document;
create policy document_select on document for select to authenticated
  using (has_perm('patient.read') and case when encounter_id is not null then visit_view(encounter_id) is not null
                                          else history_via(patient_id) is not null end);

-- ---------------------------------------------------------------- B requests, C emergencies
-- Who answers a request about the patient: the managers and the heads in charge.
create or replace function record_access_approvers(p_patient_id uuid)
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(distinct x.id), '{}')
  from (
    select p.id from profiles p where p.role = 'manager' and p.active and p.deleted_at is null
    union
    select unnest(heads_in_charge(p_patient_id))
  ) x
$$;

-- May the signed-in person answer requests about the patient?
create or replace function may_answer_access(p_patient_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select is_manager() or coalesce(auth.uid() = any (heads_in_charge(p_patient_id)), false)
$$;

-- The checks shared by a request and an emergency access: signed in, reads clinical records,
-- treats the patient now, has no access already, gave a reason. Returns the visit treated.
create or replace function record_access_check(p_patient_id uuid, p_reason text)
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare
  v_enc uuid;
begin
  if auth.uid() is null or not clinical_reader() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from patient where id = p_patient_id and deleted_at is null) then
    raise exception 'patient not found' using errcode = 'P0002';
  end if;
  v_enc := treating_visit(p_patient_id);
  if v_enc is null then
    raise exception 'not allowed: only the people treating the patient now may ask to see the past records'
      using errcode = '42501', hint = 'not_treating';
  end if;
  if history_via(p_patient_id) is not null then
    raise exception 'you already see the past records of this patient'
      using errcode = '22023', hint = 'already_allowed';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'say why you need the past records' using errcode = '22023', hint = 'reason_needed';
  end if;
  return v_enc;
end
$$;

-- B: ask the manager and the heads in charge to see the patient's past records. A request
-- still waiting for this visit is returned as it is.
create or replace function request_record_access(p_patient_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_enc uuid := record_access_check(p_patient_id, p_reason);
  v_req record_access_request%rowtype;
  v_name text;
  v_file text;
  v_me text;
  v_to uuid[];
begin
  select * into v_req from record_access_request r
  where r.patient_id = p_patient_id and r.encounter_id = v_enc and r.requested_by = auth.uid()
    and r.kind = 'request' and r.status = 'pending'
  order by r.created_at desc limit 1;
  if found then
    return jsonb_build_object('id', v_req.id, 'status', v_req.status, 'existing', true,
                              'approvers', cardinality(record_access_approvers(p_patient_id)));
  end if;
  insert into record_access_request (patient_id, encounter_id, requested_by, kind, reason)
  values (p_patient_id, v_enc, auth.uid(), 'request', trim(p_reason))
  returning * into v_req;
  select p.surname || ' ' || p.given_names, p.file_number into v_name, v_file from patient p where p.id = p_patient_id;
  select full_name into v_me from profiles where id = auth.uid();
  v_to := array(select x from unnest(record_access_approvers(p_patient_id)) x where x <> auth.uid());
  insert into notification (kind, params, title, body, link, urgent, recipient_user, created_by)
  select 'access_request',
         jsonb_build_object('requestId', v_req.id, 'patientId', p_patient_id, 'name', v_name, 'file', v_file,
                            'by', v_me, 'reason', v_req.reason),
         'Access to past records requested',
         v_me || ' asks to see the past records of ' || v_name || ' (' || coalesce(v_file, '') || '): ' || v_req.reason,
         '/app/record-access?request=' || v_req.id, false, x, auth.uid()
  from unnest(v_to) x;
  return jsonb_build_object('id', v_req.id, 'status', v_req.status, 'existing', false,
                            'approvers', cardinality(v_to));
end
$$;

-- C: open the past records at once in an emergency. Urgent notice to the manager and the heads
-- in charge; a red entry in the access log; the manager reviews it later.
create or replace function emergency_record_access(p_patient_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_enc uuid := record_access_check(p_patient_id, p_reason);
  v_req record_access_request%rowtype;
  v_name text;
  v_file text;
  v_me text;
begin
  insert into record_access_request (patient_id, encounter_id, requested_by, kind, reason, status, answered_at)
  values (p_patient_id, v_enc, auth.uid(), 'emergency', trim(p_reason), 'approved', now())
  returning * into v_req;
  -- a request still waiting for this visit is no longer needed
  with c as (
    update record_access_request set status = 'cancelled', answered_at = now(), answer_note = 'emergency access opened'
    where patient_id = p_patient_id and encounter_id = v_enc and requested_by = auth.uid()
      and kind = 'request' and status = 'pending'
    returning id
  )
  delete from notification n using c
  where n.kind = 'access_request' and (n.params ->> 'requestId') = c.id::text;
  insert into record_access_entry (actor_id, patient_id, encounter_id, via, what, request_id)
  values (auth.uid(), p_patient_id, null, 'emergency', 'emergency', v_req.id);
  select p.surname || ' ' || p.given_names, p.file_number into v_name, v_file from patient p where p.id = p_patient_id;
  select full_name into v_me from profiles where id = auth.uid();
  insert into notification (kind, params, title, body, link, urgent, recipient_user, created_by)
  select 'access_emergency',
         jsonb_build_object('requestId', v_req.id, 'patientId', p_patient_id, 'name', v_name, 'file', v_file,
                            'by', v_me, 'reason', v_req.reason),
         'Emergency access to past records',
         v_me || ' opened the past records of ' || v_name || ' (' || coalesce(v_file, '') || ') in an emergency: ' || v_req.reason,
         '/app/record-access?request=' || v_req.id, true, x, auth.uid()
  from unnest(record_access_approvers(p_patient_id)) x
  where x <> auth.uid();
  return jsonb_build_object('id', v_req.id, 'status', v_req.status, 'via', 'emergency');
end
$$;

-- B: the first approver to answer approves or refuses (a refusal says why). The requester is told.
create or replace function answer_record_access(p_request_id uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_req record_access_request%rowtype;
  v_name text;
  v_me text;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_req from record_access_request where id = p_request_id for update;
  if not found or v_req.kind <> 'request' then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if v_req.requested_by = auth.uid() or not may_answer_access(v_req.patient_id) then
    raise exception 'not allowed: the manager or a head of a department in charge of the patient answers'
      using errcode = '42501', hint = 'not_approver';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'this request was already answered (%)', v_req.status
      using errcode = '22023', hint = 'already_answered',
            detail = coalesce((select full_name from profiles where id = v_req.answered_by), '');
  end if;
  if p_approve is null then
    raise exception 'approve or refuse' using errcode = '22023';
  end if;
  if not p_approve and (v_note is null or length(v_note) < 3) then
    raise exception 'say why the request is refused' using errcode = '22023', hint = 'reason_needed';
  end if;
  if p_approve and not exists (select 1 from encounter e where e.id = v_req.encounter_id and e.status = 'open' and e.deleted_at is null) then
    raise exception 'the visit is closed: the access would end at once' using errcode = '22023', hint = 'visit_closed';
  end if;
  update record_access_request
  set status = case when p_approve then 'approved' else 'refused' end,
      answered_by = auth.uid(), answered_at = now(), answer_note = v_note
  where id = p_request_id
  returning * into v_req;
  -- the other approvers no longer need to answer
  delete from notification where kind = 'access_request' and (params ->> 'requestId') = p_request_id::text;
  select p.surname || ' ' || p.given_names into v_name from patient p where p.id = v_req.patient_id;
  select full_name into v_me from profiles where id = auth.uid();
  insert into notification (kind, params, title, body, link, urgent, recipient_user, created_by)
  values ('access_answer',
          jsonb_build_object('requestId', v_req.id, 'patientId', v_req.patient_id, 'name', v_name,
                             'approved', p_approve, 'by', v_me, 'reason', v_note),
          case when p_approve then 'Access to past records approved' else 'Access to past records refused' end,
          v_me || case when p_approve then ' approved your request to see the past records of '
                       else ' refused your request to see the past records of ' end
            || v_name || coalesce(': ' || v_note, '') || '.',
          '/app/patient?id=' || v_req.patient_id, false, v_req.requested_by, auth.uid());
  return jsonb_build_object('id', v_req.id, 'status', v_req.status);
end
$$;

-- The requester withdraws a request still waiting.
create or replace function cancel_record_access(p_request_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update record_access_request set status = 'cancelled', answered_at = now()
  where id = p_request_id and requested_by = auth.uid() and kind = 'request' and status = 'pending';
  if not found then
    raise exception 'no request of yours waiting' using errcode = 'P0002', hint = 'not_found';
  end if;
  delete from notification where kind = 'access_request' and (params ->> 'requestId') = p_request_id::text;
end
$$;

-- C: the manager reviews an emergency access (with a comment).
create or replace function review_emergency_access(p_request_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_manager() then
    raise exception 'not allowed: the manager reviews emergency accesses' using errcode = '42501', hint = 'not_manager';
  end if;
  update record_access_request
  set reviewed_by = auth.uid(), reviewed_at = now(), review_note = nullif(trim(coalesce(p_note, '')), '')
  where id = p_request_id and kind = 'emergency';
  if not found then
    raise exception 'emergency access not found' using errcode = 'P0002';
  end if;
end
$$;

-- B/C: the requests and emergency accesses the signed-in person may see (the last 90 days):
--   'pending'   waiting for an answer they may give
--   'mine'      their own
--   'emergency' emergency accesses (the manager: those to review first)
--   'all'       every one they may see (as requester, approver or the manager)
create or replace function record_access_requests(p_scope text default 'pending')
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'kind', r.kind, 'status', r.status,
      'patientId', r.patient_id, 'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'encounterId', r.encounter_id, 'visitReference', e.reference, 'visitOpen', e.status = 'open',
      'requestedById', r.requested_by, 'requestedBy', rq.full_name, 'requestedByRole', rq.role,
      'reason', r.reason, 'at', r.created_at,
      'answeredBy', (select full_name from profiles where id = r.answered_by),
      'answeredAt', r.answered_at, 'answerNote', r.answer_note,
      'active', r.status = 'approved' and e.status = 'open',
      'mine', r.requested_by = auth.uid(),
      'canAnswer', r.kind = 'request' and r.status = 'pending' and r.requested_by <> auth.uid()
                   and e.status = 'open' and may_answer_access(r.patient_id),
      'canCancel', r.kind = 'request' and r.status = 'pending' and r.requested_by = auth.uid(),
      'reviewedBy', (select full_name from profiles where id = r.reviewed_by),
      'reviewedAt', r.reviewed_at, 'reviewNote', r.review_note,
      'canReview', r.kind = 'emergency' and r.reviewed_at is null and is_manager()
    ) order by (r.kind = 'emergency' and r.reviewed_at is null) desc, (r.status = 'pending') desc, r.created_at desc), '[]'::jsonb)
  from record_access_request r
  join patient p on p.id = r.patient_id
  join encounter e on e.id = r.encounter_id
  join profiles rq on rq.id = r.requested_by
  where auth.uid() is not null
    and r.created_at > now() - interval '90 days'
    and (r.requested_by = auth.uid() or may_answer_access(r.patient_id))
    and case coalesce(p_scope, 'pending')
          when 'pending' then r.kind = 'request' and r.status = 'pending' and r.requested_by <> auth.uid()
                              and e.status = 'open'
          when 'mine' then r.requested_by = auth.uid()
          when 'emergency' then r.kind = 'emergency'
          else true
        end
$$;

-- ---------------------------------------------------------------- D the access log
create or replace function access_entry_json(a record_access_entry)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', a.id, 'at', a.at, 'actorId', a.actor_id, 'actor', pr.full_name, 'actorRole', pr.role,
    'patientId', a.patient_id, 'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
    'encounterId', a.encounter_id, 'visitReference', e.reference,
    'via', a.via, 'what', a.what, 'requestId', a.request_id, 'reason', r.reason,
    'emergency', a.via = 'emergency',
    'reviewed', r.reviewed_at is not null, 'reviewedBy', (select full_name from profiles where id = r.reviewed_by),
    'reviewNote', r.review_note)
  from patient p
  left join profiles pr on pr.id = a.actor_id
  left join encounter e on e.id = a.encounter_id
  left join record_access_request r on r.id = a.request_id
  where p.id = a.patient_id
$$;

-- The manager's page "Record access": who opened past records, filtered (default: 30 days).
create or replace function record_access_log(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_patient_id uuid default null,
  p_actor uuid default null,
  p_via text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '30 days');
  v_to timestamptz := coalesce(p_to, now() + interval '1 minute');
  v_total integer;
  v_rows jsonb;
begin
  if not is_manager() then
    raise exception 'not allowed: the manager reads the record access log' using errcode = '42501';
  end if;
  select count(*) into v_total
  from record_access_entry a
  where a.at >= v_from and a.at < v_to
    and (p_patient_id is null or a.patient_id = p_patient_id)
    and (p_actor is null or a.actor_id = p_actor)
    and (p_via is null or a.via = p_via);
  select coalesce(jsonb_agg(access_entry_json(x) order by x.at desc), '[]'::jsonb) into v_rows
  from (
    select a.* from record_access_entry a
    where a.at >= v_from and a.at < v_to
      and (p_patient_id is null or a.patient_id = p_patient_id)
      and (p_actor is null or a.actor_id = p_actor)
      and (p_via is null or a.via = p_via)
    order by a.at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500)) offset greatest(coalesce(p_offset, 0), 0)
  ) x;
  return jsonb_build_object('total', v_total, 'rows', v_rows,
    'unreviewed', (select count(*) from record_access_request r where r.kind = 'emergency' and r.reviewed_at is null));
end
$$;

-- The patient file's "Who looked": the manager and the heads in charge.
create or replace function patient_access_log(p_patient_id uuid, p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if not may_answer_access(p_patient_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(access_entry_json(x) order by x.at desc)
    from (select a.* from record_access_entry a where a.patient_id = p_patient_id
          order by a.at desc limit greatest(1, least(coalesce(p_limit, 50), 200))) x), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- grants
-- Internal: written by the reading functions only.
revoke all on function log_record_access(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function record_access_check(uuid, text) from public, anon, authenticated;
revoke all on function patient_safety_summary(uuid) from public, anon, authenticated;
revoke all on function access_entry_json(record_access_entry) from public, anon, authenticated;
revoke all on function record_access_approvers(uuid) from public, anon, authenticated;
-- The rules. Only visit_view and history_via are called by the table policies (as the reader);
-- the others run inside the security definer functions and are not for asking about colleagues.
revoke all on function clinical_reader(), took_part(uuid, uuid), treated(uuid, uuid), visit_departments(uuid),
  heads_in_charge(uuid), access_in_force(uuid), treating_visit(uuid), patient_level(uuid), may_answer_access(uuid),
  visit_view_with(uuid, text, boolean), patient_access_with(uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function history_via(uuid), visit_view(uuid) from public, anon;
grant execute on function visit_view(uuid), history_via(uuid) to authenticated;
revoke all on function patient_access(uuid), request_record_access(uuid, text), emergency_record_access(uuid, text),
  answer_record_access(uuid, boolean, text), cancel_record_access(uuid), review_emergency_access(uuid, text),
  record_access_requests(text), record_access_log(timestamptz, timestamptz, uuid, uuid, text, integer, integer),
  patient_access_log(uuid, integer) from public, anon;
grant execute on function patient_access(uuid), request_record_access(uuid, text), emergency_record_access(uuid, text),
  answer_record_access(uuid, boolean, text), cancel_record_access(uuid), review_emergency_access(uuid, text),
  record_access_requests(text), record_access_log(timestamptz, timestamptz, uuid, uuid, text, integer, integer),
  patient_access_log(uuid, integer) to authenticated;
revoke all on function patient_file(uuid), visit_clinical(uuid), patient_results(uuid), visit_journey(uuid),
  update_patient(uuid, jsonb) from public, anon;
grant execute on function patient_file(uuid), visit_clinical(uuid), patient_results(uuid), visit_journey(uuid),
  update_patient(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------- H the other ways in
-- The latest vital signs of a visit (0019): the open visits as before (the queues, triage and the
-- nurse's paper sheet need them); a closed visit only for whoever may see its record.
create or replace view visit_vitals with (security_invoker = false) as
  select distinct on (o.encounter_id, o.code)
         o.encounter_id, o.code, o.value_num, o.unit, o.effective_at,
         pm.full_name as measured_by, pe.full_name as entered_by
  from observation o
  join encounter e on e.id = o.encounter_id and e.deleted_at is null
  left join profiles pm on pm.id = o.performer_id
  left join profiles pe on pe.id = o.created_by
  where o.deleted_at is null
    and o.code in ('bp_sys', 'bp_dia', 'pulse', 'temp', 'resp', 'spo2', 'weight', 'height', 'muac')
    and (has_perm('clinical.read') or has_perm('vitals.write'))
    and (e.status = 'open' or visit_view(o.encounter_id) is not null)
  order by o.encounter_id, o.code, o.effective_at desc;
revoke all on visit_vitals from anon;
grant select on visit_vitals to authenticated;

-- The queue board runs with its owner's rights, because the triage reason and the referral note
-- are no longer readable from the tables (below). It filters as the tables' policies did: queue
-- and patient readers; colleagues' names for staff readers (or oneself). Open visits only.
create or replace view queue_board with (security_invoker = false) as
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
         -- the latest handover of the entry (20261129090000_handover); its note is clinical: for
         -- the two colleagues and those who read clinical records
         ho.id as handover_id, ho.status as handover_status,
         ho.from_user as handover_from, hf.full_name as handover_from_name,
         ho.to_user as handover_to, ht.full_name as handover_to_name,
         case when auth.uid() in (ho.from_user, ho.to_user) or has_perm('clinical.read')
              then ho.note end as handover_note,
         ho.created_at as handover_at, ho.answered_at as handover_answered_at
  from queue_entry q
  join encounter e on e.id = q.encounter_id
  join patient p on p.id = e.patient_id
  left join profiles tb on tb.id = q.taken_by and (tb.id = auth.uid() or has_perm('staff.read'))
  left join profiles asg on asg.id = q.assigned_to and (asg.id = auth.uid() or has_perm('staff.read'))
  left join profiles rb on rb.id = q.referred_by and (rb.id = auth.uid() or has_perm('staff.read'))
  left join department dep on dep.id = q.department_id and dep.deleted_at is null
  left join lateral last_vitals_stamp(q.encounter_id) v on true
  left join lateral (select h.* from patient_handover h
                     where h.queue_id = q.id and h.status in ('pending', 'taken') and h.deleted_at is null
                     order by h.created_at desc limit 1) ho on true
  left join profiles hf on hf.id = ho.from_user
  left join profiles ht on ht.id = ho.to_user
  where q.deleted_at is null and e.status = 'open'
    and has_perm('queue.read') and has_perm('patient.read');
revoke all on queue_board from anon;
grant select on queue_board to authenticated;

-- Reading the tables directly gives no safety field, triage reason or referral note: those come
-- through the reading functions, by level. Column privileges: a column added to these tables later
-- must be granted here too (a plain "grant select on patient" would open them all again).
revoke select on patient from authenticated;
grant select (id, created_at, created_by, device_id, received_at, updated_at, updated_by, deleted_at, version,
              file_number, surname, given_names, sex, birth_date, age_estimated, national_id, id_verified,
              id_source, phone_1, phone_2, preferred_channel, language, district, sector, cell, village,
              ubudehe_category, occupation, emergency_name, emergency_phone, guardian_patient_id,
              consent_treatment, consent_messages, consent_insurer, merged_into, photo_blob_id, no_national_id)
  on patient to authenticated;
revoke select on encounter from authenticated;
grant select (id, created_at, created_by, device_id, received_at, updated_at, updated_by, deleted_at, version,
              patient_id, type, arrived_at, practitioner_id, triage_level, coverage_id, appointment_id,
              status, closed_at, closed_by, reopen_reason, clinical_done_at, left_reason, service,
              intended_to, reference)
  on encounter to authenticated;
revoke select on queue_entry from authenticated;
grant select (id, created_at, created_by, device_id, received_at, updated_at, updated_by, deleted_at, version,
              encounter_id, station, ticket_no, priority, called_at, started_at, finished_at, entered_by,
              pool_id, taken_by, assigned_to, referred_by, return_station, return_to, department_id, service)
  on queue_entry to authenticated;

-- The patient search (0026): identity for everyone; the allergy and safety marks for the people
-- who read clinical records.
create or replace function patients_list(p_query text default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with q as (select nullif(trim(coalesce(p_query, '')), '') as text),
  base as (
    select p.*,
           (select max(e.arrived_at) from encounter e where e.patient_id = p.id and e.deleted_at is null) as last_visit_at,
           (select count(*) from encounter e where e.patient_id = p.id and e.deleted_at is null) as visits,
           (select e.id from encounter e where e.patient_id = p.id and e.status = 'open' and e.deleted_at is null order by e.arrived_at desc limit 1) as open_encounter_id,
           (select coalesce(sum(invoice_balance(i.id)), 0) from invoice i join encounter e on e.id = i.encounter_id where e.patient_id = p.id and i.deleted_at is null and i.status <> 'credited') as balance_due
    from patient p, q
    where has_perm('patient.read') and p.deleted_at is null and p.merged_into is null
      and (q.text is null
        or upper(p.file_number) = upper(q.text)
        or p.national_id = q.text
        or (length(regexp_replace(q.text, '[^0-9]', '', 'g')) >= 4 and regexp_replace(coalesce(p.phone_1, ''), '[^0-9]', '', 'g') like '%' || regexp_replace(q.text, '[^0-9]', '', 'g') || '%')
        or (p.surname || ' ' || p.given_names) ilike '%' || q.text || '%'
        or (p.given_names || ' ' || p.surname) ilike '%' || q.text || '%')
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', b.id, 'fileNumber', b.file_number, 'surname', b.surname, 'givenNames', b.given_names,
        'sex', b.sex, 'birthDate', b.birth_date, 'phone', b.phone_1, 'sector', b.sector,
        'registeredAt', b.created_at, 'lastVisitAt', b.last_visit_at, 'visits', b.visits,
        'openEncounterId', b.open_encounter_id, 'balanceDue', b.balance_due,
        -- 0088: the safety marks for the people who read clinical records only ("VIP" for all)
        'flags', case when clinical_reader() then b.flags
                      else jsonb_strip_nulls(jsonb_build_object('vip', b.flags -> 'vip')) end,
        'hasAllergies', case when clinical_reader() then b.allergies is not null else false end
      ) order by coalesce(b.last_visit_at, b.created_at) desc)
      from (select * from base order by coalesce(last_visit_at, created_at) desc limit greatest(1, least(p_limit, 200)) offset greatest(0, p_offset)) b), '[]'::jsonb)
  )
$$;

-- The analytics of one person (0086), for the heads and assistants of their department: what was
-- written in a visit (a diagnosis, a medicine, a result) only where the reader may see that visit.
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
  if not v_manager and not exists (
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
                         or ev.kind in ('registered', 'patientsSeen', 'charges', 'admissions',
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
revoke all on function staff_activity_detail(uuid, date, date, text, integer) from public, anon;
grant execute on function staff_activity_detail(uuid, date, date, text, integer) to authenticated;

-- B: a request still waiting when its visit closes can no longer be answered: it is cancelled and
-- the approvers' notices go.
create or replace function cancel_requests_of_closed_visit()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  with c as (
    update record_access_request
    set status = 'cancelled', answered_at = now(), answer_note = 'visit closed'
    where encounter_id = new.id and status = 'pending'
    returning id
  )
  delete from notification n using c
  where n.kind = 'access_request' and (n.params ->> 'requestId') = c.id::text;
  return null;
end
$$;
revoke all on function cancel_requests_of_closed_visit() from public, anon, authenticated;
drop trigger if exists encounter_closed_cancels_access on encounter;
create trigger encounter_closed_cancels_access
  after update of status on encounter
  for each row when (new.status = 'closed' and old.status is distinct from 'closed')
  execute function cancel_requests_of_closed_visit();

-- The heads of a department are looked up for every visit of a patient.
create index if not exists staff_department_department_position_idx on staff_department (department_id, position);
