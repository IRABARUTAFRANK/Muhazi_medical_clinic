-- 0126 · Patient records are for doctors.
--
-- Frank (the owner): "Only the doctor views the records of patients. Anyone with the role of
-- doctor can view the records; even the manager can view them if he is a doctor, but if he isn't
-- he can't view the patient record files. The doctor may be in dental, consultation or any other
-- department — being a doctor is what gives access."
--
--   * A  WHO IS A DOCTOR: is_doctor() = the role 'doctor', or profiles.is_doctor, which the manager
--        switches on for another employee or for himself (set_staff_doctor) with the registration
--        number of the medical council (RMDC…). Audited (History: Settings) and told to the other
--        managers. Nobody is marked by this migration: the manager ticks it himself (the live
--        manager's specialty "General doctor" does not make him one).
--   * B  WHAT A RECORD IS: clinical notes, diagnoses (and the reason no diagnosis was found),
--        prescriptions, the tests' clinical reason and results, the attachments of visits and
--        tests, the medical documents, past visits' clinical record, the record access history.
--        NOT a record: identity and contact, the file number, the list of visits (date, desks,
--        who), bills and payments, counts, queues and tickets, the vital signs at the desk that
--        measures them, the safety summary (allergies, alerts, long-term conditions) for whoever
--        treats the patient now.
--   * C  WHO SEES RECORDS: doctors only. The rules of 0088 stay on top for the doctors (being a
--        doctor is necessary, not sufficient): the open visit they work on ('visit'), the visits
--        they treated ('own'), the manager-doctor ('manager'), the head-doctor of a department in
--        charge ('head'), an approved request or an emergency access. history_via and
--        visit_view_with answer null for anyone else, and everything built on them follows: the
--        clinical tables' policies, patient_file, patient_results, visit_journey, the files, the
--        reports' diagnosis columns, the queue board's notes.
--   * D  THE DESKS keep their part of an open visit they work on (visit_clinical, view 'desk'):
--        what the person wrote themselves; the pharmacy the medicines to hand over; a treating
--        desk the medicines given in the room; the laboratory, ultrasound or a desk doing its own
--        tests the tests it runs with their reason and result (an HIV test too: the desk running
--        it); everyone the safety summary. The diagnosis, the others' notes and the past visits
--        are not part of it. The manager may use every desk to run the clinic: a manager who is
--        not a doctor gets no desk part from that (only what he wrote or was sent by name).
--   * E  REQUESTS AND EMERGENCIES: only doctors ask (record_access_check, hint 'not_doctor');
--        the approvers are doctors: the manager if a doctor and the doctors given
--        records.approve (0095: a head no longer answers by position); when none of them is
--        left, every other active doctor; never a non-doctor. The record access page, its log,
--        the reviews and "Who looked" are for doctors.
--   * F  THE OTHER WAYS IN: the clinical reports (diagnoses, prescriptions; patients seen without
--        the diagnosis; tests without the result) and report_assert_clinical; the visits list's
--        diagnosis (visits_in_period) and the Patients' documents (visit_documents, analytics
--        'documents'); the home page's results; my_orders' results; the menu's results and
--        record-access counts; the laboratory worklist and desk orders seen by a manager who is
--        not a doctor; a colleague's analytics; the notice of a result; the History page and the
--        audit table; the private "medical" patient fields in the patients report.
--
-- Errcodes: 42501 not allowed (hints: not_doctor, not_manager), 22023 bad input (hints:
-- registration_needed, doctor_by_role), P0002 not found (hint: not_found).

-- ---------------------------------------------------------------- A who is a doctor
alter table profiles add column if not exists is_doctor boolean not null default false;
comment on column profiles.is_doctor is
  'Marked a doctor by the manager (set_staff_doctor, 0126): sees patient records like the role doctor.';

-- A doctor: the role 'doctor', or marked a doctor by the manager; active.
create or replace function is_doctor(p_user uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select p.active and p.deleted_at is null and (p.role = 'doctor' or p.is_doctor)
                   from profiles p where p.id = p_user), false)
$$;

-- The manager marks an employee (or himself) a doctor, with the registration number; or takes
-- the mark away. Audited; the other active managers are told.
create or replace function set_staff_doctor(
  p_profile uuid,
  p_on boolean,
  p_registration_no text default null,
  p_registration_body text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_p profiles%rowtype;
  v_no text := nullif(trim(coalesce(p_registration_no, '')), '');
  v_body text := nullif(trim(coalesce(p_registration_body, '')), '');
  v_me text;
begin
  if auth.uid() is null or not is_manager() then
    raise exception 'not allowed: the manager marks who is a doctor' using errcode = '42501', hint = 'not_manager';
  end if;
  if p_on is null then
    raise exception 'say yes or no' using errcode = '22023';
  end if;
  select * into v_p from profiles where id = p_profile and deleted_at is null for update;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if p_on and (v_no is null or length(v_no) < 3) then
    raise exception 'the registration number is needed to mark a doctor'
      using errcode = '22023', hint = 'registration_needed';
  end if;
  if not p_on and v_p.role = 'doctor' then
    raise exception 'a doctor by role stays a doctor: change the role instead'
      using errcode = '22023', hint = 'doctor_by_role';
  end if;
  update profiles
  set is_doctor = p_on,
      registration_no = case when p_on then v_no else registration_no end,
      registration_body = case when p_on then coalesce(v_body, registration_body) else registration_body end
  where id = p_profile
  returning * into v_p;
  insert into audit_event (actor_id, action, entity, entity_id, after)
  values (auth.uid(), 'settings', 'profiles', p_profile,
          jsonb_build_object('key', 'staff_doctor', 'on', p_on, 'registration_no', v_p.registration_no,
                             'registration_body', v_p.registration_body));
  select full_name into v_me from profiles where id = auth.uid();
  insert into notification (kind, params, title, body, link, urgent, recipient_user, created_by)
  select 'staff_doctor',
         jsonb_build_object('profileId', p_profile, 'name', v_p.full_name, 'on', p_on, 'by', v_me,
                            'registrationNo', v_p.registration_no, 'registrationBody', v_p.registration_body),
         case when p_on then 'Marked a doctor' else 'No longer marked a doctor' end,
         v_me || case when p_on then ' marked ' || v_p.full_name || ' a doctor (sees patient records), registration '
                                     || coalesce(v_p.registration_no, '') || '.'
                      else ' took away the doctor mark of ' || v_p.full_name || ' (no longer sees patient records).' end,
         '/app/staff/profile?id=' || p_profile, false, m.id, auth.uid()
  from profiles m
  where m.role = 'manager' and m.active and m.deleted_at is null and m.id <> auth.uid();
  return jsonb_build_object('id', p_profile, 'isDoctor', is_doctor(p_profile), 'marked', v_p.is_doctor,
                            'registrationNo', v_p.registration_no, 'registrationBody', v_p.registration_body);
end
$$;

-- The desks of the person themselves (a department, the role, kept): not the manager's right to
-- open every desk to run the clinic.
create or replace function works_at_desk(p_desk text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(desk_via(auth.uid(), p_desk) <> 'manager', false)
$$;

-- Working on the open visit now (the 'visit' rule of 0088): may work on it, took part, it waits
-- at a desk the person uses, a test of it is open at their laboratory / ultrasound desk, a
-- medicine of it waits at their pharmacy.
create or replace function visit_working_on(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select auth.uid() is not null
    and exists (select 1 from encounter e where e.id = p_encounter_id and e.status = 'open' and e.deleted_at is null)
    and (may_work_on(p_encounter_id) or took_part(p_encounter_id)
         -- the visit waits, not yet taken, at a desk this person uses (they may take the patient)
         or exists (select 1 from queue_entry q
                    where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
                      and q.taken_by is null and (q.assigned_to is null or q.assigned_to = auth.uid())
                      and q.station <> 'reception' and may_use_any_desk(station_desks(q.station)))
         -- a test of the visit is open at their laboratory or ultrasound desk
         or exists (select 1 from service_request r
                    where r.encounter_id = p_encounter_id and r.deleted_at is null
                      and r.status not in ('verified', 'cancelled')
                      and may_use_desk(request_desk(r.station, r.category)))
         -- a medicine of the visit waits at the pharmacy
         or (may_use_desk('pharmacy')
             and exists (select 1 from medication_request m
                         where m.encounter_id = p_encounter_id and m.deleted_at is null and rx_pending(m))))
$$;

-- The same for a desk part (D): a manager who is not a doctor only where he is named (the
-- patient sent or handed to him, a task for him, a help he accepted) or took part.
create or replace function visit_desk_working(p_encounter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    when not is_manager() then visit_working_on(p_encounter_id)
    else exists (select 1 from encounter e where e.id = p_encounter_id and e.status = 'open' and e.deleted_at is null)
      and (exists (select 1 from queue_entry q
                   where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
                     and auth.uid() in (q.assigned_to, q.taken_by, q.return_to))
           or exists (select 1 from internal_task k
                      where k.encounter_id = p_encounter_id and k.done_at is null and k.deleted_at is null
                        and k.assigned_to = auth.uid())
           or exists (select 1 from staff_call c
                      where c.encounter_id = p_encounter_id and c.kind = 'help' and c.status = 'accepted'
                        and c.answered_by = auth.uid())
           or took_part(p_encounter_id))
  end
$$;

-- D: the desk part of an open visit for someone who is not a doctor and works on it ('desk'), or
-- null.
create or replace function visit_desk_view(p_encounter_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select case when auth.uid() is not null and not is_doctor() and clinical_reader()
                   and visit_desk_working(p_encounter_id) then 'desk' end
$$;

-- A queue entry that is the person's own (sent, handed or given back to them; for the others
-- their section's): its referral note is the instruction for them. Not the manager's right to
-- every desk.
create or replace function queue_entry_mine(p_queue_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from queue_entry q
                 where q.id = p_queue_id and q.deleted_at is null
                   and (auth.uid() in (q.assigned_to, q.taken_by, q.return_to)
                        or (not is_manager() and queue_entry_for_me(q.id))))
$$;

-- ---------------------------------------------------------------- C the gates of 0088, for doctors
-- How the signed-in person sees the patient's whole history, or null: doctors only.
create or replace function history_via(p_patient_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when auth.uid() is null or not is_doctor() then null
    when is_manager() then 'manager'
    when auth.uid() = any (heads_in_charge(p_patient_id)) then 'head'
    else (select a.kind from access_in_force(p_patient_id) a where a.id is not null)
  end
$$;

-- The heads (not the assistants) of the departments in charge of any visit of the patient, who
-- are doctors.
create or replace function heads_in_charge(p_patient_id uuid)
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(distinct sd.profile_id), '{}')
  from encounter e
  cross join lateral unnest(visit_departments(e.id)) as vd(id)
  join staff_department sd on sd.department_id = vd.id and sd.position = 'head'
  join profiles p on p.id = sd.profile_id and p.active and p.deleted_at is null
                 and (p.role = 'doctor' or p.is_doctor)
  where e.patient_id = p_patient_id and e.deleted_at is null
$$;

-- How the signed-in person sees one visit's clinical record, or null (0088), for doctors only:
--   open visit:   'visit' (working on it, the manager-doctor), else history_via
--   closed visit: 'manager', 'own' (treated it), else history_via
-- Someone who is not a doctor gets null; their desk part comes from visit_desk_view.
create or replace function visit_view_with(p_encounter_id uuid, p_via text, p_via_known boolean)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  v_e encounter%rowtype;
begin
  if auth.uid() is null or not is_doctor() then
    return null;
  end if;
  select * into v_e from encounter where id = p_encounter_id and deleted_at is null;
  if not found then
    return null;
  end if;
  if v_e.status = 'open' then
    if visit_working_on(v_e.id) then
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

-- The open visit the signed-in person treats now (0088), or null. A manager who is not a doctor
-- treats only a patient sent or handed to him by name (not every queue).
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
                   and q.station not in ('reception', 'cashier') and queue_entry_for_me(q.id)
                   and (not is_manager() or is_doctor() or auth.uid() in (q.assigned_to, q.taken_by, q.return_to)))
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

-- ---------------------------------------------------------------- E requests: doctors ask, doctors answer
-- Who answers a request of p_requester about the patient (and is told of an emergency access):
-- the managers who are doctors and the doctors the manager allowed to answer (records.approve);
-- when none of them is left (the requester excluded), every other active doctor. Never a
-- non-doctor. (0095: a head does not answer by position.)
create or replace function request_approvers(p_patient_id uuid, p_requester uuid)
returns uuid[]
language sql stable security definer set search_path = public
as $$
  with doc as (
    select p.id, (p.role = 'manager' or staff_perm(p.id, 'records.approve')) as first_
    from profiles p
    where p.active and p.deleted_at is null and (p.role = 'doctor' or p.is_doctor)
      and p.id is distinct from p_requester
  )
  select case when exists (select 1 from doc where first_)
              then (select array_agg(id) from doc where first_)
              else coalesce((select array_agg(id) from doc), '{}') end
$$;

create or replace function record_access_approvers(p_patient_id uuid)
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select request_approvers(p_patient_id, null)
$$;

-- May the signed-in person answer requests (in general: the record access page)?
create or replace function may_answer_access(p_patient_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(auth.uid() = any (record_access_approvers(p_patient_id)), false)
$$;

-- May the signed-in person answer this requester's request?
create or replace function may_answer_request(p_patient_id uuid, p_requester uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(auth.uid() is distinct from p_requester
                  and auth.uid() = any (request_approvers(p_patient_id, p_requester)), false)
$$;

-- The checks shared by a request and an emergency access (0088): a doctor treating the patient
-- now, without access already, with a reason. Returns the visit treated.
create or replace function record_access_check(p_patient_id uuid, p_reason text)
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare
  v_enc uuid;
begin
  if auth.uid() is null or not has_perm('clinical.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not is_doctor() then
    raise exception 'not allowed: patient records are for doctors' using errcode = '42501', hint = 'not_doctor';
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

-- ---------------------------------------------------------------- D the desk part of an open visit
-- visit_clinical for someone who is not a doctor and works on the open visit (visit_desk_view):
-- the same shape as the record, with only the desk's part. No access log (an open visit).
create or replace function visit_clinical_desk(p_encounter_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_pharmacy boolean := works_at_desk('pharmacy');
  v_treat boolean := exists (select 1 from unnest(treating_desks()) d(desk) where works_at_desk(d.desk));
  v_sens boolean := has_perm('sensitive.read');
begin
  return jsonb_build_object(
    -- what the person wrote themselves (removed ones stay, marked)
    'diagnoses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by), 'byId', c.created_by,
        'editedAt', case when c.deleted_at is null and c.edit_reason is not null then c.updated_at end,
        'editedBy', case when c.deleted_at is null and c.edit_reason is not null then (select full_name from profiles where id = c.updated_by) end,
        'editReason', case when c.deleted_at is null then c.edit_reason end,
        'removedAt', c.deleted_at,
        'removedBy', case when c.deleted_at is not null then (select full_name from profiles where id = c.updated_by) end,
        'removeReason', case when c.deleted_at is not null then c.edit_reason end,
        'history', '[]'::jsonb) order by c.created_at)
      from condition c where c.encounter_id = p_encounter_id and c.created_by = v_me), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.value_text, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id), 'byId', coalesce(o.performer_id, o.created_by),
        'editedAt', case when o.edit_reason is not null then o.updated_at end,
        'editedBy', case when o.edit_reason is not null then (select full_name from profiles where id = o.updated_by) end,
        'editReason', o.edit_reason,
        'history', '[]'::jsonb) order by o.effective_at)
      from observation o where o.encounter_id = p_encounter_id and o.code = 'note' and o.deleted_at is null
        and coalesce(o.performer_id, o.created_by) = v_me), '[]'::jsonb),
    -- the medicines: the person's own; the pharmacy's to hand over; a treating desk's given in the room
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
        'splitFrom', m.split_from,
        'prescriber', doc_person(coalesce(m.prescriber_id, m.created_by))) order by m.created_at)
      from medication_request m where m.encounter_id = p_encounter_id and m.deleted_at is null
        and (coalesce(m.prescriber_id, m.created_by) = v_me or v_pharmacy or (v_treat and m.supply = 'room'))), '[]'::jsonb),
    -- the tests the person's desk runs, with their reason and result; the tests they asked for
    -- themselves without the result (an HIV test: the desk running it, or sensitive.read)
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'test', s.name_en, 'category', r.category, 'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end), 'status', r.status,
        'reason', case when k.runs or r.requester_id = v_me then r.reason end, 'at', r.created_at, 'mine', coalesce(r.requester_id = v_me, false),
        'result', case when k.runs then (select jsonb_build_object('findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
          'corrected', d.corrected_at is not null, 'correctionReason', d.correction_reason,
          'at', coalesce(d.verified_at, d.updated_at), 'by', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
          'byPerson', doc_person(coalesce(d.verified_by, d.created_by)))
          from diagnostic_report d where d.service_request_id = r.id and d.deleted_at is null) end) order by r.created_at)
      from service_request r
      join service s on s.id = r.service_id
      cross join lateral (
        select works_at_desk(request_desk(r.station, r.category))
               or (coalesce(r.station::text, 'laboratory') not in ('laboratory', 'ultrasound')
                   and has_perm('clinical.write')
                   and exists (select 1 from unnest(station_desks(r.station)) sd(desk) where works_at_desk(sd.desk))) as runs
      ) k
      where r.encounter_id = p_encounter_id and r.deleted_at is null
        and (k.runs or (r.requester_id = v_me and (v_sens or not sensitive_service(s.id))))), '[]'::jsonb),
    -- the safety summary of the patient: allergies, blood group, alerts
    'patient', (select jsonb_build_object('id', p.id, 'allergies', p.allergies, 'bloodGroup', p.blood_group, 'notes', p.notes, 'flags', p.flags)
                       || doc_patient(p.id, e.id)
      from encounter e join patient p on p.id = e.patient_id where e.id = p_encounter_id),
    'visit', doc_visit(p_encounter_id),
    'private', false,
    'view', 'desk',
    -- the rest of the record is for doctors
    'forDoctors', true,
    'desk', jsonb_build_object('pharmacy', v_pharmacy, 'treating', v_treat,
                               'laboratory', works_at_desk('laboratory'), 'ultrasound', works_at_desk('ultrasound')),
    -- what finishing the visit needs to know, without the words
    'hasPrimaryDiagnosis', exists (select 1 from condition c
                                   where c.encounter_id = p_encounter_id and c.deleted_at is null and c.type = 'primary'),
    'hasNoDiagnosis', exists (select 1 from encounter e where e.id = p_encounter_id and e.no_diagnosis_kind is not null),
    'editLock', visit_edit_status(p_encounter_id)
  );
end
$$;

-- An attachment of a test the person's desk runs, on an open visit they work on (D): 'desk'.
create or replace function file_desk_view(d patient_file_doc)
returns text
language sql stable security definer set search_path = public
as $$
  select case when d.removed_at is null and d.service_request_id is not null
                   and visit_desk_view(d.encounter_id) is not null
                   and exists (select 1 from service_request r
                               where r.id = d.service_request_id and r.deleted_at is null
                                 and (works_at_desk(request_desk(r.station, r.category))
                                      or (coalesce(r.station::text, 'laboratory') not in ('laboratory', 'ultrasound')
                                          and has_perm('clinical.write')
                                          and exists (select 1 from unnest(station_desks(r.station)) sd(desk)
                                                      where works_at_desk(sd.desk)))))
              then 'desk' end
$$;

-- ---------------------------------------------------------------- F the queue board's referral note
-- (0088 view, the same columns): the referral note for the doctors who see the visit and for the
-- person (or section) it was sent to: it is their instruction.
create or replace view queue_board with (security_invoker = false) as
  select q.id as queue_id, q.encounter_id, q.station, q.ticket_no, q.priority,
         q.created_at as queued_at, q.called_at, q.started_at, q.finished_at,
         e.patient_id, e.triage_level, e.arrived_at, e.type as encounter_type,
         p.file_number, p.surname, p.given_names, p.sex, p.birth_date, p.phone_1,
         q.pool_id, tb.full_name as taken_by_name,
         q.assigned_to, asg.full_name as assigned_name, rb.full_name as referred_by_name,
         -- the referral note: for the doctors who may see the visit, and for whom it was sent to
         case when (has_perm('clinical.read') and visit_view(q.encounter_id) is not null)
                   or queue_entry_mine(q.id)
              then q.referral_note end as referral_note,
         q.return_station,
         v.effective_at as vitals_at, v.measured_by as vitals_by,
         q.department_id, dep.name as department_name, queue_entry_for_me(q.id) as can_work,
         q.taken_by, coalesce(q.service, e.service) as service,
         (q.assigned_to = auth.uid() or q.taken_by = auth.uid()
          or (q.assigned_to is null and q.taken_by is null
              and serves_station(auth.uid(), q.station, q.service))
          or coalesce(ho.status = 'pending' and ho.to_user = auth.uid(), false)) as for_me,
         -- the latest handover of the entry (20261129090000_handover); its note is clinical: for
         -- the two colleagues and the doctors who may see the visit
         ho.id as handover_id, ho.status as handover_status,
         ho.from_user as handover_from, hf.full_name as handover_from_name,
         ho.to_user as handover_to, ht.full_name as handover_to_name,
         case when auth.uid() in (ho.from_user, ho.to_user)
                   or (has_perm('clinical.read') and visit_view(q.encounter_id) is not null)
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

-- ---------------------------------------------------------------- F the History page and the audit table
-- The audited tables whose rows carry clinical words (and the safety fields of the patient).
create or replace function audit_redacted_entity(p_entity text)
returns boolean
language sql immutable
as $$
  select p_entity in ('condition', 'observation', 'service_request', 'diagnostic_report', 'procedure',
                      'medication_request', 'medication_dispense', 'prescription_doc', 'vaccination', 'fp_event',
                      'hiv_test', 'document', 'patient_file_doc', 'report_correction', 'record_access_request',
                      'record_access_entry', 'internal_task', 'encounter', 'queue_entry', 'patient',
                      'patient_handover')
$$;

-- An audited row without its clinical words, for someone who is not a doctor.
create or replace function audit_redact(p_entity text, p jsonb)
returns jsonb
language sql immutable
as $$
  select case
    when p is null or jsonb_typeof(p) <> 'object' or not audit_redacted_entity(p_entity) then p
    else p - array['text', 'icd10_code', 'value_text', 'findings', 'impression', 'reason', 'instructions',
                   'note', 'notes', 'detail', 'title', 'triage_reason', 'referral_note', 'no_diagnosis_kind',
                   'no_diagnosis_note', 'correction_reason', 'edit_reason', 'old_findings', 'old_impression',
                   'allergies', 'allergies_none', 'blood_group', 'answer_note', 'review_note',
                   'not_given_reason', 'cancel_reason', 'supply_reason', 'dose', 'frequency', 'route',
                   'result', 'conclusion', 'extra', 'flags', 'outcome', 'summary']
  end
$$;

-- Reading the audit table directly: the clinical tables' lines for doctors only.
drop policy if exists audit_event_select on audit_event;
create policy audit_event_select on audit_event for select to authenticated
  using (has_perm('audit.read') and (is_doctor() or not audit_redacted_entity(entity)));

-- ---------------------------------------------------------------- F the clinical reports
-- Reads clinical reports at all (as report_assert_clinical before 0126): the manager, a head, a
-- clinical reader. For the reports whose clinical columns are left out for non-doctors.
create or replace function report_assert_clinical_reader()
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null
     or not (is_manager() or cardinality(report_head_departments()) > 0 or clinical_reader()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
end
$$;

-- The clinical reports (diagnoses, prescriptions…): the same, and a doctor.
create or replace function report_assert_clinical()
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  perform report_assert_clinical_reader();
  if not is_doctor() then
    raise exception 'not allowed: patient records are for doctors' using errcode = '42501', hint = 'not_doctor';
  end if;
end
$$;

-- ---------------------------------------------------------------- C what each reader is told
-- patient_access_with (20261130090000_patient_privacy): only a doctor asks for access; the screens learn if the reader is a doctor
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
    -- 0126: patient records are for doctors (a non-doctor is told so, not offered a request)
    'doctor', is_doctor(),
    'via', v_via,
    'treatingEncounterId', v_treating,
    'pastVisits', v_past,
    'ownVisits', v_own,
    'hiddenVisits', v_hidden,
    'canRequest', has_perm('clinical.read') and is_doctor() and v_treating is not null and v_via is null and v_hidden > 0
                  and (v_req.id is null or v_req.status in ('refused', 'cancelled')),
    'canEmergency', has_perm('clinical.read') and is_doctor() and v_treating is not null and v_via is null and v_hidden > 0,
    -- the manager and the heads in charge (history_via says so)
    'canSeeLog', coalesce(v_via in ('manager', 'head'), false),
    'request', case when v_req.id is not null then jsonb_build_object(
        'id', v_req.id, 'kind', v_req.kind, 'status', v_req.status, 'reason', v_req.reason,
        'at', v_req.created_at, 'answeredAt', v_req.answered_at, 'answerNote', v_req.answer_note,
        'answeredBy', (select full_name from profiles where id = v_req.answered_by)) end
  );
end
$$;

-- patient_safety_summary (20261216090000_vital_labels): a long-term HIV condition only for a doctor with sensitive.read
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
          and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or (has_perm('sensitive.read') and is_doctor()))
          and (coalesce(c.icd10_code, '') ~ '^(I1[0-5]|I25|I50|E0[3-5]|E1[0-4]|J4[45]|G40|N18|B18|B2[0-4]|F2[0-9]|F3[1-3])'
               or (select count(distinct c2.encounter_id) from condition c2
                   join encounter e2 on e2.id = c2.encounter_id and e2.deleted_at is null
                   where e2.patient_id = p.id and c2.deleted_at is null and lower(c2.text) = lower(c.text)) >= 2)
        order by lower(c.text), c.created_at desc
      ) x), '[]'::jsonb),
    -- medicines of the open visit, and those still running (prescribed days not over)
    'medications', coalesce((
      select jsonb_agg(jsonb_build_object(
          'item', rx_label(m), 'dose', m.dose, 'frequency', m.frequency,
          'days', m.duration_days, 'at', m.created_at, 'outside', m.supply = 'outside',
          'until', case when m.duration_days is not null then m.created_at + make_interval(days => m.duration_days) end,
          'by', (select full_name from profiles where id = coalesce(m.prescriber_id, m.created_by)))
        order by m.created_at desc)
      from medication_request m
      join encounter e on e.id = m.encounter_id and e.deleted_at is null
      where e.patient_id = p.id and m.deleted_at is null and m.cancelled_at is null
        and (m.not_given_at is null or m.supply = 'outside')
        and m.created_at > now() - interval '180 days'
        and (e.status = 'open' or m.created_at + make_interval(days => coalesce(m.duration_days, 0)) >= now())), '[]'::jsonb),
    'lastVitals', coalesce((
      select jsonb_agg(jsonb_build_object('code', v.code, 'label', v.label, 'value', v.value_num, 'unit', v.unit, 'at', v.effective_at,
                                          'by', (select full_name from profiles where id = v.performer_id))
                       order by v.code)
      from (
        select distinct on (o.code) o.code, o.label, o.value_num, o.unit, o.effective_at, o.performer_id
        from observation o join encounter e on e.id = o.encounter_id and e.deleted_at is null
        where e.patient_id = p.id and o.deleted_at is null and o.code <> 'note' and o.value_num is not null
        order by o.code, o.effective_at desc
      ) v), '[]'::jsonb),
    'lastVisitAt', (select max(e.arrived_at) from encounter e where e.patient_id = p.id and e.deleted_at is null)
  )
  from patient p where p.id = p_patient_id
$$;

-- visit_clinical (20261212090000_visit_edit_lock): a desk working on the open visit gets its part (D); a non-doctor is told the record is for doctors
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
    -- 0126: someone who is not a doctor and works on the open visit: the desk's part
    if visit_desk_view(p_encounter_id) is not null then
      return visit_clinical_desk(p_encounter_id);
    end if;
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
      'access', patient_access(v_patient),
      -- 0126: the record is for doctors
      'forDoctors', not is_doctor());
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

-- doc_visit (20270105090000_book_nodx_staff): the reason no diagnosis was found is a record: doctors, and whoever wrote it
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
    'noDiagnosis', case when e.no_diagnosis_kind is not null and (is_doctor() or e.no_diagnosis_by = auth.uid()) then jsonb_build_object(
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

-- patient_results (20261130090000_patient_privacy): an HIV test only with sensitive.read
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
  where r.deleted_at is null
    -- 0126: an HIV test only with sensitive.read (the reader is a doctor)
    and (has_perm('sensitive.read') or not sensitive_service(r.service_id));
  if v_past then
    perform log_record_access(p_patient_id, null, coalesce(v_via, 'own'), 'results');
  end if;
  return v_rows;
end
$$;

-- visit_journey (20261216090000_vital_labels): an HIV test only with sensitive.read
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
        'code', o.code, 'label', o.label, 'value', o.value_num, 'unit', o.unit, 'at', o.effective_at,
        'by', (select full_name from profiles where id = o.performer_id)
      ) order by o.effective_at), '[]'::jsonb) into v_vitals
    from observation o where o.encounter_id = p_encounter_id and o.deleted_at is null and o.code <> 'note';

    select coalesce(jsonb_agg(jsonb_build_object(
        'text', c.text, 'icd10', c.icd10_code, 'type', c.type, 'provisional', c.provisional, 'at', c.created_at,
        'by', (select full_name from profiles where id = c.created_by)
      ) order by c.created_at), '[]'::jsonb) into v_dx
    from condition c where c.encounter_id = p_encounter_id and c.deleted_at is null and (coalesce(c.icd10_code, '') !~ '^B2[0-4]' or has_perm('sensitive.read'));

    select coalesce(jsonb_agg(jsonb_build_object(
        'item', rx_label(m), 'quantity', m.quantity, 'dose', m.dose,
        'frequency', m.frequency, 'days', m.duration_days, 'supply', m.supply, 'givenAt', m.given_at,
        'givenBy', (select full_name from profiles where id = m.given_by), 'at', m.created_at,
        'by', (select full_name from profiles where id = m.created_by),
        'dispensed', exists (select 1 from medication_dispense d where d.medication_request_id = m.id and d.deleted_at is null),
        'notGivenAt', m.not_given_at, 'notGivenReason', m.not_given_reason,
        'notGivenBy', (select full_name from profiles where id = m.not_given_by),
        'cancelledAt', m.cancelled_at, 'cancelReason', m.cancel_reason,
        'cancelledBy', (select full_name from profiles where id = m.cancelled_by)
      ) order by m.created_at), '[]'::jsonb) into v_meds
    from medication_request m
    where m.encounter_id = p_encounter_id and m.deleted_at is null;

    select coalesce(jsonb_agg(jsonb_build_object(
        'test', s.name_en, 'status', r.status, 'priority', r.priority, 'at', r.created_at,
        'by', (select full_name from profiles where id = r.created_by),
        'result', (select coalesce(dr.impression, dr.findings) from diagnostic_report dr where dr.service_request_id = r.id and dr.deleted_at is null order by dr.created_at desc limit 1)
      ) order by r.created_at), '[]'::jsonb) into v_tests
    from service_request r left join service s on s.id = r.service_id
    where r.encounter_id = p_encounter_id and r.deleted_at is null
      and (has_perm('sensitive.read') or not sensitive_service(r.service_id));

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

-- ---------------------------------------------------------------- E requests and emergencies: doctors ask, doctors answer
-- request_record_access (20261130090000_patient_privacy): the approvers are doctors (request_approvers)
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
                              'approvers', cardinality(request_approvers(p_patient_id, auth.uid())));
  end if;
  insert into record_access_request (patient_id, encounter_id, requested_by, kind, reason)
  values (p_patient_id, v_enc, auth.uid(), 'request', trim(p_reason))
  returning * into v_req;
  select p.surname || ' ' || p.given_names, p.file_number into v_name, v_file from patient p where p.id = p_patient_id;
  select full_name into v_me from profiles where id = auth.uid();
  v_to := request_approvers(p_patient_id, auth.uid());
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

-- emergency_record_access (20261130090000_patient_privacy): the approvers told are doctors (request_approvers)
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
  from unnest(request_approvers(p_patient_id, auth.uid())) x;
  return jsonb_build_object('id', v_req.id, 'status', v_req.status, 'via', 'emergency');
end
$$;

-- answer_record_access (20261205090000_record_access_manager_only): answered by a doctor approver of this request
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
  if v_req.requested_by = auth.uid() or not may_answer_request(v_req.patient_id, v_req.requested_by) then
    raise exception 'not allowed: the manager answers, or whoever the manager allowed to answer record-access requests'
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

-- record_access_requests (20261130090000_patient_privacy): doctors only; answered by a doctor approver; reviewed by the manager-doctor
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
                   and e.status = 'open' and may_answer_request(r.patient_id, r.requested_by),
      'canCancel', r.kind = 'request' and r.status = 'pending' and r.requested_by = auth.uid(),
      'reviewedBy', (select full_name from profiles where id = r.reviewed_by),
      'reviewedAt', r.reviewed_at, 'reviewNote', r.review_note,
      'canReview', r.kind = 'emergency' and r.reviewed_at is null and is_manager() and is_doctor()
    ) order by (r.kind = 'emergency' and r.reviewed_at is null) desc, (r.status = 'pending') desc, r.created_at desc), '[]'::jsonb)
  from record_access_request r
  join patient p on p.id = r.patient_id
  join encounter e on e.id = r.encounter_id
  join profiles rq on rq.id = r.requested_by
  where auth.uid() is not null and is_doctor()
    and r.created_at > now() - interval '90 days'
    and (r.requested_by = auth.uid() or is_manager() or may_answer_request(r.patient_id, r.requested_by))
    and case coalesce(p_scope, 'pending')
          when 'pending' then r.kind = 'request' and r.status = 'pending' and r.requested_by <> auth.uid()
                              and e.status = 'open'
          when 'mine' then r.requested_by = auth.uid()
          when 'emergency' then r.kind = 'emergency'
          else true
        end
$$;

-- record_access_log (20261130090000_patient_privacy): the manager who is a doctor
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
  if not (is_manager() and is_doctor()) then
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

-- patient_access_log (20261205090000_record_access_manager_only): "Who looked": a doctor (the manager, a head in charge)
create or replace function patient_access_log(p_patient_id uuid, p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if not is_doctor() or not (is_manager() or coalesce(auth.uid() = any (heads_in_charge(p_patient_id)), false)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(access_entry_json(x) order by x.at desc)
    from (select a.* from record_access_entry a where a.patient_id = p_patient_id
          order by a.at desc limit greatest(1, least(coalesce(p_limit, 50), 200))) x), '[]'::jsonb);
end
$$;

-- review_emergency_access (20261130090000_patient_privacy): the manager who is a doctor
create or replace function review_emergency_access(p_request_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not (is_manager() and is_doctor()) then
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

-- ---------------------------------------------------------------- B/F the medical documents and the visits list
-- visit_documents (20261215090000_receipts_and_documents): the Patients' documents are for doctors
create or replace function visit_documents(p_encounter_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_out jsonb := '[]'::jsonb;
  v_c jsonb;
  v_private boolean;
  v_n integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not clinical_reader() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not is_doctor() then
    raise exception 'not allowed: patient records are for doctors' using errcode = '42501', hint = 'not_doctor';
  end if;
  foreach v_id in array coalesce(p_encounter_ids, '{}'::uuid[]) loop
    v_n := v_n + 1;
    exit when v_n > 300;
    v_c := visit_clinical(v_id);
    if v_c is null then
      continue;
    end if;
    v_private := coalesce((v_c ->> 'private')::boolean, false);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_id,
      'clinical', v_c,
      'private', v_private,
      'patient', (select jsonb_build_object('id', p.id, 'name', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number)
                  from encounter e join patient p on p.id = e.patient_id where e.id = v_id),
      'vitals', case when v_private then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('code', v.code, 'label', v.label, 'value', v.value_num, 'text', v.value_text,
                                            'unit', v.unit, 'at', v.effective_at, 'by', v.by) order by v.effective_at)
        from (select distinct on (o.code) o.code, o.label, o.value_num, o.value_text, o.unit, o.effective_at, pr.full_name as by
              from observation o left join profiles pr on pr.id = o.performer_id
              where o.encounter_id = v_id and o.deleted_at is null and o.code <> 'note'
              order by o.code, o.effective_at desc) v), '[]'::jsonb) end,
      'charges', case when v_private then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('description', l.description, 'quantity', l.quantity) order by l.created_at)
        from invoice i join invoice_line l on l.invoice_id = i.id
        where i.encounter_id = v_id and i.deleted_at is null and l.deleted_at is null), '[]'::jsonb) end));
  end loop;
  return v_out;
end
$$;

-- visits_in_period (20261215090000_receipts_and_documents): the diagnosis of each visit for doctors (an HIV one with sensitive.read)
create or replace function visits_in_period(
  p_from date default null,
  p_to date default null,
  p_department uuid default null,
  p_doctor uuid default null,
  p_service text default null,
  p_insurer uuid default null,
  p_closed_only boolean default false,
  p_search text default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  s record;
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_q text := nullif(trim(coalesce(p_search, '')), '');
  v_result jsonb;
  v_rows jsonb;
  v_options jsonb;
  -- 0126: the diagnosis column for doctors
  v_doc boolean := is_doctor();
  v_sens boolean := has_perm('sensitive.read');
begin
  select * into s from analytics_scope(p_department);
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;

  with base as (
  select e.id, e.reference, e.arrived_at, e.closed_at, e.status::text as status, e.service,
         p.id as patient_id, p.surname || ' ' || p.given_names as patient, p.file_number,
         d.id as department_id, d.name as department,
         doc.id as doctor_id, doc.full_name as doctor,
         c.text as diagnosis, c.icd10_code as icd10,
         ins.id as insurer_id, ins.name as insurer
  from encounter e
  join patient p on p.id = e.patient_id
  left join lateral (
    select q.department_id from queue_entry q
    where q.encounter_id = e.id and q.deleted_at is null and q.department_id is not null
    order by q.created_at desc limit 1
  ) qd on true
  left join department d on d.id = qd.department_id
  left join lateral (
    select pr.id, pr.full_name from profiles pr
    where pr.id = coalesce(
      (select c0.created_by from condition c0 where c0.encounter_id = e.id and c0.deleted_at is null
       order by c0.created_at limit 1),
      (select q.taken_by from queue_entry q
       where q.encounter_id = e.id and q.deleted_at is null and q.taken_by is not null
         and q.station not in ('reception', 'triage', 'cashier', 'pharmacy')
       order by coalesce(q.started_at, q.created_at) limit 1))
  ) doc on true
  left join lateral (
    select c1.text, c1.icd10_code from condition c1
    where c1.encounter_id = e.id and c1.deleted_at is null
    order by (c1.type = 'primary') desc, c1.created_at limit 1
  ) c on true
  left join lateral (
    select py.id, py.name from coverage cv
    join payer py on py.id = cv.payer_id and py.type <> 'cash'
    where cv.id = coalesce((select i.coverage_id from invoice i where i.encounter_id = e.id and i.deleted_at is null limit 1),
                           e.coverage_id)
  ) ins on true
  where e.deleted_at is null
    and (e.arrived_at at time zone 'Africa/Kigali')::date between v_from and v_to
    and (s.s_department is null or exists (
      select 1 from queue_entry q where q.encounter_id = e.id and q.deleted_at is null
        and (q.department_id = s.s_department or q.station = any (s.s_stations))))
  )
  select jsonb_build_object(
    'options', jsonb_build_object(
      'departments', coalesce((select jsonb_agg(jsonb_build_object('id', x.department_id, 'name', x.department) order by x.department)
                               from (select distinct department_id, department from base where department_id is not null) x), '[]'::jsonb),
      'doctors', coalesce((select jsonb_agg(jsonb_build_object('id', x.doctor_id, 'name', x.doctor) order by x.doctor)
                           from (select distinct doctor_id, doctor from base where doctor_id is not null) x), '[]'::jsonb),
      'services', coalesce((select jsonb_agg(x.service order by x.service)
                            from (select distinct service from base where service is not null) x), '[]'::jsonb),
      'insurers', coalesce((select jsonb_agg(jsonb_build_object('id', x.insurer_id, 'name', x.insurer) order by x.insurer)
                            from (select distinct insurer_id, insurer from base where insurer_id is not null) x), '[]'::jsonb)),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', b.id, 'reference', b.reference, 'at', b.arrived_at, 'closedAt', b.closed_at, 'status', b.status,
        'service', b.service,
        'patient', jsonb_build_object('id', b.patient_id, 'name', b.patient, 'fileNumber', b.file_number),
        'doctor', case when b.doctor_id is null then null else jsonb_build_object('id', b.doctor_id, 'name', b.doctor) end,
        'department', case when b.department_id is null then null else jsonb_build_object('id', b.department_id, 'name', b.department) end,
        'diagnosis', case when v_doc and (v_sens or coalesce(b.icd10, '') !~ '^B2[0-4]') then b.diagnosis end,
        'icd10', case when v_doc and (v_sens or coalesce(b.icd10, '') !~ '^B2[0-4]') then b.icd10 end,
        'insurer', b.insurer
      ) order by b.arrived_at, b.id)
      from (select * from base b
            where (p_doctor is null or b.doctor_id = p_doctor)
              and (p_service is null or b.service = p_service)
              and (p_insurer is null or b.insurer_id = p_insurer)
              and (not p_closed_only or b.status = 'closed')
              and (v_q is null or b.patient ilike '%' || v_q || '%' or b.file_number ilike '%' || v_q || '%'
                   or coalesce(b.reference, '') ilike '%' || v_q || '%' or (v_doc and (v_sens or coalesce(b.icd10, '') !~ '^B2[0-4]')
                       and coalesce(b.diagnosis, '') ilike '%' || v_q || '%'))
            order by b.arrived_at, b.id
            limit 2000) b), '[]'::jsonb))
  into v_result;
  v_options := v_result -> 'options';
  v_rows := v_result -> 'rows';

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'manager', s.s_manager,
    'department', s.s_department,
    'count', jsonb_array_length(v_rows),
    'closed', (select count(*) from jsonb_array_elements(v_rows) x where x ->> 'status' = 'closed'),
    'open', (select count(*) from jsonb_array_elements(v_rows) x where x ->> 'status' = 'open'),
    'options', v_options,
    'visits', v_rows);
end
$$;

-- ---------------------------------------------------------------- D/F the attachments (patient-files)
-- file_view (20261201090000_supporting_files): doctors by the record's rules; a desk the files of the tests it runs (D); one's own upload for 24 hours
create or replace function file_view(d patient_file_doc)
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce(
    case when clinical_reader() or is_manager() then visit_view(d.encounter_id) end,
    -- 0126: the files of a test the person's desk runs, on the open visit
    file_desk_view(d),
    case when d.removed_at is null and d.uploaded_by = auth.uid()
              and d.uploaded_at > now() - interval '24 hours' then 'own' end)
$$;

-- files_list (20261201090000_supporting_files): the same as file_view
create or replace function files_list(p_patient_id uuid, p_encounter_id uuid, p_service_request_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_via text;
  v_reader boolean := clinical_reader();
  v_files jsonb;
  v_hidden integer;
  v_removed integer;
begin
  if auth.uid() is null or not has_perm('patient.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_via := history_via(p_patient_id);
  with f as (
    select d, coalesce(
             case when v_reader or is_manager() then visit_view_with(d.encounter_id, v_via, true) end,
             -- 0126: the files of a test the person's desk runs, on the open visit
             file_desk_view(d),
             -- one's own upload, for 24 hours (as file_view)
             case when d.removed_at is null and d.uploaded_by = auth.uid()
                       and d.uploaded_at > now() - interval '24 hours' then 'own' end) as view
    from patient_file_doc d
    where d.patient_id = p_patient_id
      and (p_encounter_id is null or d.encounter_id = p_encounter_id)
      and (p_service_request_id is null or d.service_request_id = p_service_request_id)
  )
  select coalesce(jsonb_agg(file_doc_json(f.d, f.view) order by (f.d).uploaded_at desc)
                    filter (where f.view is not null and ((f.d).removed_at is null or is_manager())), '[]'::jsonb),
         count(*) filter (where f.view is null and (f.d).removed_at is null),
         count(*) filter (where f.view is not null and (f.d).removed_at is not null)
  into v_files, v_hidden, v_removed
  from f;
  return jsonb_build_object(
    'files', v_files,
    'hidden', v_hidden,
    'removed', v_removed,
    'maxBytes', file_max_bytes(),
    'types', jsonb_build_array('image/jpeg', 'image/png', 'image/webp', 'application/pdf'));
end
$$;

-- file_open (20261201090000_supporting_files): a desk file opens like the open visit (no log)
create or replace function file_open(p_file_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_f patient_file_doc%rowtype;
  v_view text;
begin
  if auth.uid() is null or not has_perm('patient.read') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_f from patient_file_doc where id = p_file_id;
  if not found or (v_f.removed_at is not null and not is_manager()) then
    raise exception 'file not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_f.removed_at is not null then
    raise exception 'this file was removed' using errcode = '22023', hint = 'already_removed';
  end if;
  v_view := file_view(v_f);
  if v_view is null then
    raise exception 'not allowed: this file belongs to records you may not see'
      using errcode = '42501', hint = 'private';
  end if;
  if v_view not in ('visit', 'desk') then
    perform log_record_access(v_f.patient_id, v_f.encounter_id, v_view, 'attachment');
  end if;
  return jsonb_build_object('id', v_f.id, 'bucket', 'patient-files', 'path', v_f.storage_path,
                            'mimeType', v_f.mime_type, 'title', v_f.title, 'expiresIn', 300);
end
$$;

-- file_object_read_ok (20261201090000_supporting_files): a desk file is read like the open visit
create or replace function file_object_read_ok(p_name text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(storage_session_ok() and has_perm('patient.read')
    and case
      when exists (select 1 from patient_file_doc d where d.storage_path = p_name) then
        exists (select 1 from patient_file_doc d
                cross join lateral (select file_view(d) as v) x
                where d.storage_path = p_name and d.removed_at is null and x.v is not null
                  and (x.v in ('visit', 'desk')
                       or exists (select 1 from record_access_entry a
                                  where a.actor_id = auth.uid() and a.patient_id = d.patient_id
                                    and a.encounter_id = d.encounter_id and a.what = 'attachment'
                                    and a.at > now() - interval '35 minutes')))
        -- Postgres deletes only the rows it may read: the person deleting a removed file
        or file_object_delete_ok(p_name)
      else file_object_insert_ok(p_name)
    end, false)
$$;

-- ---------------------------------------------------------------- F the reports
-- report_patients_seen (20270105090000_book_nodx_staff): patients seen for the clinical readers; the diagnosis column for doctors
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
  -- 0126: the diagnosis column for doctors
  v_doc boolean := is_doctor();
  v_sens boolean := has_perm('sensitive.read');
begin
  perform report_assert_clinical_reader();
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
        'diagnosis', case when v_doc then coalesce((select string_agg(coalesce(c.icd10_code || ' ', '') || c.text, '; '
                                        order by (c.type = 'primary') desc, c.created_at)
                      from condition c where c.encounter_id = r.encounter_id and c.deleted_at is null
                        and (v_sens or coalesce(c.icd10_code, '') !~ '^B2[0-4]')),
                      no_diagnosis_marker(r.no_diagnosis_kind, r.no_diagnosis_note)) end,
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

-- report_tests (20261222090000_reports_stock_clinical): the result for a doctor or the desk running the test; an HIV test likewise
create or replace function report_tests(
  p_from date, p_to date, p_desk text default null, p_status text default null, p_requester uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_mgr boolean := is_manager();
  v_heads uuid[] := report_head_departments();
  v_lab boolean := may_use_desk('laboratory') and has_perm('orders.read');
  v_us boolean := may_use_desk('ultrasound') and has_perm('orders.read');
  -- 0126: results are records: a doctor, or the desk running the test
  v_doc boolean := is_doctor();
  v_lab_desk boolean := works_at_desk('laboratory') and has_perm('orders.read');
  v_us_desk boolean := works_at_desk('ultrasound') and has_perm('orders.read');
begin
  if not (v_lab or v_us) then
    perform report_assert_clinical_reader();
  end if;
  perform report_assert_period(p_from, p_to);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', r.id, 'at', r.created_at, 'encounterId', e.id, 'reference', e.reference,
        'test', s.name_en, 'testFr', s.name_fr, 'testRw', s.name_kin, 'category', r.category, 'desk', k.desk,
        'urgent', r.priority <= 2, 'sampleId', r.sample_id,
        'patientId', p.id, 'patient', p.surname || ' ' || p.given_names, 'fileNo', p.file_number,
        'requesterId', r.requester_id, 'requester', rq.full_name, 'status', r.status,
        'sampleAt', (select min(a.at) from audit_event a
                     where a.entity = 'service_request' and a.entity_id = r.id
                       and a.after ->> 'status' in ('collected', 'in_process', 'resulted', 'verified')),
        'resultAt', d.created_at, 'verifiedAt', d.verified_at,
        'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
        'turnaround', case when d.id is not null
                           then round(extract(epoch from coalesce(d.verified_at, d.created_at) - r.created_at) / 60) end,
        'corrected', d.corrected_at is not null,
        'result', case when v.ok and (v_doc or (k.desk = 'laboratory' and v_lab_desk) or (k.desk = 'ultrasound' and v_us_desk)) then coalesce(nullif(trim(d.impression), ''), nullif(trim(d.findings), '')) end
      ) order by r.created_at desc)
    from service_request r
    join encounter e on e.id = r.encounter_id and e.deleted_at is null
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    left join profiles rq on rq.id = r.requester_id
    cross join lateral (
      select case when r.station is not null then r.station::text
                  when r.category = 'imaging' then 'ultrasound' else 'laboratory' end as desk
    ) k
    cross join lateral (
      select v_mgr or r.requester_id = v_me
             or (k.desk = 'laboratory' and v_lab) or (k.desk = 'ultrasound' and v_us)
             or (cardinality(v_heads) > 0 and visit_departments(e.id) && v_heads) as ok
    ) v
    where r.deleted_at is null and v.ok
      -- 0126: an HIV test for a doctor with sensitive.read, or the desk running it
      and (not sensitive_service(s.id) or (v_doc and has_perm('sensitive.read'))
           or (k.desk = 'laboratory' and v_lab_desk) or (k.desk = 'ultrasound' and v_us_desk))
      and (r.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
      and (p_desk is null or p_desk = '' or k.desk = p_desk)
      and (p_status is null or p_status = '' or r.status::text = p_status)
      and (p_requester is null or r.requester_id = p_requester)
  ), '[]'::jsonb);
end
$$;

-- report_prescriptions (20261222090000_reports_stock_clinical): a doctor, or the pharmacy's own desk (not the manager's right to every desk)
create or replace function report_prescriptions(
  p_from date, p_to date, p_supply text default null, p_prescriber uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_mgr boolean := is_manager();
  v_heads uuid[] := report_head_departments();
  v_rx boolean := works_at_desk('pharmacy');
begin
  if not v_rx then
    perform report_assert_clinical();
  end if;
  perform report_assert_period(p_from, p_to);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', m.id, 'at', m.created_at, 'encounterId', e.id, 'reference', e.reference,
        'patientId', p.id, 'patient', p.surname || ' ' || p.given_names, 'fileNo', p.file_number,
        'itemId', m.item_id, 'medicine', rx_label(m), 'code', coalesce(i.code, m.reference_code),
        'unit', i.selling_unit, 'packSize', case when coalesce(i.pack_size, 1) >= 2 then i.pack_size end,
        'packUnit', i.pack_unit,
        'quantity', m.quantity,
        'given', case when m.supply = 'room' then case when m.given_at is not null then m.quantity else 0 end
                      when m.supply = 'pharmacy' then coalesce(m.quantity_given, 0) end,
        'supply', m.supply, 'status', st.status,
        'prescriberId', coalesce(m.prescriber_id, m.created_by), 'prescriber', pr.full_name,
        'dose', nullif(concat_ws(' · ', nullif(m.dose, ''), nullif(m.frequency, ''),
                                 case when m.duration_days is not null then m.duration_days || ' d' end,
                                 nullif(m.route, '')), ''),
        'instructions', m.instructions,
        'reason', coalesce(m.cancel_reason, m.not_given_reason, m.supply_reason)
      ) order by m.created_at desc, p.surname)
    from medication_request m
    join encounter e on e.id = m.encounter_id and e.deleted_at is null
    join patient p on p.id = e.patient_id
    left join item i on i.id = m.item_id
    left join profiles pr on pr.id = coalesce(m.prescriber_id, m.created_by)
    cross join lateral (
      select case
               when m.cancelled_at is not null then 'cancelled'
               when m.supply = 'outside' then 'outside'
               when m.supply = 'room' then case when m.given_at is not null then 'given' else 'waiting' end
               when m.not_given_at is not null then 'not_given'
               when m.given_at is not null or coalesce(m.quantity_given, 0) >= ceil(m.quantity) then 'given'
               when coalesce(m.quantity_given, 0) > 0 then 'part'
               else 'waiting'
             end as status
    ) st
    where m.deleted_at is null
      and (m.created_at at time zone 'Africa/Kigali')::date between p_from and p_to
      and (v_mgr or v_rx or coalesce(m.prescriber_id, m.created_by) = v_me
           or (cardinality(v_heads) > 0 and visit_departments(e.id) && v_heads))
      and (p_supply is null or p_supply = '' or m.supply = p_supply)
      and (p_prescriber is null or coalesce(m.prescriber_id, m.created_by) = p_prescriber)
  ), '[]'::jsonb);
end
$$;

-- report_patients_visited (20261220090000_reports_patients): the private "medical" patient fields for the manager who is a doctor
create or replace function report_patients_visited(
  p_from date default null,
  p_to date default null,
  p_filters jsonb default '{}'::jsonb,
  p_clinical boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_manager boolean := is_manager();
  v_sex text := nullif(v_f ->> 'sex', '');
  v_band text := nullif(v_f ->> 'ageBand', '');
  v_kind text := nullif(v_f ->> 'kind', '');
  v_district text := nullif(trim(coalesce(v_f ->> 'district', '')), '');
  v_q text := nullif(trim(coalesce(v_f ->> 'search', '')), '');
  v_sensitive boolean := has_perm('sensitive.read');
  v_private text[] := private_extra_keys();
  v_rows jsonb;
  v_count integer;
  r record;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_to < v_from then
    select v_to, v_from into v_from, v_to;
  end if;

  with v as (
    select x.*,
           -- how the reader sees the visit's record (asked only for the diagnoses)
           case when p_clinical then visit_view(x.encounter_id) end as via
    from report_visit_set(v_from, v_to, v_f) x
  ),
  per as (
    select v.patient_id,
           min(v.arrived_at) as first_at, max(v.arrived_at) as last_at,
           count(distinct v.encounter_id)::int as visits,
           bool_or(v.first_visit) as is_new,
           array_remove(array_agg(distinct v.department), null) as departments,
           array_remove(array_agg(distinct s.station), null) as desks,
           array_remove(array_agg(distinct v.doctor), null) as doctors,
           (array_agg(v.insurer order by v.arrived_at desc) filter (where v.insurer is not null))[1] as insurer,
           case when p_clinical then
             array_remove(array_agg(distinct case when v.via is not null
                                                  then report_visit_diagnosis(v.encounter_id, v_sensitive) end), null)
           end as diagnoses
    from v
    left join lateral unnest(v.stations) as s(station) on true
    group by v.patient_id
  ),
  pt as (
    select p.*, per.first_at, per.last_at, per.visits, per.is_new, per.departments, per.desks,
           per.doctors, per.insurer, per.diagnoses,
           extract(year from age(v_to, p.birth_date))::int as age_years
    from per join patient p on p.id = per.patient_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'patientId', pt.id,
      'fileNumber', pt.file_number,
      'surname', pt.surname,
      'givenNames', pt.given_names,
      'sex', pt.sex::text,
      'age', pt.age_years,
      'ageBand', report_age_band(pt.age_years),
      'birthDate', pt.birth_date,
      'phone', pt.phone_1,
      'phone2', pt.phone_2,
      'nationalId', case when v_manager then coalesce(pt.national_id, pt.id_number)
                         else report_mask_id(coalesce(pt.national_id, pt.id_number)) end,
      'province', pt.province,
      'district', pt.district,
      'sector', pt.sector,
      'cell', pt.cell,
      'village', pt.village,
      'insurer', pt.insurer,
      'firstVisit', pt.first_at,
      'lastVisit', pt.last_at,
      'visits', pt.visits,
      'isNew', pt.is_new,
      'departments', to_jsonb(pt.departments),
      'desks', to_jsonb(pt.desks),
      'doctors', to_jsonb(pt.doctors),
      'diagnoses', case when p_clinical then to_jsonb(coalesce(pt.diagnoses, '{}'::text[])) end,
      -- the clinic's own fields; the private ones to the manager and the heads in charge only
      'extra', case
        when v_manager and is_doctor() then coalesce(pt.extra, '{}'::jsonb)
        when p_clinical and history_via(pt.id) is not null then coalesce(pt.extra, '{}'::jsonb)
        else coalesce(pt.extra, '{}'::jsonb) - v_private end
    ) order by lower(pt.surname), lower(pt.given_names), pt.file_number), '[]'::jsonb),
    count(*)::int
  into v_rows, v_count
  from (
    select * from pt
    where (v_sex is null or pt.sex::text = v_sex)
      and (v_band is null or report_age_band(pt.age_years) = v_band)
      and (v_kind is null or (v_kind = 'new') = pt.is_new)
      and (v_district is null or lower(coalesce(pt.district, '')) = lower(v_district))
      and (v_q is null or (pt.surname || ' ' || pt.given_names) ilike '%' || v_q || '%'
           or (pt.given_names || ' ' || pt.surname) ilike '%' || v_q || '%'
           or coalesce(pt.file_number, '') ilike '%' || v_q || '%'
           or coalesce(pt.phone_1, '') ilike '%' || v_q || '%')
    order by lower(pt.surname), lower(pt.given_names), pt.file_number
    limit 5000
  ) pt;

  -- the diagnoses of past visits were read: one line per visit in the access log (0088)
  if p_clinical then
    for r in
      select x.patient_id, x.encounter_id, visit_view(x.encounter_id) as via
      from report_visit_set(v_from, v_to, v_f) x
      where x.status <> 'open'
        and x.patient_id in (select (j ->> 'patientId')::uuid from jsonb_array_elements(v_rows) j)
        and exists (select 1 from condition c where c.encounter_id = x.encounter_id and c.deleted_at is null)
    loop
      if r.via is not null then
        perform log_record_access(r.patient_id, r.encounter_id, r.via, 'visit');
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'manager', v_manager,
    'count', v_count,
    'truncated', v_count >= 5000,
    'rows', v_rows);
end
$$;

-- ---------------------------------------------------------------- F dashboards, menus, worklists
-- home_summary (20261203090000_guide_fixes): the results: the manager who is a doctor (the others' rule follows visit_view)
create or replace function home_summary(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_role role_key := current_role_key();
  v_practitioner uuid := (select id from practitioner where user_id = auth.uid() and active limit 1);
  v_today date := (now() at time zone 'Africa/Kigali')::date;
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, p_from, v_today);
  v_appts jsonb;
  v_inquiries jsonb;
  v_mine jsonb;
  v_to_accept jsonb;
  v_bills jsonb := '[]'::jsonb;
  v_paid jsonb;
  v_beds jsonb;
  v_tasks jsonb;
  v_results jsonb;
begin
  if v_role is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- today's booked patients (reception, doctors)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'time', to_char(a.starts_at at time zone 'Africa/Kigali', 'HH24:MI'),
      'name', coalesce(p.surname || ' ' || p.given_names, a.contact_name),
      'doctor', coalesce(pr.names, ''), 'station', coalesce(a.category, ''),
      'status', case when a.status in ('arrived', 'in_progress', 'completed') then 'arrived'
                     when a.starts_at < now() then 'late' else 'due' end,
      'mine', (a.practitioner_id = v_practitioner),
      'encounterId', (select e.id from encounter e where e.appointment_id = a.id order by e.arrived_at desc limit 1)
    ) order by a.starts_at), '[]'::jsonb) into v_appts
  from appointment a
  left join patient p on p.id = a.patient_id
  left join practitioner pr on pr.id = a.practitioner_id
  where a.deleted_at is null and a.status in ('approved', 'confirmed', 'arrived', 'in_progress', 'completed')
    and (a.starts_at at time zone 'Africa/Kigali')::date between v_from and v_to;

  -- public inquiries waiting for reception
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'name', a.contact_name, 'phone', a.contact_phone, 'reference', a.reference,
      'category', a.category, 'doctor', pr.names, 'channel', a.contact_channel,
      'when', case when a.starts_at is null then null else to_char(a.starts_at at time zone 'Africa/Kigali', 'DD/MM HH24:MI') end,
      'note', a.reason
    ) order by a.created_at), '[]'::jsonb) into v_inquiries
  from appointment a
  left join practitioner pr on pr.id = a.practitioner_id
  where a.deleted_at is null and a.status = 'inquiry';

  -- approved bookings this practitioner still has to accept
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'name', coalesce(p.surname || ' ' || p.given_names, a.contact_name),
      'when', to_char(a.starts_at at time zone 'Africa/Kigali', 'DD/MM HH24:MI'), 'note', a.reason,
      'category', a.category, 'startsAt', a.starts_at
    ) order by a.starts_at), '[]'::jsonb) into v_to_accept
  from appointment a
  left join patient p on p.id = a.patient_id
  where a.deleted_at is null and a.status = 'approved' and a.practitioner_id = v_practitioner
    and a.starts_at > now() - interval '1 day';

  -- open bills: visits with something charged and a patient balance, for the people who take
  -- payments and the manager (the other roles have no business with names and balances)
  if has_perm('payment.take') or is_manager() then
    select coalesce(jsonb_agg(jsonb_build_object(
        'encounterId', i.encounter_id, 'name', p.surname || ' ' || p.given_names, 'file', p.file_number,
        'ticket', (select ticket_no from queue_entry q where q.encounter_id = i.encounter_id order by q.created_at limit 1),
        'station', (select station from queue_entry q where q.encounter_id = i.encounter_id and q.finished_at is null order by q.created_at desc limit 1),
        'amount', i.patient_share, 'balance', invoice_balance(i.id), 'status', i.status
      ) order by i.updated_at desc), '[]'::jsonb) into v_bills
    from invoice i
    join encounter e on e.id = i.encounter_id
    join patient p on p.id = e.patient_id
    where i.deleted_at is null and i.total > 0 and e.status = 'open' and invoice_balance(i.id) > 0;
  end if;

  select jsonb_build_object('count', count(*), 'amount', coalesce(sum(amount), 0)) into v_paid
  from payment where deleted_at is null and (paid_at at time zone 'Africa/Kigali')::date between v_from and v_to;

  -- beds
  select coalesce(jsonb_agg(jsonb_build_object(
      'n', b.sort_order, 'name', b.name, 'state', b.status,
      'who', (select p.surname || ' ' || left(p.given_names, 1) || '.' from bed_stay s join encounter e on e.id = s.encounter_id join patient p on p.id = e.patient_id
              where s.bed_id = b.id and s.discharged_at is null limit 1)
    ) order by b.sort_order, b.name), '[]'::jsonb) into v_beds
  from bed b where b.deleted_at is null;

  -- tasks for my role or me
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', k.id, 'time', to_char(k.due_at at time zone 'Africa/Kigali', 'HH24:MI'), 'title', k.title,
      'detail', coalesce(k.detail, ''), 'overdue', (k.due_at < now()),
      'patient', (select p.surname || ' ' || p.given_names from patient p where p.id = k.patient_id)
    ) order by k.due_at), '[]'::jsonb) into v_tasks
  from internal_task k
  where k.deleted_at is null and k.done_at is null and (k.assigned_to = auth.uid() or task_for_me(k.assigned_role));

  -- lab / imaging results of the last two days: a doctor's own requests; the manager; others only
  -- results of visits they may see (privacy levels); HIV tests only with sensitive.read
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'encounterId', sr.encounter_id, 'test', s.name_en,
      'name', p.surname || ' ' || p.given_names, 'impression', coalesce(r.impression, r.findings, ''),
      'verified', (r.verified_at is not null), 'at', to_char(r.updated_at at time zone 'Africa/Kigali', 'HH24:MI'),
      'reviewed', (r.reviewed_at is not null), 'corrected', (r.corrected_at is not null)
    ) order by (r.reviewed_at is null) desc, r.updated_at desc), '[]'::jsonb) into v_results
  from diagnostic_report r
  join service_request sr on sr.id = r.service_request_id
  join service s on s.id = sr.service_id
  join encounter e on e.id = sr.encounter_id
  join patient p on p.id = e.patient_id
  where r.deleted_at is null
    and (r.updated_at > now() - interval '2 days' or (r.reviewed_at is null and r.updated_at > now() - interval '7 days'))
    and (
      -- after a handover the results follow the patient to the colleague who took them
      (v_role = 'doctor' and result_recipient(sr.encounter_id, sr.requester_id) = auth.uid())
      or (is_manager() and is_doctor())
      or (v_role is distinct from 'doctor' and has_perm('orders.read')
          and visit_view(sr.encounter_id) is not null)
    )
    and (has_perm('sensitive.read') or not sensitive_service(s.id));

  return jsonb_build_object(
    'role', v_role,
    -- the patients this person took and finished today (a doctor's "Seen")
    'seenToday', (select count(distinct q.encounter_id) from queue_entry q
                  where q.taken_by = auth.uid() and q.deleted_at is null and q.finished_at is not null
                    and (q.finished_at at time zone 'Africa/Kigali')::date between v_from and v_to),
    'appointments', v_appts,
    'inquiries', v_inquiries,
    'toAccept', v_to_accept,
    'openBills', v_bills,
    'paidToday', v_paid,
    'beds', v_beds,
    'tasks', v_tasks,
    'results', v_results
  );
end
$$;

-- my_orders (20261202090000_security_hardening): the result for a doctor or the desk running the test
create or replace function my_orders(p_days integer default 7, p_from date default null, p_to date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb)
  from (
    select r.created_at as at, jsonb_build_object(
      'id', r.id, 'encounterId', r.encounter_id, 'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'test', s.name_en,
      'station', coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end),
      'status', r.status, 'priority', r.priority, 'reason', r.reason, 'orderedAt', r.created_at,
      'findings', case when is_doctor() or works_at_desk(request_desk(r.station, r.category)) then d.findings end,
      'impression', case when is_doctor() or works_at_desk(request_desk(r.station, r.category)) then d.impression end, 'verified', d.verified_at is not null,
      'resultAt', coalesce(d.verified_at, d.updated_at),
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
      'visitOpen', e.status = 'open') as j
    from service_request r
    join encounter e on e.id = r.encounter_id
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and result_recipient(r.encounter_id, r.requester_id) = auth.uid()
      and case when p_from is not null
            then (r.created_at at time zone 'Africa/Kigali')::date between p_from and coalesce(p_to, p_from)
            else r.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90))) end
    order by r.created_at desc
    limit 500
  ) x
$$;

-- nav_counts (20270105090000_book_nodx_staff): results waiting and record-access requests counted for doctors
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
    -- 0126: results are records: counted for doctors
    if is_doctor() then
      v_out := v_out || jsonb_build_object('results', v_n, 'resultsEarlier', v_e);
    end if;

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
  -- 0126: doctors only; the requests this doctor may answer
  if is_doctor() then
    v_n := (select count(*) from record_access_request r
            join encounter e on e.id = r.encounter_id and e.status = 'open'
            where r.kind = 'request' and r.status = 'pending' and r.requested_by <> v_me
              and r.created_at > now() - interval '90 days'
              and may_answer_request(r.patient_id, r.requested_by))
           + case when v_manager then
               (select count(*) from record_access_request r
                where r.kind = 'emergency' and r.reviewed_at is null
                  and r.created_at > now() - interval '90 days')
             else 0 end;
    if v_n > 0 or v_manager or has_perm('records.approve') then
      v_out := v_out || jsonb_build_object('recordAccess', v_n);
    end if;
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

-- analytics_access (20261215090000_receipts_and_documents): the Patients' documents view for doctors
create or replace function analytics_access()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_manager boolean := is_manager();
  v_deps jsonb;
  v_desks text[];
  v_views text[] := '{}';
  v_dash text;
  v_dash_views text[] := '{}';
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_manager then
    select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'desks', to_jsonb(coalesce(d.services, '{}')))
                              order by d.sort_order, d.name), '[]'::jsonb)
    into v_deps
    from department d where d.deleted_at is null and d.active;
    v_views := array['revenue', 'staff', 'visits', 'treatments', 'lab', 'pharmacy', 'triage', 'stock', 'waiting', 'receipts', 'documents'];
    v_dash := 'manager';
    -- the manager dashboard's order: patients, waiting, money, people, treatments, stock, the desks, documents
    v_dash_views := array['visits', 'waiting', 'revenue', 'receipts', 'staff', 'treatments', 'stock', 'lab', 'pharmacy', 'triage', 'documents'];
  else
    select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'desks', to_jsonb(coalesce(d.services, '{}')))
                              order by d.sort_order, d.name), '[]'::jsonb)
    into v_deps
    from staff_department sd
    join department d on d.id = sd.department_id and d.deleted_at is null
    join profiles p on p.id = sd.profile_id and p.active
    where sd.profile_id = auth.uid() and sd.position in ('head', 'assistant');
    if jsonb_array_length(v_deps) > 0 then
      select coalesce(array_agg(distinct x), '{}') into v_desks
      from jsonb_array_elements(v_deps) dep, jsonb_array_elements_text(dep -> 'desks') x;
      v_views := array['staff', 'visits', 'treatments']
        || case when v_desks && array['laboratory', 'ultrasound'] then array['lab'] else '{}'::text[] end
        || case when 'pharmacy' = any (v_desks) then array['pharmacy'] else '{}'::text[] end
        || case when 'triage' = any (v_desks) then array['triage'] else '{}'::text[] end
        || case when 'pharmacy' = any (v_desks) then array['stock'] else '{}'::text[] end
        || array['waiting'];
      v_dash := 'head';
      -- the department section's order: patients, waiting, orders (the lab), people, services
      v_dash_views := array['visits', 'waiting']
        || case when v_desks && array['laboratory', 'ultrasound'] then array['lab'] else '{}'::text[] end
        || array['staff', 'treatments']
        || case when 'pharmacy' = any (v_desks) then array['pharmacy', 'stock'] else '{}'::text[] end
        || case when 'triage' = any (v_desks) then array['triage'] else '{}'::text[] end
        || array['documents'];
    else
      select p.role::text into v_role from profiles p where p.id = auth.uid() and p.active;
      v_dash := case v_role
        when 'cashier' then 'cashier'
        when 'pharmacist' then 'pharmacy'
        when 'lab_tech' then 'lab'
        when 'sonographer' then 'lab'
        when 'doctor' then 'doctor'
        when 'nurse' then 'nurse'
        when 'receptionist' then 'reception'
        else null
      end;
      v_dash_views := case v_dash
        when 'cashier' then array['collections', 'receipts', 'methods', 'openBills', 'refunds']
        when 'pharmacy' then array['handovers', 'walkIn', 'stock', 'expiry', 'outside']
        when 'lab' then array['tests', 'turnaround', 'verification', 'byTest']
        when 'doctor' then array['myPatients', 'waitingNow', 'diagnoses', 'prescriptions', 'orders', 'tasks']
        when 'nurse' then array['myPatients', 'vitals', 'waitingNow', 'tasks']
        when 'reception' then array['registrations', 'bookings', 'waitingNow', 'arrivals']
        else '{}'::text[]
      end;
    end if;
  end if;
  -- 0126: the Patients' documents are records: for doctors
  if not is_doctor() then
    v_views := array_remove(v_views, 'documents');
    v_dash_views := array_remove(v_dash_views, 'documents');
  end if;
  return jsonb_build_object(
    'manager', v_manager,
    'departments', v_deps,
    'views', to_jsonb(v_views),
    'dashboard', v_dash,
    'dashboardViews', to_jsonb(v_dash_views));
end
$$;

-- staff_activity_detail (20270105090000_book_nodx_staff): what was written (a diagnosis, a medicine…) and the HIV tests' patients: the manager who is a doctor
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
               case when (v_manager and is_doctor()) or ev.user_id = auth.uid()
                         or ev.kind in ('registered', 'patientsSeen', 'admissions',
                                        'payments', 'refunds', 'voided', 'handovers')
                         or (ev.encounter_id is not null and visit_view(ev.encounter_id) is not null)
                    then ev.what end as what,
               -- an HIV test names its patient to the manager only
               case when ev.kind = 'hivTests' and not (v_manager and is_doctor()) then null else ev.patient_id end as pid,
               case when ev.kind = 'hivTests' and not (v_manager and is_doctor()) then null else pt.surname || ' ' || pt.given_names end as pname,
               case when ev.kind = 'hivTests' and not (v_manager and is_doctor()) then null else pt.file_number end as file_number
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

-- desk_orders (20261202090000_security_hardening): a doctor-manager or the desk itself (not the manager's right to every desk)
create or replace function desk_orders(p_station station)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.prio, x.at), '[]'::jsonb)
  from (
    select r.priority as prio, r.created_at as at, doc_patient(p.id, e.id) || jsonb_build_object(
      'id', r.id, 'encounterId', r.encounter_id, 'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'sex', p.sex, 'birthDate', p.birth_date,
      'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = r.encounter_id order by q.created_at limit 1),
      'triage', e.triage_level,
      'test', s.name_en, 'category', r.category, 'status', r.status, 'priority', r.priority,
      'reason', r.reason, 'orderedAt', r.created_at,
      'orderedBy', (select full_name from profiles where id = r.requester_id),
      'findings', d.findings, 'impression', d.impression, 'verified', d.verified_at is not null,
      'resultAt', coalesce(d.verified_at, d.updated_at),
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
      'resultByPerson', doc_person(coalesce(d.verified_by, d.created_by)),
      'visitReference', e.reference, 'visitAt', e.arrived_at
    ) as j
    from service_request r
    join encounter e on e.id = r.encounter_id and e.status = 'open'
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    where r.deleted_at is null and r.station = p_station and p_station not in ('laboratory', 'ultrasound')
      and r.status not in ('verified', 'cancelled')
      and (has_perm('clinical.read') or has_perm('orders.read'))
      and ((is_manager() and is_doctor())
           or exists (select 1 from unnest(station_desks(p_station)) sd(desk) where works_at_desk(sd.desk)))
  ) x
$$;

-- lab_worklist (20261223090000_lab_worklist_period): the reason and the result for a doctor or the desk running the test; an HIV test likewise
create or replace function lab_worklist(p_scope text default 'open', p_from date default null, p_to date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(x.j order by x.prio, x.at), '[]'::jsonb)
  from (
    select r.priority as prio, r.created_at as at, doc_patient(p.id, e.id) || jsonb_build_object(
      'id', r.id, 'encounterId', r.encounter_id, 'patientId', p.id,
      'patient', p.surname || ' ' || p.given_names, 'fileNumber', p.file_number,
      'sex', p.sex, 'birthDate', p.birth_date,
      'ticket', (select q.ticket_no from queue_entry q where q.encounter_id = r.encounter_id order by q.created_at limit 1),
      'triage', e.triage_level,
      'test', s.name_en, 'category', r.category, 'status', r.status, 'priority', r.priority,
      'reason', case when k.ok then r.reason end, 'orderedAt', r.created_at,
      'orderedBy', (select full_name from profiles where id = r.requester_id),
      'findings', case when k.ok then d.findings end, 'impression', case when k.ok then d.impression end, 'verified', d.verified_at is not null,
      'corrected', d.corrected_at is not null,
      'resultAt', coalesce(d.verified_at, d.updated_at),
      'resultBy', (select full_name from profiles where id = coalesce(d.verified_by, d.created_by)),
      'resultByPerson', doc_person(coalesce(d.verified_by, d.created_by)),
      'visitReference', e.reference, 'visitAt', e.arrived_at
    ) as j
    from service_request r
    join encounter e on e.id = r.encounter_id and (p_scope = 'done' or e.status = 'open')
    join patient p on p.id = e.patient_id
    join service s on s.id = r.service_id
    left join diagnostic_report d on d.service_request_id = r.id and d.deleted_at is null
    -- 0126: the reason and the result for a doctor or the desk running the test
    cross join lateral (select is_doctor() or works_at_desk(request_desk(r.station, r.category)) as ok) k
    where r.deleted_at is null and has_perm('orders.read')
      and r.category in (select unnest(my_test_categories())) and coalesce(r.station, case when r.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end) in ('laboratory', 'ultrasound')
      -- HIV tests: the people allowed to see them, and the desk that runs them (the laboratory and
      -- ultrasound staff do their work whatever their rights)
      and ((has_perm('sensitive.read') and is_doctor()) or works_at_desk(request_desk(r.station, r.category))
           or not sensitive_service(s.id))
      and case when p_scope = 'done'
            then r.status in ('resulted', 'verified')
                 and (coalesce(d.verified_at, d.updated_at) at time zone 'Africa/Kigali')::date
                     between coalesce(p_from, (now() at time zone 'Africa/Kigali')::date)
                         and coalesce(p_to, p_from, (now() at time zone 'Africa/Kigali')::date)
            else r.status not in ('verified', 'cancelled') end
  ) x
$$;

-- visit_routing (20261202090000_security_hardening): the referral note for the doctors who see the visit and for whom it was sent to
create or replace function visit_routing(p_encounter_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'queueId', q.id, 'station', q.station, 'since', q.created_at,
      'assignedTo', q.assigned_to, 'assignedName', a.full_name,
      'referredBy', q.referred_by, 'referredName', r.full_name,
      'note', case when (has_perm('clinical.read') and visit_view(q.encounter_id) is not null)
                        or queue_entry_mine(q.id)
                   then q.referral_note end,
      'returnStation', q.return_station, 'returnTo', q.return_to, 'returnName', b.full_name,
      'takenBy', q.taken_by, 'takenName', t.full_name, 'canWork', queue_entry_for_me(q.id)
    ) order by q.created_at), '[]'::jsonb)
  from queue_entry q
  left join profiles a on a.id = q.assigned_to
  left join profiles r on r.id = q.referred_by
  left join profiles b on b.id = q.return_to
  left join profiles t on t.id = q.taken_by
  where q.encounter_id = p_encounter_id and q.finished_at is null and q.deleted_at is null
    and has_perm('queue.read')
$$;

-- record_result (20261212090000_visit_edit_lock): the result's words in the notice only for a doctor
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
                               'impression', case when is_doctor(v_to) then nullif(trim(coalesce(p_impression, '')), '') end,
                               'verified', p_verify),
            '/app/visit?encounter=' || v_req.encounter_id,
            v_to, auth.uid());
  end if;
  -- Last result of this desk written: the patient goes back to the doctor.
  v_station := coalesce(v_req.station, case when v_req.category = 'imaging' then 'ultrasound'::station else 'laboratory'::station end);
  perform after_desk_tests(v_req.encounter_id, v_station, v_req.requester_id);
end
$$;

-- correct_result (20261212090000_visit_edit_lock): the result's words in the notice only for a doctor
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
                               'impression', case when is_doctor(v_to) then nullif(trim(coalesce(p_impression, '')), '') end,
                               'verified', true, 'corrected', true, 'reason', case when is_doctor(v_to) then trim(p_reason) end),
            '/app/visit?encounter=' || v_req.encounter_id,
            v_to, true, auth.uid());
  end if;
end
$$;

-- activity_history (20261106090000_desks_wave8): the clinical words of others' records hidden from a reader who is not a doctor
create or replace function activity_history(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_actor uuid default null,
  p_group text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '7 days');
  v_to timestamptz := coalesce(p_to, now());
  v_total integer;
  v_items jsonb;
  -- 0126: a reader who is not a doctor sees what was done, not the clinical words
  v_doc boolean := is_doctor();
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- Everyone sees their own activity; only the manager sees everybody's (and may pick a person).
  if not is_manager() then
    p_actor := auth.uid();
  end if;

  select count(*) into v_total
  from audit_event a
  where a.at >= v_from and a.at < v_to and a.action <> 'read'
    and (p_actor is null or a.actor_id = p_actor)
    and (p_group is null or activity_group(a.entity, a.action) = p_group);

  with ev as (
    select a.*, activity_group(a.entity, a.action) as grp, coalesce(a.after, a.before) as row
    from audit_event a
    where a.at >= v_from and a.at < v_to and a.action <> 'read'
      and (p_actor is null or a.actor_id = p_actor)
      and (p_group is null or activity_group(a.entity, a.action) = p_group)
    order by a.at desc
    limit greatest(1, least(p_limit, 500)) offset greatest(p_offset, 0)
  ),
  -- The visit behind the record: directly, through its bill, or through its test order.
  ev2 as (
    select ev.*,
      case when ev.entity = 'encounter' then ev.entity_id
        else coalesce(
          nullif(ev.row ->> 'encounter_id', '')::uuid,
          (select i.encounter_id from invoice i where i.id = nullif(ev.row ->> 'invoice_id', '')::uuid),
          (select i.encounter_id from invoice i where ev.entity = 'invoice' and i.id = ev.entity_id),
          (select sr.encounter_id from service_request sr where sr.id = nullif(ev.row ->> 'service_request_id', '')::uuid),
          (select md.encounter_id from medication_request md where md.id = nullif(ev.row ->> 'medication_request_id', '')::uuid))
      end as enc_id
    from ev
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', ev2.id,
      'at', ev2.at,
      'action', ev2.action,
      'entity', ev2.entity,
      'group', ev2.grp,
      'actor', pr.full_name,
      'actorRole', pr.role,
      'actorStaffId', pr.staff_id,
      'encounterId', en.id,
      'patientId', coalesce(case when ev2.entity = 'patient' then ev2.entity_id end, en.patient_id, pp.id),
      'patient', coalesce(
        case when ev2.entity = 'patient' then (ev2.row ->> 'surname') || ' ' || (ev2.row ->> 'given_names') end,
        pe.surname || ' ' || pe.given_names,
        pp.surname || ' ' || pp.given_names,
        case when ev2.entity = 'appointment' then ev2.row ->> 'contact_name' end),
      'detail', null,
      'reason', ev2.reason,
      'row', case when v_doc or ev2.actor_id = auth.uid() then audit_clean(ev2.row)
                  else audit_redact(ev2.entity, audit_clean(ev2.row)) end,
      'changes', case when ev2.action <> 'update' then '[]'::jsonb
                      when v_doc or ev2.actor_id = auth.uid() then audit_changes(ev2.before, ev2.after)
                      else audit_changes(audit_redact(ev2.entity, ev2.before), audit_redact(ev2.entity, ev2.after)) end,
      'names', jsonb_strip_nulls(jsonb_build_object(
        'file', coalesce(case when ev2.entity = 'patient' then ev2.row ->> 'file_number' end,
                         pe.file_number, pp.file_number),
        'target', case ev2.entity
          when 'profiles' then (select p.full_name || coalesce(' (' || p.staff_id || ')', '') from profiles p where p.id = ev2.entity_id)
          when 'practitioner' then ev2.row ->> 'names'
          when 'service' then coalesce(ev2.row ->> 'name_en', (select s.name_en from service s where s.id = ev2.entity_id))
          when 'payer' then coalesce(ev2.row ->> 'name', (select y.name from payer y where y.id = ev2.entity_id))
          when 'bed' then ev2.row ->> 'name'
          when 'item' then ev2.row ->> 'name_generic'
        end,
        'service', (select s.name_en from service s where s.id = coalesce(
          nullif(ev2.row ->> 'service_id', '')::uuid,
          (select sr.service_id from service_request sr where sr.id = nullif(ev2.row ->> 'service_request_id', '')::uuid))),
        'item', case when not v_doc and ev2.actor_id is distinct from auth.uid()
                          and ev2.entity in ('medication_request', 'medication_dispense', 'prescription_doc') then null
                     else (select it.name_generic || coalesce(' ' || it.strength, '') from item it
                 where it.id = coalesce(nullif(ev2.row ->> 'item_id', '')::uuid,
                   (select md.item_id from medication_request md where md.id = nullif(ev2.row ->> 'medication_request_id', '')::uuid))) end,
        'staff', (select p.full_name from profiles p
                  where p.id = nullif(coalesce(ev2.after ->> 'assigned_to', ev2.after ->> 'taken_by',
                                               ev2.row ->> 'assigned_to', ev2.row ->> 'given_by'), '')::uuid),
        'referredBy', (select p.full_name from profiles p where p.id = nullif(ev2.row ->> 'referred_by', '')::uuid),
        'returnTo', (select p.full_name from profiles p where p.id = nullif(ev2.row ->> 'return_to', '')::uuid),
        'performer', (select p.full_name from profiles p where p.id = nullif(ev2.row ->> 'performer_id', '')::uuid),
        'practitioner', (select x.names from practitioner x where x.id = nullif(ev2.row ->> 'practitioner_id', '')::uuid),
        'bed', (select b.name from bed b where b.id = nullif(ev2.row ->> 'bed_id', '')::uuid),
        'invoice', coalesce(case when ev2.entity = 'invoice' then ev2.row ->> 'number' end,
                            (select i.number from invoice i where i.id = nullif(ev2.row ->> 'invoice_id', '')::uuid)),
        'department', (select d.name from department d where d.id = nullif(ev2.row ->> 'department_id', '')::uuid)
      ))
    ) order by ev2.at desc), '[]'::jsonb)
  into v_items
  from ev2
  left join profiles pr on pr.id = ev2.actor_id
  left join encounter en on en.id = ev2.enc_id
  left join patient pe on pe.id = en.patient_id
  left join patient pp on pp.id = nullif(ev2.row ->> 'patient_id', '')::uuid and en.id is null;

  return jsonb_build_object('total', v_total, 'items', v_items, 'from', v_from, 'to', v_to);
end
$$;

-- ---------------------------------------------------------------- A the session and the employee profile say who is a doctor
-- my_session_profile (20261126090000_departments_decide_desks): is_doctor for the menu and the screens
create or replace function my_session_profile()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v profiles%rowtype;
begin
  select * into v from profiles where id = auth.uid();
  if not found or not v.active then
    raise exception 'this account is deactivated; ask the manager' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'id', v.id, 'username', v.username, 'full_name', v.full_name, 'role', v.role,
    'station', v.station, 'dashboard', v.dashboard, 'head_of', v.head_of,
    'language', v.language, 'must_change_pin', v.must_change_pin,
    'staff_id', v.staff_id, 'email', v.email,
    'specialty', v.specialty, 'registration_no', v.registration_no, 'registration_body', v.registration_body,
    'is_doctor', is_doctor(v.id),
    'desks', to_jsonb(my_desk_list())
  );
end
$$;

-- staff_profile (20270105090000_book_nodx_staff): is a doctor (the role, or marked by the manager)
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
    -- 0126: a doctor (the role, or marked by the manager): sees patient records
    'isDoctor', v_p.role = 'doctor' or v_p.is_doctor, 'doctorMarked', v_p.is_doctor,
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

-- The employee list (0080 view, same columns) with the doctor mark at the end.
create or replace view staff_directory with (security_invoker = true) as
  select p.id, p.username, p.full_name, p.role, p.station, p.dashboard, p.head_of, p.language, p.phone,
         p.active, p.must_change_pin, p.last_sign_in_at, p.pin_changed_at, p.deactivated_at, p.created_at,
         p.staff_id, p.email, p.department_id, d.name as department_name, p.position, p.specialty,
         coalesce((select jsonb_agg(jsonb_build_object('id', dd.id, 'name', dd.name, 'position', sd.position)
                                    order by (sd.department_id = p.department_id) desc, dd.name)
                   from staff_department sd join department dd on dd.id = sd.department_id and dd.deleted_at is null
                   where sd.profile_id = p.id), '[]'::jsonb) as departments,
         p.registration_no, p.registration_body,
         desks_of(p.id) as desks, kept_desks_of(p.id) as kept_desks,
         -- 0126: marked a doctor by the manager (the role 'doctor' is one anyway)
         p.is_doctor
  from profiles p
  left join department d on d.id = p.department_id and d.deleted_at is null
  where p.deleted_at is null;

-- ---------------------------------------------------------------- grants
-- The policies call is_doctor() and audit_redacted_entity() as the reader; the queue board (a view)
-- calls queue_entry_mine() as the reader too.
revoke all on function is_doctor(uuid), audit_redacted_entity(text), queue_entry_mine(uuid) from public, anon;
grant execute on function is_doctor(uuid), audit_redacted_entity(text), queue_entry_mine(uuid) to authenticated;
revoke all on function set_staff_doctor(uuid, boolean, text, text) from public, anon;
grant execute on function set_staff_doctor(uuid, boolean, text, text) to authenticated;
-- Internal: inside the security definer functions only.
revoke all on function works_at_desk(text), visit_working_on(uuid), visit_desk_working(uuid), visit_desk_view(uuid),
  visit_clinical_desk(uuid), file_desk_view(patient_file_doc), request_approvers(uuid, uuid),
  may_answer_request(uuid, uuid), report_assert_clinical_reader(), report_assert_clinical(), audit_redact(text, jsonb)
  from public, anon, authenticated;
-- The previous versions of a diagnosis or a note: inside visit_clinical only (it was callable).
revoke all on function record_history(text, uuid) from public, anon, authenticated;
